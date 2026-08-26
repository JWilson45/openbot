# OpenBot Phase 2 — Team on One Desk

| Field | Value |
| --- | --- |
| **Title** | OpenBot Phase 2 Plan: Multi-bot roster, `SendToAgent`, parallel turns |
| **Author** | OpenBot maintainers (draft) |
| **Date** | 2026-08-25 |
| **Status** | Draft |
| **Depends on** | Phase 1 as implemented in this repo (not the pre-code design freeze) |
| **Audience** | Engineers extending `apps/server` + `packages/*` |

Phase 1 shipped the teammate loop. Phase 2 makes it a **team**: several named bots on the **same desk**, talking to the human via `SendMessage` and to each other via `SendToAgent`, without the human as glue.

---

## Where Phase 1 actually is

Cite the code, not the original architecture sketch. These are the load-bearing facts Phase 2 must change or keep.

### Keep (do not rewrite)

| Piece | Where | Why it stays |
| --- | --- | --- |
| BYO host, no cloud provision | `apps/server/src/cli.ts`, `LocalHostDriver` | Operator decision. Fly/`cptr` stay later. |
| Shared desk `$OPENBOT_HOME/desk` | `packages/runner` `desk` | Grok Bot model. Not a bot security boundary. Copy already says so. |
| `SendMessage` + DB `promote()` | `packages/mcp-send-message`, `packages/live-work` | Human-visible writes stay tool-shaped. Running-turn-only, drain, ignore runner counters. |
| GitHub allowlist, vaulted `XAI_API_KEY` | `packages/auth`, `packages/vault` | One account key for the desk. Per-bot keys are later. |
| CDP Chromium + takeover | `packages/runner` `startScreencast` / `dispatchInput` | One browser on the desk. |
| ACP stdio + fake agent | `packages/acp-grok`, `tests/fixtures/acp/fake-agent.ts` | Tests stay off the live xAI network. |
| SQLite + Bun + same-origin SPA | `packages/db`, `apps/server` | No Postgres/Redis in Phase 2. |
| Five-method compute contract | `packages/compute-protocol` | Remote runner / Fly still later; don't break the interface. |

### Must change (Phase 1 will not scale to a team)

1. **One active bot.** `CREATE UNIQUE INDEX bots_one_active` in `packages/db/src/index.ts`. `POST /v1/bots` returns 409 if an active bot exists (`apps/server/src/app.ts`). `GET /v1/bots` returns a singular `bot`. SPA assumes `state.bot`.
2. **One thread per account in the API.** `GET /v1/threads` is `SELECT * FROM threads WHERE account_id = ?` with no bot filter. Fine for one bot; wrong for N.
3. **Global serial turn loop.** `TurnEngine.loop()` in `apps/server/src/engine.ts` takes `SELECT * FROM turns WHERE status = 'queued' ORDER BY created_at LIMIT 1` and `await runTurn`. Two bots cannot work at once.
4. **One ACP child per account, killed every turn.** `runnerFor(accountId)` is a single `LocalHostRunner`. `ensureHarness` does `await this.acp?.kill()` then respawns (`packages/runner/src/index.ts`). Multi-bot needs **one warm ACP process per bot**.
5. **MCP tools = `SendMessage` only.** `SEND_MESSAGE_TOOL` in `packages/mcp-send-message`. No way for Ada to enqueue work for Bob.
6. **One Chromium.** Shared. Phase 2 keeps that (mutex around browser MCP). “Own screen per bot” is Phase 3.

Schema hatch from Phase 1 that we use: `bots` and `threads` already key by `bot_id`; `mcp_tokens` already bind `{accountId, botId, threadId, harnessSessionId}`. We are not starting a new storage model.

---

## Overview

Phase 2 ships:

- Up to **six** named bots on one account / one desk.
- Each bot has a **human DM** (existing `threads_one_per_bot`).
- Bots message each other with **`SendToAgent`**: async mailbox, never blocks the sender, never writes the human thread.
- Turns run **in parallel, at most one running turn per bot**.
- Each bot keeps a **warm ACP process** across turns (no kill/spawn per message).
- Optional **human approval** on `SendMessage` (`urgency=needs_user` or per-bot flag). `SendToAgent` is not approval-gated.
- Optional last slice: **Codex ACP** as a per-bot harness pick. Same desk, same tools.

The magic loop: you have Ada (research) and Bob (writer). You text Ada; she `SendToAgent`s Bob a brief; Bob `SendMessage`s you a draft. You were not the integration layer.

