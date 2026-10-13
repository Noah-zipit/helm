# Helm — setup (about 5 minutes)

You need: desktop Chrome or Edge. The relay is already live — skip to step 1.

## Live relay

- Relay URL: `https://helm-relay.vercel.app`
- Vercel project: `helm-relay` (second account), Supabase table: `helm_messages`
  in the shopagent project. Source: `relay-vercel/`.

## 1. Make a secret token

Run this once, anywhere:

```
openssl rand -hex 32
```

Copy the output. This is the shared secret between your browser and the
agent. Never put it in the repo.

## 2. The relay is already deployed (nothing to do)

The polling relay is live on Vercel + Supabase — no deploy step needed.
(The Cloudflare Worker in `relay/` and the fly.io WebSocket relay in
`relay-ws/` remain as documented alternatives; see `docs/DEPLOY.md`.)

## 3. Install the extension

1. Open `chrome://extensions` (or `edge://extensions` in Edge), turn on
   **Developer mode** (top right).
2. **Load unpacked** → pick the `extension/` folder.
3. Click the Helm icon → **Open settings**.
4. Fill in: relay URL `https://helm-relay.vercel.app`,
   transport **polling**, the secret token from step 1, and optionally a site
   allowlist (one domain per line).
5. Save. The icon shows a green dot when the worker is healthy.

## 4. Verify

Tell the agent: "open a new tab and search Wikipedia for Elon Musk".
A tab opens in your browser and searches. The extension badge shows ●
while each command runs.

## Trust note

Helm gives the agent full control of this browser — every tab, every
logged-in session. Run it only on a browser you own, keep the token
private, and use the allowlist to limit which sites it can touch.
