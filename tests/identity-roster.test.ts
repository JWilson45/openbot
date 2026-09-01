import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  clipRosterDesc,
  composeIdentityRules,
  deskIdentityRules,
  formatRosterBlock,
  gatewayIdentityRules,
  ROSTER_BLOCK_MAX,
  ROSTER_DESC_MAX,
  rosterFingerprint,
} from "@openbot/acp-grok";
import type { EnsureHarnessRequest } from "@openbot/compute-protocol";
import { OpenbotDb } from "@openbot/db";
import {
  handleMcpJsonRpc,
  LIST_BOTS_TOOL,
  loadOverlayRoster,
  mcpToolsForRole,
  McpInflight,
  SEND_TO_AGENT_TOOL,
} from "@openbot/mcp-send-message";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { fakeAgentCommand, insertTurn, seedWorld, tempHome } from "./helpers.ts";

const ADA_BOB_GATEWAY = {
  desks: [
    { name: "Ada", description: "research" },
    { name: "Bob", description: "writer" },
  ],
  gateway: { name: "Gateway", description: "Diplomat for this org. Not a desk coder." },
};

function harnessReq(partial: Partial<EnsureHarnessRequest> = {}): EnsureHarnessRequest {
  return {
    botId: "bot",
    env: {},
    mcpUrl: "http://127.0.0.1/mcp/v1",
    mcpToken: "tok",
    cwd: "/",
    botName: "Ada",
    botDescription: "research",
    permissionMode: "auto",
    roster: ADA_BOB_GATEWAY,
    ...partial,
  };
}

async function waitCompletedTurns(
  db: { get: (sql: string, params: unknown[]) => { n: number } | null },
  botId: string,
  n: number,
  timeout = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const row = db.get("SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'", [botId]);
    if ((row?.n ?? 0) >= n) return;
    await Bun.sleep(40);
  }
  throw new Error(`timeout waiting for ${n} completed turns`);
}

async function waitMessages(
  origin: string,
  headers: Record<string, string>,
  pred: (messages: Array<{ origin: string; body: string }>) => boolean,
  timeout = 20_000,
): Promise<Array<{ origin: string; body: string }>> {
  const start = Date.now();
  let messages: Array<{ origin: string; body: string }> = [];
  while (Date.now() - start < timeout) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    messages = t.messages ?? [];
    if (pred(messages)) return messages;
    await Bun.sleep(80);
  }
  return messages;
}

function sendBodies(messages: Array<{ origin: string; body: string }>): string[] {
  return messages.filter((m) => m.origin === "send_message").map((m) => m.body);
}

describe("formatRosterBlock", () => {
  test("Ada/Bob/Gateway fixture is frozen (em dash, header, Gateway last)", () => {
    expect(formatRosterBlock(ADA_BOB_GATEWAY)).toBe(
      [
        "Who is here (do not invent names; SendToAgent only these):",
        "- Ada — research",
        "- Bob — writer",
        "- Gateway — Diplomat for this org. Not a desk coder.",
      ].join("\n"),
    );
    expect(rosterFingerprint(ADA_BOB_GATEWAY)).toBe(formatRosterBlock(ADA_BOB_GATEWAY));
  });

  test("clip 160, slice 6, empty is empty string", () => {
    const long = "x".repeat(200);
    const clipped = clipRosterDesc(long);
    expect(clipped.length).toBe(ROSTER_DESC_MAX);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipRosterDesc("  short\nrole  ")).toBe("short role");

    const desks = Array.from({ length: 8 }, (_, i) => ({ name: `B${i}`, description: "d" }));
    const sliced = formatRosterBlock({ desks, gateway: null });
    expect(sliced).toContain("- B0 — d");
    expect(sliced).toContain("- B5 — d");
    expect(sliced).not.toContain("- B6");
    expect(sliced).not.toContain("- B7");

    expect(formatRosterBlock(undefined)).toBe("");
    expect(formatRosterBlock({ desks: [] })).toBe("");
    expect(formatRosterBlock({ desks: [], gateway: null })).toBe("");
  });

  test("6x160-char desks plus Gateway degrade to names-only without end-slice", () => {
    const desc = "d".repeat(160);
    const names = ["Ada", "Bob", "Cara", "Dana", "Eve", "Fay"];
    const block = formatRosterBlock({
      desks: names.map((name) => ({ name, description: desc })),
      gateway: { name: "Gateway", description: desc },
    });
    const withDescLen =
      "Who is here (do not invent names; SendToAgent only these):\n".length +
      names.reduce((n, name) => n + `- ${name} — ${desc}\n`.length, 0) +
      `- Gateway — ${desc}`.length;
    expect(withDescLen).toBeGreaterThan(ROSTER_BLOCK_MAX);
    expect(block.length).toBeLessThanOrEqual(ROSTER_BLOCK_MAX);
    expect(block).not.toContain(" — ");
    for (const name of names) expect(block).toContain(`- ${name}`);
    expect(block).toContain("- Gateway");
    expect(block.startsWith("Who is here (do not invent names; SendToAgent only these):")).toBe(true);
    expect(block.trimEnd().endsWith("- Gateway")).toBe(true);
  });
});

