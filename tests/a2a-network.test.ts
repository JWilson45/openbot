import { afterEach, describe, expect, test } from "bun:test";
import { nodePinnedA2AFetch } from "../apps/server/src/a2a-network.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("A2A server network boundary", () => {
  test("connects to the validated address while preserving the original Host header", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return Response.json({ host: request.headers.get("host"), path: new URL(request.url).pathname });
      },
    });
    servers.push(server);
    const url = `http://agent.invalid:${server.port}/a2a/v1`;
    const response = await nodePinnedA2AFetch(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), {
      hostname: "agent.invalid",
      addresses: ["127.0.0.1"],
      trustedLoopback: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: `agent.invalid:${server.port}`, path: "/a2a/v1" });
  });

  test("fails closed on target mismatch, empty pins, and untrusted cleartext", async () => {
    const request = new Request("http://agent.invalid/a2a/v1", { method: "POST", body: "{}" });
    await expect(nodePinnedA2AFetch(request.clone(), {
      hostname: "other.invalid",
      addresses: ["127.0.0.1"],
      trustedLoopback: true,
    })).rejects.toThrow("does not match");
    await expect(nodePinnedA2AFetch(request.clone(), {
      hostname: "agent.invalid",
      addresses: [],
      trustedLoopback: true,
    })).rejects.toThrow("no validated address");
    await expect(nodePinnedA2AFetch(request, {
      hostname: "agent.invalid",
      addresses: ["127.0.0.1"],
      trustedLoopback: false,
    })).rejects.toThrow("insecure");
  });
});

