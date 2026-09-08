import {
  A2A_VERSION_HEADER,
  type AgentCard,
  type CancelTaskRequest,
  type GetTaskRequest,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import { A2A_VERSION } from "./types.ts";

export type A2AOutboundPolicyErrorCode =
  | "invalid_url"
  | "insecure_transport"
  | "dns_resolution_failed"
  | "forbidden_address"
  | "redirect_rejected"
  | "request_too_large"
  | "response_too_large"
  | "request_timed_out"
  | "unsupported_agent"
  | "credential_unavailable";

export class A2AOutboundPolicyError extends Error {
  readonly code: A2AOutboundPolicyErrorCode;
  readonly cause?: unknown;

  constructor(code: A2AOutboundPolicyErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "A2AOutboundPolicyError";
    this.code = code;
    this.cause = options.cause;
  }
}

export type A2AResolvedTarget = {
  /** Original normalized URL hostname. Use it for the HTTP Host header and TLS SNI. */
  hostname: string;
  /** Complete validated terminal A/AAAA set. Connect only to an address in this set. */
  addresses: readonly string[];
  /** True only for an origin explicitly allowlisted as a loopback development endpoint. */
  trustedLoopback: boolean;
};

export type ResolveA2AHostname = (
  hostname: string,
  options: { signal: AbortSignal },
) => Promise<readonly string[]>;

/**
 * Network primitive supplied by the runtime host. It MUST connect to one of `target.addresses`,
 * preserve the request hostname for Host/SNI and TLS certificate verification, perform no DNS
 * re-resolution, and never follow redirects. The adapter also sets `redirect: "manual"` and
 * validates the returned response.
 */
export type A2APinnedFetch = (
  request: Request,
  target: A2AResolvedTarget,
) => Promise<Response>;

export type ResolveA2ABearerCredential = (context: {
  agentCard: AgentCard;
  endpoint: string;
  signal: AbortSignal;
}) => Promise<string | null>;

export type A2AOutboundLimits = {
  /** Maximum encoded request body. Defaults to 1 MiB. */
  maxRequestBodyBytes?: number;
  /** Maximum bytes consumed from one response, including an SSE response. Defaults to 16 MiB. */
  maxResponseBodyBytes?: number;
  /** End-to-end timeout for each DNS + HTTP exchange and credential lookup. Defaults to 30 s. */
  requestTimeoutMs?: number;
};

export type CreateA2AOutboundClientOptions = {
  /** Base URL used for standard Agent Card discovery. */
  baseUrl: string;
  resolveHostname: ResolveA2AHostname;
  pinnedFetch: A2APinnedFetch;
  resolveBearerCredential: ResolveA2ABearerCredential;
  /** Exact origins allowed to resolve exclusively to loopback addresses and use HTTP. */
  trustedLoopbackOrigins?: readonly string[];
  limits?: A2AOutboundLimits;
};

export type A2AOutboundCallOptions = {
  signal?: AbortSignal;
};

export interface A2AOutboundClient {
  readonly agentCard: AgentCard;
  readonly endpoint: string;
  sendMessage(
    params: SendMessageRequest,
    options?: A2AOutboundCallOptions,
  ): Promise<SendMessageResult>;
  sendMessageStream(
    params: SendMessageRequest,
    options?: A2AOutboundCallOptions,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  getTask(params: GetTaskRequest, options?: A2AOutboundCallOptions): Promise<Task>;
  cancelTask(params: CancelTaskRequest, options?: A2AOutboundCallOptions): Promise<Task>;
}

type RequiredLimits = Required<A2AOutboundLimits>;
type IpAddress =
  | { family: 4; bytes: readonly number[]; canonical: string }
  | { family: 6; groups: readonly number[]; canonical: string; embeddedV4?: IpAddress & { family: 4 } };

const DEFAULT_LIMITS: RequiredLimits = {
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 30_000,
};

function policyError(
  code: A2AOutboundPolicyErrorCode,
  message: string,
  cause?: unknown,
): A2AOutboundPolicyError {
  return new A2AOutboundPolicyError(code, message, cause === undefined ? {} : { cause });
}

function normalizeLimits(value: A2AOutboundLimits | undefined): RequiredLimits {
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  return limits;
}

function normalizeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw policyError("invalid_url", `${label} is not a valid absolute URL`, cause);
  }
  if (url.username || url.password) {
    throw policyError("invalid_url", `${label} must not contain credentials`);
  }
  if (url.hash) throw policyError("invalid_url", `${label} must not contain a fragment`);
  return url;
}

function normalizedHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.toLowerCase().replace(/\.$/, "");
}

function parseIpv4(value: string): (IpAddress & { family: 4 }) | null {
  const pieces = value.split(".");
  if (pieces.length !== 4) return null;
  const bytes: number[] = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const byte = Number(piece);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return { family: 4, bytes, canonical: bytes.join(".") };
}

function parseIpv6(value: string): (IpAddress & { family: 6 }) | null {
  let input = value.toLowerCase();
  if (input.includes("%") || !/^[0-9a-f:.]+$/.test(input)) return null;
  let embeddedV4: (IpAddress & { family: 4 }) | undefined;
  if (input.includes(".")) {
    const finalColon = input.lastIndexOf(":");
    if (finalColon < 0) return null;
    embeddedV4 = parseIpv4(input.slice(finalColon + 1)) ?? undefined;
    if (!embeddedV4) return null;
    const [a, b, c, d] = embeddedV4.bytes;
    input = `${input.slice(0, finalColon)}:${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  if ((input.match(/::/g) ?? []).length > 1) return null;
  const compressed = input.includes("::");
  const [leftRaw, rightRaw = ""] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) return null;
  const missing = compressed ? 8 - left.length - right.length : 0;
  const groups = [
    ...left.map((piece) => Number.parseInt(piece, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((piece) => Number.parseInt(piece, 16)),
  ];
  if (groups.length !== 8) return null;
  return { family: 6, groups, canonical: groups.map((group) => group.toString(16)).join(":"), ...(embeddedV4 ? { embeddedV4 } : {}) };
}

function parseIpAddress(value: string): IpAddress | null {
  const normalized = normalizedHostname(value);
  return parseIpv4(normalized) ?? parseIpv6(normalized);
}

function ipv4Category(address: IpAddress & { family: 4 }): "public" | "loopback" | "forbidden" {
  const [a, b, c] = address.bytes;
  if (a === 127) return "loopback";
  if (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  ) return "forbidden";
  return "public";
}

function ipv6Category(address: IpAddress & { family: 6 }): "public" | "loopback" | "forbidden" {
  const groups = address.groups;
  const allZeroPrefix = groups.slice(0, 6).every((group) => group === 0);
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  if (address.embeddedV4 && (allZeroPrefix || (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff))) {
    return ipv4Category(address.embeddedV4);
  }
  const first = groups[0]!;
  if (
    groups.every((group) => group === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    first === 0xfec0 ||
    (first === 0x2001 && groups[1] === 0x0db8) ||
    (first === 0x2001 && groups[1] === 0x0002) ||
    (first === 0x0064 && groups[1] === 0xff9b) ||
    first === 0x0100 ||
    first === 0x2002
  ) return "forbidden";
  return (first & 0xe000) === 0x2000 ? "public" : "forbidden";
}

function addressCategory(address: IpAddress): "public" | "loopback" | "forbidden" {
  return address.family === 4 ? ipv4Category(address) : ipv6Category(address);
}

function normalizeTrustedOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values ?? []) {
    const url = normalizeUrl(value, "trusted loopback origin");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
      throw new TypeError("trusted loopback origins must use http or https");
    }
    if (url.href !== `${url.origin}/`) {
      throw new TypeError("trusted loopback entries must be exact origins without a path or query");
    }
    origins.add(url.origin);
  }
  return origins;
}

function linkAbortSignal(source: AbortSignal | null, controller: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
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

async function byteLength(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) return total;
      total += next.value.byteLength;
      if (total > maximum) {
        void reader.cancel("A2A outbound request body exceeds configured limit").catch(() => undefined);
        return total;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class GuardedA2AFetch {
  readonly #trustedOrigins: ReadonlySet<string>;

  constructor(
    private readonly resolveHostname: ResolveA2AHostname,
    private readonly pinnedFetch: A2APinnedFetch,
    private readonly limits: RequiredLimits,
    trustedLoopbackOrigins?: readonly string[],
  ) {
    this.#trustedOrigins = normalizeTrustedOrigins(trustedLoopbackOrigins);
  }

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const controller = new AbortController();
    const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const unlink = linkAbortSignal(inputSignal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(policyError("request_timed_out", "A2A request timed out"));
    }, this.limits.requestTimeoutMs);

    let request: Request;
    try {
      request = new Request(input, { ...init, redirect: "manual", signal: controller.signal });
    } catch (cause) {
      clearTimeout(timer);
      unlink();
      throw policyError("invalid_url", "Could not construct the A2A request", cause);
    }

    try {
      const declaredRequestLength = request.headers.get("Content-Length");
      if (declaredRequestLength !== null && (
        !/^\d+$/.test(declaredRequestLength) ||
        Number(declaredRequestLength) > this.limits.maxRequestBodyBytes
      )) {
        throw policyError("request_too_large", "A2A request body exceeds configured limit");
      }
      if (await byteLength(
        request.clone().body,
        this.limits.maxRequestBodyBytes,
        controller.signal,
      ) > this.limits.maxRequestBodyBytes) {
        throw policyError("request_too_large", "A2A request body exceeds configured limit");
      }

      const target = await this.#resolveTarget(normalizeUrl(request.url, "A2A target URL"), controller.signal);
      const response = await raceAbort(this.pinnedFetch(request, target), controller.signal);
      if (
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400) ||
        (response.url !== "" && response.url !== request.url)
      ) {
        void response.body?.cancel("A2A redirects are forbidden").catch(() => undefined);
        throw policyError("redirect_rejected", "A2A endpoint returned a redirect");
      }
      const declaredResponseLength = response.headers.get("Content-Length");
      if (declaredResponseLength !== null && (
        !/^\d+$/.test(declaredResponseLength) ||
        Number(declaredResponseLength) > this.limits.maxResponseBodyBytes
      )) {
        void response.body?.cancel("A2A response body exceeds configured limit").catch(() => undefined);
        throw policyError("response_too_large", "A2A response body exceeds configured limit");
      }
      return this.#limitResponse(response, controller, timer, unlink, () => timedOut);
    } catch (error) {
      clearTimeout(timer);
      unlink();
      if (timedOut) {
        throw policyError("request_timed_out", "A2A request timed out", error);
      }
      throw error;
    }
  }) as typeof fetch;

  async validateUrl(value: string): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(policyError("request_timed_out", "A2A target validation timed out"));
    }, this.limits.requestTimeoutMs);
    try {
      await this.#resolveTarget(normalizeUrl(value, "Agent Card JSONRPC interface"), controller.signal);
    } catch (error) {
      if (timedOut) {
        throw policyError("request_timed_out", "A2A target validation timed out", error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #resolveTarget(url: URL, signal: AbortSignal): Promise<A2AResolvedTarget> {
    const trustedLoopback = this.#trustedOrigins.has(url.origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && trustedLoopback)) {
      throw policyError("insecure_transport", "A2A endpoints must use HTTPS");
    }
    const hostname = normalizedHostname(url.hostname);
    const literal = parseIpAddress(hostname);
    let rawAddresses: readonly string[];
    try {
      rawAddresses = literal
        ? [literal.canonical]
        : await raceAbort(this.resolveHostname(hostname, { signal }), signal);
    } catch (cause) {
      if (signal.aborted) throw signal.reason ?? cause;
      throw policyError("dns_resolution_failed", "Could not resolve the A2A target", cause);
    }
    if (rawAddresses.length === 0) {
      throw policyError("dns_resolution_failed", "The A2A target resolved to no addresses");
    }
    const addresses: string[] = [];
    const categories: Array<"public" | "loopback" | "forbidden"> = [];
    for (const raw of rawAddresses) {
      const address = parseIpAddress(raw);
      if (!address) {
        throw policyError("dns_resolution_failed", "The resolver returned a non-IP address");
      }
      addresses.push(address.canonical);
      categories.push(addressCategory(address));
    }

    if (trustedLoopback) {
      if (!categories.every((category) => category === "loopback")) {
        throw policyError("forbidden_address", "Trusted loopback origin resolved outside loopback");
      }
    } else if (!categories.every((category) => category === "public")) {
      throw policyError("forbidden_address", "A2A target resolved to a non-public address");
    }
    return { hostname, addresses: [...new Set(addresses)], trustedLoopback };
  }

  #limitResponse(
    response: Response,
    controller: AbortController,
    timer: ReturnType<typeof setTimeout>,
    unlink: () => void,
    timedOut: () => boolean,
  ): Response {
    if (!response.body) {
      clearTimeout(timer);
      unlink();
      return response;
    }
    const reader = response.body.getReader();
    const maximum = this.limits.maxResponseBodyBytes;
    let total = 0;
    const finish = () => {
      clearTimeout(timer);
      unlink();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const next = await raceAbort(reader.read(), controller.signal);
          if (next.done) {
            finish();
            streamController.close();
            return;
          }
          total += next.value.byteLength;
          if (total > maximum) {
            void reader.cancel("A2A response body exceeds configured limit").catch(() => undefined);
            controller.abort();
            finish();
            streamController.error(policyError("response_too_large", "A2A response body exceeds configured limit"));
            return;
          }
          streamController.enqueue(next.value);
        } catch (error) {
          void reader.cancel(error).catch(() => undefined);
          finish();
          streamController.error(timedOut()
            ? policyError("request_timed_out", "A2A request timed out", error)
            : error);
        }
      },
      async cancel(reason) {
        finish();
        controller.abort(reason);
        void reader.cancel(reason).catch(() => undefined);
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

function securitySchemeIsBearer(scheme: unknown): boolean {
  if (!scheme || typeof scheme !== "object") return false;
  const record = scheme as Record<string, unknown>;
  const oneof = record.scheme;
  if (oneof && typeof oneof === "object") {
    const value = oneof as { $case?: unknown; value?: unknown };
    if (value.$case === "httpAuthSecurityScheme" && value.value && typeof value.value === "object") {
      return String((value.value as Record<string, unknown>).scheme).toLowerCase() === "bearer";
    }
  }
  const proto = record.httpAuthSecurityScheme;
  if (proto && typeof proto === "object") {
    return String((proto as Record<string, unknown>).scheme).toLowerCase() === "bearer";
  }
  return record.type === "http" && String(record.scheme).toLowerCase() === "bearer";
}

type BearerMode = "none" | "optional" | "required";

function supportedSecurity(card: AgentCard): { bearerMode: BearerMode } {
  const requirements = card.securityRequirements ?? [];
  if (requirements.length === 0) return { bearerMode: "none" };
  const hasAnonymousAlternative = requirements.some((requirement) =>
    Object.keys(requirement.schemes ?? {}).length === 0
  );
  const hasBearerAlternative = requirements.some((requirement) => {
    const names = Object.keys(requirement.schemes ?? {});
    return names.length === 1 && securitySchemeIsBearer(card.securitySchemes?.[names[0]!]);
  });
  if (hasAnonymousAlternative) {
    return { bearerMode: hasBearerAlternative ? "optional" : "none" };
  }
  if (!hasBearerAlternative) {
    throw policyError(
      "unsupported_agent",
      "Agent Card requires an authentication scheme other than HTTP Bearer",
    );
  }
  return { bearerMode: "required" };
}

function selectedInterface(card: AgentCard): AgentCard["supportedInterfaces"][number] {
  const selected = card.supportedInterfaces.find((entry) =>
    entry.protocolBinding.toUpperCase() === "JSONRPC" && entry.protocolVersion === A2A_VERSION
  );
  if (!selected) {
    throw policyError("unsupported_agent", "Agent Card does not advertise JSONRPC A2A 1.0");
  }
  normalizeUrl(selected.url, "Agent Card JSONRPC interface");
  return selected;
}

async function resolveCredential(
  resolver: ResolveA2ABearerCredential,
  card: AgentCard,
  endpoint: string,
  required: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal ?? null, controller);
  let timedOut = false;
  let rejectTimeout: ((reason: unknown) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = policyError("request_timed_out", "A2A credential lookup timed out");
    controller.abort(error);
    rejectTimeout?.(error);
  }, timeoutMs);
  try {
    const token = await Promise.race([
      resolver({ agentCard: card, endpoint, signal: controller.signal }),
      timeout,
      aborted,
    ]);
    if (token === null) {
      if (required) throw policyError("credential_unavailable", "Bearer credential is required");
      return null;
    }
    if (!/^[A-Za-z0-9._~+/-]+={0,}$/.test(token)) {
      throw policyError("credential_unavailable", "Bearer credential is invalid");
    }
    return token;
  } catch (error) {
    if (timedOut) throw policyError("request_timed_out", "A2A credential lookup timed out", error);
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    if (error instanceof A2AOutboundPolicyError) throw error;
    throw policyError("credential_unavailable", "Bearer credential lookup failed", error);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    unlink();
  }
}

class DefaultA2AOutboundClient implements A2AOutboundClient {
  constructor(
    readonly agentCard: AgentCard,
    readonly endpoint: string,
    private readonly client: Client,
    private readonly credentialResolver: ResolveA2ABearerCredential,
    private readonly bearerMode: BearerMode,
    private readonly timeoutMs: number,
  ) {}

  async sendMessage(params: SendMessageRequest, options?: A2AOutboundCallOptions): Promise<SendMessageResult> {
    return this.client.sendMessage(params, await this.#requestOptions(options?.signal));
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    options?: A2AOutboundCallOptions,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    if (!this.agentCard.capabilities?.streaming) {
      throw policyError("unsupported_agent", "Agent Card does not advertise streaming");
    }
    yield* this.client.sendMessageStream(params, await this.#requestOptions(options?.signal));
  }

  async getTask(params: GetTaskRequest, options?: A2AOutboundCallOptions): Promise<Task> {
    return this.client.getTask(params, await this.#requestOptions(options?.signal));
  }

  async cancelTask(params: CancelTaskRequest, options?: A2AOutboundCallOptions): Promise<Task> {
    return this.client.cancelTask(params, await this.#requestOptions(options?.signal));
  }

  async #requestOptions(signal?: AbortSignal) {
    const token = this.bearerMode === "none"
      ? null
      : await resolveCredential(
        this.credentialResolver,
        this.agentCard,
        this.endpoint,
        this.bearerMode === "required",
        this.timeoutMs,
        signal,
      );
    return {
      ...(signal ? { signal } : {}),
      serviceParameters: {
        [A2A_VERSION_HEADER]: A2A_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
  }
}

/** Discover and create a security-constrained outbound A2A 1.0 JSON-RPC client. */
export async function createA2AOutboundClient(
  options: CreateA2AOutboundClientOptions,
): Promise<A2AOutboundClient> {
  const baseUrl = normalizeUrl(options.baseUrl, "A2A base URL");
  const limits = normalizeLimits(options.limits);
  const guarded = new GuardedA2AFetch(
    options.resolveHostname,
    options.pinnedFetch,
    limits,
    options.trustedLoopbackOrigins,
  );
  const resolver = new DefaultAgentCardResolver({ fetchImpl: guarded.fetch });
  const card = await resolver.resolve(baseUrl.toString());
  const selected = selectedInterface(card);
  await guarded.validateUrl(selected.url);
  const security = supportedSecurity(card);
  const selectedCard: AgentCard = { ...card, supportedInterfaces: [selected] };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: guarded.fetch })],
    preferredTransports: ["JSONRPC"],
    cardResolver: resolver,
  });
  const client = await factory.createFromAgentCard(selectedCard);
  return new DefaultA2AOutboundClient(
    selectedCard,
    selected.url,
    client,
    options.resolveBearerCredential,
    security.bearerMode,
    limits.requestTimeoutMs,
  );
}
