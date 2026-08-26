import { describe, expect, test } from "bun:test";
import { tempHome } from "./helpers.ts";
import { startTestServer } from "../apps/server/src/test-helpers.ts";

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
    server.stop(true);
  });
});
