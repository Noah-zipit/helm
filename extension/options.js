// Helm options page: relay URL, transport, Supabase v2 settings, token, allowlist.
//
// The Supabase URL + anon key are PUBLIC (the anon key is already exposed in
// deployed web apps), so they ship as defaults. The secret token is NEVER
// pre-filled — it must be entered by hand.
const DEFAULT_SUPABASE_URL = "https://udbitfhowopevixiulhu.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYml0Zmhvd29wZXZpeGl1bGh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MDA0NDIsImV4cCI6MjEwNzI3NjQ0Mn0.i_rNKbvDP4BjG7NxYn52Aa144QD2UHsJBcUHk3VxBHI";

const FIELDS = ["relayUrl", "mode", "supabaseUrl", "supabaseAnonKey", "token"];

async function load() {
  // Effective config from the worker: storage overrides baked-in config.js.
  const cfg = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "helm-get-config" }, (res) => {
      resolve((res && res.config) || {});
    });
  });
  const F = { relayUrl: cfg.relayUrl, mode: cfg.mode, token: cfg.token,
    supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.supabaseAnonKey };
  for (const f of FIELDS) {
    document.getElementById(f).value = F[f] || "";
  }
  document.getElementById("allowlist").value = (cfg.allowlist || []).join("\n");
  const inst = cfg.instance || {};
  document.getElementById("instanceId").textContent =
    inst.id ? `${inst.name || "Browser"} (${inst.id})` : "not generated yet";
}

document.getElementById("save").addEventListener("click", async () => {
  const token = document.getElementById("token").value.trim();
  if (token && token.length < 16) {
    alert("Token must be at least 16 characters (32+ recommended).");
    return;
  }
  const mode = document.getElementById("mode").value;
  if (mode === "realtime") {
    const u = document.getElementById("supabaseUrl").value.trim();
    const k = document.getElementById("supabaseAnonKey").value.trim();
    if (!u || !k) {
      alert("Realtime mode needs the Supabase URL and anon key.");
      return;
    }
  }
  const allowlist = document
    .getElementById("allowlist")
    .value.split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const data = { allowlist };
  for (const f of FIELDS) data[f] = document.getElementById(f).value.trim();
  await chrome.storage.local.set(data);
  const el = document.getElementById("saved");
  el.style.display = "inline";
  setTimeout(() => (el.style.display = "none"), 1500);
});

load();
