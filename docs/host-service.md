# OpenBot as a host service

OpenBot is a process on a machine you run. That process **is** the desk **and** the org: Grok, Chromium, SQLite, and the web UI. OpenBot does **not** provision cloud VMs (no Fly Machines). Closing a browser tab does not stop the teammate. Stopping `openbot server` — or the VM it runs on — does. If you want work to continue while a laptop is closed, run the service on a host that stays up.

This document is how to run that process as a **user** service (systemd `--user` or a launchd LaunchAgent) and how to federate **two** such hosts. `openbot install` never requires root. Do not run Chromium as root.

Version: `openbot version` prints `{"openbot":"0.3.0","grokPin":"1.0.5","grok":"…"}`. Pin lives in `packages/acp-grok/src/pin.ts`.

---

## Honesty

- **Closing the browser does not stop OpenBot.** The SPA is a client. Turns continue on the host.
- **Stopping the service does.** `systemctl --user stop openbot`, `launchctl bootout …`, or killing the process ends Grok, Chromium, and in-flight turns.
- **Stopping the VM makes that org unreachable.** Peers get timeouts. There is no hosted retry queue. sqlite, `org.ed25519`, and inbox rows stay on disk (`held` / `pending`).
- **Laptop-closed:** the **service host** must stay powered and reachable. A sleeping laptop is a stopped desk. Use a VPS, home server, or a Mac/PC that does not sleep.
- **The calendar clock is the process.** Calendar fire does not survive a stopped unit, a stopped VM, or a closed laptop: the 9am did not happen. At most one catch-up if you were down less than a day; OpenBot will not replay a weekend of missed summaries. Closing the tab does not stop a turn the calendar already queued. Stopping the process stops the clock **and** the turn.
- `$OPENBOT_HOME/desk` is a shared computer, not a security boundary **inside** an org. Cross-org is messages only (one hop: A→B). Ada on A cannot spawn Grok on B.
- Bind defaults to **127.0.0.1**. OpenBot does **not** implement TLS. Put Caddy or nginx in front if you need a hostname. Caddy **must** 404 `/mcp/v1`; `/fed/v1` is the public federation surface.
- **Federation is off until you turn it on** (`openbot gateway on` on **both** sides). Off does not delete the Gateway row or `org.ed25519`.
- OpenBot does **not** provision Fly Machines or any cloud VM API. You bring the hosts.

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
| `OPENBOT_MASTER_KEY` | Override vault master. Prefer `$OPENBOT_HOME/master.key` (`0600`). |
| `OPENBOT_CHROME` | Chromium/Chrome binary if not on PATH. |
| `OPENBOT_ACP_IDLE_MS` | Kill idle **desk** Grok ACP children after this many ms. Default 600000 (10 minutes). `0` disables **desk** idle kill only — it does **not** disable Gateway. |
| `OPENBOT_GATEWAY_ACP_IDLE_MS` | Gateway ACP idle TTL. Default 1800000 (30 minutes). `0` disables Gateway idle kill only. |
| `OPENBOT_FEDERATION` | Panic **off:** `0` makes federation effective-off even if the DB flag is on. Unset/`1` does **not** force on. Restart the unit so the process sees env. `GET /fed/v1/info` still works. |
| `OPENBOT_FED_ALLOW_HTTP` | `1` allows RFC1918 `http://` peer URLs (LAN). Default is https, plus loopback `http://127.0.0.1` / `localhost`. |

Units from `install` bind `--host 127.0.0.1` and snapshot `PATH` so `grok` is found. Do not point `HOME` at `OPENBOT_HOME`; Grok CLI auth lives in `~/.grok` of the **service user**.

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

Example Caddyfile: `contrib/caddy/Caddyfile.example`. MCP is loopback-only (Grok talks to `http://127.0.0.1:{port}/mcp/v1`, not through Caddy). `/fed/v1` **must** be proxied — that is the public federation surface.

