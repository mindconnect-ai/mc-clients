// Session list, chat with a stream-reattach loop, approval cards.
// Modeled on the JavaFX ApiClient/ChatApp: same endpoints, same frames —
// but every request travels through a tunnel (the WS relay or the
// Firebase RTDB variant, chosen at pairing time), and the afterSeq
// cursor lives in localStorage so the session survives app switches,
// dead spots, and the server's 120-second SSE emitter timeout.
import { RelayClient, pair } from './relay-client.js';
import { RtdbClient } from './rtdb-client.js';
import { firebaseConfig, rtdbServerId } from './firebase-config.js';
import { initPush, getPushToken } from './push-setup.js';
import { renderMarkdown } from './md.js';

const NAMESPACE = 'local';
const $app = document.getElementById('app');
const $title = document.getElementById('title');
const $back = document.getElementById('back');
const $state = document.getElementById('state');

const store = {
  get pairing() { return JSON.parse(localStorage.getItem('mc.pairing') ?? 'null'); },
  set pairing(v) { localStorage.setItem('mc.pairing', JSON.stringify(v)); },
  // Must match the desktop client (ChatPrefs defaults to 'mc_user') or the
  // same user's sessions won't line up — they're filtered by userId. The
  // old 'mobile' default matched nothing, so migrate it away.
  get userId() {
    const v = localStorage.getItem('mc.userId');
    return (!v || v === 'mobile') ? 'mc_user' : v;
  },
  set userId(v) { localStorage.setItem('mc.userId', v); },
  cursor(sessionId) { return Number(localStorage.getItem('mc.cursor.' + sessionId) ?? 0); },
  setCursor(sessionId, seq) { localStorage.setItem('mc.cursor.' + sessionId, String(seq)); },
};

let client = null;
let leaveView = () => {};

function show(title, backTo) {
  leaveView();
  leaveView = () => {};
  $title.textContent = title;
  $back.hidden = !backTo;
  $back.onclick = backTo ?? null;
  $app.replaceChildren();
  document.querySelector('.composer')?.remove();
  return $app;
}

// Base64 of a byte array, chunked so String.fromCharCode never overflows the
// argument stack on larger files.
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node[k] = v;
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

// ── Setup / pairing ──────────────────────────────────────────────────────

function setupView(message = '') {
  const main = show('Mit Server verbinden');
  let mode = store.pairing?.mode ?? (firebaseConfig ? 'rtdb' : 'ws');
  const relayUrl = el('input', { placeholder: 'https://mc-relay-….run.app', value: store.pairing?.relayUrl ?? '' });
  const code = el('input', { placeholder: 'ABCD-1234', autocapitalize: 'characters' });
  const userId = el('input', { value: store.userId });
  const error = el('p', { class: 'error' }, message);
  const relayField = el('div', {}, el('label', {}, 'Relay-URL'), relayUrl);
  const codeField = el('div', {}, el('label', {}, 'Pairing-Code'), code);
  const connectButton = el('button', { class: 'primary' }, 'Verbinden');
  const wsButton = el('button', { class: 'ghost', onclick: () => setMode('ws') }, 'WS-Relay');
  const rtdbButton = el('button', { class: 'ghost', onclick: () => setMode('rtdb') }, 'Firebase');
  const setMode = (m) => {
    mode = m;
    // Firebase is codeless: sign in with Google, the rules check the account.
    relayField.hidden = m === 'rtdb';
    codeField.hidden = m === 'rtdb';
    hint.textContent = m === 'rtdb'
        ? 'Mit Google anmelden — die Freigabe hängt am Konto, kein Code nötig.'
        : 'Der Connector zeigt beim Start einen Pairing-Code an.';
    connectButton.textContent = m === 'rtdb' ? 'Mit Google verbinden' : 'Koppeln';
    wsButton.className = m === 'ws' ? 'primary' : 'ghost';
    rtdbButton.className = m === 'rtdb' ? 'primary' : 'ghost';
    if (m === 'rtdb' && !firebaseConfig) error.textContent = 'firebase-config.js ist noch leer.';
    else if (!message) error.textContent = '';
  };
  const hint = el('p', {});
  connectButton.onclick = async () => {
    try {
      store.userId = userId.value.trim() || 'mc_user';
      if (mode === 'rtdb') {
        // Codeless: remember the intent so boot() reconnects after the
        // Google redirect, then hand off to start() which signs in.
        store.pairing = { mode: 'rtdb', serverId: rtdbServerId };
        start();
      } else {
        await completePairing(mode, code.value, relayUrl.value);
        start();
      }
    } catch (e) {
      error.textContent = e.message;
    }
  };
  main.append(el('div', { class: 'card' },
      hint,
      el('label', {}, 'Transport'),
      el('div', { style: 'display:flex;gap:0.5rem' }, wsButton, rtdbButton),
      relayField,
      codeField,
      el('label', {}, 'Benutzer-ID (wie im Desktop-Client, Standard mc_user)'), userId,
      error,
      el('div', { style: 'margin-top:0.8rem' }, connectButton)));
  setMode(mode);
}

