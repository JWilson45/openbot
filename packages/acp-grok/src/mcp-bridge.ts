#!/usr/bin/env bun
/**
 * Stdio MCP bridge: agent talks stdio MCP, we forward JSON-RPC to Streamable HTTP.
 * Used when the harness lacks mcpCapabilities.http.
 * Compiled binaries expose this as `openbot mcp-bridge <url> <token>`.
 */

export async function runMcpBridge(url: string, token: string): Promise<void> {
  let buf = Buffer.alloc(0);
  const stdin = Bun.stdin.stream().getReader();

  function send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  }

  async function forward(rpc: unknown): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(rpc),
    });
    const json = await res.json().catch(() => ({}));
    send(json);
  }

  while (true) {
    const { done, value } = await stdin.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buf.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const json = JSON.parse(buf.subarray(start, start + len).toString("utf8"));
      buf = buf.subarray(start + len);
      await forward(json);
    }
  }
}

if (import.meta.main) {
  const url = process.argv[2];
  const token = process.argv[3];
  if (!url || !token) {
    console.error("usage: mcp-bridge <url> <token>");
    process.exit(1);
  }
  await runMcpBridge(url, token);
}
