import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitTurn(origin: string, headers: Record<string, string>, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string; role: string }>;
    };
    const done = t.messages.some((m) => m.role === "assistant" || m.origin === "system" || m.origin === "fallback");
    if (done) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("turn timeout");
}

describe("ACP session on the desk (fake agent)", () => {
  test("user message runs with cwd = bot project dir; native file work; tab close does not cancel", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", description: "d" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const botId = created.bot.id;
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-testkey0001" }),
    });
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const filename = "desk-proof.txt";
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: `[[write:${filename}]] [[cwd]]` }),
    });
    expect(posted.status).toBe(202);
    const { turnId } = (await posted.json()) as { turnId: string };
    const messages = await waitTurn(origin, headers);
    const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) =>
      r.json(),
    )) as { events: Array<{ kind: string }> };
    expect(live.events.length).toBeGreaterThan(0);
    const projectDir = join(home, "desk", "projects", botId);
    const deskFile = join(projectDir, filename);
    expect(existsSync(deskFile)).toBe(true);
    expect(existsSync(join(home, "desk", filename))).toBe(false);
    const contents = readFileSync(deskFile, "utf8");
    expect(contents).toContain(projectDir);
    expect(messages.some((m) => m.origin === "send_message" && m.body.includes(`projects/${botId}`))).toBe(
      true,
    );

    const posted2 = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[sleep:400]] [[send:still running after client gone]]" }),
    });
    expect(posted2.status).toBe(202);
    const messages2 = await waitTurn(origin, headers);
    expect(messages2.some((m) => m.body.includes("still running after client gone"))).toBe(true);
    server.stop(true);
  });
});
