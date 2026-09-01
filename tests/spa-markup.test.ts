import { describe, expect, test } from "bun:test";
import { tempHome } from "./helpers.ts";
import { startTestServer } from "../apps/server/src/test-helpers.ts";
import { parseHttpUrl, spaSource, SPA_CSS, SPA_HTML, SPA_JS } from "../apps/server/src/spa.ts";

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
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

function spaParseHttpUrl(): (raw: unknown) => URL | null {
  const src = extractFn(SPA_JS, "parseHttpUrl");
  return new Function(`${src}; return parseHttpUrl;`)() as (raw: unknown) => URL | null;
}

describe("desk SPA markup", () => {
  test("ships skip link, noscript sign-in, live region, and language", async () => {
    const { server, origin } = startTestServer({ home: tempHome() });
    const [html, css, js] = await Promise.all([
      fetch(origin + "/").then((r) => r.text()),
      fetch(origin + "/ui/desk.css").then((r) => r.text()),
      fetch(origin + "/ui/desk.js").then((r) => r.text()),
    ]);
    expect(html).toBe(SPA_HTML);
    expect(css).toBe(SPA_CSS);
    expect(js).toBe(SPA_JS);
    const source = html + "\n" + css + "\n" + js;
    expect(source).toBe(spaSource());
    expect(html).toContain('lang="en"');
    expect(html).toContain('href="#app"');
    expect(html).toContain("Skip to message input");
    expect(html).toContain("<noscript>");
    expect(html).toContain("/auth/local?login=demo");
    expect(html).toContain('role="status"');
    expect(html).toContain("aria-live");
    expect(html).toContain('href="/ui/desk.css"');
    expect(html).toContain('src="/ui/desk.js"');
    expect(html).toContain("Desk JS failed to load");
    expect(js).toContain("Enter</kbd> send");
    expect(js).toContain("Shift");
    expect(css).toContain("prefers-reduced-motion");
    expect(html).toContain('name="viewport"');
    expect(js).toContain("tk-url");
    expect(js).toContain("tk-stage");
    expect(css).toContain("overlay.tk");
    expect(js).toContain("type:'navigate'");
    expect(js).toContain("type:'viewport'");
    expect(js).toContain("sendPointer('wheel'");
    expect(js).toContain("sendKey('rawKeyDown'");
    expect(js).toContain("sendKey('char'");
    expect(js).not.toContain("e.key === 'Backspace'");
    expect(css).toContain("touch-action: none");
    expect(js).toContain("lastFit");
    expect(js).toContain("ResizeObserver");
    expect(js).toContain("requestAnimationFrame");
    expect(css).toContain("width: 100%; height: 100%");
    expect(source).not.toContain("object-fit: contain");
    expect(js).toContain("Type DELETE to confirm wipe");
    expect(js).toContain("open-archive");
    expect(js).toContain("Archive");
    expect(js).toContain("open-calendar");
    expect(js).toContain("inCalendar");
    expect(js).toContain("timezone");
    expect(js).toContain("calendar.proposed");
    expect(js).toContain("Learn this");
    expect(js).toContain('id="learn-this"');
    expect(js).toContain("((state.view === 'human' && !gwSelected) || inGroup) && state.thread");
    expect(js).toContain("state.view !== 'human' && state.view !== 'group'");
    expect(js).toContain("This saves a prompt you can edit, not a recording of clicks. OpenBot will not replay the browser session.");
    expect(js).toContain("kind === 'routine'");
    expect(js).toContain("Proposed event");
    expect(js).toContain("Proposed · ");
    expect(js).toContain("seriesRowHtml");
    expect(js).toContain("Schedules");
    expect(js).toContain("Every ");
    expect(js).toContain("INTERVAL=([0-9]+)");
    expect(js).toContain("needs confirm");
    expect(js).toContain("Fires on");
    expect(js).not.toContain("Schedule vs Routine");
    expect(js).toContain("Readable");
    expect(js).toContain("live-human");
    expect(js).toContain("collapse-rail");
    expect(js).toContain("collapse-side");
    expect(js).toContain("resize-side");
    expect(js).toContain("open-activity");
    expect(js).toContain("live-block");
    expect(js).toContain("<strong>");
    expect(js).toContain("md-pre");
    expect(js).toContain("pick-model");
    expect(js).toContain("pick-effort");
    expect(js).toContain("Reasoning");
    expect(js).toContain("open-gateway");
    expect(js).toContain("fed-on");
    expect(js).toContain("fed-off");
    expect(js).toContain("Federation");
    expect(js).toContain("federationEnabled");
    expect(js).toContain("/v1/threads?kind=group");
    expect(js).toContain("new-group");
    expect(js).toContain("data-group");
    expect(js).toContain("origin === 'prompt'");
    expect(js).toContain("origin === 'calendar'");
    expect(js).toContain("turnIds");
    expect(js).toContain("_turnIds");
    expect(js).toContain("dropFinishedTurn");
    expect(js).toContain("sameThread");
    expect(js).toContain("Groups");
    expect(js).toContain("openbot-orgs");
    expect(js).toContain("open-orgs");
    expect(js).toContain("Bookmark this URL");
    expect(js).toContain("add-org");
    expect(js).toContain("This instance");
    expect(js).toContain("new URL");
    expect(js).toContain("javascript:");
    expect(js).toContain("data:");
    expect(js).toContain("http:");
    expect(js).toContain("https:");
    expect(js).toContain("location.href");
    expect(js).toContain("/v1/org/peers");
    expect(js).toContain("/v1/org/peers/from-info");
    expect(js).toContain("/v1/org/inbox");
    expect(js).toContain("Copy pubkey");
    expect(js).toContain("tried to send mail");
    expect(js).toContain("navigator.clipboard.writeText");
    expect(js).not.toContain("thread_bridges");
    expect(js).toContain("peerPreview.baseUrl");
    expect(js).toContain("url.protocol !== 'http:'");
    expect(js).toContain("%%FENCE");
    expect(() => new Function(SPA_JS)).not.toThrow();

    expect(js).toContain("openbot-debug");
    expect(js).toContain("debug-mode");
    expect(js).toContain("code === 'Period'");
    expect(js).toContain("Control+Shift+Period");
    expect(js).toContain("deskChipText");
    expect(js).toContain("Working on the desk");
    expect(js).toContain('id="live-chip"');
    expect(js).toContain("set-theme");
    expect(js).toContain("openbot-theme");
    expect(source).toContain("data-theme");
    expect(js).toContain("set-model");
    expect(js).toContain("on-model");
    expect(js).toContain("snapshotFocus");
    expect(js).toContain("data-action");
    expect(js).toContain("data-msg-id");
    expect(js).toContain("aria-keyshortcuts");
    expect(js).toContain("e.key === 'F6'");
    expect(css).toContain(".thread .composer-tools");
    expect(css).toContain('html:not([data-debug="1"]) .thread .composer-tools');
    expect(css).not.toContain('html:not([data-debug="1"]) .composer-tools {');
    expect(css).toContain(":root");
    expect(css).toContain("prefers-color-scheme: light");
    expect(css).toContain('html:not([data-theme="dark"])');
    expect(css).toContain('html[data-theme="light"]');
    expect(js).toContain("Desk browser");
    expect(js).toContain("retargetSkip");
    expect(html).toContain('href="#app"');

    const toggleSrc = extractFn(js, "toggleDebug");
    expect(toggleSrc).not.toContain("renderApp");
    expect(js).not.toMatch(/live-chip[\s\S]{0,200}toggleDebug/);
    expect(js).not.toMatch(/id="live-chip"[^>]*onclick/);

    const chipSrc = extractFn(js, "deskChipText");
    expect(chipSrc).not.toContain("Writing to thread");
    expect(chipSrc).not.toMatch(/return ['"]Writing['"]/);

    server.stop(true);
  });

  test("parseHttpUrl allows http(s) and rejects javascript:, data:, relative, protocol-relative", () => {
    const fromSpa = spaParseHttpUrl();
    const cases: Array<[string, string | null]> = [
      ["javascript:alert(1)", null],
      ["data:text/html,hi", null],
      ["/relative", null],
      ["//evil.example", null],
      ["https://beta.example.com/desk", "https://beta.example.com"],
      ["http://127.0.0.1:8787/x", "http://127.0.0.1:8787"],
    ];
    for (const [input, origin] of cases) {
      const exported = parseHttpUrl(input);
      const inlined = fromSpa(input);
      if (origin == null) {
        expect(exported).toBeNull();
        expect(inlined).toBeNull();
      } else {
        expect(exported).toBeInstanceOf(URL);
        expect(inlined).toBeInstanceOf(URL);
        expect(exported!.origin).toBe(origin);
        expect(inlined!.origin).toBe(origin);
        expect(exported!.protocol === "http:" || exported!.protocol === "https:").toBe(true);
      }
    }
  });
});
