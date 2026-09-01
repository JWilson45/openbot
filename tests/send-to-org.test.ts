import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deskIdentityRules, gatewayIdentityRules } from "@openbot/acp-grok";
import { id, now, OpenbotDb, type OrgInboxRow } from "@openbot/db";
import { generateEd25519, signFedJws } from "@openbot/federation";
import { insertMessage } from "@openbot/live-work";
import { loadOrCreateMasterKey } from "@openbot/vault";
import {
  handleMcpJsonRpc,
  inbox,
  McpInflight,
  mcpToolsForRole,
  sendToOrg,
} from "@openbot/mcp-send-message";
import { loadOrgKeypair } from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { fakeAgentCommand, insertTurn, seedWorld, tempHome } from "./helpers.ts";

type OrgHome = {
  home: string;
  origin: string;
  cookie: string;
  orgId: string;
  slug: string;
  pubkey: string;
  privateKey: ReturnType<typeof loadOrgKeypair>["privateKey"];
  ctx: ReturnType<typeof startTestServer>["ctx"];
  server: ReturnType<typeof startTestServer>["server"];
  headers: { cookie: string; "content-type": string };
  gwId: string;
};

async function bootOrg(slug: string, opts?: { federationOn?: boolean }): Promise<OrgHome> {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  process.env.OPENBOT_FED_ALLOW_HTTP = "1";
  const home = tempHome();
  const created = startTestServer({
    home,
    env: { OPENBOT_ORG_SLUG: slug, OPENBOT_ORG_NAME: slug },
  });
  const { cookie } = loginCookie({ ctx: created.ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  if (opts?.federationOn !== false) {
    const on = await fetch(`${created.origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ federationEnabled: true }),
    });
    expect(on.status).toBe(200);
  }
  const info = (await fetch(`${created.origin}/fed/v1/info`).then((r) => r.json())) as {
    orgId: string;
    slug: string;
    pubkey: string;
  };
  const listed = (await fetch(`${created.origin}/v1/bots`, { headers }).then((r) => r.json())) as {
    gateway: { id: string } | null;
  };
  const key = loadOrgKeypair(home, loadOrCreateMasterKey(home));
  return {
    home,
    origin: created.origin,
    cookie,
    orgId: info.orgId,
    slug: info.slug,
    pubkey: info.pubkey,
    privateKey: key.privateKey,
    ctx: created.ctx,
    server: created.server,
    headers,
    gwId: listed.gateway?.id ?? "",
  };
}

async function addPeer(from: OrgHome, to: OrgHome) {
  const res = await fetch(`${from.origin}/v1/org/peers`, {
    method: "POST",
    headers: from.headers,
    body: JSON.stringify({
      slug: to.slug,
      orgId: to.orgId,
      baseUrl: to.origin,
      pubkey: to.pubkey,
      name: to.slug,
    }),
  });
  expect(res.status).toBe(200);
}

function envelope(from: OrgHome, to: OrgHome, extra?: Record<string, unknown>) {
  const msgId = typeof extra?.id === "string" ? extra.id : id();
  return {
    id: msgId,
    fromOrg: from.orgId,
    fromSlug: from.slug,
    fromActor: { type: "gateway" as const, name: "Gateway" },
    toOrg: to.orgId,
    urgency: "normal",
    hop: 1,
    createdAt: Date.now(),
    body: "hello from peer",
    ...extra,
    id: msgId,
  };
}

async function postFed(
  from: { orgId: string; privateKey: OrgHome["privateKey"] },
  toOrigin: string,
  body: Record<string, unknown>,
) {
  const raw = JSON.stringify(body);
  const msgId = String(body.id);
  const token = signFedJws({
    privateKey: from.privateKey,
    fromOrgId: from.orgId,
    toOrgId: String(body.toOrg),
    messageId: msgId,
    rawBody: raw,
  });
  return fetch(`${toOrigin}/fed/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": msgId,
    },
    body: raw,
  });
}

async function waitTurns(
  db: OrgHome["ctx"]["db"],
  botId: string,
  pred: (turns: Array<{ id: string; status: string }>) => boolean,
  ms = 15_000,
) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const turns = db.all<{ id: string; status: string }>(
      "SELECT id, status FROM turns WHERE bot_id = ? ORDER BY created_at ASC, id ASC",
      [botId],
    );
    if (pred(turns)) return turns;
    await Bun.sleep(40);
  }
  throw new Error("timeout waiting for turns");
}

