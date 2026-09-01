import { join } from "node:path";
import { id, now, purgeExpiredArchivedBots, purgeExpiredOrgInbox, type OpenbotDb, type TurnRow } from "@openbot/db";
import { appendLiveWork, buildThreadDigest, insertMessage, promote, wrapPromptWithDigest } from "@openbot/live-work";
import { mintMcpToken, persistMcpToken, type McpInflight } from "@openbot/mcp-send-message";
import { open, type Envelope } from "@openbot/vault";
import {
  acpIdleTtlMs,
  deleteBotProject,
  gatewayAcpIdleTtlMs,
  LocalHostRunner,
} from "@openbot/runner";
import { DEFAULT_GROK_MODEL, DEFAULT_REASONING_EFFORT, grokCliSignedIn } from "@openbot/acp-grok";
import { currentOrgMeta, FEDERATION_OFF_NOTICE, federationEffective } from "./org.ts";
import { maybeEnqueueGatewayDrain } from "./inbox.ts";
import {
  markCalendarPendingAsSend,
  reconcileCalendarInstance,
  tickCalendar as runTickCalendar,
  type TickCalendarResult,
} from "./calendar-tick.ts";

export type EngineOpts = {
  db: OpenbotDb;
  home: string;
  inflight: McpInflight;
  master: Buffer;
  mcpPort: () => number;
  onPush: (accountId: string, event: unknown) => void;
};

export class TurnEngine {
  runners = new Map<string, LocalHostRunner>();
  busy = false;
  private looping = false;
  private loopAgain = false;
  private runningBots = new Set<string>();

  constructor(public readonly opts: EngineOpts) {}

  runnerFor(accountId: string): LocalHostRunner {
    let r = this.runners.get(accountId);
    if (!r) {
      r = new LocalHostRunner(this.opts.home, accountId);
      r.onLiveWork = (ev, botId) => {
        const turn = this.opts.db.get<TurnRow>(
          botId
            ? "SELECT * FROM turns WHERE status = 'running' AND bot_id = ? ORDER BY created_at DESC LIMIT 1"
            : "SELECT * FROM turns WHERE status = 'running' AND bot_id IN (SELECT id FROM bots WHERE account_id = ?) ORDER BY created_at DESC LIMIT 1",
          [botId ?? accountId],
        );
        if (!turn) return;
        appendLiveWork(this.opts.db, turn.id, ev.kind, ev.payload);
        this.opts.onPush(accountId, { type: "live_work", turnId: turn.id, event: ev });
        if (ev.kind === "permission_request") {
          const reqId = String((ev.payload as { reqId?: string }).reqId ?? "");
          const client = botId ? r.acpFor(botId) : r.acp;
          const askOrAuto = () => {
            const mode = client?.permissionMode ?? r.permissionMode;
            if (mode === "ask") {
              this.opts.onPush(accountId, {
                type: "permission_request",
                turnId: turn.id,
                reqId,
                payload: ev.payload,
              });
            } else {
              r.respondPermission(reqId, true);
            }
          };
          const handler = client?.permissionHandler;
          if (handler) {
            void Promise.resolve(handler(ev)).then(
              (res) => {
                if ("defer" in res && res.defer) askOrAuto();
                else r.respondPermission(reqId, res.allow);
              },
              () => r.respondPermission(reqId, false),
            );
            return;
          }
          askOrAuto();
        }
      };
      this.runners.set(accountId, r);
    }
    return r;
  }

  kick(): void {
    this.maintenance();
    void this.loop();
  }

  /** Sibling of maintenance(); rematerialize/catch-up/enqueue. Does not start turns. */
  tickCalendar(nowMs = Date.now()): TickCalendarResult {
    return runTickCalendar(this.opts.db, nowMs);
  }

  /** Reap orphans, idle ACPs, archived bots, and expired inbox rows. Does not start turns. */
  maintenance(): void {
    this.reapOrphans();
    this.reapIdleHarnesses();
    this.purgeExpiredArchives();
    purgeExpiredOrgInbox(this.opts.db);
  }

