"""Diagnose blob access from Playwright evaluate inside the Arkose frame."""

import functools
import http.server
import socketserver
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "Nopecha-Alternative"
PROFILE = HERE / "results" / "profiles" / "probe_profile"
HTTP_PORT = 8643


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    handler = functools.partial(QuietHandler, directory=str(HERE))
    httpd = socketserver.TCPServer(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE),
            headless=False,
            viewport=None,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1400,1000",
            ],
        )
        page = ctx.new_page()
        page.goto(f"http://127.0.0.1:{HTTP_PORT}/arkose-10-real-sessions.html")
        time.sleep(2)
        page.click("#startButton")

        diag_js = """() => {
  const out = { frameUrl: location.href.slice(0, 90), candidates: [] };
  const els = [...document.querySelectorAll('img, div, canvas')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20 && getComputedStyle(el).display !== 'none';
  });
  for (const el of els.slice(0, 10)) {
    let src = null;
    if (el.tagName === 'IMG' && el.src) src = el.src;
    else {
      const m = (getComputedStyle(el).backgroundImage || '').match(/url\\(["']?(.+?)["']?\\)/);
      if (m && m[1] && !m[1].includes('.svg')) src = m[1];
    }
    if (!src) continue;
    const entry = {
      tag: el.tagName, cls: String(el.className).slice(0, 40), src: src.slice(0, 80),
      nw: el.naturalWidth !== undefined ? el.naturalWidth : null,
      nh: el.naturalHeight !== undefined ? el.naturalHeight : null
    };
    out.candidates.push(entry);
  }
  return out;
}"""

        fetch_js = """async (url) => {
  try {
    const r = await fetch(url);
    const b = await r.blob();
    return 'OK size=' + b.size + ' type=' + b.type;
  } catch (e) {
    return 'ERR ' + String(e).slice(0, 120);
  }
}"""

        deadline = time.time() + 90
        done = False
        while time.time() < deadline and not done:
            for f in page.frames:
                try:
                    d = f.evaluate(diag_js)
                except Exception:
                    continue
                if not d["candidates"]:
                    continue
                print(f"\nFRAME: {d['frameUrl']}")
                for c in d["candidates"][:6]:
                    print("  ", c["tag"], c["cls"][:28], "nat=", c["nw"], "x", c["nh"], "src=", c["src"][:60])
                # try fetching the widest one
                big = max(d["candidates"], key=lambda c: (c["nw"] or 0))
                if big["src"] and big["src"].startswith("blob:"):
                    res = f.evaluate(fetch_js, big["src"])
                    print("  FETCH:", big["src"][:50], "â†’", res)
                    if res.startswith("OK"):
                        done = True
            time.sleep(1)

        time.sleep(2)
        ctx.close()
    httpd.shutdown()


if __name__ == "__main__":
    main()

