# PI Team Room

PI Team Room is a PI extension for a mobile-first chat UI plus a persistent multi-model Team room. It keeps the simple `/` single-chat shell separate from `/team`, where each member has its own role profile, access method, model binding, thinking intent and physical session.

This project is being prepared for open-source release. The package name `pi-team-room`, repository URL and npm publication are candidates until the maintainer confirms them. The package is marked `private: true` to prevent accidental publication during preparation.

## What It Is

- `/team web` opens a local Web room for durable Team conversations.
- `/team doctor` reports local connector status without spending model calls.
- `pi_team({ action: "web" })` exposes the standalone Team tool when installed through `team-runtime/standalone-extension.ts`.
- The first empty Team initializes from detected local access methods. Installed connectors are not the same as authenticated or remotely usable models; run an explicit probe when you want to verify a connector with a real request.
- Existing Team members are not rewritten when capabilities refresh. New CLI installs or newly configured PI models appear in capabilities so the user can add them deliberately.

PI is still the extension host. PI provider models are a separate connector, and PI/PI-compatible members currently use an independent PI WEB service at `PI_TEAM_PI_WEB_URL`, `PI_WEB_URL`, or `http://127.0.0.1:8504`.

## Requirements

- PI coding agent with extension support.
- Node.js 22.19 or newer. Current local validation uses Node 24.
- Optional connector CLIs, installed and authenticated separately:
  - `codex` for Codex CLI
  - `grok` for Grok Build CLI
  - `kimi` for Kimi Code CLI
  - `claude` for Claude Code CLI
- PI WEB when using `/` single chat or PI-backed Team members.

## Install

After the final package name is confirmed and published:

```bash
pi install npm:pi-team-room
```

Local checkout for development:

```bash
cd /path/to/pi-team-room
pi --no-extensions --extension ./team-runtime/standalone-extension.ts
```

The legacy `npx pi-team-room` helper does not write to `~/.pi` by default. It only prints guidance. `--legacy-copy` exists for isolated compatibility testing and should not be used alongside PI's native package install.

## First Run

Inside PI:

```text
/team doctor
/team web
```

`/team doctor` is local-only by default. It checks commands, PI model scope, local model caches and thinking levels. It does not send prompts unless you explicitly request a probe:

```text
/team doctor codex-cli probe
```

or:

```typescript
pi_team({ action: "doctor", clientId: "codex-cli", probe: true, turns: 2 })
```

## Default Members

For a brand-new empty Team, PI Team Room creates one member per detected access profile, up to the requested `memberLimit`. For example, a machine with Codex CLI and Grok Build CLI available can start with those two members only. Missing Kimi, Claude or PI provider models are not faked as usable members.

After a Team exists, capability refreshes do not add, remove or overwrite members. If a user installs Kimi later, Kimi appears in the capability/editor list and can be added intentionally. Existing roles, aliases, model bindings, thinking intent and unsaved editor drafts are preserved.

## Conversation History

Team history is canonical and durable. User messages, member replies, saved thinking, tool calls/results, handoffs, task status and ordering are stored separately from physical provider sessions. Upgrades and connector changes must not recreate the Team, change member identity or erase the canonical thread.

When a physical session must be replaced, the runtime replays the authorized canonical history for that logical member. It must not include other members' private chats or hidden thinking. Full storage is not the same as stuffing the entire history into every model prompt; context overflow should fail clearly rather than silently summarizing and claiming complete inheritance.

Older conversations remain readable. If an older version did not save thinking/tool process data, the UI must mark that process as missing instead of inventing it. Saved process sections default to collapsed and can be expanded after restart.

## Mobile Share

`/team web` is localhost-only. Mobile access requires an explicit self-hosted tunnel:

```text
/team web --share --provider rathole --url https://team.example.com --ttl 12h
```

Supported provider contracts are `frp` and `rathole`. The extension does not install tunnel binaries or store tunnel credentials. Share login uses a one-time QR token plus a PIN and an HttpOnly session cookie. Revoke with:

```text
/team web --share stop
```

See [Team Web Mobile Share](docs/team-web-share.md).

## Data And Backup

Project data lives under:

```text
<project>/.pi/messenger/team-runtime.sqlite
<project>/.pi/messenger/team-sessions/
<project>/.pi/messenger/process-backups/
```

Back up `.pi/messenger/` before upgrading a project with important Team history. SQLite migrations are incremental and idempotent; they add columns/tables and should not rewrite roles, models, thinking or original messages.

Uninstalling the extension should not delete project `.pi/messenger/` data.

## Connector Docs

- [Connector contract](docs/connector-contract.md)
- [Runtime connectors](docs/runtime-connectors.md)
- [Team process history](docs/team-process-history.md)
- [Architecture](docs/architecture.md)
- [Privacy and security](docs/privacy-and-security.md)
- [Open-source release checklist](docs/open-source-release-checklist.md)

## Development

```bash
npm test
npm run typecheck
npm run typecheck:tests
npm pack --dry-run --json --ignore-scripts
```

Real connector probes can spend account quota. Do not run them without an explicit test scope.

## License

MIT. This work is derived from `pi-messenger` by Nico Bailon and keeps the original license and attribution. The multi-model Team protocol was informed by Clowder design notes and source review; copied code must be audited separately before publication.
