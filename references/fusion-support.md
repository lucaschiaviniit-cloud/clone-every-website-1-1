# Selective evidence and Fusion verification

Read only when maintaining the engine or supplying selected evidence to Design Fusion. Normal faithful cloning continues through the complete replay and the existing user accuracy decision.

## Stable bridge

From `tools/lab`, run:

```text
node node_modules/tsx/dist/cli.mjs src/cli.ts fusion-capabilities
```

Fusion API 1 advertises inventory schema 1, `fusion-eval` and `fusion-selective-capture`. The consumer supplies the engine skill directory explicitly; it must not assume a sibling path or install dependencies in reference sites. No additional model/API is called by these commands.

## Selective acquisition

`CaptureConfig.selective` is optional and contains `{schemaVersion:1,purpose:"fusion",selectors:string[],viewportIds:string[],scenarioIds:string[]}`. The complete config still specifies the original sequential session. The runner executes the prefix through the last selected checkpoint and records only the measured states, on selected viewports. Failed setup or measured expectations stop the selective capture. Selector roots must exist in each measured state.

Snapshots restrict DOM branches, computed elements, animation targets, media, frames and Canvas to the selected roots plus ancestor context. CSS, font inventory, runtime hints, initial response bytes and observed runtime-required network resources remain shared. Viewport screenshots retain their surrounding context. This is a reduction of evidence and analysis scope, not proof of a minimal runnable code slice.

The manifest includes hashed `scope.kind: "fusion-selective"`, measured/setup IDs and viewport IDs. Full Clone build, evaluation, source comparison and source-approval tools reject it. Use the Design Fusion `capture` wrapper to record the request, preserve a fresh run and reuse telemetry; the normal `clone.mjs` rejects selective configs. Expand the acquisition explicitly if context is missing. Never label partial evidence a complete approved replay.

## Fusion checks

`fusion-eval --url <loopback-target> --config <suite.json> --identity <identity.json> --out <fresh-dir> [--selection <selection.json>] [--baseline <fusion-approval.json>]` uses shared browser/context, guarded local traffic, readiness, scenarios, selection and image metrics. Its acceptance logic is separate from the Clone source comparator.

The suite declares the target's components, states and technical checks; thresholds are optional until visual baseline comparison is requested. Identity includes the target root, explicit file hashes, build hash and project/registry hashes. The engine rechecks identity before and after verification, writes screenshots/report and preserves failed or partial outcomes. It does not attest the serving process, recover unlisted dependencies or approve creativity.

Optional visual comparison uses an approved **Fusion project** report, with confirmation/report/screenshot hashes, matching browser, suite and scope. Reference-site pixels are not the global acceptance criterion of a new design. Keep fidelity review and creative consent separate from technical results.

The higher-level project/catalog contracts and operational workflow belong to Design Fusion; this package supplies browser primitives and evidence. Ordinary Clone runs need no Fusion project files.
