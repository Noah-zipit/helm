# Helm — protocol

All relay traffic is JSON over HTTPS. Every request carries the shared
secret: query param `?token=…`, JSON body field `token`, or header
`X-BC-Token`. Missing or short (<16 chars) token → `401`. Note: tokens in
URLs can appear in server logs; non-browser clients can use the header
instead. Rotate with `openssl rand -hex 32` (see docs/DEPLOY.md).

## HTTP endpoints (v1 Worker and v2 Node relay share these)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, service}` (no token needed) |
| POST | `/api/command` | `{command: {id, type, args}}` | `{ok, id, queued}` |
| GET | `/api/poll` | — | `{ok, commands: [...]}` — drains the queue |
| POST | `/api/result` | `{result: {id, ok, ...}}` | `{ok, id}` |
| GET | `/api/results` | — | `{ok, results: [...]}` — drains the store |

Queues hold 50 commands, results hold 100; oldest are dropped first.

## Command shape

```json
{ "id": "a1b2c3d4e5f6", "type": "type", "args": { "tabId": 7, "selector": "#searchInput", "text": "Elon Musk" } }
```

## Result shape

```json
{ "id": "a1b2c3d4e5f6", "ok": true, "url": "https://en.wikipedia.org/" }
```

Failures: `{ "id": "…", "ok": false, "error": "no such element: #x" }`.
The extension never fails silently.

## Commands (v1)

| type | args | returns |
|---|---|---|
| `listTabs` | — | `{ok, tabs: [{id, url, title, active}]}` |
| `openTab` | `{url}` | `{ok, id, url}` |
| `navigate` | `{tabId, url}` | `{ok}` |
| `search` | `{query}` | `{ok, id, url}` — new Google search tab |
| `click` | `{tabId, selector}` | `{ok}` |
| `type` | `{tabId, selector, text}` | `{ok}` — sets value, fires input/change |
| `pressEnter` | `{tabId}` | `{ok}` — Enter key on the focused element |
| `readText` | `{tabId}` | `{ok, url, title, text}` — text capped at 20k chars |
| `closeTab` | `{tabId}` | `{ok}` |

## v2 additions

| type | args | returns |
|---|---|---|
| `screenshot` | `{tabId}` | `{ok, dataUrl}` — PNG of the tab (tab is activated first) |

v2 also adds the WebSocket channel: the extension connects to
`wss://<relay>/ws?token=…` and the server pushes
`{type: "command", command}` instantly. Results still travel back over
`POST /api/result` (or a `{type: "result", result}` socket frame) — the
CLI is identical for both transports.

## Refusals

- `chrome://`, `chrome-extension://`, `about:` pages → `refused: browser internal page`.
- Domain not on the allowlist (when set) → `refused: domain not in allowlist`.
- Unknown command → `unknown command: <type>`.
- Missing selector/element → `no such element: <selector>`.
