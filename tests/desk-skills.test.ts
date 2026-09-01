import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeIdentityRules, deskIdentityRules, gatewayIdentityRules } from "@openbot/acp-grok";
import type { EnsureHarnessRequest } from "@openbot/compute-protocol";
import { mcpToolsForRole } from "@openbot/mcp-send-message";
import {
  CONFIRM_SERIES_SKILL_MD,
  DESK_SKILL_NAME_CAP,
  LocalHostRunner,
  SHARED_CHROMIUM_SKILL_MD,
  ensureDeskSkills,
  listDeskSkillNames,
} from "@openbot/runner";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { fakeAgentCommand, tempHome } from "./helpers.ts";

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
    skillNames: ["confirm-series", "shared-chromium"],
    ...partial,
  };
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

function writeSkill(desk: string, name: string, body = "---\nname: x\n---\nbody\n"): void {
  const dir = join(desk, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("ensureDeskSkills", () => {
  test("write-if-absent seeds confirm-series and shared-chromium", () => {
    const desk = join(tempHome(), "desk");
    ensureDeskSkills(desk);
    const confirm = join(desk, "skills", "confirm-series", "SKILL.md");
    const chromium = join(desk, "skills", "shared-chromium", "SKILL.md");
    expect(readFileSync(confirm, "utf8")).toBe(CONFIRM_SERIES_SKILL_MD);
    expect(readFileSync(chromium, "utf8")).toBe(SHARED_CHROMIUM_SKILL_MD);
    expect(readFileSync(join(desk, "skills", "README.md"), "utf8")).toContain("not a jail");
    writeFileSync(confirm, "handwritten\n");
    ensureDeskSkills(desk);
    expect(readFileSync(confirm, "utf8")).toBe("handwritten\n");
    expect(readFileSync(chromium, "utf8")).toBe(SHARED_CHROMIUM_SKILL_MD);
  });

  test("wipeDesk re-seeds", async () => {
    const home = tempHome();
    const runner = new LocalHostRunner(home, "acct");
    await runner.ensure("acct");
    const confirm = join(home, "desk", "skills", "confirm-series", "SKILL.md");
    writeFileSync(confirm, "handwritten\n");
    await runner.wipeDesk();
    expect(readFileSync(confirm, "utf8")).toBe(CONFIRM_SERIES_SKILL_MD);
    expect(existsSync(join(home, "desk", "skills", "shared-chromium", "SKILL.md"))).toBe(true);
  });
});

describe("listDeskSkillNames", () => {
  test("two skill dirs created in either order produce the same join", () => {
    const deskA = join(tempHome(), "desk");
    const deskB = join(tempHome(), "desk");
    writeSkill(deskA, "shared-chromium");
    writeSkill(deskA, "confirm-series");
    writeSkill(deskB, "confirm-series");
    writeSkill(deskB, "shared-chromium");
    const a = listDeskSkillNames(deskA);
    const b = listDeskSkillNames(deskB);
    expect(a).toEqual(["confirm-series", "shared-chromium"]);
    expect(b).toEqual(a);
    expect(a.join(",")).toBe("confirm-series,shared-chromium");
    expect(b.join(",")).toBe(a.join(","));
  });

  test("catalog cap 32 after ASCII sort; skips invalid names and missing SKILL.md", () => {
    const home = tempHome();
    const desk = join(home, "desk");
    for (let i = 0; i < 40; i++) writeSkill(desk, `skill-${String(i).padStart(2, "0")}`);
    writeSkill(desk, "NotValid");
    mkdirSync(join(desk, "skills", "no-body"), { recursive: true });
    const names = listDeskSkillNames(desk, 32);
    expect(names).toHaveLength(DESK_SKILL_NAME_CAP);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("skill-00");
    expect(names.at(-1)).toBe("skill-31");
    expect(names).not.toContain("skill-32");
    expect(names).not.toContain("NotValid");
    expect(names).not.toContain("no-body");
    const runner = new LocalHostRunner(home, "acct");
    expect(runner.listDeskSkillNames(32).join(",")).toBe(names.join(","));
  });
});

describe("overlay catalog", () => {
  test("desk overlay has names not bodies; Gateway has no catalog", () => {
    const desk = composeIdentityRules(harnessReq());
    expect(desk).toContain("confirm-series");
    expect(desk).toContain("shared-chromium");
    expect(desk).toContain("Skills (names only");
    expect(desk).toContain("SOUL.md");
    expect(desk).toMatch(/do not write skills unless asked/i);
    expect(desk).toContain("Operator ~/.grok skills are not loaded.");
    expect(desk).not.toContain("When the human agrees in this thread, call ConfirmSeries with that seriesId");
    expect(desk).not.toContain("Snapshot is how you see your page");
    expect(desk).not.toContain(CONFIRM_SERIES_SKILL_MD);
    expect(desk).not.toContain(SHARED_CHROMIUM_SKILL_MD);

    const gw = composeIdentityRules(
      harnessReq({ role: "gateway", orgSlug: "alpha", orgId: "org-id", botName: "Gateway" }),
    );
    expect(gw).toContain("You are Gateway for org alpha (org-id)");
    expect(gw).toMatch(/do not follow desk\/skills/i);
    expect(gw).not.toContain("confirm-series");
    expect(gw).not.toContain("shared-chromium");
    expect(gw).not.toContain("Skills (names only");
    expect(gw).not.toContain("SOUL.md");
    expect(gatewayIdentityRules("alpha", "org-id")).not.toContain("confirm-series");
    expect(deskIdentityRules("Ada", "research", { skillNames: ["zebra"] })).toContain("zebra");
    expect(deskIdentityRules("Ada", "research", { skillNames: ["zebra"] })).not.toContain("confirm-series, shared-chromium");
  });

  test("tools/list is unchanged and has no ListSkills", () => {
    const deskNames = mcpToolsForRole("desk").map((t) => (t as { name: string }).name);
    const gwNames = mcpToolsForRole("gateway").map((t) => (t as { name: string }).name);
    expect(deskNames).not.toContain("ListSkills");
    expect(gwNames).not.toContain("ListSkills");
    expect(deskNames).toEqual([
      "SendMessage",
      "SendToAgent",
      "SendToThread",
      "ListBots",
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
  });

  test("echo-rules contains confirm-series; cwd-relative skill read works; no native skills dir or SOUL.md", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const { ctx, server, origin } = startTestServer({ home });
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
        body: JSON.stringify({ key: "xai-skillkey0001" }),
      });
      const project = join(home, "desk", "projects", ada.bot.id);
      mkdirSync(join(project, ".grok", "skills"), { recursive: true });
      writeFileSync(join(project, ".grok", "skills", "leak.md"), "nope\n");
      expect(existsSync(join(project, "SOUL.md"))).toBe(false);

      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: "[[echo-rules]] [[readfile:../../skills/confirm-series/SKILL.md]]",
        }),
      });
      expect(posted.status).toBe(202);
      const messages = await waitMessages(origin, headers, (msgs) => {
        const bodies = sendBodies(msgs);
        return (
          bodies.some((b) => b.includes("confirm-series") && b.includes("You are Ada")) &&
          bodies.some((b) => b.includes("When the human agrees in this thread"))
        );
      });
      const bodies = sendBodies(messages);
      const rulesEcho = bodies.find((b) => b.includes("You are Ada")) ?? "";
      expect(rulesEcho).toContain("confirm-series");
      expect(rulesEcho).toContain("shared-chromium");
      expect(rulesEcho).not.toContain("When the human agrees in this thread, call ConfirmSeries with that seriesId");
      expect(rulesEcho).not.toContain("Snapshot is how you see your page");
      const skillEcho = bodies.find((b) => b.includes("When the human agrees in this thread")) ?? "";
      expect(skillEcho).toContain("name: confirm-series");
      expect(skillEcho).toBe(CONFIRM_SERIES_SKILL_MD);

      expect(existsSync(join(project, ".grok", "skills"))).toBe(false);
      expect(existsSync(join(project, "SOUL.md"))).toBe(false);
      expect(ctx.engine.runnerFor(session.accountId).listDeskSkillNames(32)).toEqual([
        "confirm-series",
        "shared-chromium",
      ]);
    } finally {
      server.stop(true);
    }
  });
});
