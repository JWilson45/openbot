import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { generateEd25519, signFedJws } from "@openbot/federation";
import { FED_RATE_PEER_HOUR, id, now, purgeExpiredOrgInbox } from "@openbot/db";
import { loadOrCreateMasterKey } from "@openbot/vault";
import { FED_INFO_RATE_LIMIT, insertOrgPeer, loadOrgKeypair } from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { fakeAgentCommand, tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

async function runOpenbot(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawned: Record<string, string | undefined> = { ...process.env, ...env };
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: spawned,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

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
    if (opts?.federationOn) expect(on.status).toBe(200);
  }
  if (opts?.federationOn === false) {
    /* leave default off */
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
  const body: Record<string, unknown> = {
    id: msgId,
    fromOrg: from.orgId,
    fromSlug: from.slug,
    fromActor: { type: "gateway", name: "Gateway" },
    toOrg: to.orgId,
    urgency: "normal",
    hop: 1,
    createdAt: Date.now(),
    body: "hello from peer",
    ...extra,
    id: msgId,
  };
  if (extra && "id" in extra && extra.id) body.id = extra.id;
  return body as {
    id: string;
    fromOrg: string;
    fromSlug: string;
    fromActor: { type: "gateway"; name: string };
    toOrg: string;
    urgency: string;
    hop: number;
    createdAt: number;
    body: string;
  };
}

async function postFed(
  from: { orgId: string; privateKey: OrgHome["privateKey"] },
  toOrigin: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
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
      ...headers,
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

function postChunkedNoLength(
  origin: string,
  extraHeaders: Record<string, string>,
  body: string,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(origin);
  const hex = body.length.toString(16);
  const headerLines = [
    `POST /fed/v1/messages HTTP/1.1`,
    `Host: ${url.host}`,
    `Transfer-Encoding: chunked`,
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    `Connection: close`,
    ``,
    ``,
  ].join("\r\n");
  const payload = `${headerLines}${hex}\r\n${body}\r\n0\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const sock = connect({ host: url.hostname, port: Number(url.port) }, () => {
      sock.write(payload);
    });
    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(Buffer.from(c)));
    sock.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = split >= 0 ? text.slice(0, split) : text;
      const respBody = split >= 0 ? text.slice(split + 4) : "";
      const status = Number(/HTTP\/1\.\d\s+(\d+)/.exec(head)?.[1] ?? 0);
      let json: unknown = respBody;
      try {
        json = JSON.parse(respBody);
      } catch {
        /* keep text */
      }
      resolve({ status, json });
    });
    sock.on("error", reject);
  });
}

describe("federation inbox POST /fed/v1/messages", () => {
  test("two homes: trusted mail 202, duplicate 200, extra keys stripped", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const env = envelope(a, b, { extraIgnored: "nope", body: "please deliver" });
      const res = await postFed(a, b.origin, env);
      expect(res.status).toBe(202);
      const json = (await res.json()) as { id: string; duplicate: boolean; queued: boolean };
      expect(json.id).toBe(env.id);
      expect(json.duplicate).toBe(false);
      expect(json.queued).toBe(true);

      const inbox = b.ctx.db.all<{ message_id: string; status: string; from_org_id: string }>(
        "SELECT message_id, status, from_org_id FROM org_inbox",
      );
      expect(inbox.length).toBe(1);
      expect(inbox[0]?.status).toBe("pending");
      expect(inbox[0]?.from_org_id).toBe(a.orgId);

      const bubble = b.ctx.db.get<{ origin: string; turn_id: string | null; remote_org_id: string | null; body: string }>(
        "SELECT origin, turn_id, remote_org_id, body FROM messages WHERE origin = 'federation' ORDER BY created_at DESC LIMIT 1",
      );
      expect(bubble?.origin).toBe("federation");
      expect(bubble?.turn_id).toBeTruthy();
      expect(bubble?.remote_org_id).toBe(a.orgId);
      expect(bubble?.body).toContain("please deliver");
      expect(bubble?.body).toContain(env.id);

      const dup = await postFed(a, b.origin, env);
      expect(dup.status).toBe(200);
      expect(((await dup.json()) as { duplicate: boolean; queued: boolean }).duplicate).toBe(true);
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(1);

      await waitTurns(b.ctx.db, b.gwId, (t) => t.some((x) => x.status === "completed" || x.status === "failed"));
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("MUST-bind fail closed: bearer, hop, audience, unknown peer, attachments, json", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);

      const missingAuth = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id() },
        body: JSON.stringify(envelope(a, b)),
      });
      expect(missingAuth.status).toBe(401);
      expect(((await missingAuth.json()) as { error: string }).error).toBe("unauthorized");

      const hop0 = envelope(a, b, { hop: 0 });
      expect((await postFed(a, b.origin, hop0)).status).toBe(400);
      const hop2 = envelope(a, b, { hop: 2 });
      const hop2res = await postFed(a, b.origin, hop2);
      expect(hop2res.status).toBe(400);
      expect(((await hop2res.json()) as { error: string }).error).toBe("hop_limit");
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);

      const wrongAud = envelope(a, b, { toOrg: a.orgId });
      const audRes = await postFed({ ...a, orgId: a.orgId }, b.origin, wrongAud);
      expect(audRes.status).toBe(401);
      expect(((await audRes.json()) as { error: string }).error).toBe("audience");

      const stranger = generateEd25519();
      const strangerOrg = id();
      const env = envelope(a, b);
      env.fromOrg = strangerOrg;
      const raw = JSON.stringify(env);
      const token = signFedJws({
        privateKey: stranger.privateKey,
        fromOrgId: strangerOrg,
        toOrgId: b.orgId,
        messageId: env.id,
        rawBody: raw,
      });
      const unknown = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": env.id,
        },
        body: raw,
      });
      expect(unknown.status).toBe(401);
      expect(((await unknown.json()) as { error: string }).error).toBe("unknown_peer");
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
      const solicit = b.ctx.db.get<{ reason: string; count: number }>(
        "SELECT reason, count FROM org_solicit WHERE reason = 'unknown_peer'",
      );
      expect(solicit?.count).toBeGreaterThan(0);

      const att = envelope(a, b);
      const attRaw = JSON.stringify({ ...att, attachments: [{ name: "x.bin" }] });
      const attTok = signFedJws({
        privateKey: a.privateKey,
        fromOrgId: a.orgId,
        toOrgId: b.orgId,
        messageId: att.id,
        rawBody: attRaw,
      });
      const attRes = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attTok}`,
          "content-type": "application/json",
          "idempotency-key": att.id,
        },
        body: attRaw,
      });
      expect(attRes.status).toBe(400);
      expect(((await attRes.json()) as { error: string }).error).toBe("attachments");

      const badJson = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer x.y.z",
          "content-type": "application/json",
          "idempotency-key": id(),
        },
        body: "{",
      });
      expect(badJson.status).toBe(400);
      expect(((await badJson.json()) as { error: string }).error).toBe("invalid_json");

      const cookieOnly = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: { cookie: b.cookie, "content-type": "application/json", "idempotency-key": id() },
        body: JSON.stringify(envelope(a, b)),
      });
      expect(cookieOnly.status).toBe(401);
      expect(((await cookieOnly.json()) as { error: string }).error).toBe("cookies_not_accepted");

      const mismatchIdem = envelope(a, b);
      const mis = await postFed(a, b.origin, mismatchIdem, { "idempotency-key": id() });
      expect(mis.status).toBe(401);
      expect(((await mis.json()) as { error: string }).error).toBe("bind");
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("oversize Content-Length and missing Content-Length are 413", async () => {
    const b = await bootOrg("beta", { federationOn: true });
    try {
      const big = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer abc",
          "idempotency-key": id(),
        },
        body: "x".repeat(70_000),
      });
      expect(big.status).toBe(413);
      expect(((await big.json()) as { error: string }).error).toBe("too_large");

      const chunked = await postChunkedNoLength(
        b.origin,
        { "content-type": "application/json", authorization: "Bearer abc", "idempotency-key": id() },
        JSON.stringify({ id: id() }),
      );
      expect(chunked.status).toBe(413);
      expect((chunked.json as { error: string }).error).toBe("too_large");
    } finally {
      b.server.stop(true);
    }
  });

  test("trusted + federation off holds mail 403 with no ACP; untrusted 401 solicits", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: false });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const res = await postFed(a, b.origin, envelope(a, b, { body: "held please" }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("federation_disabled");
      const row = b.ctx.db.get<{ status: string }>("SELECT status FROM org_inbox");
      expect(row?.status).toBe("held");
      expect(b.ctx.engine.runnerFor(b.ctx.db.get<{ account_id: string }>("SELECT account_id FROM org_meta")!.account_id).acpPid(b.gwId)).toBeUndefined();
      expect(b.ctx.db.all("SELECT id FROM turns").length).toBe(0);

      const on = await fetch(`${b.origin}/v1/org`, {
        method: "PATCH",
        headers: b.headers,
        body: JSON.stringify({ federationEnabled: true }),
      });
      expect(on.status).toBe(200);
      expect(b.ctx.db.get<{ status: string }>("SELECT status FROM org_inbox")?.status).toBe("pending");
      await waitTurns(b.ctx.db, b.gwId, (t) => t.length >= 1);
      const drain = b.ctx.db.get<{ body: string; origin: string }>(
        "SELECT body, origin FROM messages WHERE origin = 'prompt' ORDER BY created_at DESC LIMIT 1",
      );
      expect(drain?.origin).toBe("prompt");
      expect(drain?.body).toContain("pending");
      const pendingId = b.ctx.db.get<{ id: string }>("SELECT id FROM org_inbox")!.id;
      expect(drain?.body).toContain(pendingId);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("stampede: five POSTs while Gateway running on human hello → one drain", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const thread = (await fetch(`${b.origin}/v1/threads?botId=${b.gwId}`, { headers: b.headers }).then((r) =>
        r.json(),
      )) as { thread: { id: string } };
      const posted = await fetch(`${b.origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers: b.headers,
        body: JSON.stringify({ body: "[[sleep:2500]] [[ramble]] hello" }),
      });
      expect(posted.status).toBe(202);
      await waitTurns(b.ctx.db, b.gwId, (t) => t.some((x) => x.status === "running"));

      const sent = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => postFed(a, b.origin, envelope(a, b, { body: `burst ${i}` }))),
      );
      for (const res of sent) {
        expect(res.status).toBe(202);
        const json = (await res.json()) as { queued: boolean; duplicate: boolean };
        expect(json.queued).toBe(false);
        expect(json.duplicate).toBe(false);
      }
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(5);
      const bubbles = b.ctx.db.all<{ turn_id: string | null }>(
        "SELECT turn_id FROM messages WHERE origin = 'federation'",
      );
      expect(bubbles.length).toBe(5);
      expect(bubbles.every((m) => m.turn_id == null)).toBe(true);

      await waitTurns(b.ctx.db, b.gwId, (t) => t.length >= 2 && t.every((x) => x.status !== "running"));
      const turns = b.ctx.db.all<{ id: string; status: string }>(
        "SELECT id, status FROM turns WHERE bot_id = ? ORDER BY created_at",
        [b.gwId],
      );
      expect(turns.length).toBe(2);
      const drainTurn = turns[1]!;
      const prompt = b.ctx.db.get<{ body: string; origin: string }>(
        "SELECT body, origin FROM messages WHERE turn_id = ? AND role = 'user'",
        [drainTurn.id],
      );
      expect(prompt?.origin).toBe("prompt");
      expect(prompt?.body).toBeTruthy();
      const ids = b.ctx.db.all<{ id: string }>("SELECT id FROM org_inbox").map((r) => r.id);
      for (const inboxId of ids) expect(prompt?.body).toContain(inboxId);

      await waitTurns(b.ctx.db, b.gwId, (t) => t.length === 2 && t.every((x) => x.status !== "queued" && x.status !== "running"));
      expect(
        b.ctx.db.all("SELECT id FROM turns WHERE bot_id = ?", [b.gwId]).length,
      ).toBe(2);
      const notice = b.ctx.db.all<{ body: string }>(
        "SELECT body FROM messages WHERE origin = 'system' AND body LIKE '%acked none%'",
      );
      expect(notice.length).toBeGreaterThan(0);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("openbot gateway off: trusted 403 held, untrusted 401 solicit, no ACP", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const thread = (await fetch(`${b.origin}/v1/threads?botId=${b.gwId}`, { headers: b.headers }).then((r) =>
        r.json(),
      )) as { thread: { id: string } };
      await fetch(`${b.origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers: b.headers,
        body: JSON.stringify({ body: "[[cwd]]" }),
      });
      await waitTurns(b.ctx.db, b.gwId, (t) => t.some((x) => x.status === "completed"));
      const accountId = b.ctx.db.get<{ account_id: string }>("SELECT account_id FROM org_meta")!.account_id;
      expect(b.ctx.engine.runnerFor(accountId).acpPid(b.gwId)).toBeTruthy();

      const off = await runOpenbot(["gateway", "off", "--home", b.home]);
      expect(off.code).toBe(0);
      b.ctx.engine.maintenance();
      expect(b.ctx.engine.runnerFor(accountId).acpPid(b.gwId)).toBeUndefined();

      const held = await postFed(a, b.origin, envelope(a, b, { body: "after off" }));
      expect(held.status).toBe(403);
      expect(b.ctx.db.get<{ status: string }>("SELECT status FROM org_inbox ORDER BY created_at DESC")?.status).toBe(
        "held",
      );

      const stranger = generateEd25519();
      const sid = id();
      const env = {
        id: sid,
        fromOrg: sid,
        fromSlug: "eve",
        fromActor: { type: "gateway" as const, name: "Gateway" },
        toOrg: b.orgId,
        urgency: "normal",
        hop: 1,
        createdAt: Date.now(),
        body: "untrusted",
      };
      const raw = JSON.stringify(env);
      const token = signFedJws({
        privateKey: stranger.privateKey,
        fromOrgId: sid,
        toOrgId: b.orgId,
        messageId: sid,
        rawBody: raw,
      });
      const untrusted = await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": sid,
        },
        body: raw,
      });
      expect(untrusted.status).toBe(401);
      expect(b.ctx.engine.runnerFor(accountId).acpPid(b.gwId)).toBeUndefined();
      expect(
        b.ctx.db.get("SELECT id FROM org_solicit WHERE reason = 'unknown_peer'"),
      ).toBeTruthy();
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("no Gateway bot → 503 and does not store; disabled peer is unknown_peer", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const created = startTestServer({ home, env: { OPENBOT_ORG_SLUG: "solo" } });
    try {
      const info = (await fetch(`${created.origin}/fed/v1/info`).then((r) => r.json())) as {
        orgId: string;
      };
      const kp = generateEd25519();
      const peerOrg = id();
      insertOrgPeer(created.ctx.db, {
        slug: "alpha",
        orgId: peerOrg,
        baseUrl: "http://127.0.0.1:9",
        pubkey: kp.publicKeyRawB64,
      });
      const msgId = id();
      const body = {
        id: msgId,
        fromOrg: peerOrg,
        fromSlug: "alpha",
        fromActor: { type: "gateway", name: "Gateway" },
        toOrg: info.orgId,
        urgency: "normal",
        hop: 1,
        createdAt: Date.now(),
        body: "no gw",
      };
      const raw = JSON.stringify(body);
      const token = signFedJws({
        privateKey: kp.privateKey,
        fromOrgId: peerOrg,
        toOrgId: info.orgId,
        messageId: msgId,
        rawBody: raw,
      });
      const res = await fetch(`${created.origin}/fed/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": msgId,
        },
        body: raw,
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("no_gateway");
      expect(created.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
    } finally {
      created.server.stop(true);
    }

    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await fetch(`${b.origin}/v1/org/peers/${a.orgId}/disable`, { method: "POST", headers: { cookie: b.cookie } });
      const res = await postFed(a, b.origin, envelope(a, b));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_peer");
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("peer rate limit 60/hour is 429; reap drops old pending", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const t = now();
      for (let i = 0; i < FED_RATE_PEER_HOUR; i++) {
        b.ctx.db.run(
          `INSERT INTO org_inbox (id, message_id, from_org_id, from_slug, to_org_id, hop, urgency, body, envelope, status, created_at)
           VALUES (?, ?, ?, 'alpha', ?, 1, 'normal', 'x', '{}', 'pending', ?)`,
          [id(), id(), a.orgId, b.orgId, t],
        );
      }
      const res = await postFed(a, b.origin, envelope(a, b));
      expect(res.status).toBe(429);

      b.ctx.db.run("UPDATE org_inbox SET created_at = ? WHERE status = 'pending'", [
        t - 8 * 24 * 60 * 60 * 1000,
      ]);
      purgeExpiredOrgInbox(b.ctx.db);
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("GET /v1/org/inbox requires session and lists held rows", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: false });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      expect((await fetch(`${b.origin}/v1/org/inbox`)).status).toBe(401);
      await postFed(a, b.origin, envelope(a, b, { body: "listed" }));
      const listed = await fetch(`${b.origin}/v1/org/inbox`, { headers: { cookie: b.cookie } });
      expect(listed.status).toBe(200);
      const json = (await listed.json()) as { inbox: Array<{ status: string; body: string }> };
      expect(json.inbox.length).toBe(1);
      expect(json.inbox[0]?.status).toBe("held");
      expect(json.inbox[0]?.body).toBe("listed");
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });

  test("untrusted unique fromOrg UUIDs coalesce on IP /24, not claimed iss", async () => {
    const b = await bootOrg("beta", { federationOn: true });
    try {
      const sendUnknown = async () => {
        const kp = generateEd25519();
        const org = id();
        const msgId = id();
        const body = {
          id: msgId,
          fromOrg: org,
          fromSlug: "eve",
          fromActor: { type: "gateway" as const, name: "Gateway" },
          toOrg: b.orgId,
          urgency: "normal",
          hop: 1,
          createdAt: Date.now(),
          body: "scan",
        };
        const raw = JSON.stringify(body);
        const token = signFedJws({
          privateKey: kp.privateKey,
          fromOrgId: org,
          toOrgId: b.orgId,
          messageId: msgId,
          rawBody: raw,
        });
        return fetch(`${b.origin}/fed/v1/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": msgId,
          },
          body: raw,
        });
      };
      expect((await sendUnknown()).status).toBe(401);
      expect((await sendUnknown()).status).toBe(401);
      const rows = b.ctx.db.all<{ bucket: string; count: number }>(
        "SELECT bucket, count FROM org_solicit WHERE reason = 'unknown_peer'",
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.bucket.startsWith("ip:")).toBe(true);
      expect(rows[0]?.count).toBe(2);
      expect(b.ctx.db.all("SELECT id FROM org_inbox").length).toBe(0);
      expect(b.ctx.db.all("SELECT id FROM messages WHERE origin = 'system'").length).toBe(1);
    } finally {
      b.server.stop(true);
    }
  });

  test("untrusted POSTs are capped 30/min like GET /fed/v1/info", async () => {
    const b = await bootOrg("beta", { federationOn: true });
    try {
      let last = 0;
      for (let i = 0; i < FED_INFO_RATE_LIMIT + 1; i++) {
        const res = await fetch(`${b.origin}/fed/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": id() },
          body: JSON.stringify({
            id: id(),
            fromOrg: id(),
            fromSlug: "scan",
            fromActor: { type: "gateway", name: "Gateway" },
            toOrg: b.orgId,
            urgency: "normal",
            hop: 1,
            createdAt: Date.now(),
            body: "x",
          }),
        });
        last = res.status;
        if (i < FED_INFO_RATE_LIMIT) expect(res.status).toBe(401);
      }
      expect(last).toBe(429);
      expect(((await (await fetch(`${b.origin}/fed/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id() },
        body: JSON.stringify({
          id: id(),
          fromOrg: id(),
          fromSlug: "scan",
          fromActor: { type: "gateway", name: "Gateway" },
          toOrg: b.orgId,
          urgency: "normal",
          hop: 1,
          createdAt: Date.now(),
          body: "x",
        }),
      })).json()) as { error: string }).error).toBe("rate_limited");
      expect(b.ctx.db.all("SELECT id FROM messages WHERE origin = 'system'").length).toBe(1);
    } finally {
      b.server.stop(true);
    }
  });

  test("cancelling a queued Gateway turn drains pending inbox", async () => {
    const a = await bootOrg("alpha", { federationOn: true });
    const b = await bootOrg("beta", { federationOn: true });
    try {
      await addPeer(a, b);
      await addPeer(b, a);
      const thread = b.ctx.db.get<{ id: string }>(
        "SELECT id FROM threads WHERE bot_id = ? AND IFNULL(kind,'human') = 'human'",
        [b.gwId],
      );
      expect(thread).toBeTruthy();
      const occupy = id();
      b.ctx.db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?)`,
        [occupy, thread!.id, b.gwId, now()],
      );
      const res = await postFed(a, b.origin, envelope(a, b, { body: "while queued" }));
      expect(res.status).toBe(202);
      expect(((await res.json()) as { queued: boolean }).queued).toBe(false);
      expect(b.ctx.db.get<{ status: string }>("SELECT status FROM org_inbox")?.status).toBe("pending");
      expect(b.ctx.db.get<{ turn_id: string | null }>("SELECT turn_id FROM messages WHERE origin = 'federation'")?.turn_id).toBeNull();

      const cancel = await fetch(`${b.origin}/v1/turns/${occupy}/cancel`, {
        method: "POST",
        headers: b.headers,
      });
      expect(cancel.status).toBe(200);
      await waitTurns(b.ctx.db, b.gwId, (t) =>
        t.some((x) => {
          const prompt = b.ctx.db.get<{ origin: string }>(
            "SELECT origin FROM messages WHERE turn_id = ? AND role = 'user'",
            [x.id],
          );
          return prompt?.origin === "prompt";
        }),
      );
      const drain = b.ctx.db.get<{ body: string }>(
        "SELECT body FROM messages WHERE origin = 'prompt' ORDER BY created_at DESC LIMIT 1",
      );
      expect(drain?.body).toContain("pending");
      const pendingId = b.ctx.db.get<{ id: string }>("SELECT id FROM org_inbox")!.id;
      expect(drain?.body).toContain(pendingId);
    } finally {
      a.server.stop(true);
      b.server.stop(true);
    }
  });
});
