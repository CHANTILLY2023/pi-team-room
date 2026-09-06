# Architecture

PI Team Room is a PI extension with two user-facing modes:

- `/` single chat shell, backed by PI WEB session behavior.
- `/team` persistent multi-agent room, backed by Team Runtime.

The npm entry for open-source release is `team-runtime/standalone-extension.ts`.
It registers the conflict-free `pi_team` tool and `/team` command hooks. The
legacy `index.ts` remains in the repository for compatibility review, but the
standalone entry is the public package path.

## Runtime Objects

| Object | Responsibility |
| --- | --- |
| Team | Durable room and owner/principal. |
| Thread | Canonical conversation stream and folders/archive state. |
| Agent | Logical member identity, role profile, connector, model and thinking intent. |
| TeamMember | Agent membership, role label, aliases and enabled state for one Team. |
| SessionBinding | Physical provider session, effective runtime config and replay watermark. |
| Invocation | One leased unit of work for one member. |
| Process history | Saved thinking, tool calls/results and intermediate answer process. |

Canonical history and logical membership are the source of truth. Physical PI
WEB/CLI sessions are replaceable implementation details.

## Connector Boundary

Every connector receives the same binding shape:

```text
clientId
provider
model
thinking
```

PI-backed members use PI WEB or SDK sessions. Local CLI members use their own
native session/resume mechanisms and local config/cache discovery. Capability
refresh never mutates existing members or editor drafts.

## Collaboration Protocol

User mentions and agent handoffs are parsed separately. Agent text does not
route arbitrary inline mentions. Invocations commit one outcome:

- `completed`
- `no_action`
- `awaiting_user`
- `failed` or cancelled state

Outcome, optional final answer, process, session state, delivery ACK and slot
release are committed through the same fenced SQLite transaction.

## Web And Share

Team Web binds to `127.0.0.1` by default and uses per-process local tokens.
Mobile share is explicitly enabled through self-hosted frp/rathole tunnel
configuration. Revocation and expiry close existing shared sockets.

## Migration

Migrations are additive and idempotent. They may add nullable columns/tables but
must not rewrite roles, models, thinking, member IDs, canonical message order or
original replies. Backup and restore procedures live in the release checklist.