---

## Goals & Non-Goals

### Goals

1. Create / list / archive up to 6 active bots. Shared-desk warning remains on create.
2. Human can open each bot’s DM independently. Composer queues per that bot (depth 5, unchanged).
3. `SendToAgent({ botId | name, body })` inserts `origin=agent` on an A2A thread and **queues a turn on the target**. Sender’s turn continues.
4. Target bot only hears A2A mail when its next `session/prompt` starts (mailbox, not a blocking RPC).
5. Two bots can be `in_turn` at the same time (coding in parallel on the shared FS). Browser MCP is serialized.
6. Tab close still does not cancel anyone. Stopping `openbot server` still stops everyone.
7. Approvals: a `SendMessage` can sit as `origin=pending_approval` until the human confirms; then it becomes `send_message` and is visible as the bot’s words.
8. Tests use the fake ACP agent (`[[sendto:Bob:hello]]`, `[[send:…]]`, `[[permission]]`) — no live xAI required.

### Non-Goals (Phase 2)

- Group chats (3+ bots in one thread). 1:1 A2A only.
- Fly Machines / tenant VM provisioning.
- Remote runner (orchestrator on A, grok on B). `/runner/v1` sibling stays unused except as the existing hatch.
- `cptr` / Open WebUI Computer.
- Desktop / mobile clients.
- Cron, routines, watch-me-do-it.
- Per-bot filesystem isolation, extra Chromium per bot, gVisor.
- Postgres, KMS, SSO, billing.
- OpenCode / Claude Code adapters (Codex is the only extra harness if we get to it).
- Changing `promote()` rules or making assistant text the thread.

---

## Key Decisions

| # | Decision | Choice | Rationale |
| --- | --- | --- | --- |
| P2-D1 | Product slice | Roster + 1:1 `SendToAgent` + parallel per-bot turns | That’s the Grok Bot “stop being the glue” moment. Group chat and hosted desks wait. |
| P2-D2 | Cap | **6** active bots per account | Matches Grok Bot’s 2–6 group size. Cheap enough for one host. |
| P2-D3 | Isolation | Still **one desk, one Chromium** | Phase 1 copy is still true. Parallel coding, mutexed browser. Own-screen is Phase 3. |
| P2-D4 | A2A transport | Orchestrator MCP `SendToAgent`, same Streamable HTTP server as `SendMessage` | Tool host stays the orchestrator. Harness never DMs another stdio. |
| P2-D5 | A2A delivery | **Mailbox**: insert message + `turns` row `queued` on the target. Never wait for Bob to finish. | Phase 1 already forbids blocking on other agents. Late `SendMessage` rules stay. |
| P2-D6 | Threads | Human DM: keep `threads_one_per_bot`. A2A: new `kind='a2a'` thread unique on `(account_id, bot_lo, bot_hi)`. | Human inbox stays 1:1. A2A history is inspectable, not mixed into the human DM unless we later add a system notice. |
| P2-D7 | Human sees A2A? | **Read-only inspector** (open the A2A thread in the UI). Bots do not `SendMessage` as a side effect of A2A. | Transparency without turning every handoff into a human ping. |
| P2-D8 | Harness processes | `Map<botId, AcpClient>` on the existing `LocalHostRunner`. Warm until crash/idle-timeout. | Today `ensureHarness` kills the only child every turn — unusable at N>1. |
| P2-D9 | Engine loop | One running turn **per bot_id**, not global serial. Kick is “for each bot with no running turn, dequeue oldest queued”. | Two `session/prompt`s at once. Drain remains **per harnessSessionId**. |
| P2-D10 | Approvals | `SendMessage` only. Default **off**. `urgency=needs_user` **or** `bots.require_human_approval` parks `pending_approval`. `SendToAgent` never parks. | ACP bash permissions already exist (`tests/permissions.test.ts`). Don’t conflate them with “show this to the human.” |
| P2-D11 | Credentials | Still one vaulted `xai_api_key` per account. Codex OAuth/token is a second `credentials.kind` when that adapter lands. | Don’t explode Settings. |
| P2-D12 | Codex | Last PR, same ACP client interface, `bots.harness = 'grok' \| 'codex'`. Skip if the pin is painful; column exists either way. | BYO-brain hatch without blocking the team loop. |
| P2-D13 | Names | `SendToAgent` target is `botId` (stable) with `name` as a convenience resolved inside the account. Names unique per account among active bots. | Renames shouldn’t break mail. |

