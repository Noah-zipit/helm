// Helm v0.4.0 service worker — worker-only architecture.
//
// Everything runs here: config, realtime WebSocket, HTTP fallback poll,
// command execution, result reporting. No offscreen document — some
// Chromium forks (notably modded mobile builds) never run offscreen
// pages, so Helm no longer depends on one.
import { executeCommand } from "./executor.js";
import { HELM_CONFIG } from "./config.js";

const POLL_MS = 2000;
const FALLBACK_POLL_MS = 15000;
const HEARTBEAT_MS = 25000;
const PRESENCE_MS = 25000;
const RECONNECT_BASE_MS = 3000;
const SEEN_CAP = 200;
const EXEC_TIMEOUT_MS = 25000;
const VERSION = "0.5.1";

// --- state (the popup reads this) ---
const state = {
  mode: "poll",
  lastPoll: null,
  lastCommand: null,
  lastError: null,
  tokenHint: null,
  instance: null,
};
function setState(patch) {
  Object.assign(state, patch);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- config: storage overrides baked-in config.js ---
async function ensureInstance() {
  const s = await chrome.storage.local.get(["instanceId", "instanceName"]);
  if (s.instanceId) return { id: s.instanceId, name: s.instanceName || "Browser" };
  const id = (
    (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) ||
    Math.random().toString(16).slice(2, 10)
  ).toLowerCase();
  let name = "Browser";
  try {
    if (navigator.userAgentData && navigator.userAgentData.platform) {
      name = navigator.userAgentData.platform;
    } else {
      const m = navigator.userAgent.match(/Android|Windows|Mac OS X|Linux|iPhone|iPad/);
      if (m) name = m[0].replace("Mac OS X", "macOS");
    }
  } catch {
    /* keep default */
  }
  await chrome.storage.local.set({ instanceId: id, instanceName: name });
  return { id, name };
}

async function readConfig() {
  const c = await chrome.storage.local.get([
    "relayUrl",
    "token",
    "mode",
    "supabaseUrl",
    "supabaseAnonKey",
    "allowlist",
  ]);
  const pick = (k) => {
    const v = c[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.length) return v;
    return HELM_CONFIG[k];
  };
  const instance = await ensureInstance();
  const token = String(pick("token") || "");
  setState({
    tokenHint: token ? "…" + token.slice(-6) : null,
    instance: instance.id ? `${instance.name} (${instance.id})` : null,
  });
  return {
    relayUrl: String(pick("relayUrl") || "").replace(/\/+$/, ""),
    token,
    mode: pick("mode") === "realtime" ? "realtime" : "poll",
    supabaseUrl: String(pick("supabaseUrl") || "").replace(/\/+$/, ""),
    supabaseAnonKey: String(pick("supabaseAnonKey") || ""),
    allowlist: Array.isArray(pick("allowlist")) ? pick("allowlist") : [],
    instance,
  };
}

// --- dedupe: broadcast + poll can deliver the same command twice ---
const seenIds = [];
const seenSet = new Set();
function markSeen(id) {
  if (typeof id !== "string" || id === "") return false;
  if (seenSet.has(id)) return false;
  seenSet.add(id);
  seenIds.push(id);
  while (seenIds.length > SEEN_CAP) seenSet.delete(seenIds.shift());
  return true;
}

// --- relay HTTP ---
async function api(c, path, opts, timeoutMs) {
  const sep = path.includes("?") ? "&" : "?";
  const url = c.relayUrl + path + sep + "token=" + encodeURIComponent(c.token);
  let o = opts;
  if (timeoutMs && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    o = { ...(opts || {}), signal: AbortSignal.timeout(timeoutMs) };
  }
  const res = await fetch(url, o);
  if (!res.ok) throw new Error("relay HTTP " + res.status);
  return res.json();
}

// Long-poll the relay queue: the request stays open until a command lands
// or the relay's wait budget ends, so pickup is near-instant over plain
// HTTP — no dependence on the realtime socket at all.
const LONGPOLL_WAIT_S = 8;
async function pollQueue(c) {
  return api(c, `/api/poll?wait=${LONGPOLL_WAIT_S}`, {}, (LONGPOLL_WAIT_S + 6) * 1000);
}

// --- minimal Phoenix-channels client for Supabase Realtime broadcast ---
let rtSend = null; // (result) => void — set while the socket is open
function openRealtime(c, topic, onCommand, isCurrent) {
  const base = c.supabaseUrl
    .replace(/\/+$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  const url =
    base +
    "/realtime/v1/websocket?apikey=" +
    encodeURIComponent(c.supabaseAnonKey) +
    "&vsn=1.0.0";
  let ws = null;
  let ref = 0;
  let closed = false;
  let retryMs = RECONNECT_BASE_MS;
  let hb = null;

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function schedule() {
    if (closed || !isCurrent()) return;
    setState({ lastError: "realtime disconnected — retrying" });
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 30000);
    setTimeout(() => {
      if (!closed && isCurrent()) connect();
    }, wait);
  }
  function connect() {
    if (closed || !isCurrent()) return;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (!isCurrent()) {
        try {
          sock.close();
        } catch {
          /* already gone */
        }
        return;
      }
      retryMs = RECONNECT_BASE_MS;
      setState({ lastError: null });
      send({
        topic,
        event: "phx_join",
        ref: String(++ref),
        payload: { config: { broadcast: { ack: false } } },
      });
      if (hb) clearInterval(hb);
      hb = setInterval(() => {
        if (isCurrent()) {
          send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) });
        }
      }, HEARTBEAT_MS);
    };
    sock.onmessage = (ev) => {
      if (!isCurrent()) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || msg.topic !== topic || msg.event !== "broadcast") return;
      const p = msg.payload || {};
      if (p.event === "helm-command" && p.payload) onCommand(p.payload);
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* onclose handles the retry */
      }
    };
    sock.onclose = () => {
      if (hb) {
        clearInterval(hb);
        hb = null;
      }
      if (ws === sock) ws = null;
      schedule();
    };
  }
  connect();
  return {
    sendResult(result) {
      send({
        topic,
        event: "broadcast",
        ref: String(++ref),
        payload: { event: "helm-result", payload: result },
      });
    },
    sendPresence(info) {
      send({
        topic,
        event: "broadcast",
        ref: String(++ref),
        payload: { event: "helm-presence", payload: info },
      });
    },
    close() {
      closed = true;
      if (hb) clearInterval(hb);
      try {
        if (ws) ws.close();
      } catch {
        /* already gone */
      }
      ws = null;
    },
  };
}

