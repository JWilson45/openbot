import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_TTL_MS, now } from "@openbot/db";
import {
  botProjectDir,
  deleteBotProject,
  ensureBotProject,
  ensureGatewayWorkspace,
  gatewayWorkspaceDir,
  isInsideDesk,
  LocalHostRunner,
} from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("bot project workspace", () => {
  test("ensureBotProject creates dir, metadata, and README; deleteBotProject removes only that dir", () => {
    const desk = join(tempHome(), "desk");
    const botId = "11111111-1111-4111-8111-111111111111";
    const dir = ensureBotProject(desk, botId, "Ada");
    expect(dir).toBe(join(desk, "projects", botId));
    expect(botProjectDir(desk, botId)).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".openbot-bot.json"), "utf8")) as {
      id: string;
      name: string;
      updatedAt: number;
    };
    expect(meta.id).toBe(botId);
    expect(meta.name).toBe("Ada");
    expect(meta.updatedAt).toBeGreaterThan(0);
    const readme = readFileSync(join(dir, "README.md"), "utf8").trim();
    expect(readme).toBe("Workspace for bot Ada. Shared desk is the parent. Not a security boundary.");
    writeFileSync(join(dir, "README.md"), "keep me\n");
    ensureBotProject(desk, botId, "Ada");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("keep me\n");

    const sibling = ensureBotProject(desk, "22222222-2222-4222-8222-222222222222", "Bob");
    writeFileSync(join(dir, "notes.txt"), "ada");
    writeFileSync(join(desk, "shared.txt"), "desk");
    deleteBotProject(desk, botId);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(join(desk, "shared.txt"))).toBe(true);
  });

  test("deleteBotProject refuses path traversal and does not delete the desk", () => {
    const desk = join(tempHome(), "desk");
    mkdirSync(join(desk, "projects"), { recursive: true });
    writeFileSync(join(desk, "keep.txt"), "safe");
    const victim = join(desk, "projects", "keep-bot");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "x.txt"), "x");

    expect(() => deleteBotProject(desk, "..")).toThrow();
    expect(() => deleteBotProject(desk, "../..")).toThrow();
    expect(() => deleteBotProject(desk, join("..", "keep.txt"))).toThrow();
    expect(() => ensureBotProject(desk, "..", "Nope")).toThrow();
    expect(existsSync(desk)).toBe(true);
    expect(existsSync(join(desk, "keep.txt"))).toBe(true);
    expect(existsSync(join(victim, "x.txt"))).toBe(true);
  });

  test("ensureGatewayWorkspace is desk/.openbot/gateway not a project dir", () => {
    const home = tempHome();
    const desk = join(home, "desk");
    const dir = ensureGatewayWorkspace(desk);
    expect(dir).toBe(gatewayWorkspaceDir(desk));
    expect(dir).toBe(join(desk, ".openbot", "gateway"));
    expect(existsSync(dir)).toBe(true);
    expect(dir.includes("projects")).toBe(false);
    const runner = new LocalHostRunner(home, "acct");
    expect(runner.ensureGatewayWorkspace()).toBe(dir);
  });

  test("isInsideDesk", () => {
    const desk = join(tempHome(), "desk");
    expect(isInsideDesk(desk, desk)).toBe(true);
    expect(isInsideDesk(desk, join(desk, "projects", "abc"))).toBe(true);
    expect(isInsideDesk(desk, join(desk, ".."))).toBe(false);
    expect(isInsideDesk(join(desk, "projects"), join(desk, "other"))).toBe(false);
  });

  test("LocalHostRunner project helpers", async () => {
    const home = tempHome();
    const runner = new LocalHostRunner(home, "acct");
    await runner.ensure("acct");
    const botId = "bot-a";
    const dir = runner.ensureProject(botId, "Ada");
    expect(dir).toBe(runner.projectDir(botId));
    expect(existsSync(join(dir, ".openbot-bot.json"))).toBe(true);
    runner.deleteProject(botId);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(home, "desk", "projects"))).toBe(true);
  });
});

describe("purge deletes only the bot project dir", () => {
  test("archive keeps files; purge removes the project and leaves siblings", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const adaDir = join(home, "desk", "projects", ada.bot.id);
    const bobDir = join(home, "desk", "projects", bob.bot.id);
    expect(existsSync(adaDir)).toBe(true);
    expect(existsSync(bobDir)).toBe(true);
    writeFileSync(join(adaDir, "notes.txt"), "keep until purge");

    const arch = await fetch(`${origin}/v1/bots/${ada.bot.id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    expect(existsSync(join(adaDir, "notes.txt"))).toBe(true);

    const purged = await fetch(`${origin}/v1/bots/${ada.bot.id}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(purged.status).toBe(200);
    expect(existsSync(adaDir)).toBe(false);
    expect(existsSync(bobDir)).toBe(true);

    await fetch(`${origin}/v1/bots/${bob.bot.id}/archive`, { method: "POST", headers });
    ctx.db.run("UPDATE bots SET archived_at = ? WHERE id = ?", [now() - ARCHIVE_TTL_MS - 1000, bob.bot.id]);
    const afterTtl = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      archived: unknown[];
    };
    expect(afterTtl.archived.length).toBe(0);
    expect(existsSync(bobDir)).toBe(false);
    server.stop(true);
  });
});
