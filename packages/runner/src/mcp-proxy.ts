import type { JsonRpcPeer } from "./rpc.ts";

export async function startMcpProxy(peer: JsonRpcPeer): Promise<{ port: number; stop: () => void }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, bunServer) {
      const requestId = proxyRequestId(req.headers.get("x-request-id"));
      const method = req.method.toUpperCase();
      const path = new URL(req.url).pathname;
      const startedAt = Date.now();
      bunServer.timeout(req, method === "GET" ? 0 : 30);
      proxyLog("info", "mcp_proxy.request.started", { requestId, method, path });
      const slow = setTimeout(() => {
        proxyLog("warn", "mcp_proxy.request.slow", {
          requestId,
          method,
          path,
          durationMs: Date.now() - startedAt,
        });
      }, 5_000);
      slow.unref();
      try {
        const response = await handleProxyRequest(peer, req);
        response.headers.set("X-Request-ID", requestId);
        proxyLog("info", "mcp_proxy.request.completed", {
          requestId,
          method,
          path,
          status: response.status,
          durationMs: Date.now() - startedAt,
          streaming: response.headers.get("content-type")?.includes("text/event-stream") ?? false,
        });
        return response;
      } catch (error) {
        proxyLog("error", "mcp_proxy.request.failed", {
          requestId,
          method,
          path,
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "Error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        clearTimeout(slow);
      }
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}

async function handleProxyRequest(peer: JsonRpcPeer, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/mcp/v1")) return new Response("not found", { status: 404 });
  if (req.method === "GET") {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        const iv = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(iv);
          }
        }, 15_000);
        req.signal.addEventListener("abort", () => {
          clearInterval(iv);
          try {
            controller.close();
          } catch {
            /* closed */
          }
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  if (req.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const cookie = req.headers.get("cookie");
  const authorization = req.headers.get("authorization") ?? undefined;
  if (cookie && !authorization) {
    return Response.json({ error: "cookies_not_accepted" }, { status: 401 });
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 1_048_576) return Response.json({ error: "too_large" }, { status: 413 });
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const result = (await peer.request("mcp.forward", {
    bearer: authorization,
    body,
  })) as { status?: number; json?: unknown };
  const status = typeof result?.status === "number" ? result.status : 200;
  return Response.json(result?.json ?? {}, { status });
}

function proxyRequestId(candidate: string | null): string {
  if (candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) return candidate;
  return crypto.randomUUID();
}

function proxyLog(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown>): void {
  console.error(JSON.stringify({ level, msg, ...extra }));
}
