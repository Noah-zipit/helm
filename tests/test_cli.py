"""End-to-end test for bin/helm against an in-process mock relay."""
import json
import os
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = "cli-test-token-0123456789abcdef"
HELM = os.path.join(os.path.dirname(__file__), "..", "bin", "helm")

store = {"queue": [], "results": []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _token(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        return q.get("token", [""])[0]

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self._token() != TOKEN:
            return self._send({"ok": False}, 401)
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"null")
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/command":
            store["queue"].append(body["command"])
            return self._send({"ok": True, "id": body["command"]["id"]})
        if path == "/api/result":
            store["results"].append(body["result"])
            return self._send({"ok": True})
        return self._send({"ok": False}, 404)

    def do_GET(self):
        if self._token() != TOKEN:
            return self._send({"ok": False}, 401)
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/poll":
            cmds, store["queue"] = store["queue"], []
            return self._send({"ok": True, "commands": cmds})
        if path == "/api/results":
            res, store["results"] = store["results"], []
            return self._send({"ok": True, "results": res})
        return self._send({"ok": False}, 404)


def run(*args, env_extra=None):
    env = dict(os.environ, HELM_RELAY_URL=f"http://127.0.0.1:{port}", HELM_TOKEN=TOKEN)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([HELM, *args], capture_output=True, text=True, env=env, timeout=30)


server = HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

# Missing env fails cleanly.
r = run("tabs", env_extra={"HELM_TOKEN": ""})
assert r.returncode == 2 and "HELM_TOKEN" in r.stderr, r.stderr

# Queue a command, simulate the extension, read the result.
r = run("cmd", "search", '{"query": "Elon Musk"}')
assert r.returncode == 0, r.stderr
cid = r.stdout.strip()
assert len(cid) == 12, cid
assert store["queue"][0]["type"] == "search"
assert store["queue"][0]["args"] == {"query": "Elon Musk"}

# Fake extension: poll, execute (pretend), post result.
import urllib.request

def api(method, path, body=None):
    url = f"http://127.0.0.1:{port}{path}?token={TOKEN}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    return json.loads(urllib.request.urlopen(req, timeout=5).read())

polled = api("GET", "/api/poll")
assert [c["id"] for c in polled["commands"]] == [cid]
api("POST", "/api/result", {"result": {"id": cid, "ok": True, "url": "https://google.com/search?q=Elon+Musk"}})

r = run("result", cid, "5")
assert r.returncode == 0, r.stderr
got = json.loads(r.stdout)
assert got["id"] == cid and got["ok"] is True

# tabs shorthand prints the stubbed tab list: run it in the background,
# answer the command it queues, then collect its output.
tab_out = {}
def run_tabs():
    tab_out["r"] = run("tabs")

t = threading.Thread(target=run_tabs, daemon=True)
t.start()
for _ in range(100):
    if store["queue"]:
        break
    threading.Event().wait(0.05)
assert store["queue"], "helm tabs queued nothing"
tabs_cid = store["queue"].pop(0)["id"]
api("POST", "/api/result", {"result": {"id": tabs_cid, "ok": True, "tabs": [
    {"id": 7, "url": "https://en.wikipedia.org/", "title": "Wikipedia", "active": True}]}})
t.join(timeout=15)
r = tab_out["r"]
assert r.returncode == 0, r.stderr
assert "7" in r.stdout and "Wikipedia" in r.stdout and "en.wikipedia.org" in r.stdout

# Unknown subcommand fails.
r = run("frobnicate")
assert r.returncode == 2

server.shutdown()
print("test_cli: all assertions passed")
