# Team Runtime Connector Contract

Team Runtime has one public binding shape for every member:

```text
clientId  = access method
provider  = model provider or CLI namespace
model     = concrete model alias
thinking  = connector-specific thinking/reasoning effort
```

The connector registry in `team-runtime/capabilities.ts` is the source of truth for labels, auth mode, session mode, default command, command override env var, and fallback thinking levels. Web capabilities, doctor output, and runtime adapters should all derive from that registry.

Non-PI CLI model options should come from the user's local CLI config/cache when available. Bundled model lists are fallback only.

## Runtime Adapter Interface

Non-PI connectors implement:

```typescript
interface AgentRuntimeProviderAdapter {
  readonly clientId: string;
  prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession>;
  invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
  dispose?(threadId?: string, agentId?: string): Promise<void> | void;
}
```

Adapters must preserve:

```text
request.agent.clientId
request.agent.provider
request.agent.model
request.agent.thinking
request.binding.piSessionId
request.binding.sessionFile
```

`sessionFile` may be a connector marker such as `codex-session:<thread_id>` rather than a PI JSONL path.

## Existing Connectors

| `clientId` | Adapter | Model parameter | Thinking parameter | Resume mechanism |
| --- | --- | --- | --- | --- |
| `pi` | PI WEB bridge (SDK also supported) | provider/model API | thinking API | PI WEB session ID / SDK AgentSession |
| `grok-pi` | PI WEB bridge (SDK also supported) | provider/model API | thinking API | PI WEB session ID / SDK AgentSession |
| `codex-cli` | `CodexCliRuntimeAdapter` | `codex exec --model <model>` | `-c model_reasoning_effort="<thinking>"` | `codex exec resume <thread_id>` |
| `claude-code` | `ClaudeCodeCliRuntimeAdapter` | `claude --model <model>` | `--effort <thinking>` | `--resume <session_id>` |
| `kimi-code` | `KimiCodeCliRuntimeAdapter` | ACP native model reference | ACP `thinking` config option | ACP `session/load` |
| `grok-build` | `GrokBuildCliRuntimeAdapter` | `grok --model <model>` | `--reasoning-effort <thinking>` | `--session-id` / `--resume` |

## Adding A Connector

### Invocation Outcomes

An adapter returns the current turn's final answer in `content`, never a concatenation of pre-tool commentary and final output. Preserve leading indentation because it distinguishes code examples from handoffs. Full thinking, tools and intermediate text belong in `process`.

`AgentRuntimeResult.control` optionally supplies `{ disposition, reason?, targets? }`, with `completed`, `no_action`, or `awaiting_user`. Explicit targets are authoritative, including an empty list. The coordinator binds the output to its live invocation lease; adapters cannot select a different invocation, source or thread to complete. No unauthenticated completion endpoint is exposed.

The bundled connectors currently use the same final-line text fallback, not connector-specific tool/callback registration:

- `[[team:completed]]` terminates without dispatching further work.
- `[[team:awaiting_user]]` follows a question and suppresses all handoffs.
- `[[team:no_action]] reason` is the entire final output for silent completion; an empty response is not success.

Quoted, fenced, indented and embedded examples do not execute. Other final output can hand off using line-leading member selectors, at most two other members. User mention parsing is separate and remains unchanged. A multi-target source starts independent collection; contributions cannot create child dispatches. This is not a forced supervisor or synthesized final answer.

Outcome, optional final, process, cursor, physical session state, delivery ACK and lease release commit in one fenced SQLite transaction. `POST /api/send` accepts `replyTo` for an explicit response to a waiting question, routes only to its asking member, and atomically records resolution. Unrelated conversation does not imply approval. `routeMessage(parentInvocationId)` is rejected; agent handoffs must use the leased outcome commit.

Grok accepts both ACP notifications and the locally observed `thought/text/end` headless stream. ID-less deltas belong to that invocation's dedicated child process; an explicit conflicting session ID fails. For legacy events, exact-session native history and the exact prompt recover final/process boundaries. Unknown legacy events require confirmed native history instead of inventing tool data. Tools not represented by recognized live events may appear only after native history is read.

Default scheduler limits are three attempts, depth eight, 32 invocations per root and four alternating two-agent edges. These are PI-team defaults, not a claim about Clowder's values; constructor options can override them. Deterministic protocol errors stop immediately.

### Registration

1. Add a connector definition in `TEAM_RUNTIME_CONNECTORS`.
2. Add model options and thinking levels in the capability matrix.
3. If it is a local CLI, implement `AgentRuntimeProviderAdapter`.
4. Register the adapter in `PiAgentRuntime`.
5. Add doctor coverage and unit tests for command detection, model list, thinking mapping, and resume parameters.
6. Add a real probe command to `team-runtime/verify-capabilities.ts` if the connector can be safely probed.

## Safety Rules

- Do not store third-party credentials in Team Runtime.
- Keep command override environment variables as command paths only.
- Do not inject proxy variables except in the Grok Build connector.
- Default doctor checks must not send model requests.
- Real model calls require explicit `probe: true`.

## Configuration And Context

An omitted update field means unchanged; empty thinking means inherit the native default. The stored agent retains that intent. The runtime binding records the effective thinking, native model reference, configuration identity, initialization state and physical context watermark separately from the canonical read cursor.

`prepare` accepts an `AbortSignal`. PI WEB HTTP requests have deadlines, including response-body reads; cancellation sends stop with a separate three-second deadline. Kimi uses the official ACP SDK and bounded process cleanup. Tool permission requests are denied and surfaced as errors until a Team Web approval bridge exists; the connector must not enable automatic approval as a workaround.

Configuration changes or incomplete initialization may require a new physical session. The coordinator replays the complete authorized canonical history through the current request, including the agent's own replies, excluding other agents' private messages. No silent summarization or truncation is applied. Initialization is committed with the fenced output; failed attempts remain incomplete. Database migration only adds missing columns and preserves user configuration and original history.

Discovery fingerprints refresh capabilities without mutating agents or editor drafts. Execution fingerprints exclude cache timestamps and CLI trust bookkeeping so normal CLI cache writes do not rotate sessions. A changed effective binding still rotates the physical session where clearing native overrides is unreliable.

Shared WebSocket connections are checked at connection, event send and operation receive; revocation closes existing connections and expiration has an idle timer. Socket identities guard late callbacks, and reconnect uses snapshots/cursors. Capability discovery is not proof of account authorization or model availability.
