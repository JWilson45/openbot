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

- **Closing this browser tab does not stop your teammate.** A turn the calendar already queued keeps running.
- **Stopping `openbot server` / `openbot demo` does.** Stopping the **VM** that runs it makes that org **unreachable** until it boots again. Peers see timeouts, not a hosted retry. sqlite, `org.ed25519`, and inbox rows stay on disk. Stopping the process stops the **clock and the turn**.
- If you want work to continue while a laptop is closed, run the server on a machine that stays up (VPS, home server, systemd) — not on the laptop you are about to shut.
- **The calendar runs only while `openbot server` / `openbot demo` runs.** Closed laptop / stopped unit / stopped VM: the 9am did not happen. At most one catch-up if down less than a day. OpenBot will not replay a weekend of missed summaries. “9am” is the org IANA timezone in Settings (default `UTC`; not browser detect).
- **Watch-me-do-it v1 is not a recording.** **Learn this** drafts a proposed calendar event from a thread. You edit it. No click replay.
- **This is not Google Calendar.** No sync. No invites. Org-local sqlite.
- **Schedules and learned routines are two products** on the same grid.
- `$OPENBOT_HOME/desk` is a **shared computer**. It is **not** a security boundary **inside** an org. Every bot on the account can read and write the desk the way you can. There is **one Chromium** for the whole team (**a tab per desk bot**; cookies shared). Cross-org is messages only (hop=1).
- Skills are procedures on a **shared** desk (`desk/skills/<name>/SKILL.md`). Overlay lists names only; Grok reads bodies via the filesystem. Learn this / ProposeRoutine are calendar jobs. Operator `~/.grok/skills` are not loaded. Optional `desk/projects/<botId>/SOUL.md` is never auto-created.
- Vault files (`master.key`, `org.ed25519`, credentials) live **outside** `desk/`. Grok’s `HOME` is `$OPENBOT_HOME/grok-home` (a copy of `~/.grok/auth.json`, not a symlink). ACP tools whose paths resolve outside the desk are denied. Optional `OPENBOT_SANDBOX` (macOS `sandbox-exec` / Linux `bwrap`) is best-effort and off in tests. Same-uid `0600` is not a jail; a dedicated OS user is. Do not copy secrets into the workspace Grok can see.
- Restarting the server starts a new Grok ACP process. Chat history is in SQLite. On cold start OpenBot tries ACP `session/resume`; if that fails it injects a thread **summary + recent tail**. Idle desk children stay warm for 2 hours (override `OPENBOT_ACP_IDLE_MS`; `0` disables desk idle kill). A warm teammate hopping to another thread gets that thread's summary + tail prefixed; that is **not** a new session. Compact is `session/new` on the **same** process (default every 20 turns or 48k prompt chars; `OPENBOT_ACP_COMPACT_TURNS` / `OPENBOT_ACP_COMPACT_CHARS`, `0` disables that trigger). Compact-on-thread-switch is off unless `OPENBOT_ACP_COMPACT_ON_SWITCH=1`. Compact does not announce itself in the transcript.
- Teammates see who is on the desk (up to six names + Gateway) in their spawn overlay. Hiring someone does not kill the other Groks; each bot picks up the new roster on its next turn.
- Standing notes freeze at spawn (idle ~2h, compact, model/roster respawn, or Save which kills the child if it is not in a turn). They do not appear on the current warm child. `Memory.read` sees sqlite immediately. Search is a tool over this org’s log, not prompt stuffing.
- **Federation is off until you turn it on** on **both** sides. OpenBot does not provision Fly Machines.
- **SendToAgent is queued, not done.** Completions sit on the A2A thread as a system line; the sender is not auto-woken.

---

## What you get