```caddy
desk.example.com {
	handle /mcp/v1* {
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

    location /mcp/v1 {
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
| Host sleeps, shuts down, loses power, or you stop the VM | Org **unreachable**. Peers time out. Disk identity and inbox remain. |

Restarting the service starts a new Grok ACP process. Chat history is in SQLite; OpenBot injects a thread digest on the next turn. Federation inbox already stored stays on disk (`held` or `pending`).

---

## Laptop-closed / always-on

The host that runs `openbot server` must stay up:

- Home server or VPS: systemd user unit + linger (or an equivalent always-on user session).
- Mac mini that never sleeps: LaunchAgent + stay logged in.
- The laptop you close: **not** a service host. Point the browser at the machine that stays up (`OPENBOT_PUBLIC_ORIGIN`).

Disk for `$OPENBOT_HOME` and Chromium also live on that host. Stopping that VM makes the org unreachable; sqlite and keys remain.

---

## Two VMs, two orgs (federation)

One `openbot server` process is one org: one `$OPENBOT_HOME`, one sqlite, one Ed25519 key, one GitHub allowlist, one set of `sk-ob_…` keys. A second VM is a **second process**. Switching org in a client means switching **base URL** (and the key minted on that VM).

OpenBot does **not** provision the VMs. No Fly Machines, no Machines API, no remote runner (Grok on B driven from A). You install the same binary twice.

Trust is **bidirectional**. A `peers add` B **and** B `peers add` A **and both** `openbot gateway on`. One-way allowlist = `401 unknown_peer` on the reverse path. **hop is 1:** a message is A→B only. B does not forward it to C.

### Assumptions

| | VM A | VM B |
| --- | --- | --- |
| Public origin | `https://org-a.example.com` | `https://org-b.example.com` |
| Slug | `acme` | `beta` |
| Bind | `127.0.0.1:8787` | `127.0.0.1:8787` |

Do every step on **each** VM unless a heading says otherwise. Do not copy `$OPENBOT_HOME`, `org.ed25519`, or `OPENBOT_ORG_ID` from one VM to the other (`OPENBOT_ORG_ID` mismatch with stored `org_id` refuses to boot).

### 1. Install the unit

Binary or git checkout (same as above):

```bash
# curl -fsSL https://github.com/JWilson45/openbot/releases/latest/download/install.sh | bash
openbot version
openbot install --user --org acme --port 8787   # VM B: --org beta
# then load / enable --now, or pass --start
```

`grok login` as the **same user** the unit runs as, on **that** VM. A laptop Grok login does not count.

GitHub OAuth callback is `$OPENBOT_PUBLIC_ORIGIN/auth/callback/github` **on that VM**. Add both callbacks to the OAuth app (or use two apps). Allowlist the operator login on each home:

```bash
bun run openbot -- allowlist add your-github-login
```

### 2. Origin + TLS

Bind **127.0.0.1**. Terminate HTTPS at Caddy. Set origin on the **service**, not in the Caddyfile. `createApp` snapshots `publicOrigin` from env at boot — reload the unit after writing env or OAuth/cookies still use the listen origin.

**systemd** drop-in (VM A). Path: `~/.config/systemd/user/openbot.service.d/oauth.conf`:

```ini
[Service]
Environment=OPENBOT_PUBLIC_ORIGIN=https://org-a.example.com
Environment=OPENBOT_GITHUB_CLIENT_ID=…
Environment=OPENBOT_GITHUB_CLIENT_SECRET=…
```

Then:

```bash
systemctl --user daemon-reload && systemctl --user restart openbot
```

On VM B use `OPENBOT_PUBLIC_ORIGIN=https://org-b.example.com` in the same drop-in path, then daemon-reload/restart there.

**launchd:** add the same keys to `EnvironmentVariables` in `~/Library/LaunchAgents/ai.openbot.plist`, then:

```bash
launchctl bootout gui/$UID/ai.openbot    # ignore errors if not loaded
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openbot.plist
```

Caddy on **each** VM **must** 404 MCP and proxy the rest (including `/fed/v1`). Install the site block and reload Caddy (`sudo systemctl reload caddy`, or `caddy reload --config /etc/caddy/Caddyfile`).

```caddy
# VM A
org-a.example.com {
	handle /mcp/v1* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}

# VM B — that host's Caddyfile
org-b.example.com {
	handle /mcp/v1* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}
```

`--host 0.0.0.0` remains the warned hatch. `/auth/local` is loopback `Host` only — do not enable `OPENBOT_DEV_LOGIN` on a public origin.

### 3. Org init (zero users)

Identity and the Ed25519 key exist **before the first login**. Gateway does not. The CLI does **not** read the systemd drop-in — export origin in this shell.

```bash
# VM A
export OPENBOT_PUBLIC_ORIGIN=https://org-a.example.com
bun run openbot -- org init acme --name "Acme"
bun run openbot -- org
# { orgId, slug, name, publicOrigin, pubkey, federationEnabled: false, gateway: null, home, profile }

# VM B
export OPENBOT_PUBLIC_ORIGIN=https://org-b.example.com
bun run openbot -- org init beta --name "Beta"
bun run openbot -- org
```

