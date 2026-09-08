import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenbotDb, id } from "@openbot/db";
import { createApp } from "../apps/server/src/app.ts";
import {
  currentOrgMeta,
  deriveOrgSlug,
  ensureOrgMeta,
} from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

async function runOpenbot(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawned: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of [
    "OPENBOT_ORG_ID",
    "OPENBOT_ORG_SLUG",
    "OPENBOT_ORG_NAME",
    "OPENBOT_PUBLIC_ORIGIN",
  ] as const) {
    if (env && Object.prototype.hasOwnProperty.call(env, key)) continue;
    delete spawned[key];
  }
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

function openHome(home = tempHome()) {
  const db = OpenbotDb.open(join(home, "openbot.sqlite"));
  return { home, db };
}

describe("org slug derivation", () => {
  test("127.0.0.1, localhost, ipv6, and invalid hostnames become local", () => {
    expect(deriveOrgSlug("http://127.0.0.1:8787")).toBe("local");
    expect(deriveOrgSlug("http://localhost:8787")).toBe("local");
    expect(deriveOrgSlug("http://[::1]:8787")).toBe("local");
    expect(deriveOrgSlug("")).toBe("local");
    expect(deriveOrgSlug("not a url")).toBe("local");
    expect(deriveOrgSlug("http://acme:8787")).toBe("acme");
  });
});

