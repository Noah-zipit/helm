// Helm relay on Vercel + Supabase. Same contract as relay/worker.js:
// token via body/query/x-bc-token header, 401 if token < 16 chars,
// drain-on-read, 50-command / 100-result caps, per-token namespacing.
// Storage: Supabase table helm_messages (token, kind 'cmd'|'res', payload).
// Plain fetch only, no dependencies.

const CMD_CAP = 50;
const RES_CAP = 100;

function json(res, data, status = 200) {
  // CORS: the Helm Commander website calls this relay from the browser.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-bc-token");
  res.status(status).json(data);
}

function sb(path, key) {
  // Minimal Supabase REST helper (service-role key, server-side only).
  const base = process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
  return async (method, query = "", body) => {
    const r = await fetch(base + path + query, {
      method,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

function getToken(req) {
  const b = req.body;
  if (b && typeof b.token === "string" && b.token) return b.token;
  if (typeof req.query.token === "string" && req.query.token) return req.query.token;
  return req.headers["x-bc-token"] || "";
}

async function trimCap(call, token, kind, cap) {
  const rows = await call("GET", `?token=eq.${token}&kind=eq.${kind}&select=id&order=created_at.desc&limit=${cap + 50}`);
  if (rows.length > cap) {
    const extra = rows.slice(cap).map((r) => r.id);
    await call("DELETE", `?id=in.(${extra.join(",")})`);
  }
}

export default async function handler(req, res) {
  const route = req.query.route;

  // CORS preflight for browser clients (Helm Commander website).
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-bc-token");
    return res.status(204).end();
  }

  if (route === "health") {
    return json(res, { ok: true, service: "browser-controller-relay" });
  }

  const token = getToken(req);
  if (!token || token.length < 16) {
    return json(res, { ok: false, error: "missing or invalid token" }, 401);
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return json(res, { ok: false, error: "relay not configured" }, 500);
  const call = sb("/helm_messages", key);

  try {
    if (route === "command" && req.method === "POST") {
      const cmd = req.body && req.body.command;
      if (!cmd || typeof cmd.type !== "string" || typeof cmd.id !== "string") {
        return json(res, { ok: false, error: "body.command must include id and type" }, 400);
      }
      cmd.receivedAt = Date.now();
      await call("POST", "", { token, kind: "cmd", payload: cmd });
      await trimCap(call, token, "cmd", CMD_CAP);
      return json(res, { ok: true, id: cmd.id });
    }

    if (route === "poll" && req.method === "GET") {
      // Long-poll: ?wait=<seconds> holds the request open, re-checking the
      // queue about once a second, until a command lands or the budget runs
      // out (capped at 8s to stay inside the function duration limit). This
      // is what makes command pickup feel instant over plain HTTP.
      const waitCap = Math.min(8, Math.max(0, Number(req.query.wait) || 0));
      const deadline = Date.now() + waitCap * 1000;
      for (;;) {
        const rows = await call("GET", `?token=eq.${token}&kind=eq.cmd&select=id,payload&order=created_at.asc`);
        // Presence heartbeats share this table but are NOT commands: never
        // hand them to a poller and never drain them here — /api/presence
        // reads them, instances re-post every ~25s, and trimCap keeps the
        // table bounded. (Draining them made presence vanish within seconds
        // of being posted, because the poller itself ate the row.)
        const cmds = rows.filter((r) => !(r.payload && r.payload.type === "__presence"));
        if (cmds.length) {
          await call("DELETE", `?id=in.(${cmds.map((r) => r.id).join(",")})`);
          return json(res, { ok: true, commands: cmds.map((r) => r.payload) });
        }
        if (Date.now() >= deadline) {
          return json(res, { ok: true, commands: [] });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (route === "result" && req.method === "POST") {
      const r = req.body && req.body.result;
      if (!r || typeof r.id !== "string") {
        return json(res, { ok: false, error: "body.result must include id" }, 400);
      }
      r.at = Date.now();
      await call("POST", "", { token, kind: "res", payload: r });
      await trimCap(call, token, "res", RES_CAP);
      return json(res, { ok: true, id: r.id });
    }

    if (route === "results" && req.method === "GET") {
      const rows = await call("GET", `?token=eq.${token}&kind=eq.res&select=payload&order=created_at.asc`);
      await call("DELETE", `?token=eq.${token}&kind=eq.res`);
      return json(res, { ok: true, results: rows.map((r) => r.payload) });
    }

    if (route === "brain" && req.method === "POST") {
      // Helm Brain: turn a plain-language task into a validated plan of
      // extension commands, planned by NVIDIA NIM. The API key lives ONLY
      // in this project's server-side env — never in the client bundle.
      const nimKey = process.env.NVIDIA_NIM_API_KEY;
      if (!nimKey) return json(res, { ok: false, error: "brain not configured" }, 500);
      const task = String((req.body && req.body.task) || "").slice(0, 500).trim();
      if (!task) return json(res, { ok: false, error: "missing task" }, 400);
      const tabsIn = Array.isArray(req.body && req.body.tabs) ? req.body.tabs.slice(0, 20) : [];
      const tabCtx = tabsIn
        .map((t) => `- tabId ${t.tabId}: "${String(t.title || "").slice(0, 60)}" ${String(t.url || "").slice(0, 90)}${t.active ? " (active)" : ""}`)
        .join("\n");
      const system = [
        "You are Helm Brain, the planner for a browser-control system.",
        "Convert the user's task into a JSON plan of browser commands.",
        'Output ONLY JSON, no prose, no code fences: {"note": "<one short sentence>", "steps": [{"type": "...", "args": {...}}]}',
        "Available commands:",
        "- listTabs {}",
        "- openTab {url}",
        "- search {query} (opens a Google search in a new tab)",
        "- navigate {tabId, url}",
        "- click {tabId, selector}",
        "- type {tabId, selector, text}",
        "- pressEnter {tabId}",
        "- readText {tabId}",
        "- screenshot {tabId} (tabId optional)",
        "- waitFor {tabId, selector, timeoutMs}",
        "- fillForm {tabId, fields: [{selector, value}], submit}",
        "- closeTab {tabId}",
        "Rules:",
        "- At most 6 steps.",
        '- A tab opened by openTab or search is referenced later as tabId "$new".',
        "- Existing tabs are listed below; reference them by their numeric tabId.",
        '- "search" only searches Google. It never opens a specific site and never plays media.',
        "- To open or play something on a named site, open that site's own search URL with openTab, then waitFor a result link, then click the first result.",
        '- Use stable CSS selectors: ids, aria-labels, or href patterns such as a[href*="watch?v="].',
        "- If the task asks about the current page, use readText on the active tab.",
        "- When opening a site's search page, put the query IN the URL whenever the site supports it (for example ?q=term, ?search=term, &udm=).",
        "- Once a click opens or starts the thing the user asked for, STOP. Never add verification, confirmation, or cleanup steps after it.",
        'Example — task "play despacito on youtube music":',
        '{"note": "Play Despacito on YouTube Music", "steps": [',
        '  {"type": "openTab", "args": {"url": "https://music.youtube.com/search?q=Despacito"}},',
        '  {"type": "waitFor", "args": {"tabId": "$new", "selector": "a[href*=\\"watch?v=\\"]", "timeoutMs": 15000}},',
        '  {"type": "click", "args": {"tabId": "$new", "selector": "ytmusic-responsive-list-item-renderer a[href*=\\"watch?v=\\"]"}}',
        "]}",
        'Existing tabs:\n' + (tabCtx || "(none reported)"),
      ].join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let nimRes;
      try {
        nimRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + nimKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "meta/llama-3.2-11b-vision-instruct",
            temperature: 0.2,
            max_tokens: 900,
            messages: [
              { role: "system", content: system },
              { role: "user", content: task },
            ],
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!nimRes.ok) {
        const t = await nimRes.text();
        return json(res, { ok: false, error: `brain upstream ${nimRes.status}: ${t.slice(0, 160)}` }, 502);
      }
      const nimBody = await nimRes.json();
      const raw = (((nimBody.choices || [])[0] || {}).message || {}).content || "";
      let plan = null;
      try {
        let cleaned = raw.replace(/```json|```/g, "").trim();
        const s = cleaned.indexOf("{");
        const e = cleaned.lastIndexOf("}");
        cleaned = cleaned.slice(s, e + 1);
        try {
          plan = JSON.parse(cleaned);
        } catch {
          // Small models sometimes emit the JSON double-escaped (literal
          // \" sequences). Unescape one layer and parse again.
          plan = JSON.parse(cleaned.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        }
        if (typeof plan === "string") plan = JSON.parse(plan);
      } catch {
        return json(res, { ok: false, error: "brain returned an unreadable plan", raw: raw.slice(0, 300) }, 502);
      }
      const ALLOWED = new Set([
        "listTabs", "openTab", "search", "navigate", "click", "type",
        "pressEnter", "readText", "screenshot", "waitFor", "fillForm", "closeTab",
      ]);
      const steps = [];
      for (const st of Array.isArray(plan.steps) ? plan.steps.slice(0, 6) : []) {
        if (!st || !ALLOWED.has(st.type)) continue;
        const args = st.args && typeof st.args === "object" && !Array.isArray(st.args) ? st.args : {};
        // Models love quoting numbers; the extension wants a real integer
        // tabId ("$new" is the one string allowed through).
        if (typeof args.tabId === "string" && /^\d+$/.test(args.tabId)) {
          args.tabId = Number(args.tabId);
        }
        steps.push({ type: st.type, args });
      }
      if (!steps.length) {
        return json(res, { ok: false, error: "brain produced no usable steps", raw: raw.slice(0, 300) }, 502);
      }
      return json(res, { ok: true, note: String(plan.note || ""), steps });
    }

    if (route === "presence" && req.method === "GET") {
      // Latest "__presence" heartbeat per instance, read WITHOUT draining —
      // extensions re-announce every ~25s, so a drained row is back within
      // one cycle. Entries older than 120s count as offline.
      const rows = await call("GET", `?token=eq.${token}&kind=eq.cmd&select=payload,created_at&order=created_at.desc&limit=50`);
      const byId = new Map();
      for (const r of rows) {
        const p = r.payload;
        if (!p || p.type !== "__presence" || !p.instance || typeof p.instance.id !== "string") continue;
        if (!byId.has(p.instance.id)) {
          byId.set(p.instance.id, {
            id: p.instance.id,
            name: p.instance.name || "Browser",
            version: p.version || "",
            at: p.receivedAt || Date.parse(r.created_at) || 0,
          });
        }
      }
      const now = Date.now();
      const instances = [...byId.values()].filter((i) => now - i.at < 120000);
      return json(res, { ok: true, instances });
    }

    return json(res, { ok: false, error: "not found" }, 404);
  } catch (e) {
    // Table missing (first run) or Supabase hiccup: say so plainly.
    return json(res, { ok: false, error: String(e.message || e) }, 502);
  }
}
