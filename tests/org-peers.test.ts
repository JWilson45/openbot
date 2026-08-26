import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateEd25519 } from "@openbot/federation";
import { id } from "@openbot/db";
import { mintApiKey } from "@openbot/auth";
import {
  deleteOrgPeer,
  disableOrgPeer,
  fetchPeerFedInfo,
  getOrgPeer,
  insertOrgPeer,
  listOrgPeers,
  OrgPeerError,
  parsePeerBaseUrl,
} from "../apps/server/src/org.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

async function runOpenbot(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawned: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of ["OPENBOT_ORG_ID", "OPENBOT_ORG_SLUG", "OPENBOT_ORG_NAME", "OPENBOT_PUBLIC_ORIGIN", "OPENBOT_FED_ALLOW_HTTP"] as const) {
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

function expectPeerUrlThrows(raw: string, env?: Record<string, string | undefined>) {
  try {
    parsePeerBaseUrl(raw, env ?? {});
    throw new Error(`expected reject ${raw}`);
  } catch (err) {
    expect(err).toBeInstanceOf(OrgPeerError);
    expect((err as OrgPeerError).code).toBe("invalid_peer_url");
  }
}

describe("peer URL policy", () => {
  test("https origin stored without path; loopback http allowed", () => {
    expect(parsePeerBaseUrl("https://beta.example.com/fed/v1/info", {})).toBe("https://beta.example.com");
    expect(parsePeerBaseUrl("https://beta.example.com:8443/x", {})).toBe("https://beta.example.com:8443");
    expect(parsePeerBaseUrl("http://127.0.0.1:8787/peers", {})).toBe("http://127.0.0.1:8787");
    expect(parsePeerBaseUrl("http://localhost:9/", {})).toBe("http://localhost:9");
    expect(parsePeerBaseUrl("http://[::1]:8787", {})).toBe("http://[::1]:8787");
  });

  test("blocks link-local, metadata, unspecified, and non-loopback http", () => {
    expectPeerUrlThrows("http://example.com");
    expectPeerUrlThrows("http://192.168.1.9");
    expectPeerUrlThrows("http://10.0.0.1");
    expectPeerUrlThrows("http://169.254.169.254");
    expectPeerUrlThrows("https://169.254.169.254");
    expectPeerUrlThrows("http://169.254.1.1:8080");
    expectPeerUrlThrows("http://[fe80::1]");
    expectPeerUrlThrows("https://[fe80::abcd]");
    expectPeerUrlThrows("http://[fd00:ec2::254]");
    expectPeerUrlThrows("https://[fd00:ec2::254]");
    expectPeerUrlThrows("http://0.0.0.0");
    expectPeerUrlThrows("https://0.0.0.0");
    expectPeerUrlThrows("javascript:alert(1)");
    expectPeerUrlThrows("file:///etc/passwd");
    expect(parsePeerBaseUrl("http://192.168.1.9", { OPENBOT_FED_ALLOW_HTTP: "1" })).toBe("http://192.168.1.9");
    expect(parsePeerBaseUrl("http://10.1.2.3", { OPENBOT_FED_ALLOW_HTTP: "1" })).toBe("http://10.1.2.3");
    expect(parsePeerBaseUrl("http://172.16.0.1", { OPENBOT_FED_ALLOW_HTTP: "1" })).toBe("http://172.16.0.1");
    expectPeerUrlThrows("http://172.15.0.1", { OPENBOT_FED_ALLOW_HTTP: "1" });
    expectPeerUrlThrows("http://8.8.8.8", { OPENBOT_FED_ALLOW_HTTP: "1" });
    expectPeerUrlThrows("https://2852039166");
    expectPeerUrlThrows("https://[64:ff9b::a9fe:a9fe]");
    expectPeerUrlThrows("https://[64:ff9b::169.254.169.254]");
  });

  test("from-info rejects names that resolve to metadata/NAT64/link-local", async () => {
    const lookup =
      (address: string, family: number): ((hostname: string) => Promise<Array<{ address: string; family: number }>>) =>
      async () => [{ address, family }];
    await expect(
      fetchPeerFedInfo("https://imds.test", { lookup: lookup("169.254.169.254", 4) }),
    ).rejects.toMatchObject({ code: "invalid_peer_url" });
    await expect(
      fetchPeerFedInfo("https://imds.test", { lookup: lookup("64:ff9b::a9fe:a9fe", 6) }),
    ).rejects.toMatchObject({ code: "invalid_peer_url" });
    await expect(
      fetchPeerFedInfo("https://imds.test", { lookup: lookup("fe80::1", 6) }),
    ).rejects.toMatchObject({ code: "invalid_peer_url" });
    await expect(
      fetchPeerFedInfo("https://imds.test", { lookup: lookup("fd00:ec2::254", 6) }),
    ).rejects.toMatchObject({ code: "invalid_peer_url" });
    await expect(
      fetchPeerFedInfo("https://imds.test", {
        lookup: async () => [
          { address: "203.0.113.9", family: 4 },
          { address: "169.254.1.1", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_peer_url" });
  });
});

describe("org peers HTTP", () => {
  test("cookie CRUD, unique slug, disable, JSON 400, API key rejected", async () => {
    const { server, origin, ctx } = startTestServer({ home: tempHome(), env: {} });
    try {
      const anon = await fetch(`${origin}/v1/org/peers`);
      expect(anon.status).toBe(401);

      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const kp = generateEd25519();
      const orgId = id();
      const created = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "beta",
          orgId,
          baseUrl: "https://beta.example.com/ignored/path",
          pubkey: kp.publicKeyRawB64,
          name: "Beta",
        }),
      });
      expect(created.status).toBe(200);
      const peer = (await created.json()) as {
        orgId: string;
        slug: string;
        baseUrl: string;
        pubkey: string;
        status: string;
        name: string;
      };
      expect(peer.orgId).toBe(orgId);
      expect(peer.slug).toBe("beta");
      expect(peer.baseUrl).toBe("https://beta.example.com");
      expect(peer.pubkey).toBe(kp.publicKeyRawB64);
      expect(peer.status).toBe("allowed");
      expect(peer.name).toBe("Beta");

      const dup = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "beta",
          orgId: id(),
          baseUrl: "https://other.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(dup.status).toBe(409);
      expect(((await dup.json()) as { error: string }).error).toBe("duplicate_slug");

      const dupOrg = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "gamma",
          orgId,
          baseUrl: "https://gamma.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(dupOrg.status).toBe(409);
      expect(((await dupOrg.json()) as { error: string }).error).toBe("duplicate_org");

      const listed = await fetch(`${origin}/v1/org/peers`, { headers: { cookie } });
      expect(listed.status).toBe(200);
      const listJson = (await listed.json()) as { peers: typeof peer[] };
      expect(listJson.peers.length).toBe(1);

      const disabled = await fetch(`${origin}/v1/org/peers/${orgId}/disable`, { method: "POST", headers: { cookie } });
      expect(disabled.status).toBe(200);
      expect(((await disabled.json()) as { status: string }).status).toBe("disabled");

      const badJson = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: "{",
      });
      expect(badJson.status).toBe(400);

      const ssrf = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "meta",
          orgId: id(),
          baseUrl: "http://169.254.169.254",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(ssrf.status).toBe(400);

      const minted = mintApiKey(ctx.db, session.accountId, "owui");
      const byKey = await fetch(`${origin}/v1/org/peers`, {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(byKey.status).toBe(401);

      const bySessionBearer = await fetch(`${origin}/v1/org/peers`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(bySessionBearer.status).toBe(200);

      const del = await fetch(`${origin}/v1/org/peers/${orgId}`, { method: "DELETE", headers: { cookie } });
      expect(del.status).toBe(200);
      const after = (await fetch(`${origin}/v1/org/peers`, { headers: { cookie } }).then((r) => r.json())) as {
        peers: unknown[];
      };
      expect(after.peers.length).toBe(0);

      const missing = await fetch(`${origin}/v1/org/peers/${orgId}`, { method: "DELETE", headers: { cookie } });
      expect(missing.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("uppercase orgId disables and deletes the stored row", async () => {
    const { server, origin, ctx } = startTestServer({ home: tempHome(), env: {} });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const disableId = id();
      const created = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "beta",
          orgId: disableId,
          baseUrl: "https://beta.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(created.status).toBe(200);
      const disabled = await fetch(`${origin}/v1/org/peers/${disableId.toUpperCase()}/disable`, {
        method: "POST",
        headers: { cookie },
      });
      expect(disabled.status).toBe(200);
      expect(((await disabled.json()) as { status: string }).status).toBe("disabled");
      expect(getOrgPeer(ctx.db, disableId)?.status).toBe("disabled");
      expect(disableOrgPeer(ctx.db, disableId.toUpperCase())?.status).toBe("disabled");

      const deleteId = id();
      const createdDel = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "gamma",
          orgId: deleteId,
          baseUrl: "https://gamma.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(createdDel.status).toBe(200);
      expect(deleteOrgPeer(ctx.db, deleteId.toUpperCase())).toBe(true);
      expect(getOrgPeer(ctx.db, deleteId)).toBeUndefined();

      const httpDelId = id();
      const createdHttpDel = await fetch(`${origin}/v1/org/peers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "delta",
          orgId: httpDelId,
          baseUrl: "https://delta.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        }),
      });
      expect(createdHttpDel.status).toBe(200);
      const del = await fetch(`${origin}/v1/org/peers/${httpDelId.toUpperCase()}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(200);
      expect(getOrgPeer(ctx.db, httpDelId)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("from-info previews loopback /fed/v1/info and does not insert", async () => {
    const peer = startTestServer({ home: tempHome(), env: {} });
    const admin = startTestServer({ home: tempHome(), env: {} });
    try {
      const { cookie } = loginCookie({ ctx: admin.ctx }, "alice");
      const res = await fetch(`${admin.origin}/v1/org/peers/from-info`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: peer.origin }),
      });
      expect(res.status).toBe(200);
      const info = (await res.json()) as { orgId: string; pubkey: string; slug: string };
      expect(info.orgId).toBeTruthy();
      expect(Buffer.from(info.pubkey, "base64").length).toBe(32);
      expect(listOrgPeers(admin.ctx.db).length).toBe(0);

      const blocked = await fetch(`${admin.origin}/v1/org/peers/from-info`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://169.254.169.254" }),
      });
      expect(blocked.status).toBe(400);
    } finally {
      peer.server.stop(true);
      admin.server.stop(true);
    }
  });
});

describe("openbot peers CLI", () => {
  test("add/list/remove with zero users", async () => {
    const home = tempHome();
    const kp = generateEd25519();
    const orgId = id();
    const add = await runOpenbot([
      "peers",
      "add",
      "--home",
      home,
      "--slug",
      "beta",
      "--url",
      "https://beta.example.com/path",
      "--pubkey",
      kp.publicKeyRawB64,
      "--org-id",
      orgId,
      "--name",
      "Beta",
    ]);
    expect(add.code).toBe(0);
    const added = JSON.parse(add.stdout.trim()) as { slug: string; baseUrl: string; orgId: string };
    expect(added.slug).toBe("beta");
    expect(added.baseUrl).toBe("https://beta.example.com");
    expect(added.orgId).toBe(orgId);

    const list = await runOpenbot(["peers", "--home", home]);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout.trim()) as { peers: Array<{ slug: string }> };
    expect(listed.peers.map((p) => p.slug)).toEqual(["beta"]);

    const bad = await runOpenbot([
      "peers",
      "add",
      "--home",
      home,
      "--slug",
      "evil",
      "--url",
      "http://169.254.169.254",
      "--pubkey",
      kp.publicKeyRawB64,
      "--org-id",
      id(),
    ]);
    expect(bad.code).not.toBe(0);

    const remove = await runOpenbot(["peers", "remove", "--home", home, "--id", orgId]);
    expect(remove.code).toBe(0);
    const after = await runOpenbot(["peers", "--home", home]);
    expect(JSON.parse(after.stdout.trim()).peers).toEqual([]);
  });
});

describe("insertOrgPeer uniqueness", () => {
  test("slug and peer_org_id unique", async () => {
    const { ctx, server } = startTestServer({ home: tempHome(), env: {} });
    try {
      const orgId = id();
      insertOrgPeer(ctx.db, {
        slug: "beta",
        orgId,
        baseUrl: "https://beta.example.com",
        pubkey: generateEd25519().publicKeyRawB64,
      });
      try {
        insertOrgPeer(ctx.db, {
          slug: "beta",
          orgId: id(),
          baseUrl: "https://other.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        });
        throw new Error("expected duplicate_slug");
      } catch (err) {
        expect(err).toBeInstanceOf(OrgPeerError);
        expect((err as OrgPeerError).code).toBe("duplicate_slug");
      }
      try {
        insertOrgPeer(ctx.db, {
          slug: "gamma",
          orgId,
          baseUrl: "https://gamma.example.com",
          pubkey: generateEd25519().publicKeyRawB64,
        });
        throw new Error("expected duplicate_org");
      } catch (err) {
        expect(err).toBeInstanceOf(OrgPeerError);
        expect((err as OrgPeerError).code).toBe("duplicate_org");
      }
    } finally {
      server.stop(true);
    }
  });
});
