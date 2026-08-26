import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
  ensureThreadBridge,
  id,
  now,
  OpenbotDb,
  sha256Hex,
  ThreadBridgeConflict,
  type OrgInboxRow,
  type ThreadBridgeRow,
} from "@openbot/db";
import { generateEd25519, signFedJws } from "@openbot/federation";
import { insertMessage } from "@openbot/live-work";
import { persistMcpToken, sendToOrg, McpInflight } from "@openbot/mcp-send-message";
import { loadOrCreateMasterKey } from "@openbot/vault";
import { loadOrgKeypair } from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { fakeAgentCommand, insertTurn, seedWorld, tempHome } from "./helpers.ts";

type OrgHome = {
  home: string;
  origin: string;
  orgId: string;
  slug: string;
  pubkey: string;
  privateKey: ReturnType<typeof loadOrgKeypair>["privateKey"];
  ctx: ReturnType<typeof startTestServer>["ctx"];
  server: ReturnType<typeof startTestServer>["server"];
  headers: { cookie: string; "content-type": string };
  gwId: string;
};

async function bootOrg(slug: string): Promise<OrgHome> {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  process.env.OPENBOT_FED_ALLOW_HTTP = "1";
  const home = tempHome();
  const created = startTestServer({
    home,
    env: { OPENBOT_ORG_SLUG: slug, OPENBOT_ORG_NAME: slug },
  });
  const { cookie } = loginCookie({ ctx: created.ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  const on = await fetch(`${created.origin}/v1/org`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ federationEnabled: true }),
  });
  expect(on.status).toBe(200);
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
  const token = signFedJws({
    privateKey: from.privateKey,
    fromOrgId: from.orgId,
    toOrgId: String(body.toOrg),
    messageId: String(body.id),
    rawBody: raw,
  });
  return fetch(`${toOrigin}/fed/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": String(body.id),
    },
    body: raw,
  });
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

function insertPeer(db: OpenbotDb, slug: string, peerOrgId: string, baseUrl = "http://127.0.0.1:9") {
  const kp = generateEd25519();
  db.run(
    `INSERT INTO org_peers (id, peer_org_id, slug, name, base_url, pubkey, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'allowed', ?)`,
    [id(), peerOrgId, slug, slug, baseUrl, kp.publicKeyRawB64, now()],
  );
  return kp;
}

function insertGroup(db: OpenbotDb, w: ReturnType<typeof seedWorld>, title = "pair"): string {
  const groupId = id();
  const t = now();
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, ?, 'group', ?)`,
    [groupId, w.accountId, w.botId, title, t],
  );
  db.run(
    `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
     VALUES (?, ?, 'human', ?, NULL, ?)`,
    [id(), groupId, w.userId, t],
  );
  db.run(
    `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
     VALUES (?, ?, 'bot', NULL, ?, ?)`,
    [id(), groupId, w.botId, t],
  );
  return groupId;
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