| Capability | What it means |
| --- | --- |
| Named bots | Up to **six** active desk teammates. Unique names. Archive frees a slot. Gateway is extra. |
| Human DM | Each bot has a 1:1 thread with you. |
| `SendMessage` | The **only** way a bot talks to you. Assistant rambling is a private work log unless it fails to call the tool (then you get a fallback). |
| `SendToAgent` | Async mailbox to another bot. Does **not** write your DM. Handoffs in the UI show the A2A thread. |
| `ListBots` / `CreateBot` | Fallback roster and hire. Desk bots only (cap 6). Gateway does not hire. Bots must **not** mint `/auth/local` or `POST /v1/bots`. The spawn overlay already lists names. |
| Parallel turns | At most one running turn **per bot**. Two bots can work at the same time on the shared desk. |
| Warm Grok process | Each bot keeps an ACP child across turns. Model / reasoning / roster changes respawn it on the **next** turn. |
| Model & reasoning | Per-bot Grok model (e.g. grok-4.6) and effort (low / medium / high / extra high). Settings always; Debug composer on a human DM. |
| Live work | Default UI is the messenger (roster + thread). **Debug** (header, or Ctrl/Cmd+Shift+Period) shows thinking and tool calls in a resizable sidebar. Activity board for the whole team. |
| Takeover | **Desk browser** grabs the human tab of the shared Chromium (screencast + input). Esc / Close ends it; F6 from the canvas focuses Close. Desk bots keep their own tabs. |
| Archive | Soft-delete folder. Restore, or type `DELETE` to purge. Expired archives (30 days) are removed automatically. |
| Calendar / schedules / Learn this | Org-local sqlite (not Google Calendar: no sync, no invites). Schedules and learned routines are two products on the same grid. **Learn this** drafts a proposed event from a thread — not a recording. The clock is the process. |
| OpenAI-compatible API | Open WebUI (and similar) can use a bot as `openbot/<Name>` with a `sk-ob_…` key. Two connections = two orgs (mint the key on that VM). |
| Org / Gateway | One process is one org. Auto-provisioned **Gateway** diplomat (not a seventh desk slot). Federation **off** until `openbot gateway on` on both peers. |
| Remote computer | Optional enrolled runner (`openbot runner join`) holds Grok and Chromium. The org process stays up if that computer sleeps. Default is still in-process on the server host. |
| Auth | Local demo login on loopback, or GitHub OAuth + allowlist. Optional vaulted `XAI_API_KEY`; `grok login` is enough. |

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.1
- **[Grok CLI](https://github.com)** on `PATH` for real turns (`grok login`, SuperGrok / Cursor subscription). Fake demo mode does not need it.
- Optional: Chromium/Chrome for takeover and browser tools (`OPENBOT_CHROME` if not found).
- Optional: GitHub OAuth app for non-demo sign-in.

---

## Install

Binary (no Bun at runtime). Still needs **Grok CLI** on PATH (`grok login` as this user). Do not run as root.

```bash
# curl (Linux / macOS)
curl -fsSL https://github.com/JWilson45/openbot/releases/latest/download/install.sh | bash
# installs to ~/.local/bin/openbot  (override: OPENBOT_BIN=/usr/local/bin/openbot)

# Homebrew
brew tap JWilson45/openbot https://github.com/JWilson45/openbot
brew install openbot
```

Then:

```bash
openbot org init acme --name "Acme"
openbot install --user --org acme --port 8787 --start
```

From source (contributors):

```bash
git clone https://github.com/JWilson45/openbot.git
cd openbot
bun install
```

The CLI is `bun run openbot -- <command>` (or `bun run apps/server/src/cli.ts`). Current version is **0.6.0**. `openbot version` prints `{ openbot, grokPin, grok }`. OpenBot pins **Grok CLI 1.0.5** (warns if missing or older; does not refuse to start).

Merging to `main` with a **new** `package.json` version creates tag `vX.Y.Z` and publishes GitHub Release binaries. Pull requests run tests. Other branches do not. A version that already has a tag is not re-released.

```
openbot org init acme --name "Acme"
openbot demo
openbot orgs
openbot use beta
openbot use acme --home ~/.openbot-p3    # import an existing data dir
```

A **profile is an org**: one slug → one data dir (sqlite, desk, keys). `openbot use acme` switches which org later commands talk to. Unset `OPENBOT_HOME` first if you exported it — that env **pins a path** and ignores `use`. A running `demo`/`server` stays on the org it started with until you restart it.

`--org` / `OPENBOT_ORG` select a slug for one command. `--home` / `OPENBOT_HOME` pin a directory (units snapshot this). Named orgs default to `~/.openbot/orgs/<slug>/`. An existing `~/.openbot/openbot.sqlite` is adopted by the first `org init <slug>`.

```
openbot demo    [slug] [--org <slug>] [--port 8787] [--home DIR] [--host 127.0.0.1] [--fake]
openbot server  [slug] [--org <slug>] [--port 8787] [--home DIR] [--host 127.0.0.1] [--origin URL]
openbot install [--user] [--org <slug>] [--home DIR] [--port 8787] [--start]
openbot orgs | profiles
openbot use [slug] [--home DIR]
openbot org [slug]
openbot org init <slug> [--name "Acme"] [--home DIR]
openbot gateway on | off [slug]
openbot peers [--org <slug>]
openbot peers add --slug beta --url https://beta.example.com --pubkey <b64> --org-id <uuid>
openbot peers remove --id <orgId>
openbot version | -v | --version
openbot allowlist add <github-login>
openbot allowlist
openbot runner enroll [--origin URL] [--port 8787] [--home DIR]
openbot runner join <origin> --token TOKEN [--home DIR]
openbot runner leave [--home DIR]
openbot runner revoke [--port 8787] [--home DIR]
openbot runner status [--home DIR]
```

Bind defaults to **127.0.0.1**. OpenBot does not terminate TLS — put Caddy or nginx in front (see [docs/host-service.md](docs/host-service.md) and `contrib/caddy/Caddyfile.example`).

### Run as a user service

From a git checkout after `bun install`:

```bash
bun run openbot -- org init acme --name "Acme"
bun run openbot -- install --user --org acme --port 8787
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
bun run openbot -- org init acme --name "Acme"
bun run openbot -- demo --port 8787
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

- Enter sends, Shift+Enter newline. First Tab is a skip link to the message box.
- Default chrome is a two-pane messenger: team rail + transcript. Teammate replies are **SendMessage** bubbles, not thinking.
- **Debug mode** (header **Debug**, or Ctrl/Cmd+Shift+Period) shows live work (thinking, tools) in the right sidebar; drag the handle to resize. The status chip next to the title is not a button and is hidden when idle.
- **Model** and **Reasoning** live in Settings. They also appear above the human composer in Debug. Changing them saves immediately and applies on the **next turn**. A running turn keeps the old setting.
- **Appearance** (Settings): Match system, Dark (ink), or Light (paper). Takeover stays dark.
- **Activity** is a folder in the rail for every teammate at once.
- **Handoff** threads are the A2A log (read-only from the human UI). Message a bot from their human DM.

### Calendar

**Calendar** is a Library folder (agenda + month). **New event** is a schedule. **Learn this** on a human DM or group drafts a proposed routine you confirm. Org timezone is Settings (IANA; default `UTC`, not from the browser).

### Takeover

**Desk browser** (Takeover) shows the shared Chromium. `about:blank` means no page is open yet. Esc or **Close** ends it; F6 from the canvas focuses Close. One browser, mutexed with bot browser tools.

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

Control dir is `~/.openbot`. Each org profile is its own data root (`$OPENBOT_HOME`).

| Path | Role |
| --- | --- |
| `~/.openbot/profiles.json` | Slug → data dir map and current profile |
| `~/.openbot/orgs/<slug>/` | Default data root for a named org |
| `~/.openbot/openbot.sqlite` | Legacy single-home layout (still valid; first `org init <slug>` adopts it) |
| `$OPENBOT_HOME/openbot.sqlite` | Bots, threads, turns, messages, live-work, sessions, `org_meta` (incl. timezone), `org_peers`, `org_inbox`, `calendar_series`, `calendar_instances` |
| `org.json` | Optional org slug/name/origin. DB wins once written; `org init` rewrites this file. |
| `org.ed25519` | Sealed Ed25519 org key (mode 0600). Not under `desk/`. Not a `credentials` row. |
| `master.key` | Vault master (mode 0600). Not under `desk/` |
| `allowlist` | GitHub logins, one per line |
| `desk/` | Shared computer. Chromium profile under `desk/.openbot/chromium`. Gateway cwd `desk/.openbot/gateway/`. |
| `desk/skills/<name>/SKILL.md` | Shared procedures (seeded `confirm-series`, `shared-chromium`, write-if-absent). Overlay lists names only. |
| `desk/projects/<botId>/` | That bot's ACP cwd. Purge deletes this folder only. Bots can still `../` into siblings. |
| `desk/projects/<botId>/SOUL.md` | Optional voice/taboos. Never auto-created. |
| `grok-home/` | Isolated Grok config (no user MCP servers) and the Grok child `HOME`. Auth is a **copy** of `~/.grok/auth.json`, refreshed on each `ensureHarness`. Operator `~/.grok/skills` are not loaded. |

`--home` / `OPENBOT_HOME` relocate one org's data. Wiping the desk does not delete the sqlite DB or vault. Grok CLI login stays in `~/.grok/auth.json`.

---

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENBOT_HOME` | Pin a data root (skips profile lookup). Default is the current profile, else `~/.openbot`. |
| `OPENBOT_ORG` | Select a profile by slug (`--org` / `--profile`). |
| `PORT` | Listen port (default `8787`) |
| `OPENBOT_HOST` | Bind address (`127.0.0.1` default; `localhost`; `0.0.0.0` with a warning) |
| `OPENBOT_PUBLIC_ORIGIN` | Public URL for OAuth redirects and cookies. `--origin` overrides this. If neither is set, `org.json` / stored `org_meta.public_origin` is kept. |
| `OPENBOT_ORG_ID` | Stable org UUID. Generated on first boot if unset. A **different** value than `org_meta.org_id` refuses to boot. |
| `OPENBOT_ORG_SLUG` | Org slug (single DNS label). May update the stored slug. FQDN origins such as `desk.example.com` do **not** auto-slug — they become `local` unless you set this, `org.json`, or `openbot org init --slug`. |
| `OPENBOT_ORG_NAME` | Display name. May update the stored name. |
| `OPENBOT_ACP_IDLE_MS` | Kill idle **desk** Grok ACP children after this many ms. Default **7200000** (2 hours). `0` disables desk idle kill only (not Gateway). Cold start on the next message is a few seconds plus a thread digest — not a full amnesia. |
| `OPENBOT_GATEWAY_ACP_IDLE_MS` | Gateway ACP idle TTL. Default **1800000** (30 minutes). `0` disables Gateway idle kill only. |
| `OPENBOT_FEDERATION` | Panic **off:** `0` forces federation off even if the DB flag is on. Unset/`1` does **not** force on. Restart the unit so the process sees env. |
| `OPENBOT_FED_ALLOW_HTTP` | `1` allows RFC1918 `http://` peer URLs. Default is https + loopback http. |
| `OPENBOT_GITHUB_CLIENT_ID` / `OPENBOT_GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `OPENBOT_GITHUB_ALLOWLIST` | Extra comma-separated GitHub logins |
| `OPENBOT_DEV_LOGIN` | `1` enables `/auth/local` (loopback only). `demo` sets this. |
| `OPENBOT_MASTER_KEY` | Override vault master (hex/raw). Prefer the file. |
| `OPENBOT_ACP_COMMAND` | Replace `grok agent … stdio` (tests / `--fake`) |
| `OPENBOT_SANDBOX` | Grok-child OS sandbox: `auto` (default; `sandbox-exec` on macOS, `bwrap` on Linux, else none), `none`, `bwrap`, `seatbelt`, `required` (fail the turn if missing). Tests default to `none`. Does not wrap Chromium. |
| `OPENBOT_CHROME` | Chromium/Chrome binary for takeover |
| `XAI_API_KEY` | Optional; prefer Settings or `grok login` |

Grok is spawned as:

```text
grok agent --no-leader [--always-approve] --model <id> --reasoning-effort <level> stdio
```

`--always-approve` is passed only when that bot’s permission mode is Always-approve. `HOME` and `GROK_HOME` are `$OPENBOT_HOME/grok-home`. `GROK_CONFIG` overlays the selected model / effort. User `~/.grok/config.toml` MCP servers are **not** loaded. The child env is an allowlist (no `SSH_AUTH_SOCK`, no GitHub OAuth secrets, no MCP token — HTTP MCP uses `session/new` headers).

---

## HTTP API (sketch)

Cookie session (`openbot_session`) or `Authorization: Bearer` (session token or `sk-ob_…` API key where noted).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/healthz` `/v1/readyz` | Liveness / SQLite + desk writable |
| `GET` | `/v1/me` | Current user |
| `GET` | `/fed/v1/info` | Public-ish org identity + pubkey. Rate-limited. No cookies. |
| `GET`/`PATCH` | `/v1/org` | Member snapshot; `{ federationEnabled, timezone }` (cookie, not `sk-ob_`). Timezone is IANA; default `UTC` |
| `GET`/`POST`/`DELETE` | `/v1/org/peers` | Allowlist. `POST /v1/org/peers/from-info` is preview only |
| `GET` | `/v1/org/inbox` | Trusted mail only (`pending` / `held`). Untrusted solicits are Gateway-DM `origin=system` + `fed.solicit` |
| `POST` | `/fed/v1/messages` | Signed inbound mail (JWS). 403 when federation is off (trusted → `held`) |
| `POST` | `/v1/bots` | Create. Body `{ name, description, model?, reasoningEffort? }` |
| `GET` | `/v1/bots` | Desk `bots[]` + archived; Gateway is a sidecar, not a seventh slot |
| `POST` | `/v1/bots/:id/archive` `/restore` | Soft-delete / undo |
| `POST` | `/v1/bots/:id/purge` | Body `{ confirm: "DELETE" }`. Archived only |
| `PATCH` | `/v1/bots/:id/settings` | `permissionMode`, `requireHumanApproval`, `requireMemoryApproval`, `model`, `reasoningEffort` |
| `GET`/`PATCH` | `/v1/memory` `/v1/bots/:id/memory` | Standing org/bot notes. Human Save kills the child if it is not in a turn. |
| `POST` | `/v1/memory/pending/:id/approve` `/reject` | Parked agent Memory writes |
| `GET` | `/v1/inference-models` | Grok catalog + effort menus |
| `GET` | `/v1/threads?botId=&kind=human\|a2a` | Human DM or A2A list |
| `POST` | `/v1/threads/:id/messages` | Queue a turn (`202`) |
| `GET` | `/v1/turns/:id/live-work` | Tool / thought events |
| `GET` | `/v1/activity` | Team presence |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/calendar…` | Cookie, not `sk-ob_`. Window `GET /v1/calendar?from=&to=`; series CRUD, confirm, pause; instance cancel; `POST /learn` |
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
packages/calendar/    RRULE subset, civil expansion, calendar constants
packages/runner/      localhost compute: desk, Chromium CDP, per-bot ACP
packages/db/          SQLite schema + purge / archive
packages/live-work/   messages, promote(), live-work events, thread digest
packages/mcp-send-message/  SendMessage + SendToAgent
packages/federation/  Ed25519 JWS for /fed/v1
packages/vault/       credential encryption
packages/auth/        GitHub / local session, allowlist
packages/compute-protocol/  five-method host contract
docs/design/          Phase 1–5 design notes
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
- Idle desk Grok processes exit after 2 hours (override `OPENBOT_ACP_IDLE_MS`). Gateway default 30 minutes. The next message cold-starts in a few seconds.
- Federation default **off**. Hop **1** (no forwards). Group `@mention` cap is 3 when groups ship — still a RAM foot-gun.
- Codex / OpenCode adapters are not shipped.
- Bind is 127.0.0.1 by default; you own TLS and exposure. Caddy must 404 `/mcp/v1`.

**Not this project (later / never here)**

- Fly Machines / tenant VM provisioning, `cptr`, hosted multi-tenant 6PN.
- Remote runner (orchestrator on A, grok on B).
- Mobile / desktop apps, Postgres control plane, per-bot filesystem isolation.

Design background: [docs/design/phase-1-always-on-teammate-loop.md](docs/design/phase-1-always-on-teammate-loop.md), [docs/design/phase-2-team-on-one-desk.md](docs/design/phase-2-team-on-one-desk.md), [docs/design/phase-3-orgs-vms-gateway.md](docs/design/phase-3-orgs-vms-gateway.md), [docs/design/phase-4-calendar-automations.md](docs/design/phase-4-calendar-automations.md), [docs/design/phase-5-hermes-behavior.md](docs/design/phase-5-hermes-behavior.md).

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Bot says it is a “new session” after restart | Expected ACP reset if resume failed. Current builds inject a summary + recent tail and tell Grok not to announce it. Restart after pull, then send again. |
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
