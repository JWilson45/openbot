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
- **Stopping `openbot server` / `openbot demo` does.** Stopping the **VM** that runs it makes that org **unreachable** until it boots again. Protocol clients get connection failures, not a hosted retry. SQLite state stays on disk. Stopping the process stops the **clock and the turn**.
- If you want work to continue while a laptop is closed, run the server on a machine that stays up (VPS, home server, systemd) — not on the laptop you are about to shut.
- **The calendar runs only while `openbot server` / `openbot demo` runs.** Closed laptop / stopped unit / stopped VM: the 9am did not happen. At most one catch-up if down less than a day. OpenBot will not replay a weekend of missed summaries. “9am” is the org IANA timezone in Settings (default `UTC`; not browser detect).
- **Watch-me-do-it v1 is not a recording.** **Learn this** drafts a proposed calendar event from a thread. You edit it. No click replay.
- **This is not Google Calendar.** No sync. No invites. Org-local sqlite.
- **Schedules and learned routines are two products** on the same grid.
- `$OPENBOT_HOME/desk` is a **shared computer**. It is **not** a security boundary **inside** an org. Every bot on the account can read and write the desk the way you can. There is **one Chromium** for the whole team (**a tab per desk bot**; cookies shared).
- Skills are procedures on a **shared** desk (`desk/skills/<name>/SKILL.md`). Overlay lists names only; Grok reads bodies via the filesystem. Learn this / ProposeRoutine are calendar jobs. Operator `~/.grok/skills` are not loaded. Optional `desk/projects/<botId>/SOUL.md` is never auto-created.
- Vault files (`master.key` and credentials) live **outside** `desk/`. Grok’s `HOME` is `$OPENBOT_HOME/grok-home` (a copy of `~/.grok/auth.json`, not a symlink). ACP tools whose paths resolve outside the desk are denied. Optional `OPENBOT_SANDBOX` (macOS `sandbox-exec` / Linux `bwrap`) is best-effort and off in tests. Same-uid `0600` is not a jail; a dedicated OS user is. Do not copy secrets into the workspace Grok can see.
- Restarting the server starts a new Grok ACP process. Chat history is in SQLite. On cold start OpenBot tries ACP `session/resume`; if that fails it injects a thread **summary + recent tail**. Idle desk children stay warm for 2 hours (override `OPENBOT_ACP_IDLE_MS`; `0` disables desk idle kill). A warm teammate hopping to another thread gets that thread's summary + tail prefixed; that is **not** a new session. Compact is `session/new` on the **same** process (default every 20 turns or 48k prompt chars; `OPENBOT_ACP_COMPACT_TURNS` / `OPENBOT_ACP_COMPACT_CHARS`, `0` disables that trigger). Compact-on-thread-switch is off unless `OPENBOT_ACP_COMPACT_ON_SWITCH=1`. Compact does not announce itself in the transcript.
- Teammates see the desk roster (up to six teammate names) in their spawn overlay. Protocol infrastructure is not part of that roster. Hiring someone does not kill the other Groks; each bot picks up the new roster on its next turn.
- Standing notes freeze at spawn (idle ~2h, compact, model/roster respawn, or Save which kills the child if it is not in a turn). They do not appear on the current warm child. `Memory.read` sees sqlite immediately. Search is a tool over this org’s log, not prompt stuffing.
- **The frozen public protocol surfaces are `/mcp`, `/a2a/v1` plus `/.well-known/agent-card.json`, and `/ag-ui/v1/*`.** The Grok bridge at `/internal/runtime/mcp` is private and loopback-only. Legacy `/mcp/v1` and `/fed/v1/*` routes are removed.
- **SendToAgent is queued, not done.** Completions sit on the A2A thread as a system line; the sender is not auto-woken.

---

## What you get

