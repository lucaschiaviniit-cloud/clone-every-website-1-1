# Compare and deliver the reconstructed source

Read when validating Phase B. Keep reference identity, new build identity, protocols and observed coverage explicit. A stopped iteration is not proof that every state matches.

## Observable checks

- Build/install/start from source with a lockfile and explicit dependencies. Observe actual browser console/HTTP failures and required asset/font/video readiness.
- Run the same target-specific load, menu, hover, focus, scroll and other significant state scenarios at the same viewports/DPR/locale as the approved reference. Check preconditions and expectations; distinguish executed, passed, failed, skipped and untested.
- Compare screenshots with documented pixel threshold, antialiasing behavior and masks. Also inspect DOM geometry, page height, typography, image crops and interactions. DOM matchers can mispair transformed/invisible nodes after componentization: retain the raw metric and inspect the state, rather than hiding the error or treating it as ground truth.
- Track natural JS/video/GPU clocks. For clock-aligned supplemental checks, report them separately; compare identical video frames when isolating layout/shader differences. Do not convert a handful of screenshots into a universal fidelity percentage.
- Resize a live session, test opening/closing repeatedly and exercise forward/backward navigation within reconstructed controls. Validate actual mechanisms, not only endpoints.
- Require the new implementation to use local assets and explicit dependencies, with no runtime dependence on the replay or captured opaque application chunks. Block non-loopback network while observing source behavior and record attempts. Inspect the generated module graph and scripts; a blocked request alone is not proof that all required behavior still works.

`tools/lab` handles corpus verification and replay evaluation/benchmarking. `scripts/verify-source.mjs` now orchestrates source-versus-approved-replay comparison, policy freezing, selector mapping, sequential scenario prerequisites and evidence/source hashes. `scripts/delivery.mjs` verifies a freshly extracted package. Read [v1-workflow.md](v1-workflow.md) for commands, acceptance policy, coverage review and finalization. A replay benchmark is not automatically a benchmark of the rewritten application.

## Reproducible delivery

Package source, all required public assets, package/lock/config files and concise editing/start instructions. Exclude dependency installations, caches, unrelated experiments and prior target examples. Include third-party dependency/asset provenance; do not label reused libraries or acquired site assets as newly authored code.

Package the resulting static build separately when the chosen stack permits. Use sorted entries, fixed archive metadata and SHA256 inventories for repeatable packaging. Reopen archives and verify member hashes. Extract source to a fresh directory, install/build, run on an isolated loopback origin and check that it functions without the replay. Compare runtime output hashes where useful; source maps may contain location-dependent paths and should be reported separately.

Deliver the local URL, editable source location, commands, evidence/gallery, validation coverage and remaining limitations. State which routes and backend behaviors are absent. Do not publish, deploy, send forms or claim original repository recovery unless those actions/results were explicitly requested and actually achieved.

## New-chat benchmark boundary

For a fresh target test, give the new agent only the skill and target URL. Start in a new workspace/run directory; supply no prior target solution, score, implementation, screenshot or expected answer. Store current target inputs/evidence, software identity, config, steps, failures and actual results. Historical examples may be published outside the skill after testing; do not read them as implicit instructions. A new chat reduces prior-target context but does not by itself establish a blind, standardized or independently comparable benchmark: document the actual protocol.
