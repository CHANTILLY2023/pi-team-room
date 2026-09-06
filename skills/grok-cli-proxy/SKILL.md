---
name: grok-cli-proxy
description: "Ensure every Grok CLI invocation in pi2pi-persistent-team uses command-scoped local proxy variables only for that Grok child process. Use when adding, reviewing, debugging, or running backend code, scripts, tests, or manual commands that call `grok`, `clientId: \"grok\"`, xAI/Grok models, or the Team Web Grok CLI adapter."
---

# Grok CLI Proxy

## Overview

Use the local proxy only around Grok CLI calls. Do not export proxy variables globally, edit shell startup files, or proxy unrelated tooling.

## Required Proxy

- `HTTP_PROXY=http://127.0.0.1:7890`
- `HTTPS_PROXY=http://127.0.0.1:7890`
- `ALL_PROXY=socks5h://127.0.0.1:7890`
- `NO_PROXY=localhost,127.0.0.1,::1`

## Backend Rule

When backend TypeScript invokes Grok CLI, import the project helper instead of hand-writing proxy env:

```ts
import { withGrokProxyEnv } from "./grok-proxy.ts";

spawn("grok", args, {
  cwd,
  env: withGrokProxyEnv(),
});
```

The canonical helper is `team-runtime/grok-proxy.ts`. It intentionally overwrites any inherited proxy values for the Grok child process, while preserving unrelated environment variables.

The Team Web runtime path for `clientId: "grok"` already uses this helper through `team-runtime/runtime.ts`.
It must keep Grok multi-turn state: first use `--session-id <binding.piSessionId>`, then persist the `grok-session:<id>` marker and use `--resume <id>` on later turns.

## Manual Command Rule

Before running real Grok model work, check whether the local proxy is listening:

```bash
nc -z 127.0.0.1 7890
```

If it is closed, warn the user that Grok networking may fail.

For manual runs, either use the bundled wrapper:

```bash
node skills/grok-cli-proxy/scripts/run-grok-with-proxy.mjs --model grok-4.5 -p "hello"
```

or use command-scoped env:

```bash
env \
  HTTP_PROXY="http://127.0.0.1:7890" \
  HTTPS_PROXY="http://127.0.0.1:7890" \
  ALL_PROXY="socks5h://127.0.0.1:7890" \
  NO_PROXY="localhost,127.0.0.1,::1" \
  grok --model grok-4.5 -p "hello"
```

## Do Not

- Do not run `proxy_on`.
- Do not export proxy variables in the current shell.
- Do not proxy `npm`, `npx`, `git`, `gh`, `curl`, or unrelated commands.
- Do not add new raw `spawn("grok", ...)` or `exec("grok ...")` calls without `withGrokProxyEnv()`.
