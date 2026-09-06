import { Socket } from "node:net";

export interface GrokProxyEndpoint {
  host: string;
  port: number;
  protocol: "http" | "socks5h";
}

export const DEFAULT_GROK_PROXY_ENDPOINTS: readonly GrokProxyEndpoint[] = Object.freeze([
  { host: "127.0.0.1", port: 7890, protocol: "http" },
  { host: "127.0.0.1", port: 7891, protocol: "http" },
  { host: "127.0.0.1", port: 7897, protocol: "http" },
  { host: "127.0.0.1", port: 1087, protocol: "socks5h" },
  { host: "127.0.0.1", port: 1080, protocol: "socks5h" },
  { host: "127.0.0.1", port: 39876, protocol: "http" },
]);

export const GROK_PROXY_ENV = Object.freeze(proxyEnvForEndpoint(DEFAULT_GROK_PROXY_ENDPOINTS[0]!));

export function proxyEnvForEndpoint(endpoint: GrokProxyEndpoint): NodeJS.ProcessEnv {
  const base = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`;
  const httpBase = endpoint.protocol === "http" ? base : `http://${endpoint.host}:${endpoint.port}`;
  const allProxy = endpoint.protocol === "http" && endpoint.host === "127.0.0.1" && endpoint.port === 7890
    ? `socks5h://${endpoint.host}:${endpoint.port}`
    : base;
  return {
    HTTP_PROXY: httpBase,
    HTTPS_PROXY: httpBase,
    ALL_PROXY: allProxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
  };
}

export function withGrokProxyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ...GROK_PROXY_ENV,
  };
}

function withoutUnavailableLocalProxy(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const knownValues = new Set(DEFAULT_GROK_PROXY_ENDPOINTS.flatMap((endpoint) => {
    const proxyEnv = proxyEnvForEndpoint(endpoint);
    return [proxyEnv.HTTP_PROXY, proxyEnv.HTTPS_PROXY, proxyEnv.ALL_PROXY, proxyEnv.NO_PROXY];
  }));
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const) {
    if (env[key] && knownValues.has(env[key])) delete env[key];
  }
  return env;
}

export function isProxyEndpointListening(endpoint: GrokProxyEndpoint, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(endpoint.port, endpoint.host);
  });
}

export function isGrokProxyListening(timeoutMs = 250): Promise<boolean> {
  return isProxyEndpointListening(DEFAULT_GROK_PROXY_ENDPOINTS[0]!, timeoutMs);
}

function proxyEndpointFromEnv(base: NodeJS.ProcessEnv = process.env): GrokProxyEndpoint | undefined {
  const raw = base.GROK_PROXY_URL || base.IKUUU_PROXY_URL || base.IKUUU_PROXY || "";
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const port = Number(url.port);
    if (!url.hostname || !Number.isFinite(port)) return undefined;
    return {
      host: url.hostname,
      port,
      protocol: url.protocol.startsWith("socks") ? "socks5h" : "http",
    };
  } catch {
    return undefined;
  }
}

export async function resolveGrokProxyEndpoint(input: {
  base?: NodeJS.ProcessEnv;
  candidates?: readonly GrokProxyEndpoint[];
  isListening?: (endpoint: GrokProxyEndpoint) => boolean | Promise<boolean>;
} = {}): Promise<GrokProxyEndpoint | undefined> {
  const envEndpoint = proxyEndpointFromEnv(input.base);
  const candidates = envEndpoint
    ? [envEndpoint, ...(input.candidates ?? DEFAULT_GROK_PROXY_ENDPOINTS)]
    : input.candidates ?? DEFAULT_GROK_PROXY_ENDPOINTS;
  const seen = new Set<string>();
  for (const endpoint of candidates) {
    const key = `${endpoint.protocol}:${endpoint.host}:${endpoint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listening = await (input.isListening ?? isProxyEndpointListening)(endpoint);
    if (listening) return endpoint;
  }
  return undefined;
}

export async function grokRuntimeEnv(
  base: NodeJS.ProcessEnv = process.env,
  proxyAvailable?: () => boolean | Promise<boolean>,
): Promise<NodeJS.ProcessEnv> {
  if (proxyAvailable) {
    return await proxyAvailable()
      ? withGrokProxyEnv(base)
      : withoutUnavailableLocalProxy(base);
  }
  const endpoint = await resolveGrokProxyEndpoint({ base });
  return endpoint
    ? { ...base, ...proxyEnvForEndpoint(endpoint) }
    : withoutUnavailableLocalProxy(base);
}
