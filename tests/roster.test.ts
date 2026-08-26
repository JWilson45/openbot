import { describe, expect, test } from "bun:test";
import { ARCHIVE_TTL_MS, now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("roster", () => {
  test("up to 6 active bots, unique names, archive frees a slot", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created: string[] = [];
    for (const name of ["Ada", "Bob", "Cara", "Dan", "Eve", "Fay"]) {
      const res = await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, description: name }),
      });
      expect(res.status).toBe(200);
      created.push(((await res.json()) as { bot: { id: string } }).bot.id);
    }
    const seventh = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gus" }),
    });
    expect(seventh.status).toBe(409);
    expect(((await seventh.json()) as { error: string }).error).toBe("cap");
    const dup = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(dup.status).toBe(409);
    const list = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: Array<{ name: string }>;
    };
    expect(list.bots.length).toBe(6);
    const arch = await fetch(`${origin}/v1/bots/${created[0]}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    const again = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gus" }),
    });
    expect(again.status).toBe(200);
    const adaThread = await fetch(`${origin}/v1/threads?botId=${created[1]}`, { headers });
    expect(adaThread.status).toBe(200);
    const t = (await adaThread.json()) as { thread: { bot_id: string } };
    expect(t.thread.bot_id).toBe(created[1]);
    const wipeBad = await fetch(`${origin}/v1/compute`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirm: "nope" }),
    });
    expect(wipeBad.status).toBe(400);
    const wipe = await fetch(`${origin}/v1/compute/wipe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "delete" }),
    });
    expect(wipe.status).toBe(200);
    server.stop(true);
  });

  test("archive is reversible; permanent delete is archived-only; expired archives purge", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const id = created.bot.id;

    const delActive = await fetch(`${origin}/v1/bots/${id}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(delActive.status).toBe(409);

    const arch = await fetch(`${origin}/v1/bots/${id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: unknown[];
      archived: Array<{ id: string; name: string }>;
    };
    expect(listed.bots.length).toBe(0);
    expect(listed.archived.some((b) => b.id === id)).toBe(true);

    const restored = await fetch(`${origin}/v1/bots/${id}/restore`, { method: "POST", headers });
    expect(restored.status).toBe(200);
    expect(
      ((await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as { bots: unknown[] }).bots.length,
    ).toBe(1);

    await fetch(`${origin}/v1/bots/${id}/archive`, { method: "POST", headers });
    const gone = await fetch(`${origin}/v1/bots/${id}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(gone.status).toBe(200);
    expect(
      ((await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as { archived: unknown[] }).archived
        .length,
    ).toBe(0);

    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    await fetch(`${origin}/v1/bots/${bob.bot.id}/archive`, { method: "POST", headers });
    ctx.db.run("UPDATE bots SET archived_at = ? WHERE id = ?", [now() - ARCHIVE_TTL_MS - 1000, bob.bot.id]);
    const afterTtl = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      archived: unknown[];
    };
    expect(afterTtl.archived.length).toBe(0);
    server.stop(true);
  });
});
