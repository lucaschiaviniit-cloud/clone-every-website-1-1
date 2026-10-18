# Deterministic acquisition and replay engine

This portable Node/Playwright engine captures **one supplied page**, stores observed original GET response bodies by SHA256, and replays its distributed frontend on loopback. It is phase 1 of the skill. It does not automatically recover or reconstruct editable application components.

```sh
npm ci
npm run setup:browser
npm run typecheck
npm test
```

Use the repository wrapper for normal acquisition: `node scripts/clone.mjs URL --media original --out ../clone-runs/name` from the repository root. It writes a per-run configuration and capture-request record, derives the target host, captures and builds the baseline, then stops at `awaiting_user_review`. `--prepare-only` needs no browser or dependencies. Preview starts separately using the command in the run's `state.json`.

## Individual commands

```sh
npm run capture -- --url https://example.test/page/ --config /absolute/run/capture-config.json --out /absolute/run/corpus
npm run build:variants -- --capture /absolute/run/corpus
npm run serve -- --capture /absolute/run/corpus --variant v2 --port 4173
npm run eval -- --capture /absolute/run/corpus --variant v2
npm run bench -- --capture /absolute/run/corpus --offline --repeat 3 --variant v2 --no-ablation
npm run bench -- --capture /absolute/run/corpus --offline --repeat 3 --all
```

`src/cli.ts verify --capture PATH` verifies the manifest and every recorded evidence/resource body against persisted hashes. It prints JSON containing status and corpus identity. CLI paths are resolved from the caller before the engine enters its own directory; software fingerprints are independent of caller working directory.

Direct `capture` requires the configuration's legacy-named `ownershipAuthorization` field for remote pages. The wrapper records the factual user request there; it makes no claim about ownership. This avoids silently inventing permission while requiring no repeated confirmation for acquisition already requested by the user. The later explicit approval gate concerns whether this particular local baseline is sufficiently accurate to become the source reconstruction reference.

## Evidence and replay

V1 additions: the `build` CLI accepts `--variant`; the normal skill wrapper selects V2. `eval --viewport ID --scenario ID` selects checkpoints while replaying sequential setup. `inventory --capture PATH --out RUN/analysis` and `dossier ... --section ID` generate verified derived indices outside the corpus. `source-eval --run RUN --url LOOPBACK_URL --out FRESH_DIR --policy FILE` is approval-gated; prefer `scripts/verify-source.mjs` because it also binds source/build identity and report hashes. See [the V1 workflow](../../references/v1-workflow.md) and [measurement guide](../../references/measurement.md).

- D01 original HTML bytes and headers; D02 serialized rendered DOM, open shadow roots and accessible frames.
- D03 CSSOM/rules; D04 computed styles/pseudo elements/custom properties; D05 element/text geometry.
- D06 font loading and selected rendered font evidence; D07 hashed response bodies; D08 observed bundles/maps and metadata.
- D09 sanitized network/HAR plus block/discovery audit; D10 measured viewport states; D11 configured interactions/assertions/deltas.
- D12 exposed animation timelines and timestamps; D13 screenshots; D14 observable canvas pixels/dimensions.
- D15 redacted unauthenticated session metadata; D16 corpus integrity and coverage.

GET bodies are captured through routed `route.fetch` before fulfilling Chromium requests, including dedicated-worker scripts and frame binaries that the worker may consume or transfer. The resource inventory includes only observed requests; no guessed asset sequence or backend responses are inserted. Redirect responses pass through the request policy again. The target must be the final page URL: navigation to a different URL, including a canonical redirect, is currently refused and requires choosing that final URL in a fresh run.

Phase 1 variants preserve the experiment: V0 static DOM without application JS; V1 original frontend with asset replay; V2 adds observed GET fetch/XHR data; V3 adds state evidence catalog; V4 adds motion evidence catalog. V3/V4 do not replace interaction logic or establish improved visual fidelity over V2. Benchmark dimensions are kept separate. Ablations remove CSS, JS, GET data, assets, state catalog or motion catalog one at a time.

The replay preserves paths and query ordering, remaps recorded origins literally, handles full/partial video range evidence conservatively, retains restrictive original CSP and adds an offline policy. Missing assets remain missing with explicit errors. It does not bypass original CSP/CORS or reconstruct backend behavior. Build hashes and corpus hashes bind the review reference.

## Capture scope

The supplied page and configured asset hosts are allowed for GET only. Optional asset discovery admits page-emitted script, stylesheet, image, font and media requests and recognizable asset-file fetches (including worker scripts, binary frames, models and JSON files). Discovery does not promote a CDN to unrestricted API access: each non-allowlisted request must itself qualify as an asset. Additional third-party API/data origins require a configured `--asset-host` for the observed page dependency. Discovered origins/types and blocked requests are recorded. Known tracker hosts, non-GET, WebSockets, service workers and AI model endpoints are disabled. No external model SDK, API key or paid API integration is used by the deterministic engine.

Initial contexts are fresh and unauthenticated. URL/header/session redaction is conservative, not a guarantee that an arbitrary public response contains no private data. Do not include a run's captured assets or evidence in a public repository automatically; publication is a separate user action.

## Measurement limits

Default scenarios measure four load checkpoints and four scroll positions at desktop/tablet/mobile sizes. They provide **partial interaction coverage**. Add target-specific safe menu, hover, focus, carousel and resize scenarios before drawing conclusions about those behaviors. Safe click scenarios refuse forms and navigational links. Failed or unexecuted reference scenarios block the wrapper's review handoff.

WAAPI seeking controls exposed CSS/WAAPI animation objects only. It does not create a shared synthetic JS, video, GSAP, Lenis, RAF or WebGL clock. Natural sampled timing has overhead and run variability; actual timestamps and repeated-run dispersion are retained. Unmasked screenshot differences may include different video frames. A controlled video-time comparison, if added by the agent, must be labeled as a separate protocol rather than silently changing the main metric.

Canvas pixels are evidence, not recovered WebGL scenes. Closed shadow roots and inaccessible iframe internals remain unsupported. Observed source maps may help later reconstruction; their absence in observed traffic is not proof none exist. Responsive captures show only the configured viewports, not all device/browser behavior. These tests validate the toolkit using synthetic fixtures; they are not fidelity results for a real website.

Selected dependency excerpts and their licenses are documented in `THIRD_PARTY.md` and `licenses/`. This folder contains no past target, live capture, target-owned asset, or historical benchmark result.
