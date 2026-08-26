import { describe, expect, test } from "bun:test";
import { OpenbotDb } from "@openbot/db";
import { join } from "node:path";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type ApiKeyMinted = { id: string; name: string; token: string; prefix: string; lastFour: string };
type ApiKeyList = {
  keys: Array<{ id: string; name: string; prefix: string; lastFour: string; createdAt: number; lastUsedAt: number | null; token?: string }>;
};
type OpenAiErrorBody = { error: { message: string; type: string; code: string } };
type ModelsList = { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
type ChatCompletion = {
  id: string;
  object: string;
  model: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
};

async function mintKey(origin: string, cookie: string, name = "owui"): Promise<ApiKeyMinted> {
  const res = await fetch(`${origin}/v1/api-keys`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ApiKeyMinted;
}

async function setupAda(
  origin: string,
  cookie: string,
): Promise<void> {
  const headers = { cookie, "content-type": "application/json" };
  const bot = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ada" }),
  });
  expect(bot.status).toBe(200);
  const cred = await fetch(`${origin}/v1/credentials/xai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key: "xai-compatkey01" }),
  });
  expect(cred.status).toBe(200);
}

describe("openai-compatible api", () => {
  test("cookie session can mint, list, and revoke api keys", async () => {
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const minted = await mintKey(origin, cookie, "open-webui");
      expect(minted.token.startsWith("sk-ob_")).toBe(true);
      expect(minted.prefix.startsWith("sk-ob_")).toBe(true);
      expect(minted.lastFour).toBe(minted.token.slice(-4));
      expect(minted.name).toBe("open-webui");

      const listRes = await fetch(`${origin}/v1/api-keys`, { headers });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as ApiKeyList;
      expect(list.keys.length).toBe(1);
      expect(list.keys[0]?.id).toBe(minted.id);
      expect(list.keys[0]?.prefix).toBe(minted.prefix);
      expect(list.keys[0]?.lastFour).toBe(minted.lastFour);
      expect(list.keys[0]?.token).toBeUndefined();
      expect(JSON.stringify(list)).not.toContain(minted.token);

      const del = await fetch(`${origin}/v1/api-keys/${minted.id}`, { method: "DELETE", headers });
      expect(del.status).toBe(200);
      const after = (await fetch(`${origin}/v1/api-keys`, { headers }).then((r) => r.json())) as ApiKeyList;
      expect(after.keys.length).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/models without auth is 401 OpenAI error", async () => {
    const { server, origin } = startTestServer({ home: tempHome() });
    try {
      const res = await fetch(`${origin}/v1/models`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as OpenAiErrorBody;
      expect(body.error).toBeTruthy();
      expect(body.error.type).toBe("authentication_error");
      expect(typeof body.error.message).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/models with api key lists openbot/Ada", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const res = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ModelsList;
      expect(body.object).toBe("list");
      const ids = body.data.map((m) => m.id);
      expect(ids).toContain("openbot/Ada");
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/models lists openbot/Gateway and UUID; GET /v1/bots.bots does not", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const roster = (await fetch(`${origin}/v1/bots`, { headers: { cookie } }).then((r) => r.json())) as {
        bots: Array<{ id: string; name: string }>;
        gateway: { id: string; name: string } | null;
      };
      expect(roster.gateway).toBeTruthy();
      expect(roster.bots.map((b) => b.name)).toContain("Ada");
      expect(roster.bots.some((b) => b.id === roster.gateway!.id || b.name === roster.gateway!.name)).toBe(false);

      const res = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as ModelsList).data.map((m) => m.id);
      expect(ids).toContain("openbot/Ada");
      expect(ids).toContain(`openbot/${roster.gateway!.name}`);
      expect(ids).toContain(roster.gateway!.id);
    } finally {
      server.stop(true);
    }
  });

  test("OPTIONS /v1/chat/completions returns CORS allow headers", async () => {
    const { server, origin } = startTestServer({ home: tempHome() });
    try {
      const res = await fetch(`${origin}/v1/chat/completions`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
      expect(res.headers.get("access-control-allow-methods")?.toLowerCase()).toContain("post");
    } finally {
      server.stop(true);
    }
  });

  test("POST /v1/chat/completions with api key returns send_message text", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const res = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openbot/Ada",
          messages: [{ role: "user", content: "[[send:compat-ok]]" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatCompletion;
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0]?.message.content).toContain("compat-ok");
      expect(body.choices[0]?.finish_reason).toBe("stop");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("POST /openai/v1/chat/completions alias works", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const res = await fetch(`${origin}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openbot/Ada",
          messages: [{ role: "user", content: "[[send:compat-ok]]" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatCompletion;
      expect(body.choices[0]?.message.content).toContain("compat-ok");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("stream: true includes data: [DONE] and send_message text", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const res = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openbot/Ada",
          stream: true,
          messages: [{ role: "user", content: "[[send:compat-ok]]" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data: [DONE]");
      expect(text).toContain("compat-ok");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("unknown model is 404 OpenAI error", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      await setupAda(origin, cookie);
      const minted = await mintKey(origin, cookie);
      const res = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openbot/Nope",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as OpenAiErrorBody;
      expect(body.error.type).toBe("not_found_error");
    } finally {
      server.stop(true);
    }
  });

  test("api_keys table exists after OpenbotDb.open", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    expect(names).toContain("api_keys");
    db.close();
  });
});
