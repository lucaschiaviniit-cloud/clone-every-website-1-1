---
name: clone-every-website-1-1
description: Clone a supplied webpage through a verified local replay, then reconstruct editable independent source only after the user confirms the local version is sufficiently accurate. Use for faithful website replication and frontend source reconstruction from a deployed page.
---

# Clone Every Website 1:1 — Compiled Build to Components

Turn a user-supplied page URL into a faithful local frontend, then into editable source. Preserve the user's exact design, content and interactive behavior. Use deterministic acquisition/build/evaluation tools and agents for analysis, integration and source reconstruction. Tool execution must not require an additional LLM, scraping or image-generation API.

At the start of each new cloning session, before contacting the target or starting acquisition, ask: **"Vuoi una copia fedele con gli asset originali, oppure vanno bene segnaposto al posto di foto e video per ridurre i download e potenzialmente il tempo?"** Offer `original` (faithful copy) and `placeholders` (replace photos/videos). Wait for the answer; do not silently choose either. If the active user request/session already establishes this choice, reuse it without asking again. Save the choice in the run config and pass `--media original|placeholders` explicitly; the wrapper refuses a missing choice. Logos, icons and fonts remain original in placeholder mode. Reduced downloads do not guarantee an overall speedup. Read [references/media-placeholders.md](references/media-placeholders.md) for the replacement contract, geometry configuration and unsupported media mechanisms. A placeholder baseline preserves the approved layout/interactions, not original photo/video content or timing. Existing captures are never converted in place.

## Context and input boundary

- The required user input is the page URL. Use the active request for scope and authorization; ask only when essential information is missing.
- This skill contains no prior target, example implementation or benchmark case. Do not search for or load old conversations, project memories, sibling projects, historical examples, test outputs or benchmark answers to solve a new target. Read only this skill, the reference for the current phase, current user instructions and this run's artifacts. If the user explicitly selects an old run, its artifacts may be reused with provenance.
- Create a fresh output directory in the user's current workspace. Do not derive a new target's selectors, assets, component structure or timings from a previous target.
- Synthetic tooling tests are engineering checks, not evidence of fidelity on a real page. Published examples belong outside this skill and are opt-in inputs, never automatic context.

## Two phases and a required user decision

### Phase A — working local build

Read [references/capture-and-replay.md](references/capture-and-replay.md). Inspect the target's sections, responsive states and significant interactions; create a run-specific scenario config from that page. Use the bundled engine to acquire HTML, CSS, JS, assets and observed GET responses, preserve hashes and produce a local replay of the distributed frontend. This phase intentionally runs the captured application; it does not claim recovered development source.

From the skill folder, install tooling once with `npm ci --prefix tools/lab` and `npm --prefix tools/lab run setup:browser`. Start a run:

```text
node scripts/clone.mjs <URL> --media <original|placeholders> --out <absolute-fresh-run-directory> --config <run-specific-config.json>
```

The wrapper first checks free space, loopback binding and actual browser execution locally, then builds only V2 and runs a short offline startup check at every configured viewport before writing an initial section inventory/index under the run's `analysis/`, outside the corpus. These are candidates, not automatic quality passes. Use them to refine the current-run scenarios before freezing the baseline; long pages need bottom and return-scroll states. Read [references/v1-workflow.md](references/v1-workflow.md) for dossier, scenario and comparison commands. Startup checks write `preflight.json` and `replay-checks/report.json` outside the corpus; they do not replace full interaction/visual review. Inspect reported console errors, blocked requests and the diagnostic wheel probe. A deterministic environment failure is not retried until its cause changes. Minimal local telemetry is enabled by default; it makes no model calls. Read [references/measurement.md](references/measurement.md) only for problems, token imports or maintenance comparisons.

`--prepare-only` prepares a run without contacting the target. Inspect `--help` for the current options. Start the local preview using the command in `state.json` or `AGENT_HANDOFF.md`; check actual network, assets, fonts, geometry, menu/hover/focus, scroll, canvas/video and important target-specific states. Repair missing capture/replay behavior and repeat affected checks. A page merely displaying is not sufficient. Preserve failed observations and state what could not be acquired.

