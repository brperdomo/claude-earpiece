#!/usr/bin/env python3
"""Local-only transcript sink for earpiece.

Accepts POSTs of JSON string arrays from the Zoom web client (origin https://app.zoom.us)
and appends each line to the transcript file. Binds to 127.0.0.1 only.

Usage: sink.py <transcript_path> [port]
"""
import http.server, json, os, sys

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath("transcript.txt")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
ALLOWED = {"https://app.zoom.us"}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "a").close()


class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        o = self.headers.get("Origin", "")
        if o in ALLOWED:
            self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        if self.headers.get("Origin", "") not in ALLOWED:
            self.send_response(403); self.end_headers(); return
        n = int(self.headers.get("Content-Length", 0))
        try:
            lines = json.loads(self.rfile.read(n) or b"[]")
        except ValueError:
            self.send_response(400); self.end_headers(); return
        with open(OUT, "a") as f:
            for l in lines:
                f.write(str(l).replace("\n", " ") + "\n")
        self.send_response(204); self._cors(); self.end_headers()

    def log_message(self, *a):
        pass


print(f"sink listening on 127.0.0.1:{PORT} -> {OUT}", flush=True)
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
