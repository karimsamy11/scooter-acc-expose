"""A tiny stand-in for the Ollama REST API, used only by the lab tests.

Implements GET /api/tags and streaming POST /api/chat, and enforces CORS like Ollama:
only origins in the allow-list get Access-Control-Allow-Origin, so a refused origin fails in the browser.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROPOSAL = """# Single ESP32-S3 with radar-only detection

## Idea
AI text that must not overwrite the visitor's idea.

## Why it is better
AI text that must not overwrite the visitor's reason.

## How I would test it
- Measure detection range per target class on a test track.

## Architecture
- One ESP32-S3, one 24 GHz radar, external watchdog IC.

## Requirements check (FR-1 to FR-8)
- FR-8: addressed by the external watchdog. [Assumption]

## Risks and assumptions
- Radar-only detection may miss pedestrians. [Assumption]

## Validation suggestions
- End-to-end latency to propulsion cut; Pass criterion: below 20 ms.
- Detection range; Pass criterion: 95% within 30 m.

## Open questions
- Which radar module?

## Extra notes
Unknown heading should be kept.
"""


class State:
    def __init__(self, allowed_origins, models):
        self.allowed = set(allowed_origins)
        self.models = models
        self.chats = []  # request bodies received on /api/chat


def make_handler(state):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and origin in state.allowed:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path != "/api/tags":
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps({"models": [
                {"name": n, "size": 4_700_000_000, "details": {"family": "qwen2"}} for n in state.models
            ]}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/api/chat":
                self.send_response(404)
                self.end_headers()
                return
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            state.chats.append(req)
            last = req["messages"][-1]["content"]
            if "Expand the visitor's idea" in last:
                text = PROPOSAL
            elif "ECHO:" in last:
                text = last.split("ECHO:", 1)[1]
            else:
                text = ("Interesting alternative. [Suggestion]\n\n- Which perception tasks run on the ESP32-S3?\n"
                        "- How do you meet the **20 ms** fault reaction (FR-8)?")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            # stream in small pieces, deliberately splitting JSON lines across writes
            lines = b"".join(
                json.dumps({"model": req.get("model"), "message": {"role": "assistant", "content": text[i:i + 7]}, "done": False}).encode() + b"\n"
                for i in range(0, len(text), 7)
            ) + json.dumps({"model": req.get("model"), "done": True}).encode() + b"\n"
            try:
                for i in range(0, len(lines), 50):
                    self.wfile.write(lines[i:i + 50])
                    self.wfile.flush()
                    time.sleep(0.002)
            except (BrokenPipeError, ConnectionError):
                pass  # the page pressed Stop

    return H


def start(port, allowed_origins, models=("qwen2.5:7b", "nomic-embed-text")):
    state = State(allowed_origins, list(models))
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, state
