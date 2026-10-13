// Helm command executor. Pure dispatch over an injected `chrome` object, so the
// same code runs in the extension and in node tests with stubs.
// Every command returns { ok, ... } or { ok: false, error }.

export function isInternalUrl(url) {
  return /^(chrome|chrome-extension|edge|about|view-source):/.test(url || "");
}

// Exclude-list semantics: every http(s) host is allowed EXCEPT hosts on the
// blocklist (a blocked entry also covers its subdomains). Empty = allow all.
export function hostAllowed(url, blocklist) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!blocklist || blocklist.length === 0) return true;
  const blocked = blocklist.some((d) => {
    d = String(d).toLowerCase().trim().replace(/^\*\./, "");
    return d !== "" && (host === d || host.endsWith("." + d));
  });
  return !blocked;
}

// --- page-side functions: serialized into the tab, so they may only use
// tab globals (document, location, Event, KeyboardEvent). No closures. ---

function pageClick(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: "no such element: " + sel };
  el.click();
  return { ok: true };
}

function pageType(sel, text) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: "no such element: " + sel };
  el.focus();
  if ("value" in el) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    return { ok: false, error: "element is not editable: " + sel };
  }
  return { ok: true };
}

function pagePressEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
  );
  const form = el.closest ? el.closest("form") : null;
  if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  return { ok: true };
}

function pageReadText() {
  const body = document.body ? document.body.innerText : "";
  return {
    ok: true,
    url: location.href,
    title: document.title,
    text: (body || "").slice(0, 20000),
  };
}

function pageHas(sel) {
  return { ok: true, found: !!document.querySelector(sel) };
}

function pageFillForm(fields, submitSel) {
  // Native setters bypass React/Vue value tracking so frameworks see the
  // change; input+change events cover plain listeners.
  function setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (desc && typeof desc.set === "function") desc.set.call(el, value);
    else el.value = value;
  }
  function setNativeChecked(el, checked) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "checked");
    if (desc && typeof desc.set === "function") desc.set.call(el, checked);
    else el.checked = checked;
  }
  let filled = 0;
  const errors = [];
  for (const f of fields || []) {
    if (!f || !f.selector) {
      errors.push("field missing selector");
      continue;
    }
    const el = document.querySelector(f.selector);
    if (!el) {
      errors.push("no such element: " + f.selector);
      continue;
    }
    try {
      el.focus();
    } catch (e) {
      /* focus is best-effort */
    }
    const t = (el.type || "").toLowerCase();
    if (t === "checkbox" || t === "radio") {
      setNativeChecked(el, !!f.value);
    } else if ("value" in el) {
      setNativeValue(el, String(f.value == null ? "" : f.value));
    } else if (el.isContentEditable) {
      el.textContent = String(f.value == null ? "" : f.value);
    } else {
      errors.push("element is not editable: " + f.selector);
      continue;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled++;
  }
  if (submitSel) {
    const btn = document.querySelector(submitSel);
    if (!btn) {
      return { ok: false, filled, errors, error: "no such submit element: " + submitSel };
    }
    btn.click();
  }
  return { ok: true, filled, errors };
}

// The console hook must run in the page's MAIN world to wrap the page's own
// console calls. Messages logged before this is injected are missed.
function pageInstallConsoleHook() {
  if (window.__helmConsoleHooked) return { ok: true, already: true };
  try {
    window.__helmConsoleHooked = true;
    window.__helmConsole = [];
    const levels = ["log", "info", "warn", "error", "debug"];
    for (const level of levels) {
      const orig = console[level] ? console[level].bind(console) : null;
      console[level] = function () {
        try {
          const args = Array.prototype.slice.call(arguments);
          window.__helmConsole.push({
            level,
            text: args
              .map((a) => {
                try {
                  return typeof a === "string" ? a : JSON.stringify(a);
                } catch (e) {
                  return String(a);
                }
              })
              .join(" "),
            at: Date.now(),
          });
          if (window.__helmConsole.length > 200) {
            window.__helmConsole.splice(0, window.__helmConsole.length - 200);
          }
        } catch (e) {
          /* never break the page's logging */
        }
        if (orig) return orig.apply(null, arguments);
      };
    }
  } catch (e) {
    return { ok: false, error: "hook install failed: " + String((e && e.message) || e) };
  }
  return { ok: true };
}

function pageReadConsole(limit) {
  const all = Array.isArray(window.__helmConsole) ? window.__helmConsole : [];
  return {
    ok: true,
    hooked: !!window.__helmConsoleHooked,
    messages: all.slice(-limit),
  };
}

async function runInTab(chrome, tabId, func, args, world) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
    ...(world ? { world } : {}),
  });
  const first = results && results[0];
  return first && first.result
    ? first.result
    : { ok: false, error: "no result from tab" };
}

