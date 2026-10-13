// Tests for relay-ws/server.js: HTTP surface parity with the v1 worker plus
// the WebSocket push path. Starts the real server on an ephemeral port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// `ws` lives in relay-ws/node_modules; resolve from there.
const require = createRequire(new URL("../relay-ws/package.json", import.meta.url));
const { WebSocket } = require("ws");

const TOK = "ws-test-token-0123456789abcdef";
const PORT = 18731;

const server = spawn("node", ["server.js"], {
  cwd: new URL("../relay-ws/", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((r) => setTimeout(r, 800));

async function api(method, path, body) {
  const url = `http://127.0.0.1:${PORT}${path}?token=${TOK}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

try {
  const h = await api("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.service, "helm-relay-ws");

  const bad = await api("POST", "/api/command", { command: { id: "x", type: "listTabs" } });
  assert.equal(bad.status, 200);
  await api("GET", "/api/poll"); // drain the probe command
  // token is valid here; bad shape check:
  const badShape = await fetch(`http://127.0.0.1:${PORT}/api/command?token=${TOK}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: { id: "x" } }),
  });
  assert.equal(badShape.status, 400);

  const noTok = await fetch(`http://127.0.0.1:${PORT}/api/poll`);
  assert.equal(noTok.status, 401);

  // WebSocket push: connect, queue a command, expect it on the socket.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOK}`);
  const got = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no WS push within 3s")), 3000);
    ws.on("open", async () => {
      await api("POST", "/api/command", { command: { id: "w1", type: "openTab", args: { url: "https://en.wikipedia.org/" } } });
    });
    ws.on("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
    ws.on("error", reject);
  });
  assert.equal(got.type, "command");
  assert.equal(got.command.id, "w1");

  // Extension answers over the socket; CLI-visible via /api/results.
  ws.send(JSON.stringify({ type: "result", result: { id: "w1", ok: true, id2: 9 } }));
  await new Promise((r) => setTimeout(r, 200));
  const res1 = await api("GET", "/api/results");
  assert.equal(res1.json.results.length, 1);
  assert.equal(res1.json.results[0].id, "w1");

  // The same command is still in the HTTP poll queue (push does not drain).
  const p1 = await api("GET", "/api/poll");
  assert.equal(p1.json.commands.length, 1);
  assert.equal(p1.json.commands[0].id, "w1");

  // HTTP result path also works.
  await api("POST", "/api/command", { command: { id: "w2", type: "listTabs", args: {} } });
  await api("POST", "/api/result", { result: { id: "w2", ok: true, tabs: [] } });
  const res2 = await api("GET", "/api/results");
  assert.equal(res2.json.results[0].id, "w2");

  // Bad WS token: the server answers 401, no upgrade.
  const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=short`);
  const refused = await new Promise((resolve) => {
    badWs.on("close", () => resolve(true));
    badWs.on("error", () => resolve(true)); // "unexpected server response: 401"
    setTimeout(() => resolve("timeout"), 2000);
  });
  assert.equal(refused, true);

  ws.close();
  console.log("test_relay_ws: all assertions passed");
} finally {
  server.kill();
}
