# Clone Every Website 1:1 — Compiled Build to Components

[![Clone checks](https://github.com/lucaschiaviniit-cloud/clone-every-website-1-1/actions/workflows/ci.yml/badge.svg)](https://github.com/lucaschiaviniit-cloud/clone-every-website-1-1/actions/workflows/ci.yml)

An experimental Codex skill by Orvibe for studying a deployed webpage, building a verified local replay, and reconstructing editable frontend source after you approve the reference.

**Status: experimental, local-first tooling.** The engine has synthetic browser and regression tests. Real-site fidelity, total time savings and unattended reconstruction are not guaranteed. Clone is the product included here; Fusion, premium components and hosted services are separate directions.

## What it does

1. Asks whether to preserve original media or replace photos/videos with local placeholders.
2. Captures the supplied page and configured interactions, preserving resource hashes and evidence.
3. Builds a local replay and checks startup, resources and configured states.
4. Pauses for your review of the local result.
5. After approval, prepares a separate workspace where the coding agent reconstructs editable source and verifies it against the approved reference.

The replay runs captured frontend code. Reconstructed source is a subsequent agent task. Backend code, server data and original development projects are not recovered by this process.

## Requirements

- Node.js 22 or newer, npm, and space for Chromium and the page's captured resources.
- Codex with local skills support for the agent workflow.
- Network access to install dependencies and acquire a target; replay verification runs locally.

The deterministic tooling makes no AI API calls and needs no API key. Your coding agent may have its own subscription or usage costs. FFmpeg is only needed to regenerate the bundled procedural video, not to use the skill.

## Install

Clone the repository into a folder named `clone-every-website-1-1`:

```sh
git clone https://github.com/lucaschiaviniit-cloud/clone-every-website-1-1.git clone-every-website-1-1
cd clone-every-website-1-1
```

Alternatively, download its ZIP and extract it to a folder named `clone-every-website-1-1`. From that folder:

```sh
npm ci --prefix tools/lab
npm --prefix tools/lab run setup:browser
```

Copy the folder to `~/.codex/skills/clone-every-website-1-1`, or on macOS/Linux create a symlink from the repository root:

```sh
mkdir -p ~/.codex/skills
ln -s "$PWD" ~/.codex/skills/clone-every-website-1-1
```

If that destination already exists, choose explicitly whether to retain or replace your existing installation. Start a new Codex session in the project where you want the output:

```text
Use $clone-every-website-1-1 to reconstruct https://YOUR-AUTHORIZED-TARGET.example/page
```

The agent asks about media before opening the target. Use a fresh output directory for every capture. For setup problems see [installation and troubleshooting](docs/INSTALLATION.md).

## Try without contacting a website

This command needs only Node and creates a configuration and handoff, without installing dependencies or opening a browser:

```sh
node scripts/clone.mjs https://example.test/page --media placeholders --prepare-only --out ../clone-runs/offline-check
```

For a browser demonstration using only the included synthetic fixture, follow [the local demo](docs/LOCAL_DEMO.md). It is an engineering example, not a real-site benchmark.

## Commands and documentation

- [Skill instructions](SKILL.md): the agent entrypoint and approval workflow.
- [Capture, review and reconstruction](docs/WORKFLOW.md): user-facing workflow and important limits.
- [Media modes](references/media-placeholders.md): what placeholders preserve and replace.
- [Operational commands](references/v1-workflow.md): inventory, review, source comparison and delivery.
- [Validation](VALIDATION.md): executed checks, supported claims and remaining gaps.
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), [changelog](CHANGELOG.md) and [roadmap](docs/ROADMAP.md).

Local validation covers macOS arm64. The GitHub Actions workflow checks Linux; [current results](https://github.com/lucaschiaviniit-cloud/clone-every-website-1-1/actions/workflows/ci.yml) are public. Other platforms and agents are not yet validated.

## License and content rights

Original project code and documentation are licensed under [Apache License 2.0](LICENSE). You may use them commercially subject to the license. Third-party excerpts and the fixture font retain their own licenses: see [NOTICE](NOTICE), [third-party inventory](tools/lab/THIRD_PARTY.md) and [licensing details](docs/LICENSING.md).

The software license grants no rights to a target website's code, media, fonts, trademarks or other content. Use owned or appropriately authorized targets and assets. Captures and reconstructed outputs are not automatically Apache-licensed and are excluded from this repository.

Orvibe's name and branding do not come with a permission to present a fork as the official product. See [brand usage](TRADEMARKS.md).
