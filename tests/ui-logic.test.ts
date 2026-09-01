import { describe, expect, test } from "bun:test";
import { SPA_JS } from "../apps/server/src/spa.ts";

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} not closed`);
}

function loadFn<T extends (...args: never[]) => unknown>(name: string, extras: Record<string, unknown> = {}): T {
  const src = extractFn(SPA_JS, name);
  const keys = Object.keys(extras);
  const vals = keys.map((k) => extras[k]);
  return new Function(...keys, `${src}; return ${name};`)(...vals) as T;
}

describe("shipped desk UI helpers", () => {
  test("visibleMessages drops prompt and calendar", () => {
    const visibleMessages = loadFn<(list: Array<{ origin: string }>) => Array<{ origin: string }>>("visibleMessages");
    const out = visibleMessages([
      { origin: "user" },
      { origin: "send_message" },
      { origin: "prompt" },
      { origin: "calendar" },
      { origin: "fallback" },
    ]);
    expect(out.map((m) => m.origin)).toEqual(["user", "send_message", "fallback"]);
  });

  test("deskChipText is quiet copy, never Writing", () => {
    const deskChipText = loadFn<(blocks: unknown[], harness?: string) => string>("deskChipText");
    expect(deskChipText([], "idle")).toBe("");
    expect(deskChipText([], undefined)).toBe("");
    expect(deskChipText([], "in_turn")).toBe("Working on the desk…");
    expect(deskChipText([], "starting")).toBe("Working on the desk…");
    expect(deskChipText([{ type: "thought", text: "hmm" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "write", text: "hello" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "tool", title: "SendMessage", status: "running" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "status", text: "Needs permission" }])).toBe("Needs permission");
    expect(deskChipText([{ type: "status", text: "Turn finished" }])).toBe("");
    expect(deskChipText([{ type: "write", text: "x" }, { type: "status", text: "Turn finished" }])).toBe("");
    expect(JSON.stringify([
      deskChipText([], "in_turn"),
      deskChipText([{ type: "write" }]),
      deskChipText([{ type: "thought" }]),
    ])).not.toContain("Writing");
  });

  test("applyTheme writes light/dark/system without renderApp", () => {
    const dataset: Record<string, string> = {};
    const metas: Array<{ name: string; media?: string; content?: string }> = [];
    const document = {
      documentElement: { dataset },
      head: { appendChild(n: { name: string }) { metas.push(n); } },
      querySelector(sel: string) {
        if (sel.includes("theme-color") && sel.includes("not([media])")) {
          return metas.find((m) => m.name === "theme-color" && !m.media) || null;
        }
        return null;
      },
      createElement() {
        const node: { name: string; media?: string; content?: string; setAttribute: (k: string, v: string) => void } = {
          name: "",
          setAttribute(k, v) {
            if (k === "name") node.name = v;
            else (node as Record<string, string>)[k] = v;
          },
        };
        return node;
      },
    };
    const store: Record<string, string> = {};
    const localStorage = {
      getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null; },
      setItem(k: string, v: string) { store[k] = String(v); },
    };
    const window = { matchMedia: (q: string) => ({ matches: q.includes("prefers-color-scheme: light") ? false : false }) };
    const applyTheme = loadFn<(value: string, persist?: boolean) => void>("applyTheme", { document, localStorage, window });
    applyTheme("light");
    expect(store["openbot-theme"]).toBe("light");
    expect(dataset.theme).toBe("light");
    applyTheme("dark");
    expect(dataset.theme).toBe("dark");
    applyTheme("system");
    expect(store["openbot-theme"]).toBe("system");
    expect(dataset.theme).toBeUndefined();
    const src = extractFn(SPA_JS, "applyTheme");
    expect(src).not.toContain("renderApp");
  });

  test("toggleDebug sets storage and inert, does not renderApp", () => {
    const state = { debug: false };
    const side = {
      inert: true,
      setAttribute(name: string, value: string) { if (name === "inert") this.inert = true; void value; },
      removeAttribute(name: string) { if (name === "inert") this.inert = false; },
    };
    const btn = { pressed: "false", setAttribute(name: string, value: string) { if (name === "aria-pressed") this.pressed = value; } };
    const dataset: Record<string, string> = {};
    const document = {
      documentElement: { dataset },
      getElementById(id: string) { return id === "side" ? side : id === "debug-mode" ? btn : null; },
    };
    const store: Record<string, string> = {};
    const localStorage = {
      getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null; },
      setItem(k: string, v: string) { store[k] = String(v); },
    };
    const toggleDebug = loadFn<(on: boolean) => void>("toggleDebug", { state, document, localStorage });
    toggleDebug(true);
    expect(state.debug).toBe(true);
    expect(store["openbot-debug"]).toBe("1");
    expect(dataset.debug).toBe("1");
    expect(side.inert).toBe(false);
    expect(btn.pressed).toBe("true");
    toggleDebug(false);
    expect(state.debug).toBe(false);
    expect(store["openbot-debug"]).toBe("0");
    expect(dataset.debug).toBe("0");
    expect(side.inert).toBe(true);
    expect(btn.pressed).toBe("false");
    expect(extractFn(SPA_JS, "toggleDebug")).not.toContain("renderApp");
  });
});
