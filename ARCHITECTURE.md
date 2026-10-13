# Helm — Architecture

**One line:** Helm lets Ashar's AI agent control his Chrome browser — open tabs, search, click, type, read pages — so agent work can run in his sessions instead of a remote server.

## Why

Some work only works in his browser: his logins, his cookies, sites with bot-checks that block datacenter IPs (BairesDev, LaunchyFi, Invisible applications). Helm closes that gap.

## Non-goals (v1)

- No Web Store publishing. Sideloaded unpacked extension, personal use.
- No persistent WebSocket. The agent's VM cannot receive inbound connections (cloudflared/localtunnel fail for inbound), so v1 polls.
- No phone browsers. Desktop Chrome only.

## Components

```
┌──────────────┐      HTTPS poll (2s)      ┌──────────────┐
│  Chrome ext  │ ◄──────────────────────── │    Relay     │
│  (his side)  │ ──results───────────────► │  (Vercel +   │
└──────────────┘                            │  Supabase)   │
       │ executes                           └──────────────┘
       ▼                                           ▲
  his tabs                                  ┌──────────────┐
                                            │  bin/helm    │
                                            │  (agent CLI) │
                                            └──────────────┘
```

### 1. Extension (`extension/`, Manifest V3)

- Service worker with `tabs` + `scripting` permissions. No host permissions beyond what commands need.
- Loop: every ~2s, GET relay `/queue?token=…`. If a command is waiting, execute it, POST the result to `/result`.
- Execution uses `chrome.tabs` and `chrome.scripting.executeScript` — real clicks, real keystrokes, real navigation.
- Visible indicator: badge text on the extension icon while a command runs. Control is never invisible.
- Commands never run on `chrome://` pages or the Web Store (Chrome forbids it; the extension reports `refused`).

### 2. Relay (LIVE: Vercel serverless + Supabase)

- Endpoints, all requiring the shared secret token (query param, body field, or `X-BC-Token` header):
  - `POST /api/command` — agent pushes `{command: {id, type, args}}`.
  - `GET /api/poll` — extension drains pending commands.
  - `POST /api/result` — extension posts `{result: {id, ok, ...}}`.
  - `GET /api/results` — agent drains completed results.
  - `GET /api/health` — no token needed.
- Implementation: `relay-vercel/api/[route].js` — one serverless function,
  zero dependencies, plain fetch to Supabase REST. Token < 16 chars → 401.
  Per-token namespacing, 50-command / 100-result caps, drain-on-read.
- Storage: Supabase table `helm_messages` (`token`, `kind` cmd|res,
  `payload` jsonb) in the shopagent project.
- Live at `https://helm-relay.vercel.app`
  (Vercel project `helm-relay` on the second account; deployment protection off).
- The Cloudflare Worker (`relay/`, KV) and fly.io WebSocket relay
  (`relay-ws/`) remain as documented alternatives in `docs/DEPLOY.md`.

### 3. CLI (`bin/helm`, agent side)

- `helm cmd <command> '<json-args>'` — queues a command, prints its id.
- `helm result <id>` — blocks up to 30s for the result, prints JSON.
- `helm tabs` — shorthand for listTabs.

## Command set (v1)

| Command | Args | Returns |
|---|---|---|
| `listTabs` | — | `[{id, url, title, active}]` |
| `openTab` | `{url}` | `{id}` |
| `navigate` | `{tabId, url}` | `{ok}` |
| `search` | `{query}` | `{id, url}` (Google search tab) |
| `click` | `{tabId, selector}` | `{ok}` |
| `type` | `{tabId, selector, text}` | `{ok}` |
| `pressEnter` | `{tabId}` | `{ok}` |
| `readText` | `{tabId}` | `{url, title, text}` |
| `closeTab` | `{tabId}` | `{ok}` |

Selectors are CSS. If a selector misses, the extension returns `error: "no such element"` — the agent retries with a better one. No silent failures.

## Security model

- Shared secret token, 32+ random bytes, stored in the extension's local storage and the agent's env — never in the repo.
- Relay rejects any request without a valid token (401).
- The extension only talks to the configured relay URL. No other network calls.
- Trust statement (shown in setup docs): this gives the agent full control of the user's logged-in browser. Personal use only.

## Setup (his side, ~5 minutes)

1. `chrome://extensions` (or `edge://extensions`) → Developer mode → Load unpacked → `extension/`.
2. Open the extension popup, paste relay URL
   `https://helm-relay.vercel.app` + secret, save.
3. Relay is already live — no deploy step.
4. Agent runs `HELM_RELAY_URL=<url> HELM_TOKEN=<secret> bin/helm cmd search '{"query":"test"}'` → tab opens in his browser.

## v2 (in scope for this build)

- WebSocket relay for sub-second control (needs a host that holds connections: fly.io/railway — builder picks the simplest that works; polling stays as fallback).
- Screenshots on demand (`screenshot {tabId}` → PNG data URL in the result).
- Per-site allowlist: commands only run on approved domains, managed in the extension popup.
- Android support via Kiwi Browser (MV3 extensions work there) — docs only, not tested.

## Build discipline

PONYTAIL (`~/workspace/skills/ponytail/SKILL.md`, MIT, DietrichGebert/ponytail): the laziness ladder applies to the whole build — reuse before extending, stdlib before dependencies, smallest complete change, no scaffolding for later. `ponytail-review` runs over the final diff before delivery.