// ── Agents ───────────────────────────────────────────────────────────────

async function agentsView() {
  const main = show('Agenten');
  try {
    const agents = (await client.getJson('/api/agents?namespace=' + NAMESPACE))
        .filter((a) => (a.status ?? 'ACTIVE') === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!agents.length) main.append(el('p', { class: 'error' }, 'Keine aktiven Agenten.'));
    for (const agent of agents) {
      main.append(el('div', {
        class: 'card tappable',
        onclick: () => sessionsView(agent),
      }, el('h3', {}, agent.name), el('p', {}, agent.description ?? '')));
    }
    main.append(el('button', { class: 'ghost', onclick: () => setupView() }, 'Kopplung ändern'));
  } catch (e) {
    main.append(el('p', { class: 'error' }, e.message),
        el('button', { class: 'ghost', onclick: agentsView }, 'Nochmal versuchen'));
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────

async function sessionsView(agent) {
  const main = show(agent.name, agentsView);
  main.append(el('button', {
    class: 'primary',
    onclick: async () => {
      const s = await client.postJson('/api/sessions',
          { agentId: agent.id, namespace: NAMESPACE, userId: store.userId });
      sessionView(agent, s);
    },
  }, 'Neue Session'));
  try {
    const sessions = (await client.getJson('/api/sessions?namespace=' + NAMESPACE
        + '&userId=' + encodeURIComponent(store.userId) + '&agentId=' + agent.id))
        .filter((s) => (s.status ?? 'ACTIVE') === 'ACTIVE')
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    for (const session of sessions) {
      main.append(el('div', {
        class: 'card tappable',
        onclick: () => sessionView(agent, session),
      }, el('h3', {}, session.title ?? 'Session vom ' + (session.startedAt ?? '?').slice(0, 16)),
         el('p', {}, session.id)));
    }
  } catch (e) {
    main.append(el('p', { class: 'error' }, e.message));
  }
}

// ── One session: history, live stream, approval cards, composer ──────────

async function sessionView(agent, session) {
  const main = show(agent.name, () => sessionsView(agent));
  const approvals = el('div', { style: 'display:flex;flex-direction:column;gap:0.75rem' });
  main.append(approvals);

  let streaming = null; // the agent bubble currently receiving tokens
  const openTools = new Map(); // toolName → its line, so the result can tick it off
  const openSubs = new Map(); // agentName → its line
  const scroll = () => main.scrollTo({ top: main.scrollHeight });
  const addBubble = (cls, text) => {
    const b = el('div', { class: 'bubble ' + cls }, text);
    main.insertBefore(b, approvals);
    scroll();
    return b;
  };
  // Agent prose is Markdown; render it (safely) into the bubble.
  const renderAgentMd = (bubble, text) => {
    bubble.classList.add('md');
    bubble.innerHTML = renderMarkdown(text);
    scroll();
  };
  const addAgentBubble = (text) => {
    const b = addBubble('agent', '');
    renderAgentMd(b, text);
    return b;
  };

  // History first — bubbles plus, per turn, which tools ran.
  try {
    for (const m of await client.getJson(`/api/sessions/${session.id}/history`)) {
      if (m.type === 'CHAT') {
        if (m.senderType === 'USER') addBubble('user', m.content ?? '');
        else addAgentBubble(m.content ?? '');
      } else if (m.type === 'TOOL_CALL') {
        try {
          const names = JSON.parse(m.content).toolCalls?.map((c) => c.name) ?? [];
          if (names.length) addBubble('tool', '⚙ ' + names.join(', '));
        } catch { /* unreadable tool payload — skip the row */ }
      }
    }
  } catch (e) {
    addBubble('tool', 'History nicht ladbar: ' + e.message);
  }

  // Open approval cards — the stream announces one only in the moment it
  // is raised, so a client that connects later rebuilds its cards here.
  const renderApproval = (callId, toolName, argsJson) => {
    if (approvals.querySelector(`[data-call="${callId}"]`)) return;
    const answer = async (approved, scope) => {
      try {
        await client.postJson(`/api/sessions/${session.id}/approvals/`
            + encodeURIComponent(callId) + `?approved=${approved}&scope=${scope}`);
      } catch (e) {
        addBubble('tool', e.message);
      }
      card.remove();
    };
    const card = el('div', { class: 'approval' },
        el('h3', {}, 'Freigabe: ' + (toolName ?? '?')),
        argsJson ? el('pre', {}, argsJson) : '',
        el('div', { class: 'actions' },
            el('button', { class: 'primary', onclick: () => answer(true, 'once') }, 'Einmal'),
            el('button', { class: 'ghost', onclick: () => answer(true, 'session') }, 'Für Session'),
            el('button', { class: 'danger', onclick: () => answer(false, 'once') }, 'Ablehnen')));
    card.dataset.call = callId;
    approvals.append(card);
    scroll();
  };
  const refreshApprovals = async () => {
    try {
      for (const a of await client.getJson(`/api/sessions/${session.id}/approvals`)) {
        const call = JSON.parse(a.content ?? '{}');
        renderApproval(a.callId, a.toolName ?? call.name,
            call.arguments ? JSON.stringify(call.arguments, null, 2) : null);
      }
    } catch { /* older server without the endpoint */ }
  };
  await refreshApprovals();

  // The reattach loop. Every event carries a seq — that is the cursor.
  const onEvent = (node) => {
    if (node.type === 'attached') {
      // Events evicted before we came back → the cards may be stale.
      if (node.firstBufferedSeq > store.cursor(session.id) + 1) refreshApprovals();
      return;
    }
    if (node.seq) store.setCursor(session.id, node.seq);
    let ev = node.event ?? node;
    // A sub-agent's own frames arrive wrapped; unwrap and indent them.
    let indented = false;
    if (ev.type === 'sub_agent_event' && ev.inner) { ev = ev.inner; indented = true; }
    const pad = indented ? '      ' : '';
    const durText = (ms) => ms == null ? ''
        : ' · ' + (ms < 1000 ? ms + ' ms' : Math.round(ms / 100) / 10 + ' s');
    switch (ev.type) {
      case 'token':
        // A sub-agent's token stream is noise in the main view — the
        // desktop client drops it too; the → line already shows it works.
        if (indented) break;
        if (!streaming) streaming = addBubble('agent streaming', '');
        streaming.textContent += ev.text ?? '';
        scroll();
        break;
      case 'tool_call_started':
        openTools.set(ev.toolName, addBubble('tool', pad + '⚙ ' + (ev.toolName ?? '?') + ' …'));
        break;
      case 'tool_call_result':
      case 'tool_call_failed': {
        const mark = ev.type === 'tool_call_failed' ? '✗ ' : '✓ ';
        const line = pad + mark + (ev.toolName ?? '?') + durText(ev.durationMs);
        const row = openTools.get(ev.toolName);
        if (row) { row.textContent = line; openTools.delete(ev.toolName); }
        else addBubble('tool', line);
        break;
      }
      case 'sub_agent_started':
        openSubs.set(ev.agentName, addBubble('tool', '→ ' + (ev.agentName ?? 'Sub-Agent') + ' arbeitet …'));
        break;
      case 'sub_agent_done':
      case 'sub_agent_error': {
        const mark = ev.type === 'sub_agent_error' ? '✗ ' : '✓ ';
        const line = mark + (ev.agentName ?? 'Sub-Agent');
        const row = openSubs.get(ev.agentName);
        if (row) { row.textContent = line; openSubs.delete(ev.agentName); }
        else addBubble('tool', line);
        break;
      }
      case 'approval_requested':
        // The server puts the call id in `text`; arguments ride along raw.
        renderApproval(ev.text, ev.toolName,
            ev.arguments ? JSON.stringify(ev.arguments, null, 2) : (ev.argsJson ?? null));
        break;
      case 'done': {
        // Tokens streamed in as plain text; now render the whole turn as
        // Markdown. Prefer the server's finalText, else the accumulated tokens.
        const finalText = (ev.finalText != null && ev.finalText !== '')
            ? ev.finalText : (streaming ? streaming.textContent : '');
        if (streaming) {
          streaming.classList.remove('streaming');
          renderAgentMd(streaming, finalText);
        } else if (finalText) {
          addAgentBubble(finalText);
        }
        streaming = null;
        break;
      }
      case 'error':
        addBubble('tool', '✗ ' + (ev.error ?? 'Fehler'));
        streaming = null;
        break;
    }
  };

  let attachCtrl = null;
  let left = false;
  (async function attachLoop() {
    while (!left) {
      attachCtrl = new AbortController();
      try {
        await client.sse('GET',
            `/api/sessions/${session.id}/stream?afterSeq=${store.cursor(session.id)}`,
            { onEvent, signal: attachCtrl.signal });
      } catch (e) {
        if (left || e.name === 'AbortError') return;
      }
      // Emitter timed out or the tunnel blinked — re-enter with the cursor.
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();

  // Ask the connector to watch this session for push, if push is set up.
  getPushToken().then((fcmToken) => client.postJson('/relay/push/watch',
      { sessionId: session.id, fcmToken }).catch(() => {})).catch(() => {});

  // Composer. The POST /chat response streams the same turn the session
  // stream already delivers — we render from the stream only, so the send
  // is fire-and-forget and duplicates cannot happen.
  const input = el('textarea', { rows: 1, placeholder: 'Nachricht… (Enter sendet, Shift+Enter = Zeile)' });
  const send = () => {
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    addBubble('user', message);
    client.request('POST', `/api/sessions/${session.id}/chat`, { body: message })
        .catch((e) => addBubble('tool', '✗ ' + e.message));
  };
  // Enter sends; Shift+Enter (and Alt/Ctrl+Enter) inserts a newline.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // File upload: multipart to /api/sessions/{id}/files, sent through the
  // tunnel as base64 so binary survives the text-only transport.
  const uploadFile = async (file) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      addBubble('tool', '✗ ' + file.name + ' ist größer als 4 MB');
      return;
    }
    const chip = addBubble('tool', '📎 ' + file.name + ' … lädt');
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const req = new Request('https://x', { method: 'POST', body: fd });
      const contentType = req.headers.get('content-type'); // multipart/…; boundary=…
      const bodyBase64 = bytesToBase64(new Uint8Array(await req.arrayBuffer()));
      const { status } = await client.request('POST',
          `/api/sessions/${session.id}/files`, { bodyBase64, contentType });
      chip.textContent = Math.floor(status / 100) === 2
          ? '📎 ' + file.name + ' ✓ (im Workspace verfügbar)'
          : '📎 ' + file.name + ' ✗ (' + status + ')';
    } catch (e) {
      chip.textContent = '📎 ' + file.name + ' ✗ ' + e.message;
    }
  };
  const fileInput = el('input', { type: 'file' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files) uploadFile(f);
    fileInput.value = '';
  });
  const attachButton = el('button', {
    class: 'ghost attach', title: 'Datei anhängen', onclick: () => fileInput.click(),
  }, '📎');

  const composer = el('div', { class: 'composer' }, attachButton, input, fileInput,
      el('button', { class: 'primary', onclick: send }, 'Senden'));
  document.body.append(composer);
  scroll();

  leaveView = () => {
    left = true;
    attachCtrl?.abort();
    composer.remove();
  };
}

// ── Boot ─────────────────────────────────────────────────────────────────

/** WS relay only: redeem the pairing code for a device token. The RTDB
 *  transport is codeless — its store.pairing is set before sign-in. */
async function completePairing(mode, codeValue, relayUrlValue) {
  const result = await pair(relayUrlValue, codeValue);
  store.pairing = { mode, relayUrl: relayUrlValue.replace(/\/$/, ''), ...result };
}

/** "Zum Home-Bildschirm / installieren". Chromium fires beforeinstallprompt
 *  and we defer it to our own button; iOS Safari has no such event, so there
 *  we show the manual Share-sheet hint instead. */
function setupInstall() {
  const $install = document.getElementById('install');
  if (!$install) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  if (standalone) return; // already installed
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $install.hidden = false;
  });
  window.addEventListener('appinstalled', () => { $install.hidden = true; });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos) {
    $install.hidden = false; // no prompt event on iOS — offer instructions
  }
  $install.onclick = async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      $install.hidden = true;
    } else if (isIos) {
      alert('Installieren: unten auf „Teilen“ tippen → „Zum Home-Bildschirm“.');
    }
  };
}

function boot() {
  initPush();
  setupInstall();
  // The RTDB sign-in redirect returns here: store.pairing was persisted
  // before the redirect, so start() just reconnects (now signed in).
  start();
}

async function start() {
  const pairing = store.pairing;
  const paired = pairing?.mode === 'rtdb' ? pairing.serverId : pairing?.deviceToken;
  if (!paired) {
    setupView();
    return;
  }
  client?.close();
  client = pairing.mode === 'rtdb'
      ? new RtdbClient(pairing.serverId)
      : new RelayClient(pairing.relayUrl, pairing.deviceToken);
  client.onstate = (s) => { $state.className = 'state ' + s; };
  try {
    await client.connect();
    // First 'connected'/presence signal before the first request.
    await Promise.race([client.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Keine Verbindung zum Tunnel.')), 10000))]);
    agentsView();
  } catch (e) {
    setupView(e.message);
  }
}

boot();
