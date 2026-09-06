import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SpawnFunction } from "./adapters.ts";
import { AcpTurnProcess } from "./acp-process.ts";
import type { TurnProcess } from "../process-history.ts";

export async function openKimiAcp(input: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; spawnFn?: SpawnFunction;
  sessionId?: string; model?: string; thinking?: string; signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const child = (input.spawnFn ?? spawn)(input.command, ["acp"], { cwd: input.cwd, env: input.env, stdio: "pipe" });
  let sessionId = input.sessionId;
  let collecting = false;
  let process = new AcpTurnProcess();
  let onProcess: ((data: TurnProcess) => void) | undefined;
  let thinking: string | undefined;
  let configs: SessionConfigOption[] = [];
  let childError: Error | undefined;
  let permissionDenied = false;
  child.on("error", error => { childError = error; });
  child.stderr?.resume();
  const connection = new ClientSideConnection(() => ({
    requestPermission: async () => {
      permissionDenied = true;
      return { outcome: { outcome: "cancelled" } };
    },
    sessionUpdate: async notification => {
      if (notification.sessionId !== sessionId) return;
      const update = notification.update;
      if (collecting && process.update(update)) onProcess?.(process.snapshot("partial"));
      if (update.sessionUpdate === "config_option_update") configs = update.configOptions;
    },
  }), ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  let closed = false;
  let closing: Promise<void> | undefined;
  const lifetimeAbort = () => { void close(); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    input.signal?.removeEventListener("abort", lifetimeAbort);
    closing = (async () => {
      if (child.exitCode != null || child.signalCode != null) return;
      let onClose: () => void;
      const exited = new Promise<void>(resolve => { onClose = resolve; child.once("close", onClose); });
      child.stdin?.end();
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
      let deadline: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([exited, new Promise<void>(resolve => { deadline = setTimeout(resolve, 2_000); })]);
      } finally { clearTimeout(force); clearTimeout(deadline!); child.removeListener("close", onClose!); }
    })();
    return closing;
  };
  input.signal?.addEventListener("abort", lifetimeAbort, { once: true });
  const run = async <T>(operation: () => Promise<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error("Kimi request cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("Kimi request timed out")), timeoutMs);
      timer.unref?.();
    });
    try {
      signal?.throwIfAborted();
      input.signal?.throwIfAborted();
      if (closed) throw new Error("Kimi ACP connection closed");
      return await Promise.race([operation(), cancelled, connection.closed.then(() => { throw childError ?? new Error("Kimi ACP connection closed"); })]);
    } catch (error) {
      if (sessionId) void connection.cancel({ sessionId }).catch(() => undefined);
      await close();
      throw error;
    } finally { clearTimeout(timer!); signal?.removeEventListener("abort", abort!); }
  };
  await run(async () => {
    await connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pi-team", version: "2.0" } });
    if (sessionId) {
      configs = (await connection.loadSession({ sessionId, cwd: input.cwd, mcpServers: [] })).configOptions ?? [];
    } else {
      const created = await connection.newSession({ cwd: input.cwd, mcpServers: [] });
      sessionId = created.sessionId;
      configs = created.configOptions ?? [];
    }
    if (input.model) configs = (await connection.setSessionConfigOption({ sessionId: sessionId!, configId: "model", value: input.model })).configOptions;
    if (input.thinking) configs = (await connection.setSessionConfigOption({ sessionId: sessionId!, configId: "thinking", value: input.thinking })).configOptions;
    const current = configs.find(option => option.id === "thinking")?.currentValue;
    thinking = typeof current === "string" ? current : typeof current === "boolean" ? current ? "on" : "off" : undefined;
  }, input.signal);
  return {
    sessionId: sessionId!, thinking,
    get process() { return process.snapshot("complete"); },
    async prompt(text: string, signal?: AbortSignal, observe?: (data: TurnProcess) => void): Promise<string> {
      process = new AcpTurnProcess();
      onProcess = observe;
      permissionDenied = false;
      collecting = true;
      try {
        const result = await run(() => connection.prompt({ sessionId: sessionId!, prompt: [{ type: "text", text }] }), signal, 30 * 60_000);
        if (permissionDenied) throw new Error("Kimi requested tool approval; the Team Web approval bridge is not available");
        if (result.stopReason === "cancelled") throw new Error("Kimi turn cancelled");
        if (!process.finalText.trim()) throw new Error("Kimi returned no final assistant text");
        return process.finalText.trimEnd();
      } finally { collecting = false; onProcess = undefined; }
    },
    close,
  };
}
