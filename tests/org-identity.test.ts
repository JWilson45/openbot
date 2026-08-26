import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenbotDb, id } from "@openbot/db";
import { createApp } from "../apps/server/src/app.ts";
import {
  clientRateKey,
  currentOrgMeta,
  deriveOrgSlug,
  ensureOrgMeta,
  FED_INFO_RATE_LIMIT,
  FED_INFO_RATE_WINDOW_MS,
  SlidingWindowRateLimiter,
} from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

async function runOpenbot(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawned: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of ["OPENBOT_ORG_ID", "OPENBOT_ORG_SLUG", "OPENBOT_ORG_NAME", "OPENBOT_PUBLIC_ORIGIN"] as const) {
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
    expect(row.federation_enabled).toBe(0);
    expect(row.pubkey).toBe("");
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
  test("GET /fed/v1/info is public, gateway null, federation off, empty pubkey", async () => {
    const { server, origin, ctx } = startTestServer({
      home: tempHome(),
      publicOrigin: "http://127.0.0.1:8787",
    });
    const res = await fetch(`${origin}/fed/v1/info`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      orgId: string;
      slug: string;
      pubkey: string;
      gateway: unknown;
      caps: { protocol: string; federation: string; hopLimit: number; attachments: boolean };
    };
    const row = currentOrgMeta(ctx.db)!;
    expect(json.orgId).toBe(row.org_id);
    expect(json.slug).toBe("local");
    expect(json.gateway).toBeNull();
    expect(json.caps.federation).toBe("off");
    expect(json.caps.protocol).toBe("openbot-fed/1");
    expect(json.caps.hopLimit).toBe(1);
    expect(json.caps.attachments).toBe(false);
    expect(json.pubkey === "" || json.pubkey == null).toBe(true);
    server.stop(true);
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
      federationEnabled: boolean;
    };
    const row = currentOrgMeta(ctx.db)!;
    expect(json.orgId).toBe(row.org_id);
    expect(json.slug).toBe(row.slug);
    expect(json.federationEnabled).toBe(false);
    expect(json).not.toHaveProperty("gateway");
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
      federationEnabled: boolean;
      gateway: unknown;
    };
    expect(json.orgId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(json.slug).toBe("local");
    expect(json.federationEnabled).toBe(false);
    expect(json.gateway).toBeNull();
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
});

describe("fed info rate limit helper", () => {
  test("31st request in a minute is denied; X-Forwarded-For only from loopback", () => {
    let t = 1_000_000;
    const limiter = new SlidingWindowRateLimiter(FED_INFO_RATE_LIMIT, FED_INFO_RATE_WINDOW_MS, () => t);
    const key = "203.0.113.9";
    for (let i = 0; i < FED_INFO_RATE_LIMIT; i++) expect(limiter.take(key)).toBe(true);
    expect(limiter.take(key)).toBe(false);
    t += FED_INFO_RATE_WINDOW_MS;
    expect(limiter.take("other")).toBe(true);
    expect(limiter.size).toBe(1);
    expect(limiter.take(key)).toBe(true);

    expect(clientRateKey("127.0.0.1", "203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(clientRateKey("::1", "198.51.100.2")).toBe("198.51.100.2");
    expect(clientRateKey("8.8.8.8", "203.0.113.9")).toBe("8.8.8.8");
    expect(clientRateKey("192.0.2.1", "203.0.113.9")).toBe("192.0.2.1");
  });
});
