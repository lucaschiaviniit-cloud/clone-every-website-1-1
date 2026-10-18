# V1 operational workflow

Use for the current run only. The user reviews the replay, then reconstruction uses that approved replay as its reference. No additional intermediate user approval is introduced by V1.

## Capture and inventory

`clone.mjs` requires an explicit original/placeholder media choice and installs nothing automatically. It checks space (512 MiB minimum startup reserve, not a final-size estimate), actual loopback serving and Chromium execution without contacting the target. `preflight.json` records failures by stage/category; deterministic permission failures require a changed cause before retry. It then captures in a fresh directory, builds V2 only, checks replay startup at all configured viewports, and writes `analysis/page-inventory.json`, `reconstruction-index.json`, `assets-map.json` and verified cache metadata. Tool/browser installations are reused. For diagnostic variants use lab `build --all` (or omit a variant); `build --variant v2` is selective.

The short startup check runs the scenario prefix through the first significant interaction and its immediate close/reset when present, checks visible images/fonts, records runtime/network errors and a real wheel probe, and writes screenshots plus `replay-checks/report.json` outside the corpus. Failed startup blocks review state; console/blocked-request diagnostics still require agent review. A passing receipt is neither full comparison nor user approval. Offline preparation skips all preflight/browser/network checks.

Original-media capture reuses only explicitly fresh cacheable image/media GET responses within the same browser context; URL including query and all request headers (including Range) determine identity. Cookies/authentication, conditional requests, no-cache/no-store/private responses, compressed bodies, redirects and incomplete range bodies bypass reuse. Memory is bounded to 32 MiB. Resource/HAR records label cache reuse and traffic audits record hits/logical reused body bytes; these are not measured network savings. Set `captureMediaCache:false` in the config for a control run. No cross-run/viewport solution cache is introduced.

Inspect candidates and gaps. Inventory rows start `not-verified`; observed snapshots do not prove section coverage. Default long-page scenarios include bottom and return; menus, carousels, hover, focus, media progression, real scroll and responsive changes need current-target scenarios. Revise capture in a fresh coherent run if evidence is missing. Do not mutate an approved corpus.

Commands from the skill root:

```text
node tools/lab/node_modules/tsx/dist/cli.mjs tools/lab/src/cli.ts inventory --capture RUN/corpus --out RUN/analysis
node tools/lab/node_modules/tsx/dist/cli.mjs tools/lab/src/cli.ts dossier --capture RUN/corpus --out RUN/analysis --section SECTION_ID
```

The dossier command returns a path, not its full contents. Read only relevant fragments. It lazily extracts bounded DOM, element/font data, CSS candidates and JavaScript/source-map hints with provenance. Limits/omissions remain explicit. CSS candidates are not a safe cascade subset; JavaScript matches are not a recovered call graph. No image generation, model call or new browser capture occurs.

To record evidence review, supply `inventory --review-file RUN/inventory-review.json`. Review structure:

- `sections`: `{selector,label?,kind?}` for each grouping actually reviewed.
- `coverage`: `{sectionId,viewportId,stateId,status,reason,evidence:[corpusRelativePath]}`. Status is `passed`, `failed`, `skipped`, `not-verified` or `not-applicable`. Passed rows need evidence from that section's actual state. Non-applicable rows need a reason/evidence; each section needs at least one passed check.
- `impacts`: `{component,sectionIds,scenarioIds,shared?}` mapping components to scenarios. Unknown/shared impact expands to all configured scenarios.

These are coordinator review records, not independent human authentication. Do not mark states passed merely to unlock completion. Reviewed coverage describes the reference; the reconstructed build must separately pass comparisons and behavior assertions.

## Scenario extensions

Scenario IDs and viewport IDs must be stable path-free identifiers. New actions:

- `wheel`: `deltaY`, optional `deltaX` and pointer `selector`.
- `swipe`: `from:{x,y}`, `to:{x,y}`, optional `steps` (Chromium touch input).
- `resize`: `width`, `height` in the same session.

Optional metadata: `dependsOn`, `sections`, `sharedSystems`. Expectations add `visuallyVisible`, `scrollChanged`, `minScrollDelta`, `mediaReady`, `videoPlaying`. Element expectations need a selector. Scroll/video temporal checks belong in `expect`, not `precondition`. `videoPlaying` requires actual time advancement across the action interval; allow a pertinent `waitMs`. Images checked with `mediaReady` undergo a bounded decode check. Snapshot media readiness alone does not certify decode.

`readiness` is opt-in: selectors, fonts, images, stableMs, pollMs, timeoutMs and fallback (`fixed` or `fail`). It observes relevant local geometry rather than waiting for continuous animation to stop. The fixed settle path remains the default until profiling justifies a change. Both paths record timing and limitations; post-settle checkpoints do not establish initial load-animation fidelity.

Canvas transparent/uniform readback is advisory. Visual inspection remains necessary for GPU output, intentional hidden media and occlusion.

## Reconstruct and compare

