# OpenBot

Named AI teammates that live **on this machine**. You run `openbot server` (or `openbot demo`). That process **is** the desk: Grok, Chromium, SQLite, and the chat UI all stay on the host you started. OpenBot does not provision cloud VMs.

Several bots share one desk and talk to you with **SendMessage** and to each other with **SendToAgent**. Closing the browser tab does not stop them. Stopping the server does.

```bash
bun install
bun run openbot demo --port 8787
```

Open the `signIn` URL it prints, create a teammate, send a message.

---

## Honesty (read this)

- **Closing this browser tab does not stop your teammate.**
- **Stopping `openbot server` / `openbot demo` does.** Stopping the **VM** that runs it makes that org **unreachable** until it boots again. Peers see timeouts, not a hosted retry. sqlite, `org.ed25519`, and inbox rows stay on disk.
- If you want work to continue while a laptop is closed, run the server on a machine that stays up (VPS, home server, systemd) — not on the laptop you are about to shut.
- `$OPENBOT_HOME/desk` is a **shared computer**. It is **not** a security boundary **inside** an org. Every bot on the account can read and write the desk the way you can. There is **one Chromium** for the whole team. Cross-org is messages only (hop=1).
- Vault files (`master.key`, `org.ed25519`, credentials) live **outside** `desk/`. Do not copy secrets into the workspace Grok can see.
- Restarting the server starts a new Grok ACP process. Chat history is in SQLite; OpenBot injects a thread digest on the next turn so the bot continues instead of announcing amnesia.
- **Federation is off until you turn it on** on **both** sides. OpenBot does not provision Fly Machines.

---

## What you get

