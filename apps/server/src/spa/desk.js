  const state = {
    me:null, bots:[], a2aGateway:null, groups:[], org:null, archived:[], archiveTtlMs: 30*24*60*60*1000, bot:null, thread:null, messages:[], live:[], compute:null, railCollapsed: localStorage.getItem('openbot-rail') === '1', sideCollapsed: localStorage.getItem('openbot-side') === '1',
    turn:null, a2a:[], view:'human', auth:{}, harness:{}, ws:'down', sending:false, activity:[], calendar:{ series:[], instances:[], timezone:'UTC' }, calMode:'agenda', calMonth:null, models:[], sideW: Number(localStorage.getItem('openbot-side-w') || 320), agUiContext:null, agUiRun:null, agUiAbort:null, agUiMessages:{}, agUiRetry:null,
    debug: false
  };
  try { state.debug = localStorage.getItem('openbot-debug') === '1'; } catch {}
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

  function newAgUiRunState(threadId, runId) {
    return {
      threadId, runId, phase:'idle', blocks:[], messages:{}, openMessages:{}, tools:{},
      reasoningSpan:null, reasoningMessage:null, activities:{}, interrupts:[],
      outcome:null, error:null, lastSeq:0
    };
  }

  // A deliberately small, strict reducer for the pinned AG-UI BaseEvent subset the
  // desk renders. Invalid boundaries fail closed instead of guessing at provider data.
  function reduceAgUiEvent(current, event) {
    const fail = message => { throw new Error('Invalid AG-UI stream: ' + message); };
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const text = (value, field, max=1048576) => {
      if (typeof value !== 'string' || !value || value.length > max) fail(field + ' is invalid');
      return value;
    };
    if (!record(current) || !record(event)) fail('event must be an object');
    if (event.type === 'RAW' || Object.prototype.hasOwnProperty.call(event, 'rawEvent')) fail('raw events are forbidden');
    const type = text(event.type, 'type', 128);
    const next = {
      ...current,
      blocks: (current.blocks || []).map(block => ({ ...block })),
      messages: { ...(current.messages || {}) },
      openMessages: { ...(current.openMessages || {}) },
      tools: Object.fromEntries(Object.entries(current.tools || {}).map(([id, tool]) => [id, { ...tool }])),
      activities: { ...(current.activities || {}) },
      interrupts: [...(current.interrupts || [])],
    };
    const seq = event.metadata && event.metadata.openbot && event.metadata.openbot.seq;
    if (seq !== undefined) {
      if (!Number.isSafeInteger(seq) || seq < 0 || seq < (next.lastSeq || 0)) fail('event sequence moved backwards');
      next.lastSeq = Math.max(next.lastSeq || 0, seq);
    }
    const add = block => {
      if (next.blocks.length >= 512) fail('too many rendered blocks');
      next.blocks.push(block);
      return next.blocks.length - 1;
    };
    const active = () => {
      if (next.phase !== 'active') fail(type + ' occurred outside an active run');
    };
    const sameRun = () => {
      if (event.runId !== next.runId || event.threadId !== next.threadId) fail('run identity changed');
    };

    if (type === 'RUN_STARTED') {
      if (next.phase !== 'idle') fail('run started twice');
      sameRun();
      next.phase = 'active';
      return next;
    }
    if (type === 'RUN_ERROR') {
      if (next.phase !== 'idle' && next.phase !== 'active') fail('RUN_ERROR occurred after a terminal event');
    } else {
      active();
    }

    if (type === 'TEXT_MESSAGE_START') {
      const id = text(event.messageId, 'messageId', 512);
      if (event.role !== 'assistant' || next.messages[id] !== undefined) fail('invalid message start');
      const index = add({ type:'write', id, text:'', status:'streaming' });
      next.messages[id] = index;
      next.openMessages[id] = index;
      return next;
    }
    if (type === 'TEXT_MESSAGE_CONTENT') {
      const id = text(event.messageId, 'messageId', 512);
      const index = next.openMessages[id];
      if (index === undefined || typeof event.delta !== 'string') fail('message delta has no open message');
      const value = (next.blocks[index].text || '') + event.delta;
      if (value.length > 1048576) fail('message is too large');
      next.blocks[index].text = value;
      return next;
    }
    if (type === 'TEXT_MESSAGE_END') {
      const id = text(event.messageId, 'messageId', 512);
      const index = next.openMessages[id];
      if (index === undefined) fail('message ended without a start');
      next.blocks[index].status = 'completed';
      delete next.openMessages[id];
      return next;
    }
    if (type === 'TOOL_CALL_START') {
      const id = text(event.toolCallId, 'toolCallId', 512);
      if (next.tools[id]) fail('tool call started twice');
      const title = text(event.toolCallName, 'toolCallName', 512);
      next.tools[id] = { index:add({ type:'tool', id, title, status:'running', input:'', output:null }), open:true, result:false };
      return next;
    }
    if (type === 'TOOL_CALL_ARGS') {
      const id = text(event.toolCallId, 'toolCallId', 512);
      const tool = next.tools[id];
      if (!tool || !tool.open || typeof event.delta !== 'string') fail('tool arguments have no open call');
      const value = (next.blocks[tool.index].input || '') + event.delta;
      if (value.length > 1048576) fail('tool arguments are too large');
      next.blocks[tool.index].input = value;
      return next;
    }
    if (type === 'TOOL_CALL_END') {
      const id = text(event.toolCallId, 'toolCallId', 512);
      const tool = next.tools[id];
      if (!tool || !tool.open) fail('tool ended without a start');
      try {
        const value = JSON.parse(next.blocks[tool.index].input || '{}');
        if (!record(value)) fail('tool arguments are not a JSON object');
      } catch (error) {
        if (String(error && error.message || error).startsWith('Invalid AG-UI stream:')) throw error;
        fail('tool arguments are not valid JSON');
      }
      tool.open = false;
      next.blocks[tool.index].status = 'finished';
      return next;
    }
    if (type === 'TOOL_CALL_RESULT') {
      const id = text(event.toolCallId, 'toolCallId', 512);
      text(event.messageId, 'tool result messageId', 512);
      const tool = next.tools[id];
      if (!tool || tool.open || tool.result || event.role !== 'tool' || typeof event.content !== 'string') fail('invalid tool result');
      if (event.content.length > 1048576) fail('tool result is too large');
      tool.result = true;
      next.blocks[tool.index].output = event.content;
      const outcome = event.metadata && event.metadata.outcome;
      next.blocks[tool.index].status = typeof outcome === 'string' && /^[a-z_-]{1,32}$/i.test(outcome) ? outcome : 'completed';
      return next;
    }
    if (type === 'REASONING_START') {
      if (next.reasoningSpan) fail('reasoning started twice');
      next.reasoningSpan = text(event.messageId, 'reasoning span id', 512);
      return next;
    }
    if (type === 'REASONING_MESSAGE_START') {
      if (!next.reasoningSpan || next.reasoningMessage || event.role !== 'reasoning') fail('invalid reasoning message start');
      const id = text(event.messageId, 'reasoning message id', 512);
      next.reasoningMessage = { id, index:add({ type:'thought', id, text:'', status:'streaming' }) };
      return next;
    }
    if (type === 'REASONING_MESSAGE_CONTENT') {
      if (!next.reasoningMessage || event.messageId !== next.reasoningMessage.id || typeof event.delta !== 'string') fail('reasoning delta has no open message');
      const block = next.blocks[next.reasoningMessage.index];
      const value = (block.text || '') + event.delta;
      if (value.length > 1048576) fail('reasoning summary is too large');
      block.text = value;
      return next;
    }
    if (type === 'REASONING_MESSAGE_END') {
      if (!next.reasoningMessage || event.messageId !== next.reasoningMessage.id) fail('reasoning message ended without a start');
      next.blocks[next.reasoningMessage.index].status = 'completed';
      next.reasoningMessage = null;
      return next;
    }
    if (type === 'REASONING_END') {
      if (!next.reasoningSpan || next.reasoningMessage || event.messageId !== next.reasoningSpan) fail('reasoning ended without a matching start');
      next.reasoningSpan = null;
      return next;
    }
    if (type === 'ACTIVITY_SNAPSHOT') {
      const id = text(event.messageId, 'activity message id', 512);
      if (event.activityType !== 'openbot.run.activity' || !record(event.content)) return next;
      const label = text(event.content.label, 'activity label', 2000);
      const progress = event.content.progress;
      if (progress !== undefined && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)) fail('activity progress is invalid');
      const prior = next.activities[id];
      const block = { type:'status', id, text:label, ...(progress === undefined ? {} : { progress }) };
      if (prior === undefined) next.activities[id] = add(block);
      else next.blocks[prior] = block;
      return next;
    }
    if (type === 'CUSTOM') {
      // OpenBot custom events carry public rich parts/artifacts. The current desk has
      // no registered renderer for them, so retain the protocol boundary and ignore.
      text(event.name, 'custom event name', 512);
      return next;
    }
    if (type === 'RUN_FINISHED') {
      sameRun();
      if (Object.keys(next.openMessages).length || Object.values(next.tools).some(tool => tool.open) || next.reasoningSpan || next.reasoningMessage) fail('run finished with an open stream');
      const outcome = event.outcome;
      if (!record(outcome) || (outcome.type !== 'success' && outcome.type !== 'interrupt')) fail('run outcome is invalid');
      if (outcome.type === 'interrupt') {
        if (!Array.isArray(outcome.interrupts) || !outcome.interrupts.length) fail('interrupt outcome is empty');
        next.interrupts = outcome.interrupts.map(item => {
          if (!record(item)) fail('interrupt is invalid');
          const interrupt = {
            id:text(item.id, 'interrupt id', 512),
            reason:text(item.reason, 'interrupt reason', 512),
            message:typeof item.message === 'string' ? item.message.slice(0, 4000) : '',
            responseSchema:record(item.responseSchema) ? item.responseSchema : null,
            toolCallId:typeof item.toolCallId === 'string' ? item.toolCallId : null,
          };
          const tool = interrupt.toolCallId && next.tools[interrupt.toolCallId];
          if (tool) next.blocks[tool.index].status = 'needs permission';
          return interrupt;
        });
        add({ type:'status', id:'interrupt:' + next.runId, text:'Needs permission' });
        next.phase = 'interrupted';
      } else {
        add({ type:'status', id:'finished:' + next.runId, text:'Turn finished' });
        next.phase = 'completed';
      }
      next.outcome = outcome.type;
      return next;
    }
    if (type === 'RUN_ERROR') {
      if (Object.keys(next.openMessages).length || Object.values(next.tools).some(tool => tool.open) || next.reasoningSpan || next.reasoningMessage) fail('run failed with an open stream');
      const message = text(event.message, 'run error', 4000);
      next.phase = event.code === 'cancelled' ? 'cancelled' : 'failed';
      next.error = { code:typeof event.code === 'string' ? event.code : 'run_failed', message };
      add({ type:'status', id:'error:' + next.runId, text:message });
      return next;
    }
    fail('unsupported event type ' + type);
  }

  function parseAgUiSseFrames(buffer, flush=false) {
    if (typeof buffer !== 'string' || buffer.length > 2097152) throw new Error('Invalid AG-UI SSE stream: frame buffer is too large');
    const events = [];
    let rest = buffer;
    while (true) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(rest);
      if (!match) break;
      const frame = rest.slice(0, match.index);
      rest = rest.slice(match.index + match[0].length);
      parseFrame(frame);
    }
    if (flush && rest.trim()) { parseFrame(rest); rest = ''; }
    function parseFrame(frame) {
      const lines = frame.split(/\r\n|\n|\r/);
      const data = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line === 'data') data.push('');
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      const payload = data.join('\n');
      if (!payload || payload === '[DONE]') throw new Error('Invalid AG-UI SSE stream: empty or sentinel event');
      let parsed;
      try { parsed = JSON.parse(payload); }
      catch { throw new Error('Invalid AG-UI SSE stream: event is not JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid AG-UI SSE stream: event is not an object');
      events.push(parsed);
    }
    return { events, rest };
  }

  async function readAgUiSse(response, onEvent) {
    const media = String(response.headers.get('content-type') || '').toLowerCase();
    if (!media.startsWith('text/event-stream') || !response.body) throw new Error('AG-UI response is not an SSE stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream:!chunk.done });
      const parsed = parseAgUiSseFrames(buffer, chunk.done);
      buffer = parsed.rest;
      for (const event of parsed.events) await onEvent(event);
      if (chunk.done) break;
    }
    if (buffer.trim()) throw new Error('Invalid AG-UI SSE stream: unterminated event');
  }

  function h(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
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
        out.push({ name, baseUrl: url.origin });
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
  function addOrgBookmark(name, baseUrl) {
    const url = parseHttpUrl(baseUrl);
    if (!url) return 'Only http and https org URLs are allowed';
    const list = loadOrgBookmarks();
    if (list.some(o => { const u = parseHttpUrl(o.baseUrl); return u && u.origin === url.origin; })) {
      return 'Already bookmarked';
    }
    list.push({ name: String(name || '').trim() || url.hostname, baseUrl: url.origin });
    saveOrgBookmarks(list);
    return '';
  }
  function thisOrgName() {
    return (state.org && (state.org.name || state.org.slug)) || location.host || 'this instance';
  }
  function initials(name) {
    const p = String(name||'?').trim().split(/\s+/).slice(0,2);
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
    let src = String(text || '').replace(/\r\n/g, '\n');
    src = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = fences.length;
      fences.push(escapeHtml(String(code).replace(/\n$/, '')));
      return '\n\n%%FENCE' + i + '%%\n\n';
    });
    src = escapeHtml(src);
    function inline(t) {
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
      t = t.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
        const clean = url.replace(/[.,;:!?)]+$/, '');
        const rest = url.slice(clean.length);
        return '<a href="' + clean + '" rel="noopener noreferrer" target="_blank">' + clean + '</a>' + rest;
      });
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return t;
    }
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^%%FENCE(\d+)%%$/.exec(line.trim());
      if (fence) {
        out.push('<pre class="md-pre"><code>' + (fences[Number(fence[1])] || '') + '</code></pre>');
        i++; continue;
      }
      if (/^\s*---+\s*$/.test(line)) { out.push('<hr />'); i++; continue; }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        const n = heading[1].length;
        out.push('<h' + n + '>' + inline(heading[2]) + '</h' + n + '>');
        i++; continue;
      }
      if (/^&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;/.test(lines[i])) {
          buf.push(lines[i].replace(/^&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + inline(buf.join('<br />')) + '</blockquote>');
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^%%FENCE/.test(lines[i].trim()) && !/^#{1,3}\s+/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^&gt;/.test(lines[i]) && !/^\s*---+\s*$/.test(lines[i])) {
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

  function readStoredTheme() {
    try {
      const t = localStorage.getItem('openbot-theme');
      return (t === 'light' || t === 'dark' || t === 'system') ? t : 'system';
    } catch { return 'system'; }
  }
  function applyTheme(value, persist) {
    const v = (value === 'light' || value === 'dark') ? value : 'system';
    if (persist !== false) {
      try { localStorage.setItem('openbot-theme', v); } catch {}
    }
    if (v === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    const dark = v === 'dark' || (v === 'system' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
    let meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    if (meta && !meta.media) meta.content = dark ? '#12151c' : '#f3efe6';
  }
  function toggleDebug(on) {
    state.debug = Boolean(on);
    try {
      if (state.debug) localStorage.setItem('openbot-debug', '1');
      else localStorage.setItem('openbot-debug', '0');
    } catch {}
    document.documentElement.dataset.debug = state.debug ? '1' : '0';
    const side = document.getElementById('side');
    if (side) {
      if (state.debug) side.removeAttribute('inert');
      else side.setAttribute('inert', '');
    }
    const btn = document.getElementById('debug-mode');
    if (btn) btn.setAttribute('aria-pressed', state.debug ? 'true' : 'false');
  }
  function deskChipText(blocks, harness) {
    const list = blocks || [];
    const last = [...list].reverse().find(b => b.type !== 'status' || b.text === 'Needs permission' || b.text === 'Turn finished');
    if (!last) {
      if (harness === 'in_turn' || harness === 'starting') return 'Working on the desk…';
      return '';
    }
    if (last.type === 'status' && last.text === 'Needs permission') return 'Needs permission';
    if (last.type === 'status' && last.text === 'Turn finished') return '';
    if (last.type === 'thought' || last.type === 'write' || last.type === 'tool') return 'Working on the desk…';
    return '';
  }
  function paintLiveChip() {
    const chip = document.getElementById('live-chip');
    if (!chip) return;
    const harness = state.view === 'human' ? undefined : state.compute && state.compute.harness;
    const text = deskChipText(typeof buildLiveBlocks === 'function' ? buildLiveBlocks(state.live) : [], harness);
    if (!text) {
      chip.hidden = true;
      chip.textContent = '';
      chip.removeAttribute('aria-label');
    } else {
      chip.hidden = false;
      chip.textContent = text;
      chip.setAttribute('aria-label', 'Desk status: ' + text);
    }
  }
  function messagesFingerprint() {
    return state.messages.map(m => m.id + ':' + m.origin + ':' + (m._pending || '') + ':' + (m._failed || '') + ':' + (m._agUi ? (m.body || '') : '')).join('|') + '|' + waitingKind();
  }
  function snapshotFocus() {
    const a = document.activeElement;
    if (!a || !el.contains(a)) return null;
    if (a.id === 'draft') return { area: 'draft' };
    if (a.id === 'debug-mode' || a.id === 'takeover' || a.id === 'send') return { area: 'id', id: a.id };
    const bot = a.closest('button.bot[data-id]');
    if (bot) return { area: 'rail', botId: bot.getAttribute('data-id') };
    const g = a.closest('button.bot[data-group]');
    if (g) return { area: 'rail-group', groupId: g.getAttribute('data-group') };
    const lib = a.closest('#open-activity, #open-archive, #open-calendar, #open-a2a-status, #newbot, #new-group');
    if (lib) return { area: 'id', id: lib.id };
    const msgBtn = a.closest('#msgs button');
    if (msgBtn) {
      const li = msgBtn.closest('li.msg');
      return { area: 'msgs-action', msgId: li && li.getAttribute('data-msg-id'), action: msgBtn.getAttribute('data-action') };
    }
    return a.id ? { area: 'id', id: a.id } : null;
  }
  function restoreFocus(snap) {
    function focusId(id) {
      const n = id && document.getElementById(id);
      if (n && n.focus) n.focus();
      return Boolean(n);
    }
    if (!snap) {
      if (document.querySelector('.overlay')) return;
      if (!focusId('draft')) {
        const h1 = document.querySelector('header.app-header h1');
        if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus(); }
      }
      return;
    }
    if (snap.area === 'draft') { focusId('draft'); return; }
    if (snap.area === 'rail' && snap.botId) {
      const row = document.querySelector('button.bot[data-id="' + snap.botId + '"]') || document.getElementById('bot-' + snap.botId);
      if (row && row.focus) row.focus();
      return;
    }
    if (snap.area === 'rail-group' && snap.groupId) {
      const row = document.querySelector('button.bot[data-group="' + snap.groupId + '"]');
      if (row && row.focus) row.focus();
      return;
    }
    if (snap.area === 'msgs-action' && snap.msgId && snap.action) {
      const btn = document.querySelector('#msgs li[data-msg-id="' + snap.msgId + '"] button[data-action="' + snap.action + '"]');
      if (btn && btn.focus) btn.focus();
      return;
    }
    if (snap.area === 'id' && snap.id) focusId(snap.id);
  }
  function retargetSkip() {
    const skip = document.querySelector('a.skip');
    if (!skip) return;
    const draft = document.getElementById('draft');
    const thread = document.querySelector('main.thread');
    if (draft) skip.setAttribute('href', '#draft');
    else if (thread) {
      if (!thread.id) thread.id = 'thread';
      skip.setAttribute('href', '#' + thread.id);
    } else skip.setAttribute('href', '#app');
  }
  try {
    const storedTheme = localStorage.getItem('openbot-theme');
    applyTheme(storedTheme, storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system');
  } catch {}
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === '.' || e.code === 'Period')) {
      e.preventDefault();
      toggleDebug(!state.debug);
    }
  });

  async function boot() {
    try { state.auth = await api('/v1/auth-options'); } catch { state.auth = {}; }
    try { state.me = await api('/v1/me'); }
    catch { return renderSignIn(); }
    try { state.harness = await api('/v1/harness-auth'); } catch { state.harness = {}; }
    try { state.models = (await api('/v1/inference-models')).models || []; } catch { state.models = []; }
    try {
      const bots = await api('/v1/bots');
      state.bots = bots.bots || (bots.bot ? [bots.bot] : []);
      state.a2aGateway = bots.a2aGateway || null;
      state.archived = bots.archived || [];
      if (bots.archiveTtlMs) state.archiveTtlMs = bots.archiveTtlMs;
      const last = localStorage.getItem('openbot-last-bot');
      state.bot = state.bots.find(b => b.id === last)
        || state.bots[0]
        || null;
    } catch {}
    // Onboard until a desk teammate exists; protocol infrastructure does not skip it.
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
    el.append(h(`<main class="card">
      <h1>OpenBot</h1>
      <p>Named teammates on this machine. Closing this tab does not stop them. Stopping <code>openbot server</code> does.</p>
      <p class="muted">Allowlist-only. Shared desk is not a security boundary. One Chromium for the whole team.</p>
      ${local}${gh}
    </main>`));
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
    const card = h(`<main class="card">
      <h1>Create your teammate</h1>
      <label for="name">Name</label>
      <input id="name" name="name" autocomplete="nickname" value="Ada" />
      <label for="desc">Description</label>
      <textarea id="desc" name="description">You are a helpful teammate. Finish jobs on this computer.</textarea>
      <p class="muted">${harnessBlurb()}</p>
      ${inferenceFields('on-model', 'on-effort')}
      <label for="key">API key (optional)</label>
      <input id="key" name="key" type="password" autocomplete="off" placeholder="xai-… only if you are not using grok login" />
      <p class="muted">Shared desk. One Chromium. Bots talk with SendToAgent. They hire with CreateBot — not by signing in as you.</p>
      <button class="primary" id="go" type="button">Create bot</button>
      <p class="err" id="err" role="alert"></p>
    </main>`);
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

  function visibleMessages(list) {
    return (list || []).filter(m => m.origin !== 'prompt' && m.origin !== 'calendar');
  }
  function principalById(botId) {
    return state.bots.find(b => b.id === botId) || null;
  }

  function newAgUiId(kind) {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
      throw new Error('This browser cannot create secure AG-UI identifiers');
    }
    return 'desk-' + kind + '-' + globalThis.crypto.randomUUID();
  }

  function agUiContextKey(botId, legacyThreadId) {
    return 'openbot-ag-ui-v1:' + encodeURIComponent(botId) + ':' + encodeURIComponent(legacyThreadId);
  }

  function saveAgUiContext(context) {
    if (!context || !context.storageKey) return;
    try {
      localStorage.setItem(context.storageKey, JSON.stringify({
        version:2,
        threadId:context.threadId,
        taskId:context.taskId || null,
        started:Boolean(context.started),
        active:Boolean(context.active),
        interrupted:Boolean(context.interrupted),
        lastRunId:context.lastRunId || null,
        lastSeq:Number.isSafeInteger(context.lastSeq) ? context.lastSeq : 0,
      }));
    } catch {}
  }

  function loadAgUiContext(botId, legacyThreadId) {
    const storageKey = agUiContextKey(botId, legacyThreadId);
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (value && value.version === 2 && typeof value.threadId === 'string' && value.threadId && value.threadId.length <= 512 && (value.taskId === null || value.taskId === undefined || (typeof value.taskId === 'string' && value.taskId && value.taskId.length <= 512))) {
        return {
          storageKey, botId, legacyThreadId,
          threadId:value.threadId,
          taskId:value.taskId || null,
          started:Boolean(value.started),
          active:Boolean(value.active),
          interrupted:Boolean(value.interrupted),
          lastRunId:typeof value.lastRunId === 'string' && value.lastRunId ? value.lastRunId : null,
          lastSeq:Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0 ? value.lastSeq : 0,
        };
      }
    } catch {}
    const context = {
      storageKey, botId, legacyThreadId,
      threadId:newAgUiId('thread'), taskId:null,
      started:false, active:false, interrupted:false, lastRunId:null, lastSeq:0,
    };
    saveAgUiContext(context);
    return context;
  }

  function adoptAgUiConversation(context, conversation) {
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
    if (conversation === null) {
      if (context.lastRunId || context.started || context.active || context.interrupted) {
        context.threadId = newAgUiId('thread');
        context.taskId = null;
        context.started = false;
        context.active = false;
        context.interrupted = false;
        context.lastRunId = null;
        context.lastSeq = 0;
      }
      saveAgUiContext(context);
      return [];
    }
    if (!conversation || typeof conversation !== 'object' || !validId(conversation.threadId) || !Array.isArray(conversation.messages)) {
      throw new Error('Invalid canonical conversation response');
    }
    context.threadId = conversation.threadId;
    const active = conversation.active;
    if (active === null || active === undefined) {
      context.taskId = null;
      context.started = false;
      context.active = false;
      context.interrupted = false;
      context.lastRunId = null;
      context.lastSeq = 0;
    } else {
      if (!active || typeof active !== 'object' || !validId(active.taskId) || !validId(active.runId) || !['submitted', 'working', 'input_required', 'auth_required'].includes(active.status)) {
        throw new Error('Invalid canonical active-run response');
      }
      context.taskId = active.taskId;
      context.started = true;
      context.active = active.status === 'submitted' || active.status === 'working';
      context.interrupted = active.status === 'input_required' || active.status === 'auth_required';
      context.lastRunId = active.runId;
      context.lastSeq = Number.isSafeInteger(active.lastSeq) && active.lastSeq >= 0 ? active.lastSeq : 0;
    }
    const messages = [];
    for (const message of conversation.messages) {
      if (!message || typeof message !== 'object' || !validId(message.id) || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.body !== 'string' || message.body.length > 1048576 || !Number.isFinite(message.createdAt)) {
        throw new Error('Invalid canonical conversation message');
      }
      messages.push({
        id:message.id,
        role:message.role === 'user' ? 'user' : 'assistant',
        origin:message.role === 'user' ? 'user' : 'ag-ui',
        body:message.body,
        created_at:message.createdAt,
        _agUi:true,
      });
    }
    const pending = conversation.pendingNotifications === undefined ? [] : conversation.pendingNotifications;
    if (!Array.isArray(pending)) throw new Error('Invalid pending notification response');
    for (const message of pending) {
      if (!message || typeof message !== 'object' || !validId(message.id) || typeof message.body !== 'string' || message.body.length > 1048576 || !Number.isFinite(message.createdAt)) {
        throw new Error('Invalid pending notification');
      }
      if (!messages.some(candidate => candidate.id === message.id)) messages.push({
        id:message.id,
        role:'assistant',
        origin:'pending_approval',
        body:message.body,
        created_at:message.createdAt,
      });
    }
    saveAgUiContext(context);
    return messages;
  }

  async function fetchAgUiConversation(botId) {
    const result = await api('/v1/agents/' + encodeURIComponent(botId) + '/conversation');
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'conversation')) throw new Error('Invalid canonical conversation response');
    return result.conversation;
  }

  function rememberAgUiMessages() {
    if (state.view !== 'human' || !state.agUiContext) return;
    state.agUiMessages[state.agUiContext.storageKey] = state.messages
      .filter(message => message._agUi)
      .map(message => ({ ...message }));
  }

  function mergeAgUiMessages(messages, context, onlyUncommitted=false) {
    const merged = [...messages];
    const cached = state.agUiMessages[context.storageKey] || [];
    for (const message of cached) {
      if (onlyUncommitted && !message._pending && !message._failed) continue;
      if (!merged.some(candidate => candidate.id === message.id)) merged.push({ ...message });
    }
    return merged.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
  }

  function detachAgUiStream() {
    const controller = state.agUiAbort;
    state.agUiAbort = null;
    if (controller) controller.abort();
    state.sending = false;
  }

  async function selectBot(botId, threadId) {
    saveDraft();
    rememberAgUiMessages();
    detachAgUiStream();
    const principal = principalById(botId);
    if (!principal) return;
    state.bot = principal;
    try { localStorage.setItem('openbot-last-bot', state.bot.id); } catch {}
    state.view = threadId ? 'a2a' : 'human';
    const t = threadId
      ? await api('/v1/threads/' + threadId)
      : await api('/v1/threads?botId=' + encodeURIComponent(botId));
    state.thread = t.thread;
    if (state.view === 'human') {
      state.agUiContext = loadAgUiContext(botId, state.thread.id);
      state.agUiRun = null;
      state.live = [];
      try {
        const conversation = await fetchAgUiConversation(botId);
        state.messages = mergeAgUiMessages(adoptAgUiConversation(state.agUiContext, conversation), state.agUiContext, true);
      } catch {
        // Local memory/storage is only a continuity cache when canonical bootstrap is unavailable.
        state.messages = mergeAgUiMessages([], state.agUiContext);
      }
    } else {
      state.agUiContext = null;
      state.agUiRun = null;
      state.live = [];
      state.messages = visibleMessages(t.messages);
    }
    try {
      const a2a = await api('/v1/threads?kind=a2a&botId=' + encodeURIComponent(botId));
      state.a2a = a2a.threads || [];
    } catch { state.a2a = []; }
    stickBottom = true;
    renderApp();
    const latestTurnId = t.latestTurnId || [...(state.messages || [])].reverse().find(m => m.turn_id)?.turn_id;
    state.turn = latestTurnId;
    loadDraft();
    if (state.view === 'human' && (state.agUiContext.active || state.agUiContext.interrupted) && state.agUiContext.lastRunId) {
      void replayAgUiRun(state.agUiContext);
    }
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
    rememberAgUiMessages();
    detachAgUiStream();
    state.view = 'group';
    state.agUiContext = null;
    state.agUiRun = null;
    state.live = [];
    const t = await api('/v1/threads/' + threadId);
    state.thread = t.thread;
    state.messages = visibleMessages(t.messages);
    stickBottom = true;
    renderApp();
    const latestTurnId = t.latestTurnId || [...(state.messages || [])].reverse().find(m => m.turn_id)?.turn_id;
    state.turn = latestTurnId;
    loadDraft();
  }

  function openA2aStatus() {
    saveDraft();
    rememberAgUiMessages();
    detachAgUiStream();
    state.view = 'a2a-status';
    state.thread = null;
    state.messages = [];
    state.live = [];
    state.a2a = [];
    renderApp();
  }

  function openNewGroup() {
    const botChecks = state.bots.map(b =>
      '<label><input type="checkbox" data-bot="' + b.id + '" /> ' + escapeHtml(b.name) + '</label>'
    ).join('');
    const overlay = h(`<div class="overlay"><div class="modal">
      <h2 id="grp-title">New group</h2>
      <label for="grp-name">Title</label>
      <input id="grp-name" name="title" value="New thread" />
      <p class="muted">Pick at least two teammates. You are included.</p>
      <div id="grp-bots" style="display:flex;flex-direction:column;gap:6px">${botChecks}</div>
      <p class="err" id="grp-err" hidden></p>
      <div class="modal-actions">
        <button class="primary" type="button" id="grp-go">Create</button>
        <button type="button" id="grp-no">Cancel</button>
      </div>
    </div></div>`);
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
        || state.bot;
      bot.model = res.model;
      bot.reasoning_effort = res.reasoningEffort;
      state.bot = bot;
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
    const inCalendar = state.view === 'calendar';
    const inGroup = state.view === 'group';
    const inA2aStatus = state.view === 'a2a-status';
    const heading = inArchive ? 'Archive' : inActivity ? 'Activity' : inCalendar ? 'Calendar' : inA2aStatus ? 'A2A connection' : inGroup ? (state.thread?.title || 'Group') : (state.bot?.name || 'OpenBot');
    document.title = heading + ' · OpenBot';
    const railBots = state.bots.map(b => {
      const active = state.bot && b.id === state.bot.id && state.view === 'human';
      const pres = presenceOf(b);
      const collapsedLabel = state.railCollapsed ? ' aria-label="' + escapeHtml(b.name + ', ' + pres.label) + '"' : '';
      return '<button type="button" class="bot' + (active ? ' active' : '') + '" id="bot-' + b.id + '" data-id="' + b.id + '" aria-current="' + (active ? 'page' : 'false') + '"' + collapsedLabel + '>' +
        '<span class="st ' + escapeHtml(pres.key) + '" title="' + escapeHtml(pres.label) + '"></span>' +
        '<span class="avatar" aria-hidden="true">' + escapeHtml(initials(b.name)) + '</span>' +
        '<span class="bot-meta"><strong>' + escapeHtml(b.name) + '</strong><span class="muted presence">' + escapeHtml(pres.label) + '</span></span></button>';
    }).join('');
    const a2aPin = state.a2aGateway
      ? '<button type="button" class="bot folder' + (inA2aStatus ? ' active' : '') + '" id="open-a2a-status" aria-current="' + (inA2aStatus ? 'page' : 'false') + '">' +
        '<span class="avatar" aria-hidden="true">↔</span>' +
        '<span class="bot-meta"><strong>A2A connection</strong><span class="muted presence">Protocol status</span></span></button>'
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
    const composer = inArchive || inActivity || inCalendar || inA2aStatus
      ? ''
      : readonly
      ? '<p class="muted" id="draft-help">This handoff log is read-only. Message the bot from their human thread.</p>'
      : inGroup
      ? `
        <div class="composer">
          <label class="sr-only" for="draft">Message group</label>
          <textarea id="draft" name="draft" rows="2" maxlength="32000" aria-describedby="draft-help" placeholder="Message the group… @name to mention"></textarea>
          <button class="primary" id="send" type="button" disabled>Send</button>
        </div>
        <div class="hint" id="draft-help"><span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · @mention up to 3 teammates</span><span id="count"></span></div>`
      : `${inferenceFields('pick-model', 'pick-effort')}
        <div class="composer">
          <label class="sr-only" for="draft">Message ${escapeHtml(state.bot?.name || '')}</label>
          <textarea id="draft" name="draft" rows="2" maxlength="32000" aria-describedby="draft-help" placeholder="Message ${escapeHtml(state.bot?.name || '')}…"></textarea>
          <button class="primary" id="send" type="button" disabled>Send</button>
        </div>
        <div class="hint" id="draft-help"><span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline<span class="hint-debug"> · model and reasoning apply on the next turn</span></span><span id="count"></span></div>`;
    const mainInner = inArchive
      ? '<ul class="archive-list" id="archive-folder"></ul>'
      : inActivity
      ? '<ul class="act-list" id="activity-board"></ul>'
      : inCalendar
      ? '<div class="cal-board" id="calendar-board"><div class="cal-toolbar"><div class="cal-tools"><div class="seg" role="group" aria-label="Calendar view"><button type="button" id="cal-agenda" aria-pressed="' + (state.calMode !== 'month' ? 'true' : 'false') + '">Agenda</button><button type="button" id="cal-month" aria-pressed="' + (state.calMode === 'month' ? 'true' : 'false') + '">Month</button></div></div><button type="button" class="primary" id="cal-new">New event</button></div><p class="muted" style="padding:8px 16px 0">The calendar runs only while <code>openbot server</code> runs. A closed laptop means the 9am did not happen.</p><div class="cal-body" id="cal-body"></div></div>'
      : inA2aStatus
      ? '<section class="card" aria-labelledby="a2a-status-title"><h2 id="a2a-status-title">Agent-to-agent connection</h2><p>This is the protocol edge for authenticated external agent requests. It is infrastructure, not a teammate or chat recipient.</p><dl><dt>Status</dt><dd>' + (state.a2aGateway?.available ? 'Available' : 'Unavailable') + '</dd><dt>Agent Card</dt><dd><a href="/.well-known/agent-card.json"><code>/.well-known/agent-card.json</code></a></dd><dt>JSON-RPC endpoint</dt><dd><code>/a2a/v1</code></dd></dl><p class="muted">Desk bots are the only entries in Team, groups, AG-UI chat, and OpenAI-compatible models.</p></section>'
      : '<ol class="msgs" id="msgs" tabindex="0"></ol><div class="composer-wrap">' + composer + '</div><p class="muted" style="padding:0 16px 12px">Closing this tab does not stop teammates. Stopping <code>openbot server</code> does.</p>';

    const orgName = thisOrgName();
    saveDraft();
    const snap = snapshotFocus();
    el.innerHTML = '';
    el.append(h(`<header class="app-header">
      <div class="header-title">
        <h1>${escapeHtml(heading)}</h1>
        <span id="live-chip" hidden></span>
      </div>
      <div class="header-actions">
        ${statusPill()}
        <span class="pill" id="this-org" title="This instance">${escapeHtml(orgName)}</span>
        <button type="button" id="debug-mode" aria-label="Debug mode" aria-pressed="${state.debug ? 'true' : 'false'}" aria-keyshortcuts="Control+Shift+Period Meta+Shift+Period">Debug</button>
        <button type="button" class="ghost" id="takeover">Desk browser</button>
        <button type="button" id="open-orgs" aria-haspopup="dialog">Orgs</button>
        <button type="button" class="side-toggle" id="live-toggle" aria-expanded="false">Live work</button>
        ${!inArchive && !inActivity && !inCalendar && !inA2aStatus && !inGroup && state.bot ? '<button type="button" id="archive-bot">Archive</button>' : ''}
        ${(state.view === 'human' || inGroup) && state.thread ? '<button type="button" id="learn-this">Learn this</button>' : ''}
        <button type="button" id="help" aria-haspopup="dialog">Help</button>
        <button type="button" id="settings">Settings</button>
      </div>
    </header>`));
    const layout = h(`<div class="shell${state.railCollapsed ? ' no-rail' : ''}${state.sideCollapsed ? ' no-side' : ''}" id="shell">
      <nav class="rail" aria-label="Team">
        <div class="pane-head">
          <h2>Team</h2>
          <button type="button" class="ghost collapse-desk" id="collapse-rail" aria-expanded="${!state.railCollapsed}" aria-label="${state.railCollapsed ? 'Show team' : 'Hide team'}">${state.railCollapsed ? '›' : '‹'}</button>
        </div>
        ${railBots}
        <button type="button" id="newbot">New bot</button>
        <h2>Library</h2>
        <button type="button" class="bot folder${inActivity ? ' active' : ''}" id="open-activity" aria-current="${inActivity ? 'page' : 'false'}">
          <span class="avatar" aria-hidden="true">◉</span>
          <span class="bot-meta"><strong>Activity</strong><span class="muted">All teammates</span></span>
        </button>
        <button type="button" class="bot folder${inArchive ? ' active' : ''}" id="open-archive" aria-current="${inArchive ? 'page' : 'false'}">
          <span class="avatar" aria-hidden="true">📦</span>
          <span class="bot-meta"><strong>Archive</strong><span class="muted"> ${state.archived.length} teammate${state.archived.length === 1 ? '' : 's'}</span></span>
        </button>
        <button type="button" class="bot folder${inCalendar ? ' active' : ''}" id="open-calendar" aria-current="${inCalendar ? 'page' : 'false'}">
          <span class="avatar" aria-hidden="true">📅</span>
          <span class="bot-meta"><strong>Calendar</strong><span class="muted">Schedules</span></span>
        </button>
        ${a2aPin}
        <h2>Groups</h2>
        ${railGroups}
        <button type="button" id="new-group">New group</button>
        <p class="muted desk-note">Shared desk · one Chromium, a tab per bot · SendToAgent is how bots talk.</p>
      </nav>
      <main class="thread" id="thread" aria-label="${inArchive ? 'Archive' : inActivity ? 'Activity' : inCalendar ? 'Calendar' : inA2aStatus ? 'A2A connection status' : inGroup ? 'Group' : 'Conversation'}">
        ${mainInner}
      </main>
      <div class="resize-side" id="resize-side" role="separator" aria-orientation="vertical" aria-label="Resize live work" tabindex="0"></div>
      <aside class="side" id="side" aria-label="Live work">
        <div class="pane-head">
          <h2>Live work</h2>
          <button type="button" class="ghost collapse-desk" id="collapse-side" aria-expanded="${!state.sideCollapsed}" aria-label="${state.sideCollapsed ? 'Show live work' : 'Hide live work'}">${state.sideCollapsed ? '‹' : '›'}</button>
        </div>
        <div class="side-body">
          <p class="muted" id="live-summary">Quiet</p>
          <p class="muted">Canonical AG-UI activity</p>
          <div id="live" class="live" aria-live="off"></div>
          <h2>Handoffs</h2>
          <div id="handoffs">${handoffs}</div>
          <h2>Host</h2>
          <div class="muted" id="host"></div>
        </div>
      </aside>
    </div>`);
    el.append(layout);
    const shellEl = document.getElementById('shell');
    if (shellEl) shellEl.style.setProperty('--side-w', Math.max(240, state.sideW || 320) + 'px');
    if (inArchive) paintArchiveFolder();
    else if (inActivity) void paintActivity();
    else if (inCalendar) void paintCalendar();
    else paintMessages();
    paintLive();
    bindResize();
    const bind = (sel, fn) => { const n = el.querySelector(sel); if (n) n.onclick = fn; };
    bind('#send', sendMsg);
    bindInferenceSelects(el, '#pick-model', '#pick-effort');
    bind('#settings', openSettings);
    bind('#debug-mode', () => toggleDebug(!state.debug));
    bind('#takeover', startTakeover);
    bind('#newbot', renderOnboard);
    bind('#new-group', openNewGroup);
    bind('#help', openHelp);
    bind('#open-orgs', openOrgs);
    bind('#open-archive', openArchiveFolder);
    bind('#open-activity', openActivity);
    bind('#open-calendar', openCalendar);
    bind('#open-a2a-status', openA2aStatus);
    bind('#cal-agenda', () => setCalMode('agenda'));
    bind('#cal-month', () => setCalMode('month'));
    bind('#cal-new', openNewEvent);
    bind('#learn-this', learnThis);
    bind('#archive-bot', archiveCurrentBot);
    bind('#collapse-rail', () => togglePane('rail'));
    bind('#collapse-side', () => togglePane('side'));
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
    const side = document.getElementById('side');
    if (side) {
      if (state.debug) side.removeAttribute('inert');
      else side.setAttribute('inert', '');
    }
    document.documentElement.dataset.debug = state.debug ? '1' : '0';
    loadDraft();
    retargetSkip();
    paintLiveChip();
    restoreFocus(snap);
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
    send.disabled = !draft.value.trim() || state.sending || (state.view === 'human' && ((state.agUiRun && state.agUiRun.phase === 'interrupted') || (state.agUiContext && state.agUiContext.interrupted)));
    if (count) count.textContent = n > 28000 ? (32000 - n) + ' left' : '';
  }

  function onMsgScroll() {
    const box = document.getElementById('msgs');
    if (!box) return;
    stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const jump = document.getElementById('jump');
    if (jump) jump.hidden = stickBottom;
  }

  function waitingKind() {
    if (state.view === 'human') {
      if (state.sending && (!state.agUiRun || state.agUiRun.phase === 'idle')) return 'starting';
      if (state.agUiRun && state.agUiRun.phase === 'active') return 'working';
      return '';
    }
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
    if (m.from_bot_id) return botName(m.from_bot_id);
    // Group fallback has no from_bot_id; do not pin it to the last selected DM.
    if (m.origin === 'fallback' && state.view === 'group') return 'Teammate';
    return state.bot?.name || 'Teammate';
  }

  function paintMessages() {
    const box = document.getElementById('msgs');
    if (!box) return;
    const fp = messagesFingerprint();
    if (box.getAttribute('data-fp') === fp) return;
    const prevStick = stickBottom;
    const msgSnap = snapshotFocus();
    box.innerHTML = '';
    box.setAttribute('data-fp', fp);
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
      if (m.id) li.setAttribute('data-msg-id', m.id);
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
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = renderBody(m.body || '');
      li.append(body);
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'linkish';
      copy.setAttribute('data-action', 'copy');
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
        retry.setAttribute('data-action', 'retry');
        retry.textContent = 'Retry';
        retry.onclick = () => retryMsg(m);
        actions.append(retry);
      }
      if (m.origin === 'pending_approval') {
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.setAttribute('data-action', 'approve');
        ok.textContent = 'Approve';
        ok.onclick = async () => { await api('/v1/messages/' + m.id + '/approve', { method:'POST', body:'{}' }); };
        const no = document.createElement('button');
        no.type = 'button';
        no.setAttribute('data-action', 'reject');
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
      const labels = { starting:'Starting teammate…', working:'Teammate is working…', crashed:'Harness crashed. Send again or open Settings.', waiting:'Waiting for teammate…' };
      li.textContent = labels[wait] || 'Waiting…';
      const canCancel = state.view === 'human'
        ? Boolean(state.agUiRun && state.agUiRun.phase === 'active')
        : Boolean(state.turn);
      if (canCancel && wait !== 'crashed') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'linkish';
        cancel.textContent = 'Cancel turn';
        cancel.onclick = async () => {
          try {
            if (state.view === 'human') await cancelAgUiRun();
            else await api('/v1/turns/' + state.turn + '/cancel', { method:'POST', body:'{}' });
          } catch {}
        };
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
    if (msgSnap && msgSnap.area === 'msgs-action') restoreFocus(msgSnap);
  }

  function currentAgUiOwner(context) {
    return Boolean(
      context && state.view === 'human' && state.bot && state.thread && state.agUiContext &&
      state.bot.id === context.botId && state.thread.id === context.legacyThreadId &&
      state.agUiContext.storageKey === context.storageKey
    );
  }

  function syncAgUiView(context, run) {
    if (!currentAgUiOwner(context)) return;
    state.agUiRun = run;
    state.live = run.blocks;
    for (const block of run.blocks) {
      if (block.type !== 'write') continue;
      let message = state.messages.find(candidate => candidate._agUi && candidate.id === block.id);
      if (!message) {
        message = { id:block.id, role:'assistant', origin:'ag-ui', body:'', created_at:Date.now(), _agUi:true };
        state.messages.push(message);
      }
      message.body = block.text || '';
    }
    rememberAgUiMessages();
    paintMessages();
    paintLive();
    syncSend();
  }

  function agUiRequestInput(context, runId, parentRunId, message, resume, taskId) {
    const input = {
      threadId:context.threadId,
      runId,
      state:{},
      messages:message ? [{ id:message.id, role:'user', content:message.body }] : [],
      tools:[],
      context:[],
    };
    if (parentRunId) input.parentRunId = parentRunId;
    if (taskId) input.forwardedProps = { openbot:{ taskId } };
    if (resume && resume.length) input.resume = resume;
    return input;
  }

  function applyAgUiContextEvent(context, run, event) {
    if (event.type === 'RUN_STARTED') {
      context.started = true;
      context.interrupted = false;
    }
    context.lastSeq = run.lastSeq;
    if (run.phase === 'completed' || run.phase === 'failed' || run.phase === 'cancelled') {
      context.active = false;
      context.started = false;
      context.interrupted = false;
      context.taskId = null;
    } else if (run.phase === 'interrupted') {
      context.active = false;
      context.interrupted = true;
    }
    return context;
  }

  async function agUiHttpError(response) {
    const body = (await response.text()).slice(0, 8000);
    try {
      const parsed = JSON.parse(body);
      return new Error(parsed && parsed.error && (parsed.error.message || parsed.error.code) || parsed.message || response.statusText || 'AG-UI request failed');
    } catch {
      return new Error(body || response.statusText || 'AG-UI request failed');
    }
  }

  function agUiClientFailure(run, error) {
    const failed = {
      ...run,
      phase:'failed',
      error:{ code:'client_stream_error', message:String(error && error.message || error) },
      blocks:run.blocks.map(block => ({ ...block })),
    };
    failed.blocks.push({ type:'status', id:'client-error:' + run.runId, text:failed.error.message });
    return failed;
  }

  async function consumeAgUiResponse(response, context, initialRun) {
    if (!response.ok) throw await agUiHttpError(response);
    let run = initialRun;
    await readAgUiSse(response, event => {
      run = reduceAgUiEvent(run, event);
      applyAgUiContextEvent(context, run, event);
      saveAgUiContext(context);
      syncAgUiView(context, run);
    });
    if (run.phase === 'idle' || run.phase === 'active') throw new Error('AG-UI stream ended without a terminal event');
    return run;
  }

  async function postAgUiRun(context, input, run) {
    const controller = new AbortController();
    if (currentAgUiOwner(context)) state.agUiAbort = controller;
    try {
      const response = await fetch('/ag-ui/v1/run', {
        method:'POST',
        credentials:'same-origin',
        signal:controller.signal,
        headers:{
          'content-type':'application/json',
          'accept':'text/event-stream',
          'X-OpenBot-Agent-ID':context.botId,
        },
        body:JSON.stringify(input),
      });
      return await consumeAgUiResponse(response, context, run);
    } finally {
      if (state.agUiAbort === controller) state.agUiAbort = null;
    }
  }

  async function replayAgUiRun(context) {
    if (!context || !context.lastRunId || !currentAgUiOwner(context)) return;
    state.sending = true;
    let run = newAgUiRunState(context.threadId, context.lastRunId);
    syncAgUiView(context, run);
    const controller = new AbortController();
    state.agUiAbort = controller;
    try {
      const response = await fetch('/ag-ui/v1/runs/' + encodeURIComponent(context.lastRunId) + '/events?after=0', {
        credentials:'same-origin',
        signal:controller.signal,
        headers:{ 'accept':'text/event-stream', 'X-OpenBot-Agent-ID':context.botId },
      });
      run = await consumeAgUiResponse(response, context, run);
      if (currentAgUiOwner(context) && run.phase === 'interrupted') showAgUiInterrupt(context, run);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      context.active = false;
      saveAgUiContext(context);
      run = agUiClientFailure(run, error);
      syncAgUiView(context, run);
      announce('Could not reconnect to the AG-UI run');
    } finally {
      if (state.agUiAbort === controller) state.agUiAbort = null;
      if (currentAgUiOwner(context)) {
        state.sending = false;
        paintMessages();
        syncSend();
      }
    }
  }

  async function cancelAgUiRun() {
    const context = state.agUiContext;
    const run = state.agUiRun;
    if (!context || !run || (run.phase !== 'idle' && run.phase !== 'active')) return;
    const response = await fetch('/ag-ui/v1/runs/' + encodeURIComponent(run.runId), {
      method:'DELETE',
      credentials:'same-origin',
      headers:{ 'accept':'application/json', 'X-OpenBot-Agent-ID':context.botId },
    });
    if (!response.ok) throw await agUiHttpError(response);
    announce('Cancellation requested');
  }

  async function sendMsg() {
    const draft = document.getElementById('draft');
    if (!draft || !state.thread || state.view === 'a2a') return;
    const body = draft.value.trim();
    if (!body || state.sending) return;
    const isHuman = state.view === 'human';
    if (isHuman && (!state.agUiContext || state.agUiContext.active || state.agUiContext.interrupted || (state.agUiRun && state.agUiRun.phase === 'interrupted'))) return;
    state.sending = true;
    syncSend();
    const retry = isHuman ? state.agUiRetry : null;
    state.agUiRetry = null;
    const context = state.agUiContext;
    const parentRunId = null;
    const runId = isHuman ? (retry && retry.runId || newAgUiId('run')) : null;
    const messageId = isHuman ? (retry && retry.messageId || newAgUiId('message')) : 'tmp-' + Date.now();
    const tmp = { id:messageId, role:'user', origin:'user', body, created_at:Date.now(), _pending:true, ...(isHuman ? { _agUi:true, _runId:runId, _parentRunId:parentRunId } : {}) };
    state.messages.push(tmp);
    draft.value = '';
    try { sessionStorage.removeItem(draftKey()); } catch {}
    stickBottom = true;
    paintMessages();
    announce('Sending message');
    try {
      if (isHuman) {
        context.taskId = runId;
        context.started = false;
        context.interrupted = false;
        context.lastRunId = runId;
        context.active = true;
        saveAgUiContext(context);
        let run = newAgUiRunState(context.threadId, runId);
        syncAgUiView(context, run);
        // A normal message is a fresh task/run on the existing AG-UI thread.
        // The private task extension is reserved for an interrupted task resume.
        const input = agUiRequestInput(context, runId, null, { id:messageId, body }, null, null);
        run = await postAgUiRun(context, input, run);
        const live = state.messages.find(candidate => candidate.id === messageId) || tmp;
        live._pending = false;
        rememberAgUiMessages();
        if (run.phase === 'interrupted' && currentAgUiOwner(context)) showAgUiInterrupt(context, run);
        paintMessages();
        announce(run.phase === 'completed' ? 'Message sent' : run.phase === 'interrupted' ? 'Permission needed' : 'Run ended');
        return;
      }
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
      if (e && e.name === 'AbortError') return;
      const live = state.messages.find(x => x.id === tmp.id || x === tmp) || tmp;
      live._pending = false;
      live._failed = true;
      live.error = e.message;
      if (isHuman) {
        context.active = false;
        saveAgUiContext(context);
        const current = state.agUiRun || newAgUiRunState(context.threadId, runId);
        syncAgUiView(context, agUiClientFailure(current, e));
        rememberAgUiMessages();
      }
      paintMessages();
      announce('Send failed');
    } finally {
      if (!isHuman || currentAgUiOwner(context)) {
        state.sending = false;
        syncSend();
        draft.focus();
      }
    }
  }

  async function retryMsg(m) {
    if (state.view === 'human' && m._agUi) state.agUiRetry = { messageId:m.id, runId:m._runId };
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
    rememberAgUiMessages();
    detachAgUiStream();
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

  function orgTimezone() {
    return (state.org && state.org.timezone) || (state.calendar && state.calendar.timezone) || 'UTC';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ianaZones() {
    try {
      const z = Intl.supportedValuesOf?.('timeZone');
      if (z && z.length) return z;
    } catch {}
    return null;
  }
  function tzParts(ms, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', weekday:'short', hourCycle:'h23'
      }).formatToParts(new Date(Number(ms)));
      const get = (t) => { const p = parts.find(x => x.type === t); return p ? p.value : ''; };
      let hour = Number(get('hour'));
      if (hour === 24) hour = 0;
      return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour, minute: Number(get('minute')), weekday: get('weekday') };
    } catch {
      if (tz !== 'UTC') return tzParts(ms, 'UTC');
      const d = new Date(Number(ms));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: '' };
    }
  }
  function ymdKey(ms, tz) {
    const p = tzParts(ms, tz);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }
  function zoneShort(ms, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(Number(ms) || Date.now()));
      const p = parts.find(x => x.type === 'timeZoneName');
      if (p && p.value) return p.value;
    } catch {}
    return tz;
  }
  function fmtClockTz(ms, tz) {
    const p = tzParts(ms, tz);
    return pad2(p.hour) + ':' + pad2(p.minute) + ' ' + zoneShort(ms, tz);
  }
  function fmtWhenTz(ms, tz) {
    if (!ms) return '';
    const p = tzParts(ms, tz);
    return p.weekday + ' ' + p.month + '/' + p.day + ' ' + pad2(p.hour) + ':' + pad2(p.minute) + ' ' + tz;
  }
  function toLocalInput(ms, tz) {
    const p = tzParts(ms, tz);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T' + pad2(p.hour) + ':' + pad2(p.minute);
  }
  function rruleInterval(rrule) {
    const m = /(?:^|;)INTERVAL=([0-9]+)/i.exec(String(rrule || ''));
    return m ? Math.max(1, Number(m[1])) : 1;
  }
  function rruleProse(rrule, minMs) {
    if (!rrule) return 'Once';
    const u = String(rrule).replace(/^RRULE:/i, '').toUpperCase();
    const n = rruleInterval(u);
    const floorMin = minMs ? Math.max(1, Math.round(Number(minMs) / 60000)) : 1;
    if (u.indexOf('FREQ=MINUTELY') === 0) {
      const minutes = Math.max(n, floorMin);
      return minutes === 1 ? 'Every minute' : 'Every ' + minutes + ' minutes';
    }
    if (u.indexOf('FREQ=HOURLY') === 0) return n === 1 ? 'Hourly' : 'Every ' + n + ' hours';
    if (u.indexOf('BYDAY=MO,TU,WE,TH,FR') >= 0 && u.indexOf('BYHOUR=9') >= 0) return 'Weekdays at 9:00';
    if (u.indexOf('FREQ=DAILY') === 0) return 'Daily';
    if (u.indexOf('FREQ=WEEKLY') === 0) return 'Weekly';
    if (u.indexOf('FREQ=MONTHLY') === 0) return 'Monthly';
    return rrule;
  }
  function seriesIsDense(s) {
    const u = String((s && s.rrule) || '').toUpperCase();
    return u.indexOf('FREQ=MINUTELY') === 0 || u.indexOf('FREQ=HOURLY') === 0;
  }
  function seriesNextFire(s) {
    if (!s) return null;
    const inst = (state.calendar.instances || []).filter(i => i.series_id === s.id && (i.status === 'scheduled' || i.status === 'due' || i.status === 'queued' || i.status === 'running'));
    inst.sort((a, b) => a.scheduled_at - b.scheduled_at);
    if (inst[0]) return inst[0].scheduled_at;
    return s.next_due_at || null;
  }
  function seriesRowHtml(s) {
    const tz = orgTimezone();
    const next = seriesNextFire(s);
    const cadence = rruleProse(s.rrule, s.min_interval_ms);
    let when = 'no next fire';
    if (s.status === 'paused') when = 'paused';
    else if (s.status === 'proposed') when = 'needs confirm';
    else if (next) when = 'next ' + fmtClockTz(next, tz);
    const muted = s.status === 'paused' || s.status === 'cancelled';
    return '<button type="button" class="cal-item' + (muted ? ' muted' : '') + '" data-series="' + escapeHtml(s.id) + '"><strong>' + escapeHtml(s.title) + '</strong> <span class="muted">' + escapeHtml(cadence) + ' · ' + escapeHtml(when) + ' · ' + escapeHtml(botName(s.assignee_bot_id)) + '</span></button>';
  }
  function repeatFromRrule(rrule) {
    if (!rrule) return 'none';
    const u = String(rrule).replace(/^RRULE:/i, '').toUpperCase();
    if (u.indexOf('FREQ=WEEKLY') >= 0 && u.indexOf('BYDAY=MO,TU,WE,TH,FR') >= 0 && u.indexOf('BYHOUR=9') >= 0) return 'weekdays';
    if (u.indexOf('FREQ=DAILY') === 0) return 'daily';
    if (u.indexOf('FREQ=WEEKLY') === 0) return 'weekly';
    return 'custom';
  }
  function rruleFromRepeat(repeat, localVal, custom) {
    if (repeat === 'none' || !repeat) return null;
    if (repeat === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0';
    if (repeat === 'custom') {
      const t = String(custom || '').trim();
      return t || null;
    }
    const bits = String(localVal || '').split('T');
    const date = (bits[0] || '').split('-');
    const time = (bits[1] || '00:00').split(':');
    const y = Number(date[0]), mo = Number(date[1]), d = Number(date[2]);
    const hh = Number(time[0] || 0), mm = Number(time[1] || 0);
    if (repeat === 'daily') return 'FREQ=DAILY;INTERVAL=1;BYHOUR=' + hh + ';BYMINUTE=' + mm;
    if (repeat === 'weekly') {
      const by = ['SU','MO','TU','WE','TH','FR','SA'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] || 'MO';
      return 'FREQ=WEEKLY;BYDAY=' + by + ';BYHOUR=' + hh + ';BYMINUTE=' + mm;
    }
    return null;
  }
  function zoneSelectHtml(id, selected) {
    const cur = selected || 'UTC';
    const zones = ianaZones();
    if (!zones) return '<input id="' + id + '" value="' + escapeHtml(cur) + '" placeholder="UTC" autocomplete="off" />';
    const list = zones.indexOf(cur) >= 0 ? zones : [cur].concat(zones);
    return '<select id="' + id + '">' + list.map(z => '<option value="' + escapeHtml(z) + '"' + (z === cur ? ' selected' : '') + '>' + escapeHtml(z) + '</option>').join('') + '</select>';
  }
  function deskBotOptions(selected) {
    return (state.bots || []).map(b => '<option value="' + escapeHtml(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + escapeHtml(b.name) + '</option>').join('');
  }
  function instNote(i) {
    if (!i) return '';
    if (i.status === 'skipped_offline') return 'missed — OpenBot was down';
    if (i.status === 'skipped_coalesce') return 'coalesced';
    if (i.status === 'skipped_paused') return 'paused';
    if (i.status === 'due') return 'due';
    if (i.status === 'running') return 'running';
    if (i.status === 'queued') return 'queued';
    if (i.status === 'failed') return 'failed';
    if (i.status === 'cancelled') return 'cancelled';
    if (i.status === 'completed') return 'done';
    return '';
  }
  function instMuted(i) {
    return i && (i.status === 'skipped_offline' || i.status === 'skipped_coalesce' || i.status === 'skipped_paused' || i.status === 'cancelled');
  }
  function kindBadge(s) {
    if (!s) return '';
    if (s.status === 'proposed') return 'Proposed';
    if (s.kind === 'routine') return 'Routine';
    return 'Schedule';
  }
  function firingThreadLabel(series) {
    if (!series || !series.thread_id) return 'Assignee DM';
    const g = (state.groups || []).find(t => t.id === series.thread_id);
    if (g) return g.title || 'Group';
    return 'DM · ' + botName(series.assignee_bot_id);
  }
  function calHorizon() {
    const tz = orgTimezone();
    const now = Date.now();
    const p = tzParts(now, tz);
    if (!state.calMonth) state.calMonth = { y: p.year, m: p.month };
    const y = state.calMonth.y, m = state.calMonth.m;
    const monthFrom = Date.UTC(y, m - 1, 1) - 14 * 86400000;
    const monthTo = Date.UTC(y, m, 1) + 14 * 86400000;
    const agendaFrom = now - 2 * 86400000;
    const agendaTo = now + 14 * 86400000;
    return { from: Math.min(monthFrom, agendaFrom), to: Math.max(monthTo, agendaTo), tz, now, todayKey: ymdKey(now, tz) };
  }

  async function openCalendar() {
    rememberAgUiMessages();
    detachAgUiStream();
    state.view = 'calendar';
    renderApp();
    await paintCalendar();
  }
  async function learnThis() {
    if (!state.thread || (state.view !== 'human' && state.view !== 'group') || (state.view === 'human' && !state.bot)) return;
    const ok = await askConfirm({
      title: 'Learn this',
      body: 'This saves a prompt you can edit, not a recording of clicks. OpenBot will not replay the browser session.',
      confirmLabel: 'Learn this',
    });
    if (!ok) return;
    try {
      const source = state.view === 'human'
        ? { agentId:state.bot.id }
        : { threadId:state.thread.id };
      const res = await api('/v1/calendar/learn', { method:'POST', body: JSON.stringify(source) });
      state.calMode = 'agenda';
      state.view = 'calendar';
      renderApp();
      await paintCalendar();
      if (res && res.series) openEventForm(res.series);
    } catch (e) {
      announce(e.message || 'Could not learn this');
    }
  }
  function setCalMode(mode) {
    state.calMode = mode === 'month' ? 'month' : 'agenda';
    const ag = document.getElementById('cal-agenda');
    const mo = document.getElementById('cal-month');
    if (ag) ag.setAttribute('aria-pressed', state.calMode === 'agenda' ? 'true' : 'false');
    if (mo) mo.setAttribute('aria-pressed', state.calMode === 'month' ? 'true' : 'false');
    void paintCalendar();
  }

  async function paintCalendar() {
    const body = document.getElementById('cal-body');
    if (!body) return;
    const range = calHorizon();
    try {
      const res = await api('/v1/calendar?from=' + range.from + '&to=' + range.to);
      state.calendar = { series: res.series || [], instances: res.instances || [], timezone: res.timezone || range.tz };
      if (res.timezone && state.org) state.org.timezone = res.timezone;
    } catch { /* keep last snapshot */ }
    if (!document.getElementById('cal-body')) return;
    drawCalendar();
  }

  function drawCalendar() {
    const body = document.getElementById('cal-body');
    if (!body) return;
    if (state.calMode === 'month') drawMonth(body);
    else drawAgenda(body);
  }

  function seriesById(id) {
    return (state.calendar.series || []).find(s => s.id === id) || null;
  }

  function drawAgenda(body) {
    const series = (state.calendar.series || []).filter(s => s.status !== 'cancelled');
    const proposed = series.filter(s => s.status === 'proposed');
    const active = series.filter(s => s.status === 'active').slice().sort((a, b) => (seriesNextFire(a) || 1e15) - (seriesNextFire(b) || 1e15));
    const paused = series.filter(s => s.status === 'paused');
    let html = '';
    if (proposed.length) {
      html += '<h3>Proposed</h3>';
      for (const s of proposed) html += seriesRowHtml(s);
    }
    if (active.length) {
      html += '<h3>Schedules</h3>';
      for (const s of active) html += seriesRowHtml(s);
    }
    if (paused.length) {
      html += '<h3>Paused</h3>';
      for (const s of paused) html += seriesRowHtml(s);
    }
    if (!html) {
      html = '<p class="empty">No upcoming events. New event creates a schedule.</p>';
    }
    body.innerHTML = html;
    bindCalItems(body);
  }

  function drawMonth(body) {
    const tz = orgTimezone();
    const now = Date.now();
    const cur = tzParts(now, tz);
    if (!state.calMonth) state.calMonth = { y: cur.year, m: cur.month };
    const y = state.calMonth.y, m = state.calMonth.m;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const byDay = new Map();
    for (const i of state.calendar.instances || []) {
      const k = ymdKey(i.scheduled_at, tz);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(i);
    }
    const proposed = (state.calendar.series || []).filter(s => s.status === 'proposed');
    const proposedByDay = new Map();
    for (const s of proposed) {
      if (s.dtstart_utc == null) continue;
      const k = ymdKey(s.dtstart_utc, tz);
      if (!proposedByDay.has(k)) proposedByDay.set(k, []);
      proposedByDay.get(k).push(s);
    }
    let html = '<div class="cal-nav"><button type="button" id="cal-prev">Previous</button><strong>' + escapeHtml(monthName) + '</strong><button type="button" id="cal-next">Next</button></div>';
    if (proposed.length) {
      html += '<h3>Proposed</h3>';
      for (const s of proposed) {
        html += '<button type="button" class="cal-item" data-series="' + escapeHtml(s.id) + '"><strong>' + escapeHtml(s.title) + '</strong> <span class="muted">' + escapeHtml(kindBadge(s)) + ' · ' + escapeHtml(botName(s.assignee_bot_id)) + '</span><div class="snip">' + escapeHtml(rruleProse(s.rrule)) + '</div></button>';
      }
    }
    html += '<div class="cal-month">';
    for (const d of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']) html += '<div class="dow">' + d + '</div>';
    const cells = lead + dim;
    const total = Math.ceil(cells / 7) * 7;
    for (let idx = 0; idx < total; idx++) {
      const day = idx - lead + 1;
      const inMonth = day >= 1 && day <= dim;
      const key = inMonth ? (y + '-' + pad2(m) + '-' + pad2(day)) : '';
      const isToday = inMonth && y === cur.year && m === cur.month && day === cur.day;
      html += '<div class="cal-cell' + (inMonth ? '' : ' out') + (isToday ? ' today' : '') + '">';
      html += '<div class="num">' + (inMonth ? day : '') + '</div>';
      const list = ((inMonth && byDay.get(key)) || []).filter(i => {
        const s = seriesById(i.series_id);
        return s && s.status !== 'paused' && s.status !== 'cancelled';
      });
      const grouped = new Map();
      for (const i of list) {
        if (!grouped.has(i.series_id)) grouped.set(i.series_id, []);
        grouped.get(i.series_id).push(i);
      }
      grouped.forEach((items, sid) => {
        const s = seriesById(sid);
        if (seriesIsDense(s) || items.length > 2) {
          html += '<button type="button" class="cal-chip" data-series="' + escapeHtml(sid) + '">' + escapeHtml(rruleProse(s && s.rrule) + ' · ' + ((s && s.title) || 'Event')) + '</button>';
          return;
        }
        items.forEach(i => {
          html += '<button type="button" class="cal-chip' + (instMuted(i) ? ' muted' : '') + '" data-series="' + escapeHtml(sid) + '" data-inst="' + escapeHtml(i.id) + '">' + escapeHtml(fmtClockTz(i.scheduled_at, tz) + ' ' + ((s && s.title) || 'Event')) + '</button>';
        });
      });
      const drafts = (inMonth && proposedByDay.get(key)) || [];
      for (const s of drafts) {
        html += '<button type="button" class="cal-chip" data-series="' + escapeHtml(s.id) + '">' + escapeHtml('Proposed · ' + (s.title || 'Event')) + '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
    const prev = body.querySelector('#cal-prev');
    const next = body.querySelector('#cal-next');
    if (prev) prev.onclick = () => {
      let mm = state.calMonth.m - 1, yy = state.calMonth.y;
      if (mm < 1) { mm = 12; yy -= 1; }
      state.calMonth = { y: yy, m: mm };
      void paintCalendar();
    };
    if (next) next.onclick = () => {
      let mm = state.calMonth.m + 1, yy = state.calMonth.y;
      if (mm > 12) { mm = 1; yy += 1; }
      state.calMonth = { y: yy, m: mm };
      void paintCalendar();
    };
    bindCalItems(body);
  }

  function bindCalItems(root) {
    root.querySelectorAll('[data-series]').forEach(btn => {
      btn.onclick = () => openCalDetail(btn.getAttribute('data-series'), btn.getAttribute('data-inst'));
    });
  }

  async function openCalDetail(seriesId, instanceId) {
    if (!seriesId) return;
    let series = seriesById(seriesId);
    let instances = (state.calendar.instances || []).filter(i => i.series_id === seriesId);
    let nextFire = null;
    try {
      const res = await api('/v1/calendar/series/' + encodeURIComponent(seriesId));
      series = res.series || series;
      if (res.instances) instances = res.instances;
      nextFire = res.nextFire;
    } catch {}
    if (!series) return;
    const inst = instanceId ? (instances.find(i => i.id === instanceId) || (state.calendar.instances || []).find(i => i.id === instanceId)) : null;
    let lastRun = null;
    for (const i of instances) {
      if (!i.turn_id) continue;
      if (i.status !== 'completed' && i.status !== 'failed' && i.status !== 'running') continue;
      if (!lastRun || Number(i.scheduled_at) > Number(lastRun.scheduled_at)) lastRun = i;
    }
    const orgTz = orgTimezone();
    const seriesTz = series.timezone || orgTz;
    const running = inst && inst.status === 'running';
    const canCancelOcc = inst && (inst.status === 'scheduled' || inst.status === 'due' || inst.status === 'queued');
    const cancelled = series.status === 'cancelled';
    function whenBoth(ms) {
      let s = fmtWhenTz(ms, orgTz);
      if (seriesTz && seriesTz !== orgTz) s += ' · ' + fmtWhenTz(ms, seriesTz);
      return s;
    }
    const overlay = h('<div class="overlay"><div class="modal">' +
      '<h2 id="cal-d-title">' + escapeHtml(series.title) + '</h2>' +
      '<p class="muted">' + escapeHtml(kindBadge(series)) + (series.status && series.status !== 'proposed' && series.status !== 'active' ? ' · ' + escapeHtml(series.status) : '') + '</p>' +
      '<p>' + escapeHtml(rruleProse(series.rrule)) + '</p>' +
      '<p class="muted">Assignee · ' + escapeHtml(botName(series.assignee_bot_id)) + '</p>' +
      '<p class="muted">Fires on · ' + escapeHtml(firingThreadLabel(series)) + '</p>' +
      (lastRun && lastRun.turn_id ? '<p><button type="button" class="linkish" id="cal-last-run">Last run ' + escapeHtml(whenBoth(lastRun.finished_at || lastRun.started_at || lastRun.scheduled_at)) + '</button></p>' : '') +
      (nextFire ? '<p class="muted">Next fire · ' + escapeHtml(whenBoth(nextFire)) + '</p>' : '') +
      (running ? '<p class="muted">In-flight — this run will finish.</p>' : '') +
      '<p class="err" id="cal-d-err" hidden></p>' +
      '<div class="modal-actions">' +
      (series.status === 'proposed' ? '<button type="button" class="primary" id="cal-confirm">Confirm</button>' : '') +
      (series.status === 'proposed' || cancelled ? '' : '<button type="button" id="cal-pause">' + (series.status === 'paused' ? 'Resume' : 'Pause') + '</button>') +
      (cancelled ? '' : '<button type="button" id="cal-edit">Edit</button>') +
      (canCancelOcc ? '<button type="button" id="cal-del-occ">Delete this occurrence</button>' : '') +
      (cancelled ? '' : '<button type="button" id="cal-del-series">Delete this series</button>') +
      '<button type="button"' + (series.status === 'proposed' ? '' : ' class="primary"') + ' id="cal-d-close">Close</button>' +
      '</div></div></div>');
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'cal-d-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#cal-d-close').onclick = close;
    const confirmBtn = overlay.querySelector('#cal-confirm');
    if (confirmBtn) confirmBtn.onclick = () => { close(); openEventForm(series); };
    const lastBtn = overlay.querySelector('#cal-last-run');
    if (lastBtn) lastBtn.onclick = () => {
      close();
      const tid = series.thread_id;
      const group = tid && (state.groups || []).some(g => g.id === tid);
      if (group) void selectGroup(tid);
      else if (series.assignee_bot_id) void selectBot(series.assignee_bot_id);
    };
    const pauseBtn = overlay.querySelector('#cal-pause');
    if (pauseBtn) pauseBtn.onclick = async () => {
      try {
        await api('/v1/calendar/series/' + encodeURIComponent(series.id) + '/pause', { method:'POST', body: JSON.stringify({ paused: series.status !== 'paused' }) });
        close();
        await paintCalendar();
      } catch (e) {
        const err = overlay.querySelector('#cal-d-err');
        err.hidden = false;
        err.textContent = e.message || 'Could not pause';
      }
    };
    const editBtn = overlay.querySelector('#cal-edit');
    if (editBtn) editBtn.onclick = () => { close(); openEventForm(series); };
    const delOcc = overlay.querySelector('#cal-del-occ');
    if (delOcc) delOcc.onclick = async () => {
      const ok = await askConfirm({ title: 'Delete this occurrence?', body: 'This occurrence will not fire. The rest of the series stays.', confirmLabel: 'Delete occurrence' });
      if (!ok) return;
      try {
        await api('/v1/calendar/instances/' + encodeURIComponent(inst.id) + '/cancel', { method:'POST', body: '{}' });
        close();
        await paintCalendar();
      } catch (e) {
        if (e.status === 409) {
          const err = overlay.querySelector('#cal-d-err');
          err.hidden = false;
          err.textContent = 'In-flight — this run will finish.';
          return;
        }
        const err = overlay.querySelector('#cal-d-err');
        err.hidden = false;
        err.textContent = e.message || 'Could not cancel';
      }
    };
    const delSeries = overlay.querySelector('#cal-del-series');
    if (delSeries) delSeries.onclick = async () => {
      const ok = await askConfirm({ title: 'Delete this series?', body: 'This series will stop. History stays.', confirmLabel: 'Delete series' });
      if (!ok) return;
      try {
        await api('/v1/calendar/series/' + encodeURIComponent(series.id), { method:'DELETE' });
        close();
        await paintCalendar();
      } catch (e) {
        const err = overlay.querySelector('#cal-d-err');
        err.hidden = false;
        err.textContent = e.message || 'Could not delete';
      }
    };
  }

  function openNewEvent() { openEventForm(null); }

  function openEventForm(series) {
    const tzDefault = (series && series.timezone) || orgTimezone();
    const botDefault = (series && series.assignee_bot_id) || state.bot?.id || (state.bots[0] && state.bots[0].id) || '';
    const localDefault = series ? toLocalInput(series.dtstart_utc, tzDefault) : (function() {
      const p = tzParts(Date.now() + 86400000, tzDefault);
      return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T09:00';
    })();
    const repeatDef = repeatFromRrule(series && series.rrule);
    const bot = state.bots.find(b => b.id === botDefault);
    const approveDef = series ? Boolean(Number(series.require_human_approval)) : Boolean(bot && Number(bot.require_human_approval));
    const learned = series && series.kind === 'routine';
    const overlay = h('<div class="overlay"><div class="modal">' +
      '<h2 id="cal-e-title">' + (series ? (series.status === 'proposed' ? (learned ? 'Proposed routine' : 'Proposed event') : 'Edit event') : 'New event') + '</h2>' +
      (learned ? '<p class="muted">This saves a prompt you can edit, not a recording of clicks. OpenBot will not replay the browser session.</p>' : '') +
      '<label for="cal-title">Title</label><input id="cal-title" maxlength="200" value="' + escapeHtml((series && series.title) || '') + '" />' +
      '<label for="cal-bot">Assignee</label><select id="cal-bot">' + deskBotOptions(botDefault) + '</select>' +
      (series ? '<p class="muted">Fires on · ' + escapeHtml(firingThreadLabel(series)) + '</p>' : '') +
      '<label for="cal-when">When</label><input id="cal-when" type="datetime-local" value="' + escapeHtml(localDefault) + '" />' +
      '<label for="cal-tz">Timezone</label>' + zoneSelectHtml('cal-tz', tzDefault) +
      '<label for="cal-repeat">Repeat</label><select id="cal-repeat">' +
        '<option value="none"' + (repeatDef === 'none' ? ' selected' : '') + '>Does not repeat</option>' +
        '<option value="weekdays"' + (repeatDef === 'weekdays' ? ' selected' : '') + '>Weekdays 09:00</option>' +
        '<option value="daily"' + (repeatDef === 'daily' ? ' selected' : '') + '>Daily</option>' +
        '<option value="weekly"' + (repeatDef === 'weekly' ? ' selected' : '') + '>Weekly</option>' +
        '<option value="custom"' + (repeatDef === 'custom' ? ' selected' : '') + '>Custom RRULE</option>' +
      '</select>' +
      '<label for="cal-rrule" id="cal-rrule-lab"' + (repeatDef === 'custom' ? '' : ' hidden') + '>RRULE</label>' +
      '<input id="cal-rrule" maxlength="512" value="' + escapeHtml((repeatDef === 'custom' && series && series.rrule) || '') + '"' + (repeatDef === 'custom' ? '' : ' hidden') + ' />' +
      '<label for="cal-prompt">Prompt</label><textarea id="cal-prompt" maxlength="32000" rows="5">' + escapeHtml((series && series.prompt) || '') + '</textarea>' +
      '<label><input type="checkbox" id="cal-approve"' + (approveDef ? ' checked' : '') + ' /> Require approval for SendMessage</label>' +
      '<p class="err" id="cal-e-err" hidden></p>' +
      '<div class="modal-actions">' +
      (series && series.status === 'proposed' ? '<button type="button" class="primary" id="cal-confirm">Confirm</button>' : '') +
      '<button type="button"' + (series && series.status === 'proposed' ? '' : ' class="primary"') + ' id="cal-save">' + (series ? 'Save' : 'Create') + '</button>' +
      '<button type="button" id="cal-e-close">Cancel</button></div>' +
      '</div></div>');
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'cal-e-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#cal-e-close').onclick = close;
    const repeatEl = overlay.querySelector('#cal-repeat');
    const rruleEl = overlay.querySelector('#cal-rrule');
    const rruleLab = overlay.querySelector('#cal-rrule-lab');
    function syncRepeat() {
      const custom = repeatEl.value === 'custom';
      rruleEl.hidden = !custom;
      rruleLab.hidden = !custom;
    }
    repeatEl.onchange = syncRepeat;
    overlay.querySelector('#cal-bot').onchange = () => {
      const b = state.bots.find(x => x.id === overlay.querySelector('#cal-bot').value);
      if (!series) overlay.querySelector('#cal-approve').checked = Boolean(b && Number(b.require_human_approval));
    };
    async function submitCalForm(activate) {
      const err = overlay.querySelector('#cal-e-err');
      const title = overlay.querySelector('#cal-title').value.trim();
      const prompt = overlay.querySelector('#cal-prompt').value;
      const botId = overlay.querySelector('#cal-bot').value;
      const dtstart = overlay.querySelector('#cal-when').value;
      const timezone = overlay.querySelector('#cal-tz').value.trim();
      const rrule = rruleFromRepeat(repeatEl.value, dtstart, rruleEl.value);
      if (!title || !prompt || !botId || !dtstart) {
        err.hidden = false;
        err.textContent = 'Title, assignee, when, and prompt are required.';
        return false;
      }
      try {
        if (series) {
          await api('/v1/calendar/series/' + encodeURIComponent(series.id), { method:'PATCH', body: JSON.stringify({ title, prompt, botId, dtstart, timezone, rrule, requireHumanApproval: overlay.querySelector('#cal-approve').checked }) });
          if (activate && series.status === 'proposed') {
            await api('/v1/calendar/series/' + encodeURIComponent(series.id) + '/confirm', { method:'POST', body: '{}' });
          }
        } else {
          const body = { title, prompt, botId, dtstart, timezone, requireHumanApproval: overlay.querySelector('#cal-approve').checked };
          if (rrule) body.rrule = rrule;
          await api('/v1/calendar/series', { method:'POST', body: JSON.stringify(body) });
        }
        return true;
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || (activate ? 'Could not confirm' : 'Could not save');
        return false;
      }
    }
    async function finishCalForm() {
      close();
      if (state.view === 'calendar') await paintCalendar();
      else await openCalendar();
    }
    overlay.querySelector('#cal-save').onclick = async () => {
      if (await submitCalForm(false)) await finishCalForm();
    };
    const confirmBtn = overlay.querySelector('#cal-confirm');
    if (confirmBtn) confirmBtn.onclick = async () => {
      if (await submitCalForm(true)) await finishCalForm();
    };
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
      else if (state.view === 'calendar') void paintCalendar();
      else if (state.view !== 'archive') paintMessages();
      paintLiveChip();
    } catch {}
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

  function buildLiveBlocks(canonicalBlocks) {
    const working = state.agUiRun && state.agUiRun.phase === 'active';
    const blocks = (canonicalBlocks || []).map(block => ({ ...block }));
    const last = blocks[blocks.length - 1];
    for (const b of blocks) {
      if (b.type === 'thought') b.openDefault = working && last === b;
      if (b.type === 'tool') b.openDefault = b.status === 'running' || b.status === 'in_progress';
      if (b.type === 'write') b.openDefault = false;
    }
    return blocks;
  }

  function liveSummary() {
    const blocks = buildLiveBlocks(state.live);
    const last = [...blocks].reverse().find(b => b.type !== 'status' || b.text === 'Needs permission' || b.text === 'Turn finished');
    if (!last) return state.agUiRun && state.agUiRun.phase === 'active' ? 'Working' : 'Quiet';
    if (last.type === 'thought') return 'Thinking';
    if (last.type === 'write') return 'Writing';
    if (last.type === 'tool') return (last.status === 'running' ? 'Using ' : last.status === 'completed' ? 'Finished ' : '') + last.title;
    return last.text;
  }

  function paintLive() {
    const live = document.getElementById('live');
    const sum = document.getElementById('live-summary');
    if (sum) sum.textContent = liveSummary();
    paintLiveChip();
    if (!live) return;
    const openIds = new Set([...live.querySelectorAll('details[open]')].map(d => d.getAttribute('data-id')));
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
        div.textContent = b.text + (typeof b.progress === 'number' ? ' · ' + Math.round(b.progress * 100) + '%' : '');
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

  async function reloadThread() {
    if (state.view === 'activity') { void paintActivity(); return; }
    if (state.view === 'calendar') { void paintCalendar(); return; }
    if (state.view === 'archive') return;
    if (state.view === 'human') {
      if (state.sending || !state.bot || !state.thread || !state.agUiContext) return;
      const botId = state.bot.id;
      const legacyThreadId = state.thread.id;
      const context = state.agUiContext;
      try {
        const conversation = await fetchAgUiConversation(botId);
        if (state.view !== 'human' || !state.bot || !state.thread || state.bot.id !== botId || state.thread.id !== legacyThreadId) return;
        state.messages = mergeAgUiMessages(adoptAgUiConversation(context, conversation), context, true);
        rememberAgUiMessages();
        paintMessages();
        const needsReplay = (context.active || context.interrupted) && context.lastRunId;
        const hasRun = state.agUiRun && state.agUiRun.runId === context.lastRunId && ['idle', 'active', 'interrupted'].includes(state.agUiRun.phase);
        if (needsReplay && !hasRun && !state.agUiAbort) void replayAgUiRun(context);
      } catch {}
      return;
    }
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
      state.messages.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
      paintMessages();
    } catch {}
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
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // The push socket is only an invalidation channel for non-run resources.
      // Human run state is owned by the AG-UI SSE stream; groups are refreshed by polling.
      if (msg.type === 'bots.updated') {
        void refreshRoster().then(() => renderApp());
      }
      if (msg.type === 'agent.conversation.updated' && state.view === 'human' && state.bot && msg.agentId === state.bot.id) {
        void reloadThread();
      }
      if (msg.type === 'calendar.updated' || msg.type === 'calendar.proposed' || msg.type === 'calendar.fire') {
        if (state.view === 'calendar') void paintCalendar();
      }
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
      const overlay = h(`<div class="overlay"><div class="modal">
        <h2 id="c-title"></h2>
        <p id="c-body"></p>
        <label for="c-type" id="c-label" hidden></label>
        <input id="c-type" autocomplete="off" hidden />
        <p class="err" id="c-err" hidden></p>
        <div class="modal-actions">
          <button type="button" class="primary" id="c-ok"></button>
          <button type="button" id="c-no">Cancel</button>
        </div>
      </div></div>`);
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

  async function resumeAgUiInterrupt(context, interruptedRun, responses) {
    if (!currentAgUiOwner(context) || context.active || !context.taskId) return;
    const runId = newAgUiId('run');
    const input = agUiRequestInput(context, runId, interruptedRun.runId, null, responses, context.taskId);
    context.lastRunId = runId;
    context.active = true;
    context.interrupted = false;
    saveAgUiContext(context);
    state.sending = true;
    let run = newAgUiRunState(context.threadId, runId);
    syncAgUiView(context, run);
    try {
      run = await postAgUiRun(context, input, run);
      if (run.phase === 'interrupted' && currentAgUiOwner(context)) showAgUiInterrupt(context, run);
      announce(run.phase === 'completed' ? 'Permission response sent' : 'Run ended');
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      context.active = false;
      context.interrupted = true;
      context.lastRunId = interruptedRun.runId;
      saveAgUiContext(context);
      run = agUiClientFailure(run, error);
      syncAgUiView(context, run);
      announce('Could not send the permission response');
    } finally {
      if (currentAgUiOwner(context)) {
        state.sending = false;
        paintMessages();
        syncSend();
      }
    }
  }

  function showAgUiInterrupt(context, run, index=0, responses=[]) {
    const interrupt = run && run.interrupts && run.interrupts[index];
    if (!interrupt || !currentAgUiOwner(context) || document.querySelector('[data-ag-ui-interrupt]')) return;
    const booleanResponse = interrupt.responseSchema && interrupt.responseSchema.type === 'boolean';
    const controls = booleanResponse
      ? `<button class="primary" type="button" id="allow">Allow</button><button type="button" id="deny">Deny</button>`
      : `<label for="interrupt-response">Response (JSON)</label><textarea id="interrupt-response" rows="4"></textarea><button class="primary" type="button" id="resolve-interrupt">Continue</button><button type="button" id="cancel-interrupt">Cancel request</button>`;
    const overlay = h(`<div class="overlay" data-ag-ui-interrupt="${escapeHtml(interrupt.id)}"><div class="modal">
      <h2 id="perm-title">${booleanResponse ? 'Permission' : 'Input needed'}${run.interrupts.length > 1 ? ' (' + (index + 1) + ' of ' + run.interrupts.length + ')' : ''}</h2>
      <p>${escapeHtml(interrupt.message || interrupt.reason)}</p>
      <div class="modal-actions">${controls}</div>
      <p class="err" id="interrupt-error" hidden></p>
    </div></div>`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'perm-title');
    const close = openOverlay(overlay);
    const submit = response => {
      close();
      const all = [...responses, response];
      if (index + 1 < run.interrupts.length) showAgUiInterrupt(context, run, index + 1, all);
      else void resumeAgUiInterrupt(context, run, all);
    };
    const allow = overlay.querySelector('#allow');
    const deny = overlay.querySelector('#deny');
    if (allow) allow.onclick = () => submit({ interruptId:interrupt.id, status:'resolved', payload:true });
    if (deny) deny.onclick = () => submit({ interruptId:interrupt.id, status:'resolved', payload:false });
    const resolve = overlay.querySelector('#resolve-interrupt');
    if (resolve) resolve.onclick = () => {
      const raw = overlay.querySelector('#interrupt-response').value.trim();
      let payload;
      try { payload = raw ? JSON.parse(raw) : null; }
      catch {
        const error = overlay.querySelector('#interrupt-error');
        error.hidden = false;
        error.textContent = 'Enter a valid JSON response.';
        return;
      }
      submit({ interruptId:interrupt.id, status:'resolved', payload });
    };
    const cancel = overlay.querySelector('#cancel-interrupt');
    if (cancel) cancel.onclick = () => submit({ interruptId:interrupt.id, status:'cancelled' });
  }

  async function refreshRoster() {
    const bots = await api('/v1/bots');
    state.bots = bots.bots || [];
    state.a2aGateway = bots.a2aGateway || null;
    state.archived = bots.archived || [];
    if (bots.archiveTtlMs) state.archiveTtlMs = bots.archiveTtlMs;
    if (state.bot) {
      state.bot = state.bots.find(b => b.id === state.bot.id) || state.bots[0] || null;
    }
  }

  async function openArchiveFolder() {
    try { await refreshRoster(); } catch {}
    rememberAgUiMessages();
    detachAgUiStream();
    state.view = 'archive';
    renderApp();
  }

  async function archiveCurrentBot() {
    if (!state.bot) return;
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
    const overlay = h(`<div class="overlay"><div class="modal">
      <h2 id="orgs-title">Orgs</h2>
      <p class="muted">Local bookmarks for desks this browser can open. They are stored only in this browser.</p>
      <p><strong>This instance</strong> · ${escapeHtml(thisOrgName())} · <span class="mono">${escapeHtml(location.origin)}</span></p>
      <ul id="org-list"></ul>
      <label for="org-add-name">Name (optional)</label>
      <input id="org-add-name" placeholder="defaults to hostname" autocomplete="off" />
      <label for="org-url">Org URL</label>
      <input id="org-url" placeholder="https://beta.example.com" autocomplete="off" />
      <p class="err" id="org-err" hidden></p>
      <div class="modal-actions">
        <button type="button" id="add-org">Add org</button>
        <button type="button" class="primary" id="bookmark-org">Bookmark this URL</button>
        <button type="button" id="close-orgs">Close</button>
      </div>
    </div></div>`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'orgs-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close-orgs').onclick = close;
    function paintBookmarks() {
      const box = overlay.querySelector('#org-list');
      const err = overlay.querySelector('#org-err');
      err.hidden = true;
      const list = loadOrgBookmarks();
      if (!list.length) {
        box.innerHTML = '<li class="muted">No bookmarks yet. Bookmark this URL, or paste another org http(s) URL.</li>';
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
    function rememberOrg(name, baseUrl) {
      const err = overlay.querySelector('#org-err');
      const fail = addOrgBookmark(name, baseUrl);
      if (fail) { err.hidden = false; err.textContent = fail; return; }
      err.hidden = true;
      announce('Bookmarked');
      paintBookmarks();
    }
    overlay.querySelector('#bookmark-org').onclick = () => rememberOrg(thisOrgName(), location.origin);
    overlay.querySelector('#add-org').onclick = () => {
      rememberOrg(overlay.querySelector('#org-add-name').value, overlay.querySelector('#org-url').value);
    };
    paintBookmarks();
  }

  function openHelp() {
    const overlay = h(`<div class="overlay"><div class="modal">
      <h2 id="help-title">Keyboard and chat</h2>
      <ul>
        <li><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</li>
        <li>Focus stays in the composer after send</li>
        <li><kbd>Esc</kbd> closes dialogs and ends desk browser</li>
        <li>Skip link (first Tab) jumps to the message box</li>
        <li><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> toggles Debug mode (header Debug is canonical)</li>
        <li>Desk browser: <kbd>Esc</kbd> closes · <kbd>F6</kbd> moves to Close</li>
        <li>Bots hire teammates with <code>CreateBot</code> (cap 6). They must not use <code>/auth/local</code> or <code>POST /v1/bots</code>.</li>
      </ul>
      <p class="muted">Default chat is the messenger. Debug shows live work (thinking and tools). Model and reasoning are in Settings, and in the Debug composer. Appearance is Settings.</p>
      <p class="muted">Teammates keep working if you close this tab. Stopping <code>openbot server</code> stops them.</p>
      <p class="muted">OpenAI-compatible clients (Open WebUI) can use <code>/v1</code> with an API key from Settings.</p>
      <div class="modal-actions"><button type="button" class="primary" id="close">Close</button></div>
    </div></div>`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'help-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close').onclick = close;
  }

  async function openSettings() {
    try { state.org = await api('/v1/org'); } catch { state.org = state.org || {}; }
    const curTz = (state.org && state.org.timezone) || 'UTC';
    const overlay = h(`<div class="overlay"><div class="modal">
      <h2 id="set-title">Settings</h2>
      <p class="muted">${harnessBlurb()}</p>
      <label for="set-theme">Appearance</label>
      <select id="set-theme" aria-describedby="set-theme-help">
        <option value="system">Match system</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      <p id="set-theme-help" class="muted">Match system follows this device. Dark is ink; Light is paper.</p>
      <h2 style="margin-top:16px;font-size:1rem">Timezone</h2>
      <p class="muted">Used when you type 9am. Existing events keep their own zone. Defaults to UTC until you pick one.</p>
      <label for="org-tz">IANA timezone</label>
      ${zoneSelectHtml('org-tz', curTz)}
      <p class="err" id="tz-err" hidden></p>
      <label for="set-key">API key override (optional)</label>
      <input id="set-key" type="password" autocomplete="off" placeholder="leave blank to use grok login" />
      ${inferenceFields('set-model', 'set-effort')}
      <div id="desk-controls">
      <label for="mode">Permission mode</label>
      <select id="mode">
        <option value="auto">Auto</option>
        <option value="ask">Ask</option>
        <option value="always-approve">Always-approve</option>
      </select>
      <label><input type="checkbox" id="approve" /> Require approval for SendMessage</label>
      <label><input type="checkbox" id="mem-approve" /> Require approval for Memory writes</label>
      </div>
      <h2 style="margin-top:16px;font-size:1rem">Standing notes</h2>
      <p class="muted">Frozen at next <code>session/new</code> (idle ~2h, compact, model/roster respawn, or Save which kills the child <strong>if it is not in a turn</strong>). This warm session is unchanged. <code>Memory.read</code> sees sqlite now.</p>
      <label for="org-notes">Org notes</label>
      <textarea id="org-notes" maxlength="1200" rows="4"></textarea>
      <label for="bot-notes">This bot</label>
      <textarea id="bot-notes" maxlength="2000" rows="4"></textarea>
      <div id="pending-notes" hidden>
        <p class="muted" id="pending-caption">Pending agent write</p>
        <pre id="pending-body" class="md-pre"></pre>
        <button type="button" id="pending-approve">Approve</button>
        <button type="button" id="pending-reject">Reject</button>
      </div>
      <p class="err" id="mem-err" hidden></p>
      <h2 style="margin-top:16px;font-size:1rem">OpenAI-compatible keys</h2>
      <p class="muted">For Open WebUI or any OpenAI client. Base URL <code>${location.origin}/v1</code>, model <code>openbot/${escapeHtml(state.bot?.name || 'Ada')}</code>.</p>
      <p class="muted">Each OpenBot process is one org. Switch org in Open WebUI by adding another connection (that VM’s base URL + a <code>sk-ob_…</code> key minted there). There is no OpenAI organization field. Models are active desk teammates.</p>
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
    </div></div>`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'set-title');
    const close = openOverlay(overlay);
    overlay.querySelector('#close').onclick = close;
    const themeEl = overlay.querySelector('#set-theme');
    if (themeEl) {
      themeEl.value = readStoredTheme();
      themeEl.onchange = () => applyTheme(themeEl.value);
    }
    if (state.bot) {
      overlay.querySelector('#mode').value = state.bot.permission_mode || 'auto';
      overlay.querySelector('#approve').checked = Boolean(Number(state.bot.require_human_approval));
      overlay.querySelector('#mem-approve').checked = Boolean(Number(state.bot.require_memory_approval));
    }
    let pendingNoteId = null;
    async function loadStandingNotes() {
      const err = overlay.querySelector('#mem-err');
      try {
        const mem = await api('/v1/memory');
        overlay.querySelector('#org-notes').value = mem.org || '';
        const mine = (mem.bots || []).find((b) => b.botId === state.bot?.id);
        overlay.querySelector('#bot-notes').value = mine ? (mine.body || '') : '';
        const pending = (mine && mine.pendingBody) || mem.orgPending;
        pendingNoteId = (mine && mine.pendingBody && mine.id) || (mem.orgPending ? mem.orgNoteId : null);
        const box = overlay.querySelector('#pending-notes');
        if (pending) {
          box.hidden = false;
          overlay.querySelector('#pending-body').textContent = pending;
        } else {
          box.hidden = true;
        }
        err.hidden = true;
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || 'Memory load failed';
      }
    }
    overlay.querySelector('#pending-approve').onclick = async () => {
      if (!pendingNoteId) return;
      try {
        await api('/v1/memory/pending/' + encodeURIComponent(pendingNoteId) + '/approve', { method:'POST', body: '{}' });
        await loadStandingNotes();
      } catch (e) {
        overlay.querySelector('#mem-err').hidden = false;
        overlay.querySelector('#mem-err').textContent = e.message || 'Approve failed';
      }
    };
    overlay.querySelector('#pending-reject').onclick = async () => {
      if (!pendingNoteId) return;
      try {
        await api('/v1/memory/pending/' + encodeURIComponent(pendingNoteId) + '/reject', { method:'POST', body: '{}' });
        await loadStandingNotes();
      } catch (e) {
        overlay.querySelector('#mem-err').hidden = false;
        overlay.querySelector('#mem-err').textContent = e.message || 'Reject failed';
      }
    };
    void loadStandingNotes();
    async function saveTimezone() {
      const err = overlay.querySelector('#tz-err');
      const tz = (overlay.querySelector('#org-tz').value || '').trim();
      if (!tz) { err.hidden = false; err.textContent = 'Pick a timezone'; return false; }
      try {
        const res = await api('/v1/org', { method:'PATCH', body: JSON.stringify({ timezone: tz }) });
        state.org = res;
        err.hidden = true;
        if (state.view === 'calendar') void paintCalendar();
        return true;
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message || 'Invalid timezone';
        return false;
      }
    }
    overlay.querySelector('#org-tz').onchange = () => { void saveTimezone(); };
    bindInferenceSelects(overlay, '#set-model', '#set-effort');
    overlay.querySelector('#save').onclick = async () => {
      const tzOk = await saveTimezone();
      if (!tzOk) return;
      const key = overlay.querySelector('#set-key').value.trim();
      if (key) await api('/v1/credentials/xai', { method:'PUT', body: JSON.stringify({ key }) });
      if (state.bot) {
        const payload = {
          model: overlay.querySelector('#set-model')?.value,
          reasoningEffort: overlay.querySelector('#set-effort')?.value,
        };
        payload.permissionMode = overlay.querySelector('#mode').value;
        payload.requireHumanApproval = overlay.querySelector('#approve').checked;
        payload.requireMemoryApproval = overlay.querySelector('#mem-approve').checked;
        await api('/v1/bots/' + state.bot.id + '/settings', { method:'PATCH', body: JSON.stringify(payload) });
        await api('/v1/memory', { method:'PATCH', body: JSON.stringify({ org: overlay.querySelector('#org-notes').value }) });
        await api('/v1/bots/' + state.bot.id + '/memory', { method:'PATCH', body: JSON.stringify({ body: overlay.querySelector('#bot-notes').value }) });
        state.bot.model = payload.model || state.bot.model;
        state.bot.reasoning_effort = payload.reasoningEffort || state.bot.reasoning_effort;
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
    const overlay = h(`<div class="overlay tk"><div class="modal tk">
      <div class="tk-chrome">
        <h2 id="tk-title">Desk browser</h2>
        <form id="tk-nav">
          <input id="tk-url" name="url" placeholder="https://example.com" autocomplete="off" />
          <button type="submit" class="primary">Go</button>
        </form>
        <span class="muted" id="urlbar">Connecting…</span>
        <button type="button" id="done" aria-keyshortcuts="Escape F6">Close</button>
      </div>
      <div class="tk-stage">
        <canvas id="takeover-frame" width="1280" height="720" role="img" aria-label="Shared desk browser"></canvas>
      </div>
    </div></div>`);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', 'tk-title');
    const canvas = overlay.querySelector('#takeover-frame');
    canvas.tabIndex = 0;
    const stage = overlay.querySelector('.tk-stage');
    let ws = null;
    let viewportTimer = 0;
    let frameUrl = '';
    let lastFit = { dx: 0, dy: 0, dw: 1280, dh: 720 };
    function sendViewport() {
      if (!ws || ws.readyState !== 1 || !stage) return;
      const r = stage.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w < 40 || h < 40) return;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ws.send(JSON.stringify({ type:'viewport', width: w, height: h }));
    }
    function scheduleViewport() {
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(sendViewport, 50);
    }
    const ro = new ResizeObserver(scheduleViewport);
    function cleanupTk() {
      try { if (ws) ws.close(); } catch {}
      window.removeEventListener('resize', scheduleViewport);
      try { ro.disconnect(); } catch {}
      clearTimeout(viewportTimer);
    }
    const close = openOverlay(overlay, cleanupTk);
    function endTakeover() { close(); }
    overlay.querySelector('#done').onclick = endTakeover;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/v1/takeover');
    ws.binaryType = 'arraybuffer';
    overlay.querySelector('#tk-nav').onsubmit = (e) => {
      e.preventDefault();
      let url = String(overlay.querySelector('#tk-url').value || '').trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      overlay.querySelector('#tk-url').value = url;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'navigate', url }));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'auth', ticket: t.ticket }));
      requestAnimationFrame(function() {
        sendViewport();
        requestAnimationFrame(sendViewport);
      });
    };
    ro.observe(stage);
    window.addEventListener('resize', scheduleViewport);
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'meta') {
          const page = msg.pageUrl && msg.pageUrl !== 'about:blank' ? msg.pageUrl : 'Desk browser';
          const origin = msg.pageOrigin && msg.pageOrigin !== 'null' ? ' — ' + msg.pageOrigin : '';
          overlay.querySelector('#urlbar').textContent = page + origin;
          if (msg.pageUrl && msg.pageUrl.indexOf('http') === 0) overlay.querySelector('#tk-url').value = msg.pageUrl;
        }
        if (msg.error) overlay.querySelector('#urlbar').textContent = msg.error;
      } else {
        const blob = new Blob([ev.data], { type: 'image/jpeg' });
        const img = new Image();
        img.onload = () => {
          const cw = canvas.width, ch = canvas.height;
          const scale = Math.min(cw / img.width, ch / img.height);
          const dw = Math.max(1, Math.round(img.width * scale));
          const dh = Math.max(1, Math.round(img.height * scale));
          lastFit = { dx: Math.round((cw - dw) / 2), dy: Math.round((ch - dh) / 2), dw: dw, dh: dh };
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#11161e';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, lastFit.dx, lastFit.dy, lastFit.dw, lastFit.dh);
          if (frameUrl) URL.revokeObjectURL(frameUrl);
        };
        frameUrl = URL.createObjectURL(blob);
        img.src = frameUrl;
      }
    };
    function frac(e) {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return { x: 0, y: 0 };
      const sx = r.width / canvas.width;
      const sy = r.height / canvas.height;
      const imgLeft = lastFit.dx * sx;
      const imgTop = lastFit.dy * sy;
      const imgW = lastFit.dw * sx;
      const imgH = lastFit.dh * sy;
      if (!imgW || !imgH) return { x: 0, y: 0 };
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left - imgLeft) / imgW)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top - imgTop) / imgH)),
      };
    }
    function sendPointer(type, extra) {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify(Object.assign({ type: type }, extra)));
    }
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault(); canvas.focus();
      const p = frac(e);
      sendPointer('mouse', { action:'pressed', x:p.x, y:p.y, button:'left' });
    });
    canvas.addEventListener('mouseup', (e) => {
      const p = frac(e);
      sendPointer('mouse', { action:'released', x:p.x, y:p.y, button:'left' });
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!e.buttons) return;
      const p = frac(e);
      sendPointer('mouse', { action:'moved', x:p.x, y:p.y, button:'left' });
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = frac(e);
      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
      if (e.deltaMode === 2) { dx *= canvas.height; dy *= canvas.height; }
      sendPointer('wheel', { x:p.x, y:p.y, deltaX: dx, deltaY: dy });
    }, { passive: false });
    function sendKey(action, e, text) {
      sendPointer('key', {
        action: action, key: e.key, code: e.code, text: text,
        altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, repeat: e.repeat,
      });
    }
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); endTakeover(); return; }
      if (e.key === 'F6') { e.preventDefault(); const done = document.getElementById('done'); if (done) done.focus(); return; }
      e.preventDefault();
      sendKey('rawKeyDown', e);
      if (e.key.length === 1) sendKey('char', e, e.key);
      else if (e.key === 'Enter') sendKey('char', e, '\r');
    });
    canvas.addEventListener('keyup', (e) => {
      if (e.key === 'Escape' || e.key === 'F6') return;
      sendKey('keyUp', e);
    });
  }

  boot().catch(err => {
    if (el.querySelector('.shell') || el.querySelector('.card')) return;
    el.innerHTML = '<main class="card"><h1>OpenBot</h1><p class="err"></p><p class="muted">Reload the tab. If this persists, the last event stream or cached view may be invalid.</p><p><button type="button" class="primary" onclick="location.reload()">Reload</button></p></main>';
    const p = el.querySelector('.err');
    if (p) p.textContent = err && err.message ? err.message : String(err);
  });