// --- result reporting: realtime broadcast first, HTTP relay second ---
async function postResult(c, result) {
  const errors = [];
  if (rtSend) {
    try {
      rtSend(result);
    } catch (e) {
      errors.push(e);
    }
  }
  if (c.relayUrl && c.token) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api(c, "/api/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: c.token, result }),
        });
        return;
      } catch (e) {
        if (attempt === 3) errors.push(e);
        else await sleep(1000 * (attempt + 1));
      }
    }
  } else if (!rtSend) {
    errors.push(new Error("no result path configured"));
  }
  if (errors.length) throw errors[0];
}

// --- execute one command, always post exactly one result ---
// The timeout is critical: a hung chrome.* call must never stall the
// serialized chain forever. On timeout we post {ok:false} and move on.
let cmdChain = Promise.resolve(); // serialize: never drive chrome.* concurrently
async function executeAndReport(c, cmd) {
  setState({ lastCommand: cmd.type + " " + (cmd.id || "") });
  await setBadge("●");
  let result;
  try {
    const data = await Promise.race([
      executeCommand(chrome, { type: cmd.type, args: cmd.args }, c.allowlist),
      sleep(EXEC_TIMEOUT_MS).then(() => {
        throw new Error(`command timed out after ${EXEC_TIMEOUT_MS / 1000}s`);
      }),
    ]);
    result = { id: cmd.id, ...data };
  } catch (e) {
    result = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
  }
  if (!result || typeof result !== "object") {
    result = { id: cmd.id, ok: false, error: "internal error building result" };
  }
  if (!result.id) result.id = cmd.id;
  result.at = Date.now();
  result.instance = { id: c.instance.id, name: c.instance.name };
  try {
    await postResult(c, result);
  } catch (e) {
    setState({ lastError: "result lost: " + String((e && e.message) || e) });
  }
  await setBadge("");
  return result;
}

async function setBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
  } catch {
    /* badge is best-effort */
  }
}

// --- HTTP presence heartbeat ---
// Realtime presence only exists while the socket is open, and some browsers
// never let the socket connect. So the instance also announces itself over
// plain HTTP: a "__presence" pseudo-command on the relay queue (the relay
// exposes the latest ones at /api/presence). Intake filters "__" types out
// below — they are channel traffic, never commands to execute.
let lastPresenceAt = 0;
async function announcePresence(c, force) {
  const now = Date.now();
  if (!force && now - lastPresenceAt < PRESENCE_MS) return;
  lastPresenceAt = now;
  if (!c.relayUrl || !c.token) return;
  try {
    await api(c, "/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: c.token,
        command: {
          id: "pres-" + c.instance.id,
          type: "__presence",
          instance: { id: c.instance.id, name: c.instance.name },
          version: VERSION,
        },
      }),
    });
  } catch {
    lastPresenceAt = 0; // retry on the next cycle
  }
}

function isChannelTraffic(cmd) {
  return !!cmd && typeof cmd.type === "string" && cmd.type.startsWith("__");
}

// --- loops ---
let generation = 0;
let loopsActive = false;

