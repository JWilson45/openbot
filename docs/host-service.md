# OpenBot as a host service

OpenBot is a process on a machine you run. That process **is** the desk **and** the org: Grok, Chromium, SQLite, and the web UI. OpenBot does **not** provision cloud VMs (no Fly Machines). Closing a browser tab does not stop the teammate. Stopping `openbot server` — or the VM it runs on — does. If you want work to continue while a laptop is closed, run the service on a host that stays up.

This document is how to run that process as a **user** service (systemd `--user` or a launchd LaunchAgent) and expose the supported protocol endpoints. `openbot install` never requires root. Do not run Chromium as root.

Version: `openbot version` prints `{"openbot":"0.8.0","grokPin":"1.0.5","grok":"…"}`. Pin lives in `packages/acp-grok/src/pin.ts`.

---

## Honesty

- **Closing the browser does not stop OpenBot.** The SPA is a client. Turns continue on the host.
- **Stopping the service does.** `systemctl --user stop openbot`, `launchctl bootout …`, or killing the process ends Grok, Chromium, and in-flight turns.
- **Stopping the VM makes that org unreachable.** Protocol clients get connection failures. There is no hosted retry queue. SQLite state stays on disk.
- **Laptop-closed:** the **service host** must stay powered and reachable. A sleeping laptop is a stopped desk. Use a VPS, home server, or a Mac/PC that does not sleep.
- **The calendar clock is the process.** Calendar fire does not survive a stopped unit, a stopped VM, or a closed laptop: the 9am did not happen. At most one catch-up if you were down less than a day; OpenBot will not replay a weekend of missed summaries. Closing the tab does not stop a turn the calendar already queued. Stopping the process stops the clock **and** the turn.
- `$OPENBOT_HOME/desk` is a shared computer, not a security boundary **inside** an org. Grok’s process `HOME` is `$OPENBOT_HOME/grok-home`, not the service user’s home. Vault files are outside `desk/` and blocked by the ACP path guard (and by `OPENBOT_SANDBOX` when a backend is present). That is not Ada-vs-Bob isolation and not a dedicated-user jail. Skills live in `desk/skills/` (shared; overlay names only). Optional `desk/projects/<botId>/SOUL.md` is never auto-created. Operator `~/.grok/skills` are not loaded. Standing notes live in SQLite, not on the desk.
- Bind defaults to **127.0.0.1**. OpenBot does **not** implement TLS. Put Caddy or nginx in front if you need a hostname, and explicitly deny the private runtime bridge.
- The old federation HTTP API and peer-deployment workflow are not part of the frozen protocol stack. Do not deploy or configure them.
- OpenBot does **not** provision Fly Machines or any cloud VM API. You bring the hosts.

---

## Protocol surface at the cutover

These are the only externally routable agent-protocol surfaces:

| Surface | Path | Exposure |
| --- | --- | --- |
| MCP | `/mcp` | Public route; Streamable HTTP clients authenticate as required by the server. |
| A2A | `/a2a/v1` | Public A2A JSON-RPC route. |
| A2A Agent Card | `/.well-known/agent-card.json` | Public discovery document advertising `/a2a/v1`. |
| AG-UI | `/ag-ui/v1/*` | Public AG-UI run, replay, and cancel routes. |
| Grok runtime bridge | `/internal/runtime/mcp` | **Private.** Loopback-only compatibility bridge for the Grok runtime; never a client integration endpoint. |

`/mcp/v1` and every `/fed/v1/*` route were removed. There is no compatibility alias or federation deployment path. Update clients to `/mcp` or A2A as appropriate.

The server itself rejects a non-loopback `Host` for `/internal/runtime/mcp`. A public reverse proxy must also return `404` for that path so the request never reaches OpenBot. Proxy `/mcp`, `/a2a/v1`, `/.well-known/agent-card.json`, and `/ag-ui/v1/*` normally; “public” here means externally routable, not unauthenticated.

---

## Data on disk

Same layout as README “Data on disk”. Skills and soul are on the **shared** desk, not a jail:

| Path | Role |
| --- | --- |
| `$OPENBOT_HOME/desk/skills/<name>/SKILL.md` | Shared procedures. Seeded `confirm-series` and `shared-chromium` (write-if-absent). Overlay lists names only. |
| `$OPENBOT_HOME/desk/projects/<botId>/SOUL.md` | Optional voice/taboos. Never auto-created. |
| `$OPENBOT_HOME/grok-home/` | Grok child `HOME`. Operator `~/.grok/skills` are not loaded. |

