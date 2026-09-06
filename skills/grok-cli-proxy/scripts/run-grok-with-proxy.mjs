#!/usr/bin/env node
import { spawn } from "node:child_process";

const proxyEnv = {
  HTTP_PROXY: "http://127.0.0.1:7890",
  HTTPS_PROXY: "http://127.0.0.1:7890",
  ALL_PROXY: "socks5h://127.0.0.1:7890",
  NO_PROXY: "localhost,127.0.0.1,::1",
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node skills/grok-cli-proxy/scripts/run-grok-with-proxy.mjs [grok args...]");
  process.exit(2);
}

const command = process.env.GROK_COMMAND || "grok";
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...proxyEnv,
  },
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
