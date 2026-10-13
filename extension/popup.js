// Helm popup: live status + inline settings (no options page needed).
//
// The Supabase URL + anon key are PUBLIC (the anon key is already exposed in
// deployed web apps), so they are written as defaults on save. The secret
// token is NEVER pre-filled.

const DEFAULT_RELAY_URL = "https://helm-relay.vercel.app";
const DEFAULT_ALLOWLIST = ["wikipedia.org", "google.com"];
const DEFAULT_SUPABASE_URL = "https://udbitfhowopevixiulhu.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYml0Zmhvd29wZXZpeGl1bGh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MDA0NDIsImV4cCI6MjEwNzI3NjQ0Mn0.i_rNKbvDP4BjG7NxYn52Aa144QD2UHsJBcUHk3VxBHI";

async function loadState() {
  chrome.runtime.sendMessage({ type: "helm-state" }, (state) => {
    if (!state) return;
    document.getElementById("mode").textContent = state.mode || "—";
    document.getElementById("poll").textContent = state.lastPoll
      ? new Date(state.lastPoll).toLocaleTimeString()
      : "—";
    document.getElementById("cmd").textContent = state.lastCommand || "—";
    document.getElementById("err").textContent = state.lastError || "";
    if (!state.lastError) document.getElementById("dot").classList.add("on");
  });
}

async function loadSettings() {
  // Effective config from the worker: storage overrides baked-in config.js.
  const cfg = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "helm-get-config" }, (res) => {
      resolve((res && res.config) || {});
    });
  });
  const inst = cfg.instance || {};
  document.getElementById("instance").textContent =
    inst.id ? `${inst.name || "Browser"} (${inst.id})` : "—";
  document.getElementById("token").value = cfg.token || "";
  document.getElementById("relayUrl").value = cfg.relayUrl || DEFAULT_RELAY_URL;
  document.getElementById("modeSel").value =
    cfg.mode === "realtime" ? "realtime" : "poll";
  const list =
    Array.isArray(cfg.blocklist) && cfg.blocklist.length
      ? cfg.blocklist
      : DEFAULT_ALLOWLIST;
  document.getElementById("blocklist").value = list.join("\n");
}

document.getElementById("save").addEventListener("click", async () => {
  const token = document.getElementById("token").value.trim();
  if (token && token.length < 16) {
    document.getElementById("err").textContent =
      "Token must be at least 16 characters.";
    return;
  }
  const relayUrl = document.getElementById("relayUrl").value.trim() || DEFAULT_RELAY_URL;
  const mode = document.getElementById("modeSel").value;
  const blocklist = document
    .getElementById("blocklist")
    .value.split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  await chrome.storage.local.set({
    token,
    relayUrl: relayUrl.replace(/\/+$/, ""),
    mode,
    blocklist,
    // Public defaults — written so realtime mode works without the options page.
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
  });
  document.getElementById("err").textContent = "";
  const el = document.getElementById("saved");
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 1500);
  loadState();
});

loadState();
loadSettings();
