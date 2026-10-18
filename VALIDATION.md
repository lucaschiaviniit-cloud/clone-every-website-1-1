# Release validation

This repository is a standalone distribution of Clone. Local package validation is recorded below; subsequent Linux checks are recorded in [GitHub Actions](https://github.com/lucaschiaviniit-cloud/orvibe-clone/actions/workflows/ci.yml).

## Executed against the release copy — 2026-10-18

Environment: macOS arm64, Node v22.23.1 and Playwright's installed Chromium.

- Fresh locked installation with `npm ci --prefix tools/lab`: passed.
- Browser setup and TypeScript typecheck: passed.
- Complete synthetic engine suite: **91/91 passed**, zero skipped, 147.09 seconds.
- Skill Creator frontmatter/name validation: passed.
- Release checker: 116 maintained files, 43 local documentation links, 40 locked npm package records and procedural-video hash all verified.
- Generator executed; FFprobe independently confirmed H.264, 720×1280, 24 fps, eight seconds and no audio. The bundled asset is 22,316 bytes.
- Git staged whitespace checks and YAML parsing: passed.
- A separate clean export of the staged Git files installed its own dependencies and completed the documented local fixture capture, V2 build, evaluation and HTTP preview. Across three viewports and 36 checkpoints: 15/15 interaction assertions passed, full measured asset coverage, zero changed pixels, zero console errors and zero remote replay requests. This result applies only to that synthetic fixture.

The release checker verifies selected disclosure patterns and package integrity; it is not a complete security or legal audit. Test scratch output and installed dependencies are excluded from distribution.

The development implementation previously passed 91/91 synthetic engine tests and a final focused 16/16 pass on 2026-10-18. Those historical results are separate from the release-copy suite above.

The release replaces the earlier workspace-reused video with a procedural project asset. Runtime code and the skill entrypoint retain the development implementation; media tests use the bundled asset's recorded size and hash rather than the historical file's hardcoded size.

No real-site fidelity benchmark, end-to-end speedup measurement, Windows/Linux certification or external-user onboarding trial is claimed. The optional Fusion skill and its separate tests are not part of this package.

Reproduce checks from the repository root:

```sh
npm ci --prefix tools/lab
npm --prefix tools/lab run setup:browser
npm --prefix tools/lab run typecheck
npm --prefix tools/lab test
node scripts/check-release.mjs
```
