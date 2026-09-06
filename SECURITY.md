# Security Policy

PI Team Room is a local PI extension, not a hosted multi-tenant service.

## Supported Surface

- Localhost Team Web server with per-process token URLs.
- Optional self-hosted mobile share through frp or rathole.
- Local connector CLIs selected by the user.
- Project-local SQLite history under `.pi/messenger/`.

## Sensitive Data

Do not include API keys, account tokens, PI WEB login URLs, mobile PINs, tunnel
secrets, `.pi/`, `.pi-subagents/`, `work/`, or local connector config files in
issues or release artifacts.

The extension reads local CLI configuration and caches to discover model
options. It should not store third-party credentials. Command override
environment variables such as `PI_TEAM_CODEX_COMMAND` must contain command paths
only, not secrets.

## Reporting

Until the public repository is confirmed, report security issues privately to
the maintainer preparing the release. After publication, replace this section
with the repository's preferred private disclosure channel.

## Known Limits

Agent tool access is not an operating-system sandbox. A connector process that
has shell/file access may read files available to that user account. Team Web
private-message filtering protects API reads inside the extension; it does not
isolate untrusted code running on the same machine.

Mobile share should use HTTPS outside a trusted LAN. Plain HTTP exposes QR
tokens, PIN entry and cookies to the network.
