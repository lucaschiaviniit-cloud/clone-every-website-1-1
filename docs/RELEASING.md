# Publishing this prepared repository

Run the documented installation and checks first. See [VALIDATION.md](../VALIDATION.md) for what has actually been verified. Read the licensing inventory and keep the target website captures out of the release.

The Git repository can be initialized locally with:

```sh
git init -b main
git add .
git diff --cached --stat
git diff --cached --check
```

Inspect the staged files before committing. The `private: true` flag in the engine package prevents accidental npm publication; it does not set GitHub repository visibility. When preparing a fork or another distribution, choose its destination account and remote explicitly. Creating a public GitHub repository, pushing and publishing a release are separate actions by the owner.

Before announcing a public release:

1. Review staged content, copyright information and third-party notices.
2. Run the included workflow on GitHub; local validation does not imply that CI has passed.
3. Enable private vulnerability reporting and choose whether to enable Discussions.
4. Add owned/authorized demonstration media when available; do not publish historical third-party captures.
5. Tag a release only after its checks and claims are confirmed. Avoid committing generated archives or `node_modules`.

The packaged original material is Apache-2.0. Publishing grants the rights in that license, including commercial use and redistribution. Future paid products need their own clear scope and terms.