describe("ensureOrgMeta", () => {
  test("fresh home generates org_id and slug local for loopback public origin", () => {
    const { db } = openHome();
    const row = ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    expect(row.org_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(row.slug).toBe("local");
    expect(row.timezone).toBe("UTC");
    expect(row.account_id == null).toBe(true);
    const again = ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    expect(again.org_id).toBe(row.org_id);
    db.close();
  });

  test("localhost public origin also yields slug local", () => {
    const { db } = openHome();
    const row = ensureOrgMeta(db, { advertisedOrigin: "http://localhost:9" });
    expect(row.slug).toBe("local");
    db.close();
  });

  test("OPENBOT_ORG_SLUG and org.json may update a stored slug", () => {
    const { home, db } = openHome();
    const first = ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    expect(first.slug).toBe("local");

    const enved = ensureOrgMeta(db, {
      env: { OPENBOT_ORG_SLUG: "fromenv" },
      advertisedOrigin: "http://127.0.0.1:8787",
    });
    expect(enved.org_id).toBe(first.org_id);
    expect(enved.slug).toBe("fromenv");

    writeFileSync(join(home, "org.json"), JSON.stringify({ slug: "fromfile", name: "From file" }));
    const filed = ensureOrgMeta(db, {
      env: {},
      file: join(home, "org.json"),
      advertisedOrigin: "http://127.0.0.1:8787",
    });
    expect(filed.org_id).toBe(first.org_id);
    expect(filed.slug).toBe("fromfile");
    expect(filed.name).toBe("From file");
    db.close();
  });

  test("OPENBOT_ORG_ID mismatch with stored org_id refuses boot", () => {
    const { home, db } = openHome();
    const row = ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    db.close();
    const other = id();
    expect(() =>
      ensureOrgMeta(OpenbotDb.open(join(home, "openbot.sqlite")), {
        env: { OPENBOT_ORG_ID: other },
        advertisedOrigin: "http://127.0.0.1:8787",
      }),
    ).toThrow(/OPENBOT_ORG_ID/);
    expect(() =>
      createApp({ home, port: 0, env: { OPENBOT_ORG_ID: other } }),
    ).toThrow(/OPENBOT_ORG_ID/);
  });

  test("matching OPENBOT_ORG_ID boots", () => {
    const { home, db } = openHome();
    const row = ensureOrgMeta(db, { advertisedOrigin: "http://127.0.0.1:8787" });
    db.close();
    const created = startTestServer({ home, env: { OPENBOT_ORG_ID: row.org_id } });
    expect(currentOrgMeta(created.ctx.db)?.org_id).toBe(row.org_id);
    created.server.stop(true);
  });

  test("file/stored https origin survives createApp without publicOrigin", () => {
    const { home, db } = openHome();
    writeFileSync(
      join(home, "org.json"),
      JSON.stringify({ slug: "acme", publicOrigin: "https://acme.example.com" }),
    );
    const row = ensureOrgMeta(db, {
      env: {},
      file: join(home, "org.json"),
      advertisedOrigin: "http://127.0.0.1:8787",
    });
    expect(row.public_origin).toBe("https://acme.example.com");
    expect(row.slug).toBe("acme");
    db.close();
    const created = createApp({ home, port: 0, env: {} });
    try {
      expect(currentOrgMeta(created.ctx.db)?.public_origin).toBe("https://acme.example.com");
      expect(created.ctx.publicOrigin).toBe("https://acme.example.com");
    } finally {
      created.stop();
    }
  });

  test("explicit publicOrigin wins over OPENBOT_PUBLIC_ORIGIN", () => {
    const { db } = openHome();
    const row = ensureOrgMeta(db, {
      env: { OPENBOT_PUBLIC_ORIGIN: "https://from-env.example" },
      publicOrigin: "https://from-flag.example",
      advertisedOrigin: "http://127.0.0.1:8787",
      slug: "acme",
    });
    expect(row.public_origin).toBe("https://from-flag.example");
    db.close();
  });
});

describe("org HTTP", () => {
  test("legacy federation transport routes are removed", async () => {
    const { server, origin, ctx } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const statuses = {
        info: (await fetch(`${origin}/fed/v1/info`)).status,
        messages: (await fetch(`${origin}/fed/v1/messages`, { method: "POST", body: "{}" })).status,
        inbox: (await fetch(`${origin}/v1/org/inbox`, { headers })).status,
        peers: (await fetch(`${origin}/v1/org/peers`, { headers })).status,
        peerDiscovery: (
          await fetch(`${origin}/v1/org/peers/from-info`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      };
      expect(statuses).toEqual({ info: 404, messages: 404, inbox: 404, peers: 404, peerDiscovery: 404 });
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/readyz stays { ok, home, desk } without orgId", async () => {
    const home = tempHome();
    const { server, origin } = startTestServer({ home });
    const res = await fetch(`${origin}/v1/readyz`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.home).toBe(home);
    expect(json.desk).toBe(join(home, "desk"));
    expect(json).not.toHaveProperty("orgId");
    expect(Object.keys(json).sort()).toEqual(["desk", "home", "ok"]);
    server.stop(true);
  });

  test("GET /v1/org is 401 without session and 200 with loginCookie", async () => {
    const { server, origin, ctx } = startTestServer({ home: tempHome() });
    const anon = await fetch(`${origin}/v1/org`);
    expect(anon.status).toBe(401);
    const { cookie } = loginCookie({ ctx }, "alice");
    const authed = await fetch(`${origin}/v1/org`, { headers: { cookie } });
    expect(authed.status).toBe(200);
    const json = (await authed.json()) as {
      orgId: string;
      slug: string;
      name: string;
      publicOrigin: string | null;
      timezone: string;
    };
    const row = currentOrgMeta(ctx.db)!;
    expect(json.orgId).toBe(row.org_id);
    expect(json.slug).toBe(row.slug);
    expect(json.timezone).toBe("UTC");
    expect(json).not.toHaveProperty("federationEnabled");
    expect(json).not.toHaveProperty("pubkey");
    expect(json).not.toHaveProperty("gateway");
    server.stop(true);
  });

  test("PATCH /v1/org timezone is IANA, default UTC, and unknown keys are rejected atomically", async () => {
    const { server, origin, ctx } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const before = (await fetch(`${origin}/v1/org`, { headers }).then((r) => r.json())) as { timezone: string };
    expect(before.timezone).toBe("UTC");
    const bad = await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ timezone: "Not/A_Zone" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_timezone");
    expect(currentOrgMeta(ctx.db)?.timezone).toBe("UTC");
    const unknown = await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ timezone: "America/New_York", ignored: true }),
    });
    expect(unknown.status).toBe(400);
    expect(currentOrgMeta(ctx.db)?.timezone).toBe("UTC");
    const on = await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(on.status).toBe(200);
    const stored = (await on.json()) as { timezone: string };
    expect(stored.timezone).toBe("America/New_York");
    expect(stored).not.toHaveProperty("federationEnabled");
    expect(stored).not.toHaveProperty("pubkey");
    expect(currentOrgMeta(ctx.db)?.timezone).toBe("America/New_York");
    server.stop(true);
  });
});

