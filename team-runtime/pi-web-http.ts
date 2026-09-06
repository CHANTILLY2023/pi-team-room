export function redactRuntimeError(message: string): string {
  return message.replace(/(?:sk-|key-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|authorization|token)\s*[=:]\s*)[^\s,}"']+/gi, "$1[redacted]");
}

export async function piWebJson(
  url: string,
  options: { body?: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("PI Web request timed out")), options.timeoutMs ?? 30_000);
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, {
      signal,
      ...(options.body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options.body),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try { const value = JSON.parse(text); detail = typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : ""; } catch {}
      throw new Error(`PI Web request failed with HTTP ${response.status}${detail ? ": " + redactRuntimeError(detail).slice(0, 240) : ""}`);
    }
    return text.trim() ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}
