# Team Process History

Team process history stores the parts of a model turn that are useful for
reviewing and debugging a collaboration:

- saved thinking exposed by the provider or CLI
- tool calls and tool results
- intermediate answer/process text
- final answer boundaries
- invocation outcome and retry metadata

The UI renders process sections collapsed by default and lets the user expand
them. Restarting the Web page should not delete saved process records.

## Storage Boundary

Canonical messages remain in the Team thread. Process records are keyed by
invocation ID and generation so retries, cancellations and late callbacks do
not overwrite each other.

Final answer, process history, delivery ACK, physical session state and outcome
are committed through the same fenced SQLite transaction. A silent outcome such
as `no_action` may save process without writing a public chat message.

## Connector Coverage

PI WEB uses session messages, stream snapshots and message pagination to recover
new replies. Local CLI connectors use their native stdout/history formats where
available. The runtime must filter by physical session identity and source
message; it must not import process from another project, another agent or an
unrelated connector session.

If a provider or older version did not save thinking/tool process data, the
history remains readable and the missing process is reported as unavailable. The
runtime must not synthesize hidden thinking.

## Backfill

Backfill is optional and should be run only on a backup or with the built-in
backup flow:

```bash
node --experimental-transform-types team-runtime/backfill-process.ts --dry-run
node --experimental-transform-types team-runtime/backfill-process.ts --apply
```

The script uses SQLite backup APIs so WAL contents are included. Apply mode
creates a timestamped backup and report under `.pi/messenger/process-backups/`.
Backfill should only add process records; it must not rewrite existing messages,
agents, members, models, thinking or session bindings.

## Web Behavior

Completed process is loaded on demand. Active process can be exposed in
snapshots for incremental display, with throttling to avoid flooding the page.
Switching threads cancels in-flight process loads and ignores late responses.

Access checks use the same Team Web authorization as messages. A user who cannot
see the source message must not be able to fetch its process history.

## Regression Expectations

- Process stays collapsed by default after refresh.
- Expanding one member's process does not remove another member's process.
- Similar or identical final answers after large histories are identified by
  source position, not text comparison.
- Private/direct message process remains scoped to authorized viewers.
- Backfill failure leaves original history intact and retryable.
