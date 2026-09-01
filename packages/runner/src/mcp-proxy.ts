import type { JsonRpcPeer } from "./rpc.ts";

export async function startMcpProxy(peer: JsonRpcPeer): Promise<{ port: number; stop: () => void }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
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
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
