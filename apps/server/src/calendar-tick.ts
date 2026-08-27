import {
  CAL_CATCHUP_MS,
  CAL_HORIZON_MS,
  CAL_MAX_FIRES_PER_TICK,
  materializeHorizon,
} from "@openbot/calendar";
import { humanThread, id, isGatewayRole, type OpenbotDb } from "@openbot/db";
import { insertMessage } from "@openbot/live-work";

export type TickCalendarResult = {
  enqueued: number;
  dueLeft: number;
  skippedOffline: number;
  skippedCoalesce: number;
};

type SeriesRow = {
  id: string;
  account_id: string;
  title: string;
  prompt: string;
  assignee_bot_id: string | null;
  thread_id: string | null;
  kind: string;
  status: string;
  rrule: string | null;
  dtstart_utc: number;
  timezone: string;
  min_interval_ms: number;
  last_fired_at: number | null;
  next_due_at: number | null;
};

type InstanceRow = {
  id: string;
  series_id: string;
  scheduled_at: number;
  status: string;
  turn_id: string | null;
};

type TurnState = {
  id: string;
  status: string;
  promote_reason: string | null;
  error: string | null;
};

export function tickCalendar(db: OpenbotDb, nowMs: number): TickCalendarResult {
  return db.immediate(() => {
    reconcileFinishedInstances(db, nowMs);
    suppressInactiveSeries(db, nowMs);
    materializeActiveSeries(db, nowMs);

    const stats: TickCalendarResult = {
      enqueued: 0,
      dueLeft: 0,
      skippedOffline: 0,
      skippedCoalesce: 0,
    };
    const candidates: Array<{ series: SeriesRow; instance: InstanceRow }> = [];
    const seriesList = db.all<SeriesRow>(
      `SELECT * FROM calendar_series
        WHERE status = 'active'
          AND (next_due_at IS NULL OR next_due_at <= ?)`,
      [nowMs + CAL_HORIZON_MS],
    );

    for (const series of seriesList) {
      if (!liveDeskAssignee(db, series.assignee_bot_id)) continue;

      const misses = db.all<InstanceRow>(
        `SELECT * FROM calendar_instances
          WHERE series_id = ? AND status IN ('scheduled', 'due') AND scheduled_at <= ?
          ORDER BY scheduled_at ASC, id ASC`,
        [series.id, nowMs],
      );
      if (!misses.length) {
        refreshNextDue(db, series.id, nowMs);
        continue;
      }

      const latest = misses[misses.length - 1]!;
      if (nowMs - latest.scheduled_at >= CAL_CATCHUP_MS) {
        for (const inst of misses) {
          db.run(
            `UPDATE calendar_instances
              SET status = 'skipped_offline', skipped_reason = 'offline', finished_at = ?
              WHERE id = ?`,
            [nowMs, inst.id],
          );
          stats.skippedOffline += 1;
        }
        noticeSkippedOffline(db, series, misses.length);
        refreshNextDue(db, series.id, nowMs);
        continue;
      }

      for (const inst of misses.slice(0, -1)) {
        db.run(
          `UPDATE calendar_instances
            SET status = 'skipped_coalesce', skipped_reason = 'coalesce', finished_at = ?
            WHERE id = ?`,
          [nowMs, inst.id],
        );
        stats.skippedCoalesce += 1;
      }

      if (!series.thread_id) {
        skipNoThread(db, series, latest, nowMs);
        refreshNextDue(db, series.id, nowMs);
        continue;
      }

      const inflight = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM calendar_instances
          WHERE series_id = ? AND status IN ('queued', 'running')`,
        [series.id],
      );
      if ((inflight?.n ?? 0) > 0) {
        db.run(`UPDATE calendar_instances SET status = 'due' WHERE id = ?`, [latest.id]);
        refreshNextDue(db, series.id, nowMs);
        continue;
      }

      candidates.push({ series, instance: latest });
    }

    candidates.sort((a, b) => a.instance.scheduled_at - b.instance.scheduled_at || a.instance.id.localeCompare(b.instance.id));

    for (const cand of candidates) {
      if (stats.enqueued >= CAL_MAX_FIRES_PER_TICK) {
        db.run(`UPDATE calendar_instances SET status = 'due' WHERE id = ?`, [cand.instance.id]);
        refreshNextDue(db, cand.series.id, nowMs);
        continue;
      }
      const series = db.get<SeriesRow>("SELECT * FROM calendar_series WHERE id = ?", [cand.series.id]) ?? cand.series;
      const outcome = enqueueInstance(db, series, cand.instance, nowMs);
      if (outcome === "enqueued") stats.enqueued += 1;
      else if (outcome === "due") {
        db.run(`UPDATE calendar_instances SET status = 'due' WHERE id = ?`, [cand.instance.id]);
      }
      refreshNextDue(db, series.id, nowMs);
    }

    stats.dueLeft =
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM calendar_instances WHERE status = 'due'`)?.n ?? 0;
    return stats;
  });
}

