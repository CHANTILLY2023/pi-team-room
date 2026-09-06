# Contributing

Thanks for helping prepare PI Team Room.

## Development Checks

Run these before proposing a change:

```bash
npm test
npm run typecheck
npm run typecheck:tests
npm pack --dry-run --json --ignore-scripts
```

Real connector probes can spend account quota and may touch local CLI sessions.
Keep them opt-in and document exactly which connector/model was tested.

## Compatibility Rules

- Do not rewrite or delete `.pi/messenger/` history during migrations.
- Keep logical Team member identity separate from physical provider sessions.
- Preserve each member's role profile, model binding and thinking intent unless
  the user explicitly changes them.
- Keep capability discovery separate from Team membership. Newly discovered
  connectors should be offered to the user, not auto-added to existing rooms.
- Do not put API keys, auth files, tunnel configs, PINs or session tokens in
  tests, docs or release artifacts.

## Code Style

Follow the existing TypeScript style. Prefer focused regression tests for
runtime, connector, Web UI and migration behavior. Avoid broad rewrites unless a
small change cannot preserve the required history and session semantics.
