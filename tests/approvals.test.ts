import { describe, expect, test } from "bun:test";
import { OpenbotDb } from "@openbot/db";
import { McpInflight, approveMessage, rejectMessage, sendMessage } from "@openbot/mcp-send-message";
import { promote } from "@openbot/live-work";
import { insertTurn, seedWorld, tempHome } from "./helpers.ts";
import { join } from "node:path";

describe("SendMessage approvals", () => {
  test("needs_user parks pending_approval; approve flips to send_message", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    const inflight = new McpInflight();
    const result = sendMessage(db, inflight, `Bearer ${w.token}`, {
      body: "please confirm",
      urgency: "needs_user",
    });
    const parked = db.get<{ origin: string }>("SELECT origin FROM messages WHERE id = ?", [result.messageId]);
    expect(parked?.origin).toBe("pending_approval");
    promote(db, turnId, { kind: "acp_done", assistantText: "leftover" });
    const fallback = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
      [turnId],
    );
    expect(fallback?.n).toBe(0);
    const ok = approveMessage(db, w.accountId, result.messageId);
    expect(ok).toBe(true);
    const after = db.get<{ origin: string }>("SELECT origin FROM messages WHERE id = ?", [result.messageId]);
    expect(after?.origin).toBe("send_message");
  });

  test("reject does not count as send_message", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const inflight = new McpInflight();
    const result = sendMessage(db, inflight, `Bearer ${w.token}`, {
      body: "nope",
      urgency: "needs_user",
    });
    expect(rejectMessage(db, w.accountId, result.messageId)).toBe(true);
    const row = db.get<{ origin: string; body: string }>("SELECT origin, body FROM messages WHERE id = ?", [
      result.messageId,
    ]);
    expect(row?.origin).toBe("system");
    expect(row?.body).toContain("declined");
  });
});
