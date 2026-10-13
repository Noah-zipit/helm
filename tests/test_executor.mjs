// Tests for extension/executor.js. Stubs the chrome APIs and the page DOM;
// exercises all 10 commands plus refusals, then chains the exact example
// flow: open tab -> type into Wikipedia search -> press enter -> read text.
import assert from "node:assert/strict";
import { executeCommand, hostAllowed, isInternalUrl } from "../extension/executor.js";

function makeChrome(tabs) {
  return {
    tabs: {
      query: async () => tabs,
      get: async (id) => {
        const t = tabs.find((t) => t.id === id);
        if (!t) throw new Error("No tab with id: " + id);
        return t;
      },
      create: async ({ url }) => {
        const t = { id: Math.max(...tabs.map((t) => t.id)) + 1, url, title: "", active: true };
        tabs.push(t);
        return t;
      },
      update: async (id, props) => {
        const t = tabs.find((t) => t.id === id);
        if (props.url !== undefined) t.url = props.url;
        if (props.active !== undefined) t.active = props.active;
        return t;
      },
      remove: async (id) => {
        const i = tabs.findIndex((t) => t.id === id);
        if (i >= 0) tabs.splice(i, 1);
      },
      captureVisibleTab: async () => "data:image/png;base64,AAA",
    },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: await func(...(args || [])) }],
    },
  };
}

// Fake page DOM. Elements record what happened to them.
function fakeDocument(elements) {
  const events = [];
  const doc = {
    title: "Fake page",
    activeElement: null,
    body: {
      innerText: "hello world ".repeat(50),
      dispatchEvent: (ev) => events.push({ el: "body", type: ev.type }),
      closest: () => null,
    },
    querySelector: (sel) => elements[sel] || null,
    _events: events,
  };
  for (const el of Object.values(elements)) {
    el.focus = () => (doc.activeElement = el);
    el.click = () => (el.clicked = true);
    el.dispatchEvent = (ev) => events.push({ el: el.name, type: ev.type });
    el.closest = () => null;
  }
  return doc;
}

function fakeInput(name) {
  return { name, value: "", isContentEditable: false, clicked: false };
}

globalThis.Event = class Event {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
  }
};
globalThis.KeyboardEvent = class KeyboardEvent extends globalThis.Event {
  constructor(type, opts) {
    super(type, opts);
    Object.assign(this, opts);
  }
};
globalThis.location = { href: "https://en.wikipedia.org/" };

const cmd = (type, args) => executeCommand(makeChrome([]), { type, args }, []);

assert.equal(isInternalUrl("chrome://newtab/"), true);
assert.equal(isInternalUrl("https://x.com"), false);
assert.equal(hostAllowed("https://en.wikipedia.org/wiki/X", []), true);
assert.equal(hostAllowed("https://en.wikipedia.org/wiki/X", ["wikipedia.org"]), true);
assert.equal(hostAllowed("https://fr.wikipedia.org/wiki/X", ["wikipedia.org"]), true);
assert.equal(hostAllowed("https://evil.com", ["wikipedia.org"]), false);
assert.equal(hostAllowed("not a url", ["wikipedia.org"]), false);

// listTabs
{
  const tabs = [{ id: 1, url: "https://a.com", title: "A", active: true }];
  const r = await executeCommand(makeChrome(tabs), { type: "listTabs", args: {} }, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tabs, [{ id: 1, url: "https://a.com", title: "A", active: true }]);
}

// openTab / navigate / closeTab
{
  const chrome = makeChrome([]);
  const r = await executeCommand(chrome, { type: "openTab", args: { url: "https://en.wikipedia.org/" } }, []);
  assert.equal(r.ok, true);
  const id = r.id;
  const n = await executeCommand(chrome, { type: "navigate", args: { tabId: id, url: "https://en.wikipedia.org/wiki/Elon_Musk" } }, []);
  assert.equal(n.ok, true);
  const c = await executeCommand(chrome, { type: "closeTab", args: { tabId: id } }, []);
  assert.equal(c.ok, true);
  const gone = await executeCommand(chrome, { type: "closeTab", args: { tabId: id } }, []);
  assert.equal(gone.ok, false);
}

// openTab refused: internal + allowlist
{
  const r1 = await cmd("openTab", { url: "chrome://settings/" });
  assert.equal(r1.ok, false);
  const r2 = await executeCommand(makeChrome([]), { type: "openTab", args: { url: "https://evil.com" } }, ["wikipedia.org"]);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /allowlist/);
}

// search
{
  const r = await cmd("search", { query: "Elon Musk" });
  assert.equal(r.ok, true);
  assert.ok(r.url.includes("google.com/search?q=Elon%20Musk"));
  const r2 = await cmd("search", {});
  assert.equal(r2.ok, false);
}