---

## Install the unit

Binary (GitHub Releases). `grok` must be on PATH; `grok login` as this user.

```bash
curl -fsSL https://github.com/JWilson45/openbot/releases/latest/download/install.sh | bash
# or: brew tap JWilson45/openbot https://github.com/JWilson45/openbot && brew install openbot

openbot version
openbot org init acme --name "Acme"
openbot install --user --org acme --port 8787
```

From a git checkout after `bun install`:

```bash
bun run openbot -- version
bun run openbot -- org init acme --name "Acme"
bun run openbot -- install --user --org acme --port 8787
```

`--user` is the only mode (user unit / LaunchAgent). There is no system service. `--org acme` (or `--home DIR`) is baked into the unit as `OPENBOT_HOME` so the service stays on that org. `openbot use acme` sets the current profile for interactive CLI; the unit does not read `profiles.json` at runtime.

`install` writes a unit with the **absolute** Bun binary and `apps/server/src/cli.ts` from this checkout. Working directory is the repo root. If you move the clone, run `install` again.

It does **not** load or start the unit unless you pass `--start`.

### macOS (launchd LaunchAgent)

Writes `~/Library/LaunchAgents/ai.openbot.plist` (template: `contrib/launchd/ai.openbot.plist`).

```bash
# printed by install; $UID is your user id
launchctl load ~/Library/LaunchAgents/ai.openbot.plist
# modern equivalent
launchctl bootout gui/$UID/ai.openbot    # ignore errors if not loaded
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openbot.plist
```

`RunAtLoad` + `KeepAlive`. Unload:

```bash
launchctl bootout gui/$UID/ai.openbot
# or
launchctl unload ~/Library/LaunchAgents/ai.openbot.plist
```

`--start` runs `launchctl bootstrap` for you.

This is a **LaunchAgent** in the logged-in user session, not a LaunchDaemon. Do not install it as root. Stay logged in on a Mac that stays awake; a LaunchAgent will not survive a logged-out or sleeping machine the way a server in a datacenter will.

### Linux (systemd user unit)

Writes `~/.config/systemd/user/openbot.service` (template: `contrib/systemd/openbot.service`).

```bash
systemctl --user daemon-reload && systemctl --user enable --now openbot
systemctl --user status openbot
journalctl --user -u openbot -f
```

Stop:

```bash
systemctl --user disable --now openbot
```

`--start` runs `daemon-reload` and `enable --now`.

`Restart=always`. `After=network-online.target`. The unit is **not** a system unit under `/etc/systemd/system`.

Headless / linger (so the user instance starts at boot without a graphical login):

```bash
loginctl enable-linger "$USER"
```

`enable-linger` is OS setup and may need root; `openbot install` itself does not.

### Other OS

`openbot install` prints the rendered unit files and suggested destinations, then exits 0. Copy them yourself. Still never as root.

