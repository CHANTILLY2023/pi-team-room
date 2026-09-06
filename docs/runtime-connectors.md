# Team Runtime Connectors

Team Runtime connects to tools the user already has. It does not store third-party account passwords, API keys, or base URLs.

## First Run

```text
pi install npm:pi-team-room
pi
/team doctor
/team web
```

`/team doctor` is local-only by default. It checks installed commands, the current PI model scope, each connector's model list, thinking levels, and the next setup step. It does not send a model request unless you explicitly ask for a probe.

To run a real two-turn hello probe:

```text
/team doctor codex-cli probe
```

or:

```typescript
pi_team({ action: "doctor", clientId: "codex-cli", probe: true, turns: 2 })
```

## Connector Matrix

| Connector | `clientId` | Auth source | Session mode | Setup |
| --- | --- | --- | --- | --- |
| PI Agent | `pi` | Current PI provider/model config | PI WEB session; SDK supported | Configure PI as usual; Team Runtime reads scoped models and `enabledModels`. |
| Codex CLI | `codex-cli` | Local logged-in `codex` CLI | `codex exec resume <thread_id>` | Install and log in to Codex CLI. |
| Claude Code CLI | `claude-code` | Local logged-in `claude` CLI | `claude --resume <session_id>` | Install and log in to Claude Code CLI. |
| Kimi Code CLI | `kimi-code` | Local logged-in `kimi` CLI | `kimi acp`, new/load session | Install and authenticate Kimi Code CLI. |
| Grok Build CLI | `grok-build` | Local logged-in `grok` CLI | `grok --session-id` / `--resume` | Install and log in to Grok Build CLI; this connector injects the local Grok proxy env. |
| Grok API via PI | `grok-pi` | Current PI provider config | PI WEB session; SDK supported | Configure the Grok-compatible provider in PI. |

Legacy `clientId` values are normalized:

| Old value | New value |
| --- | --- |
| `codex` | `codex-cli` |
| `claude` | `claude-code` |
| `kimi` | `kimi-code` |
| `grok` | `grok-build` |

## Command Overrides

By default Team Runtime uses commands from `PATH`:

```text
codex
claude
kimi
grok
```

Override command paths only when the command is not on `PATH`:

```bash
export PI_TEAM_CODEX_COMMAND=/path/to/codex
export PI_TEAM_CLAUDE_COMMAND=/path/to/claude
export PI_TEAM_KIMI_COMMAND=/path/to/kimi
export PI_TEAM_GROK_COMMAND=/path/to/grok
```

Do not put API keys in these variables. They are command paths only.

## CLI Model Discovery

Non-PI CLI connectors prefer the user's local CLI data before falling back to the bundled conservative list:

| Connector | Local source |
| --- | --- |
| Codex CLI | `$CODEX_HOME/config.toml` explicit `model_catalog_json`, otherwise `$CODEX_HOME/models_cache.json`; home defaults to `~/.codex` |
| Kimi Code CLI | `$KIMI_CODE_HOME/config.toml`, default `~/.kimi-code/config.toml`; all configured model references and custom providers |
| Grok Build CLI | `~/.grok/config.toml` and `~/.grok/models_cache.json` |
| Claude Code CLI | Local `--help` aliases/efforts and `~/.claude/settings.json`; CLI-default option plus custom ID, not a complete account catalog |

Thinking levels come from the same local source: Codex `default_reasoning_level/supported_reasoning_levels`, Kimi `default_effort/support_efforts` (including overrides), and Grok `reasoning_effort/reasoning_efforts/supports_reasoning_effort`. Models explicitly lacking reasoning do not receive invented levels. Kimi boolean thinking capabilities use native `on/off`; custom provider effort strings are not translated to Kimi-specific names.

Discovery checks file contents on each capability snapshot and before invocation. Added, changed and deleted files refresh automatically. A malformed file retains the previous successful result marked stale and is retried next time. Neither refresh nor opening the editor overwrites saved models, thinking or another member's unsaved draft. Missing current options remain editable.

Empty thinking means native default, not a fixed middle tier. Explicit member settings take priority; discovered native configuration/environment defaults precede model defaults. Selecting a different connector/model resets the editor's thinking intent to default. Saving only role fields leaves bindings untouched. CLI `default` omits the model argument. Capability metadata is unverified until a real probe succeeds; project-level configuration overlays and opaque CLI defaults may not be fully represented by discovery.

Kimi's ACP connector does not yet forward interactive tool-approval dialogs to the Web UI. Such requests fail explicitly without granting permission. Ordinary text chat and native session continuation are supported.

## PI Multi-Provider Behavior

The `pi` connector can expose multiple provider/model pairs at the same time, such as:

```text
openai/gpt-5.6-luna
deepseek/deepseek-v4-flash
deepseek/deepseek-v4-pro
```

They remain separate Team members by storing all three fields:

```text
clientId=pi
provider=<provider>
model=<model>
```

Team Runtime discovers PI models in this order:

1. `ctx.scopedModels`
2. `~/.pi/agent/settings.json` `enabledModels`
3. Current PI session model

Version 1 intentionally does not manage multiple PI account directories. If the user sets `PI_CODING_AGENT_DIR`, Team Runtime follows that current PI environment.

## Troubleshooting

| Doctor output | Fix |
| --- | --- |
| `codex-cli` is `missing` | Install/log in to Codex CLI, or set `PI_TEAM_CODEX_COMMAND`. |
| `claude-code` is `missing` | Install/log in to Claude Code CLI, or set `PI_TEAM_CLAUDE_COMMAND`. |
| `kimi-code` is `missing` | Install/log in to Kimi Code CLI, or set `PI_TEAM_KIMI_COMMAND`. |
| `grok-build` is `missing` | Install/log in to Grok Build CLI, or set `PI_TEAM_GROK_COMMAND`. |
| PI connector has no models | Check `ctx.scopedModels`, PI `enabledModels`, or the active PI model. |
| Quick doctor says `needs_probe` | The command exists, but Team Runtime has not spent a model call to prove the account/model works. Run `probe` when you want that confirmation. |
