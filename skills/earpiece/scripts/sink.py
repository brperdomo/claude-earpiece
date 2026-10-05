#!/usr/bin/env python3
"""Local-only transcript sink for earpiece.

Accepts POSTs from the Zoom web client (origin https://app.zoom.us) and appends each line
to the transcript file. Binds to 127.0.0.1 only. The body is either a JSON array of lines
or {"lines": [...], "mode": "...", "err": "..."}. Every accepted POST also rewrites
<transcript_path>.hb as "<epoch seconds> <mode> <err>" so watch.sh can tell whether the
in-page recorder is still alive.

Usage: sink.py <transcript_path> [port]
Set EARPIECE_EXTRA_ORIGIN to also accept one more origin (for local testing).
"""
import http.server, json, os, re, sys, time

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath("transcript.txt")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
HB = OUT + ".hb"
MAX_BODY = 1 << 20
ALLOWED = {"https://app.zoom.us"}
if os.environ.get("EARPIECE_EXTRA_ORIGIN"):
    ALLOWED.add(os.environ["EARPIECE_EXTRA_ORIGIN"])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "a").close()


def word(s, limit):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:limit]


class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        o = self.headers.get("Origin", "")
        if o in ALLOWED:
            self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _reply(self, code):
        self.send_response(code); self._cors(); self.end_headers()

    def do_OPTIONS(self):
        self._reply(204)

    def do_POST(self):
        if self.headers.get("Origin", "") not in ALLOWED:
            return self._reply(403)
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n < 0 or n > MAX_BODY:
            return self._reply(413)
        try:
            body = json.loads(self.rfile.read(n) or b"[]")
        except ValueError:
            return self._reply(400)
        if isinstance(body, list):
            lines, mode, err = body, "", ""
        elif isinstance(body, dict):
            lines, mode, err = body.get("lines", []), body.get("mode", ""), body.get("err", "")
        else:
            return self._reply(400)
        if not isinstance(lines, list):
            return self._reply(400)
        if lines:
            with open(OUT, "a") as f:
                for l in lines:
                    f.write(str(l).replace("\n", " ") + "\n")
        with open(HB, "w") as f:
            f.write(f"{int(time.time())} {word(mode, 20).replace(' ', '-') or '-'} {word(err, 200)}\n")
        self._reply(204)

    def log_message(self, *a):
        pass


print(f"sink listening on 127.0.0.1:{PORT} -> {OUT}", flush=True)
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