async function pollLoop(gen, c) {
  while (gen === generation) {
    if (!c.relayUrl || !c.token) {
      setState({ lastError: "not configured" });
      await sleep(POLL_MS);
      continue;
    }
    setState({ mode: "poll" });
    try {
      const res = await pollQueue(c);
      setState({ lastPoll: new Date().toISOString(), lastError: null });
      announcePresence(c, false);
      for (const cmd of res.commands || []) {
        if (gen !== generation) return;
        if (!cmd || isChannelTraffic(cmd) || !markSeen(cmd.id)) continue;
        if (cmd.target && cmd.target !== c.instance.id) continue;
        cmdChain = cmdChain.then(() => (gen === generation ? executeAndReport(c, cmd) : null));
        await cmdChain;
      }
      // The long-poll already paced us; re-ask almost immediately.
      await sleep(250);
    } catch (e) {
      setState({ lastError: String((e && e.message) || e) });
      await sleep(POLL_MS);
    }
  }
}

async function realtimeLoop(gen, c) {
  setState({ mode: "realtime" });
  const topic = "realtime:helm-" + c.token;
  const isCurrent = () => gen === generation;
  const queueCommand = (cmd) => {
    if (!isCurrent()) return;
    if (!cmd || isChannelTraffic(cmd) || !markSeen(cmd.id)) return;
    if (cmd.target && cmd.target !== c.instance.id) return;
    cmdChain = cmdChain
      .then(() => (isCurrent() ? executeAndReport(c, cmd) : null))
      .catch(() => {
        /* executeAndReport never throws; belt and braces */
      });
  };
  const sock = openRealtime(c, topic, queueCommand, isCurrent);
  rtSend = (result) => sock.sendResult(result);
  const presence = () => {
    try {
      sock.sendPresence({ id: c.instance.id, name: c.instance.name, version: VERSION, at: Date.now() });
    } catch {
      /* best-effort */
    }
    // HTTP heartbeat too: visible at /api/presence even if the socket
    // never connects from this browser.
    announcePresence(c, false);
  };
  presence();
  announcePresence(c, true);
  let lastPresenceCall = Date.now();
  try {
    // Fallback drain, now a continuous long-poll: when the socket is dead
    // (the common case on his browsers) commands still land within about
    // a second; when the socket is live, broadcasts beat the drain to it
    // and the drain simply finds an empty queue.
    while (isCurrent()) {
      if (Date.now() - lastPresenceCall >= PRESENCE_MS) {
        lastPresenceCall = Date.now();
        presence();
      }
      if (c.relayUrl && c.token) {
        try {
          const res = await pollQueue(c);
          setState({ lastPoll: new Date().toISOString() });
          for (const cmd of res.commands || []) {
            if (!isCurrent()) break;
            queueCommand(cmd);
          }
        } catch (e) {
          setState({ lastError: "fallback poll: " + String((e && e.message) || e) });
          await sleep(2000);
        }
      } else {
        await sleep(FALLBACK_POLL_MS);
      }
    }
  } finally {
    rtSend = null;
    sock.close();
  }
}

async function startLoops() {
  const gen = ++generation;
  loopsActive = true;
  rtSend = null;
  const c = await readConfig();
  if (!c.token) {
    loopsActive = false;
    setState({ lastError: "not configured" });
    return;
  }
  // If a loop ever dies outright, clear the flag so the keepalive alarm
  // can resurrect it instead of assuming all is well.
  const onLoopDeath = () => {
    if (gen === generation) loopsActive = false;
  };
  if (c.mode === "realtime" && c.supabaseUrl && c.supabaseAnonKey) {
    realtimeLoop(gen, c).catch(onLoopDeath);
  } else {
    pollLoop(gen, c).catch(onLoopDeath);
  }
}

// --- messages: popup / options page ---
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === "helm-get-config") {
    readConfig().then((config) => reply({ type: "helm-config", config }));
    return true;
  }
  if (msg.type === "helm-state") {
    reply({ ...state });
    return false;
  }
  return false;
});

// Config change: restart loops with the new config.
chrome.storage.onChanged.addListener(() => {
  startLoops().catch(() => {});
});

// --- lifecycle: no offscreen document anymore ---
chrome.runtime.onStartup.addListener(() => startLoops().catch(() => {}));
chrome.runtime.onInstalled.addListener((details) => {
  startLoops().catch(() => {});
  if (details.reason === "install" || details.reason === "update") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }).catch(() => {});
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  // Resurrect only a dead loop. Restarting healthy loops every minute
  // would tear down the realtime socket and churn presence for nothing —
  // a live loop in this worker lifetime leaves loopsActive set.
  if (alarm.name === "helm-keepalive" && !loopsActive) {
    startLoops().catch(() => {});
  }
});

(async () => {
  await startLoops().catch(() => {});
  try {
    await chrome.alarms.create("helm-keepalive", { periodInMinutes: 1 });
  } catch {
    /* alarms unavailable; onStartup/onInstalled still cover restarts */
  }
})();