function armGatewayTurn(org: OrgHome, threadId: string): string {
  const token = "ob_sess_test_" + id().replaceAll("-", "");
  const harnessId = id();
  const t = now();
  const accountId = org.ctx.db.get<{ account_id: string }>(
    "SELECT account_id FROM org_meta WHERE id = 'current'",
  )!.account_id;
  const compute = org.ctx.db.get<{ id: string }>(
    "SELECT id FROM compute_instances WHERE account_id = ?",
    [accountId],
  );
  org.ctx.db.run(
    `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
    [harnessId, compute?.id ?? accountId, org.gwId, t],
  );
  persistMcpToken(
    org.ctx.db,
    { accountId, botId: org.gwId, threadId, harnessSessionId: harnessId },
    sha256Hex(token),
  );
  const turnId = id();
  org.ctx.db.run(
    `INSERT INTO turns (id, thread_id, bot_id, harness_session_id, status, sent_message_count, assistant_text, created_at)
     VALUES (?, ?, ?, ?, 'running', 0, '', ?)`,
    [turnId, threadId, org.gwId, harnessId, t],
  );
  insertMessage(org.ctx.db, {
    threadId,
    turnId,
    role: "user",
    origin: "user",
    body: "tell them",
  });
  return token;
}

describe("thread_bridges schema", () => {
  test("UNIQUE local_thread_id and auto_forward default 0", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const groupId = insertGroup(db, w);
    const peerA = id();
    const peerB = id();
    const first = ensureThreadBridge(db, { localThreadId: groupId, peerOrgId: peerA });
    expect(first.auto_forward).toBe(0);
    expect(first.peer_org_id).toBe(peerA);
    expect(() => ensureThreadBridge(db, { localThreadId: groupId, peerOrgId: peerB })).toThrow(
      ThreadBridgeConflict,
    );
    expect(
      db.all<ThreadBridgeRow>("SELECT * FROM thread_bridges WHERE local_thread_id = ?", [groupId]).length,
    ).toBe(1);
    expect(() => {
      db.run(
        `INSERT INTO thread_bridges (id, local_thread_id, peer_org_id, peer_thread_id, auto_forward, created_at)
         VALUES (?, ?, ?, NULL, 0, ?)`,
        [id(), groupId, peerB, now()],
      );
    }).toThrow(/UNIQUE/i);
    const cols = db.all<{ name: string; dflt_value: unknown }>("PRAGMA table_info(thread_bridges)");
    expect(String(cols.find((c) => c.name === "auto_forward")?.dflt_value)).toBe("0");
    db.close();
  });
});

describe("SendToOrg thread bridges", () => {
  test("two-org pair maps; hop is 1; inbound creates Bridge · {slug}", async () => {
    const a = await bootOrg("alpha");
    const b = await bootOrg("beta");
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const ada = await fetch(`${a.origin}/v1/bots`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ name: "Ada" }),
      });
      expect(ada.status).toBe(200);
      const adaBody = (await ada.json()) as { bot: { id: string } };
      const created = await fetch(`${a.origin}/v1/threads`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ kind: "group", title: "pair", botIds: [a.gwId, adaBody.bot.id] }),
      });
      expect([200, 201]).toContain(created.status);
      const groupId = ((await created.json()) as { thread: { id: string } }).thread.id;

      const token = armGatewayTurn(a, groupId);
      const inflight = new McpInflight();
      const sent = await sendToOrg(
        a.ctx.db,
        inflight,
        `Bearer ${token}`,
        { org: "beta", body: "pair-hi", threadId: groupId },
        { orgPrivateKey: () => a.privateKey, fetchFed: fetch },
      );
      expect(sent.hop).toBe(1);

      const aBridge = a.ctx.db.get<ThreadBridgeRow>(
        "SELECT * FROM thread_bridges WHERE local_thread_id = ?",
        [groupId],
      );
      expect(aBridge?.peer_org_id).toBe(b.orgId);
      expect(aBridge?.auto_forward).toBe(0);
      expect(aBridge?.peer_thread_id).toBeNull();

      const rows = await waitInbox(b.ctx.db, (r) => r.some((x) => x.body === "pair-hi"));
      expect(rows[0]?.hop).toBe(1);
      const env = JSON.parse(rows[0]!.envelope) as {
        hop: number;
        threadHint?: { kind: string; localThreadId?: string; peerThreadId?: string };
      };
      expect(env.hop).toBe(1);
      expect(env.threadHint?.kind).toBe("bridge");
      expect(env.threadHint?.localThreadId).toBe(groupId);
      expect(env.threadHint?.peerThreadId).toBeUndefined();

      const bGroup = b.ctx.db.get<{ id: string; title: string; kind: string }>(
        "SELECT id, title, kind FROM threads WHERE kind = 'group' ORDER BY created_at DESC LIMIT 1",
      );
      expect(bGroup?.title).toBe("Bridge · alpha");
      const bBridge = b.ctx.db.get<ThreadBridgeRow>("SELECT * FROM thread_bridges LIMIT 1");
      expect(bBridge?.local_thread_id).toBe(bGroup?.id);
      expect(bBridge?.peer_org_id).toBe(a.orgId);
      expect(bBridge?.peer_thread_id).toBe(groupId);
      expect(bBridge?.auto_forward).toBe(0);
      expect(
        b.ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND origin = 'federation'",
          [bGroup!.id],
        )?.n,
      ).toBe(1);

      const bToken = armGatewayTurn(b, bGroup!.id);
      const reply = await sendToOrg(
        b.ctx.db,
        new McpInflight(),
        `Bearer ${bToken}`,
        { org: "alpha", body: "pair-reply", threadId: bGroup!.id },
        { orgPrivateKey: () => b.privateKey, fetchFed: fetch },
      );
      expect(reply.hop).toBe(1);

      const aRows = await waitInbox(a.ctx.db, (r) => r.some((x) => x.body === "pair-reply"));
      const aMail = aRows.find((x) => x.body === "pair-reply")!;
      expect(aMail.hop).toBe(1);
      const replyEnv = JSON.parse(aMail.envelope) as {
        hop: number;
        threadHint?: { kind: string; localThreadId?: string; peerThreadId?: string };
      };
      expect(replyEnv.hop).toBe(1);
      expect(replyEnv.threadHint?.kind).toBe("bridge");
      expect(replyEnv.threadHint?.localThreadId).toBe(bGroup!.id);
      expect(replyEnv.threadHint?.peerThreadId).toBe(groupId);

      const aFed = a.ctx.db.get<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE origin = 'federation' AND body LIKE ? ORDER BY created_at DESC LIMIT 1",
        ["%pair-reply%"],
      );
      expect(aFed?.thread_id).toBe(groupId);
      const aAfter = a.ctx.db.get<ThreadBridgeRow>(
        "SELECT * FROM thread_bridges WHERE local_thread_id = ?",
        [groupId],
      );
      expect(aAfter?.peer_thread_id).toBe(bGroup!.id);
      expect(aAfter?.auto_forward).toBe(0);
      expect(a.ctx.db.all("SELECT id FROM threads WHERE kind = 'group'").length).toBe(1);
      expect(b.ctx.db.all("SELECT id FROM threads WHERE kind = 'group'").length).toBe(1);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("claimedLocal does not bridge an unbridged local group", async () => {
    const a = await bootOrg("alpha");
    const b = await bootOrg("beta");
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const ada = await fetch(`${a.origin}/v1/bots`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ name: "Ada" }),
      });
      expect(ada.status).toBe(200);
      const adaBody = (await ada.json()) as { bot: { id: string } };
      const created = await fetch(`${a.origin}/v1/threads`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ kind: "group", title: "standup", botIds: [a.gwId, adaBody.bot.id] }),
      });
      expect([200, 201]).toContain(created.status);
      const groupId = ((await created.json()) as { thread: { id: string } }).thread.id;
      const peerThread = id();
      const res = await postFed(
        b,
        a.origin,
        envelope(b, a, {
          body: "inject",
          threadHint: { kind: "bridge", localThreadId: peerThread, peerThreadId: groupId },
        }),
      );
      expect(res.status).toBe(202);
      expect(
        a.ctx.db.get<ThreadBridgeRow>("SELECT * FROM thread_bridges WHERE local_thread_id = ?", [groupId]),
      ).toBeFalsy();
      const bridgeGroup = a.ctx.db.get<{ id: string; title: string }>(
        "SELECT id, title FROM threads WHERE kind = 'group' AND title = ? ORDER BY created_at DESC LIMIT 1",
        ["Bridge · beta"],
      );
      expect(bridgeGroup?.id).toBeTruthy();
      expect(bridgeGroup?.id).not.toBe(groupId);
      const mapped = a.ctx.db.get<ThreadBridgeRow>(
        "SELECT * FROM thread_bridges WHERE local_thread_id = ?",
        [bridgeGroup!.id],
      );
      expect(mapped?.peer_org_id).toBe(b.orgId);
      expect(mapped?.peer_thread_id).toBe(peerThread);
      expect(mapped?.auto_forward).toBe(0);
      expect(
        a.ctx.db.get<{ thread_id: string }>(
          "SELECT thread_id FROM messages WHERE origin = 'federation' ORDER BY created_at DESC LIMIT 1",
        )?.thread_id,
      ).toBe(bridgeGroup!.id);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("open outbound is not reused when inbound names a peer thread", async () => {
    const a = await bootOrg("alpha");
    const b = await bootOrg("beta");
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const ada = await fetch(`${a.origin}/v1/bots`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ name: "Ada" }),
      });
      expect(ada.status).toBe(200);
      const adaBody = (await ada.json()) as { bot: { id: string } };
      const created = await fetch(`${a.origin}/v1/threads`, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({ kind: "group", title: "project-x", botIds: [a.gwId, adaBody.bot.id] }),
      });
      expect([200, 201]).toContain(created.status);
      const groupId = ((await created.json()) as { thread: { id: string } }).thread.id;
      const token = armGatewayTurn(a, groupId);
      await sendToOrg(
        a.ctx.db,
        new McpInflight(),
        `Bearer ${token}`,
        { org: "beta", body: "from-x", threadId: groupId },
        { orgPrivateKey: () => a.privateKey, fetchFed: fetch },
      );
      expect(
        a.ctx.db.get<ThreadBridgeRow>("SELECT * FROM thread_bridges WHERE local_thread_id = ?", [groupId])
          ?.peer_thread_id,
      ).toBeNull();

      const otherPeerThread = id();
      const res = await postFed(
        b,
        a.origin,
        envelope(b, a, {
          body: "from-y",
          threadHint: { kind: "bridge", localThreadId: otherPeerThread },
        }),
      );
      expect(res.status).toBe(202);
      const stillOpen = a.ctx.db.get<ThreadBridgeRow>(
        "SELECT * FROM thread_bridges WHERE local_thread_id = ?",
        [groupId],
      );
      expect(stillOpen?.peer_thread_id).toBeNull();
      const extra = a.ctx.db.get<{ id: string; title: string }>(
        "SELECT id, title FROM threads WHERE kind = 'group' AND title = ?",
        ["Bridge · beta"],
      );
      expect(extra?.id).toBeTruthy();
      expect(extra?.id).not.toBe(groupId);
      expect(
        a.ctx.db.get<ThreadBridgeRow>("SELECT * FROM thread_bridges WHERE local_thread_id = ?", [extra!.id])
          ?.peer_thread_id,
      ).toBe(otherPeerThread);
      expect(a.ctx.db.all("SELECT id FROM threads WHERE kind = 'group'").length).toBe(2);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("a second peer_org on the same local thread 409s", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    seedGatewayOrg(db, w);
    const groupId = insertGroup(db, w);
    const turnId = insertTurn(db, w, "running", { threadId: groupId });
    insertMessage(db, {
      threadId: groupId,
      turnId,
      role: "user",
      origin: "user",
      body: "hello",
    });
    insertPeer(db, "beta", id());
    insertPeer(db, "gamma", id());
    const posts: string[] = [];
    const hooks = {
      orgPrivateKey: () => generateEd25519().privateKey,
      fetchFed: (async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(String(init?.body ?? ""));
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
    };
    const inflight = new McpInflight();
    const first = await sendToOrg(
      db,
      inflight,
      `Bearer ${w.token}`,
      { org: "beta", body: "first", threadId: groupId },
      hooks,
    );
    expect(first.hop).toBe(1);
    expect(JSON.parse(posts[0]!).hop).toBe(1);
    expect(JSON.parse(posts[0]!).threadHint).toEqual({ kind: "bridge", localThreadId: groupId });

    await expect(
      sendToOrg(db, inflight, `Bearer ${w.token}`, { org: "gamma", body: "second", threadId: groupId }, hooks),
    ).rejects.toMatchObject({ code: "conflict", httpStatus: 409 });
    expect(posts.length).toBe(1);
    expect(db.all<ThreadBridgeRow>("SELECT * FROM thread_bridges").length).toBe(1);
    expect(db.get<ThreadBridgeRow>("SELECT * FROM thread_bridges")?.auto_forward).toBe(0);
    db.close();
  });

  test("no hop+1 path exists in code", async () => {
    const roots = ["apps/server/src", "packages"];
    const hopInc = /\bhop\s*\+\s*1\b|\bhop\s*\+\+|\+\+\s*hop\b|\bhop\s*\+=/;
    const autoForwardOn = /\bauto_forward\b[^;\n]*=\s*1\b/;
    for (const root of roots) {
      const glob = new Glob("**/*.ts");
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
        if (rel.includes(".test.")) continue;
        const text = await Bun.file(join(root, rel)).text();
        expect(hopInc.test(text), `${root}/${rel} increments hop`).toBe(false);
        expect(autoForwardOn.test(text), `${root}/${rel} sets auto_forward=1`).toBe(false);
      }
    }
    const sendSrc = await Bun.file("packages/mcp-send-message/src/index.ts").text();
    expect(sendSrc).toContain("hop: 1 as const");
    expect(sendSrc).toContain("hop: 1");
  });
});
