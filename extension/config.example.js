// Helm baked-in config — copy this file to `config.js` and fill in your values.
//
// `config.js` is gitignored on purpose: it holds your secret token, which is
// the only credential standing between the internet and your browser. Never
// commit it, never share a zip that contains it.
export const HELM_CONFIG = {
  // Shared secret for your relay deployment. Generate a long random string
  // (128-bit or better) and set the same value on the relay and in the
  // Commander / CLI.
  token: "REPLACE_WITH_YOUR_OWN_RANDOM_TOKEN",
  // Your relay deployment (see relay-vercel/).
  relayUrl: "https://your-relay.vercel.app",
  // "realtime" (Supabase broadcast + long-poll fallback) or "poll" (pure
  // long-polling over HTTPS). Both work without any reachable socket.
  mode: "realtime",
  // Your Supabase project (used for the realtime broadcast channel; the
  // anon key is a public client key by design).
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
  // Exclude-list: every site is allowed EXCEPT domains listed here
  // (an entry also covers its subdomains). Empty = allow everything.
  blocklist: [],
};
