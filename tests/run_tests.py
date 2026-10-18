"""Runs the Engineering Lab tests in a real headless browser (Edge, Chrome or Firefox).

    python tests/run_tests.py            # unit + end-to-end
    BROWSER=/path/to/chrome-or-firefox python tests/run_tests.py

Serves the site on http://127.0.0.1:8765, starts mock Ollama servers, opens the test pages and
collects the results they POST back. Exit code 0 only if every test passes.
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

sys.path.insert(0, str(Path(__file__).parent))
import mock_ollama  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SITE_PORT, GOOD, REFUSED, DEAD = 8765, 11555, 11556, 11599
ORIGIN = f"http://127.0.0.1:{SITE_PORT}"
results: "queue.Queue[dict]" = queue.Queue()


class Site(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path != "/__result":
            self.send_response(404)
            self.end_headers()
            return
        results.put(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(204)
        self.end_headers()


def find_browser() -> str:
    cands = [os.environ.get("BROWSER", ""),
             r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
             r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
             r"C:\Program Files\Google\Chrome\Application\chrome.exe",
             "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
             shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or ""]
    for c in cands:
        if c and Path(c).exists():
            return c
    sys.exit("No Chromium-based browser found; set BROWSER=/path/to/browser")


def run_page(browser: str, url: str, timeout: int = 90) -> dict:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:  # browser may still write while exiting
        if "firefox" in Path(browser).name.lower():
            args = [browser, "--headless", "--no-remote", "--profile", profile, url]
        else:
            args = [browser, "--headless=new", "--no-first-run", "--no-default-browser-check",
                    "--disable-extensions", f"--user-data-dir={profile}", url]
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            return results.get(timeout=timeout)
        except queue.Empty:
            return {"suite": url, "pass": 0, "total": 1, "results": [{"name": "page finished", "ok": False, "err": "timeout"}]}
        finally:
            proc.kill()
            proc.wait()


def main() -> int:
    site = ThreadingHTTPServer(("127.0.0.1", SITE_PORT), partial(Site, directory=str(ROOT)))
    threading.Thread(target=site.serve_forever, daemon=True).start()
    _, good = mock_ollama.start(GOOD, [ORIGIN])
    mock_ollama.start(REFUSED, [])  # running, but refuses this origin, like Ollama without OLLAMA_ORIGINS
    browser = find_browser()
    print("browser:", browser)

    reports = [run_page(browser, f"{ORIGIN}/tests/unit.html"),
               run_page(browser, f"{ORIGIN}/tests/e2e.html?good={GOOD}&refused={REFUSED}&dead={DEAD}")]

    # What actually reached the model
    checks = []
    first = good.chats[0] if good.chats else {}
    system = (first.get("messages") or [{}])[0].get("content", "")
    checks.append(("system prompt carries rules and the public brief",
                   first.get("messages", [{}])[0].get("role") == "system" and "ENGINEERING BRIEF" in system and "FR-8" in system))
    checks.append(("brief states that parts cost is not published", "Parts cost: not published" in system))
    checks.append(("streaming request with larger context", first.get("stream") is True and first.get("options", {}).get("num_ctx") == 8192))
    expand = [c for c in good.chats if "Expand the visitor's idea" in c["messages"][-1]["content"]]
    checks.append(("expansion prompt sent as a final user turn, with the visitor's answers as data",
                   bool(expand) and "VISITOR'S ANSWERS:" in expand[0]["messages"][-1]["content"]
                   and "Idea: One MCU" in expand[0]["messages"][-1]["content"]))
    reports.append({"suite": "requests", "pass": sum(ok for _, ok in checks), "total": len(checks),
                    "results": [{"name": n, "ok": ok} for n, ok in checks]})

    failed = 0
    for r in reports:
        print(f"\n{r['suite']}: {r['pass']}/{r['total']}")
        for t in r["results"]:
            print(("  PASS " if t["ok"] else "  FAIL ") + t["name"] + ("" if t["ok"] else f"  -> {t.get('err')}"))
        failed += r["total"] - r["pass"]
    print("\nALL PASS" if not failed else f"\n{failed} FAILED")
    site.shutdown()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
