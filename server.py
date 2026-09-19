#!/usr/bin/env python3
"""Jev Lab — local server.

Holds the TypeSafe API key server-side and proxies typed questions to Jev.
The key is NEVER sent to the browser and never appears in a URL, log, or argv.

Usage:
    python3 server.py            # then open http://127.0.0.1:8770
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"          # local only: never bind 0.0.0.0 with a key in play
PORT = int(os.environ.get("JEV_LAB_PORT", "8770"))
STATIC = Path(__file__).parent / "static"
ENDPOINT = "https://api.typesafe.ai/v1/systemone"
SECRET_FILE = Path.home() / ".agents-md" / ".secrets" / "typesafe.env"
PRICE_PER_MTOK_USD = 0.042   # input tokens; output tokens are free


def load_key() -> str | None:
    """Environment first, then the shared secrets file. Never logged."""
    k = os.environ.get("TYPESAFE_API_KEY")
    if k:
        return k.strip()
    if SECRET_FILE.exists():
        for line in SECRET_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


KEY = load_key()

# Session-wide accounting so the cost readout is authoritative, not cosmetic.
LOCK = threading.Lock()
TOTALS = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
          "model": None}


def ask_jev(state, questions, model: str = "jev-latest") -> dict:
    """One evaluation request. Returns answers plus measured cost/latency."""
    body = {"model": model, "state": state, "questions": questions}
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + (KEY or ""),
                 "Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode())
            server_ms = r.headers.get("x-envoy-upstream-service-time")
            req_id = r.headers.get("x-typesafe-request-id")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise RuntimeError("TypeSafe %s: %s" % (e.code, detail)) from None
    latency_ms = (time.perf_counter() - t0) * 1000.0

    usage = payload.get("usage", {}) or {}
    inp = int(usage.get("input_tokens", 0) or 0)
    out = int(usage.get("output_tokens", 0) or 0)
    cost = inp * PRICE_PER_MTOK_USD / 1_000_000.0

    with LOCK:
        TOTALS["calls"] += 1
        TOTALS["input_tokens"] += inp
        TOTALS["output_tokens"] += out
        TOTALS["cost_usd"] += cost
        TOTALS["model"] = payload.get("model")
        totals = dict(TOTALS)

    return {
        "answers": payload.get("answers", {}),
        "model": payload.get("model"),
        "usage": {"input_tokens": inp, "output_tokens": out},
        "cost_usd": cost,
        "latency_ms": round(latency_ms, 1),
        "server_ms": int(server_ms) if server_ms else None,
        "request_id": req_id,
        "totals": totals,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):        # keep the console quiet
        pass

    def _json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._json({"ok": True, "key_present": bool(KEY), "model": TOTALS["model"],
                        "price_per_mtok_usd": PRICE_PER_MTOK_USD, "totals": TOTALS})
            return
        if path in ("/", ""):
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            self.send_error(404, "not found")
            return
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css", ".json": "application/json"}.get(target.suffix,
                                                                      "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/ask":
            self.send_error(404, "not found")
            return
        if not KEY:
            self._json({"error": "No TYPESAFE_API_KEY found. Set it in the environment "
                                 "or in ~/.agents-md/.secrets/typesafe.env."}, 500)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n).decode() or "{}")
            result = ask_jev(payload["state"], payload["questions"],
                             payload.get("model", "jev-latest"))
            self._json(result)
        except KeyError as e:
            self._json({"error": "missing field: %s" % e}, 400)
        except Exception as e:                      # surfaced to the UI, never the key
            self._json({"error": str(e)}, 502)


if __name__ == "__main__":
    if not KEY:
        print("!! No TYPESAFE_API_KEY found — /api/ask will fail.")
    print("Jev Lab  ->  http://%s:%d   (model alias: jev-latest)" % (HOST, PORT))
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