`org init <slug>` registers a profile (first init on a machine that already has `~/.openbot/openbot.sqlite` **adopts** that directory; otherwise `$HOME/.openbot/orgs/<slug>`). It writes `org.json` and upserts `org_meta` (it never rotates `org_id`). FQDN origins such as `org-a.example.com` do **not** auto-slug — they become `local` unless you pass the slug / `OPENBOT_ORG_SLUG` / `org.json`. `--home` still pins a path when you need it.

Restart the unit again so the process is up with that origin, **then** probe (repeat on VM B with `org-b.example.com`):

```bash
systemctl --user daemon-reload && systemctl --user restart openbot
# launchd: bootout / bootstrap as in step 2

curl -sS -o /dev/null -w '%{http_code}\n' https://org-a.example.com/mcp/v1
# 404

curl -sS https://org-a.example.com/fed/v1/info
# JSON: gateway null (no login yet), caps.federation: "off", caps.hopLimit: 1, pubkey set
```

`GET /fed/v1/info` is public (rate-limited) and is **not** a solicitation.

### 4. First login (Gateway row, federation still off)

Sign in with an allowlisted GitHub user on each origin. First login creates the org account and auto-provisions a **Gateway** bot (`role='gateway'`, not a seventh desk slot).

```bash
bun run openbot -- org
# gateway: { id, name: "Gateway" }, federationEnabled: still false
```

`GET /v1/bots.bots[]` stays desk-only. Gateway is an API sidecar (`GET /v1/bots.gateway`, `enabled: false`). `GET /v1/models` lists `openbot/Gateway` once the row exists; listing it does **not** send org mail. This cut has **no SPA Gateway rail** — talk to the diplomat from Open WebUI as `openbot/Gateway`.

Federation **off** means: no Gateway ACP child (RAM valve), `POST /fed/v1/messages` from a trusted peer is `403 federation_disabled` with inbox `held`, `SendToOrg` would fail `federation_off`. An Open WebUI / `openbot/Gateway` completion gets a system line, not a Grok turn.

### 5. `openbot gateway on` on **both**

```bash
# VM A
bun run openbot -- gateway on
# VM B
bun run openbot -- gateway on
```

Writes `org_meta.federation_enabled`. Does **not** delete the Gateway row or keys. `OPENBOT_FEDERATION=0` in the unit env still wins (panic; cannot force on). Cookie API (not `sk-ob_…`): `PATCH /v1/org { "federationEnabled": true }`.

| Control | Live? | Can force ON? | Can force OFF? |
| --- | --- | --- | --- |
| `openbot gateway on` / `off` | Yes (DB) | Yes, unless env is `0` | Yes |
| `PATCH /v1/org { federationEnabled }` | Yes (DB) | Yes, unless env is `0` | Yes |
| `OPENBOT_FEDERATION=0` in the unit env | After the process sees env (restart the unit) | **No** | **Yes** |

Turning **on** flips `held` → `pending` and may spawn Gateway ACP on the next inbound mail or Open WebUI / `openbot/Gateway` completion.

### 6. Peers add both ways (A→B and B→A)

Copy identity from the **peer** with the public GET or local CLI (no cookie). Map fields 1:1:

| Peer JSON (`openbot org` or `GET /fed/v1/info`) | `peers add` flag |
| --- | --- |
| `orgId` | `--org-id` |
| `pubkey` | `--pubkey` — standard base64 of the **raw 32-byte** Ed25519 key, **not PEM** |
| `publicOrigin` | `--url` (origin only, no path) |
| `slug` | `--slug` |

```bash
# on VM B — print what Acme will paste
bun run openbot -- org
# or: curl -sS https://org-b.example.com/fed/v1/info

# on VM A: allow Beta (paste Beta's orgId / pubkey / publicOrigin)
bun run openbot -- peers add \
  --slug beta \
  --url https://org-b.example.com \
  --pubkey "$BETA_PUBKEY" \
  --org-id "$BETA_ORG_ID"

# on VM B: allow Acme (paste Acme's orgId / pubkey / publicOrigin)
bun run openbot -- peers add \
  --slug acme \
  --url https://org-a.example.com \
  --pubkey "$ACME_PUBKEY" \
  --org-id "$ACME_ORG_ID"

bun run openbot -- peers
```