  maybeKickGatewayDrain(gatewayBotId: string, finishedTurnId?: string): void {
    const result = maybeEnqueueGatewayDrain(this.opts.db, gatewayBotId, finishedTurnId);
    const bot = this.opts.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [
      gatewayBotId,
    ]);
    if (bot) {
      for (const m of result.push) {
        if (m.origin === "prompt" || m.origin === "calendar") continue;
        this.opts.onPush(bot.account_id, { type: "message.created", message: m });
      }
    }
    if (result.kick) this.kick();
  }

  /** DB-purge expired archives, then best-effort delete each `desk/projects/<id>` only (not isolation). */
  purgeExpiredArchives(accountId?: string): string[] {
    const ids = purgeExpiredArchivedBots(this.opts.db, accountId);
    const desk = join(this.opts.home, "desk");
    for (const botId of ids) {
      try {
        deleteBotProject(desk, botId);
      } catch {
        /* best-effort; the bot row is already gone */
      }
    }
    return ids;
  }

  reapIdleHarnesses(): void {
    const federationOff = !federationEffective(currentOrgMeta(this.opts.db));
    for (const runner of this.runners.values()) {
      const killed = runner.reapIdle(Date.now(), { federationOff });
      for (const botId of killed) {
        this.opts.db.run(
          "UPDATE harness_sessions SET state = 'ended', ended_at = ? WHERE bot_id = ? AND ended_at IS NULL",
          [now(), botId],
        );
      }
    }
  }

  stopGatewayAcps(): void {
    const rows = this.opts.db.all<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM bots WHERE IFNULL(role, 'desk') = 'gateway' AND status = 'active'`,
    );
    for (const row of rows) {
      this.runners.get(row.account_id)?.invalidateAcp(row.id);
    }
  }

  /** Turns left `running` after a process crash/restart would block the bot's queue forever. */
  reapOrphans(): void {
    const orphans = this.opts.db.all<TurnRow>(
      "SELECT * FROM turns WHERE status = 'running' ORDER BY created_at",
    );
    for (const turn of orphans) {
      if (this.runningBots.has(turn.bot_id)) continue;
      const note =
        "OpenBot restarted before this turn finished. Send the message again if you still need a reply.";
      this.opts.db.run("UPDATE turns SET error = ? WHERE id = ?", [note, turn.id]);
      promote(this.opts.db, turn.id, { kind: "crash", assistantText: note });
      if (turn.harness_session_id) {
        this.opts.db.run(
          "UPDATE harness_sessions SET state = 'ended', ended_at = ? WHERE id = ? AND ended_at IS NULL",
          [now(), turn.harness_session_id],
        );
      }
      const bot = this.opts.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [
        turn.bot_id,
      ]);
      if (bot) {
        this.opts.onPush(bot.account_id, { type: "turn.updated", turnId: turn.id, status: "failed" });
        const msgs = this.opts.db.all<{ origin: string }>(
          "SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at",
          [turn.id],
        );
        for (const m of msgs) {
          if (m.origin === "prompt" || m.origin === "calendar") continue; // per-turn clones, not transcript bubbles
          this.opts.onPush(bot.account_id, { type: "message.created", message: m });
        }
      }
    }
  }

  private async loop(): Promise<void> {
    if (this.looping) {
      this.loopAgain = true;
      await this.startIdleBots();
      return;
    }
    this.looping = true;
    try {
      do {
        this.loopAgain = false;
        await this.startIdleBots();
      } while (this.loopAgain);
    } finally {
      this.looping = false;
    }
  }

  private async startIdleBots(): Promise<void> {
    const idleBots = this.opts.db.all<{ bot_id: string }>(
      `SELECT DISTINCT bot_id FROM turns t
       WHERE status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM turns r
           WHERE r.bot_id = t.bot_id AND r.status = 'running'
         )`,
    );
    const toRun = idleBots.filter((b) => !this.runningBots.has(b.bot_id));
    if (toRun.length === 0) return;
    await Promise.all(
      toRun.map(async (b) => {
        this.runningBots.add(b.bot_id);
        try {
          const turn = this.opts.db.get<TurnRow>(
            "SELECT * FROM turns WHERE bot_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
            [b.bot_id],
          );
          if (turn) await this.runTurn(turn);
        } finally {
          this.runningBots.delete(b.bot_id);
        }
      }),
    );
  }

  private async runTurn(turn: TurnRow): Promise<void> {
    const bot = this.opts.db.get<{
      id: string;
      account_id: string;
      name: string;
      description: string;
      permission_mode: string;
      model: string | null;
      reasoning_effort: string | null;
      role: string | null;
    }>("SELECT * FROM bots WHERE id = ?", [turn.bot_id]);
    if (!bot) return;

    const thread = this.opts.db.get<{ id: string; account_id: string; kind: string; title: string }>(
      "SELECT * FROM threads WHERE id = ?",
      [turn.thread_id],
    );
    if (!thread) return;

    const compute = this.opts.db.get<{ id: string; workspace_path: string }>(
      "SELECT * FROM compute_instances WHERE account_id = ?",
      [bot.account_id],
    );
    const isGateway = bot.role === "gateway";
    const org = currentOrgMeta(this.opts.db);
    const runner = this.runnerFor(bot.account_id);
    runner.permissionMode = (bot.permission_mode as typeof runner.permissionMode) || "auto";
    await runner.ensure(bot.account_id);
    const cwd = isGateway ? runner.ensureGatewayWorkspace() : runner.ensureProject(bot.id, bot.name);

    if (isGateway && !federationEffective(org)) {
      runner.invalidateAcp(bot.id);
      this.opts.db.run("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?", [
        now(),
        turn.id,
      ]);
      this.opts.onPush(bot.account_id, { type: "turn.updated", turnId: turn.id, status: "running" });
      insertMessage(this.opts.db, {
        threadId: turn.thread_id,
        turnId: turn.id,
        role: "system",
        origin: "system",
        body: FEDERATION_OFF_NOTICE,
      });
      // skip promote() empty-turn placeholder; the system line is the reply
      this.opts.db.run("UPDATE turns SET sent_message_count = 1 WHERE id = ?", [turn.id]);
      promote(this.opts.db, turn.id, { kind: "acp_done", stopReason: "end_turn", assistantText: "" });
      this.opts.onPush(bot.account_id, { type: "turn.updated", turnId: turn.id, status: "completed" });
      const msgs = this.opts.db.all<{ origin: string }>(
        "SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at",
        [turn.id],
      );
      for (const m of msgs) {
        if (m.origin === "prompt" || m.origin === "calendar") continue;
        this.opts.onPush(bot.account_id, { type: "message.created", message: m });
      }
      this.maybeKickGatewayDrain(bot.id, turn.id);
      return;
    }

    const cred = this.opts.db.get<{ ciphertext: Uint8Array; dek_wrapped: Uint8Array; key_id: string }>(
      "SELECT ciphertext, dek_wrapped, key_id FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'",
      [bot.account_id],
    );

    const model = bot.model || DEFAULT_GROK_MODEL;
    const reasoningEffort = bot.reasoning_effort || DEFAULT_REASONING_EFFORT;
    const warm = runner.matchesHarness(
      bot.id,
      model,
      reasoningEffort,
      bot.permission_mode as "ask" | "auto" | "always-approve",
    );
    let harnessId = turn.harness_session_id;
    if (!warm) {
      this.opts.db.run(
        "UPDATE harness_sessions SET state = 'ended', ended_at = ? WHERE bot_id = ? AND ended_at IS NULL",
        [now(), bot.id],
      );
      harnessId = id();
      this.opts.db.run(
        `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
        [harnessId, compute?.id ?? bot.account_id, bot.id, now()],
      );
    } else if (!harnessId) {
      const existingHs = this.opts.db.get<{ id: string }>(
        "SELECT id FROM harness_sessions WHERE bot_id = ? AND state = 'active' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [bot.id],
      );
      if (existingHs) harnessId = existingHs.id;
      else {
        harnessId = id();
        this.opts.db.run(
          `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at)
           VALUES (?, ?, ?, 'active', ?)`,
          [harnessId, compute?.id ?? bot.account_id, bot.id, now()],
        );
      }
    }

    const runningAt = now();
    this.opts.db.run(
      "UPDATE turns SET status = 'running', started_at = ?, harness_session_id = ? WHERE id = ?",
      [runningAt, harnessId, turn.id],
    );
    this.opts.db.run(
      `UPDATE calendar_instances SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE turn_id = ? AND status = 'queued'`,
      [runningAt, turn.id],
    );
    if (!warm) {
      appendLiveWork(this.opts.db, turn.id, "harness_session_reset", { reason: "cold_start" });
    }
    this.opts.onPush(bot.account_id, { type: "turn.updated", turnId: turn.id, status: "running" });

    const fakeHarness = Boolean(process.env.OPENBOT_ACP_COMMAND);
    const cliSignedIn = grokCliSignedIn();
    if (!cred && !fakeHarness && !cliSignedIn) {
      insertMessage(this.opts.db, {
        threadId: turn.thread_id,
        turnId: turn.id,
        role: "system",
        origin: "system",
        body: "No Grok login on this machine. Run `grok login` (your SuperGrok/Cursor subscription) or paste an API key in Settings.",
      });
      this.opts.db.run("UPDATE turns SET status = 'running' WHERE id = ?", [turn.id]);
      promote(this.opts.db, turn.id, { kind: "crash", assistantText: "" });
      reconcileCalendarInstance(this.opts.db, turn.id);
      this.opts.onPush(bot.account_id, { type: "turn.updated", turnId: turn.id, status: "failed" });
      if (isGateway) this.maybeKickGatewayDrain(bot.id, turn.id);
      return;
    }

    let apiKey = "";
    if (cred) {
      const envelope: Envelope = {
        ciphertext: Buffer.from(cred.ciphertext),
        dekWrapped: Buffer.from(cred.dek_wrapped),
        keyId: cred.key_id,
        lastFour: "",
      };
      apiKey = open(this.opts.master, envelope);
    }

    let token = "";
    if (!warm) {
      const minted = mintMcpToken();
      token = minted.token;
      persistMcpToken(
        this.opts.db,
        {
          accountId: bot.account_id,
          botId: bot.id,
          threadId: turn.thread_id,
          harnessSessionId: harnessId,
        },
        minted.hash,
      );
    }

    const mcpUrl = `http://127.0.0.1:${this.opts.mcpPort()}/mcp/v1`;
    runner.harnessSessionId = harnessId;

    try {
      await runner.ensureHarness({
        botId: bot.id,
        env: apiKey ? { XAI_API_KEY: apiKey } : {},
        mcpUrl,
        mcpToken: token,
        cwd,
        botName: bot.name,
        botDescription: bot.description,
        permissionMode: bot.permission_mode as "ask" | "auto" | "always-approve",
        model,
        reasoningEffort,
        role: isGateway ? "gateway" : "desk",
        orgId: org?.org_id,
        orgSlug: org?.slug,
        idleTtlMs: isGateway ? gatewayAcpIdleTtlMs() : acpIdleTtlMs(),
        omitCdp: isGateway,
      });
      this.opts.db.run("UPDATE harness_sessions SET acp_session_id = ? WHERE id = ?", [
        runner.acpSessionId ?? null,
        harnessId,
      ]);

      const userMsg = this.opts.db.get<{ origin: string; body: string }>(
        "SELECT origin, body FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
        [turn.id],
      );
      let prompt = userMsg?.body ?? "";
      if (thread.kind === "group") {
        prompt = `Group thread "${thread.title}". To speak here call SendToThread. SendMessage still DMs the human privately. SendToAgent is 1:1, not this group.\n\n${prompt}`;
      }
      if (userMsg?.origin === "calendar") {
        prompt = `${calendarTurnBlock(this.opts.db, turn.id)}\n\n${prompt}`;
      }
      if (!warm) {
        const digest = buildThreadDigest(this.opts.db, {
          threadId: turn.thread_id,
          botId: bot.id,
          botName: bot.name,
          excludeTurnId: turn.id,
        });
        prompt = wrapPromptWithDigest(digest, prompt);
      }
      const result = await runner.prompt(prompt, bot.id);
      markCalendarPendingAsSend(this.opts.db, turn.id);
      promote(this.opts.db, turn.id, {
        kind: "acp_done",
        stopReason: result.stopReason,
        assistantText: result.assistantText,
        telemetrySentMessageCount: 0,
      });
      reconcileCalendarInstance(this.opts.db, turn.id);
    } catch (err) {
      const stderr = runner.acpFor(bot.id)?.lastStderr ?? "";
      const text = (err instanceof Error ? err.message : String(err)) + (stderr ? `\n${stderr.slice(-1500)}` : "");
      this.opts.db.run("UPDATE turns SET error = ? WHERE id = ?", [text, turn.id]);
      this.opts.db.run("UPDATE turns SET status = 'running' WHERE id = ?", [turn.id]);
      markCalendarPendingAsSend(this.opts.db, turn.id);
      promote(this.opts.db, turn.id, { kind: "crash", assistantText: text });
      reconcileCalendarInstance(this.opts.db, turn.id);
    }

    await this.opts.inflight.drain(harnessId, 2000);
    const updated = this.opts.db.get<TurnRow>("SELECT * FROM turns WHERE id = ?", [turn.id]);
    this.opts.onPush(bot.account_id, {
      type: "turn.updated",
      turnId: turn.id,
      status: updated?.status,
    });
    const msgs = this.opts.db.all<{ origin: string }>(
      "SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at",
      [turn.id],
    );
    for (const m of msgs) {
      if (m.origin === "prompt" || m.origin === "calendar") continue;
      this.opts.onPush(bot.account_id, { type: "message.created", message: m });
    }
    if (isGateway) this.maybeKickGatewayDrain(bot.id, turn.id);
  }
}

function calendarTurnBlock(db: OpenbotDb, turnId: string): string {
  const series = db.get<{ title: string; kind: string; rrule: string | null }>(
    `SELECT s.title, s.kind, s.rrule
     FROM calendar_instances i
     JOIN calendar_series s ON s.id = i.series_id
     WHERE i.turn_id = ?
     LIMIT 1`,
    [turnId],
  );
  const title = series?.title ?? "event";
  const kind = series?.kind ?? "schedule";
  const recurring = series?.rrule ? ", recurring" : "";
  return [
    `This turn was started by calendar event "${title}" (${kind}${recurring}).`,
    "Do the work in the prompt. If the human should see a result, call SendMessage.",
    "If this turn is on a group thread, speak there with SendToThread; SendMessage still DMs the human privately.",
    "If you parked a SendMessage as pending_approval, you are done — do not ramble.",
    "Do not announce that you are a cron job. Do not CreateEvent from this turn unless the prompt asks to schedule follow-up.",
  ].join("\n");
}

export function deskPath(home: string): string {
  return join(home, "desk");
}
