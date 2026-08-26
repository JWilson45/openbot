#!/usr/bin/env bun
/**
 * Scripted ACP agent for tests. Speaks Content-Length JSON-RPC on stdio.
 *
 * Directives in the user prompt:
 *   [[send:body]]     POST SendMessage via MCP HTTP
 *   [[echo-prompt]]   SendMessage "got-digest" or "no-digest" based on ACP reset block
 *   [[echo-prefix]]   SendMessage "got-group-prefix" if the group runTurn prefix is present
 *   [[thread:Title:body]]  SendToThread by group title (empty Title omits name/threadId)
 *   [[threadid:uuid:body]] SendToThread by group thread id
 *   [[write:name]]    write name into cwd
 *   [[ramble]]        emit assistant text, do not SendMessage
 *   [[sleep:ms]]      wait
 *   [[cwd]]           SendMessage with process.cwd()
 *   [[shell:cmd]]     run a shell command in cwd
 *   [[permission]]    JSON-RPC session/request_permission and wait for the client result
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let buf = Buffer.alloc(0);
let nextSession = 1;
let permRpc = 9000;
const sessions = new Map<string, { cwd: string; mcpUrl?: string; mcpToken?: string }>();
const pendingClientResponses = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

function parseMcp(raw: unknown): { url?: string; token?: string } {
  const servers = Array.isArray(raw) ? raw : [];
  for (const s of servers as Array<Record<string, unknown>>) {
    const url = s.url ?? s.uri;
    let token: string | undefined;
    const headers = s.headers;
    if (Array.isArray(headers)) {
      const auth = (headers as Array<{ name?: string; value?: string }>).find(
        (h) => String(h.name ?? "").toLowerCase() === "authorization",
      );
      token = auth?.value;
    } else if (headers && typeof headers === "object") {
      const rec = headers as Record<string, string>;
      token = rec.Authorization ?? rec.authorization;
    }
    if (url) {
      return { url: String(url), token: token ? token.replace(/^Bearer\s+/i, "") : undefined };
    }
  }
  return {};
}

function extractText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: string }).text) : ""))
      .join("\n");
  }
  return "";
}

function currentMessage(text: string): string {
  // Digest is prior thread; re-running [[thread:]] from history would fan-out again.
  const marker = "\nCurrent message:\n";
  const idx = text.lastIndexOf(marker);
  return idx >= 0 ? text.slice(idx + marker.length) : text;
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${name} HTTP ${res.status}: ${text}`);
  }
}

async function callSend(url: string, token: string, body: string): Promise<void> {
  await callTool(url, token, "SendMessage", { body });
}

async function handle(msg: {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  const id = msg.id;
  const method = msg.method ?? "";
  const params = msg.params ?? {};

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true } },
        authMethods: [{ id: "env" }],
      },
    });
    return;
  }
  if (method === "authenticate") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/new") {
    const sessionId = `sess_${nextSession++}`;
    const parsed = parseMcp(params.mcpServers);
    sessions.set(sessionId, {
      cwd: String(params.cwd ?? process.cwd()),
      mcpUrl: parsed.url || process.env.OPENBOT_MCP_URL,
      mcpToken: parsed.token || process.env.OPENBOT_MCP_TOKEN,
    });
    write({ jsonrpc: "2.0", id, result: { sessionId } });
    return;
  }
  if (method === "session/cancel") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = String(params.sessionId ?? "");
    const sess = sessions.get(sessionId);
    const text = extractText(params.prompt);
    const current = currentMessage(text);
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `working: ${text.slice(0, 200)}\n` },
      },
    });

    const sleep = /\[\[sleep:(\d+)\]\]/.exec(current);
    if (sleep) await Bun.sleep(Number(sleep[1]));

    const writeMatch = /\[\[write:([^\]]+)\]\]/.exec(current);
    if (writeMatch && sess) {
      writeFileSync(join(sess.cwd, writeMatch[1]), `written-by-fake-agent\ncwd=${sess.cwd}\n`);
    }

    const shell = /\[\[shell:([^\]]+)\]\]/.exec(current);
    if (shell && sess) {
      const proc = Bun.spawn(["bash", "-lc", shell[1]], { cwd: sess.cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    }

    if (current.includes("[[permission]]")) {
      const rpcId = permRpc++;
      write({
        jsonrpc: "2.0",
        id: rpcId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tc1", title: "run a command", kind: "execute" },
        },
      });
      await new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("permission timeout")), 20_000);
        pendingClientResponses.set(rpcId, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    }

    const mcpUrl = sess?.mcpUrl || process.env.OPENBOT_MCP_URL;
    const mcpToken = sess?.mcpToken || process.env.OPENBOT_MCP_TOKEN;

    try {
      const sendto = /\[\[sendto:([^:\]]+):([\s\S]*?)\]\]/.exec(current);
      if (sendto && mcpUrl && mcpToken) {
        await callTool(mcpUrl, mcpToken, "SendToAgent", { name: sendto[1].trim(), body: sendto[2].trim() });
      }

      const threadById = /\[\[threadid:([^:\]]+):([\s\S]*?)\]\]/.exec(current);
      if (threadById && mcpUrl && mcpToken) {
        await callTool(mcpUrl, mcpToken, "SendToThread", {
          threadId: threadById[1].trim(),
          body: threadById[2].trim(),
        });
      }

      const threadByName = /\[\[thread:(?!id)([^:\]]*):([\s\S]*?)\]\]/.exec(current);
      if (threadByName && mcpUrl && mcpToken) {
        const title = threadByName[1].trim();
        const body = threadByName[2].trim();
        await callTool(mcpUrl, mcpToken, "SendToThread", title ? { name: title, body } : { body });
      }

      if (current.includes("[[echo-prompt]]") && mcpUrl && mcpToken) {
        await callSend(mcpUrl, mcpToken, /ACP session reset/.test(text) ? "got-digest" : "no-digest");
      }

      if (current.includes("[[echo-prefix]]") && mcpUrl && mcpToken) {
        await callSend(
          mcpUrl,
          mcpToken,
          /To speak here call SendToThread/.test(text) ? "got-group-prefix" : "no-group-prefix",
        );
      }

      const send = /\[\[send:([\s\S]*?)\]\]/.exec(current);
      const sendCwd = current.includes("[[cwd]]");
      if ((send || sendCwd) && mcpUrl && mcpToken) {
        const body = sendCwd ? `cwd=${sess?.cwd}` : send![1].trim();
        await callSend(mcpUrl, mcpToken, body);
      } else if (
        mcpUrl &&
        mcpToken &&
        !current.includes("[[ramble]]") &&
        !current.includes("[[permission]]") &&
        !current.includes("[[echo-prompt]]") &&
        !current.includes("[[echo-prefix]]") &&
        !current.includes("[[sendto:") &&
        !current.includes("[[thread") &&
        !writeMatch &&
        !shell &&
        current.trim()
      ) {
        await callSend(mcpUrl, mcpToken, current.trim());
      }
    } catch (err) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `mcp_error: ${String(err)}\n` },
        },
      });
    }

    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method ${method}` },
  });
}

const reader = Bun.stdin.stream().getReader();
async function loop(): Promise<void> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    while (true) {
      const nl = buf.indexOf("\n");
      const headerEnd = buf.indexOf("\r\n\r\n");
      let json: {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (headerEnd >= 0 && (nl < 0 || headerEnd < nl) && /Content-Length:/i.test(buf.subarray(0, headerEnd).toString("utf8"))) {
        const header = buf.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          buf = buf.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) break;
        json = JSON.parse(buf.subarray(start, start + len).toString("utf8"));
        buf = buf.subarray(start + len);
      } else {
        if (nl < 0) break;
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        json = JSON.parse(line);
      }
      if (json.id != null && (json.result !== undefined || json.error) && pendingClientResponses.has(json.id)) {
        pendingClientResponses.get(json.id)!(json);
        pendingClientResponses.delete(json.id);
        continue;
      }
      void handle(json as { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown> });
    }
  }
}

void loop();