export function markCalendarPendingAsSend(db: OpenbotDb, turnId: string): void {
  const user = db.get<{ origin: string }>(
    "SELECT origin FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    [turnId],
  );
  if (user?.origin !== "calendar") return;
  const pending = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE turn_id = ? AND origin = 'pending_approval'",
    [turnId],
  );
  if ((pending?.n ?? 0) === 0) return;
  db.run("UPDATE turns SET sent_message_count = 1 WHERE id = ? AND sent_message_count = 0", [turnId]);
}

export function reconcileCalendarInstance(db: OpenbotDb, turnId: string, nowMs = Date.now()): void {
  const inst = db.get<InstanceRow>(
    `SELECT * FROM calendar_instances WHERE turn_id = ? AND status IN ('queued', 'running')`,
    [turnId],
  );
  if (!inst) return;
  const turn = db.get<TurnState>("SELECT id, status, promote_reason, error FROM turns WHERE id = ?", [turnId]);
  if (!turn) return;
  const next = instanceStatusFromTurn(turn);
  if (!next) return;
  db.run(`UPDATE calendar_instances SET status = ?, finished_at = ? WHERE id = ?`, [next, nowMs, inst.id]);
}

function reconcileFinishedInstances(db: OpenbotDb, nowMs: number): void {
  const rows = db.all<{ id: string; turn_id: string }>(
    `SELECT id, turn_id FROM calendar_instances
      WHERE status IN ('queued', 'running') AND turn_id IS NOT NULL`,
  );
  for (const row of rows) {
    reconcileCalendarInstance(db, row.turn_id, nowMs);
  }
}

function suppressInactiveSeries(db: OpenbotDb, nowMs: number): void {
  const series = db.all<{ id: string; status: string }>(
    `SELECT DISTINCT s.id, s.status FROM calendar_series s
      JOIN calendar_instances i ON i.series_id = s.id
      WHERE s.status IN ('paused', 'cancelled')
        AND i.status IN ('scheduled', 'due', 'queued')`,
  );
  for (const row of series) {
    suppressOpenInstances(db, row.id, row.status === "paused" ? "pause" : "cancel", nowMs);
    refreshNextDue(db, row.id, nowMs);
  }
}

function suppressOpenInstances(db: OpenbotDb, seriesId: string, mode: "pause" | "cancel", nowMs: number): void {
  if (mode === "pause") {
    db.run(
      `UPDATE calendar_instances SET status = 'skipped_paused' WHERE series_id = ? AND status IN ('scheduled', 'due')`,
      [seriesId],
    );
  } else {
    db.run(
      `UPDATE calendar_instances SET status = 'cancelled', skipped_reason = 'series_cancelled'
        WHERE series_id = ? AND status IN ('scheduled', 'due')`,
      [seriesId],
    );
  }
  const queued = db.all<{ id: string; turn_id: string | null }>(
    `SELECT id, turn_id FROM calendar_instances WHERE series_id = ? AND status = 'queued'`,
    [seriesId],
  );
  for (const inst of queued) {
    if (inst.turn_id) {
      db.run(`UPDATE turns SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`, [
        nowMs,
        inst.turn_id,
      ]);
    }
    db.run(`UPDATE calendar_instances SET status = 'cancelled', skipped_reason = ? WHERE id = ?`, [
      mode === "cancel" ? "series_cancelled" : null,
      inst.id,
    ]);
  }
}

function materializeActiveSeries(db: OpenbotDb, nowMs: number): void {
  const seriesList = db.all<SeriesRow>(
    `SELECT * FROM calendar_series
      WHERE status = 'active'
        AND (next_due_at IS NULL OR next_due_at <= ?)`,
    [nowMs + CAL_HORIZON_MS],
  );
  for (const series of seriesList) {
    if (!liveDeskAssignee(db, series.assignee_bot_id)) continue;
    let times: number[] = [];
    try {
      const horizon = materializeHorizon({
        dtstartUtc: series.dtstart_utc,
        timezone: series.timezone,
        rrule: series.rrule,
        nowMs,
      });
      times = [...(horizon.catchup != null ? [horizon.catchup] : []), ...horizon.future];
    } catch {
      continue;
    }
    const seen = new Set<number>();
    for (const scheduledAt of times) {
      if (seen.has(scheduledAt)) continue;
      seen.add(scheduledAt);
      db.run(
        `INSERT OR IGNORE INTO calendar_instances (id, series_id, scheduled_at, status, created_at)
         VALUES (?, ?, ?, 'scheduled', ?)`,
        [id(), series.id, scheduledAt, nowMs],
      );
    }
    refreshNextDue(db, series.id, nowMs);
  }
}