| Capability | What it means |
| --- | --- |
| Named bots | Up to **six** active desk teammates. Unique names. Archive frees a slot. |
| Human DM | Each bot has a 1:1 thread with you. |
| `SendMessage` | A proactive private DM from background work. The assistant response is the canonical reply to the current human or A2A requester. |
| `SendToAgent` | Async mailbox to another bot. Does **not** write your DM. Handoffs in the UI show the A2A thread. |
| `ListBots` / `CreateBot` | Fallback roster and hire for desk teammates only (cap 6). Bots must **not** mint `/auth/local` or `POST /v1/bots`. The spawn overlay already lists names. |
| Parallel turns | At most one running turn **per bot**. Two bots can work at the same time on the shared desk. |
| Warm Grok process | Each bot keeps an ACP child across turns. Model / reasoning / roster changes respawn it on the **next** turn. |
| Model & reasoning | Per-bot Grok model (e.g. grok-4.6) and effort (low / medium / high / extra high). Settings always; Debug composer on a human DM. |
| Live work | Default UI is the messenger (roster + thread). **Debug** (header, or Ctrl/Cmd+Shift+Period) shows thinking and tool calls in a resizable sidebar. Activity board for the whole team. |
| Takeover | **Desk browser** grabs the human tab of the shared Chromium (screencast + input). Esc / Close ends it; F6 from the canvas focuses Close. Desk bots keep their own tabs. |
| Archive | Soft-delete folder. Restore, or type `DELETE` to purge. Expired archives (30 days) are removed automatically. |
| Calendar / schedules / Learn this | Org-local sqlite (not Google Calendar: no sync, no invites). Schedules and learned routines are two products on the same grid. **Learn this** drafts a proposed event from a thread — not a recording. The clock is the process. |
| OpenAI-compatible API | Open WebUI (and similar) can use a bot as `openbot/<Name>` with a `sk-ob_…` key. Two connections = two orgs (mint the key on that VM). |
| A2A connection | One process is one org. An internal transport principal backs the public A2A endpoint. It is not a teammate, chat target, group member, AG-UI agent, or OpenAI-compatible model. |
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

The CLI is `bun run openbot -- <command>` (or `bun run apps/server/src/cli.ts`). Current version is **0.8.0**. `openbot version` prints `{ openbot, grokPin, grok }`. OpenBot pins **Grok CLI 1.0.5** (warns if missing or older; does not refuse to start).

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

`grok login` must be done as the **same user** the service runs as. Full operator and protocol exposure notes: [docs/host-service.md](docs/host-service.md).

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