| Capability | What it means |
| --- | --- |
| Named bots | Up to **six** active desk teammates. Unique names. Archive frees a slot. Gateway is extra. |
| Human DM | Each bot has a 1:1 thread with you. |
| `SendMessage` | The **only** way a bot talks to you. Assistant rambling is a private work log unless it fails to call the tool (then you get a fallback). |
| `SendToAgent` | Async mailbox to another bot. Does **not** write your DM. Handoffs in the UI show the A2A thread. |
| Parallel turns | At most one running turn **per bot**. Two bots can work at the same time on the shared desk. |
| Warm Grok process | Each bot keeps an ACP child across turns. Model / reasoning changes respawn it on the **next** turn. |
| Model & reasoning | Per-bot Grok model (e.g. grok-4.6) and effort (low / medium / high / extra high). Composer + Settings. |
| Live work | Collapsible thinking and tool calls in a resizable sidebar. Activity board for the whole team. |
| Takeover | You grab the shared Chromium (screencast + input). Esc / Close ends it. |
| Archive | Soft-delete folder. Restore, or type `DELETE` to purge. Expired archives (30 days) are removed automatically. |
| OpenAI-compatible API | Open WebUI (and similar) can use a bot as `openbot/<Name>` with a `sk-ob_…` key. Two connections = two orgs (mint the key on that VM). |
| Org / Gateway | One process is one org. Auto-provisioned **Gateway** diplomat (not a seventh desk slot). Federation **off** until `openbot gateway on` on both peers. |
| Auth | Local demo login on loopback, or GitHub OAuth + allowlist. Optional vaulted `XAI_API_KEY`; `grok login` is enough. |

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.1
- **[Grok CLI](https://github.com)** on `PATH` for real turns (`grok login`, SuperGrok / Cursor subscription). Fake demo mode does not need it.
- Optional: Chromium/Chrome for takeover and browser tools (`OPENBOT_CHROME` if not found).
- Optional: GitHub OAuth app for non-demo sign-in.

---

## Install

```bash
git clone https://github.com/JWilson45/openbot.git
cd openbot
bun install
```

The CLI is `bun run openbot -- <command>` (or `bun run apps/server/src/cli.ts`). Current version is **0.2.0**. `openbot version` prints `{ openbot, grokPin, grok }`. OpenBot pins **Grok CLI 1.0.5** (warns if missing or older; does not refuse to start).

```
openbot demo    [--port 8787] [--home ~/.openbot] [--host 127.0.0.1] [--fake]
openbot server  [--port 8787] [--home ~/.openbot] [--host 127.0.0.1] [--origin http://127.0.0.1:8787]
openbot install [--user] [--home ~/.openbot] [--port 8787] [--start]
openbot org [--home ~/.openbot]
openbot org init [--home ~/.openbot] [--slug acme] [--name "Acme"]
openbot gateway on | off [--home ~/.openbot]
openbot peers [--home ~/.openbot]
openbot peers add --slug beta --url https://beta.example.com --pubkey <b64> --org-id <uuid>
openbot peers remove --id <orgId>
openbot version | -v | --version
openbot allowlist add <github-login>
openbot allowlist
```

Default home is `$OPENBOT_HOME` or `~/.openbot`. Bind defaults to **127.0.0.1**. OpenBot does not terminate TLS — put Caddy or nginx in front (see [docs/host-service.md](docs/host-service.md) and `contrib/caddy/Caddyfile.example`).

### Run as a user service

From a git checkout after `bun install`:

```bash
bun run openbot -- install --user --home ~/.openbot --port 8787
```

That writes a **LaunchAgent** (`~/Library/LaunchAgents/ai.openbot.plist`) or a **systemd --user** unit (`~/.config/systemd/user/openbot.service`). Never root; Chromium must not run as root. It does not start the unit unless you pass `--start`.

```bash
# macOS
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openbot.plist

# Linux
systemctl --user daemon-reload && systemctl --user enable --now openbot
```

`grok login` must be done as the **same user** the service runs as. Full operator notes (including the two-VM federation runbook): [docs/host-service.md](docs/host-service.md).

---

## Quick start

### 1. Local demo (real Grok)

On this machine:

```bash
grok login
bun run openbot demo --port 8787
```

Open the printed `signIn` URL (loopback user `demo`). Create **Ada**. Ask her something. No API key is required if the Grok CLI session is signed in.

### 2. Scripted demo (no Grok / no network)

```bash
bun run openbot demo --fake --port 8787
```

`--fake` runs `tests/fixtures/acp/fake-agent.ts` instead of `grok agent stdio`. Directives in the user message:

| Tag | Effect |
| --- | --- |
| `[[send:body]]` | Bot `SendMessage`s that body to you |
| `[[sendto:Name:body]]` | Bot `SendToAgent`s another bot |
| `[[ramble]]` | Thinks out loud, never calls `SendMessage` (you should see a fallback) |
| `[[write:file]]` | Writes a file in that bot’s project cwd (`desk/projects/<botId>/`) |
| `[[cwd]]` | Replies with `process.cwd()` |
| `[[permission]]` | Asks the client for tool permission |

Create **Ada** then **Bob**. In Ada's DM:

```
[[sendto:Bob:write a one-line draft]] [[send:I asked Bob]]
```

Ada's DM gets “I asked Bob”. Bob's DM gets the draft. **Handoffs** shows the A2A thread.

### 3. Always-on server

```bash
bun run openbot server --port 8787
```

Bind is `127.0.0.1`. Put it behind your own TLS reverse proxy if you need a hostname (Caddy must 404 `/mcp/v1`). Two VMs = two orgs: [docs/host-service.md](docs/host-service.md#two-vms-two-orgs-federation). GitHub OAuth:

```bash
bun run openbot allowlist add your-github-login
export OPENBOT_GITHUB_CLIENT_ID=…
export OPENBOT_GITHUB_CLIENT_SECRET=…
export OPENBOT_PUBLIC_ORIGIN=https://desk.example.com
bun run openbot server --origin https://desk.example.com
```

---

## Using the desk

### Team

- **New bot** — name + description (the prompt overlay: “You are Ada…”). Optional model / reasoning.
- **Archive** — moves the bot to the Archive folder; frees an active slot. Restore from there. **Delete** is archived-only and requires typing `DELETE`. After 30 days an archive is purged unless restored. Permanent delete also removes that bot’s folder `desk/projects/<botId>/` only. The shared desk stays; this is not filesystem isolation.
- **Wipe desk** — Settings. Deletes `$OPENBOT_HOME/desk` for **every** bot. Type `DELETE`. Does not uninstall the server or wipe SQLite users.

### Chat

- Enter sends, Shift+Enter newline.
- **Model** and **Reasoning** sit above the composer. Changing them saves immediately and applies on the **next turn**. A running turn keeps the old setting.
- Live work (thinking, tools) is the right sidebar; drag the handle to resize. **Activity** is a folder in the rail for every teammate at once.
- **Handoff** threads are the A2A log (read-only from the human UI). Message a bot from their human DM.

### Takeover

**Takeover** shows the shared Chromium. `about:blank` means no page is open yet. Esc or **Close** ends takeover. One browser, mutexed with bot browser tools.

---

## How messaging works

Grok's assistant text is **not** your chat transcript. The product contract:

1. To talk to the human, the bot **must** call MCP **SendMessage**.
2. To talk to another bot, it **must** call **SendToAgent**. That does not notify you.
3. If a turn ends with no `SendMessage`, OpenBot **promotes** swallowed assistant text as a fallback (marked in the UI) so you still see something.
4. `SendToAgent` creates/uses a 1:1 A2A thread (ordered bot pair), inserts `origin=agent`, and **queues a turn on the target**. The sender is not blocked.
5. Optional per-bot **require approval for SendMessage**. Pending lines wait in the DM until you approve or reject.

MCP is Streamable HTTP on loopback (`/mcp/v1`), token-bound to `{ accountId, botId, threadId, harnessSessionId }`.

---

## Data on disk

Default `$OPENBOT_HOME` = `~/.openbot`.

| Path | Role |
| --- | --- |
| `openbot.sqlite` | Bots, threads, turns, messages, live-work, sessions, `org_meta`, `org_peers`, `org_inbox` |
| `org.json` | Optional org slug/name/origin. DB wins once written; `org init` rewrites this file. |
| `org.ed25519` | Sealed Ed25519 org key (mode 0600). Not under `desk/`. Not a `credentials` row. |
| `master.key` | Vault master (mode 0600). Not under `desk/` |
| `allowlist` | GitHub logins, one per line |
| `desk/` | Shared computer. Chromium profile under `desk/.openbot/chromium`. Gateway cwd `desk/.openbot/gateway/`. |
| `desk/projects/<botId>/` | That bot's ACP cwd. Purge deletes this folder only. Bots can still `../` into siblings. |
| `grok-home/` | Isolated Grok config (no user MCP servers). Auth is linked from `~/.grok/auth.json` |

`--home` / `OPENBOT_HOME` relocate the lot. Wiping the desk does not delete the sqlite DB or vault.

---

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENBOT_HOME` | Data root (default `~/.openbot`) |
| `PORT` | Listen port (default `8787`) |
| `OPENBOT_HOST` | Bind address (`127.0.0.1` default; `localhost`; `0.0.0.0` with a warning) |
| `OPENBOT_PUBLIC_ORIGIN` | Public URL for OAuth redirects and cookies. `--origin` overrides this. If neither is set, `org.json` / stored `org_meta.public_origin` is kept. |
| `OPENBOT_ORG_ID` | Stable org UUID. Generated on first boot if unset. A **different** value than `org_meta.org_id` refuses to boot. |
| `OPENBOT_ORG_SLUG` | Org slug (single DNS label). May update the stored slug. FQDN origins such as `desk.example.com` do **not** auto-slug — they become `local` unless you set this, `org.json`, or `openbot org init --slug`. |
| `OPENBOT_ORG_NAME` | Display name. May update the stored name. |
| `OPENBOT_ACP_IDLE_MS` | Kill idle **desk** Grok ACP children after this many ms. Default **600000** (10 minutes). `0` disables desk idle kill only (not Gateway). Cold start on the next message is a few seconds plus a thread digest — not a full amnesia. |
| `OPENBOT_GATEWAY_ACP_IDLE_MS` | Gateway ACP idle TTL. Default **1800000** (30 minutes). `0` disables Gateway idle kill only. |
| `OPENBOT_FEDERATION` | Panic **off:** `0` forces federation off even if the DB flag is on. Unset/`1` does **not** force on. Restart the unit so the process sees env. |
| `OPENBOT_FED_ALLOW_HTTP` | `1` allows RFC1918 `http://` peer URLs. Default is https + loopback http. |
| `OPENBOT_GITHUB_CLIENT_ID` / `OPENBOT_GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `OPENBOT_GITHUB_ALLOWLIST` | Extra comma-separated GitHub logins |
| `OPENBOT_DEV_LOGIN` | `1` enables `/auth/local` (loopback only). `demo` sets this. |
| `OPENBOT_MASTER_KEY` | Override vault master (hex/raw). Prefer the file. |
| `OPENBOT_ACP_COMMAND` | Replace `grok agent … stdio` (tests / `--fake`) |
| `OPENBOT_CHROME` | Chromium/Chrome binary for takeover |
| `XAI_API_KEY` | Optional; prefer Settings or `grok login` |

Grok is spawned as:

```text
grok agent --no-leader --always-approve --model <id> --reasoning-effort <level> stdio
```

with `GROK_HOME` pointed at `$OPENBOT_HOME/grok-home` and `GROK_CONFIG` overlaying the selected model / effort. User `~/.grok/config.toml` MCP servers are **not** loaded.

---

## HTTP API (sketch)

Cookie session (`openbot_session`) or `Authorization: Bearer` (session token or `sk-ob_…` API key where noted).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/healthz` `/v1/readyz` | Liveness / SQLite + desk writable |
| `GET` | `/v1/me` | Current user |
| `GET` | `/fed/v1/info` | Public-ish org identity + pubkey. Rate-limited. No cookies. |
| `GET`/`PATCH` | `/v1/org` | Member snapshot; `{ federationEnabled }` (cookie, not `sk-ob_`) |
| `GET`/`POST`/`DELETE` | `/v1/org/peers` | Allowlist. `POST /v1/org/peers/from-info` is preview only |
| `GET` | `/v1/org/inbox` | Trusted mail only (`pending` / `held`). Untrusted solicits are Gateway-DM `origin=system` + `fed.solicit` |
| `POST` | `/fed/v1/messages` | Signed inbound mail (JWS). 403 when federation is off (trusted → `held`) |
| `POST` | `/v1/bots` | Create. Body `{ name, description, model?, reasoningEffort? }` |
| `GET` | `/v1/bots` | Desk `bots[]` + archived; Gateway is a sidecar, not a seventh slot |
| `POST` | `/v1/bots/:id/archive` `/restore` | Soft-delete / undo |
| `POST` | `/v1/bots/:id/purge` | Body `{ confirm: "DELETE" }`. Archived only |
| `PATCH` | `/v1/bots/:id/settings` | `permissionMode`, `requireHumanApproval`, `model`, `reasoningEffort` |
| `GET` | `/v1/inference-models` | Grok catalog + effort menus |
| `GET` | `/v1/threads?botId=&kind=human\|a2a` | Human DM or A2A list |
| `POST` | `/v1/threads/:id/messages` | Queue a turn (`202`) |
| `GET` | `/v1/turns/:id/live-work` | Tool / thought events |
| `GET` | `/v1/activity` | Team presence |
| `POST` | `/v1/compute/takeover` | Mint takeover ticket |
| `POST` | `/v1/compute/wipe` | Body `{ confirm: "DELETE" }` |
| `POST` | `/v1/api-keys` | Mint OpenAI-compatible key (shown once) |
| `GET`/`POST` | `/v1/models` `/v1/chat/completions` | OpenAI-compatible (also `/openai/v1/…`) |

WebSockets: `/v1/push` (live UI events), `/v1/takeover` (JPEG frames + input).

---

## Open WebUI

OpenBot speaks OpenAI Chat Completions so Open WebUI (and other OpenAI clients) can treat each bot as a model. **One `openbot server` process is one org.** Switching org is another Open WebUI connection: that VM’s `/v1` base URL plus a `sk-ob_…` key minted **on that VM**. This server has no OpenAI `organization` object.

1. Run the server and sign in.
2. Settings → **Create API key**, or:

   ```bash
   curl -s -H "Cookie: openbot_session=…" -H "Content-Type: application/json" \
     -d '{"name":"open-webui"}' http://127.0.0.1:8787/v1/api-keys
   ```

   Copy `token` (`sk-ob_…`). It is shown **once**. Mint it on the VM you will point at.
3. Open WebUI → Admin → Connections (provider **OpenAI**):
   - **Base URL**: `http://127.0.0.1:8787/v1` (or `…/openai/v1`)
   - **API key**: the `sk-ob_…` secret minted on **that** process
4. Model `openbot/<BotName>` (e.g. `openbot/Ada`). Bot UUIDs work too. When Gateway exists it is listed as `openbot/Gateway`.

`GET /v1/models` lists **active bots** (desk teammates plus Gateway when present), not Grok model IDs. Completions send the last user message into that bot's human thread and wait for the turn. Streaming is supported. Federation is **off** by default; listing Gateway does not send org mail.

`GET /v1/bots.bots[]` stays desk-only. Gateway is a sidecar on that response, not a seventh roster slot.

---

## Two VMs, two orgs

One `openbot server` process is one org. A second host is a second org (own sqlite, `org.ed25519`, allowlist, API keys). OpenBot does **not** provision VMs (no Fly Machines). Stopping a VM makes that org unreachable; disk identity and inbox remain.

Walkthrough — install, origin, `org init` (zero users), first login (Gateway row, federation still **off**), `openbot gateway on` on **both**, A→B **and** B→A `peers add`, Open WebUI second connection, RAM, mention cap (when groups ship), hop=1, off/held/solicit: [docs/host-service.md](docs/host-service.md#two-vms-two-orgs-federation).

Caddy **must** `handle /mcp/v1* { respond 404 }` and **must** proxy `/fed/v1`. Peers are bidirectional; hop is **1** (A→B only, no A→B→C).

---

## Layout (code)

Bun workspaces.

```
apps/server/          Hono app, SPA, CLI, turn engine, OpenAI shim
packages/acp-grok/    grok agent stdio client, isolated GROK_HOME, model catalog
packages/runner/      localhost compute: desk, Chromium CDP, per-bot ACP
packages/db/          SQLite schema + purge / archive
packages/live-work/   messages, promote(), live-work events, thread digest
packages/mcp-send-message/  SendMessage + SendToAgent
packages/federation/  Ed25519 JWS for /fed/v1
packages/vault/       credential encryption
packages/auth/        GitHub / local session, allowlist
packages/compute-protocol/  five-method host contract
docs/design/          Phase 1 / Phase 2 / Phase 3 design notes
tests/                bun:test; fake ACP, no live xAI required
```

---

## Tests

```bash
bun test
```

CI (`.github/workflows/ci.yml`) is `bun install --frozen-lockfile` then `bun test` on Ubuntu. Harness tests set `OPENBOT_ACP_COMMAND` to the fake agent; they do not call xAI.

---

## Limits and non-goals

**Now**

- Six active **desk** bots, 1:1 A2A only (no group chat in this cut). Gateway is extra and does not consume a roster slot.
- One desk, one Chromium. Two bots editing files will race; two bots scraping will queue on the browser lock. Each bot's cwd is `desk/projects/<id>/`; that is a home folder, not a jail.
- Idle desk Grok processes exit after 10 minutes (override `OPENBOT_ACP_IDLE_MS`). Gateway default 30 minutes. The next message cold-starts in a few seconds.
- Federation default **off**. Hop **1** (no forwards). Group `@mention` cap is 3 when groups ship — still a RAM foot-gun.
- Codex / OpenCode adapters are not shipped.
- Bind is 127.0.0.1 by default; you own TLS and exposure. Caddy must 404 `/mcp/v1`.

**Not this project (later / never here)**

- Fly Machines / tenant VM provisioning, `cptr`, hosted multi-tenant 6PN.
- Remote runner (orchestrator on A, grok on B).
- Mobile / desktop apps, Postgres control plane, per-bot filesystem isolation.

Design background: [docs/design/phase-1-always-on-teammate-loop.md](docs/design/phase-1-always-on-teammate-loop.md), [docs/design/phase-2-team-on-one-desk.md](docs/design/phase-2-team-on-one-desk.md), [docs/design/phase-3-orgs-vms-gateway.md](docs/design/phase-3-orgs-vms-gateway.md).

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Bot says it is a “new session” after restart | Expected ACP reset. Current builds inject a thread digest and tell Grok not to announce it. Restart after pull, then send again. |
| Empty bubbles / no reply | Confirm `grok login` or a vaulted key. Check Live work for a crashed turn. `OPENBOT_ACP_COMMAND` must be unset for real Grok. |
| UI looks old | Hard-refresh. The SPA is served by the same process; restart `openbot demo`. |
| Purge / delete fails | Archive first. Permanent delete is archived-only and body `{ "confirm": "DELETE" }`. |
| `FOREIGN KEY constraint failed` on purge | Fixed in current `deleteBotPermanently` (A2A / live-work / cross-thread `turn_id`). Update and retry. |
| Open WebUI 401 | Use `sk-ob_…` minted **on that VM**, base URL ending in `/v1`, model `openbot/<Name>` (or `openbot/Gateway`). Another org is another connection, not an OpenAI `organization` header. |
| Peer `401 unknown_peer` | Missing reverse allowlist. `peers add` **both** directions (A→B and B→A). Independent of `gateway on`. |
| `403 federation_disabled` | Federation is off (or `OPENBOT_FEDERATION=0`). Trusted mail is `held`, no Gateway ACP. `openbot gateway on` on **both** (unless env panic). |
| Takeover is a black `about:blank` | No page is open in the shared browser yet. That is idle Chromium, not a hang. |

---

## License

[MIT](LICENSE).
