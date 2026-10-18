# Installation and troubleshooting

Run all commands from the repository root unless a section says otherwise. Keep the installed skill folder named `clone-every-website-1-1`; this preserves the `$clone-every-website-1-1` invocation. The GitHub repository may have a different name.

```sh
node --version
npm ci --prefix tools/lab
npm --prefix tools/lab run setup:browser
node scripts/clone.mjs --help
```

Use a development install: the engine runs TypeScript through `tsx`, which is a development dependency. Do not install with `--omit=dev` or use `NODE_ENV=production` for the tooling install.

On Linux, Playwright may need operating system libraries. From `tools/lab`, `npx playwright install --with-deps chromium` installs the browser and required system packages; system-package installation may require administrator access. The included GitHub workflow runs this in its runner.

Copy the installed repository into your Codex skills directory or link it there, then start a new session. Agent skill discovery and account access depend on your client configuration. This project does not configure your account.

## Common problems

| Symptom | Action |
| --- | --- |
| `MEDIA_CHOICE_REQUIRED` | Supply `--media original` or `--media placeholders`, or an explicit `mediaMode` in your configuration. |
| Missing Chromium executable | Run the browser setup command from this package. |
| Preflight fails on disk space or loopback binding | Read the run's `preflight.json`; resolve the reported local cause before retrying. |
| Output directory is not empty | Choose a fresh output path; keep the previous run intact. |
| Canonical redirect refused | Inspect the final URL and start a fresh run targeting it directly. |
| Missing images or incorrect intrinsic geometry with placeholders | Read [media modes](../references/media-placeholders.md); specify dimensions or use originals. |
| Replay works but editable components are absent | Source reconstruction starts only after explicit approval and is performed by the agent. |

## Updating

Keep captures and source workspaces outside the installed skill. Install a new release's locked dependencies again. Engine changes can invalidate earlier approval records: the workflow binds approval to the actual corpus, replay and engine identity. Do not bypass that check.

No automatic update service, telemetry upload or hosted account is included. Local metrics are documented in [measurement](../references/measurement.md).
