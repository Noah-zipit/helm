# Helm

**Take the helm of your own browser.** Helm is a personal browser-control system: a Chrome/Edge extension that lets *you* (or an AI you trust) drive your real browser — your real tabs, your real logins — from a command line or a web control panel.

No separate automation browser. No Playwright profile that has never heard of your accounts. The browser you already use, with a remote control you hold.

```
┌────────────┐   commands    ┌──────────────┐   long-poll / realtime   ┌──────────────┐
│  CLI  /    │ ────────────▶ │    Relay     │ ───────────────────────▶ │  Extension   │
│  Commander │ ◀──────────── │ Vercel +     │ ◀─────────────────────── │  in Edge /   │
│  (web UI)  │    results    │ Supabase     │         results          │  Chromium    │
└────────────┘               └──────────────┘                          └──────────────┘
                                   ▲
                                   │  POST /api/brain
                             ┌──────────────┐
                             │  Helm Brain  │  NVIDIA NIM turns plain-language
                             │  (optional)  │  tasks into command plans
                             └──────────────┘
```

## What it can do

- **Tabs** — list, open, navigate, close
- **Search** — open a Google search in a new tab
- **Pages** — read visible text, click elements, type into fields, fill whole forms, wait for dynamic content, press Enter
- **Screenshots** — capture the visible tab as PNG
- **Dev signals** — read recent console output from a page
- **Natural language** — describe a task in the Commander ("open YouTube Music and play Ashke by Karan Aujla") and Helm Brain plans and executes it step by step

Every command runs against an exclude-list: every site is allowed except the domains you put on the blocklist, and the extension itself enforces it, no matter who sent the command.

## Components

| Path | What it is |
|---|---|
| `extension/` | MV3 extension (service-worker only, no offscreen documents — so it runs in Chromium builds where offscreen is unavailable) |
| `relay-vercel/` | Serverless relay: command queue, results, presence, and the Brain endpoint |
| `bin/helm` | Zero-dependency Python CLI |
| `tests/` | Executor, relay, and CLI test suites |
| `ARCHITECTURE.md`, `docs/` | Design notes, protocol, deploy and setup guides |

The **Commander** is the web control panel (Next.js): live instance switcher when you run Helm in more than one browser, a tab deck, prebuilt commands, and the Brain bar. Live at [helm-commander.vercel.app](https://helm-commander.vercel.app).

## How commands travel

1. A client (CLI or Commander) posts a command to the relay, authenticated by a shared token.
2. The extension picks it up. Two transports, both resilient:
   - **Realtime** — Supabase broadcast over WebSocket, with a **long-poll fallback** that holds an HTTPS request open on the relay and returns the instant a command lands.
   - **Poll** — pure long-polling. No socket required at all; pickup is around a second.
3. The extension executes the command (serialized, with a hard execution timeout so one hung page can never stall the queue) and posts the result back.

Presence heartbeats let clients see which browser instances are alive right now.

## Quick start

### 1. Relay

Deploy `relay-vercel/` to Vercel. It needs a Supabase project with one table (`helm_messages`: `id`, `token`, `kind` (`cmd`/`res`), `payload` jsonb, `created_at`) and these env vars:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (server-side only, never shipped to clients)
- `NVIDIA_NIM_API_KEY` (optional — enables `POST /api/brain`)

### 2. Extension

```bash
cp extension/config.example.js extension/config.js
# fill in your token, relay URL, Supabase URL + anon key
```

Then load the `extension/` folder as an unpacked extension (`edge://extensions` → Developer mode → Load unpacked). All settings also live in the popup, so nothing depends on the options page.

> `config.js` contains your token. It is gitignored. A zip of the extension with a real `config.js` inside is a credential — treat it like one.

### 3. CLI

```bash
export HELM_RELAY_URL="https://your-relay.vercel.app"
export HELM_TOKEN="your token"
./bin/helm tabs
./bin/helm search "harry potter movies in order"
./bin/helm open https://en.wikipedia.org
```

## Commands

| Command | Args | Notes |
|---|---|---|
| `listTabs` | — | All tabs in the last-focused window |
| `openTab` | `url` | Refused only for blocklisted domains |
| `navigate` | `tabId, url` | |
| `search` | `query` | Google search in a new tab |
| `readText` | `tabId` | Visible page text (capped) |
| `click` | `tabId, selector` | First match; scrolls into view |
| `type` | `tabId, selector, text` | Fires real input/change events |
| `fillForm` | `tabId, fields[], submit?` | Batch field fill |
| `pressEnter` | `tabId` | |
| `waitFor` | `tabId, selector, timeoutMs?` | For dynamic pages |
| `screenshot` | `tabId?` | Visible tab, PNG data URL |
| `readConsole` | `tabId` | Recent page console entries |
| `closeTab` | `tabId` | |

Plans from Helm Brain chain tabs with `"$new"`: a step can target the tab an earlier `openTab`/`search` step just created.

## Security model

- **One shared token** authenticates every hop. It is the whole perimeter — generate a long random one, keep it out of git.
- **The blocklist is enforced in the extension**, not the client. A stolen client still cannot touch a domain you have excluded; everything else is open by design.
- The relay stores commands and results in a single table and drains on read; nothing is kept after delivery (presence rows are capped).
- The Supabase **anon key is public by design** and safe to ship; the service key never leaves the relay.

## Tests

```bash
node tests/test_executor.mjs   # command executor (stubbed chrome.*)
node tests/test_relay.mjs      # relay routes (stubbed Supabase)
python3 tests/test_cli.py      # CLI
```

## License

MIT