async function waitInbox(
  db: OrgHome["ctx"]["db"],
  pred: (rows: OrgInboxRow[]) => boolean,
  ms = 15_000,
) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = db.all<OrgInboxRow>("SELECT * FROM org_inbox ORDER BY created_at ASC, id ASC");
    if (pred(rows)) return rows;
    await Bun.sleep(40);
  }
  throw new Error("timeout waiting for inbox");
}

async function waitOrigin(
  origin: string,
  headers: Record<string, string>,
  botId: string,
  pred: (m: { origin: string; body: string }) => boolean,
) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads?botId=${botId}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    if ((t.messages || []).some(pred)) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("timeout waiting for origin");
}

function seedGatewayOrg(db: OpenbotDb, w: ReturnType<typeof seedWorld>, opts?: { federation?: boolean }) {
  db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
  const orgId = id();
  db.run(
    `INSERT INTO org_meta (id, account_id, org_id, slug, name, public_origin, pubkey, federation_enabled, created_at)
     VALUES ('current', ?, ?, 'alpha', 'alpha', 'http://127.0.0.1:1', '', ?, ?)`,
    [w.accountId, orgId, opts?.federation === false ? 0 : 1, now()],
  );
  return orgId;
}

function insertPeer(
  db: OpenbotDb,
  slug: string,
  peerOrgId: string,
  baseUrl = "http://127.0.0.1:9",
) {
  const kp = generateEd25519();
  db.run(
    `INSERT INTO org_peers (id, peer_org_id, slug, name, base_url, pubkey, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'allowed', ?)`,
    [id(), peerOrgId, slug, slug, baseUrl, kp.publicKeyRawB64, now()],
  );
  return kp;
}

function rpcError(json: unknown): string | undefined {
  const err = (json as { error?: { data?: { code?: string } } }).error;
  return err?.data?.code;
}

