import {
  RUNNER_JSON_MAX_BYTES,
  type RpcId,
  type RpcNote,
  type RpcReq,
  type RpcRes,
} from "@openbot/compute-protocol";

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly stderr?: string;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    if (data && typeof data === "object" && "stderr" in data) {
      this.stderr = String((data as { stderr?: unknown }).stderr ?? "");
    }
  }
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<
    RpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  binaryMessages = 0;
  textMessages = 0;

  constructor(
    private readonly sendText: (text: string) => void,
    private readonly onRequest: RpcHandler,
  ) {}

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: RpcReq = { jsonrpc: "2.0", id, method, params };
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText(JSON.stringify(msg));
    });
    void p.catch(() => undefined);
    return p;
  }

  notify(method: string, params?: unknown): void {
    const msg: RpcNote = { jsonrpc: "2.0", method, params };
    this.sendText(JSON.stringify(msg));
  }

  /** Must not be awaited by the socket read loop. */
  handleMessage(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data !== "string") {
      this.binaryMessages += 1;
      return;
    }
    this.textMessages += 1;
    if (data.length > RUNNER_JSON_MAX_BYTES) return;
    let msg: RpcReq & RpcRes & RpcNote;
    try {
      msg = JSON.parse(data) as RpcReq & RpcRes & RpcNote;
    } catch {
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.id == null) {
      void Promise.resolve(this.onRequest(msg.method, msg.params)).catch(() => undefined);
      return;
    }
    const id = msg.id;
    void Promise.resolve(this.onRequest(msg.method, msg.params)).then(
      (result) => {
        const res: RpcRes = { jsonrpc: "2.0", id, result };
        this.sendText(JSON.stringify(res));
      },
      (err: unknown) => {
        const e = err instanceof RpcError ? err : null;
        const res: RpcRes = {
          jsonrpc: "2.0",
          id,
          error: {
            code: e?.code ?? -32000,
            message: err instanceof Error ? err.message : String(err),
            data: e?.data,
          },
        };
        this.sendText(JSON.stringify(res));
      },
    );
  }

  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