---

## Proposed Design

### Roster and UI

`POST /v1/bots` no longer 409s on a second bot (409 only at cap 6 or duplicate name).

`GET /v1/bots` returns `{ bots: Bot[] }`. Keep `{ bot }` undocumented.

SPA (`apps/server/src/spa.ts`):

- Left rail: bot list (name + in_turn / idle).
- Main pane: selected bot’s **human DM**.
- “Handoffs” (or a thread switcher) to open an A2A thread read-only, with a “Message {bot} yourself” jump to that bot’s DM.
- Create-bot still asks name + description; key is account-level (don’t re-paste for bot 2).
- Shared-desk + “one Chromium” copy on create.

### Engine: parallel per bot

Replace `TurnEngine.loop` global `await`:

```ts
// apps/server/src/engine.ts (target)
private async loop(): Promise<void> {
  while (true) {
    const idleBots = this.opts.db.all<{ bot_id: string }>(
      `SELECT DISTINCT bot_id FROM turns t
       WHERE status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM turns r
           WHERE r.bot_id = t.bot_id AND r.status = 'running'
         )`,
    );
    if (idleBots.length === 0) return;
    await Promise.all(idleBots.map((b) => this.runNextForBot(b.bot_id)));
  }
}
```

`runTurn` already loads `turn.bot_id`. Point `ensureHarness` at `runner.acpFor(botId)` instead of `this.acp`.

**Do not kill** a healthy ACP between turns. `ensureHarness(botId)`: if child alive and `acpSessionId` set, `session/prompt` only. Kill/respawn on crash, missing key rotation, or `harness_session_reset`.

Per-bot queue depth 5 still enforced in `POST /v1/threads/:id/messages` (count queued for **that bot**, not the account).

### `SendToAgent`

Same MCP server (`GET+POST /mcp/v1`). `tools/list` returns `SendMessage` and `SendToAgent`.

```json
{
  "name": "SendToAgent",
  "description": "Send work to another named bot on this desk. Async: returns immediately. Does not message the human. Use SendMessage to talk to the human.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["body"],
    "properties": {
      "botId": { "type": "string" },
      "name": { "type": "string", "description": "Active bot name on this account" },
      "body": { "type": "string", "minLength": 1, "maxLength": 32000 }
    }
  }
}
```

Authorize like `SendMessage`: bearer → `mcp_tokens` → **running** turn for `{harnessSessionId, threadId}` of the **sender**. Then:

1. Resolve target: same `account_id`, `status='active'`, not self.
2. Find-or-create A2A thread (`kind='a2a'`, `bot_lo < bot_hi` uuids).
3. `BEGIN IMMEDIATE`: insert `messages` `{ role:'user', origin:'agent', body, from_bot_id: sender }` on that thread; insert `turns` `{ bot_id: target, thread_id: a2a, status:'queued' }`.
4. Return `{ ok, threadId, turnId }` to the sender. `kick()` the engine.
5. Rate: 20 A2A/turn, 200/account/hour. Target queue full (5) → MCP error `target_busy` (sender’s turn continues).

Prompt overlay (`_meta.rules`) adds: *To talk to another bot you MUST call `SendToAgent`. That does not notify the human.*

Target’s next prompt includes the new mailbox body as the user prompt (same as a human DM). Identity overlay still “You are {targetName}”.

**Fallback:** if Ada `SendToAgent`s and Bob rambles, Bob’s human DM is **untouched**; Bob’s A2A thread gets a fallback bubble. The human sees it only if they open that handoff thread.

### Approvals

New message origin `pending_approval`. Not shown as the bot’s final words until confirmed (UI: “Ada wants to send this”).

`sendMessage()` if `input.urgency === 'needs_user'` **or** `bots.require_human_approval`:

- insert `pending_approval` (not `send_message`)
- do **not** increment `sent_message_count` until confirm (or do increment a `pending` count — prefer **not** counting as a successful SendMessage so promote can still fallback if they never confirmed and never sent a real one)

Confirm: `POST /v1/messages/:id/approve` → rewrite origin to `send_message`, increment `sent_message_count`, push `message.created`.

Reject: origin `system` “You declined this send.”

ACP `session/request_permission` stays as Phase 1 (bash/tool). Different channel.

### Browser mutex