After actual user approval, use the existing review/workspace commands. Establish fonts, cascade, layout and shared runtime first. Complete a representative difficult section before expanding. Delegate only with clear file ownership and compact current-run evidence. Keep heavy browser comparisons sequential; use shared browser processes with fresh contexts where supported.

Start the reconstructed build separately. Prepare `RUN/source-policy.json` before observing comparison results:

```json
{
  "schemaVersion": 1,
  "rationale": "Explain the calibrated tolerance for this target and protocol",
  "states": {},
  "selectorMap": {},
  "recoveredLibraryHashes": {}
}
```

Supply `defaults` and/or per-state entries keyed `VIEWPORT/SCENARIO`. Each entry requires `maxChangedPixelRatio`, `maxBoxErrorPx`, `maxPageHeightDeltaPx`, `minElementCoverage`; optional `requiredSelectors`. Choose values from reference variability and target requirements, not desired scores. No universal numeric preset is supplied. Missing limits produce `unreviewed`, not passed. `selectorMap` maps reference selectors to source selectors for scenarios and measured elements. `recoveredLibraryHashes` may declare exact recovered library hashes with a justification; never whitelist the captured opaque application as a replacement for source.

```text
node scripts/verify-source.mjs --run RUN --url http://127.0.0.1:PORT/ --policy RUN/source-policy.json
node scripts/verify-source.mjs --run RUN --url http://127.0.0.1:PORT/ --policy RUN/source-policy.json --mode targeted --scenario menu-closed --impact-known
node scripts/verify-source.mjs --run RUN --url http://127.0.0.1:PORT/ --policy RUN/source-policy.json --component COMPONENT
```

With `--component`, reviewed mappings select targeted checks automatically; an explicit `--mode full` always keeps full comparison. Unknown/shared mappings expand to full. For local changes use reviewed component mappings or `--section`, `--system`, `--scenario`, `--viewport` plus known impact. Shared fonts/global-css/layout/scroll/runtime and unknown mappings expand to full. Explicit viewport subsets remain partial. Smoke retains open/close/real-input interaction groups. Sequential preceding actions execute as setup; expensive checkpoint collection is limited to selected states. Failures in prerequisites stop comparison.

Each comparison creates a fresh output directory. It samples the approved replay first, then the reconstructed source on the same browser/settings; it does not substitute original-site screenshots for the user's approved reference. Natural motion clocks remain variable. Reports contain per-state visual/geometry/motion/media results, assertions, network/errors and copied-script diagnostics. Matching screenshots alone do not establish behavioral completeness.

The public wrapper enforces approval, binds policy/selection/coverage/evidence and source/build hashes, and records the report hash in run state. `--check REPORT` detects later changes. Comparison pass is not completed delivery. Missing reviewed inventory, failed checks, partial coverage or stale identities block finalization.

## Fresh-package delivery

Prepare an explicit independence review with `{status:"passed",sourceSha256,rationale,reviewedFiles:[sourceRelativePath]}` after inspecting source, generated module graph and scripts. Obtain the source hash from the recorded report. This is a review attestation by the coordinator, supported by files and runtime diagnostics; it cannot authenticate who reviewed the code or prove arbitrary semantic equivalence.

Delivery config contains `install`, `build`, `start`, each `{executable,args:[...]}`. Commands run without a shell in the extracted source. Use `{port}` in start arguments, a relative `path` when needed and optional `timeoutMs`. Specify the stack's real local install/build/start commands. Do not introduce publication or backend writes.

```text
node scripts/delivery.mjs --run RUN --report REPORT --config RUN/delivery-config.json --out FRESH_DELIVERY_DIR --independence-file RUN/independence-review.json
node scripts/verify-source.mjs --run RUN --finalize REPORT --delivery-check FRESH_DELIVERY_DIR/delivery-check.json
```

Delivery creates a sorted archive with fixed timestamps/owners and preserved file modes, extracts it to a fresh temporary directory, checks file hashes/modes, installs/builds/starts and reruns the full comparison with remote browser access blocked. Source package excludes node_modules, Git and reconstruction handoff/state; .next/cache is excluded. Other generated assets remain included and bound to identity. Paths exceeding USTAR limits fail explicitly. Process groups are stopped and temporary work removed. On failure evidence remains with a failed status.

Finalization requires current approval and report, complete reviewed inventory, complete passing comparison, current source/build identity and all fresh-delivery checks. Telemetry then closes the run. Do not call a reconstructed project verified if only replay benchmarks passed.

## Deliberately conditional optimizations

Per-scenario capture profiles measure actions, snapshots and evidence writes. Parsed indices and dossiers have verified deterministic caches; original response byte identities remain separate from URL identities. HLS references are resolved relative to each original playlist URL and dependency gaps/partial bytes are reported.

Do not add snapshot delta formats, broad live-capture merging, metadata-only integrity caching or automatic parallel browser expansion before profiling demonstrates their value. The current implementation does not assert the planned 30–50% speedup: that needs comparable real-target runs.