Optional preview (no insert): `POST /v1/org/peers/from-info` needs a cookie **session** (`openbot_session`), not `sk-ob_…`. Prefer the public GET above.

`org_peers.slug` is UNIQUE on that sqlite (`SendToOrg({ org: "beta" })` must be unambiguous). Outbound `baseUrl` is **https** except loopback `http://127.0.0.1` / `localhost` (or RFC1918 http when `OPENBOT_FED_ALLOW_HTTP=1`). Link-local and metadata IPs are blocked. There is **no TOFU** and **no auto-add**.

Unsigned “please add me”, unknown org, bad signature, `hop ≠ 1`: **not mail**. See [Off, held, solicit](#off-held-solicit).

### 7. Open WebUI: second connection = second org

There is no OpenAI `organization` object. Each VM is another OpenAI provider.

| Org | Base URL | API key | Model |
| --- | --- | --- | --- |
| Acme | `https://org-a.example.com/v1` | `sk-ob_…` minted **on Acme** | `openbot/Ada`, `openbot/Gateway` |
| Beta | `https://org-b.example.com/v1` | `sk-ob_…` minted **on Beta** | `openbot/Ada`, `openbot/Gateway` |

Mint the key in that VM’s Settings (or `POST /v1/api-keys` with **that** origin’s cookie). Keys do not work on the other sqlite. Completions enqueue the bot’s **human** thread on that process. Completions to `openbot/Gateway` are a local DM on that VM (this cut has no SPA Gateway rail); they send org mail only if federation is on and Gateway calls `SendToOrg`.

### Off, held, solicit

| Inbound | Federation **on** | Federation **off** |
| --- | --- | --- |
| Trusted (allowlisted + valid JWS + `hop=1`) | `org_inbox` `pending`, at most one Gateway turn | `org_inbox` `held`, **403** `federation_disabled`, **no** ACP |
| Untrusted (unknown peer, bad sig, `hop ≠ 1`, oversize, …) | **Not mail.** 401/400. Capped solicitation notice. No inbox pending. | Same (untrusted never becomes `held`) |

Untrusted solicits are **not mail** (no `org_inbox` row). They are a capped Gateway-DM `origin='system'` notice (Open WebUI `openbot/Gateway`; Settings → Peers/Trust when that UI exists) plus `audit_events` `fed.solicit` / `org_solicit`. Coalesced **one per (peer org id or IP /24) per hour**. Copy looks like: `Org acme (https://…) tried to send mail. Not on your peer list — ignored.` Bad signature on a claimed peer: `Claimed acme but the signature failed — ignored.` `GET /v1/org/inbox` is **trusted** `pending`/`held` only — it will not show “not on your peer list” notices. `GET /fed/v1/info` is not a solicitation.

Turn federation **off** anytime: `openbot gateway off`, `PATCH /v1/org { "federationEnabled": false }`, or `OPENBOT_FEDERATION=0`. Schema, Gateway row, peers, and keys stay. Held mail waits until you turn it on.

### Hop = 1

A federation message **never leaves the second org**. `hop` MUST be 1 (reject missing / `0` / `2` — not mail). Gateway may reply to the **sender** (new `id`, hop=1). It must not forward inbound mail to a third org. There is no A→B→C.

### RAM and mention cap

Idle TTL is the laptop valve. Chromium lazy-starts. Gateway turns must not start it. Stopping the VM makes the org unreachable; disk stays.

| Layout | RAM ballpark |
| --- | --- |
| 1 desk bot + Gateway cold + no Chrome | ~2–4 GB |
| 3 desk bots warm + Gateway + Chrome | ~8 GB |
| 6 desk + Gateway warm + Chrome | **16 GB** comfortable; 8 GB will OOM under parallel turns |
| `@mention` of 3 bots (when groups ship) | 3 concurrent Grok turns — planning warning even with the cap |

This cut has no group threads. When groups ship, `@mention` (and `SendToThread` fan-out) caps at **3 distinct member bots** per message; a bare “hello” queues nobody. `@Ada @Bob @Cara @Dana @Eve @Frank` would still burn three Groks. Desk cap stays 6; Gateway does not consume a roster slot.

### Non-goal: Fly Machines

This runbook is **BYO host or VM**. OpenBot does not call Fly, Docker-as-provisioner, or any Machines API. A catalog of org URLs you edit by hand is not a provisioner. Remote runner (orchestrator on A, grok on B) is out. Same binary, two installs.
