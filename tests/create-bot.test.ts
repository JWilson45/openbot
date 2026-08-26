import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb, MAX_ACTIVE_BOTS } from "@openbot/db";
import { handleMcpJsonRpc, McpInflight } from "@openbot/mcp-send-message";
import { insertTurn, seedWorld, tempHome } from "./helpers.ts";

function rpc(json: unknown): { result?: { content?: Array<{ text?: string }> }; error?: { message?: string; data?: { code?: string } } } {
  return json as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string; data?: { code?: string } };
  };
}

function payload(json: unknown): Record<string, unknown> {
  const text = rpc(json).result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function call(
  db: OpenbotDb,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  hooks?: { onCreateBot?: (b: { botId: string; name: string; accountId: string }) => void },
) {
  const inflight = new McpInflight();
  return handleMcpJsonRpc(
    db,
    inflight,
    `Bearer ${token}`,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    hooks,
  );
}

describe("CreateBot / ListBots", () => {
  test("desk bot hires ONE, lists it, then SendToAgent works", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const hired: string[] = [];
    const created = await call(db, w.token, "CreateBot", { name: "ONE", description: "does the work" }, {
      onCreateBot: (b) => {
        hired.push(b.name);
      },
    });
    expect(created.status).toBe(200);
    const body = payload(created.json);
    expect(body.ok).toBe(true);
    expect(body.name).toBe("ONE");
    expect(body.remainingDeskSlots).toBe(MAX_ACTIVE_BOTS - 2);
    expect(hired).toEqual(["ONE"]);

    const listed = await call(db, w.token, "ListBots");
    const roster = payload(listed.json) as {
      bots: Array<{ name: string }>;
      gateway: { name: string } | null;
    };
    expect(roster.bots.map((b) => b.name).sort()).toEqual(["Ada", "ONE"]);
    expect(roster.gateway).toBeNull();

    const handoff = await call(db, w.token, "SendToAgent", { name: "ONE", body: "do the thing" });
    expect(handoff.status).toBe(200);
    expect(payload(handoff.json).ok).toBe(true);
    db.close();
  });

  test("CreateBot is desk-only, reserved Gateway name, duplicate, cap, and SendToAgent 404 points at CreateBot", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");

    const reserved = await call(db, w.token, "CreateBot", { name: "Gateway" });
    expect(reserved.status).toBe(409);
    expect(rpc(reserved.json).error?.data?.code).toBe("reserved_name");

    const dup = await call(db, w.token, "CreateBot", { name: "Ada" });
    expect(dup.status).toBe(409);
    expect(rpc(dup.json).error?.data?.code).toBe("duplicate_name");

    const missing = await call(db, w.token, "SendToAgent", { name: "Ghost", body: "hi" });
    expect(missing.status).toBe(404);
    expect(rpc(missing.json).error?.data?.code).toBe("not_found");
    expect(rpc(missing.json).error?.message).toContain("CreateBot");
    expect(rpc(missing.json).error?.message).toContain("/auth/local");

    for (const name of ["B", "C", "D", "E", "F"]) {
      const r = await call(db, w.token, "CreateBot", { name });
      expect(r.status).toBe(200);
    }
    const cap = await call(db, w.token, "CreateBot", { name: "G" });
    expect(cap.status).toBe(409);
    expect(rpc(cap.json).error?.data?.code).toBe("cap");

    db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
    const asGw = await call(db, w.token, "CreateBot", { name: "HireMe" });
    expect(asGw.status).toBe(403);
    expect(rpc(asGw.json).error?.data?.code).toBe("forbidden");
    db.close();
  });
});