Bind is `127.0.0.1`. Put it behind your own TLS reverse proxy if you need a hostname. Caddy must return `404` for `/internal/runtime/mcp`; see [the host-service protocol surface](docs/host-service.md#protocol-surface-at-the-cutover). GitHub OAuth:

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

The public MCP adapter is Streamable HTTP at `/mcp`. Grok's provider-specific compatibility bridge is `/internal/runtime/mcp`; it is loopback-only, uses a scoped runtime token, and must never be exposed through the reverse proxy.

---

## Data on disk

Control dir is `~/.openbot`. Each org profile is its own data root (`$OPENBOT_HOME`).

| Path | Role |
| --- | --- |
| `~/.openbot/profiles.json` | Slug → data dir map and current profile |
| `~/.openbot/orgs/<slug>/` | Default data root for a named org |
| `~/.openbot/openbot.sqlite` | Legacy single-home layout (still valid; first `org init <slug>` adopts it) |
| `$OPENBOT_HOME/openbot.sqlite` | Bots, canonical agent tasks/runs/events, threads, messages, live-work, sessions, `org_meta` (incl. timezone), `calendar_series`, `calendar_instances` |
| `org.json` | Optional org slug/name/origin. DB wins once written; `org init` rewrites this file. |
| `master.key` | Vault master (mode 0600). Not under `desk/` |
| `allowlist` | GitHub logins, one per line |
| `desk/` | Shared computer. Chromium profile under `desk/.openbot/chromium`. Gateway cwd `desk/.openbot/gateway/`. |
| `desk/skills/<name>/SKILL.md` | Shared procedures (seeded `confirm-series`, `shared-chromium`, write-if-absent). Overlay lists names only. |
| `desk/projects/<botId>/` | That bot's ACP cwd. Purge deletes this folder only. Bots can still `../` into siblings. |
| `desk/projects/<botId>/SOUL.md` | Optional voice/taboos. Never auto-created. |
| `grok-home/` | Isolated Grok config (no user MCP servers) and the Grok child `HOME`. Auth is a **copy** of `~/.grok/auth.json`, refreshed on each `ensureHarness`. Operator `~/.grok/skills` are not loaded. |

`--home` / `OPENBOT_HOME` relocate one org's data. Wiping the desk does not delete the sqlite DB or vault. Grok CLI login stays in `~/.grok/auth.json`.

An upgraded home may retain obsolete federation tables or an `org.ed25519` file. They are inert legacy state under the current public protocol stack; their presence does not enable a `/fed/v1/*` API.

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
| `OPENBOT_GITHUB_CLIENT_ID` / `OPENBOT_GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `OPENBOT_GITHUB_ALLOWLIST` | Extra comma-separated GitHub logins |
| `OPENBOT_DEV_LOGIN` | `1` enables `/auth/local` (loopback only). `demo` sets this. |
| `OPENBOT_HTTP_LOG` | `1` logs every HTTP request start/completion. Slow, failed, aborted, and streaming request lifecycle events are always logged. Logs include request ID, method, pathname, status, and duration—never query strings, headers, or bodies. |
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

### Agent protocol endpoints

| Protocol | Path | Notes |
| --- | --- | --- |
| MCP | `/mcp` | Public Streamable HTTP endpoint. |
| A2A | `/a2a/v1` | Public JSON-RPC endpoint; bearer authentication required. |
| A2A Agent Card | `/.well-known/agent-card.json` | Public discovery document advertising `/a2a/v1`. |
| AG-UI | `/ag-ui/v1/run`, `/ag-ui/v1/runs/:runId/events`, `/ag-ui/v1/runs/:runId` | Public run, replay, and cancel endpoints. |

`/internal/runtime/mcp` is not public MCP. It is the loopback-only Grok compatibility bridge and must be denied by Caddy/nginx. `/mcp/v1` and all `/fed/v1/*` routes are removed, with no compatibility aliases. See [host-service deployment boundaries](docs/host-service.md#protocol-surface-at-the-cutover).

### Product endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/healthz` `/v1/readyz` | Liveness / SQLite + desk writable |
| `GET` | `/v1/me` | Current user |
| `GET`/`PATCH` | `/v1/org` | Member snapshot and settings (cookie, not `sk-ob_`). Timezone is IANA; default `UTC` |
| `POST` | `/v1/bots` | Create. Body `{ name, description, model?, reasoningEffort? }` |
| `GET` | `/v1/bots` | Desk `bots[]` + archived, plus read-only `a2aGateway` protocol status (not a bot resource) |
| `POST` | `/v1/bots/:id/archive` `/restore` | Soft-delete / undo |
| `POST` | `/v1/bots/:id/purge` | Body `{ confirm: "DELETE" }`. Archived only |
| `PATCH` | `/v1/bots/:id/settings` | `permissionMode`, `requireHumanApproval`, `requireMemoryApproval`, `model`, `reasoningEffort` |
| `GET`/`PATCH` | `/v1/memory` `/v1/bots/:id/memory` | Standing org/bot notes. Human Save kills the child if it is not in a turn. |
| `POST` | `/v1/memory/pending/:id/approve` `/reject` | Parked agent Memory writes |
| `GET` | `/v1/inference-models` | Grok catalog + effort menus |
| `GET` | `/v1/agents/:agentId/conversation` | Canonical AG-UI conversation bootstrap for the human DM |
| `GET` | `/v1/threads?botId=&kind=human\|a2a` | Thread/resource navigation; human transcript content comes from the canonical conversation resource |
| `POST` | `/v1/threads/:id/messages` | Group/internal legacy turn submission; human DMs use AG-UI |
| `GET` | `/v1/turns/:id/live-work` | Group/calendar/internal legacy turn diagnostics; human DMs use AG-UI events |
| `GET` | `/v1/activity` | Team presence |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/calendar…` | Cookie, not `sk-ob_`. Window `GET /v1/calendar?from=&to=`; series CRUD, confirm, pause; instance cancel; `POST /learn` uses `{ agentId }` for a human AG-UI conversation or `{ threadId, botId? }` for a group |
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
4. Model `openbot/<BotName>` (e.g. `openbot/Ada`). Desk-bot UUIDs work too.

`GET /v1/models` lists active **desk teammates**, not Grok model IDs or the internal A2A transport principal. Completions send the last user message into that teammate's human thread and wait for the turn. Streaming is supported.

`GET /v1/bots.bots[]` is desk-only. The separate `a2aGateway` field is read-only connection status and never contains a bot ID.

---

## Multiple hosts after the protocol cutover

One `openbot server` process is one org. A second host is a separate installation with its own SQLite database, allowlist, credentials, and API keys. OpenBot does **not** provision VMs.

The former peer/federation deployment procedure is retired and must not be reused. There is no `/fed/v1/*` API. Standards-based agent clients discover each host through `/.well-known/agent-card.json` and call its advertised `/a2a/v1` endpoint with an appropriate bearer credential.

For the complete reverse-proxy boundary, see [docs/host-service.md](docs/host-service.md#protocol-surface-at-the-cutover).

---

## Layout (code)

Bun workspaces.

```
apps/server/          Hono app, SPA, CLI, turn engine, OpenAI shim
packages/acp-grok/    grok agent stdio client, isolated GROK_HOME, model catalog
packages/application/ provider-neutral task/runtime ports and services
packages/calendar/    RRULE subset, civil expansion, calendar constants
packages/core/        canonical task, event, identity, and schema contracts
packages/runner/      localhost compute: desk, Chromium CDP, per-bot ACP
packages/db/          SQLite schema + purge / archive
packages/live-work/   messages, promote(), live-work events, thread digest
packages/mcp-send-message/  SendMessage + SendToAgent
packages/protocol-mcp/    public MCP adapter
packages/protocol-a2a/    public A2A adapter and Agent Card
packages/protocol-ag-ui/  public AG-UI adapter
packages/runtime-grok/    Grok runtime provider adapter
packages/vault/       credential encryption
packages/auth/        GitHub / local session, allowlist
packages/compute-protocol/  five-method host contract
docs/design/          Phase 1–5 design notes
tests/                bun:test; fake ACP, no live xAI required
```

---

## Tests

```bash
bun run check
```

That runs the frozen contract, persistence, protocol, runtime, dependency-boundary,
and full regression gates. CI also builds and executes the release binary. Harness
tests use the fake agent; they do not call xAI. The older repository-wide
`bun run check:types` remains a separate migration-debt report and is not the
acceptance gate for the isolated contract packages.

---

## Limits and non-goals

**Now**

- Six active **desk** bots. The internal A2A transport principal does not consume a roster slot and is not exposed as a bot.
- One desk, one Chromium. Two bots editing files will race; two bots scraping will queue on the browser lock. Each bot's cwd is `desk/projects/<id>/`; that is a home folder, not a jail.
- Idle desk Grok processes exit after 2 hours (override `OPENBOT_ACP_IDLE_MS`). Gateway default 30 minutes. The next message cold-starts in a few seconds.
- The protocol cutover has no backward aliases: external MCP uses `/mcp`, and cross-host agent protocol traffic uses A2A.
- Codex / OpenCode adapters are not shipped.
- Bind is 127.0.0.1 by default; you own TLS and exposure. Caddy must return `404` for `/internal/runtime/mcp`.

**Not this project (later / never here)**

- Fly Machines / tenant VM provisioning, `cptr`, hosted multi-tenant 6PN.
- Remote runner (orchestrator on A, grok on B).
- Mobile / desktop apps, Postgres control plane, per-bot filesystem isolation.

Historical design background (not current operator guidance): [docs/design/phase-1-always-on-teammate-loop.md](docs/design/phase-1-always-on-teammate-loop.md), [docs/design/phase-2-team-on-one-desk.md](docs/design/phase-2-team-on-one-desk.md), [docs/design/phase-3-orgs-vms-gateway.md](docs/design/phase-3-orgs-vms-gateway.md), [docs/design/phase-4-calendar-automations.md](docs/design/phase-4-calendar-automations.md), [docs/design/phase-5-hermes-behavior.md](docs/design/phase-5-hermes-behavior.md).

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Bot says it is a “new session” after restart | Expected ACP reset if resume failed. Current builds inject a summary + recent tail and tell Grok not to announce it. Restart after pull, then send again. |
| Empty bubbles / no reply | Confirm `grok login` or a vaulted key. Check Live work for a crashed turn. `OPENBOT_ACP_COMMAND` must be unset for real Grok. |
| UI looks old | Hard-refresh. The SPA is served by the same process; restart `openbot demo`. |
| Purge / delete fails | Archive first. Permanent delete is archived-only and body `{ "confirm": "DELETE" }`. |
| `FOREIGN KEY constraint failed` on purge | Fixed in current `deleteBotPermanently` (A2A / live-work / cross-thread `turn_id`). Update and retry. |
| Open WebUI 401 | Use `sk-ob_…` minted **on that VM**, base URL ending in `/v1`, and a desk model `openbot/<Name>`. Another org is another connection, not an OpenAI `organization` header. |
| Protocol client uses `/mcp/v1` or `/fed/v1/*` | Those routes were removed. Use `/mcp`, or discover A2A through `/.well-known/agent-card.json`. |
| `/internal/runtime/mcp` is reachable through the public hostname | Fix the reverse proxy immediately so this private, loopback-only Grok bridge returns `404`. |
| Takeover is a black `about:blank` | No page is open in the shared browser yet. That is idle Chromium, not a hang. |
| Bun reports `request timed out after 10 seconds` | Update and restart OpenBot. Long-running MCP, AG-UI, A2A, OpenAI, and takeover requests have scoped timeout policies. Look for `http.request.slow`, `http.request.aborted`, or `http.stream.*` records with the same `requestId`; set `OPENBOT_HTTP_LOG=1` for successful request boundaries too. |

---

## License

[MIT](LICENSE).
