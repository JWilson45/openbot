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
- **Stopping `openbot server` / `openbot demo` does.**
- If you want work to continue while a laptop is closed, run the server on a machine that stays up (VPS, home server, systemd) — not on the laptop you are about to shut.
- `$OPENBOT_HOME/desk` is a **shared computer**. It is **not** a security boundary. Every bot on the account can read and write the desk the way you can. There is **one Chromium** for the whole team.
- Vault files (`master.key`, credentials) live **outside** `desk/`. Do not copy secrets into the workspace Grok can see.
- Restarting the server starts a new Grok ACP process. Chat history is in SQLite; OpenBot injects a thread digest on the next turn so the bot continues instead of announcing amnesia.

---

## What you get

| Capability | What it means |
| --- | --- |
| Named bots | Up to **six** active teammates. Unique names. Archive frees a slot. |
| Human DM | Each bot has a 1:1 thread with you. |
| `SendMessage` | The **only** way a bot talks to you. Assistant rambling is a private work log unless it fails to call the tool (then you get a fallback). |
| `SendToAgent` | Async mailbox to another bot. Does **not** write your DM. Handoffs in the UI show the A2A thread. |
| Parallel turns | At most one running turn **per bot**. Two bots can work at the same time on the shared desk. |
| Warm Grok process | Each bot keeps an ACP child across turns. Model / reasoning changes respawn it on the **next** turn. |
| Model & reasoning | Per-bot Grok model (e.g. grok-4.6) and effort (low / medium / high / extra high). Composer + Settings. |
| Live work | Collapsible thinking and tool calls in a resizable sidebar. Activity board for the whole team. |
| Takeover | You grab the shared Chromium (screencast + input). Esc / Close ends it. |
| Archive | Soft-delete folder. Restore, or type `DELETE` to purge. Expired archives (30 days) are removed automatically. |
| OpenAI-compatible API | Open WebUI (and similar) can use a bot as `openbot/<Name>` with a `sk-ob_…` key. |
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

The CLI is `bun run openbot -- <command>` (or `bun run apps/server/src/cli.ts`).

```
openbot demo   [--port 8787] [--home ~/.openbot] [--fake]
openbot server [--port 8787] [--home ~/.openbot] [--origin http://127.0.0.1:8787]
openbot allowlist add <github-login>
openbot allowlist
```

Default home is `$OPENBOT_HOME` or `~/.openbot`.

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
| `[[write:file]]` | Writes a file in the desk cwd |
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

Bind is `127.0.0.1`. Put it behind your own TLS reverse proxy if you need a hostname. GitHub OAuth:

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
- **Archive** — moves the bot to the Archive folder; frees an active slot. Restore from there. **Delete** is archived-only and requires typing `DELETE`. After 30 days an archive is purged unless restored.
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
| `openbot.sqlite` | Bots, threads, turns, messages, live-work, sessions |
| `master.key` | Vault master (mode 0600). Not under `desk/` |
| `allowlist` | GitHub logins, one per line |
| `desk/` | Grok cwd, `desk/projects/`, Chromium profile |
| `grok-home/` | Isolated Grok config (no user MCP servers). Auth is linked from `~/.grok/auth.json` |

`--home` / `OPENBOT_HOME` relocate the lot. Wiping the desk does not delete the sqlite DB or vault.

---

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENBOT_HOME` | Data root (default `~/.openbot`) |
| `PORT` | Listen port (default `8787`) |
| `OPENBOT_PUBLIC_ORIGIN` | Public URL for OAuth redirects and cookies |
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
| `POST` | `/v1/bots` | Create. Body `{ name, description, model?, reasoningEffort? }` |
| `GET` | `/v1/bots` | Active + archived |
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

OpenBot speaks OpenAI Chat Completions so Open WebUI (and other OpenAI clients) can treat each bot as a model.

1. Run the server and sign in.
2. Settings → **Create API key**, or:

   ```bash
   curl -s -H "Cookie: openbot_session=…" -H "Content-Type: application/json" \
     -d '{"name":"open-webui"}' http://127.0.0.1:8787/v1/api-keys
   ```

   Copy `token` (`sk-ob_…`). It is shown **once**.
3. Open WebUI → Admin → Connections (provider **OpenAI**):
   - **Base URL**: `http://127.0.0.1:8787/v1` (or `…/openai/v1`)
   - **API key**: the `sk-ob_…` secret
4. Model `openbot/<BotName>` (e.g. `openbot/Ada`). Bot UUIDs work too.

`GET /v1/models` lists **active bots**, not Grok model IDs. Completions send the last user message into that bot's human thread and wait for the turn. Streaming is supported.

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
packages/vault/       credential encryption
packages/auth/        GitHub / local session, allowlist
packages/compute-protocol/  five-method host contract
docs/design/          Phase 1 / Phase 2 design notes
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

- Six active bots, 1:1 A2A only (no group chat).
- One desk, one Chromium. Two bots editing files will race; two bots scraping will queue on the browser lock.
- Codex / OpenCode adapters are not shipped.
- Bind is localhost; you own TLS and exposure.

**Not this project (later / never here)**

- Fly Machines / tenant VM provisioning, `cptr`, hosted multi-tenant 6PN.
- Mobile / desktop apps, Postgres control plane, per-bot filesystem isolation.

Design background: [docs/design/phase-1-always-on-teammate-loop.md](docs/design/phase-1-always-on-teammate-loop.md), [docs/design/phase-2-team-on-one-desk.md](docs/design/phase-2-team-on-one-desk.md).

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Bot says it is a “new session” after restart | Expected ACP reset. Current builds inject a thread digest and tell Grok not to announce it. Restart after pull, then send again. |
| Empty bubbles / no reply | Confirm `grok login` or a vaulted key. Check Live work for a crashed turn. `OPENBOT_ACP_COMMAND` must be unset for real Grok. |
| UI looks old | Hard-refresh. The SPA is served by the same process; restart `openbot demo`. |
| Purge / delete fails | Archive first. Permanent delete is archived-only and body `{ "confirm": "DELETE" }`. |
| `FOREIGN KEY constraint failed` on purge | Fixed in current `deleteBotPermanently` (A2A / live-work / cross-thread `turn_id`). Update and retry. |
| Open WebUI 401 | Use `sk-ob_…` from Settings, base URL ending in `/v1`, model `openbot/<Name>`. |
| Takeover is a black `about:blank` | No page is open in the shared browser yet. That is idle Chromium, not a hang. |

---

## License

[MIT](LICENSE).
