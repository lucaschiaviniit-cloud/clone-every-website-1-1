# Security reporting

Do not include credentials, private captures, live session data or a public exploit against an unrelated website in issues.

When hosted on GitHub with private vulnerability reporting enabled, use the repository's Security → Report a vulnerability form. If that option is unavailable, open an issue requesting a private contact without disclosing exploit details. The project currently has no published response-time SLA.

Captures are local files and may still contain sensitive content from a response despite redaction. Review and sanitize any evidence before sharing it. An offline replay executes captured website JavaScript in the browser; keep it isolated from unrelated confidential work and use supported, updated browser tooling.

Maintainers should enable GitHub private vulnerability reporting before announcing the public release.