describe("SendToOrg / Inbox overlays and MCP", () => {
  test("identity overlays mention SendToOrg only for Gateway", () => {
    const gw = gatewayIdentityRules("alpha", "org-id");
    expect(gw).toContain("SendToOrg");
    expect(gw).toContain("hop=1");
    expect(gw).toContain("Inbox");
    expect(gw).toContain("Do not forward inbound mail to a third org");
    const desk = deskIdentityRules("Ada", "research");
    expect(desk).not.toMatch(/To talk to another org, call SendToOrg/);
    expect(desk).toContain("Do not schedule SendToOrg");
    expect(desk).toContain("SendToAgent Gateway");
    expect(desk).toContain("CreateBot");
    expect(desk).toContain("/auth/local");
    expect(desk).toContain("Time:");
    expect(desk).toContain("ListCalendar");
    expect(desk).toContain("ConfirmSeries");
    expect(desk).toContain("Navigate");
    expect(desk).toContain("BrowserSnapshot");
    expect(desk).toContain("Click");
    expect(desk).toContain("Type");
    expect(desk).toContain("Wait");
    expect(desk).toContain("own tab");
    expect(desk).toContain("confirm-series");
    expect(desk).toContain("shared-chromium");
    expect(gw).not.toContain("Skills (names only");
    expect(gw).not.toContain("confirm-series");
    expect(gw).toMatch(/do not follow desk\/skills/i);
    expect(gw).not.toContain("ListCalendar");
    expect(gw).not.toContain("CreateEvent");
    expect(gw).not.toContain("BrowserSnapshot");
    expect(gw).toContain("You do not hire desk bots");
    expect(gw).not.toMatch(/Hire a new teammate: CreateBot/);
  });

  test("tools/list is role-aware; serverInfo is 0.6.0", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const inflight = new McpInflight();
    const deskList = await handleMcpJsonRpc(db, inflight, `Bearer ${w.token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const deskNames = (
      (deskList.json as { result: { tools: Array<{ name: string }> } }).result.tools ?? []
    ).map((t) => t.name);
    expect(deskNames).toEqual([
      "SendMessage",
      "SendToAgent",
      "SendToThread",
      "ListBots",
      "Memory",
      "SearchMessages",
      "SearchThreads",
      "CreateBot",
      "ListCalendar",
      "CreateEvent",
      "ProposeRoutine",
      "ConfirmSeries",
      "PauseSeries",
      "Navigate",
      "BrowserSnapshot",
      "Click",
      "Type",
      "Wait",
    ]);
    expect(deskNames).not.toContain("ListSkills");
    expect(mcpToolsForRole("desk").map((t) => (t as { name: string }).name)).toEqual([
      "SendMessage",
      "SendToAgent",
      "SendToThread",
      "ListBots",
      "Memory",
      "SearchMessages",
      "SearchThreads",
      "CreateBot",
      "ListCalendar",
      "CreateEvent",
      "ProposeRoutine",
      "ConfirmSeries",
      "PauseSeries",
      "Navigate",
      "BrowserSnapshot",
      "Click",
      "Type",
      "Wait",
    ]);

    db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
    const gwList = await handleMcpJsonRpc(db, inflight, `Bearer ${w.token}`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const gwNames = (
      (gwList.json as { result: { tools: Array<{ name: string }> } }).result.tools ?? []
    ).map((t) => t.name);
    expect(gwNames).toEqual([
      "SendMessage",
      "SendToAgent",
      "SendToThread",
      "ListBots",
      "Memory",
      "SearchMessages",
      "SearchThreads",
      "SendToOrg",
      "Inbox",
    ]);

    const init = await handleMcpJsonRpc(db, inflight, undefined, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(
      (init.json as { result: { serverInfo: { version: string } } }).result.serverInfo.version,
    ).toBe("0.6.0");
    db.close();
  });

  test("desk SendToOrg is forbidden; Inbox 409 without a running turn", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    seedGatewayOrg(db, w);
    db.run("UPDATE bots SET role = 'desk' WHERE id = ?", [w.botId]);
    insertTurn(db, w, "running");
    insertPeer(db, "beta", id());
    const inflight = new McpInflight();
    const forbidden = await handleMcpJsonRpc(
      db,
      inflight,
      `Bearer ${w.token}`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "SendToOrg", arguments: { org: "beta", body: "nope" } },
      },
      { orgPrivateKey: () => generateEd25519().privateKey, fetchFed: (async () => new Response("no", { status: 500 })) as typeof fetch },
    );
    expect(forbidden.status).toBe(403);
    expect(rpcError(forbidden.json)).toBe("forbidden");

    db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
    db.run("UPDATE turns SET status = 'completed'");
    expect(() => inbox(db, inflight, `Bearer ${w.token}`, { limit: 5 })).toThrow(/no running turn/);
    db.close();
  });

  test("SendToOrg federation_off; unique slug and uuid lookup; hop is always 1", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    seedGatewayOrg(db, w, { federation: false });
    const offTurn = insertTurn(db, w, "running");
    insertMessage(db, {
      threadId: w.threadId,
      turnId: offTurn,
      role: "user",
      origin: "user",
      body: "hello",
    });
    const inflight = new McpInflight();
    const key = generateEd25519();
    const posts: Array<{ url: string; body: string }> = [];
    const hooks = {
      orgPrivateKey: () => key.privateKey,
      fetchFed: (async (url: string | URL | Request, init?: RequestInit) => {
        posts.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ queued: true }), { status: 202 });
      }) as typeof fetch,
    };
    await expect(sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "beta", body: "x" }, hooks)).rejects.toMatchObject(
      { code: "federation_off" },
    );
    expect(posts.length).toBe(0);

    db.run("UPDATE org_meta SET federation_enabled = 1 WHERE id = 'current'");
    const betaId = id();
    insertPeer(db, "beta", betaId, "http://127.0.0.1:19");
    const bySlug = await sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "beta", body: "slug-hi" }, hooks);
    expect(bySlug.hop).toBe(1);
    const env = JSON.parse(posts[0]!.body) as { hop: number; toOrg: string; body: string };
    expect(env.hop).toBe(1);
    expect(env.toOrg).toBe(betaId);
    expect(env.body).toBe("slug-hi");
    expect(posts[0]!.url).toBe("http://127.0.0.1:19/fed/v1/messages");

    const byUuid = await sendToOrg(db, inflight, `Bearer ${w.token}`, { org: betaId, body: "uuid-hi" }, hooks);
    expect(byUuid.hop).toBe(1);
    expect(JSON.parse(posts[1]!.body).hop).toBe(1);
    db.close();
  });

  test("federation/drain turns cannot SendToOrg a third org; Inbox ack binds the running turn", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    seedGatewayOrg(db, w);
    const turnId = insertTurn(db, w, "running");
    const betaId = id();
    const gammaId = id();
    insertPeer(db, "beta", betaId);
    insertPeer(db, "gamma", gammaId);
    insertMessage(db, {
      threadId: w.threadId,
      turnId,
      role: "user",
      origin: "federation",
      body: "inbound from beta",
      remoteOrgId: betaId,
    });
    const inboxId = id();
    db.run(
      `INSERT INTO org_inbox (id, message_id, from_org_id, from_slug, to_org_id, hop, urgency, body, envelope, status, created_at)
       VALUES (?, ?, ?, 'beta', ?, 1, 'normal', 'inbound from beta', '{}', 'pending', ?)`,
      [inboxId, id(), betaId, id(), now()],
    );

    const posts: string[] = [];
    const hooks = {
      orgPrivateKey: () => generateEd25519().privateKey,
      fetchFed: (async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(String(init?.body ?? ""));
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
    };
    const inflight = new McpInflight();
    await expect(
      sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "gamma", body: "forwarded" }, hooks),
    ).rejects.toMatchObject({ code: "no_forward" });
    expect(posts.length).toBe(0);
    expect(
      db.get<{ body: string }>("SELECT body FROM messages WHERE origin = 'send_message'")?.body,
    ).toBe("cannot forward to a third org");
    expect(
      db.get<{ type: string }>("SELECT type FROM audit_events WHERE type = 'fed.drop'")?.type,
    ).toBe("fed.drop");

    const reply = await sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "beta", body: "pong" }, hooks);
    expect(reply.hop).toBe(1);
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0]!).hop).toBe(1);
    expect(JSON.parse(posts[0]!).toOrg).toBe(betaId);

    const listed = inbox(db, inflight, `Bearer ${w.token}`, { limit: 10 });
    expect(listed.pending.some((p) => p.id === inboxId)).toBe(true);
    const acked = inbox(db, inflight, `Bearer ${w.token}`, { ack: inboxId });
    expect(acked.acked).toBe(inboxId);
    expect(acked.pending.length).toBe(0);
    const row = db.get<OrgInboxRow>("SELECT * FROM org_inbox WHERE id = ?", [inboxId]);
    expect(row?.status).toBe("acked");
    expect(row?.acked_turn_id).toBe(turnId);

    db.run("UPDATE messages SET origin = 'prompt', remote_org_id = NULL WHERE turn_id = ? AND role = 'user'", [
      turnId,
    ]);
    await expect(
      sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "gamma", body: "still-no" }, hooks),
    ).rejects.toMatchObject({ code: "no_forward" });
    const before = posts.length;
    await sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "beta", body: "acked-reply" }, hooks);
    expect(posts.length).toBe(before + 1);
    db.close();
  });
});

describe("SendToOrg / Inbox fake ACP round-trip", () => {
  test("slug SendToOrg round-trip; hop=1 on the wire", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const thread = (await fetch(`${a.origin}/v1/threads?botId=${a.gwId}`, { headers: a.headers }).then((r) =>
        r.json(),
      )) as { thread: { id: string } };
      const posted = await fetch(`${a.origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ body: "[[sendorg:beta:hello-slug]]" }),
      });
      expect(posted.status).toBe(202);
      const rows = await waitInbox(b.ctx.db, (r) => r.some((x) => x.body === "hello-slug"));
      expect(rows[0]?.hop).toBe(1);
      expect(JSON.parse(rows[0]!.envelope).hop).toBe(1);
      expect(rows[0]?.from_org_id).toBe(a.orgId);
      await waitTurns(a.ctx.db, a.gwId, (t) => t.some((x) => x.status === "completed" || x.status === "failed"));
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("uuid lookup and Inbox list/ack via fake ACP", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const thread = (await fetch(`${a.origin}/v1/threads?botId=${a.gwId}`, { headers: a.headers }).then((r) =>
        r.json(),
      )) as { thread: { id: string } };
      const posted = await fetch(`${a.origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ body: `[[sendorg:${b.orgId}:hello-uuid]]` }),
      });
      expect(posted.status).toBe(202);
      await waitInbox(b.ctx.db, (r) => r.some((x) => x.body === "hello-uuid"));
      await waitTurns(a.ctx.db, a.gwId, (t) => t.every((x) => x.status !== "running" && x.status !== "queued"));

      const inbound = await postFed(b, a.origin, envelope(b, a, { body: "[[inbox]] please list" }));
      expect(inbound.status).toBe(202);
      const listed = await waitOrigin(a.origin, a.headers, a.gwId, (m) => {
        if (m.origin !== "send_message") return false;
        return m.body.includes("fromSlug") || m.body.includes("pending");
      });
      const pending = a.ctx.db.get<OrgInboxRow>("SELECT * FROM org_inbox WHERE status = 'pending'");
      expect(pending).toBeTruthy();
      expect(listed.some((m) => m.body.includes(pending!.id))).toBe(true);

      await waitTurns(a.ctx.db, a.gwId, (t) => t.every((x) => x.status !== "running" && x.status !== "queued"));
      const ackPost = await fetch(`${a.origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ body: `[[inboxack:${pending!.id}]]` }),
      });
      expect(ackPost.status).toBe(202);
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const row = a.ctx.db.get<OrgInboxRow>("SELECT * FROM org_inbox WHERE id = ?", [pending!.id]);
        if (row?.status === "acked") {
          expect(row.acked_turn_id).toBeTruthy();
          break;
        }
        await Bun.sleep(40);
      }
      expect(a.ctx.db.get<OrgInboxRow>("SELECT * FROM org_inbox WHERE id = ?", [pending!.id])?.status).toBe(
        "acked",
      );
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("inbound from B then SendToOrg C is no_forward and does not POST", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    const c = await bootOrg("gamma", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      await addPeer(a, c);
      await addPeer(c, a);
      const res = await postFed(b, a.origin, envelope(b, a, { body: "[[sendorg:gamma:forwarded]]" }));
      expect(res.status).toBe(202);
      await waitOrigin(a.origin, a.headers, a.gwId, (m) => m.origin === "send_message" && m.body.includes("cannot forward"));
      expect(c.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
      const drop = a.ctx.db.get<{ payload: string }>("SELECT payload FROM audit_events WHERE type = 'fed.drop'");
      expect(drop?.payload).toContain("no_forward");
      expect(
        a.ctx.db.all("SELECT id FROM audit_events WHERE type = 'fed.outbound'").length,
      ).toBe(0);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
      c.server.stop(true);
    }
  });

  test("desk bot SendToOrg is forbidden on a live turn", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const ada = (await fetch(`${a.origin}/v1/bots`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ name: "Ada", description: "research" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const posted = await fetch(`${a.origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ body: "[[sendorg:beta:nope]] [[send:tried-org]]" }),
      });
      expect(posted.status).toBe(202);
      await waitOrigin(a.origin, a.headers, ada.bot.id, (m) => m.origin === "send_message" && m.body === "tried-org");
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });
});