describe("openbot org CLI", () => {
  test("openbot org works with zero users", async () => {
    const home = tempHome();
    const { stdout, stderr, code } = await runOpenbot(["org", "--home", home]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const json = JSON.parse(stdout.trim()) as {
      orgId: string;
      slug: string;
      gateway?: unknown;
    };
    expect(json.orgId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(json.slug).toBe("local");
    expect(json).not.toHaveProperty("federationEnabled");
    expect(json).not.toHaveProperty("pubkey");
    expect(json).not.toHaveProperty("gateway");
    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    expect(db.all("SELECT id FROM users").length).toBe(0);
    db.close();
  });

  test("openbot org init --slug acme persists", async () => {
    const home = tempHome();
    const init = await runOpenbot(["org", "init", "--home", home, "--slug", "acme", "--name", "Acme"]);
    expect(init.code).toBe(0);
    const written = JSON.parse(init.stdout.trim()) as { slug: string; name: string; orgId: string };
    expect(written.slug).toBe("acme");
    expect(written.name).toBe("Acme");
    expect(existsSync(join(home, "org.json"))).toBe(true);
    const file = JSON.parse(readFileSync(join(home, "org.json"), "utf8")) as { slug: string; orgId: string };
    expect(file.slug).toBe("acme");
    expect(file.orgId).toBe(written.orgId);

    const show = await runOpenbot(["org", "--home", home]);
    expect(show.code).toBe(0);
    const json = JSON.parse(show.stdout.trim()) as { slug: string; name: string; orgId: string };
    expect(json.slug).toBe("acme");
    expect(json.name).toBe("Acme");
    expect(json.orgId).toBe(written.orgId);
  });

  test("org init --slug updates org.json so a later show does not revert", async () => {
    const home = tempHome();
    const first = await runOpenbot(["org", "init", "--home", home, "--slug", "acme", "--name", "Acme"]);
    expect(first.code).toBe(0);
    const acme = JSON.parse(first.stdout.trim()) as { orgId: string; slug: string };
    const second = await runOpenbot(["org", "init", "--home", home, "--slug", "beta", "--name", "Beta"]);
    expect(second.code).toBe(0);
    const beta = JSON.parse(second.stdout.trim()) as { orgId: string; slug: string; name: string };
    expect(beta.orgId).toBe(acme.orgId);
    expect(beta.slug).toBe("beta");
    expect(beta.name).toBe("Beta");
    const file = JSON.parse(readFileSync(join(home, "org.json"), "utf8")) as { slug: string; orgId: string };
    expect(file.slug).toBe("beta");
    expect(file.orgId).toBe(acme.orgId);
    const show = await runOpenbot(["org", "--home", home]);
    expect(show.code).toBe(0);
    const json = JSON.parse(show.stdout.trim()) as { slug: string; name: string; orgId: string };
    expect(json.slug).toBe("beta");
    expect(json.name).toBe("Beta");
    expect(json.orgId).toBe(acme.orgId);
  });

  test("org init --slug rejects invalid slugs", async () => {
    const home = tempHome();
    const bad = await runOpenbot(["org", "init", "--home", home, "--slug", "Acme_Corp"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("invalid org slug");
    const fqdn = await runOpenbot(["org", "init", "--home", home, "--slug", "acme.example.com"]);
    expect(fqdn.code).not.toBe(0);
  });

  test("openbot demo does not persist listen origin over org.json", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "org.json"),
      JSON.stringify({ slug: "acme", name: "Acme", publicOrigin: "https://acme.example.com" }),
    );
    const spawned: Record<string, string | undefined> = { ...process.env };
    delete spawned.OPENBOT_PUBLIC_ORIGIN;
    delete spawned.OPENBOT_ORG_ID;
    delete spawned.OPENBOT_ORG_SLUG;
    const proc = Bun.spawn({
      cmd: [process.execPath, cli, "demo", "--fake", "--home", home, "--port", "0"],
      stdout: "pipe",
      stderr: "pipe",
      env: spawned,
    });
    try {
      const stdout = proc.stdout ? await readUntil(proc.stdout, "openbot demo") : "";
      expect(stdout).toContain("openbot demo");
      const db = OpenbotDb.open(join(home, "openbot.sqlite"));
      const row = currentOrgMeta(db);
      expect(row?.public_origin).toBe("https://acme.example.com");
      expect(row?.slug).toBe("acme");
      db.close();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

async function readUntil(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const { done, value } = await reader.read();
    if (value) text += new TextDecoder().decode(value);
    if (text.includes(needle) || done) return text;
  }
  return text;
}