---

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENBOT_HOME` | Pin a data root. `--home` on the CLI. Units set this so a service stays on one org. Default without a flag is the current profile (`~/.openbot/profiles.json`), else `~/.openbot`. |
| `OPENBOT_ORG` | Select a profile by org slug (`--org` / `--profile` / positional on `demo`/`server`/`org`/`use`). Named orgs live in `~/.openbot/orgs/<slug>/`. |
| `PORT` | Listen port (default `8787`). `--port`. |
| `OPENBOT_HOST` | Bind address. `--host`. Default `127.0.0.1`. Allowed: `127.0.0.1`, `localhost`, `0.0.0.0`. |
| `OPENBOT_PUBLIC_ORIGIN` | Public URL for OAuth redirects and cookies. `--origin` overrides this env var. If neither flag nor env is set, `org.json` / stored origin is kept (the listen URL is not forced). |
| `OPENBOT_ORG_ID` | Stable org UUID. Generated when `org_meta` is empty. Set to a **different** UUID than the stored id → process refuses to boot (do not copy another home's unit env blindly). |
| `OPENBOT_ORG_SLUG` | Org slug. Single DNS label `[a-z0-9-]` (lowercase). May update stored slug. A public origin hostname like `desk.example.com` is **not** used as the slug — it becomes `local` unless you set slug via env, `$OPENBOT_HOME/org.json`, or `openbot org init --slug`. |
| `OPENBOT_ORG_NAME` | Display name. May update stored name. |
| `OPENBOT_GITHUB_CLIENT_ID` / `OPENBOT_GITHUB_CLIENT_SECRET` | GitHub OAuth app. |
| `OPENBOT_GITHUB_ALLOWLIST` | Extra comma-separated GitHub logins (also `openbot allowlist add`). |
| `OPENBOT_DEV_LOGIN` | `1` enables `/auth/local` (loopback Host only). `demo` sets this. Do not enable on a public origin. |
| `OPENBOT_HTTP_LOG` | `1` logs all HTTP request start/completion records. Slow, failed, aborted, and streaming lifecycle records are emitted regardless. Request logs omit query strings, headers, and bodies. |
| `OPENBOT_MASTER_KEY` | Override vault master. Prefer `$OPENBOT_HOME/master.key` (`0600`). |
| `OPENBOT_CHROME` | Chromium/Chrome binary if not on PATH. |
| `OPENBOT_ACP_IDLE_MS` | Kill idle **desk** Grok ACP children after this many ms. Default 7200000 (2 hours). `0` disables **desk** idle kill only — it does **not** disable Gateway. |
| `OPENBOT_GATEWAY_ACP_IDLE_MS` | Gateway ACP idle TTL. Default 1800000 (30 minutes). `0` disables Gateway idle kill only. |
| `OPENBOT_ACP_COMPACT_TURNS` | Warm compact after this many successful ACP turns on the session. Default 20. `0` disables this trigger. Desk and Gateway share the knob. |
| `OPENBOT_ACP_COMPACT_CHARS` | Warm compact when accumulated sent prompt chars plus the next inner body is `>=` this. Default 48000. `0` disables this trigger only. |
| `OPENBOT_ACP_COMPACT_ON_SWITCH` | `1` compact (`session/new` + cold digest) on thread switch instead of a switch-banner prefix. Default `0`. |
| `OPENBOT_SANDBOX` | Optional Grok-child sandbox (`auto` / `none` / `bwrap` / `seatbelt` / `required`). Default `auto`. The **server** process is not sandboxed. |

Units from `install` bind `--host 127.0.0.1` and snapshot `PATH` so `grok` is found. Do not point the **unit** `HOME` at `OPENBOT_HOME` or at `grok-home`; the server still reads `~/.grok/auth.json` of the **service user** and copies it into `grok-home/`. Only the Grok child gets `HOME=grok-home`.

### Dedicated OS user (real unix isolation)

`openbot install --user` means a systemd **user** unit / LaunchAgent, not a dedicated account. Same-uid `0600` on `master.key` does not stop Grok from reading it. To isolate the desk from your login:

1. Create a user (needs root once): `sudo useradd --create-home --home-dir /var/lib/openbot openbot` (or a macOS user with a home you control).
2. As that user: `grok login`, `openbot org init acme`, `openbot install --user --org acme --start`.
3. Linux linger so the user instance survives logout: `sudo loginctl enable-linger openbot`.

Git-over-SSH from your agent socket will not work; put remotes/keys **on the desk** or use HTTPS. Do not run Chromium as root.

---

Put GitHub secrets in a systemd drop-in or launchd environment, not in the Caddyfile.

### systemd drop-in (OAuth)

`~/.config/systemd/user/openbot.service.d/oauth.conf`:

```ini
[Service]
Environment=OPENBOT_GITHUB_CLIENT_ID=your_id
Environment=OPENBOT_GITHUB_CLIENT_SECRET=your_secret
Environment=OPENBOT_PUBLIC_ORIGIN=https://desk.example.com
```

Then `systemctl --user daemon-reload && systemctl --user restart openbot`.

GitHub OAuth app callback: `https://desk.example.com/auth/callback/github` (that is `$OPENBOT_PUBLIC_ORIGIN/auth/callback/github`). Allowlist the GitHub login:

```bash
bun run openbot -- allowlist add your-github-login
```

### launchd OAuth

Edit the LaunchAgent `EnvironmentVariables` dict (or a wrapper script) with the same variables, then `bootout` / `bootstrap`. Keep secrets out of git.

---

## Bind: 127.0.0.1 vs 0.0.0.0

Default bind is **127.0.0.1**. Local clients (the SPA, Open WebUI on the same host, Caddy on the same host) connect to `http://127.0.0.1:8787`.

`--host localhost` binds the IPv4/IPv6 localhost name as Bun serves it.

`--host 0.0.0.0` listens on every IPv4 interface. Startup JSON includes a **bindNote**: loopback is the default; exposing `0.0.0.0` without TLS is operator risk; put Caddy or nginx in front. OpenBot does not implement TLS. `/auth/local` still requires a loopback `Host` header.

