# Helm — deploy the relays

## Live: Vercel + Supabase (polling relay)

Already deployed — no action needed. Reference for rebuilds:

- Vercel project `helm-relay` (second account), id `prj_WvmAR2nTcLhVkl1O1Fay1fDFuCim`
- Source: `relay-vercel/` — single serverless function `api/[route].js`
  (dynamic route, no dependencies, plain fetch to Supabase REST)
- Env vars (production, encrypted): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Storage: Supabase table `helm_messages` (shopagent project) —
  `supabase/helm_messages.sql`
- Deployment protection (SSO) is OFF: `PATCH /v9/projects/{id}`
  `{"ssoProtection":null}` — the relay must be publicly reachable
- Live URL: `https://helm-relay.vercel.app`

Smoke test:

```
curl "https://helm-relay.vercel.app/api/health"
# {"ok":true,"service":"browser-controller-relay"}
```

## Alternative: Cloudflare Worker + KV (not deployed)

Prereqs: `npm i -g wrangler`, then `wrangler login`.

```
cd relay
wrangler kv namespace create BC_QUEUE
wrangler kv namespace create BC_RESULTS
```

Paste the two returned ids into `wrangler.toml` (replace the
`REPLACE_WITH_…` placeholders), then:

```
wrangler deploy
```

Wrangler prints your relay URL, e.g.
`https://helm-relay.yourname.workers.dev`. Put it in the extension
settings (docs/SETUP.md step 3). Smoke test:

```
curl "https://<your-worker>/api/health"
# {"ok":true,"service":"browser-controller-relay"}
```

## v2 relay — fly.io (WebSocket)

Prereqs: `fly` CLI, then `fly auth login`.

```
cd relay-ws
fly launch        # name it helm-relay, region sin, no Postgres/Redis
fly deploy
```

Note `fly.toml` sets `min_machines_running = 1` — the machine must stay up
or the socket drops (polling still works as fallback via the same HTTP
endpoints). Your URLs:

- Relay: `https://helm-relay.fly.dev`
- Socket: `wss://helm-relay.fly.dev`

Smoke test:

```
curl "https://helm-relay.fly.dev/api/health"
# {"ok":true,"service":"helm-relay-ws"}
```

Railway alternative: `railway init` + `railway up` in `relay-ws/` —
nixpacks detects `package.json` and runs `npm start` on `$PORT`. Same
endpoints, same socket path.

## Rotating the token

Generate a new one (`openssl rand -hex 32`), save it in the extension
options, and update the agent's `HELM_TOKEN`. Old queued commands are
namespaced per token, so nothing leaks across rotation.
