export const SPA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0e1116" />
  <title>OpenBot</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e1116;
      --panel: #171b22;
      --line: #3d4a5c;
      --text: #eef3fa;
      --muted: #b4c0d0;
      --acc: #9ec1ff;
      --acc-ink: #081018;
      --bad: #f0b429;
      --err: #ff9aa0;
      --ok: #7dcca0;
      --user: #2c4060;
      --bot: #1c2430;
      --focus: #ffd37a;
      --header-h: 56px;
    }
    @media (prefers-contrast: more) {
      :root { --line: #8b98a8; --muted: #d5dde8; --text: #fff; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; font: 1rem/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .skip {
      position: absolute; left: -999px; top: 8px; z-index: 40;
      background: var(--acc); color: var(--acc-ink); padding: 8px 12px; border-radius: 8px; font-weight: 600;
    }
    .skip:focus { left: 8px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    button, input, textarea, select { font: inherit; color: inherit; }
    button {
      background: #243044; color: var(--text); border: 1px solid var(--line);
      border-radius: 8px; padding: 10px 14px; min-height: 44px; cursor: pointer;
    }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.primary { background: var(--acc); color: var(--acc-ink); border: 0; font-weight: 650; }
    button.ghost { background: transparent; }
    button.linkish { background: none; border: 0; padding: 8px 10px; min-height: 44px; color: var(--acc); text-decoration: underline; }
    a { color: var(--acc); }
    a.primary, .btn-link {
      display: inline-flex; align-items: center; justify-content: center; min-height: 44px;
      padding: 10px 14px; border-radius: 8px; background: var(--acc); color: var(--acc-ink);
      font-weight: 650; text-decoration: none;
    }
    input, textarea, select {
      width: 100%; background: #0b0e13; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
    }
    label { font-weight: 600; display: block; margin: 8px 0 4px; }
    header.app-header {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      min-height: var(--header-h); padding: 8px 16px; border-bottom: 1px solid var(--line);
    }
    header.app-header h1 { font-size: 1.05rem; margin: 0; font-weight: 650; }
    .header-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; font-size: .78rem; color: var(--muted);
      border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; min-height: 28px;
    }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .pill.live .dot { background: var(--ok); }
    .pill.work .dot { background: var(--bad); }
    .pill.down .dot { background: var(--err); }
    .shell {
      --side-w: 20rem;
      display: grid; grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr) 6px var(--side-w);
      height: calc(100dvh - var(--header-h));
    }
    .shell.no-rail { grid-template-columns: 52px minmax(0, 1fr) 6px var(--side-w); }
    .shell.no-side { grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr) 0 48px; }
    .shell.no-rail.no-side { grid-template-columns: 52px minmax(0, 1fr) 0 48px; }
    .resize-side {
      cursor: col-resize; background: var(--line); width: 6px; align-self: stretch;
    }
    .resize-side:hover, .resize-side:focus { background: var(--acc); }
    .shell.no-side .resize-side { cursor: default; background: transparent; }
    .rail, aside.side { background: #12161c; overflow: auto; padding: 12px; min-width: 0; }
    .rail { border-right: 1px solid var(--line); }
    aside.side { border-left: 1px solid var(--line); }
    .pane-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; }
    .pane-head h2 { margin: 0; }
    .pane-head button { min-height: 32px; padding: 4px 8px; }
    .rail h2, aside.side h2 {
      font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
    }
    .shell.no-rail .rail h2, .shell.no-rail .desk-note, .shell.no-rail .bot-meta, .shell.no-rail #newbot, .shell.no-rail #new-group { display: none; }
    .shell.no-rail .rail { padding: 8px 6px; }
    .shell.no-side aside.side { padding: 8px 4px; }
    .shell.no-side aside.side .side-body { display: none; }
    .st {
      flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: #5a6573;
    }
    .st.working { background: var(--bad); }
    .st.queued { background: var(--acc); }
    .st.attention { background: var(--err); }
    .st.idle { background: #5a6573; }
    .live-log { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .live-log > * { font-size: .85rem; color: var(--text); line-height: 1.35; }
    .live-block { border: 1px solid var(--line); border-radius: 10px; background: #0b0e13; overflow: hidden; }
    .live-block > summary {
      cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 8px 10px; font-weight: 600; font-size: .82rem;
    }
    .live-block > summary::-webkit-details-marker { display: none; }
    .live-block > summary::before { content: '▸'; color: var(--muted); font-weight: 400; }
    .live-block[open] > summary::before { content: '▾'; }
    .live-block.thought > summary { color: var(--muted); }
    .live-block.tool.running > summary { color: var(--bad); }
    .live-block.tool.failed > summary { color: var(--err); }
    .live-block.tool.completed > summary { color: var(--ok); }
    .live-body, .live-kv pre {
      margin: 0; padding: 8px 10px 10px; white-space: pre-wrap; overflow-wrap: anywhere;
      font: .78rem/1.4 ui-monospace, monospace; color: #d5dde8; max-height: 16rem; overflow: auto;
      border-top: 1px solid var(--line);
    }
    .live-kv h4 { margin: 8px 10px 0; font-size: .7rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
    .tool-st { font-weight: 500; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .live-status { color: var(--muted); font-size: .85rem; padding: 2px 4px; }
    .act-list { list-style: none; margin: 0; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow: auto; flex: 1; }
    .act-card { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; background: var(--bot); cursor: pointer; text-align: left; width: 100%; }
    .act-card .doing { margin-top: 6px; }
    .act-card .snip { color: var(--muted); font-size: .85rem; margin-top: 6px; }
    .live-log .when { color: var(--muted); font-size: .75rem; }
    .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .seg button { min-height: 32px; padding: 4px 8px; border: 0; border-radius: 0; }
    .seg button[aria-pressed="true"] { background: var(--acc); color: var(--acc-ink); }
    .bot {
      display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; margin: 0 0 6px;
    }
    .bot.active { background: var(--acc); color: var(--acc-ink); }
    .bot.active .muted { color: #243044; }
    .bot.folder { opacity: .95; }
    .archive-list { list-style: none; margin: 0; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow: auto; flex: 1; }
    .archive-row {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
      padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--bot);
    }
    .archive-row .meta { color: var(--muted); font-size: .9rem; }
    .org-row, .peer-row {
      display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
      padding: 10px 0; border-bottom: 1px solid var(--line);
    }
    .mono { font-family: ui-monospace, monospace; font-size: .78rem; overflow-wrap: anywhere; }
    .avatar {
      flex: 0 0 32px; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
      background: #31415a; font-size: .75rem; font-weight: 700;
    }
    .bot.active .avatar { background: #081018; color: var(--acc); }
    .bot-meta { min-width: 0; }
    .bot-meta strong { display: block; }
    .bot-meta .muted { display: block; font-size: .78rem; font-weight: 400; }
    .thread {
      display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 0;
    }
    .msgs {
      flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px;
      padding: 16px 18px 8px; scroll-behavior: smooth; list-style: none; margin: 0;
    }
    .msg {
      max-width: min(44rem, 100%); padding: 10px 12px; border-radius: 14px; position: relative;
    }
    .msg.user { align-self: flex-end; background: var(--user); }
    .msg.assistant { align-self: flex-start; background: var(--bot); border: 1px solid var(--line); }
    .msg.system { align-self: center; color: var(--muted); font-size: .9rem; background: transparent; border: 0; max-width: 36rem; text-align: center; }
    .msg.fallback { border-color: var(--bad); }
    .msg.pending { opacity: .75; }
    .msg.failed { border: 1px solid var(--err); }
    .who { display: flex; justify-content: space-between; gap: 8px; font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .msg.user .who { flex-direction: row-reverse; }
    .body { white-space: normal; overflow-wrap: anywhere; }
    .body a { overflow-wrap: anywhere; }
    .body p { margin: 0 0 0.65em; }
    .body p:last-child { margin-bottom: 0; }
    .body h1, .body h2, .body h3 { margin: 0.7em 0 0.35em; line-height: 1.25; }
    .body h1 { font-size: 1.2em; } .body h2 { font-size: 1.1em; } .body h3 { font-size: 1.05em; }
    .body ul, .body ol { margin: 0.25em 0 0.65em; padding-left: 1.35em; }
    .body li { margin: 0.2em 0; }
    .body blockquote { margin: 0.4em 0; padding: 0.2em 0 0.2em 0.8em; border-left: 3px solid var(--line); color: var(--muted); }
    .body hr { border: 0; border-top: 1px solid var(--line); margin: 0.8em 0; }
    .body strong { font-weight: 700; }
    .body em { font-style: italic; }
    .body code { font-family: ui-monospace, monospace; font-size: .9em; background: #0b0e13; padding: 0.1em 0.35em; border-radius: 4px; }
    .body pre.md-pre { margin: 0.4em 0 0.7em; padding: 10px 12px; background: #0b0e13; border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 24rem; }
    .body pre.md-pre code { padding: 0; background: none; font-size: .82em; white-space: pre; }
    .badge { display: inline-block; font-size: .7rem; letter-spacing: .04em; text-transform: uppercase; color: var(--bad); margin-bottom: 4px; }
    .msg-actions { display: flex; gap: 4px; justify-content: flex-end; margin-top: 6px; }
    .composer-wrap { padding: 10px 16px 14px; border-top: 1px solid var(--line); background: var(--bg); }
    .composer { display: flex; gap: 8px; align-items: flex-end; }
    .composer textarea { flex: 1; min-height: 48px; max-height: 40dvh; resize: vertical; }
    .composer-tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .composer-tools label { margin: 0; font-size: .75rem; font-weight: 600; color: var(--muted); }
    .composer-tools .field { flex: 1; min-width: 9rem; }
    .composer-tools select { width: 100%; min-height: 36px; padding: 6px 8px; }
    .hint { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: .78rem; margin-top: 6px; }
    .jump {
      position: sticky; bottom: 8px; align-self: center; z-index: 2;
    }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; max-width: 28rem; margin: 12vh auto; display: flex; flex-direction: column; gap: 10px; }
    .muted { color: var(--muted); font-size: .9rem; }
    .err { color: var(--err); }
    .live { font-family: ui-monospace, monospace; font-size: .78rem; color: #c5d0dc; white-space: pre-wrap; overflow-wrap: anywhere; }
    .overlay { position: fixed; inset: 0; background: #000a; display: flex; align-items: center; justify-content: center; z-index: 30; padding: 16px; }
    .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; width: min(32rem, 100%); max-height: 90dvh; overflow: auto; }
    .modal.wide { width: min(72rem, 96vw); display: flex; flex-direction: column; max-height: 92dvh; overflow: hidden; }
    .modal h2 { margin: 0 0 10px; font-size: 1.1rem; }
    .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
    .modal-head h2 { margin: 0; }
    .modal-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; flex: 0 0 auto; }
    #takeover-frame {
      width: 100%; max-width: 100%; height: auto; max-height: min(60dvh, 24rem);
      border: 1px solid var(--line); border-radius: 8px; background: #0b0e13; flex: 1 1 auto;
    }
    .empty { margin: auto; text-align: center; color: var(--muted); padding: 24px; }
    .side-toggle { display: none; }
    kbd { font: .8em ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; background: #0b0e13; }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; height: calc(100dvh - var(--header-h)); }
      .rail { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border-right: 0; border-bottom: 1px solid var(--line); }
      .rail h2, .rail .desk-note { display: none; }
      .rail .bot { width: auto; margin: 0; }
      aside.side { display: none; }
      aside.side.open {
        display: block; position: fixed; inset: auto 0 0 0; max-height: 50dvh; z-index: 20;
        border-left: 0; border-top: 1px solid var(--line);
      }
      .side-toggle { display: inline-flex; }
      .shell.no-rail, .shell.no-side, .shell.no-rail.no-side { grid-template-columns: 1fr; }
      .collapse-desk { display: none; }
      .resize-side { display: none; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#draft">Skip to message input</a>
  <div id="announce" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <noscript>
    <div class="card">
      <h1>OpenBot</h1>
      <p>The live desk needs JavaScript. You can still sign in on this machine:</p>
      <p><a class="primary" href="/auth/local?login=demo">Demo sign-in (local)</a></p>
    </div>
  </noscript>
  <div id="app"></div>
  <script>
  const state = {
    me:null, bots:[], gateway:null, groups:[], org:null, archived:[], archiveTtlMs: 30*24*60*60*1000, bot:null, thread:null, messages:[], live:[], compute:null, liveRaw: localStorage.getItem('openbot-live-raw') === '1', railCollapsed: localStorage.getItem('openbot-rail') === '1', sideCollapsed: localStorage.getItem('openbot-side') === '1',
    turn:null, a2a:[], view:'human', auth:{}, harness:{}, ws:'down', sending:false, activity:[], models:[], sideW: Number(localStorage.getItem('openbot-side-w') || 320)
  };
  let hostPoll = 0;
  let stickBottom = true;
  let pushTimer = 0;
  const el = document.getElementById('app');
  const announceEl = document.getElementById('announce');

  async function api(path, opts={}) {
    const res = await fetch(path, { credentials:'same-origin', headers: { 'content-type':'application/json', ...(opts.headers||{}) }, ...opts });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) throw Object.assign(new Error(json?.error || json?.error?.message || json?.message || res.statusText), { status: res.status, json });
    return json;
  }

  function h(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
  function parsePayload(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return {};
    try { return JSON.parse(raw); } catch { return { truncated: true }; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function announce(msg) { if (announceEl) announceEl.textContent = msg; }
  function parseHttpUrl(raw) {
    try {
      const url = new URL(String(raw || '').trim());
      // Scheme must be http: or https:. Reject javascript:, data:, relative paths (new URL without a base).
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!url.hostname) return null;
      url.username = '';
      url.password = ''; // don't navigate with embedded credentials
      return url;
    } catch { return null; }
  }
  function loadOrgBookmarks() {
    try {
      const raw = JSON.parse(localStorage.getItem('openbot-orgs') || '[]');
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        const url = parseHttpUrl(item.baseUrl);
        if (!name || !url) continue;
        out.push({ name, baseUrl: url.href });
      }
      return out;
    } catch { return []; }
  }
  function saveOrgBookmarks(list) {
    try { localStorage.setItem('openbot-orgs', JSON.stringify(list)); } catch {}
  }
  function goToOrg(baseUrl) {
    const url = parseHttpUrl(baseUrl);
    if (!url) { announce('Only http and https org URLs are allowed'); return; }
    if (url.origin === location.origin) return;
    location.href = url.href;
  }
  async function copyText(text, btn, doneMsg) {
    const label = btn ? btn.textContent : '';
    try {
      await navigator.clipboard.writeText(String(text || ''));
      if (btn) {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = label; }, 1200);
      }
      announce(doneMsg || 'Copied');
    } catch {
      if (btn) btn.textContent = 'Copy failed';
    }
  }
  function thisOrgName() {
    return (state.org && (state.org.name || state.org.slug)) || location.host || 'this instance';
  }
  function solicitNotices(json) {
    if (!json || typeof json !== 'object') return [];
    const out = [];
    const seen = new Set();
    function emit(row, force) {
      if (!row || typeof row !== 'object') return;
      const kind = String(row.kind || row.type || row.reason || row.status || '');
      const body = String(row.body || row.text || row.message || '');
      const looks = force || row.solicit === true || /solicit|untrusted|unknown_peer|tried to send/i.test(kind + ' ' + body);
      if (!looks) return;
      const who = row.name || row.slug || row.fromOrg || row.orgName || row.host || row.from_org || 'unknown';
      const line = 'Org ' + who + ' tried to send mail';
      if (seen.has(line)) return;
      seen.add(line);
      out.push(line);
    }
    if (Array.isArray(json.solicitations)) for (const row of json.solicitations) emit(row, true);
    if (Array.isArray(json.inbox)) for (const row of json.inbox) emit(row, false);
    if (Array.isArray(json.rows)) for (const row of json.rows) emit(row, false);
    if (Array.isArray(json.items)) for (const row of json.items) emit(row, false);
    return out;
  }
  function initials(name) {
    const p = String(name||'?').trim().split(/\\s+/).slice(0,2);
    return p.map(x => x[0] ? x[0].toUpperCase() : '').join('') || '?';
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 45000) return 'just now';
    if (diff < 3600000) return Math.max(1, Math.round(diff/60000)) + 'm ago';
    if (diff < 86400000) return d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    return d.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }
  function renderBody(text) {
    const fences = [];
    let src = String(text || '').replace(/\\r\\n/g, '\\n');
    src = src.replace(/\`\`\`([^\\n\`]*)\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      const i = fences.length;
      fences.push(escapeHtml(String(code).replace(/\\n$/, '')));
      return '\\n\\n%%FENCE' + i + '%%\\n\\n';
    });
    src = escapeHtml(src);
    function inline(t) {
      t = t.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      t = t.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
      t = t.replace(/\\bhttps?:\\/\\/[^\\s<]+/g, (url) => {
        const clean = url.replace(/[.,;:!?)]+$/, '');
        const rest = url.slice(clean.length);
        return '<a href="' + clean + '" rel="noopener noreferrer" target="_blank">' + clean + '</a>' + rest;
      });
      t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      t = t.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
      t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return t;
    }
    const lines = src.split('\\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^%%FENCE(\\d+)%%$/.exec(line.trim());
      if (fence) {
        out.push('<pre class="md-pre"><code>' + (fences[Number(fence[1])] || '') + '</code></pre>');
        i++; continue;
      }
      if (/^\\s*---+\\s*$/.test(line)) { out.push('<hr />'); i++; continue; }
      const heading = /^(#{1,3})\\s+(.+)$/.exec(line);
      if (heading) {
        const n = heading[1].length;
        out.push('<h' + n + '>' + inline(heading[2]) + '</h' + n + '>');
        i++; continue;
      }
      if (/^&gt;\\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;/.test(lines[i])) {
          buf.push(lines[i].replace(/^&gt;\\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + inline(buf.join('<br />')) + '</blockquote>');
        continue;
      }
      if (/^\\s*([-*]|\\d+\\.)\\s+/.test(line)) {
        const ordered = /^\\s*\\d+\\.\\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\\s*([-*]|\\d+\\.)\\s+/, '')) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^%%FENCE/.test(lines[i].trim()) && !/^#{1,3}\\s+/.test(lines[i]) && !/^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i]) && !/^&gt;/.test(lines[i]) && !/^\\s*---+\\s*$/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + inline(para.join('<br />')) + '</p>');
    }
    return out.join('') || '<p></p>';
  }
  function draftKey() { return state.thread ? 'openbot-draft-' + state.thread.id : ''; }
  function saveDraft() {
    const t = document.getElementById('draft');
    if (t && draftKey()) try { sessionStorage.setItem(draftKey(), t.value); } catch {}
  }
  function loadDraft() {
    const t = document.getElementById('draft');
    if (!t || !draftKey()) return;
    try { t.value = sessionStorage.getItem(draftKey()) || ''; } catch { t.value = ''; }
    syncSend();
  }

  async function boot() {
    try { state.auth = await api('/v1/auth-options'); } catch { state.auth = {}; }
    try { state.me = await api('/v1/me'); }
    catch { return renderSignIn(); }
    try { state.harness = await api('/v1/harness-auth'); } catch { state.harness = {}; }
    try { state.models = (await api('/v1/inference-models')).models || []; } catch { state.models = []; }
    try {
      const bots = await api('/v1/bots');
      // Desk roster only — Gateway is the sidecar, never a Team row.
      state.bots = bots.bots || (bots.bot ? [bots.bot] : []);
      state.gateway = bots.gateway || null;
      state.archived = bots.archived || [];
      if (bots.archiveTtlMs) state.archiveTtlMs = bots.archiveTtlMs;
      const last = localStorage.getItem('openbot-last-bot');
      state.bot = state.bots.find(b => b.id === last)
        || (state.gateway && last === state.gateway.id ? state.gateway : null)
        || state.bots[0]
        || null;
    } catch {}
    // Onboard until a desk bot exists; Gateway must not skip that screen.
    if (!state.bots.length && !state.archived.length) return renderOnboard();
    try { state.groups = (await api('/v1/threads?kind=group')).threads || []; } catch { state.groups = []; }
    try { state.org = await api('/v1/org'); } catch { state.org = null; }
    connectPush();
    if (!state.bots.length) { state.view = 'archive'; renderApp(); return; }
    try {
      await selectBot(state.bot.id);
    } catch (err) {
      renderApp();
      announce(err instanceof Error ? err.message : String(err));
    }
  }

  function renderSignIn() {
    document.title = 'Sign in · OpenBot';
    el.innerHTML = '';
    const local = state.auth && state.auth.local
      ? '<p><a class="primary" href="/auth/local?login=demo">Demo sign-in (local)</a></p>'
      : '';
    const gh = '<p><a class="primary" href="/auth/github">Sign in with GitHub</a></p>';
    el.append(h(\`<main class="card">
      <h1>OpenBot</h1>
      <p>Named teammates on this machine. Closing this tab does not stop them. Stopping <code>openbot server</code> does.</p>
      <p class="muted">Allowlist-only. Shared desk is not a security boundary. One Chromium for the whole team.</p>
      \${local}\${gh}
    </main>\`));
  }

  function harnessBlurb() {
    const grok = (state.harness.logins || []).find(l => l.id === 'grok');
    if (grok && grok.signedIn) {
      return 'Using your Grok CLI subscription' + (grok.email ? ' (' + escapeHtml(grok.email) + ')' : '') + '. No API key needed. Optional key below overrides it.';
    }
    if (state.harness.vaultKey) return 'An API key is already saved. Leave blank to keep it.';
    return 'No Grok CLI login detected. Run <code>grok login</code> on this machine (SuperGrok / Cursor subscription), or paste an API key.';
  }

  function renderOnboard() {
    document.title = 'Create a teammate · OpenBot';
    el.innerHTML = '';
    const card = h(\`<main class="card">
      <h1>Create your teammate</h1>
      <label for="name">Name</label>
      <input id="name" name="name" autocomplete="nickname" value="Ada" />
      <label for="desc">Description</label>
      <textarea id="desc" name="description">You are a helpful teammate. Finish jobs on this computer.</textarea>
      <p class="muted">\${harnessBlurb()}</p>
      \${inferenceFields('on-model', 'on-effort')}
      <label for="key">API key (optional)</label>
      <input id="key" name="key" type="password" autocomplete="off" placeholder="xai-… only if you are not using grok login" />
      <p class="muted">Shared desk. One Chromium. Bots talk with SendToAgent.</p>
      <button class="primary" id="go" type="button">Create bot</button>
      <p class="err" id="err" role="alert"></p>
    </main>\`);
    el.append(card);
    card.querySelector('#go').onclick = submitOnboard;
    const onModel = card.querySelector('#on-model');
    const onEffort = card.querySelector('#on-effort');
    if (onModel && onEffort) {
      onModel.onchange = () => { onEffort.innerHTML = effortOptions(onModel.value, onEffort.value); };
    }
    card.querySelector('#name').focus();
  }

  async function submitOnboard() {
    const err = document.getElementById('err');
    try {
      await api('/v1/bots', { method:'POST', body: JSON.stringify({
        name: document.getElementById('name').value,
        description: document.getElementById('desc').value,
        model: document.getElementById('on-model')?.value,
        reasoningEffort: document.getElementById('on-effort')?.value,
      }) });
      const key = document.getElementById('key').value.trim();
      if (key) await api('/v1/credentials/xai', { method:'PUT', body: JSON.stringify({ key }) });
      location.reload();
    } catch (e) { if (err) err.textContent = e.message; }
  }

  function isGatewayBot(b) {
    return Boolean(b && state.gateway && b.id === state.gateway.id);
  }
  function visibleMessages(list) {
    return (list || []).filter(m => m.origin !== 'prompt');
  }
  function principalById(botId) {
    if (state.gateway && state.gateway.id === botId) return state.gateway;
    return state.bots.find(b => b.id === botId) || null;
  }

  async function selectBot(botId, threadId) {
    saveDraft();
    const principal = principalById(botId);
    // Gateway is not in state.bots; never keep the previous desk bot here.
    if (!principal) return;
    state.bot = principal;
    try { localStorage.setItem('openbot-last-bot', state.bot.id); } catch {}
    state.view = threadId ? 'a2a' : 'human';
    const t = threadId
      ? await api('/v1/threads/' + threadId)
      : await api('/v1/threads?botId=' + encodeURIComponent(botId));
    state.thread = t.thread;
    state.messages = visibleMessages(t.messages);
    try {
      const a2a = await api('/v1/threads?kind=a2a&botId=' + encodeURIComponent(botId));
      state.a2a = a2a.threads || [];
    } catch { state.a2a = []; }
    stickBottom = true;
    renderApp();
    const latestTurnId = t.latestTurnId || [...(state.messages || [])].reverse().find(m => m.turn_id)?.turn_id;
    state.turn = latestTurnId;
    await catchUpLive(latestTurnId);
    loadDraft();
    const draft = document.getElementById('draft');
    if (draft) draft.focus();
  }

  async function refreshGroups() {
    try {
      const res = await api('/v1/threads?kind=group');
      state.groups = res.threads || [];
    } catch { state.groups = state.groups || []; }
  }

  async function selectGroup(threadId) {
    if (!threadId) return;
    saveDraft();
    state.view = 'group';
    const t = await api('/v1/threads/' + threadId);
    state.thread = t.thread;
    state.messages = visibleMessages(t.messages);
    stickBottom = true;
    renderApp();
    const latestTurnId = t.latestTurnId || [...(state.messages || [])].reverse().find(m => m.turn_id)?.turn_id;
    state.turn = latestTurnId;
    await catchUpLive(latestTurnId);
    loadDraft();
    const draft = document.getElementById('draft');
    if (draft) draft.focus();
  }

  function openNewGroup() {
    const botChecks = state.bots.map(b =>
      '<label><input type="checkbox" data-bot="' + b.id + '" /> ' + escapeHtml(b.name) + '</label>'
    ).join('');
    const gwCheck = state.gateway
      ? '<label><input type="checkbox" data-bot="' + state.gateway.id + '" /> ' + escapeHtml(state.gateway.name) + '</label>'
      : '';
    const overlay = h(\`<div class="overlay"><div class="modal">
      <h2 id="grp-title">New group</h2>
      <label for="grp-name">Title</label>
      <input id="grp-name" name="title" value="New thread" />
      <p class="muted">Pick at least two teammates. You are included.</p>
      <div id="grp-bots" style="display:flex;flex-direction:column;gap:6px">\${botChecks}\${gwCheck}</div>
      <p class="err" id="grp-err" hidden></p>
      <div class="modal-actions">
        <button class="primary" type="button" id="grp-go">Create</button>
        <button type="button" id="grp-no">Cancel</button>
      </div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'grp-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#grp-no').onclick = close;
    overlay.querySelector('#grp-go').onclick = async () => {
      const err = overlay.querySelector('#grp-err');
      const botIds = [...overlay.querySelectorAll('#grp-bots input[data-bot]:checked')].map(i => i.getAttribute('data-bot'));
      try {
        const res = await api('/v1/threads', { method:'POST', body: JSON.stringify({
          kind:'group',
          title: overlay.querySelector('#grp-name').value,
          botIds,
        }) });
        await refreshGroups();
        close();
        await selectGroup(res.thread.id);
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || 'Could not create group';
      }
    };
  }

  function statusPill() {
    const harness = state.compute && state.compute.harness;
    const ws = state.ws;
    let cls = 'pill', label = 'Connecting';
    if (ws === 'down') { cls += ' down'; label = 'Reconnecting'; }
    else if (harness === 'in_turn' || harness === 'starting') { cls += ' work'; label = harness === 'starting' ? 'Starting' : 'Working'; }
    else if (harness === 'crashed') { cls += ' down'; label = 'Crashed'; }
    else if (ws === 'live') { cls += ' live'; label = harness === 'idle' ? 'Idle' : 'Connected'; }
    return '<span class="' + cls + '" title="Connection and harness status"><span class="dot" aria-hidden="true"></span>' + escapeHtml(label) + '</span>';
  }

  function botName(id) {
    if (state.gateway && state.gateway.id === id) return state.gateway.name;
    const b = state.bots.find(x => x.id === id) || state.archived.find(x => x.id === id);
    return b ? b.name : (id || 'bot').slice(0, 8);
  }
  function presenceOf(b) {
    return (b && b.presence) || { key: 'idle', label: 'Dormant' };
  }
  function catalogModels() {
    return (state.models && state.models.length) ? state.models : [
      { id:'grok-4.6', name:'Grok 4.6', defaultEffort:'high', reasoningEfforts:[
        { id:'xhigh', value:'xhigh', label:'Extra High' },
        { id:'high', value:'high', label:'High' },
        { id:'medium', value:'medium', label:'Medium' },
        { id:'low', value:'low', label:'Low' }
      ]}
    ];
  }
  function currentModel() { return state.bot?.model || catalogModels()[0].id; }
  function currentEffort() { return state.bot?.reasoning_effort || catalogModels()[0].defaultEffort || 'high'; }
  function modelOptions(selected) {
    return catalogModels().map(m => '<option value="' + escapeHtml(m.id) + '"' + (m.id === selected ? ' selected' : '') + '>' + escapeHtml(m.name || m.id) + '</option>').join('');
  }
  function effortList(modelId) {
    const m = catalogModels().find(x => x.id === modelId) || catalogModels()[0];
    return m.reasoningEfforts || [];
  }
  function effortOptions(modelId, selected) {
    const list = effortList(modelId);
    const sel = list.some(e => e.value === selected) ? selected : (list.find(e => e.default)?.value || list[0]?.value || 'high');
    return list.map(e => '<option value="' + escapeHtml(e.value) + '"' + (e.value === sel ? ' selected' : '') + '>' + escapeHtml(e.label || e.value) + '</option>').join('');
  }
  function inferenceFields(modelId, effortId) {
    const model = currentModel();
    return '<div class="composer-tools">' +
      '<div class="field"><label for="' + modelId + '">Model</label><select id="' + modelId + '">' + modelOptions(model) + '</select></div>' +
      '<div class="field"><label for="' + effortId + '">Reasoning</label><select id="' + effortId + '">' + effortOptions(model, currentEffort()) + '</select></div>' +
      '</div>';
  }
  async function persistInference(model, effort) {
    if (!state.bot) return;
    try {
      const res = await api('/v1/bots/' + state.bot.id + '/settings', {
        method:'PATCH',
        body: JSON.stringify({ model, reasoningEffort: effort })
      });
      const bot = state.bots.find(b => b.id === state.bot.id)
        || (isGatewayBot(state.bot) ? state.gateway : null)
        || state.bot;
      bot.model = res.model;
      bot.reasoning_effort = res.reasoningEffort;
      state.bot = bot;
      if (isGatewayBot(bot)) state.gateway = bot;
      announce('Next turn uses ' + res.model + ' · ' + res.reasoningEffort);
    } catch (e) { announce(e.message); }
  }
  function bindInferenceSelects(root, modelSel, effortSel) {
    const modelEl = root.querySelector(modelSel);
    const effortEl = root.querySelector(effortSel);
    if (!modelEl || !effortEl) return;
    modelEl.onchange = async () => {
      const keep = effortEl.value;
      effortEl.innerHTML = effortOptions(modelEl.value, keep);
      await persistInference(modelEl.value, effortEl.value);
    };
    effortEl.onchange = async () => {
      await persistInference(modelEl.value, effortEl.value);
    };
  }

  function handoffLabel(t) {
    const other = t.bot_id === state.bot.id ? t.peer_bot_id : t.bot_id;
    return 'Handoff with ' + botName(other);
  }

  function renderApp() {
    const inArchive = state.view === 'archive';
    const inActivity = state.view === 'activity';
    const inGroup = state.view === 'group';
    const gwSelected = isGatewayBot(state.bot) && state.view === 'human';
    const heading = inArchive ? 'Archive' : inActivity ? 'Activity' : inGroup ? (state.thread?.title || 'Group') : (state.bot?.name || 'OpenBot');
    document.title = heading + ' · OpenBot';
    const railBots = state.bots.map(b => {
      const active = state.bot && b.id === state.bot.id && state.view === 'human' && !gwSelected;
      const pres = presenceOf(b);
      return '<button type="button" class="bot' + (active ? ' active' : '') + '" data-id="' + b.id + '" aria-current="' + (active ? 'page' : 'false') + '">' +
        '<span class="st ' + escapeHtml(pres.key) + '" title="' + escapeHtml(pres.label) + '"></span>' +
        '<span class="avatar" aria-hidden="true">' + escapeHtml(initials(b.name)) + '</span>' +
        '<span class="bot-meta"><strong>' + escapeHtml(b.name) + '</strong><span class="muted presence">' + escapeHtml(pres.label) + '</span></span></button>';
    }).join('');
    const gwEnabled = Boolean(state.gateway && state.gateway.enabled);
    const gatewayPin = state.gateway
      ? '<button type="button" class="bot folder' + (gwSelected ? ' active' : '') + '" id="open-gateway" data-id="' + state.gateway.id + '" aria-current="' + (gwSelected ? 'page' : 'false') + '">' +
        '<span class="avatar" aria-hidden="true">' + escapeHtml(initials(state.gateway.name)) + '</span>' +
        '<span class="bot-meta"><strong>' + escapeHtml(state.gateway.name) + '</strong><span class="muted presence">' + (gwEnabled ? 'Federation on' : 'Federation off') + '</span></span></button>'
      : '';
    const railGroups = (state.groups || []).map(t => {
      const active = inGroup && state.thread && t.id === state.thread.id;
      return '<button type="button" class="bot folder' + (active ? ' active' : '') + '" data-group="' + t.id + '" aria-current="' + (active ? 'page' : 'false') + '">' +
        '<span class="avatar" aria-hidden="true">#</span>' +
        '<span class="bot-meta"><strong>' + escapeHtml(t.title || 'Group') + '</strong></span></button>';
    }).join('');
    const handoffs = (state.a2a || []).map(t =>
      '<div><button type="button" data-a2a="' + t.id + '">' + escapeHtml(handoffLabel(t)) + '</button></div>'
    ).join('') || '<p class="muted">No A2A threads yet. Bots use SendToAgent.</p>';
    const readonly = state.view === 'a2a';
    const composer = inArchive || inActivity
      ? ''
      : readonly
      ? '<p class="muted" id="draft-help">This handoff log is read-only. Message the bot from their human thread.</p>'
      : inGroup
      ? \`
        <div class="composer">
          <label class="sr-only" for="draft">Message group</label>
          <textarea id="draft" name="draft" rows="2" maxlength="32000" aria-describedby="draft-help" placeholder="Message the group… @name to mention"></textarea>
          <button class="primary" id="send" type="button" disabled>Send</button>
        </div>
        <div class="hint" id="draft-help"><span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · @mention up to 3 teammates</span><span id="count"></span></div>\`
      : \`\${inferenceFields('pick-model', 'pick-effort')}
        <div class="composer">
          <label class="sr-only" for="draft">Message \${escapeHtml(state.bot?.name || '')}</label>
          <textarea id="draft" name="draft" rows="2" maxlength="32000" aria-describedby="draft-help" placeholder="Message \${escapeHtml(state.bot?.name || '')}…"></textarea>
          <button class="primary" id="send" type="button" disabled>Send</button>
        </div>
        <div class="hint" id="draft-help"><span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · model and reasoning apply on the next turn</span><span id="count"></span></div>\`;
    const mainInner = inArchive
      ? '<ul class="archive-list" id="archive-folder"></ul>'
      : inActivity
      ? '<ul class="act-list" id="activity-board"></ul>'
      : '<ol class="msgs" id="msgs" tabindex="0"></ol><div class="composer-wrap">' + composer + '</div><p class="muted" style="padding:0 16px 12px">Closing this tab does not stop teammates. Stopping <code>openbot server</code> does.</p>';

    const orgName = thisOrgName();
    el.innerHTML = '';
    el.append(h(\`<header class="app-header">
      <h1>\${escapeHtml(heading)}</h1>
      <div class="header-actions">
        \${statusPill()}
        <span class="pill" id="this-org" title="This instance">\${escapeHtml(orgName)}</span>
        <button type="button" id="open-orgs" aria-haspopup="dialog">Orgs</button>
        <button type="button" class="side-toggle" id="live-toggle" aria-expanded="false">Live work</button>
        \${!inArchive && !inActivity && !inGroup && state.bot && !gwSelected ? '<button type="button" id="archive-bot">Archive</button>' : ''}
        <button type="button" id="help" aria-haspopup="dialog">Help</button>
        <button type="button" id="takeover">Takeover</button>
        <button type="button" id="settings">Settings</button>
      </div>
    </header>\`));
    const layout = h(\`<div class="shell\${state.railCollapsed ? ' no-rail' : ''}\${state.sideCollapsed ? ' no-side' : ''}" id="shell">
      <nav class="rail" aria-label="Team">
        <div class="pane-head">
          <h2>Team</h2>
          <button type="button" class="ghost collapse-desk" id="collapse-rail" aria-expanded="\${!state.railCollapsed}" aria-label="\${state.railCollapsed ? 'Show team' : 'Hide team'}">\${state.railCollapsed ? '›' : '‹'}</button>
        </div>
        \${railBots}
        <button type="button" id="newbot">New bot</button>
        <h2>Library</h2>
        <button type="button" class="bot folder\${inActivity ? ' active' : ''}" id="open-activity" aria-current="\${inActivity ? 'page' : 'false'}">
          <span class="avatar" aria-hidden="true">◉</span>
          <span class="bot-meta"><strong>Activity</strong><span class="muted">All teammates</span></span>
        </button>
        <button type="button" class="bot folder\${inArchive ? ' active' : ''}" id="open-archive" aria-current="\${inArchive ? 'page' : 'false'}">
          <span class="avatar" aria-hidden="true">📦</span>
          <span class="bot-meta"><strong>Archive</strong><span class="muted"> \${state.archived.length} teammate\${state.archived.length === 1 ? '' : 's'}</span></span>
        </button>
        \${gatewayPin}
        <h2>Groups</h2>
        \${railGroups}
        <button type="button" id="new-group">New group</button>
        <p class="muted desk-note">Shared desk · one browser · SendToAgent is how bots talk.</p>
      </nav>
      <main class="thread" aria-label="\${inArchive ? 'Archive' : inActivity ? 'Activity' : inGroup ? 'Group' : 'Conversation'}">
        \${mainInner}
      </main>
      <div class="resize-side" id="resize-side" role="separator" aria-orientation="vertical" aria-label="Resize live work" tabindex="0"></div>
      <aside class="side" id="side" aria-label="Live work">
        <div class="pane-head">
          <h2>Live work</h2>
          <button type="button" class="ghost collapse-desk" id="collapse-side" aria-expanded="\${!state.sideCollapsed}" aria-label="\${state.sideCollapsed ? 'Show live work' : 'Hide live work'}">\${state.sideCollapsed ? '‹' : '›'}</button>
        </div>
        <div class="side-body">
          <p class="muted" id="live-summary">Quiet</p>
          <div class="seg" role="group" aria-label="Live work format">
            <button type="button" id="live-human" aria-pressed="\${!state.liveRaw}">Readable</button>
            <button type="button" id="live-raw" aria-pressed="\${state.liveRaw}">Raw</button>
          </div>
          <div id="live" class="live" aria-live="off"></div>
          <h2>Handoffs</h2>
          <div id="handoffs">\${handoffs}</div>
          <h2>Host</h2>
          <div class="muted" id="host"></div>
        </div>
      </aside>
    </div>\`);
    el.append(layout);
    const shellEl = document.getElementById('shell');
    if (shellEl) shellEl.style.setProperty('--side-w', Math.max(240, state.sideW || 320) + 'px');
    if (inArchive) paintArchiveFolder();
    else if (inActivity) void paintActivity();
    else paintMessages();
    paintLive();
    bindResize();
    const bind = (sel, fn) => { const n = el.querySelector(sel); if (n) n.onclick = fn; };
    bind('#send', sendMsg);
    bindInferenceSelects(el, '#pick-model', '#pick-effort');
    bind('#settings', openSettings);
    bind('#takeover', startTakeover);
    bind('#newbot', renderOnboard);
    bind('#new-group', openNewGroup);
    bind('#help', openHelp);
    bind('#open-orgs', openOrgs);
    bind('#open-archive', openArchiveFolder);
    bind('#open-activity', openActivity);
    bind('#archive-bot', archiveCurrentBot);
    bind('#collapse-rail', () => togglePane('rail'));
    bind('#collapse-side', () => togglePane('side'));
    bind('#live-human', () => setLiveRaw(false));
    bind('#live-raw', () => setLiveRaw(true));
    bind('#live-toggle', () => {
      const side = document.getElementById('side');
      const btn = document.getElementById('live-toggle');
      const open = side.classList.toggle('open');
      if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    el.querySelectorAll('button.bot[data-id]').forEach(btn => {
      btn.onclick = () => selectBot(btn.getAttribute('data-id'));
    });
    el.querySelectorAll('[data-group]').forEach(btn => {
      btn.onclick = () => selectGroup(btn.getAttribute('data-group'));
    });
    el.querySelectorAll('[data-a2a]').forEach(btn => {
      btn.onclick = () => selectBot(state.bot.id, btn.getAttribute('data-a2a'));
    });
    const draft = document.getElementById('draft');
    if (draft) {
      draft.addEventListener('input', () => { syncSend(); saveDraft(); });
      draft.addEventListener('keydown', onDraftKey);
    }
    const msgs = document.getElementById('msgs');
    if (msgs) msgs.addEventListener('scroll', onMsgScroll);
    refreshCompute();
    if (!hostPoll) hostPoll = setInterval(() => { void refreshCompute(); void reloadThread(); }, 2500);
  }

  function onDraftKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMsg();
    }
  }

  function syncSend() {
    const draft = document.getElementById('draft');
    const send = document.getElementById('send');
    const count = document.getElementById('count');
    if (!draft || !send) return;
    const n = draft.value.length;
    send.disabled = !draft.value.trim() || state.sending;
    if (count) count.textContent = n > 28000 ? (32000 - n) + ' left' : '';
  }

  function onMsgScroll() {
    const box = document.getElementById('msgs');
    if (!box) return;
    stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const jump = document.getElementById('jump');
    if (jump) jump.hidden = stickBottom;
  }

  function dropFinishedTurn(turnId, status) {
    if (!turnId) return;
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return;
    for (const m of state.messages) {
      if (!Array.isArray(m._turnIds) || !m._turnIds.length) continue;
      m._turnIds = m._turnIds.filter(id => id !== turnId);
    }
    if (state.turn === turnId) {
      const still = [...state.messages].reverse().find(m => Array.isArray(m._turnIds) && m._turnIds.length);
      state.turn = still ? still._turnIds[0] : null;
    }
  }

  function waitingKind() {
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== 'user' || last.origin === 'agent') return '';
    if (last._failed) return '';
    // Group user rows stay turn_id null; hello is this POST's empty turnIds, not a missing turn_id.
    // Finished mention turns are dropped from _turnIds so SendMessage-to-DM does not stick on waiting.
    if (state.view === 'group' && !last._pending && !(Array.isArray(last._turnIds) && last._turnIds.length > 0)) return '';
    const harness = state.compute && state.compute.harness;
    if (last._pending || harness === 'starting') return 'starting';
    if (harness === 'in_turn') return 'working';
    if (harness === 'crashed') return 'crashed';
    return 'waiting';
  }

  function senderLabel(m) {
    if (m.role === 'user' && (m.origin === 'user' || !m.origin)) return 'You';
    if (m.origin === 'agent') return botName(m.from_bot_id) || 'Bot';
    if (m.origin === 'system') return 'System';
    if (m.origin === 'federation') return m.remote_actor_name || 'Org';
    if (m.from_bot_id) return botName(m.from_bot_id);
    // Group fallback has no from_bot_id; do not pin it to the last selected DM.
    if (m.origin === 'fallback' && state.view === 'group') return 'Teammate';
    return state.bot?.name || 'Teammate';
  }

  function paintMessages() {
    const box = document.getElementById('msgs');
    if (!box) return;
    const prevStick = stickBottom;
    box.innerHTML = '';
    if (!state.messages.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = state.view === 'a2a'
        ? 'No handoff messages yet.'
        : state.view === 'group'
        ? 'No messages yet. @mention a teammate to loop them in.'
        : 'No messages yet. Say hello — Enter sends, Shift+Enter makes a new line.';
      box.append(empty);
    }
    for (const m of state.messages) {
      const li = document.createElement('li');
      const kind = m.origin === 'system' || m.origin === 'agent'
        ? 'system'
        : m.role === 'user' && m.origin !== 'thread' ? 'user' : 'assistant';
      li.className = 'msg ' + kind;
      if (m.origin === 'fallback') li.classList.add('fallback');
      if (m._pending) li.classList.add('pending');
      if (m._failed) li.classList.add('failed');
      li.setAttribute('aria-label', senderLabel(m) + ', ' + fmtTime(m.created_at));
      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('span');
      name.textContent = senderLabel(m);
      const time = document.createElement('time');
      if (m.created_at) {
        time.dateTime = new Date(Number(m.created_at)).toISOString();
        time.textContent = fmtTime(m.created_at);
        time.title = new Date(Number(m.created_at)).toLocaleString();
      }
      who.append(name, time);
      li.append(who);
      if (m.origin === 'fallback') {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = 'Fallback — teammate did not call SendMessage';
        li.append(badge);
      }
      if (m.origin === 'pending_approval') {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = 'Pending your approval';
        li.append(badge);
      }
      if (m.origin === 'federation' || m.remote_org_id) {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = m.remote_actor_name ? ('From ' + m.remote_actor_name) : 'Federation';
        li.append(badge);
      }
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = renderBody(m.body || '');
      li.append(body);
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'linkish';
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(m.body || ''); copy.textContent = 'Copied'; announce('Copied message'); setTimeout(() => copy.textContent = 'Copy', 1200); }
        catch { copy.textContent = 'Copy failed'; }
      };
      actions.append(copy);
      if (m._failed) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'linkish';
        retry.textContent = 'Retry';
        retry.onclick = () => retryMsg(m);
        actions.append(retry);
      }
      if (m.origin === 'pending_approval') {
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.textContent = 'Approve';
        ok.onclick = async () => { await api('/v1/messages/' + m.id + '/approve', { method:'POST', body:'{}' }); };
        const no = document.createElement('button');
        no.type = 'button';
        no.textContent = 'Reject';
        no.onclick = async () => { await api('/v1/messages/' + m.id + '/reject', { method:'POST', body:'{}' }); };
        actions.append(ok, no);
      }
      li.append(actions);
      box.append(li);
    }
    const wait = waitingKind();
    if (wait) {
      const li = document.createElement('li');
      li.className = 'msg system';
      li.setAttribute('aria-live', 'polite');
      const labels = { starting:'Starting Grok…', working:'Teammate is working…', crashed:'Harness crashed. Send again or open Settings.', waiting:'Waiting for teammate…' };
      li.textContent = labels[wait] || 'Waiting…';
      if (state.turn && wait !== 'crashed') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'linkish';
        cancel.textContent = 'Cancel turn';
        cancel.onclick = async () => { try { await api('/v1/turns/' + state.turn + '/cancel', { method:'POST', body:'{}' }); } catch {} };
        li.append(document.createTextNode(' '));
        li.append(cancel);
      }
      box.append(li);
    }
    if (!prevStick) {
      let jump = document.getElementById('jump');
      if (!jump) {
        jump = document.createElement('button');
        jump.id = 'jump';
        jump.type = 'button';
        jump.className = 'jump primary';
        jump.textContent = 'Jump to latest';
        jump.onclick = () => { stickBottom = true; const b = document.getElementById('msgs'); if (b) b.scrollTop = b.scrollHeight; jump.hidden = true; };
      }
      jump.hidden = false;
      box.append(jump);
    }
    if (prevStick) box.scrollTop = box.scrollHeight;
  }

  async function sendMsg() {
    const draft = document.getElementById('draft');
    if (!draft || !state.thread || state.view === 'a2a') return;
    const body = draft.value.trim();
    if (!body || state.sending) return;
    state.sending = true;
    syncSend();
    const tmp = { id: 'tmp-' + Date.now(), role:'user', origin:'user', body, created_at: Date.now(), _pending:true };
    state.messages.push(tmp);
    draft.value = '';
    try { sessionStorage.removeItem(draftKey()); } catch {}
    stickBottom = true;
    paintMessages();
    announce('Sending message');
    try {
      const res = await api('/v1/threads/' + state.thread.id + '/messages', { method:'POST', body: JSON.stringify({ body }) });
      // WS may already have replaced tmp; stamp the in-array row, not the detached object.
      const live = state.messages.find(x =>
        (res.userMessageId && x.id === res.userMessageId) || x.id === tmp.id || x === tmp
      ) || tmp;
      if (res.userMessageId) live.id = res.userMessageId;
      if (Array.isArray(res.turnIds)) {
        live._turnIds = res.turnIds;
        if (res.turnIds[0]) state.turn = res.turnIds[0];
      } else if (res.turnId) {
        live.turn_id = res.turnId;
        state.turn = res.turnId;
      }
      live._pending = false;
      paintMessages();
      announce('Message sent');
    } catch (e) {
      const live = state.messages.find(x => x.id === tmp.id || x === tmp) || tmp;
      live._pending = false;
      live._failed = true;
      live.error = e.message;
      paintMessages();
      announce('Send failed');
    } finally {
      state.sending = false;
      syncSend();
      draft.focus();
    }
  }

  async function retryMsg(m) {
    state.messages = state.messages.filter(x => x !== m);
    const draft = document.getElementById('draft');
    if (draft) draft.value = m.body || '';
    await sendMsg();
  }

  function togglePane(which) {
    if (which === 'rail') state.railCollapsed = !state.railCollapsed;
    else state.sideCollapsed = !state.sideCollapsed;
    try {
      localStorage.setItem('openbot-rail', state.railCollapsed ? '1' : '0');
      localStorage.setItem('openbot-side', state.sideCollapsed ? '1' : '0');
    } catch {}
    const shell = document.getElementById('shell');
    if (shell) {
      shell.classList.toggle('no-rail', state.railCollapsed);
      shell.classList.toggle('no-side', state.sideCollapsed);
    }
    const railBtn = document.getElementById('collapse-rail');
    const sideBtn = document.getElementById('collapse-side');
    if (railBtn) {
      railBtn.textContent = state.railCollapsed ? '›' : '‹';
      railBtn.setAttribute('aria-expanded', state.railCollapsed ? 'false' : 'true');
      railBtn.setAttribute('aria-label', state.railCollapsed ? 'Show team' : 'Hide team');
    }
    if (sideBtn) {
      sideBtn.textContent = state.sideCollapsed ? '‹' : '›';
      sideBtn.setAttribute('aria-expanded', state.sideCollapsed ? 'false' : 'true');
      sideBtn.setAttribute('aria-label', state.sideCollapsed ? 'Show live work' : 'Hide live work');
    }
  }

  function bindResize() {
    const handle = document.getElementById('resize-side');
    const shell = document.getElementById('shell');
    if (!handle || !shell || state.sideCollapsed) return;
    let dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const rect = shell.getBoundingClientRect();
      const w = Math.min(640, Math.max(240, rect.right - e.clientX));
      state.sideW = w;
      shell.style.setProperty('--side-w', w + 'px');
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('openbot-side-w', String(state.sideW)); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    handle.onmousedown = (e) => {
      if (state.sideCollapsed) return;
      e.preventDefault();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    handle.onkeydown = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? 24 : -24;
      state.sideW = Math.min(640, Math.max(240, (state.sideW || 320) + delta));
      shell.style.setProperty('--side-w', state.sideW + 'px');
      try { localStorage.setItem('openbot-side-w', String(state.sideW)); } catch {}
    };
  }

  async function openActivity() {
    state.view = 'activity';
    renderApp();
    await paintActivity();
  }

  function elapsed(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  async function paintActivity() {
    const box = document.getElementById('activity-board');
    if (!box) return;
    try {
      const res = await api('/v1/activity');
      state.activity = res.bots || [];
    } catch { /* keep */ }
    if (!state.activity.length) {
      box.innerHTML = '<li class="empty">No active teammates.</li>';
      return;
    }
    box.innerHTML = '';
    for (const b of state.activity) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'act-card';
      const pres = b.presence || { key: 'idle', label: 'Dormant' };
      const time = b.turn && (b.turn.status === 'running' || b.turn.status === 'queued')
        ? elapsed(b.turn.startedAt || b.turn.createdAt)
        : '';
      btn.innerHTML = '<strong>' + escapeHtml(b.name) + '</strong> ' +
        '<span class="st ' + escapeHtml(pres.key) + '"></span> ' +
        '<span class="muted">' + escapeHtml(pres.label) + (time ? ' · ' + time : '') +
        (b.queued ? ' · ' + b.queued + ' queued' : '') + '</span>' +
        (b.doing ? '<div class="doing">' + escapeHtml(b.doing) + '</div>' : '') +
        (b.lastMessage ? '<div class="snip">' + escapeHtml((b.lastMessage.role === 'user' ? 'You: ' : '') + b.lastMessage.body) + '</div>' : '');
      btn.onclick = () => selectBot(b.id);
      li.append(btn);
      box.append(li);
    }
  }

  function setLiveRaw(raw) {
    state.liveRaw = raw;
    try { localStorage.setItem('openbot-live-raw', raw ? '1' : '0'); } catch {}
    const human = document.getElementById('live-human');
    const rawBtn = document.getElementById('live-raw');
    if (human) human.setAttribute('aria-pressed', raw ? 'false' : 'true');
    if (rawBtn) rawBtn.setAttribute('aria-pressed', raw ? 'true' : 'false');
    paintLive();
  }

  async function refreshCompute() {
    try {
      state.compute = await api('/v1/compute');
      const host = document.getElementById('host');
      if (host) {
        const c = state.compute;
        host.textContent = (c.harness === 'in_turn' ? 'working' : (c.harness || 'down')) + ' · browser ' + (c.browser || 'down');
      }
      const header = el.querySelector('.header-actions');
      if (header) {
        const pill = header.querySelector('.pill');
        const next = h(statusPill());
        if (pill && next) pill.replaceWith(next);
      }
      const pres = (state.compute && state.compute.bots) || [];
      for (const b of pres) {
        const row = document.querySelector('button.bot[data-id="' + b.id + '"]');
        if (!row || !b.presence) continue;
        const st = row.querySelector('.st');
        const lab = row.querySelector('.presence');
        if (st) { st.className = 'st ' + b.presence.key; st.title = b.presence.label; }
        if (lab) lab.textContent = (b.presence.key === 'working' && b.doing) ? b.doing : b.presence.label;
        const match = state.bots.find(x => x.id === b.id);
        if (match) { match.presence = b.presence; match.doing = b.doing; }
      }
      if (state.view === 'activity') void paintActivity();
      else paintMessages();
    } catch {}
  }

  function liveUpdate(ev) {
    const p = ev.payload || {};
    return p.update || p;
  }
  function contentText(c) {
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(contentText).join('');
    if (typeof c === 'object' && c.text) return String(c.text);
    return '';
  }
  function prettyVal(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return v; }
      }
      return v;
    }
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  function toolTitle(s) {
    return String(s || 'Tool').replace(/^openbot__/, '').replace(/^use_tool$/i, 'Tool').replaceAll('_', ' ');
  }
  function toolIdOf(u) {
    return u.toolCallId || (u.toolCall && u.toolCall.toolCallId) || '';
  }

  function buildLiveBlocks(events) {
    const blocks = [];
    const tools = new Map();
    const working = state.compute && (state.compute.harness === 'in_turn' || state.compute.harness === 'starting');
    for (const ev of events) {
      const u = liveUpdate(ev);
      const kind = ev.kind || u.sessionUpdate || '';
      if (kind === 'agent_thought_chunk') {
        const t = contentText(u.content);
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'thought') last.text += t;
        else blocks.push({ type: 'thought', id: 'th-' + blocks.length, text: t });
      } else if (kind === 'agent_message_chunk') {
        const t = contentText(u.content);
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'write') last.text += t;
        else blocks.push({ type: 'write', id: 'wr-' + blocks.length, text: t });
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = toolIdOf(u) || ('tool-' + blocks.length);
        let b = tools.get(id);
        if (!b) {
          b = { type: 'tool', id: id, title: toolTitle(u.title || u.kind), status: u.status || 'running', input: u.rawInput || u.input, output: null };
          tools.set(id, b);
          blocks.push(b);
        }
        if (u.title) b.title = toolTitle(u.title);
        if (u.status) b.status = u.status;
        if (u.rawInput != null) b.input = u.rawInput;
        if (u.input != null) b.input = u.input;
        if (u.rawOutput != null) b.output = u.rawOutput;
        if (u.result != null) b.output = u.result;
        if (kind === 'tool_call_update' && u.content != null) b.output = u.content;
      } else if (kind === 'user_message_chunk') {
        const last = blocks[blocks.length - 1];
        if (!(last && last.type === 'status' && last.text === 'Reading your message')) {
          blocks.push({ type: 'status', id: 'st-' + blocks.length, text: 'Reading your message' });
        }
      } else if (kind === 'permission_request') {
        blocks.push({ type: 'status', id: 'st-' + blocks.length, text: 'Needs permission' });
      } else if (kind === 'acp_notify' && String((ev.payload || {}).method || '').indexOf('prompt_complete') >= 0) {
        blocks.push({ type: 'status', id: 'st-' + blocks.length, text: 'Turn finished' });
      }
    }
    const last = blocks[blocks.length - 1];
    for (const b of blocks) {
      if (b.type === 'thought') b.openDefault = working && last === b;
      if (b.type === 'tool') b.openDefault = b.status === 'running' || b.status === 'in_progress';
      if (b.type === 'write') b.openDefault = false;
    }
    return blocks;
  }

  function liveHumanLine(ev) {
    const blocks = buildLiveBlocks([ev]);
    const last = blocks[blocks.length - 1];
    if (!last) return null;
    if (last.type === 'thought') return 'Thinking';
    if (last.type === 'write') return 'Writing';
    if (last.type === 'tool') return (last.status === 'completed' ? 'Finished ' : 'Using ') + last.title;
    return last.text || null;
  }

  function liveSummary() {
    const blocks = buildLiveBlocks(state.live);
    const last = [...blocks].reverse().find(b => b.type !== 'status' || b.text === 'Needs permission' || b.text === 'Turn finished');
    if (!last) return state.compute && state.compute.harness === 'in_turn' ? 'Working' : 'Quiet';
    if (last.type === 'thought') return 'Thinking';
    if (last.type === 'write') return 'Writing';
    if (last.type === 'tool') return (last.status === 'running' ? 'Using ' : last.status === 'completed' ? 'Finished ' : '') + last.title;
    return last.text;
  }

  function paintLive() {
    const live = document.getElementById('live');
    const sum = document.getElementById('live-summary');
    if (sum) sum.textContent = liveSummary();
    if (!live) return;
    const openIds = new Set([...live.querySelectorAll('details[open]')].map(d => d.getAttribute('data-id')));
    if (state.liveRaw) {
      live.className = 'live';
      live.textContent = state.live.slice(-40).map(e => e.kind).join('\\n') || 'No events yet';
      return;
    }
    live.className = 'live-log';
    live.innerHTML = '';
    const blocks = buildLiveBlocks(state.live);
    if (!blocks.length) {
      live.textContent = 'No activity yet';
      return;
    }
    for (const b of blocks) {
      if (b.type === 'status') {
        const div = document.createElement('div');
        div.className = 'live-status';
        div.textContent = b.text;
        live.append(div);
        continue;
      }
      const det = document.createElement('details');
      det.className = 'live-block ' + b.type + (b.type === 'tool' ? ' ' + (b.status || '') : '');
      det.setAttribute('data-id', b.id);
      det.open = openIds.has(b.id) || (!openIds.size && b.openDefault);
      const sumEl = document.createElement('summary');
      if (b.type === 'thought') sumEl.append(document.createTextNode('Thinking'));
      else if (b.type === 'write') sumEl.append(document.createTextNode('Writing to thread'));
      else {
        sumEl.append(document.createTextNode(b.title || 'Tool'));
        const st = document.createElement('span');
        st.className = 'tool-st';
        st.textContent = b.status || 'running';
        sumEl.append(st);
      }
      det.append(sumEl);
      if (b.type === 'tool') {
        if (b.input != null && b.input !== '') {
          const h4 = document.createElement('h4');
          h4.textContent = 'Input';
          const pre = document.createElement('pre');
          pre.className = 'live-body';
          pre.textContent = prettyVal(b.input);
          const wrap = document.createElement('div');
          wrap.className = 'live-kv';
          wrap.append(h4, pre);
          det.append(wrap);
        }
        if (b.output != null && b.output !== '') {
          const h4 = document.createElement('h4');
          h4.textContent = 'Output';
          const pre = document.createElement('pre');
          pre.className = 'live-body';
          pre.textContent = prettyVal(b.output);
          const wrap = document.createElement('div');
          wrap.className = 'live-kv';
          wrap.append(h4, pre);
          det.append(wrap);
        }
      } else {
        const pre = document.createElement('pre');
        pre.className = 'live-body';
        pre.textContent = b.text || '';
        det.append(pre);
      }
      live.append(det);
    }
  }

  function upsertMessage(m) {
    if (!m || !m.id) return;
    // Per-turn @mention clones are not transcript bubbles.
    if (m.origin === 'prompt') return;
    const tid = m.thread_id || m.threadId;
    const sameThread = Boolean(state.thread && tid === state.thread.id);
    // Other threads' system/fallback must not land in this transcript.
    if (!sameThread) return;
    const idx = state.messages.findIndex(x => x.id === m.id || (x.id && String(x.id).startsWith('tmp-') && x.body === m.body && x.role === m.role));
    const wasNew = idx < 0;
    if (idx >= 0) {
      const prev = state.messages[idx];
      state.messages[idx] = {
        ...prev,
        ...m,
        // Keep tmp pending until sendMsg stamps _turnIds; WS can replace the object first.
        _pending: Boolean(prev._pending && m.origin === 'user'),
        _failed: false,
        _turnIds: Array.isArray(prev._turnIds) ? prev._turnIds : m._turnIds,
      };
    } else {
      state.messages.push(m);
    }
    paintMessages();
    if (wasNew && m.role !== 'user') announce(senderLabel(m) + ' replied');
  }

  async function reloadThread() {
    if (state.view === 'activity') { void paintActivity(); return; }
    if (state.view === 'archive') return;
    try {
      let t;
      if ((state.view === 'a2a' || state.view === 'group') && state.thread) {
        t = await api('/v1/threads/' + state.thread.id);
      } else if (state.bot) {
        t = await api('/v1/threads?botId=' + encodeURIComponent(state.bot.id));
      } else {
        return;
      }
      if (t.thread) state.thread = t.thread;
      const prevById = new Map(state.messages.filter(m => m.id).map(m => [m.id, m]));
      const keepFailed = state.messages.filter(m => m._failed);
      state.messages = visibleMessages(t.messages).map(m => {
        const prev = prevById.get(m.id);
        if (prev && Array.isArray(prev._turnIds)) return { ...m, _turnIds: prev._turnIds };
        return m;
      });
      for (const f of keepFailed) {
        if (!state.messages.some(m => m.body === f.body && m.role === 'user')) state.messages.push(f);
      }
      paintMessages();
      await catchUpLive(t.latestTurnId);
    } catch {}
  }

  async function catchUpLive(turnId) {
    if (!turnId) return;
    try {
      const lw = await api('/v1/turns/' + turnId + '/live-work');
      state.live = (lw.events || []).map(e => ({
        kind: e.kind,
        payload: parsePayload(e.payload)
      }));
      paintLive();
    } catch {
      state.live = [];
      paintLive();
    }
  }

  function connectPush() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/v1/push');
    ws.onopen = () => { state.ws = 'live'; refreshCompute(); };
    ws.onclose = () => {
      state.ws = 'down';
      refreshCompute();
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(connectPush, 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'message.created' && msg.message && msg.message.origin !== 'prompt') upsertMessage(msg.message);
      if (msg.type === 'turn.updated') {
        dropFinishedTurn(msg.turnId, msg.status);
        void reloadThread();
      }
      if (msg.type === 'live_work') {
        if (msg.turnId) state.turn = msg.turnId;
        state.live.push(msg.event);
        paintLive();
        paintMessages();
      }
      if (msg.type === 'permission_request') showPerm(msg);
    };
  }

  function openOverlay(node, onClose) {
    const prev = document.activeElement;
    document.body.append(node);
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    const focusables = () => [...node.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled);
    const list = focusables();
    (list[0] || node).focus();
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() {
      node.removeEventListener('keydown', key);
      node.remove();
      if (prev && prev.focus) prev.focus();
      if (onClose) onClose();
    }
    node.addEventListener('keydown', key);
    node.addEventListener('click', (e) => { if (e.target === node) close(); });
    return close;
  }

  function deleteOn(archivedAt) {
    const end = Number(archivedAt || 0) + (state.archiveTtlMs || 30 * 24 * 60 * 60 * 1000);
    if (!end) return { days: 0, label: 'soon' };
    const d = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    const when = new Date(end).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    return { days: d, label: 'Deletes ' + when + ' (' + d + ' day' + (d === 1 ? '' : 's') + ' left)' };
  }
  function daysLeft(archivedAt) { return deleteOn(archivedAt).days; }

  function askConfirm(opts) {
    return new Promise((resolve) => {
      const overlay = h(\`<div class="overlay"><div class="modal">
        <h2 id="c-title"></h2>
        <p id="c-body"></p>
        <label for="c-type" id="c-label" hidden></label>
        <input id="c-type" autocomplete="off" hidden />
        <p class="err" id="c-err" hidden></p>
        <div class="modal-actions">
          <button type="button" class="primary" id="c-ok"></button>
          <button type="button" id="c-no">Cancel</button>
        </div>
      </div></div>\`);
      overlay.querySelector('.modal').setAttribute('aria-labelledby', 'c-title');
      overlay.querySelector('#c-title').textContent = opts.title || 'Confirm';
      overlay.querySelector('#c-body').textContent = opts.body || '';
      overlay.querySelector('#c-ok').textContent = opts.confirmLabel || 'Confirm';
      if (opts.requireText) {
        overlay.querySelector('#c-label').hidden = false;
        overlay.querySelector('#c-label').textContent = opts.typedLabel || ('Type ' + opts.requireText + ' to confirm');
        overlay.querySelector('#c-type').hidden = false;
      }
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };
      const close = openOverlay(overlay, () => finish(false));
      overlay.querySelector('#c-no').onclick = () => { close(); finish(false); };
      overlay.querySelector('#c-ok').onclick = () => {
        if (opts.requireText) {
          const typed = overlay.querySelector('#c-type').value.trim();
          if (typed.toLowerCase() !== String(opts.requireText).toLowerCase()) {
            const err = overlay.querySelector('#c-err');
            err.hidden = false;
            err.textContent = 'That does not match.';
            overlay.querySelector('#c-type').focus();
            return;
          }
        }
        finish(true);
        close();
      };
    });
  }

  function showPerm(msg) {
    const overlay = h(\`<div class="overlay"><div class="modal">
      <h2 id="perm-title">Permission</h2>
      <pre class="live">\${escapeHtml(JSON.stringify(msg.payload || msg, null, 2))}</pre>
      <div class="modal-actions">
        <button class="primary" type="button" id="allow">Allow</button>
        <button type="button" id="deny">Deny</button>
      </div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'perm-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#allow').onclick = async () => {
      await api('/v1/turns/' + msg.turnId + '/permissions/' + (msg.reqId || 'x'), { method:'POST', body: JSON.stringify({ allow:true }) });
      close();
    };
    overlay.querySelector('#deny').onclick = async () => {
      await api('/v1/turns/' + msg.turnId + '/permissions/' + (msg.reqId || 'x'), { method:'POST', body: JSON.stringify({ allow:false }) });
      close();
    };
  }

  async function refreshRoster() {
    const bots = await api('/v1/bots');
    state.bots = bots.bots || [];
    state.gateway = bots.gateway || null;
    state.archived = bots.archived || [];
    if (bots.archiveTtlMs) state.archiveTtlMs = bots.archiveTtlMs;
    if (state.bot) {
      state.bot = state.bots.find(b => b.id === state.bot.id)
        || (state.gateway && state.gateway.id === state.bot.id ? state.gateway : state.bot);
    }
  }

  async function openArchiveFolder() {
    try { await refreshRoster(); } catch {}
    state.view = 'archive';
    renderApp();
  }

  async function archiveCurrentBot() {
    if (!state.bot || isGatewayBot(state.bot)) return;
    const name = state.bot.name;
    const id = state.bot.id;
    const ok = await askConfirm({
      title: 'Move ' + name + ' to Archive?',
      body: name + ' leaves Team. Open Archive in the sidebar to restore them. After 30 days they are deleted. Desk files stay.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      await api('/v1/bots/' + id + '/archive', { method:'POST', body: '{}' });
      announce(name + ' moved to Archive');
      await refreshRoster();
      state.bot = state.bots[0] || null;
      state.view = 'archive';
      if (!state.bot && !state.archived.length) return renderOnboard();
      renderApp();
    } catch (e) {
      announce(e.message || 'Could not archive');
    }
  }

  function paintArchiveFolder() {
    const box = document.getElementById('archive-folder');
    if (!box) return;
    if (!state.archived.length) {
      box.innerHTML = '<li class="empty">Archive is empty. Archived teammates stay here 30 days, then they are deleted.</li>';
      return;
    }
    box.innerHTML = state.archived.map(b => {
      const info = deleteOn(b.archived_at);
      return '<li class="archive-row">' +
        '<div><strong>' + escapeHtml(b.name) + '</strong><div class="meta">' + escapeHtml(info.label) + '</div></div>' +
        '<div class="msg-actions">' +
        '<button type="button" data-restore="' + b.id + '">Restore</button>' +
        '<button type="button" data-purge="' + b.id + '" data-name="' + escapeHtml(b.name) + '">Delete</button>' +
        '</div></li>';
    }).join('');
    box.querySelectorAll('[data-restore]').forEach(btn => {
      btn.onclick = async () => {
        try {
          const id = btn.getAttribute('data-restore');
          await api('/v1/bots/' + id + '/restore', { method:'POST', body: '{}' });
          await refreshRoster();
          const bot = state.bots.find(b => b.id === id);
          if (bot) await selectBot(bot.id);
          else { state.view = 'archive'; renderApp(); }
        } catch (e) { announce(e.message); }
      };
    });
    box.querySelectorAll('[data-purge]').forEach(btn => {
      btn.onclick = async () => {
        const nm = btn.getAttribute('data-name') || 'this bot';
        const ok = await askConfirm({
          title: 'Delete ' + nm + '?',
          body: 'This cannot be undone. Their threads and messages are removed.',
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        try {
          await api('/v1/bots/' + btn.getAttribute('data-purge') + '/purge', { method:'POST', body: JSON.stringify({ confirm: 'DELETE' }) });
          announce(nm + ' deleted');
          await refreshRoster();
          renderApp();
        } catch (e) { announce(e.message); }
      };
    });
  }

  function openOrgs() {
    const overlay = h(\`<div class="overlay"><div class="modal">
      <h2 id="orgs-title">Orgs</h2>
      <p class="muted">Where this browser can open a desk. Not the Gateway peer allowlist — that lives in Settings.</p>
      <p><strong>This instance</strong> · \${escapeHtml(thisOrgName())} · <span class="mono">\${escapeHtml(location.origin)}</span></p>
      <ul id="org-list"></ul>
      <p class="err" id="org-err" hidden></p>
      <div class="modal-actions">
        <button type="button" class="primary" id="bookmark-org">Bookmark this URL</button>
        <button type="button" id="close-orgs">Close</button>
      </div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'orgs-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close-orgs').onclick = close;
    function paintBookmarks() {
      const box = overlay.querySelector('#org-list');
      const err = overlay.querySelector('#org-err');
      err.hidden = true;
      const list = loadOrgBookmarks();
      if (!list.length) {
        box.innerHTML = '<li class="muted">No bookmarks yet. Bookmark this URL, then open the other org and bookmark there too.</li>';
        return;
      }
      box.innerHTML = list.map(o => {
        const here = parseHttpUrl(o.baseUrl) && parseHttpUrl(o.baseUrl).origin === location.origin;
        return '<li class="org-row"><div><strong>' + escapeHtml(o.name) + '</strong>' +
          (here ? ' <span class="muted">this instance</span>' : '') +
          '<div class="muted mono">' + escapeHtml(o.baseUrl) + '</div></div><div class="msg-actions">' +
          (here ? '' : '<button type="button" data-go="' + escapeHtml(o.baseUrl) + '">Open</button>') +
          '<button type="button" data-forget="' + escapeHtml(o.baseUrl) + '">Remove</button></div></li>';
      }).join('');
      box.querySelectorAll('[data-go]').forEach(btn => {
        btn.onclick = () => {
          const url = parseHttpUrl(btn.getAttribute('data-go'));
          if (!url) { err.hidden = false; err.textContent = 'Only http and https org URLs are allowed'; return; }
          goToOrg(url.href);
        };
      });
      box.querySelectorAll('[data-forget]').forEach(btn => {
        btn.onclick = () => {
          const target = parseHttpUrl(btn.getAttribute('data-forget'));
          saveOrgBookmarks(loadOrgBookmarks().filter(o => {
            const u = parseHttpUrl(o.baseUrl);
            return !target || !u || u.origin !== target.origin;
          }));
          paintBookmarks();
        };
      });
    }
    overlay.querySelector('#bookmark-org').onclick = () => {
      const err = overlay.querySelector('#org-err');
      const url = parseHttpUrl(location.origin);
      if (!url) { err.hidden = false; err.textContent = 'Only http and https org URLs are allowed'; return; }
      const name = thisOrgName();
      const list = loadOrgBookmarks();
      if (list.some(o => { const u = parseHttpUrl(o.baseUrl); return u && u.origin === url.origin; })) {
        err.hidden = false; err.textContent = 'Already bookmarked'; return;
      }
      list.push({ name, baseUrl: url.origin });
      saveOrgBookmarks(list);
      err.hidden = true;
      announce('Bookmarked ' + name);
      paintBookmarks();
    };
    paintBookmarks();
  }

  function openHelp() {
    const overlay = h(\`<div class="overlay"><div class="modal">
      <h2 id="help-title">Keyboard and chat</h2>
      <ul>
        <li><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</li>
        <li>Focus stays in the composer after send</li>
        <li><kbd>Esc</kbd> closes dialogs</li>
        <li>Skip link (first Tab) jumps to the message box</li>
      </ul>
      <p class="muted">Teammates keep working if you close this tab. Stopping <code>openbot server</code> stops them.</p>
      <p class="muted">OpenAI-compatible clients (Open WebUI) can use <code>/v1</code> with an API key from Settings.</p>
      <div class="modal-actions"><button type="button" class="primary" id="close">Close</button></div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'help-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close').onclick = close;
  }

  async function openSettings() {
    try { state.org = await api('/v1/org'); } catch { state.org = state.org || {}; }
    const fedOn = Boolean(state.org && state.org.federationEnabled);
    let orgPub = '';
    let orgId = (state.org && state.org.orgId) || '';
    try {
      const info = await api('/fed/v1/info');
      if (info && info.pubkey) orgPub = String(info.pubkey);
      if (!orgId && info && info.orgId) orgId = String(info.orgId);
    } catch {}
    const overlay = h(\`<div class="overlay"><div class="modal">
      <h2 id="set-title">Settings</h2>
      <p class="muted">\${harnessBlurb()}</p>
      <h2 style="margin-top:8px;font-size:1rem">Federation</h2>
      <p class="muted" id="fed-state">\${fedOn ? 'Federation is on. Gateway may send and receive org mail.' : 'Federation is off. Gateway will not talk to other orgs.'}</p>
      <div class="seg" role="group" aria-label="Federation">
        <button type="button" id="fed-on" aria-pressed="\${fedOn ? 'true' : 'false'}">On</button>
        <button type="button" id="fed-off" aria-pressed="\${fedOn ? 'false' : 'true'}">Off</button>
      </div>
      <p class="err" id="fed-err" hidden></p>
      <h2 style="margin-top:16px;font-size:1rem">This org</h2>
      <p class="muted">Share org id and pubkey with the other operator. Never the private key.</p>
      <label for="org-id">Org id</label>
      <input id="org-id" class="mono" readonly value="\${escapeHtml(orgId)}" />
      <button type="button" id="copy-org-id">Copy org id</button>
      <label for="org-pub">Pubkey</label>
      <input id="org-pub" class="mono" readonly value="\${escapeHtml(orgPub)}" />
      <button type="button" id="copy-org-pub">Copy pubkey</button>
      <h2 style="margin-top:16px;font-size:1rem">Peers</h2>
      <p class="muted">Who Gateway may talk to. Separate from Orgs bookmarks.</p>
      <ul id="peer-list"></ul>
      <p class="err" id="peer-err" hidden></p>
      <label for="peer-url">Peer base URL</label>
      <input id="peer-url" placeholder="https://beta.example.com" autocomplete="off" />
      <button type="button" id="peer-from-info">Preview from-info</button>
      <div id="peer-preview-box" hidden>
        <label for="peer-slug">Slug</label>
        <input id="peer-slug" autocomplete="off" />
        <label for="peer-name">Name</label>
        <input id="peer-name" autocomplete="off" />
        <p class="muted mono" id="peer-preview-meta"></p>
        <button type="button" class="primary" id="peer-add">Add peer</button>
      </div>
      <div id="solicit-wrap" hidden>
        <h2 style="margin-top:16px;font-size:1rem">Solicitations</h2>
        <ul id="solicit-list"></ul>
      </div>
      <label for="set-key">API key override (optional)</label>
      <input id="set-key" type="password" autocomplete="off" placeholder="leave blank to use grok login" />
      \${inferenceFields('set-model', 'set-effort')}
      <div id="desk-controls">
      <label for="mode">Permission mode</label>
      <select id="mode">
        <option value="auto">Auto</option>
        <option value="ask">Ask</option>
        <option value="always-approve">Always-approve</option>
      </select>
      <label><input type="checkbox" id="approve" /> Require approval for SendMessage</label>
      </div>
      <h2 style="margin-top:16px;font-size:1rem">OpenAI-compatible keys</h2>
      <p class="muted">For Open WebUI or any OpenAI client. Base URL <code>\${location.origin}/v1</code>, model <code>openbot/\${escapeHtml(state.bot?.name || 'Ada')}</code>.</p>
      <p class="muted">Each OpenBot process is one org. Switch org in Open WebUI by adding another connection (that VM’s base URL + a <code>sk-ob_…</code> key minted there). There is no OpenAI organization field. Models include <code>openbot/Gateway</code> when present. Federation is off until you turn it on.</p>
      <ul id="key-list" class="muted"></ul>
      <p class="err" id="key-err" hidden></p>
      <button type="button" id="mint">Create API key</button>
      <p class="muted" id="key-once-wrap" hidden>
        <label for="key-once">Copy now — shown once</label>
        <input id="key-once" readonly />
      </p>
      <p class="muted">Archive is a folder in the sidebar. Open it to restore, delete, or see when a teammate will be removed.</p>
      <p class="err" id="wipe-err" hidden></p>
      <p class="muted">Wipe desk deletes the shared folder for every bot. Type DELETE, then Wipe desk.</p>
      <label for="wipe-confirm">Type DELETE to confirm wipe</label>
      <input id="wipe-confirm" autocomplete="off" placeholder="DELETE" />
      <div class="modal-actions">
        <button class="primary" type="button" id="save">Save</button>
        <button type="button" id="archive">Archive this bot…</button>
        <button type="button" id="wipe">Wipe desk</button>
        <button type="button" id="close">Close</button>
      </div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'set-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close').onclick = close;
    const gwView = isGatewayBot(state.bot);
    if (gwView) {
      const desk = overlay.querySelector('#desk-controls');
      if (desk) desk.hidden = true;
      const arch = overlay.querySelector('#archive');
      if (arch) arch.hidden = true;
    }
    if (state.bot && !gwView) {
      overlay.querySelector('#mode').value = state.bot.permission_mode || 'auto';
      overlay.querySelector('#approve').checked = Boolean(Number(state.bot.require_human_approval));
    }
    function paintFedState() {
      const on = Boolean(state.org && state.org.federationEnabled);
      overlay.querySelector('#fed-on').setAttribute('aria-pressed', on ? 'true' : 'false');
      overlay.querySelector('#fed-off').setAttribute('aria-pressed', on ? 'false' : 'true');
      overlay.querySelector('#fed-state').textContent = on
        ? 'Federation is on. Gateway may send and receive org mail.'
        : 'Federation is off. Gateway will not talk to other orgs.';
      const lab = document.querySelector('#open-gateway .presence');
      if (lab && state.gateway) lab.textContent = state.gateway.enabled ? 'Federation on' : 'Federation off';
    }
    async function setFederation(on) {
      const err = overlay.querySelector('#fed-err');
      try {
        const res = await api('/v1/org', { method:'PATCH', body: JSON.stringify({ federationEnabled: on }) });
        state.org = res;
        if (state.gateway) state.gateway.enabled = Boolean(res.federationEnabled);
        paintFedState();
        if (on && !res.federationEnabled) {
          err.hidden = false;
          err.textContent = 'Federation stayed off. OPENBOT_FEDERATION=0 overrides the toggle.';
        } else {
          err.hidden = true;
        }
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || 'Could not update federation';
      }
    }
    overlay.querySelector('#fed-on').onclick = () => setFederation(true);
    overlay.querySelector('#fed-off').onclick = () => setFederation(false);
    overlay.querySelector('#copy-org-id').onclick = (e) => copyText(overlay.querySelector('#org-id').value, e.currentTarget, 'Copied org id');
    overlay.querySelector('#copy-org-pub').onclick = (e) => copyText(overlay.querySelector('#org-pub').value, e.currentTarget, 'Copied pubkey');
    let peerPreview = null;
    async function refreshPeers() {
      const list = overlay.querySelector('#peer-list');
      const err = overlay.querySelector('#peer-err');
      try {
        const res = await api('/v1/org/peers');
        const peers = res.peers || [];
        list.innerHTML = peers.length
          ? peers.map(p => '<li class="peer-row"><div><strong>' + escapeHtml(p.slug) + '</strong> ' + escapeHtml(p.name || '') +
            '<div class="muted">' + escapeHtml(p.baseUrl || '') + ' · ' + escapeHtml(p.status || '') + '</div></div>' +
            '<div class="msg-actions">' +
            '<button type="button" class="linkish" data-copy-pub="' + escapeHtml(p.pubkey || '') + '">Copy pubkey</button>' +
            (p.status === 'allowed' ? '<button type="button" data-disable="' + escapeHtml(p.orgId) + '">Disable</button>' : '') +
            '<button type="button" data-del="' + escapeHtml(p.orgId) + '">Remove</button></div></li>').join('')
          : '<li class="muted">No peers yet. Preview a URL, then add.</li>';
        list.querySelectorAll('[data-copy-pub]').forEach(btn => {
          btn.onclick = () => copyText(btn.getAttribute('data-copy-pub'), btn, 'Copied pubkey');
        });
        list.querySelectorAll('[data-disable]').forEach(btn => {
          btn.onclick = async () => {
            try {
              await api('/v1/org/peers/' + encodeURIComponent(btn.getAttribute('data-disable')) + '/disable', { method:'POST', body: '{}' });
              err.hidden = true;
              refreshPeers();
            } catch (e) { err.hidden = false; err.textContent = e.message || 'Could not disable peer'; }
          };
        });
        list.querySelectorAll('[data-del]').forEach(btn => {
          btn.onclick = async () => {
            try {
              await api('/v1/org/peers/' + encodeURIComponent(btn.getAttribute('data-del')), { method:'DELETE' });
              err.hidden = true;
              refreshPeers();
            } catch (e) { err.hidden = false; err.textContent = e.message || 'Could not remove peer'; }
          };
        });
        err.hidden = true;
      } catch (e) {
        list.innerHTML = '';
        err.hidden = false;
        err.textContent = e.message || 'Could not load peers';
      }
    }
    overlay.querySelector('#peer-from-info').onclick = async () => {
      const err = overlay.querySelector('#peer-err');
      const box = overlay.querySelector('#peer-preview-box');
      const typed = overlay.querySelector('#peer-url').value;
      const url = parseHttpUrl(typed);
      if (!url) { err.hidden = false; err.textContent = 'Only http and https peer URLs are allowed'; box.hidden = true; return; }
      try {
        peerPreview = await api('/v1/org/peers/from-info', { method:'POST', body: JSON.stringify({ baseUrl: typed }) });
        overlay.querySelector('#peer-slug').value = peerPreview.slug || '';
        overlay.querySelector('#peer-name').value = peerPreview.name || '';
        overlay.querySelector('#peer-preview-meta').textContent =
          (peerPreview.orgId || '') + ' · ' + (peerPreview.pubkey || '') +
          (peerPreview.publicOrigin ? ' · ' + peerPreview.publicOrigin : '');
        box.hidden = false;
        err.hidden = true;
      } catch (e) {
        peerPreview = null;
        box.hidden = true;
        err.hidden = false;
        err.textContent = e.message || 'from-info failed';
      }
    };
    overlay.querySelector('#peer-add').onclick = async () => {
      const err = overlay.querySelector('#peer-err');
      if (!peerPreview) { err.hidden = false; err.textContent = 'Preview from-info first'; return; }
      try {
        await api('/v1/org/peers', { method:'POST', body: JSON.stringify({
          slug: overlay.querySelector('#peer-slug').value,
          name: overlay.querySelector('#peer-name').value,
          orgId: peerPreview.orgId,
          pubkey: peerPreview.pubkey,
          baseUrl: overlay.querySelector('#peer-url').value,
        }) });
        overlay.querySelector('#peer-preview-box').hidden = true;
        peerPreview = null;
        err.hidden = true;
        announce('Peer added');
        refreshPeers();
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || 'Could not add peer';
      }
    };
    async function refreshSolicits() {
      const wrap = overlay.querySelector('#solicit-wrap');
      const box = overlay.querySelector('#solicit-list');
      const lines = [];
      const seen = new Set();
      function addLines(arr) {
        for (const line of arr) {
          if (seen.has(line)) continue;
          seen.add(line);
          lines.push(line);
        }
      }
      try {
        // Untrusted solicitations may live on inbox; skip if that route is not shipped yet.
        const res = await fetch('/v1/org/inbox', { credentials:'same-origin', headers: { 'content-type':'application/json' } });
        if (res.status !== 404 && res.ok) addLines(solicitNotices(await res.json()));
      } catch {}
      try {
        const act = await api('/v1/activity');
        for (const b of act.bots || []) {
          const text = String((b.lastMessage && b.lastMessage.body) || b.doing || '');
          const m = /Org (.+) tried to send mail/i.exec(text);
          if (m) addLines(['Org ' + m[1] + ' tried to send mail']);
        }
      } catch {}
      if (!lines.length) { wrap.hidden = true; return; }
      wrap.hidden = false;
      box.innerHTML = lines.map(s => '<li>' + escapeHtml(s) + '</li>').join('');
    }
    void refreshPeers();
    void refreshSolicits();
    bindInferenceSelects(overlay, '#set-model', '#set-effort');
    overlay.querySelector('#save').onclick = async () => {
      const key = overlay.querySelector('#set-key').value.trim();
      if (key) await api('/v1/credentials/xai', { method:'PUT', body: JSON.stringify({ key }) });
      if (state.bot) {
        const payload = {
          model: overlay.querySelector('#set-model')?.value,
          reasoningEffort: overlay.querySelector('#set-effort')?.value,
        };
        if (!isGatewayBot(state.bot)) {
          payload.permissionMode = overlay.querySelector('#mode').value;
          payload.requireHumanApproval = overlay.querySelector('#approve').checked;
        }
        await api('/v1/bots/' + state.bot.id + '/settings', { method:'PATCH', body: JSON.stringify(payload) });
        state.bot.model = payload.model || state.bot.model;
        state.bot.reasoning_effort = payload.reasoningEffort || state.bot.reasoning_effort;
        if (isGatewayBot(state.bot)) state.gateway = state.bot;
      }
      close();
    };
    overlay.querySelector('#wipe').onclick = async () => {
      const typed = String(overlay.querySelector('#wipe-confirm').value || '').trim();
      const wipeErr = overlay.querySelector('#wipe-err');
      if (typed.toUpperCase() !== 'DELETE') {
        wipeErr.hidden = false;
        wipeErr.textContent = 'Type DELETE in the confirm box, then press Wipe desk.';
        overlay.querySelector('#wipe-confirm').focus();
        return;
      }
      try {
        await api('/v1/compute/wipe', { method:'POST', body: JSON.stringify({ confirm: 'DELETE' }) });
        wipeErr.hidden = true;
        announce('Desk wiped');
        close();
      } catch (e) {
        wipeErr.hidden = false;
        wipeErr.textContent = e.message || 'Wipe failed';
      }
    };
    overlay.querySelector('#archive').onclick = async () => {
      close();
      await archiveCurrentBot();
    };
    const list = overlay.querySelector('#key-list');
    const keyErr = overlay.querySelector('#key-err');
    async function refreshKeys() {
      try {
        const res = await api('/v1/api-keys');
        const keys = res.keys || res || [];
        list.innerHTML = keys.length
          ? keys.map(k => '<li>' + escapeHtml((k.prefix || '') + '…' + (k.lastFour || k.last_four || '')) + ' <button type="button" class="linkish" data-revoke="' + k.id + '">Revoke</button></li>').join('')
          : '<li>No keys yet</li>';
        list.querySelectorAll('[data-revoke]').forEach(btn => {
          btn.onclick = async () => { await api('/v1/api-keys/' + btn.getAttribute('data-revoke'), { method:'DELETE' }); refreshKeys(); };
        });
        keyErr.hidden = true;
      } catch (e) {
        list.innerHTML = '';
        keyErr.hidden = false;
        keyErr.textContent = e.status === 404 ? 'API keys ship with the OpenAI-compatible endpoint. Restart the server after that lands.' : e.message;
      }
    }
    overlay.querySelector('#mint').onclick = async () => {
      try {
        const res = await api('/v1/api-keys', { method:'POST', body: JSON.stringify({ name: 'open-webui' }) });
        const wrap = overlay.querySelector('#key-once-wrap');
        const once = overlay.querySelector('#key-once');
        wrap.hidden = false;
        once.value = res.token || '';
        once.focus();
        once.select();
        announce('API key created. Copy it now.');
        refreshKeys();
      } catch (e) {
        keyErr.hidden = false;
        keyErr.textContent = e.message;
      }
    };
    void refreshKeys();
  }

  async function startTakeover() {
    const t = await api('/v1/compute/takeover', { method:'POST', body: '{}' });
    const overlay = h(\`<div class="overlay"><div class="modal wide">
      <div class="modal-head">
        <h2 id="tk-title">Takeover</h2>
        <button type="button" id="done" class="primary">Close</button>
      </div>
      <p class="muted" id="urlbar">Connecting…</p>
      <p class="muted">This is the shared desk browser. about:blank means no page is open yet. Esc or Close ends takeover.</p>
      <canvas id="takeover-frame" width="1280" height="720" role="img" aria-label="Shared desk browser"></canvas>
      <div class="modal-actions"><button type="button" id="done-foot">Close takeover</button></div>
    </div></div>\`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'tk-title');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/v1/takeover');
    ws.binaryType = 'arraybuffer';
    const close = openOverlay(overlay, () => { try { ws.close(); } catch {} });
    function endTakeover() { try { ws.close(); } catch {} close(); }
    overlay.querySelector('#done').onclick = endTakeover;
    overlay.querySelector('#done-foot').onclick = endTakeover;
    const canvas = overlay.querySelector('#takeover-frame');
    canvas.tabIndex = 0;
    ws.onopen = () => ws.send(JSON.stringify({ type:'auth', ticket: t.ticket }));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'meta') overlay.querySelector('#urlbar').textContent = (msg.pageUrl || 'about:blank') + (msg.pageOrigin ? ' — ' + msg.pageOrigin : '');
        if (msg.error) overlay.querySelector('#urlbar').textContent = msg.error;
      } else {
        const blob = new Blob([ev.data], { type: 'image/jpeg' });
        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = URL.createObjectURL(blob);
      }
    };
    function frac(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault(); canvas.focus();
      const p = frac(e);
      ws.send(JSON.stringify({ type:'mouse', action:'pressed', x:p.x, y:p.y, button:'left' }));
    });
    canvas.addEventListener('mouseup', (e) => {
      const p = frac(e);
      ws.send(JSON.stringify({ type:'mouse', action:'released', x:p.x, y:p.y, button:'left' }));
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!e.buttons) return;
      const p = frac(e);
      ws.send(JSON.stringify({ type:'mouse', action:'moved', x:p.x, y:p.y, button:'left' }));
    });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); endTakeover(); return; }
      e.preventDefault();
      ws.send(JSON.stringify({ type:'key', action:'rawKeyDown', key:e.key, code:e.code }));
      if (e.key.length === 1) {
        ws.send(JSON.stringify({ type:'key', action:'char', key:e.key, code:e.code, text:e.key }));
      } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.key === 'Tab') {
        ws.send(JSON.stringify({ type:'key', action:'char', key:e.key, code:e.code, text: e.key === 'Enter' ? '\\r' : '' }));
      }
    });
    canvas.addEventListener('keyup', (e) => {
      if (e.key === 'Escape') return;
      ws.send(JSON.stringify({ type:'key', action:'keyUp', key:e.key, code:e.code }));
    });
  }

  boot().catch(err => {
    if (el.querySelector('.shell') || el.querySelector('.card')) return;
    el.innerHTML = '<main class="card"><h1>OpenBot</h1><p class="err"></p><p class="muted">Reload the tab. If this persists, the last live-work log may be corrupt.</p><p><button type="button" class="primary" onclick="location.reload()">Reload</button></p></main>';
    const p = el.querySelector('.err');
    if (p) p.textContent = err && err.message ? err.message : String(err);
  });
  </script>
</body>
</html>`;