export async function executeCommand(chrome, cmd, blocklist) {
  const type = cmd && cmd.type;
  const args = (cmd && cmd.args) || {};

  async function getTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return { ok: false, error: "no such tab: " + tabId };
      return { tab };
    } catch {
      return { ok: false, error: "no such tab: " + tabId };
    }
  }

  // Tab must exist and not be a browser-internal page. Its *current* URL is
  // not blocklist-checked: navigate-away from a fresh tab must work.
  async function pageTab(tabId) {
    const r = await getTab(tabId);
    if (r.error) return r;
    if (isInternalUrl(r.tab.url)) {
      return { ok: false, error: "refused: browser internal page" };
    }
    if (!hostAllowed(r.tab.url, blocklist)) {
      return { ok: false, error: "refused: domain is on the blocklist" };
    }
    return r;
  }

  function checkDest(url) {
    if (!url || typeof url !== "string") return { ok: false, error: "missing url" };
    if (isInternalUrl(url)) return { ok: false, error: "refused: browser internal page" };
    if (!hostAllowed(url, blocklist)) {
      return { ok: false, error: "refused: domain is on the blocklist" };
    }
    return null;
  }

  switch (type) {
    case "listTabs": {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: !!t.active,
        })),
      };
    }
    case "openTab": {
      const denied = checkDest(args.url);
      if (denied) return denied;
      const tab = await chrome.tabs.create({ url: args.url });
      return { ok: true, id: tab.id, url: tab.url };
    }
    case "navigate": {
      const denied = checkDest(args.url);
      if (denied) return denied;
      const r = await getTab(args.tabId);
      if (r.error) return r;
      await chrome.tabs.update(args.tabId, { url: args.url });
      return { ok: true };
    }
    case "search": {
      if (!args.query || typeof args.query !== "string") {
        return { ok: false, error: "missing query" };
      }
      const url =
        "https://www.google.com/search?q=" + encodeURIComponent(args.query);
      const denied = checkDest(url);
      if (denied) return denied;
      const tab = await chrome.tabs.create({ url });
      return { ok: true, id: tab.id, url };
    }
    case "click": {
      if (!args.selector) return { ok: false, error: "missing selector" };
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      return runInTab(chrome, args.tabId, pageClick, [args.selector]);
    }
    case "type": {
      if (!args.selector) return { ok: false, error: "missing selector" };
      if (typeof args.text !== "string") return { ok: false, error: "missing text" };
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      return runInTab(chrome, args.tabId, pageType, [args.selector, args.text]);
    }
    case "pressEnter": {
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      return runInTab(chrome, args.tabId, pagePressEnter, []);
    }
    case "readText": {
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      return runInTab(chrome, args.tabId, pageReadText, []);
    }
    case "closeTab": {
      const r = await getTab(args.tabId);
      if (r.error) return r;
      await chrome.tabs.remove(args.tabId);
      return { ok: true };
    }
    case "screenshot": {
      // Read-only: allowed on any tab (no blocklist check). Defaults to the
      // active tab when no tabId is given.
      let tabId = args.tabId;
      if (!tabId) {
        const act = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!act || !act[0]) return { ok: false, error: "no active tab" };
        tabId = act[0].id;
      }
      const r = await getTab(tabId);
      if (r.error) return r;
      if (isInternalUrl(r.tab.url)) {
        return { ok: false, error: "refused: browser internal page" };
      }
      const format = args.format === "png" ? "png" : "jpeg";
      const opts = { format };
      if (format === "jpeg") {
        opts.quality = Math.max(1, Math.min(100, Math.round(Number(args.quality) || 80)));
      }
      // captureVisibleTab only ever captures the *visible* tab of a window,
      // so the target tab must be the active one. Some Chromium forks reject
      // tabs.update({active:true}) outright ("Updating active property not
      // supported") — that rejection must never fail a screenshot of a tab
      // that is already visible, so activation is best-effort and the tab's
      // active state is re-checked afterwards.
      let tab = r.tab;
      if (!tab.active) {
        try {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((res2) => setTimeout(res2, 250));
        } catch {
          /* activation unsupported on this browser; re-check below */
        }
        const again = await getTab(tabId);
        if (!again.error) tab = again.tab;
        if (!tab.active) {
          return {
            ok: false,
            error: "tab is not visible and this browser would not activate it",
          };
        }
      }
      const windowId = typeof tab.windowId === "number" ? tab.windowId : null;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
      return { ok: true, dataUrl };
    }
    case "fillForm": {
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      if (!Array.isArray(args.fields) || args.fields.length === 0) {
        return { ok: false, error: "fields must be a non-empty array" };
      }
      const res = await runInTab(chrome, args.tabId, pageFillForm, [
        args.fields,
        typeof args.submit === "string" ? args.submit : null,
      ]);
      if (!res.ok) return res;
      return { ok: true, filled: res.filled || 0, errors: res.errors || [] };
    }
    case "waitFor": {
      if (!args.tabId) return { ok: false, error: "missing tabId" };
      if (!args.selector || typeof args.selector !== "string") {
        return { ok: false, error: "missing selector" };
      }
      const r = await pageTab(args.tabId);
      if (r.error) return r;
      const timeoutMs = Math.max(0, Number(args.timeoutMs) || 15000);
      const started = Date.now();
      for (;;) {
        const res = await runInTab(chrome, args.tabId, pageHas, [args.selector]);
        if (res.ok && res.found) {
          return { ok: true, found: true, elapsedMs: Date.now() - started };
        }
        if (Date.now() - started >= timeoutMs) {
          return { ok: true, found: false, elapsedMs: Date.now() - started };
        }
        await new Promise((r2) => setTimeout(r2, 250));
      }
    }
    case "readConsole": {
      // Read-only: allowed on any tab (no blocklist check).
      if (!args.tabId) return { ok: false, error: "missing tabId" };
      const r = await getTab(args.tabId);
      if (r.error) return r;
      if (isInternalUrl(r.tab.url)) {
        return { ok: false, error: "refused: browser internal page" };
      }
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 50)));
      // The hook must run in the MAIN world to wrap the page's own console.
      // Install is idempotent; messages logged before it are missed.
      await runInTab(chrome, args.tabId, pageInstallConsoleHook, [], "MAIN");
      const res = await runInTab(chrome, args.tabId, pageReadConsole, [limit], "MAIN");
      if (!res.ok) return res;
      return { ok: true, messages: res.messages || [] };
    }
    default:
      return { ok: false, error: "unknown command: " + type };
  }
}