// click / type / pressEnter / readText on a fake page
{
  const tabs = [{ id: 5, url: "https://en.wikipedia.org/", title: "W", active: true }];
  const chrome = makeChrome(tabs);
  const input = fakeInput("search");
  const btn = fakeInput("go");
  globalThis.document = fakeDocument({ "#searchInput": input, "#go": btn });

  const t = await executeCommand(chrome, { type: "type", args: { tabId: 5, selector: "#searchInput", text: "Elon Musk" } }, []);
  assert.equal(t.ok, true);
  assert.equal(input.value, "Elon Musk");

  const miss = await executeCommand(chrome, { type: "type", args: { tabId: 5, selector: "#nope", text: "x" } }, []);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /no such element/);

  const ro = await executeCommand(chrome, { type: "type", args: { tabId: 5, selector: "#go", text: "x" } }, []);
  // #go is a fake input too, so it types fine; make a non-editable div case:
  globalThis.document = fakeDocument({ "#div": { name: "div", clicked: false } });
  const ne = await executeCommand(chrome, { type: "type", args: { tabId: 5, selector: "#div", text: "x" } }, []);
  assert.equal(ne.ok, false);
  assert.match(ne.error, /not editable/);

  globalThis.document = fakeDocument({ "#searchInput": input });
  const p = await executeCommand(chrome, { type: "pressEnter", args: { tabId: 5 } }, []);
  assert.equal(p.ok, true);

  const c = await executeCommand(chrome, { type: "click", args: { tabId: 5, selector: "#searchInput" } }, []);
  assert.equal(c.ok, true);
  assert.equal(input.clicked, true);

  const rd = await executeCommand(chrome, { type: "readText", args: { tabId: 5 } }, []);
  assert.equal(rd.ok, true);
  assert.ok(rd.text.length > 0);
  assert.equal(rd.url, "https://en.wikipedia.org/");
}

// refused on chrome:// tab
{
  const tabs = [{ id: 9, url: "chrome://newtab/", title: "", active: true }];
  const chrome = makeChrome(tabs);
  globalThis.document = fakeDocument({});
  const r = await executeCommand(chrome, { type: "click", args: { tabId: 9, selector: "a" } }, []);
  assert.equal(r.ok, false);
  assert.match(r.error, /internal page/);
}

// screenshot
{
  const tabs = [{ id: 3, url: "https://en.wikipedia.org/", title: "W", active: false }];
  const chrome = makeChrome(tabs);
  const r = await executeCommand(chrome, { type: "screenshot", args: { tabId: 3 } }, []);
  assert.equal(r.ok, true);
  assert.ok(r.dataUrl.startsWith("data:image/png"));
  assert.equal(tabs[0].active, true); // tab was activated for capture
}

// screenshot: already-active tab must not need activation at all (v0.5.0 —
// some Chromium forks throw on tabs.update({active:true}))
{
  const tabs = [{ id: 4, url: "https://en.wikipedia.org/", title: "W", active: true, windowId: 7 }];
  const chrome = makeChrome(tabs);
  chrome.tabs.update = async () => {
    throw new Error("Updating active property not supported");
  };
  let capturedWindow = "unset";
  chrome.tabs.captureVisibleTab = async (w) => {
    capturedWindow = w;
    return "data:image/jpeg;base64,BBB";
  };
  const r = await executeCommand(chrome, { type: "screenshot", args: { tabId: 4 } }, []);
  assert.equal(r.ok, true);
  assert.ok(r.dataUrl.startsWith("data:image/jpeg"));
  assert.equal(capturedWindow, 7); // captured the tab's own window
}

// screenshot: activation refused and tab stays hidden -> clean error, no throw
{
  const tabs = [{ id: 5, url: "https://en.wikipedia.org/", title: "W", active: false }];
  const chrome = makeChrome(tabs);
  chrome.tabs.update = async () => {
    throw new Error("Updating active property not supported");
  };
  const r = await executeCommand(chrome, { type: "screenshot", args: { tabId: 5 } }, []);
  assert.equal(r.ok, false);
  assert.match(r.error, /not visible/);
}

// unknown command
{
  const r = await cmd("teleport", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown command/);
}

// The exact example flow: "open new tab, search wikipedia, search Elon Musk"
{
  const chrome = makeChrome([]);
  const input = fakeInput("searchInput");
  globalThis.document = fakeDocument({ "#searchInput": input });
  globalThis.document.title = "Wikipedia";

  const o = await executeCommand(chrome, { type: "openTab", args: { url: "https://en.wikipedia.org/" } }, []);
  assert.equal(o.ok, true);
  const ty = await executeCommand(chrome, { type: "type", args: { tabId: o.id, selector: "#searchInput", text: "Elon Musk" } }, []);
  assert.equal(ty.ok, true);
  const pe = await executeCommand(chrome, { type: "pressEnter", args: { tabId: o.id } }, []);
  assert.equal(pe.ok, true);
  const rd = await executeCommand(chrome, { type: "readText", args: { tabId: o.id } }, []);
  assert.equal(rd.ok, true);
  assert.equal(input.value, "Elon Musk");
}

console.log("test_executor: all assertions passed");