`LocalHostRunner.browserLock`. `openbot-browser` MCP and takeover both take the lock. Coding ACP processes do not. Document: two bots scraping at once will queue; two bots editing files will race on the shared desk (laptop-equivalent).

### Codex (last)

`bots.harness` text default `grok`. `packages/acp-codex` spawn `codex acp` / documented argv, `credentials.kind='codex'`. Fake command `OPENBOT_ACP_COMMAND` still overrides in tests. If the Codex pin is hostile, ship the column and skip the adapter — team loop does not depend on it.

---

## Data model changes

SQLite migrations in `OpenbotDb.migrate()` must be **additive** (`IF NOT EXISTS` / `ALTER TABLE` guarded). Existing Phase 1 DBs on operator hosts have to open.

```sql
-- drop one-bot freeze
DROP INDEX IF EXISTS bots_one_active;

CREATE UNIQUE INDEX IF NOT EXISTS bots_active_name
  ON bots(account_id, name) WHERE status = 'active';

-- cap is enforced in POST /v1/bots, not a CHECK (easier to tune)

ALTER TABLE bots ADD COLUMN harness text NOT NULL DEFAULT 'grok';
ALTER TABLE bots ADD COLUMN require_human_approval integer NOT NULL DEFAULT 0;

ALTER TABLE threads ADD COLUMN kind text NOT NULL DEFAULT 'human'; -- human | a2a
ALTER TABLE threads ADD COLUMN peer_bot_id text REFERENCES bots(id);

-- human DM remains one per bot
-- A2A: unique pair
CREATE UNIQUE INDEX IF NOT EXISTS threads_a2a_pair
  ON threads(account_id, bot_id, peer_bot_id) WHERE kind = 'a2a';

ALTER TABLE messages ADD COLUMN from_bot_id text REFERENCES bots(id);
```

`messages.origin` gains: `agent` | `pending_approval` (plus existing `user` `send_message` `fallback` `system`).

`promote()`: unchanged truth table. `pending_approval` does **not** count as `hasSend`. Only `origin='send_message'` does. A turn that only parked an unapproved send still fallbacks — good (the human never got a sent message).

---

## API changes

| Method | Path | Change |
| --- | --- | --- |
| `POST` | `/v1/bots` | Allow N≤6; 409 `cap` / `duplicate_name`. No extra key required. |
| `GET` | `/v1/bots` | `{ bots: [...] }` |
| `POST` | `/v1/bots/:id/archive` | `status='archived'`. Cancels queued turns. |
| `GET` | `/v1/threads?botId=` | Human DM for that bot (default: last-opened). |
| `GET` | `/v1/threads?kind=a2a&botId=` | Handoff list. |
| `GET` | `/v1/threads/:id` | Unchanged shape + `kind`, `peer`. |
| `POST` | `/v1/threads/:id/messages` | Unchanged; queue depth per **bot**. |
| `POST` | `/v1/messages/:id/approve` | pending_approval → send_message |
| `POST` | `/v1/messages/:id/reject` | pending_approval → system |
| `PATCH` | `/v1/bots/:id/settings` | `+ requireHumanApproval`, `harness` |

MCP: `SendToAgent` as above. Cookies still do not authorize MCP.

---

## Sequences

### A2A mailbox

```mermaid
sequenceDiagram
  actor User
  participant Ada
  participant Orch
  participant DB
  participant Bob

  User->>Orch: POST /v1/threads/{adaHuman}/messages
  Orch->>Ada: session/prompt
  Ada->>Orch: tools/call SendToAgent { name: Bob, body }
  Orch->>DB: insert A2A message origin=agent; turn queued for Bob
  Orch-->>Ada: { ok, turnId }
  Note over Ada: Ada continues; may SendMessage the human
  Orch->>Bob: when Bob has no running turn, session/prompt(body)
  Bob->>Orch: tools/call SendMessage { body: draft }
  Orch-->>User: Bob's human DM (not Ada's)
```

### Approval

```mermaid
sequenceDiagram
  participant Bot
  participant Orch
  actor User
  Bot->>Orch: SendMessage { body, urgency: needs_user }
  Orch->>Orch: insert origin=pending_approval
  Orch-->>User: WS + badge "Ada wants to send this"
  User->>Orch: POST /v1/messages/:id/approve
  Orch->>Orch: origin=send_message; sent_message_count++
```

---

## Tests (shipped path, fake ACP)

Extend `tests/fixtures/acp/fake-agent.ts`:

- `[[sendto:Bob:hello]]` — MCP `SendToAgent` with `{ name, body }`.

New files (names indicative):

| Test | Assert |
| --- | --- |
| `tests/roster.test.ts` | Second bot 200; 7th 409; duplicate name 409; archive frees a slot |
| `tests/engine-parallel.test.ts` | Two queued turns on two bots both reach `running` (use `[[sleep:300]]`) |
| `tests/send-to-agent.test.ts` | Ada `[[sendto:Bob:hi]]`; Bob’s A2A thread has `origin=agent`; Bob `[[send:got it]]` lands on Bob’s **human** DM only if the prompt was on the human thread — for mailbox, Bob’s turn is on the A2A thread so `SendMessage` there is wrong |

**Clarify `SendMessage` on an A2A turn:** the running turn’s `thread_id` is the A2A thread. If Bob `SendMessage`s during an A2A-prompted turn, Phase 2 rule:

- **`SendMessage` always writes the caller’s human DM**, not the A2A thread. Implementation: `sendMessage` uses `claims` but looks up `threads` `kind='human'` for `claims.botId` as the insert target when we want human visibility.
- A2A thread only receives `origin=agent` (inbound) and `origin=fallback` / live-work.

This is a deliberate change from Phase 1 “insert on claims.threadId”. Document it in `sendMessage`:

```ts
const human = humanThread(db, claims.botId);
// SendMessage → human DM
// SendToAgent → A2A thread + queued turn
```

`mcp_tokens.thread_id` can remain the turn’s thread (A2A or human) for **running-turn auth**; the insert target for `SendMessage` is always the human DM. Tests must lock this: A2A-triggered Bob calling `[[send:done]]` appears on Bob’s human DM, not only on the handoff thread (handoff can get a system “Bob replied to the human”).

| `tests/send-to-agent.test.ts` | Ada sendto Bob; Bob send; human DM of Bob has `send_message`; Ada human DM unchanged; A2A thread has `origin=agent` inbound |
| `tests/promote.test.ts` | existing cases still pass; pending_approval does not satisfy hasSend |
| `tests/approvals.test.ts` | needs_user parks; approve flips origin; reject does not increment sent_message_count |
| `tests/spa-roster.test.ts` | SPA_HTML contains bot list + `SendToAgent` copy / handoff inspector (structural) |

Warm harness: `tests/harness-warm.test.ts` — two sequential human messages to Ada; runner `acpFor(ada).pid` unchanged (expose `pid` on the child).

---

## Alternatives considered

1. **Group chat as the A2A primitive** — Rejected for Phase 2. Fan-out and “who is speaking” explode promote/fallback. 1:1 mailbox first.
2. **Sender blocks on Bob** — Rejected. Phase 1 is async-by-design; blocking reintroduces the human-as-glue latency.
3. **Write A2A into the human DM as system lines** — Noisy. Inspector thread is enough; optional later digest `SendMessage` “I asked Bob.”
4. **One ACP, prompt-switch personas** — Rejected. Identities and tool traces would bleed. Separate processes, shared disk.
5. **Per-bot Chromium** — Deferred. RAM. Mutex is enough for 2FA takeover (still one human).
6. **Remote runner / Fly in Phase 2** — Operator already said Phase 1 is the host. Splitting processes is a different product.

---

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Shared FS races (Ada and Bob edit the same file) | Medium | Product copy; later isolation. Not a silent security boundary. |
| 6 × Grok + 1 Chrome OOMs a 4 GB host | High | Cap 6, README recommend 8 GB for 3+ bots; don’t spawn Chrome until first browser tool/takeover (Phase 1 already lazy-starts on takeover). |
| Warm ACP identity drift | Medium | Re-inject `_meta.rules` via Grok `update_mcp_servers` / `session/new` if prompt ignores name; fallback-promote still saves us. |
| `SendMessage` retarget to human DM surprises A2A-turn prompts | Medium | Overlay: “SendMessage always goes to the human’s DM with you.” Tests above. |
| Codex adapter time sink | Low | Column first; adapter last; skippable. |

---

## Later (not Phase 2)

- Group chats (2–6 bots + optional human).
- Remote runner TLS, hosted Fly desks, per-account 6PN.
- Own virtual display per bot.
- Cron / watch-me-do-it / learned routines.
- Desktop/mobile.
- OpenCode, Claude Code.
- Per-bot API keys, KMS, Postgres.

---

## PR Plan