describe("composeIdentityRules", () => {
  test("desk overlay lists Bob/Gateway, compose sentence, no ListBots call", () => {
    const rules = composeIdentityRules(harnessReq());
    expect(rules).toContain("- Bob — writer");
    expect(rules).toContain("- Gateway — Diplomat for this org. Not a desk coder.");
    expect(rules).toMatch(/do not forward/i);
    expect(rules).not.toMatch(/call ListBots/i);
    expect(rules).not.toContain("See who is here: ListBots");
    expect(deskIdentityRules("Ada", "research")).not.toMatch(/ListBots/);
  });

  test("Gateway overlay stays distinct and still gets the roster", () => {
    const gw = composeIdentityRules(
      harnessReq({ role: "gateway", orgSlug: "alpha", orgId: "org-id", botName: "Gateway" }),
    );
    expect(gw).toContain("You are Gateway for org alpha (org-id)");
    expect(gw).toContain("You are not a desk coder");
    expect(gw).toContain("SendToOrg");
    expect(gw).toContain("hop=1");
    expect(gw).toContain("- Ada — research");
    expect(gw).toMatch(/do not forward/i);
    expect(gw).not.toMatch(/Hire a new teammate: CreateBot/);
    expect(gw).not.toMatch(/call ListBots/i);
    expect(gatewayIdentityRules("alpha", "org-id")).not.toMatch(/ListBots/);
  });
});