**Stop at `awaiting_user_review`. Give the user a working local URL, the measured comparisons and the known limits, then ask whether this local build is sufficiently accurate to start reconstructing its source. Do not write the reconstructed site's components before that confirmation.** This stop is the user's requested workflow, not a claim that automated pixel scores can replace review. If a skill-caused pause needs explaining, quote this instruction and link this file.

### Phase B — reverse the approved local build

Proceed only when the user explicitly approves the current local build's accuracy for source reconstruction. Approval persists across turns and should not be requested again while that baseline is unchanged. Save the user's actual confirmation text in a run-local file and bind it to the corpus/build hashes:

```text
node scripts/review.mjs --run <run-directory> --confirmation-file <user-confirmation.txt>
node scripts/workspace.mjs --run <run-directory> --out <fresh-source-directory>
```

Do not manufacture confirmation text, infer approval from elapsed time, a previous target, a generic "continue" before review, or a passing score. A changed baseline or replay engine requires renewed review. `review.mjs` records the decision and engine fingerprint; `workspace.mjs` checks their integrity before creating the source workspace. These tools record the coordinator's user decision; they do not independently authenticate who wrote a text file.

Read [references/source-reconstruction.md](references/source-reconstruction.md). Work from the approved local build and corpus. Recover actual distributed styles/assets, inspect compiled components and animation logic, and reconstruct readable components and explicit runtime behavior. Keep the approved replay immutable as the reference. Do not call the mirror, a screenshot, a `v-html` page wrapper or an opaque original application bundle a reconstructed source project.

Read [references/validation-and-delivery.md](references/validation-and-delivery.md) when comparing or packaging the new implementation. Iterate against the approved reference, check source independence and verify install/build/start from a freshly extracted source package. Deliver editable source, assets, lockfile, instructions and evidence with bounded claims. This is a new source implementation unless original source was actually recovered.

Use `scripts/verify-source.mjs` to compare a separately running source build to the approved replay. Freeze a justified run-local acceptance policy before comparison; no policy leaves the result unreviewed. Targeted checks preserve sequential prerequisites and cannot finalize delivery. Complete delivery through `scripts/delivery.mjs` and `verify-source.mjs --finalize`; both require current evidence and full reviewed section coverage. Record source/module independence review explicitly, not as an inferred consequence of matching screenshots. These engineering tools do not establish real-site speedup or universal fidelity.

## Agent coordination

Use a coordinator plus available specialist agents. The coordinator owns run state, authorization, integration, ports and final claims. Delegate concrete work with explicit paths and the minimum current-run evidence:

1. Acquisition/motion analyst: inspect the target, capture evidence, identify original mechanism and report missing data. Phase A only until user approval.
2. Source builders: after approval, reconstruct assigned components or animation systems. Give each builder separate files/directories and relevant approved evidence. Preserve the shared CSS cascade; integrate sequentially when ownership overlaps.
3. Independent verifier: compare the integrated implementation against approved evidence and report defects with screenshots, state, viewport and reproducible steps. Do not give it desired scores or expected conclusions.

If delegation is unavailable, execute these roles sequentially and record that fact. Bound parallel browser work to avoid CPU/GPU overload affecting captures; do not compare timings from competing runs as controlled performance measurements. Agents must not load historical examples or expected benchmark answers.

## Resume and finish

Persist each decision and the next action in this run's `state.json`, `AGENT_HANDOFF.md` and the reconstructed project's handoff. On resume after context compaction, read those files and this skill; verify the selected target, phase and approval hashes before continuing. Do not reread unrelated memories to fill gaps. Never claim an unexecuted check or missing artifact is complete.

Publication, deployment, form submission, account mutations and reconstruction of unrequested routes are outside the default local cloning workflow. Describe backend/API gaps separately; a browser-visible frontend does not recover server implementation.

When maintaining or improving this skill, read [references/improvement-backlog.md](references/improvement-backlog.md) for proposed quality checks and process improvements. This maintenance note is not required context for cloning a target and does not describe implemented features.

For selective evidence supplied to Design Fusion or maintenance of its browser validator, read [references/fusion-support.md](references/fusion-support.md). The engine exposes Fusion API 1. Selective Fusion corpora are explicitly scoped and cannot be used as complete Clone replay/source baselines; a normal clone keeps the existing complete workflow.