function enqueueInstance(db: OpenbotDb, series: SeriesRow, inst: InstanceRow, nowMs: number): "enqueued" | "due" | "skipped" {
  if (!series.assignee_bot_id) return "due";
  if (!liveDeskAssignee(db, series.assignee_bot_id)) return "due";
  if (!series.thread_id) {
    skipNoThread(db, series, inst, nowMs);
    return "skipped";
  }
  const queued = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status = 'queued'",
    [series.assignee_bot_id],
  );
  if ((queued?.n ?? 0) >= 5) return "due";
  if (series.last_fired_at != null && nowMs - series.last_fired_at < series.min_interval_ms) return "due";

  const turnId = id();
  db.run(
    `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
     VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
    [turnId, series.thread_id, series.assignee_bot_id, nowMs + 2 * 60 * 60 * 1000, nowMs],
  );
  insertMessage(db, {
    threadId: series.thread_id,
    turnId,
    role: "user",
    origin: "calendar",
    body: series.prompt,
  });
  db.run(
    `UPDATE calendar_instances SET status = 'queued', turn_id = ?, started_at = ? WHERE id = ?`,
    [turnId, nowMs, inst.id],
  );
  db.run(`UPDATE calendar_series SET last_fired_at = ?, updated_at = ? WHERE id = ?`, [nowMs, nowMs, series.id]);
  audit(db, series.account_id, "calendar.fire", {
    seriesId: series.id,
    instanceId: inst.id,
    turnId,
  });
  return "enqueued";
}

function skipNoThread(db: OpenbotDb, series: SeriesRow, inst: InstanceRow, nowMs: number): void {
  db.run(
    `UPDATE calendar_instances
      SET status = 'cancelled', skipped_reason = 'no_thread', finished_at = ?
      WHERE id = ? AND status IN ('scheduled', 'due')`,
    [nowMs, inst.id],
  );
  audit(db, series.account_id, "calendar.skip", {
    seriesId: series.id,
    instanceId: inst.id,
    reason: "no_thread",
  });
}

function liveDeskAssignee(db: OpenbotDb, botId: string | null): boolean {
  if (!botId) return false;
  const bot = db.get<{ status: string; role: string | null }>("SELECT status, role FROM bots WHERE id = ?", [botId]);
  return Boolean(bot && bot.status === "active" && !isGatewayRole(bot.role));
}

function refreshNextDue(db: OpenbotDb, seriesId: string, nowMs: number): void {
  const next = db.get<{ scheduled_at: number }>(
    `SELECT scheduled_at FROM calendar_instances
      WHERE series_id = ? AND status IN ('scheduled', 'due')
      ORDER BY scheduled_at ASC LIMIT 1`,
    [seriesId],
  );
  db.run(`UPDATE calendar_series SET next_due_at = ?, updated_at = ? WHERE id = ?`, [
    next?.scheduled_at ?? null,
    nowMs,
    seriesId,
  ]);
}

function noticeSkippedOffline(db: OpenbotDb, series: SeriesRow, n: number): void {
  if (!series.assignee_bot_id) return;
  const human = humanThread(db, series.assignee_bot_id);
  if (human) {
    insertMessage(db, {
      threadId: human.id,
      turnId: null,
      role: "system",
      origin: "system",
      body: `Calendar missed ${n} runs for ${series.title} while OpenBot was down. They were not replayed.`,
    });
  }
  audit(db, series.account_id, "calendar.skipped_offline", {
    seriesId: series.id,
    n,
    title: series.title.slice(0, 200),
  });
}

function audit(db: OpenbotDb, accountId: string, type: string, payload: Record<string, unknown>): void {
  db.run(
    `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
     VALUES (?, ?, 'engine', ?, ?, ?)`,
    [id(), accountId, type, JSON.stringify(payload), Date.now()],
  );
}

function instanceStatusFromTurn(turn: TurnState): string | null {
  if (turn.status === "queued" || turn.status === "running") return null;
  if (turn.status === "cancelled") return "cancelled";
  if (turn.promote_reason === "crash" || turn.promote_reason === "deadline" || turn.error != null) {
    return "failed";
  }
  if (turn.status === "failed") return "failed";
  if (turn.status === "completed") return "completed";
  return null;
}