Prefer: bind 127.0.0.1 + reverse proxy on 443, and set `OPENBOT_PUBLIC_ORIGIN=https://desk.example.com`.

---

## TLS via Caddy or nginx

OpenBot speaks HTTP on loopback. Terminate HTTPS yourself.

Example Caddyfile: `contrib/caddy/Caddyfile.example`. Proxy the public protocol routes `/mcp`, `/a2a/v1`, `/.well-known/agent-card.json`, and `/ag-ui/v1/*`. The Grok adapter talks to `/internal/runtime/mcp` directly over loopback; Caddy must deny that private route.

```caddy
desk.example.com {
	handle /internal/runtime/mcp* {
		respond 404
	}
	# Retired protocol paths stay unavailable during the cutover.
	handle /mcp/v1* {
		respond 404
	}
	handle /fed/v1* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}
```

Caddy handles WebSockets (`/v1/push`, `/v1/takeover`) by default.

nginx sketch (WebSocket-capable):

```nginx
server {
    listen 443 ssl;
    server_name desk.example.com;
    # ssl_certificate / ssl_certificate_key — your certs

    location ^~ /internal/runtime/mcp {
        return 404;
    }

    # Retired protocol paths stay unavailable during the cutover.
    location ^~ /mcp/v1 {
        return 404;
    }

    location ^~ /fed/v1 {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Set `OPENBOT_PUBLIC_ORIGIN` to the `https://` origin so GitHub OAuth and cookies use `Secure`.

---

## Grok CLI (same user as the service)

Turns spawn `grok agent … stdio`. That binary and `~/.grok/auth.json` must belong to the **same user** as the systemd user instance / LaunchAgent.

```bash
# as that user, on the service host
grok login
grok --version
openbot version
```

A login on your laptop does not sign in Grok on the VPS. Do not run the unit as root and expect your user `grok login` to apply.

OpenBot isolates config under `$OPENBOT_HOME/grok-home` and links auth from `~/.grok/auth.json`. User MCP servers in `~/.grok/config.toml` are not loaded.

### Pin 1.0.5

OpenBot pins Grok CLI **1.0.5**. `openbot version` reports `grokPin` and detected `grok` (or `null`). `openbot server` / `openbot demo` log `grokPin`, `grokDetected`, `grokPinOk` on the JSON startup line. Missing CLI is a warning, not a crash (`--fake` demo still starts). Older than the pin warns. Same major.minor as the pin is OK. Same major and newer than the pin is OK.

Upgrade Grok the same way you installed it, then confirm:

```bash
grok --version    # expect 1.0.5 or a compatible 1.x
bun run openbot -- version
```

To change what OpenBot considers current, edit `PINNED_GROK_CLI` in `packages/acp-grok/src/pin.ts`.

---

## Browser tab vs service

| Action | Teammates / org |
| --- | --- |
| Close the tab, reload, crash Chrome | Keep running |
| `systemctl --user stop openbot` / `launchctl bootout` / Ctrl-C | Stop |
| Host sleeps, shuts down, loses power, or you stop the VM | Org **unreachable**. Protocol clients fail. SQLite state remains. |

Restarting the service starts a new Grok ACP process. Chat history is in SQLite; OpenBot injects a thread digest on the next turn.

---

## Laptop-closed / always-on

The host that runs `openbot server` must stay up:

- Home server or VPS: systemd user unit + linger (or an equivalent always-on user session).
- Mac mini that never sleeps: LaunchAgent + stay logged in.
- The laptop you close: **not** a service host. Point the browser at the machine that stays up (`OPENBOT_PUBLIC_ORIGIN`).

Disk for `$OPENBOT_HOME` and Chromium also live on that host. Stopping that VM makes the org unreachable; sqlite and keys remain.

---

## Retired federation deployment

> **Removed at the protocol cutover. This is a migration warning, not a runbook.**

The former two-host peer/federation workflow is unsupported, and its `/fed/v1/*` routes no longer exist. Do not reuse legacy gateway/peer CLI procedures, federation environment variables, copied Ed25519 identities, or old reverse-proxy rules. Existing federation rows or key files in an upgraded data directory are inert legacy state, not evidence that the public API is available.

For standards-based agent-to-agent traffic, discover this host at `/.well-known/agent-card.json` and use the advertised `/a2a/v1` endpoint with the required bearer credential. A second host is still a separate OpenBot installation and data store; OpenBot does not provision it.
