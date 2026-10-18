# Contributing

Start with a focused issue describing an observable problem, its reproduction steps and the intended behavior. Contributions should preserve the distinction between replay, approved reference and independent source reconstruction.

## Local checks

```sh
npm ci --prefix tools/lab
npm --prefix tools/lab run setup:browser
npm --prefix tools/lab run typecheck
npm --prefix tools/lab test
node scripts/check-release.mjs
```

Use synthetic local fixtures for regression tests. Do not commit captures, customer projects, authentication data or target-owned assets. A passing fixture test is not a real-site fidelity claim.

## Rights and scope

Submit only material you have the right to contribute. Identify external sources, exact versions or commits, licenses and adaptations. Keep the corresponding attribution and license texts with the code. Do not change an upstream license to Apache.

Original contributions intentionally submitted for inclusion are accepted under this project's Apache-2.0 terms, unless a separate agreement says otherwise. You retain your copyright. No additional copyright assignment or CLA is required by this release.

## Pull requests

Describe the user-visible problem and resulting behavior, checks actually run and remaining limitations. Keep unrelated refactors separate. Include a changelog entry for material behavior changes. Feature proposals for Fusion, components or hosted products belong in a separate discussion before adding scope to Clone.
