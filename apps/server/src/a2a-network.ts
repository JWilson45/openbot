import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type {
  A2APinnedFetch,
  A2AResolvedTarget,
  ResolveA2AHostname,
} from "@openbot/protocol-a2a";

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Complete A/AAAA lookup. Address classification remains owned by protocol-a2a. */
export const resolveNodeA2AHostname: ResolveA2AHostname = async (hostname, options) => {
  const records = await raceAbort(lookup(hostname, { all: true, verbatim: true }), options.signal);
  return records.map((record) => record.address);
};

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function responseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

function pinnedLookup(address: string): NonNullable<https.RequestOptions["lookup"]> {
  const family = address.includes(":") ? 6 : 4;
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as NonNullable<https.RequestOptions["lookup"]>;
}

function assertPinnedTarget(url: URL, target: A2AResolvedTarget): string {
  if (normalizedHostname(url.hostname) !== normalizedHostname(target.hostname)) {
    throw new TypeError("A2A pinned target does not match the request hostname");
  }
  const address = target.addresses[0];
  if (!address) throw new TypeError("A2A pinned target has no validated address");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && target.trustedLoopback)) {
    throw new TypeError("A2A pinned transport rejected an insecure request");
  }
  return address;
}

/**
 * Node's request primitive lets the protocol policy pin a validated IP while
 * retaining the original hostname for Host, TLS SNI, and certificate checks.
 * It performs exactly one exchange and therefore cannot follow redirects.
 */
export const nodePinnedA2AFetch: A2APinnedFetch = async (request, target) => {
  const url = new URL(request.url);
  const address = assertPinnedTarget(url, target);
  const body = request.body === null ? null : Buffer.from(await request.arrayBuffer());
  if (request.signal.aborted) throw abortError(request.signal);

  const headers = Object.fromEntries(request.headers.entries());
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  headers.host = url.host;
  if (body !== null) headers["content-length"] = String(body.byteLength);

  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const outgoing = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      lookup: pinnedLookup(address),
      ...(url.protocol === "https:" ? { servername: target.hostname } : {}),
    }, (incoming) => {
      request.signal.removeEventListener("abort", abort);
      const stream = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(stream, {
        status: incoming.statusCode ?? 502,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming.headers),
      }));
    });
    const abort = () => outgoing.destroy(abortError(request.signal) as Error);
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("error", (error) => {
      request.signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (body !== null) outgoing.end(body);
    else outgoing.end();
  });
};
