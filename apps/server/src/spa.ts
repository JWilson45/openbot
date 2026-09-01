import deskCss from "./spa/desk.css" with { type: "text" };
import deskJs from "./spa/desk.js" with { type: "text" };

export function parseHttpUrl(raw: unknown): URL | null {
  try {
    const url = new URL(String(raw ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    url.username = "";
    url.password = "";
    return url;
  } catch {
    return null;
  }
}

export const SPA_CSS = deskCss as string;
export const SPA_JS = deskJs as string;

export const SPA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="theme-color" content="#12151c" media="(prefers-color-scheme: dark)" />
  <meta name="theme-color" content="#f3efe6" media="(prefers-color-scheme: light)" />
  <title>OpenBot</title>
  <style>
    html, body { height: 100%; }
    body { margin: 0; font: 0.9375rem/1.5 ui-sans-serif, system-ui, sans-serif; background: #12151c; color: #e8eef6; }
    .skip {
      position: absolute; left: -999px; top: 8px; z-index: 40;
      background: #3db8a8; color: #06201c; padding: 8px 12px; border-radius: 8px; font-weight: 600;
    }
    .skip:focus { left: 8px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    .card { max-width: 28rem; margin: 12vh auto; padding: 24px; }
    a.primary, .btn-link {
      display: inline-flex; align-items: center; justify-content: center; min-height: 44px;
      padding: 10px 14px; border-radius: 8px; background: #3db8a8; color: #06201c;
      font-weight: 650; text-decoration: none;
    }
    .err { color: #f0979c; }
  </style>
  <script>
    try {
      var th = localStorage.getItem("openbot-theme");
      if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th);
      if (localStorage.getItem("openbot-debug") === "1") document.documentElement.dataset.debug = "1";
    } catch (e) {}
  </script>
  <link rel="stylesheet" href="/ui/desk.css" />
</head>
<body>
  <a class="skip" href="#app">Skip to message input</a>
  <div id="announce" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <noscript>
    <div class="card">
      <h1>OpenBot</h1>
      <p>The live desk needs JavaScript. You can still sign in on this machine:</p>
      <p><a class="primary" href="/auth/local?login=demo">Demo sign-in (local)</a></p>
    </div>
  </noscript>
  <div id="app"></div>
  <script src="/ui/desk.js" defer onerror="document.getElementById('app').innerHTML='<main class=card><h1>OpenBot</h1><p class=err>Desk JS failed to load.</p><p><a class=primary href=/>Reload</a></p></main>'"></script>
</body>
</html>`;

export function spaSource(): string {
  return `${SPA_HTML}\n${SPA_CSS}\n${SPA_JS}`;
}
