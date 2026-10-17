# Helm MCP server

Drive Helm's real browser (your real logged-in tabs) from any MCP host —
Claude Desktop, Gemini CLI, Cursor — over stdio.

## Prerequisites

1. The **Helm extension** must be installed (sideloaded, `extension/` — load
   unpacked at `chrome://extensions`) and open on the machine whose browser
   you want to drive.
2. The **relay** must be reachable: the extension's popup is configured with
   the relay URL and the shared secret.
3. On the machine running this server, `~/.config/helm/env` holds
   `HELM_RELAY_URL` and `HELM_TOKEN` (the same file `bin/helm` uses).
   The secret is never printed, logged, or committed.

## Run

```sh
# stdio server, no dependencies (Python 3 stdlib only)
./mcp/helm-mcp
```

## Configure

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`
(or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "helm": {
      "command": "/path/to/browser-controller/mcp/helm-mcp"
    }
  }
}
```

The server reads `~/.config/helm/env` itself. If env is managed by your
shell instead, pass it explicitly:

```json
{
  "mcpServers": {
    "helm": {
      "command": "/path/to/browser-controller/mcp/helm-mcp",
      "env": {
        "HELM_RELAY_URL": "https://helm-relay.vercel.app",
        "HELM_TOKEN": "<your 32+ char secret>"
      }
    }
  }
}
```

### Gemini CLI

`~/.muse/settings.json`:

```json
{
  "mcpServers": {
    "helm": {
      "command": "/path/to/browser-controller/mcp/helm-mcp"
    }
  }
}
```

### Cursor

Settings → MCP → Add new MCP server:

- Name: `helm`
- Type: `command`
- Command: `/path/to/browser-controller/mcp/helm-mcp`

## Tools exposed

| Tool | Effect |
|---|---|
| `helm_listTabs` | list open tabs (id, title, url) |
| `helm_instances` | list Helm browser instances currently online |
| `helm_openTab` | open URL in a new tab |
| `helm_navigate` | navigate a tab to a URL |
| `helm_search` | Google-search in a new tab |
| `helm_click` | click by CSS selector |
| `helm_type` | type into an element by CSS selector |
| `helm_pressEnter` | press Enter in a tab |
| `helm_readText` | read url, title, and page text of a tab |
| `helm_closeTab` | close a tab |
| `helm_screenshot` | screenshot of a tab, returned as an image |

## Safety model

- The **domain blocklist is enforced inside the extension**, not here. Blocked
  domains, `chrome://` pages, and the Web Store return `refused` errors from
  the extension — this server cannot bypass them, and neither can any MCP
  client behind it.
- The extension badge lights up while a command runs: control is never
  invisible.
- Personal use only: this gives an AI full control of your logged-in browser.

## Verification

The bundled smoke test speaks raw MCP stdio to the server:

```sh
python3 mcp/test_mcp.py
```

It checks `initialize` → `tools/list` → a `tools/call` of `helm_instances`
(graceful whether or not a browser is online). A live `listTabs` round trip
needs the extension online.
