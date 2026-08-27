import { describe, expect, test } from "bun:test";
import { tempHome } from "./helpers.ts";
import { startTestServer } from "../apps/server/src/test-helpers.ts";
import { parseHttpUrl, SPA_HTML } from "../apps/server/src/spa.ts";

function spaParseHttpUrl(): (raw: unknown) => URL | null {
  const start = SPA_HTML.indexOf("function parseHttpUrl(raw)");
  expect(start).toBeGreaterThan(-1);
  const brace = SPA_HTML.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < SPA_HTML.length; i++) {
    const c = SPA_HTML[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const src = SPA_HTML.slice(start, i + 1);
        return new Function(`${src}; return parseHttpUrl;`)() as (raw: unknown) => URL | null;
      }
    }
  }
  throw new Error("SPA parseHttpUrl not closed");
}

describe("desk SPA markup", () => {
  test("ships skip link, noscript sign-in, live region, and language", async () => {
    const { server, origin } = startTestServer({ home: tempHome() });
    const html = await fetch(origin + "/").then((r) => r.text());
    expect(html).toContain('lang="en"');
    expect(html).toContain('href="#draft"');
    expect(html).toContain("Skip to message input");
    expect(html).toContain("<noscript>");
    expect(html).toContain("/auth/local?login=demo");
    expect(html).toContain('role="status"');
    expect(html).toContain("aria-live");
    expect(html).toContain("Enter</kbd> send");
    expect(html).toContain("Shift");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("Close takeover");
    expect(html).toContain("Type DELETE to confirm wipe");
    expect(html).toContain("open-archive");
    expect(html).toContain("Archive");
    expect(html).toContain("open-calendar");
    expect(html).toContain("inCalendar");
    expect(html).toContain("timezone");
    expect(html).toContain("calendar.proposed");
    expect(html).toContain("Learn this");
    expect(html).toContain('id="learn-this"');
    expect(html).toContain("((state.view === 'human' && !gwSelected) || inGroup) && state.thread");
    expect(html).toContain("state.view !== 'human' && state.view !== 'group'");
    expect(html).toContain("This saves a prompt you can edit, not a recording of clicks. OpenBot will not replay the browser session.");
    expect(html).toContain("kind === 'routine'");
    expect(html).toContain("Proposed event");
    expect(html).toContain("Proposed · ");
    expect(html).toContain("seriesRowHtml");
    expect(html).toContain("Schedules");
    expect(html).toContain("Every ");
    expect(html).toContain("INTERVAL=([0-9]+)");
    expect(html).toContain("needs confirm");
    expect(html).toContain("Fires on");
    expect(html).not.toContain("Schedule vs Routine");
    expect(html).toContain("Readable");
    expect(html).toContain("live-human");
    expect(html).toContain("collapse-rail");
    expect(html).toContain("collapse-side");
    expect(html).toContain("resize-side");
    expect(html).toContain("open-activity");
    expect(html).toContain("live-block");
    expect(html).toContain("<strong>");
    expect(html).toContain("md-pre");
    expect(html).toContain("pick-model");
    expect(html).toContain("pick-effort");
    expect(html).toContain("Reasoning");
    expect(html).toContain("open-gateway");
    expect(html).toContain("fed-on");
    expect(html).toContain("fed-off");
    expect(html).toContain("Federation");
    expect(html).toContain("federationEnabled");
    expect(html).toContain("/v1/threads?kind=group");
    expect(html).toContain("new-group");
    expect(html).toContain("data-group");
    expect(html).toContain("origin === 'prompt'");
    expect(html).toContain("origin === 'calendar'");
    expect(html).toContain("turnIds");
    expect(html).toContain("_turnIds");
    expect(html).toContain("dropFinishedTurn");
    expect(html).toContain("sameThread");
    expect(html).toContain("Groups");
    expect(html).toContain("openbot-orgs");
    expect(html).toContain("open-orgs");
    expect(html).toContain("Bookmark this URL");
    expect(html).toContain("add-org");
    expect(html).toContain("This instance");
    expect(html).toContain("new URL");
    expect(html).toContain("javascript:");
    expect(html).toContain("data:");
    expect(html).toContain("http:");
    expect(html).toContain("https:");
    expect(html).toContain("location.href");
    expect(html).toContain("/v1/org/peers");
    expect(html).toContain("/v1/org/peers/from-info");
    expect(html).toContain("/v1/org/inbox");
    expect(html).toContain("Copy pubkey");
    expect(html).toContain("tried to send mail");
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).not.toContain("thread_bridges");
    expect(html).toContain("peerPreview.baseUrl");
    expect(html).toContain("url.protocol !== 'http:'");
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
