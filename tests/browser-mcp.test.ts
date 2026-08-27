import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb } from "@openbot/db";
import { handleMcpJsonRpc, McpInflight } from "@openbot/mcp-send-message";
import { fakeAgentCommand, insertTurn, seedWorld, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

function rpc(json: unknown): {
  result?: { content?: Array<{ text?: string }> };
  error?: { message?: string; data?: { code?: string } };
} {
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
  hooks?: {
    browserNavigate?: (
      accountId: string,
      botId: string,
      url: string,
    ) => Promise<{ ok: boolean; title?: string; error?: string }>;
    browserSnapshot?: (accountId: string, botId: string) => Promise<{
      ok: boolean;
      url?: string;
      title?: string;
      text?: string;
      error?: string;
    }>;
    browserClick?: (
      accountId: string,
      botId: string,
      input: { text?: string; selector?: string; nth?: number },
    ) => Promise<{ ok: boolean; text?: string; error?: string }>;
    browserType?: (
      accountId: string,
      botId: string,
      input: { text: string; clear?: boolean; submit?: boolean },
    ) => Promise<{ ok: boolean; error?: string }>;
    browserWait?: (accountId: string, botId: string, ms: number) => Promise<{ ok: boolean; ms?: number }>;
  },
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

describe("desk browser MCP", () => {
  test("Navigate and BrowserSnapshot are desk-only, need a running turn, and hit hooks", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);

    const idle = await call(db, w.token, "Navigate", { url: "https://example.com" });
    expect(idle.status).toBe(409);
    expect(rpc(idle.json).error?.data?.code).toBe("no_active_turn");

    insertTurn(db, w, "running");

    const missing = await call(db, w.token, "Navigate", { url: "https://example.com/" });
    expect(missing.status).toBe(200);
    expect(payload(missing.json)).toEqual({ ok: false, error: "browser_unavailable" });

    const bad = await call(db, w.token, "Navigate", { url: "javascript:alert(1)" });
    expect(payload(bad.json)).toEqual({ ok: false, error: "invalid_url" });
    const fileUrl = await call(db, w.token, "Navigate", { url: "file:///etc/passwd" });
    expect(payload(fileUrl.json)).toEqual({ ok: false, error: "invalid_url" });

    const seen: string[] = [];
    const nav = await call(
      db,
      w.token,
      "Navigate",
      { url: "https://example.com/desk" },
      {
        browserNavigate: async (accountId, _botId, url) => {
          seen.push(`${accountId}:${url}`);
          return { ok: true, title: "Example" };
        },
      },
    );
    expect(payload(nav.json)).toEqual({ ok: true, title: "Example" });
    expect(seen).toEqual([`${w.accountId}:https://example.com/desk`]);

    const snap = await call(
      db,
      w.token,
      "BrowserSnapshot",
      {},
      {
        browserSnapshot: async (accountId, _botId) => ({
          ok: true,
          url: "https://example.com/desk",
          title: "Example",
          text: `seen:${accountId}`,
        }),
      },
    );
    expect(payload(snap.json)).toMatchObject({
      ok: true,
      url: "https://example.com/desk",
      title: "Example",
      text: `seen:${w.accountId}`,
    });

    const noTarget = await call(db, w.token, "Click", {});
    expect(noTarget.status).toBe(400);

    const clicked = await call(
      db,
      w.token,
      "Click",
      { text: "Add to Cart" },
      { browserClick: async (accountId, _botId, input) => ({ ok: true, text: `${accountId}:${input.text}` }) },
    );
    expect(payload(clicked.json)).toEqual({ ok: true, text: `${w.accountId}:Add to Cart` });

    const typed = await call(
      db,
      w.token,
      "Type",
      { text: "hello", clear: true },
      { browserType: async () => ({ ok: true }) },
    );
    expect(payload(typed.json)).toEqual({ ok: true });

    const waited = await call(
      db,
      w.token,
      "Wait",
      { ms: 0 },
      { browserWait: async (_id, _botId, ms) => ({ ok: true, ms }) },
    );
    expect(payload(waited.json)).toEqual({ ok: true, ms: 0 });

    db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
    const gwNav = await call(db, w.token, "Navigate", { url: "https://example.com" });
    expect(gwNav.status).toBe(403);
    const gwSnap = await call(db, w.token, "BrowserSnapshot", {});
    expect(gwSnap.status).toBe(403);
    const gwClick = await call(db, w.token, "Click", { text: "x" });
    expect(gwClick.status).toBe(403);
    const gwType = await call(db, w.token, "Type", { text: "x" });
    expect(gwType.status).toBe(403);
    db.close();
  });

  test("desk turn Navigate + BrowserSnapshot reach the shared Chromium", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie, session } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", description: "research" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-browser0001" }),
    });

    const runner = ctx.engine.runnerFor(session.accountId);
    let chromeError: string | undefined;
    try {
      await runner.ensureBrowser();
    } catch (err) {
      chromeError = String(err);
    }

    const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: `[[nav:${origin}/]] [[snap]]` }),
    });
    expect(posted.status).toBe(202);

    const start = Date.now();
    let bodies: string[] = [];
    while (Date.now() - start < 20_000) {
      const t = (await fetch(`${origin}/v1/threads?botId=${ada.bot.id}`, { headers }).then((r) => r.json())) as {
        messages: Array<{ origin: string; body: string }>;
      };
      bodies = (t.messages || []).filter((m) => m.origin === "send_message").map((m) => m.body);
      if (bodies.some((b) => b.includes("ok"))) break;
      await Bun.sleep(80);
    }

    expect(bodies.some((b) => b.includes('"ok":true') || b.includes('"ok":false'))).toBe(true);
    if (!chromeError) {
      expect(bodies.some((b) => b.includes('"ok":true'))).toBe(true);
      expect(bodies.some((b) => /OpenBot/i.test(b))).toBe(true);
    }

    server.stop(true);
    runner.stopBrowser();
  }, 30_000);
});
