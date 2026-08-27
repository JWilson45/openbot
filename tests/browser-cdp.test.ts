import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@openbot/db";
import { cdpKeyEvent } from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("CDP + takeover", () => {
  test("Backspace is a virtual key, not an empty char", () => {
    const down = cdpKeyEvent({ action: "rawKeyDown", key: "Backspace", code: "Backspace" });
    expect(down.type).toBe("rawKeyDown");
    expect(down.windowsVirtualKeyCode).toBe(8);
    expect(down.text).toBeUndefined();
    const del = cdpKeyEvent({ action: "rawKeyDown", key: "Delete", code: "Delete" });
    expect(del.windowsVirtualKeyCode).toBe(46);
    const letter = cdpKeyEvent({ action: "char", key: "a", code: "KeyA", text: "a" });
    expect(letter.text).toBe("a");
    expect(letter.windowsVirtualKeyCode).toBe(65);
  });

  test("display reports loopback CDP; Chromium is not root; navigate/snapshot; takeover tickets", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const log: string[] = [];
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie, session } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });

    const runner = ctx.engine.runnerFor(session.accountId);
    let chromeError: string | undefined;
    try {
      await runner.ensureBrowser();
    } catch (err) {
      chromeError = String(err);
      log.push(`chromium_unavailable ${chromeError}`);
    }

    const display = await runner.display();
    expect(display.cdpUrl.startsWith("http://127.0.0.1:") || display.cdpUrl === "http://127.0.0.1:0").toBe(true);
    expect(display.chromeNotRoot).toBe(true);
    expect(display.uid).not.toBe(0);

    if (!chromeError && display.browserAlive) {
      const nav = await runner.navigate(`${origin}/`);
      if (!nav.ok) {
        throw new Error(`navigate failed: ${nav.error}`);
      }
      expect(nav.ok).toBe(true);
      const snap = await runner.snapshot();
      expect(snap.ok).toBe(true);
      expect(snap.html ?? "").toContain("OpenBot");
      const text = await runner.pageText();
      expect(text.ok).toBe(true);
      expect(text.url ?? "").toContain(origin);
      expect((text.text ?? "") + (text.title ?? "")).toMatch(/OpenBot/i);
      runner.browser!.takeoverActive = true;
      const blocked = await runner.navigate(`${origin}/`);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe("takeover_active");
      const during = await runner.pageText();
      expect(during.ok).toBe(true);
      expect((await runner.click({ text: "OpenBot" })).error).toBe("takeover_active");
      expect((await runner.typeText({ text: "x" })).error).toBe("takeover_active");
      runner.browser!.takeoverActive = false;
      const demo =
        "data:text/html," +
        encodeURIComponent(
          `<!doctype html><button id="b">Add to Cart</button><input id="t"><p id="out"></p>
           <script>
             document.getElementById("b").addEventListener("click", function() {
               var t = document.getElementById("t");
               t.value = "clicked";
               t.focus();
               document.getElementById("out").textContent = "clicked";
             });
           </script>`,
        );
      expect((await runner.navigate(demo)).ok).toBe(true);
      const c = await runner.click({ text: "Add to Cart" });
      expect(c.ok).toBe(true);
      const typed = await runner.typeText({ text: " hi" });
      expect(typed.ok).toBe(true);
      const html = await runner.snapshot();
      expect(html.html ?? "").toContain("clicked");
      log.push("navigate_ok");
    }

    const bad = await fetch(`${origin}/v1/compute/takeover`, { method: "POST", headers, body: "{}" });
    expect(bad.status).toBe(200);
    const { ticket } = (await bad.json()) as { ticket: string };
    expect(ticket.length).toBeGreaterThan(20);

    const wsBad = await takeoverAuth(origin, "not-a-real-ticket");
    expect(wsBad).toContain("invalid_ticket");

    const wsOk = await takeoverAuth(origin, ticket);
    expect(wsOk).not.toContain("invalid_ticket");
    expect(wsOk.includes("meta") || wsOk.includes("pageUrl") || wsOk === "open").toBe(true);

    const row = ctx.db.get<{ ticket_hash: string }>("SELECT ticket_hash FROM takeover_tickets LIMIT 1");
    expect(row?.ticket_hash).toBe(sha256Hex(ticket));
    expect(row?.ticket_hash).not.toBe(ticket);

    if (!chromeError && display.browserAlive) {
      const session = await takeoverSession(origin, ticket);
      expect(session.jpeg).toBeTruthy();
      const jpeg = session.jpeg!;
      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
      expect(jpeg.length).toBeGreaterThan(100);
      session.ws.send(JSON.stringify({ type: "mouse", action: "pressed", x: 0.5, y: 0.4, button: "left" }));
      const start = Date.now();
      while (Date.now() - start < 3000 && !runner.lastDispatchedInput) await Bun.sleep(50);
      expect(runner.lastDispatchedInput).toBeTruthy();
      expect(runner.lastDispatchedInput?.type).toBe("mouse");
      expect(runner.screencastFrames).toBeGreaterThan(0);
      expect(runner.browser?.inputViewport?.width).toBeGreaterThan(0);
      session.ws.send(JSON.stringify({ type: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 }));
      const wheelStart = Date.now();
      while (Date.now() - wheelStart < 3000 && runner.lastDispatchedInput?.type !== "wheel") await Bun.sleep(50);
      expect(runner.lastDispatchedInput?.type).toBe("wheel");
      expect(runner.lastDispatchedInput?.deltaY).toBe(120);
      session.ws.send(JSON.stringify({ type: "viewport", width: 1600, height: 900 }));
      const vpStart = Date.now();
      while (Date.now() - vpStart < 2000 && runner.browser?.viewport?.width !== 1600) await Bun.sleep(40);
      expect(runner.browser?.viewport).toEqual({ width: 1600, height: 900 });
      session.ws.close();
    }

    const { SPA_HTML } = await import("../apps/server/src/spa.ts");
    expect(SPA_HTML).toContain("/v1/turns/");
    expect(SPA_HTML).toContain("live-work");
    expect(SPA_HTML).toContain("catchUpLive");
    expect(SPA_HTML).toContain("mousedown");
    expect(SPA_HTML).toContain("keydown");
    expect(SPA_HTML).toContain("permission_request");
    expect(SPA_HTML).toContain("el.querySelector(sel)");
    expect(SPA_HTML).toContain("SendToAgent");
    expect(SPA_HTML).toContain("New bot");
    expect(SPA_HTML).toContain("/v1/messages/");

    server.stop(true);
    runner.stopBrowser();
    if (chromeError) {
      console.log(JSON.stringify({ chromeError, log }));
    }
  }, 30_000);
});

async function takeoverSession(
  origin: string,
  ticket: string,
): Promise<{ ws: WebSocket; jpeg: Uint8Array | null }> {
  const wsUrl = origin.replace("http", "ws") + "/v1/takeover";
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => resolve({ ws, jpeg: null }), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", ticket }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        clearTimeout(timer);
        resolve({ ws, jpeg: new Uint8Array(ev.data as ArrayBuffer) });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("takeover ws error"));
    };
  });
}

async function takeoverAuth(origin: string, ticket: string): Promise<string> {
  const wsUrl = origin.replace("http", "ws") + "/v1/takeover";
  return await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve("timeout");
    }, 3000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", ticket }));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const data = String(ev.data);
      ws.close();
      resolve(data);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("error");
    };
  });
}
