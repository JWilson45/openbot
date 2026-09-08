import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { RedactingLogger } from "@openbot/vault";
import {
  createApp,
  openbotFetch,
  openbotRequestIdleTimeoutSeconds,
} from "../apps/server/src/app.ts";
import { tempHome } from "./helpers.ts";

describe("HTTP request diagnostics", () => {
  test("logs correlated request boundaries without query strings or credentials", async () => {
    const logger = new RedactingLogger(() => undefined);
    const created = createApp({
      home: tempHome(),
      port: 0,
      logger,
      requestLogging: true,
    });
    try {
      const response = await created.app.request("http://local/v1/healthz?token=sk-ob_DO_NOT_LOG", {
        headers: {
          "X-Request-ID": "request-test-1",
          Authorization: "Bearer DO_NOT_LOG",
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("request-test-1");
      const records = logger.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({
        msg: "http.request.started",
        requestId: "request-test-1",
        method: "GET",
        path: "/v1/healthz",
      }));
      expect(records).toContainEqual(expect.objectContaining({
        msg: "http.request.completed",
        requestId: "request-test-1",
        status: 200,
      }));
      expect(logger.lines.join("\n")).not.toContain("DO_NOT_LOG");
      expect(logger.lines.join("\n")).not.toContain("token=");
    } finally {
      created.stop();
      created.ctx.db.close();
    }
  });

  test("assigns finite handler deadlines and disables timeout only after an SSE response", async () => {
    expect(openbotRequestIdleTimeoutSeconds(new Request("http://local/internal/runtime/mcp"))).toBe(0);
    expect(openbotRequestIdleTimeoutSeconds(new Request("http://local/mcp", { method: "POST" }))).toBe(30);
    expect(openbotRequestIdleTimeoutSeconds(new Request("http://local/ag-ui/v1/run", { method: "POST" }))).toBe(30);
    expect(openbotRequestIdleTimeoutSeconds(new Request("http://local/a2a/v1", { method: "POST" }))).toBe(125);
    expect(openbotRequestIdleTimeoutSeconds(
      new Request("http://local/v1/chat/completions", { method: "POST" }),
    )).toBe(125);
    expect(openbotRequestIdleTimeoutSeconds(new Request("http://local/v1/healthz"))).toBeUndefined();

    const app = new Hono();
    app.post("/ag-ui/v1/run", () => new Response(": open\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const timeouts: number[] = [];
    const response = await openbotFetch(app)(
      new Request("http://local/ag-ui/v1/run", { method: "POST" }),
      { timeout(_request, seconds) { timeouts.push(seconds); } },
    );
    expect(response.status).toBe(200);
    expect(timeouts).toEqual([30, 0]);
  });

  test("keeps a quiet SSE response alive past Bun's configured idle timeout", async () => {
    const app = new Hono();
    app.get("/events", () => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": open\n\n"));
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: still-open\n\n"));
            controller.close();
          }, 1_200);
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 1,
      fetch: openbotFetch(app),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/events`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("still-open");
    } finally {
      server.stop(true);
    }
  }, 5_000);
});
