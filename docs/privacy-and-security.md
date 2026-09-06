# Privacy And Security Notes

PI Team Room is designed for a single user's local machine or trusted project
environment. It is not a hardened hosted collaboration platform.

## Local Data

Project Team data is stored in `.pi/messenger/`:

- `team-runtime.sqlite`
- `team-sessions/`
- `process-backups/`
- share config when project-local sharing is used

These files can contain prompts, replies, saved thinking, tool outputs and task
state. They should stay out of source control and npm packages.

## Connector Data

The runtime may read local CLI config and cache files to discover models and
thinking levels:

- `~/.codex/config.toml`, `~/.codex/models_cache.json`
- `~/.kimi-code/config.toml`
- `~/.grok/config.toml`, `~/.grok/models_cache.json`
- Claude Code help output and settings

Discovery is not authentication proof. Doctor checks are local-only unless
`probe: true` is explicitly requested.

## Web Tokens

Local Team Web URLs contain per-process tokens. Mobile share uses one-time login
tokens, a PIN and HttpOnly session cookies. Do not publish logs, screenshots or
docs containing live URLs, tokens or PINs.

## Agent Permissions

Connectors run with the user's local account permissions. Private Team messages
are filtered by the extension API, but a local CLI with shell access may still
read files from the project or home directory. Do not market this as a secure
multi-tenant sandbox.
