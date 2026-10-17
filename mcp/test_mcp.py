#!/usr/bin/env python3
"""Smoke test for the Helm MCP server: initialize -> tools/list -> tools/call(helm_instances).

Run: python3 mcp/test_mcp.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "helm-mcp")

failures = []


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), "-", name, detail)
    if not cond:
        failures.append(name)


def main():
    proc = subprocess.Popen(
        [SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    rid = [0]

    def send(method, params=None):
        rid[0] += 1
        msg = {"jsonrpc": "2.0", "id": rid[0], "method": method}
        if params is not None:
            msg["params"] = params
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        return rid[0]

    def recv():
        return json.loads(proc.stdout.readline())

    # 1. initialize
    send("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"},
    })
    r = recv()
    check("initialize responds", "result" in r and "error" not in r)
    si = r.get("result", {}).get("serverInfo", {})
    check("serverInfo name=helm-mcp", si.get("name") == "helm-mcp",
          f"got {si.get('name')!r}")

    # 2. tools/list
    send("tools/list")
    r = recv()
    tools = r.get("result", {}).get("tools", [])
    names = [t["name"] for t in tools]
    expected = {
        "helm_listTabs", "helm_instances", "helm_openTab", "helm_navigate",
        "helm_search", "helm_click", "helm_type", "helm_pressEnter",
        "helm_readText", "helm_closeTab", "helm_screenshot",
    }
    check("tools/list returns 11 tools",
          set(names) == expected, f"got {sorted(names)}")
    schemas_ok = all(
        t.get("inputSchema", {}).get("type") == "object"
        and isinstance(t.get("description"), str) and t["description"]
        for t in tools
    )
    check("every tool has description + inputSchema", schemas_ok)

    # 3. tools/call helm_instances (harmless, works offline too)
    send("tools/call", {"name": "helm_instances", "arguments": {}})
    r = recv()
    content = r.get("result", {}).get("content", [])
    text = content[0].get("text", "") if content else ""
    check("helm_instances call returns text", bool(content) and "isError" in r.get("result", {}),
          f"-> {text[:80]!r}")

    # 4. unknown tool -> JSON-RPC error, not a crash
    send("tools/call", {"name": "helm_nope", "arguments": {}})
    r = recv()
    check("unknown tool gives JSON-RPC error", "error" in r)

    # 5. shutdown + secret leak check happen after stdin closes
    proc.stdin.close()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    err = proc.stderr.read()
    check("no traceback on shutdown", "Traceback" not in err, err[-200:] if err else "")
    # secret check: env file values must not leak into stderr
    token = os.environ.get("HELM_TOKEN", "")
    leak = token and len(token) >= 8 and token in err
    check("secret not leaked on stderr", not leak)

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
