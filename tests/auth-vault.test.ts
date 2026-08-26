import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb } from "@openbot/db";
import {
  AuthDenied,
  completeGithubLogin,
  isAllowlisted,
  loadAllowlist,
  mintApiKey,
  sessionFromApiKey,
  sessionFromToken,
  writeAllowlistFile,
} from "@openbot/auth";
import { RedactingLogger, loadOrCreateMasterKey, open, seal } from "@openbot/vault";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("allowlist + bot-create + key inject", () => {
  test("listed GitHub login can become a session; unlisted is denied", () => {
    const home = tempHome();
    writeAllowlistFile(home, ["alice"]);
    const allow = loadAllowlist(home);
    expect(isAllowlisted(allow, "Alice")).toBe(true);
    expect(isAllowlisted(allow, "mallory")).toBe(false);
    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    const session = completeGithubLogin(db, allow, { login: "alice" });
    expect(session.githubLogin).toBe("alice");
    expect(session.accountId).toBeTruthy();
    expect(() => completeGithubLogin(db, allow, { login: "mallory" })).toThrow(AuthDenied);
    expect(sessionFromToken(db, session.token)?.accountId).toBe(session.accountId);
  });

  test("second allowlisted login shares the org account; sk-ob_ stays the founder", () => {
    const home = tempHome();
    writeAllowlistFile(home, ["alice", "bob"]);
    const allow = loadAllowlist(home);
    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    db.run(
      `INSERT INTO org_meta (id, account_id, org_id, slug, name, public_origin, pubkey, federation_enabled, created_at)
       VALUES ('current', NULL, ?, 'local', 'local', NULL, '', 0, ?)`,
      [crypto.randomUUID(), Date.now()],
    );
    const alice = completeGithubLogin(db, allow, { login: "alice" });
    const bob = completeGithubLogin(db, allow, { login: "bob" });
    expect(bob.accountId).toBe(alice.accountId);
    expect(db.all("SELECT id FROM accounts").length).toBe(1);
    expect(sessionFromToken(db, bob.token)?.accountId).toBe(alice.accountId);
    expect(sessionFromToken(db, bob.token)?.githubLogin).toBe("bob");
    const minted = mintApiKey(db, alice.accountId);
    expect(sessionFromApiKey(db, minted.token)?.githubLogin).toBe("alice");
    db.close();
  });

  test("unlisted user is denied via the same completeGithubLogin path the OAuth callback uses", async () => {
    const home = tempHome();
    const { ctx, server } = startTestServer({ home, githubClientId: "x", githubClientSecret: "y" });
    writeAllowlistFile(home, ["alice"]);
    ctx.allowlist.clear();
    ctx.allowlist.add("alice");
    expect(() => completeGithubLogin(ctx.db, ctx.allowlist, { login: "eve" })).toThrow(AuthDenied);
    server.stop(true);
  });

  test("vaulted XAI_API_KEY is passed into harness spawn env and never appears in logs", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const logger = new RedactingLogger();
    const { ctx, server, origin } = startTestServer({ home, logger });
    const { cookie, session } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const key = "xai-SUPERSECRETKEY999";
    const expectedLastFour = key.slice(-4);
    const botRes = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", description: "bot" }),
    });
    expect(botRes.status).toBe(200);
    const credRes = await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key }),
    });
    expect(credRes.status).toBe(200);
    const credJson = (await credRes.json()) as { lastFour: string };
    expect(credJson.lastFour).toBe(expectedLastFour);

    const row = ctx.db.get<{ ciphertext: Uint8Array; dek_wrapped: Uint8Array; key_id: string }>(
      "SELECT ciphertext, dek_wrapped, key_id FROM credentials WHERE account_id = ?",
      [session.accountId],
    );
    expect(row).toBeTruthy();
    const master = loadOrCreateMasterKey(home, process.env.OPENBOT_MASTER_KEY);
    const opened = open(master, {
      ciphertext: Buffer.from(row!.ciphertext),
      dekWrapped: Buffer.from(row!.dek_wrapped),
      keyId: row!.key_id,
      lastFour: credJson.lastFour,
    });
    expect(opened).toBe(key);

    const thread = await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json()) as {
      thread: { id: string };
    };
    const msgRes = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:hi]]" }),
    });
    expect(msgRes.status).toBe(202);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const turn = ctx.db.get<{ status: string }>("SELECT status FROM turns ORDER BY created_at DESC LIMIT 1");
      if (turn && (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled")) break;
      await Bun.sleep(50);
    }
    const runner = ctx.engine.runnerFor(session.accountId);
    expect(runner.injectedKey).toBe(true);
    expect(Object.values(runner.lastEnv).join("")).not.toContain(key);
    logger.info("spawned harness", { env: { XAI_API_KEY: key } });
    expect(logger.containsSecretLeak()).toBe(false);
    expect(logger.lines.join("\n")).not.toContain("SUPERSECRET");
    expect(logger.lines.join("\n")).toContain("[redacted]");
    server.stop(true);
  });
});