describe("loadOverlayRoster / MCP copy", () => {
  test("SQL matches listBots order; Gateway last; no ids", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const t = Date.now();
    db.run(
      `INSERT INTO bots (id, account_id, name, description, status, permission_mode, role, created_at)
       VALUES (?, ?, 'Gateway', 'Diplomat for this org. Not a desk coder.', 'active', 'auto', 'gateway', ?)`,
      ["gw1", w.accountId, t - 1000],
    );
    db.run(
      `INSERT INTO bots (id, account_id, name, description, status, permission_mode, role, created_at)
       VALUES (?, ?, 'Bob', 'writer', 'active', 'auto', 'desk', ?)`,
      ["bob1", w.accountId, t],
    );
    const roster = loadOverlayRoster(db, w.accountId);
    expect(roster.desks.map((b) => b.name)).toEqual(["Ada", "Bob"]);
    expect(roster.gateway).toEqual({
      name: "Gateway",
      description: "Diplomat for this org. Not a desk coder.",
    });
    expect(JSON.stringify(roster)).not.toContain("gw1");
    expect(JSON.stringify(roster)).not.toContain(w.botId);
    db.close();
  });

  test("404 still CreateBot + /auth/local; tools/list still has ListBots", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const inflight = new McpInflight();
    const missing = await handleMcpJsonRpc(db, inflight, `Bearer ${w.token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "SendToAgent", arguments: { name: "Ghost", body: "hi" } },
    });
    const err = (missing.json as { error?: { message?: string; data?: { code?: string } } }).error;
    expect(missing.status).toBe(404);
    expect(err?.data?.code).toBe("not_found");
    expect(err?.message).toContain("CreateBot");
    expect(err?.message).toContain("/auth/local");
    expect(err?.message).not.toMatch(/ListBots/i);
    expect(mcpToolsForRole("desk").map((t) => (t as { name: string }).name)).toContain("ListBots");
    expect(mcpToolsForRole("gateway").map((t) => (t as { name: string }).name)).toContain("ListBots");
    expect(LIST_BOTS_TOOL.description).not.toMatch(/Use this before SendToAgent/i);
    expect(SEND_TO_AGENT_TOOL.description).toMatch(/do not forward/i);
    expect(SEND_TO_AGENT_TOOL.description).not.toMatch(/ListBots/i);
    db.close();
  });
});

describe("roster overlay on session/new", () => {
  test("echo-roster lists Ada/Bob/Gateway and compose sentence is present", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Bob", description: "writer" }),
      });
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-rosterkey0001" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-roster]] [[echo-compose]] [[echo-rules]]" }),
      });
      const messages = await waitMessages(origin, headers, (msgs) => {
        const bodies = sendBodies(msgs);
        return (
          bodies.some((b) => b.includes("Ada") && b.includes("Bob") && b.includes("Gateway") && b.includes("got-rules")) &&
          bodies.some((b) => b === "got-compose") &&
          bodies.some((b) => b.includes("Who is here"))
        );
      });
      const bodies = sendBodies(messages);
      const rosterEcho = bodies.find((b) => b.includes("got-rules")) ?? "";
      expect(rosterEcho).toContain("Ada");
      expect(rosterEcho).toContain("Bob");
      expect(rosterEcho).toContain("Gateway");
      expect(bodies).toContain("got-compose");
      const rulesEcho = bodies.find((b) => b.includes("Who is here")) ?? "";
      expect(rulesEcho).toMatch(/do not forward/i);
      expect(rulesEcho).not.toMatch(/call ListBots/i);
      expect(rulesEcho).toContain("You are Ada");
      expect(rulesEcho).not.toContain("You are Gateway for org");
    } finally {
      server.stop(true);
    }
  });

  test("fingerprint miss respawns that bot with a new pid and a full roster echo", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-rosterkey0002" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const runner = ctx.engine.runnerFor(session.accountId);
      const pid1 = runner.acpPid(ada.bot.id);
      expect(pid1).toBeTruthy();

      await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Bob", description: "writer" }),
      });
      expect(runner.acpPid(ada.bot.id)).toBe(pid1);

      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-roster]]" }),
      });
      const messages = await waitMessages(origin, headers, (msgs) =>
        sendBodies(msgs).some((b) => b.includes("Bob") && b.includes("Gateway") && b.includes("got-rules")),
      );
      const rosterEcho = sendBodies(messages).find((b) => b.includes("got-rules")) ?? "";
      expect(rosterEcho).toContain("Ada");
      expect(rosterEcho).toContain("Bob");
      expect(rosterEcho).toContain("Gateway");
      expect(runner.acpPid(ada.bot.id)).toBeTruthy();
      expect(runner.acpPid(ada.bot.id)).not.toBe(pid1);
    } finally {
      server.stop(true);
    }
  });

  test("idle then hire Fay skips resume and echo lists Fay", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-rosterkey0003" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Fay", description: "ops" }),
      });

      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-roster]] [[echo-prompt]]" }),
      });
      expect(posted.status).toBe(202);
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitMessages(origin, headers, (msgs) => {
        const bodies = sendBodies(msgs);
        return bodies.some((b) => b.includes("Fay") && b.includes("got-rules")) && bodies.includes("got-digest");
      });
      const bodies = sendBodies(messages);
      expect(bodies.some((b) => b.includes("Fay") && b.includes("Ada") && b.includes("Gateway"))).toBe(true);
      expect(bodies).toContain("got-digest");
      expect(bodies).not.toContain("no-digest");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      const reset = live.events.filter((e) => e.kind === "harness_session_reset");
      expect(reset.some((e) => e.payload?.reason === "cold_start")).toBe(true);
      expect(reset.some((e) => e.payload?.reason === "resumed")).toBe(false);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
    }
  });

  test("two consecutive idle+fake-resume on an unchanged roster are both no-digest", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-rosterkey0004" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const fp = ctx.db.get<{ roster_fingerprint: string | null }>(
        "SELECT roster_fingerprint FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(fp?.roster_fingerprint).toBeTruthy();

      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      const first = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId: turn1 } = (await first.json()) as { turnId: string };
      await waitMessages(origin, headers, (msgs) => sendBodies(msgs).includes("no-digest"));
      await waitCompletedTurns(ctx.db, ada.bot.id, 2);
      const live1 = (await fetch(`${origin}/v1/turns/${turn1}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live1.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        true,
      );

      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      const second = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId: turn2 } = (await second.json()) as { turnId: string };
      const messages = await waitMessages(
        origin,
        headers,
        (msgs) => sendBodies(msgs).filter((b) => b === "no-digest").length >= 2,
      );
      expect(sendBodies(messages).filter((b) => b === "got-digest")).toHaveLength(0);
      const live2 = (await fetch(`${origin}/v1/turns/${turn2}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live2.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        true,
      );
      expect(live2.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "cold_start")).toBe(
        false,
      );
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
    }
  });

  test("invalidateAcp skips Ada while inTurn and still kills idle Bob", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const bob = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Bob", description: "writer" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-rosterkey0005" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:ada-ready]]" }),
      });
      await fetch(`${origin}/v1/threads/${bob.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:bob-ready]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      await waitCompletedTurns(ctx.db, bob.bot.id, 1);
      const runner = ctx.engine.runnerFor(session.accountId);
      const adaPid = runner.acpPid(ada.bot.id);
      const bobPid = runner.acpPid(bob.bot.id);
      expect(adaPid).toBeTruthy();
      expect(bobPid).toBeTruthy();

      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:4000]] [[send:ada-woke]]" }),
      });
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const t = ctx.db.get<{ status: string }>(
          "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
          [ada.bot.id],
        );
        if (t?.status === "running") break;
        await Bun.sleep(40);
      }
      await Bun.sleep(150);
      runner.invalidateAcp(ada.bot.id);
      expect(runner.acpPid(ada.bot.id)).toBe(adaPid);
      runner.invalidateAcp(bob.bot.id);
      expect(runner.acpPid(bob.bot.id)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

