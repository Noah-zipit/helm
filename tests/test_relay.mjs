// Tests for relay/worker.js (v1 Cloudflare Worker). Stubs Request/Response
// (node 24 has them via undici) and the two KV namespaces.
import assert from "node:assert/strict";
import worker from "../relay/worker.js";

const TOK = "test-token-0123456789abcdef";
const OTHER = "other-token-0123456789abcdef";

function memKV() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, v);
    },
  };
}

const env = { BC_QUEUE: memKV(), BC_RESULTS: memKV() };

async function call(method, path, { token = TOK, body = undefined } = {}) {
  let url = "https://relay.test" + path;
  const headers = {};
  let payload;
  if (body !== undefined) {
    if (token && typeof body === "object" && body !== null && !("token" in body)) {
      body = { ...body, token };
    }
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  } else if (method === "GET") {
    url += (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  const req = new Request(url, { method, headers, body: payload });
  const res = await worker.fetch(req, env);
  return { status: res.status, json: await res.json() };
}

const { status: hStatus, json: hJson } = await call("GET", "/api/health", { token: "" });
assert.equal(hStatus, 200);
assert.equal(hJson.ok, true);

const noTok = await call("POST", "/api/command", { token: "", body: { command: { id: "a", type: "listTabs" } } });
assert.equal(noTok.status, 401);

const short = await call("POST", "/api/command", { token: "short", body: { command: { id: "a", type: "listTabs" } } });
assert.equal(short.status, 401);

const bad = await call("POST", "/api/command", { body: { token: TOK, command: { id: "a" } } });
assert.equal(bad.status, 400);

const q1 = await call("POST", "/api/command", { body: { command: { id: "cmd1", type: "listTabs", args: {} } } });
assert.equal(q1.status, 200);
assert.equal(q1.json.id, "cmd1");

const q2 = await call("POST", "/api/command", {
  token: OTHER,
  body: { command: { id: "other1", type: "openTab", args: { url: "https://x.com" } } },
});
assert.equal(q2.status, 200);

const p1 = await call("GET", "/api/poll");
assert.equal(p1.status, 200);
assert.equal(p1.json.commands.length, 1);
assert.equal(p1.json.commands[0].id, "cmd1");

// Poll drains the queue.
const p2 = await call("GET", "/api/poll");
assert.deepEqual(p2.json.commands, []);

// Token isolation: other token's command is untouched.
const p3 = await call("GET", "/api/poll", { token: OTHER });
assert.equal(p3.json.commands.length, 1);
assert.equal(p3.json.commands[0].id, "other1");

const r1 = await call("POST", "/api/result", { body: { result: { id: "cmd1", ok: true, tabs: [] } } });
assert.equal(r1.status, 200);

const badR = await call("POST", "/api/result", { body: { result: { ok: true } } });
assert.equal(badR.status, 400);

const g1 = await call("GET", "/api/results");
assert.equal(g1.json.results.length, 1);
assert.equal(g1.json.results[0].id, "cmd1");

// Results drain too.
const g2 = await call("GET", "/api/results");
assert.deepEqual(g2.json.results, []);

const nf = await call("GET", "/nope");
assert.equal(nf.status, 404);

console.log("test_relay: all 14 assertions passed");
