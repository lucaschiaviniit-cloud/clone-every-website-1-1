# Capture, review and source reconstruction

## 1. Define the target

Use one supplied page and choose original assets or photo/video placeholders. The agent inspects relevant responsive states and interactions and builds a page-specific scenario configuration. Default load and scroll checks provide partial coverage.

```sh
node scripts/clone.mjs https://YOUR-AUTHORIZED-TARGET.example/page --media original --out ../clone-runs/page-01 --config ./page-scenarios.json
```

`page-scenarios.json` is a file created for that target, not a bundled universal preset. Omit `--config` for the defaults while recognizing their limited interaction coverage. Keep runs outside the skill folder.

## 2. Review the replay

The wrapper performs local preflight, acquires permitted GET resources, builds a replay and runs startup checks. Start the preview with the exact command in the generated `state.json` or `AGENT_HANDOFF.md`.

Check the page in a browser: layout, responsive states, fonts, interaction paths, scroll and media behavior. The wrapper stops at `awaiting_user_review`. A screenshot score or a successful startup does not approve source reconstruction.

## 3. Approve and reconstruct

After the user approves that local result, the agent records the actual confirmation and creates a separate source workspace. It reconstructs readable components and compares them to the approved reference. It must not present the captured application's bundles as independent reconstructed source.

See [the operational workflow](../references/v1-workflow.md) and [source reconstruction](../references/source-reconstruction.md) for commands, identity checks and delivery requirements.

## Boundaries

- Replay contains captured frontend code; its provenance and rights remain separate from this software.
- Backend behavior, private APIs and unobserved routes are not recovered.
- Natural animation clocks, video frames, Canvas and WebGL can require specific protocols and manual work.
- Placeholder mode preserves a reviewed layout and interactions, with explicit media-content and timing limitations.
- Publication and deployment require a separate instruction; local cloning does not publish a site.
