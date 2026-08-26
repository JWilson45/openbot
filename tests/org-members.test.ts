import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb, id, now, sha256Hex } from "@openbot/db";
import {
  completeGithubLogin,
  cookieHeader,
  mintApiKey,
  sessionFromApiKey,
  sessionFromToken,
  writeAllowlistFile,
} from "@openbot/auth";
import { RedactingLogger } from "@openbot/vault";
import { createApp } from "../apps/server/src/app.ts";
import { currentOrgMeta, ensureOrgMeta } from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { tempHome } from "./helpers.ts";

function cookieFor(session: { token: string }): string {
  return cookieHeader(session.token).split(";")[0]!;
}

describe("org members + one account per instance", () => {
  test("first login sets org_meta.account_id and founding org_members", () => {
    const home = tempHome();
    writeAllowlistFile(home, ["alice"]);
    const created = createApp({ home, port: 0 });
    try {
      expect(currentOrgMeta(created.ctx.db)?.account_id == null).toBe(true);
      const session = completeGithubLogin(created.ctx.db, created.ctx.allowlist, { login: "alice" });
      const org = currentOrgMeta(created.ctx.db);
      expect(org?.account_id).toBe(session.accountId);
      const members = created.ctx.db.all<{ user_id: string; account_id: string; role: string }>(
        "SELECT user_id, account_id, role FROM org_members",
      );
      expect(members).toEqual([
        { user_id: session.userId, account_id: session.accountId, role: "member" },
      ]);
      expect(created.ctx.db.all("SELECT id FROM accounts").length).toBe(1);
    } finally {
      created.stop();
    }
  });

  test("second allowlisted GitHub user gets a session on the same account", async () => {
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      writeAllowlistFile(ctx.home, ["alice", "bob"]);
      ctx.allowlist.add("alice");
      ctx.allowlist.add("bob");
      const alice = completeGithubLogin(ctx.db, ctx.allowlist, { login: "alice" });
      const bob = completeGithubLogin(ctx.db, ctx.allowlist, { login: "bob" });
      expect(bob.accountId).toBe(alice.accountId);
      expect(bob.userId).not.toBe(alice.userId);
      expect(ctx.db.all("SELECT id FROM accounts").length).toBe(1);
      expect(sessionFromToken(ctx.db, bob.token)?.accountId).toBe(alice.accountId);
      expect(sessionFromToken(ctx.db, bob.token)?.githubLogin).toBe("bob");

      const bobMe = await fetch(`${origin}/v1/me`, { headers: { cookie: cookieFor(bob) } });
      expect(bobMe.status).toBe(200);
      const json = (await bobMe.json()) as { accountId: string; githubLogin: string; userId: string };
      expect(json.accountId).toBe(alice.accountId);
      expect(json.githubLogin).toBe("bob");
      expect(json.userId).toBe(bob.userId);
    } finally {
      server.stop(true);
    }
  });

  test("unmigrated DB: sessionFromToken works; boot backfills founding member", () => {
    const home = tempHome();
    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    const userId = id();
    const accountId = id();
    const token = "ob_sess_" + id().replaceAll("-", "");
    const t = now();
    db.run(`INSERT INTO users (id, github_login, created_at) VALUES (?, 'alice', ?)`, [userId, t]);
    db.run(`INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)`, [accountId, userId, t]);
    db.run(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id(), userId, sha256Hex(token), t + 86_400_000, t],
    );
    expect(db.all("SELECT id FROM org_members").length).toBe(0);
    const prior = sessionFromToken(db, token);
    expect(prior?.accountId).toBe(accountId);
    expect(prior?.githubLogin).toBe("alice");
    db.close();

    const created = createApp({ home, port: 0 });
    try {
      expect(currentOrgMeta(created.ctx.db)?.account_id).toBe(accountId);
      const member = created.ctx.db.get<{ user_id: string; account_id: string }>(
        "SELECT user_id, account_id FROM org_members WHERE user_id = ?",
        [userId],
      );
      expect(member?.account_id).toBe(accountId);
      expect(sessionFromToken(created.ctx.db, token)?.accountId).toBe(accountId);
    } finally {
      created.stop();
    }
  });

  test("sk-ob_ still reports the founding user's githubLogin", () => {
    const home = tempHome();
    writeAllowlistFile(home, ["alice", "bob"]);
    const created = createApp({ home, port: 0 });
    try {
      created.ctx.allowlist.add("alice");
      created.ctx.allowlist.add("bob");
      const alice = completeGithubLogin(created.ctx.db, created.ctx.allowlist, { login: "alice" });
      completeGithubLogin(created.ctx.db, created.ctx.allowlist, { login: "bob" });
      const minted = mintApiKey(created.ctx.db, alice.accountId, "owui");
      const s = sessionFromApiKey(created.ctx.db, minted.token);
      expect(s?.githubLogin).toBe("alice");
      expect(s?.userId).toBe(alice.userId);
      expect(s?.accountId).toBe(alice.accountId);
    } finally {
      created.stop();
    }
  });

  test("GET /v1/org and /v1/me reject sk-ob_ bearer and accept session", async () => {
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const minted = mintApiKey(ctx.db, session.accountId);
      const keyHeaders = { authorization: `Bearer ${minted.token}` };
      const sessionHeaders = { authorization: `Bearer ${session.token}` };
      for (const path of ["/v1/org", "/v1/me"]) {
        expect((await fetch(`${origin}${path}`, { headers: keyHeaders })).status).toBe(401);
        expect((await fetch(`${origin}${path}`, { headers: { cookie } })).status).toBe(200);
        expect((await fetch(`${origin}${path}`, { headers: sessionHeaders })).status).toBe(200);
      }
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/me includes org fields and no private key", async () => {
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const org = currentOrgMeta(ctx.db)!;
      const res = await fetch(`${origin}/v1/me`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.githubLogin).toBe("alice");
      expect(json.accountId).toBe(session.accountId);
      expect(json.userId).toBe(session.userId);
      expect(json.orgId).toBe(org.org_id);
      expect(json.orgSlug).toBe(org.slug);
      expect(json.orgName).toBe(org.name);
      expect(json.pubkey).toBe("");
      expect(json.role).toBe("member");
      expect(json).not.toHaveProperty("privateKey");
      expect(JSON.stringify(json)).not.toContain("BEGIN");
    } finally {
      server.stop(true);
    }
  });

  test("two-account boot binds the oldest and warns", () => {
    const home = tempHome();
    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    const aliceId = id();
    const bobId = id();
    const oldest = id();
    const extra = id();
    const extraBot = id();
    const t = now();
    db.run(`INSERT INTO users (id, github_login, created_at) VALUES (?, 'alice', ?)`, [aliceId, t]);
    db.run(`INSERT INTO users (id, github_login, created_at) VALUES (?, 'bob', ?)`, [bobId, t + 1]);
    db.run(`INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)`, [oldest, aliceId, t]);
    db.run(`INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)`, [extra, bobId, t + 1]);
    db.run(
      `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
       VALUES (?, ?, 'Ada', '', 'active', 'auto', ?)`,
      [extraBot, extra, t + 1],
    );
    db.close();

    const logger = new RedactingLogger();
    const created = createApp({ home, port: 0, logger });
    try {
      expect(currentOrgMeta(created.ctx.db)?.account_id).toBe(oldest);
      expect(created.ctx.db.all("SELECT id FROM accounts").length).toBe(2);
      expect(
        created.ctx.db.get<{ id: string }>("SELECT id FROM bots WHERE id = ?", [extraBot])?.id,
      ).toBe(extraBot);
      const member = created.ctx.db.get<{ user_id: string }>(
        "SELECT user_id FROM org_members WHERE account_id = ?",
        [oldest],
      );
      expect(member?.user_id).toBe(aliceId);
      expect(logger.lines.join("\n")).toContain("multiple accounts on this instance");
    } finally {
      created.stop();
    }
  });
});
