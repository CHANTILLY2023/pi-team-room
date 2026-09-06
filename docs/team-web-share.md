# Team Web Mobile Share

Team Web mobile share v1 is for self-hosted reverse tunnels only:

- `frp`
- `rathole`

The Team Web process still listens on `127.0.0.1`. Your tunnel client forwards a
public URL back to that local port. Team Web can start an already configured
`frpc` or `rathole` client, but it does not install tunnel binaries, does not
save third-party credentials, and does not use Cloudflare, ngrok, or Tailscale
as first-party providers. HTTPS is recommended; HTTP is allowed only with a
warning.

## Configure

Recommended user-level config for this machine:

```json
{
  "provider": "rathole",
  "publicUrl": "https://team.example.com",
  "configPath": "/absolute/path/to/rathole/client.toml",
  "localPort": 8787,
  "autoStart": true
}
```

Save it as `~/.pi/messenger/team-web-share.json` when you want `/team web
--share` to work from any project directory.

Project-local config is also supported and kept out of git under `.pi/`; it wins
over the user-level fallback:

```json
{
  "provider": "rathole",
  "publicUrl": "https://team.example.com",
  "configPath": "work/rathole/client.toml",
  "localPort": 8787,
  "autoStart": true
}
```

Project-local relative `configPath` values are resolved from the project root.
User-level config should use an absolute `configPath`.

Then start sharing with:

```text
/team web --share
```

You can also pass provider details per action:

```typescript
pi_messenger({
  action: "team.runtime.web",
  share: true,
  shareProvider: "frp",
  shareUrl: "https://team.example.com",
  shareTtlHours: 12
})
```

or export environment variables before starting PI:

```bash
export PI_TEAM_WEB_SHARE_PROVIDER=frp
export PI_TEAM_WEB_SHARE_URL=https://team.example.com
export PI_TEAM_WEB_SHARE_CONFIG=/path/to/frpc.toml
export PI_TEAM_WEB_SHARE_COMMAND='frpc -c /path/to/frpc.toml'
```

`PI_TEAM_WEB_SHARE_CONFIG` or `shareConfigPath` lets Team Web auto-start the
provider as `frpc -c <config>` or `rathole -c <config>`. Team Web does not read
secrets from the config and does not execute arbitrary shell commands.
`PI_TEAM_WEB_SHARE_COMMAND` remains a human/doctor hint only.

Equivalent command:

```text
/team web --share --provider frp --url https://team.example.com --ttl 12h
```

Use `/team web --share-doctor` or `team.runtime.web.share.doctor` to check the
configured provider and see the local target. Use `/team web --revoke` or
`/team web --share stop` to stop sharing.

## Provider Contract

For `frp`, configure `frpc` with an http/https/tcp proxy that forwards the
public URL to the Team Web local target.

For `rathole`, configure the rathole client with a service that forwards the
public URL to the same local target.

If a config path is present, Team Web auto-starts the provider process. If no
config path is present, Team Web still generates QR/PIN and reports manual
tunnel instructions.

The public URL must expose Team Web at its root path, such as
`https://team.example.com`. Do not include username/password, query strings, or
fragments in `shareUrl`.

## Security Lifecycle

Share is off by default. `/team web` alone remains localhost-only.

When share is explicitly enabled:

1. Team Web creates a high-entropy one-time login token and a 6 digit PIN.
2. The desktop result includes a public login URL, while the local Team Web page
   renders the QR inline in its share panel.
3. The phone scans the QR and enters the PIN.
4. On success, Team Web consumes the login token and sets an HttpOnly session
   cookie.
5. The mobile session lasts `shareTtlHours` hours, defaulting to 12.
6. The desktop local UI shows the share URL, inline QR, PIN, health, copy link,
   and a stop button.

The QR login token expires after 5 minutes and cannot be used as a long-term API
token. Mobile sessions live only in the Team Web process memory. Revoking share
clears every pending QR token and mobile session immediately. After expiry or
revoke, the phone must scan a new QR and enter the new PIN.

The mobile UI is the full Team Web. Dangerous actions keep using the existing
Team Web confirmation flow; share mode does not make the phone read-only.