Each PR independently reviewable. Demo: two bots, Ada `SendToAgent`s Bob, Bob `SendMessage`s you, both turns overlap, fake ACP.

### PR-19 — Schema: many bots, A2A threads, approval origin

- **Title:** `feat(db): drop bots_one_active, A2A threads, harness and approval columns`
- **Files:** `packages/db/src/index.ts`, `tests/schema.test.ts`
- **Depends on:** Phase 1 (current main)
- **Description:** Additive migrate. Existing one-bot DBs keep working. No API behavior change yet (index drop means a second INSERT would succeed — gate stays in `POST /v1/bots` until PR-20, so **keep the 409 in app.ts until PR-20** and only add columns/indexes here). Actually: if we drop the unique index in this PR without the cap, two bots could be inserted via a bug. **Keep `bots_one_active` until PR-20** which drops it and adds cap+unique name in the same PR as the API.

Revised: this PR only `ALTER TABLE` columns + `threads.kind` / `peer_bot_id` / `from_bot_id`. Do not drop `bots_one_active` yet.

### PR-20 — Roster API and cap

- **Title:** `feat(bots): up to 6 active bots, list, archive, unique names`
- **Files:** `apps/server/src/app.ts`, `tests/roster.test.ts`, SPA bot list
- **Depends on:** PR-19
- **Description:** Drop `bots_one_active`; unique `(account_id, name)` where active; cap 6; `GET /v1/bots` array; `GET /v1/threads?botId=`; archive. Threads API must not return a random account thread.

### PR-21 — Per-bot warm ACP + parallel engine

- **Title:** `feat(engine): one ACP child per bot, parallel running turns`
- **Files:** `packages/runner/src/index.ts`, `apps/server/src/engine.ts`, `tests/engine-parallel.test.ts`, `tests/harness-warm.test.ts`
- **Depends on:** PR-20
- **Description:** `acpFor(botId)`; stop `acp.kill()` on every `ensureHarness`. Loop dequeues per idle bot. Browser mutex stub (lock around existing browser MCP).

### PR-22 — `SendToAgent` MCP + mailbox

- **Title:** `feat(mcp): SendToAgent mailbox, A2A threads`
- **Files:** `packages/mcp-send-message`, `packages/api-types`, `packages/acp-grok` overlay rules, `tests/fixtures/acp/fake-agent.ts`, `tests/send-to-agent.test.ts`
- **Depends on:** PR-21
- **Description:** Tool + find-or-create A2A thread + queue target turn. `SendMessage` insert target = caller’s **human** DM even if the running turn is A2A. Rate limits. Fake `[[sendto:Name:body]]`.

### PR-23 — Approvals for `SendMessage`

- **Title:** `feat: pending_approval origin, approve/reject routes`
- **Files:** `packages/mcp-send-message`, `packages/live-work` (promote must ignore pending), `apps/server` routes + SPA badge, `tests/approvals.test.ts`
- **Depends on:** PR-22 (so A2A isn’t blocked on UI, but promote tests can land with PR-22)
- **Description:** `urgency=needs_user` or `require_human_approval`. Confirm/reject. Promote matrix updated.

### PR-24 — SPA team surface

- **Title:** `feat(web): bot rail, DM switcher, A2A inspector, approval banner`
- **Files:** `apps/server/src/spa.ts`, structural tests
- **Depends on:** PR-20, PR-22, PR-23
- **Description:** This is the Phase 2 **product demo**. Honesty copy: shared desk, one browser, tab vs process.

### PR-25 — Codex harness (skippable)

- **Title:** `feat(acp-codex): optional Codex ACP spawn from bots.harness`
- **Files:** `packages/acp-codex`, runner spawn switch, `credentials.kind=codex`
- **Depends on:** PR-21
- **Description:** Spike argv/auth. If the pin fights us, close with the column only and a README note.

**Do not start remote runner or Fly PRs on this ladder.**

---

## Open questions (defaults in this doc)

1. **A2A-turn `SendMessage` destination** — Default: always the sender bot’s **human DM** (P2 text above). Alternative: write on the A2A thread only (human must open handoffs to see results). Recommendation: human DM, so the user isn’t required to hunt inspector threads.
2. **Codex in Phase 2 vs 3** — Default: last PR, skippable.
3. **Idle ACP TTL** — Default: keep warm for the life of `openbot server` (Phase 1 always-on). Optional 30 min idle kill later.

No operator question reopens Fly or `cptr`.
