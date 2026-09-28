"""Probe the Arkose tile-cell DOM: how does each of the 6 cells render its image?
Dumps outerHTML snippets, computed background properties, img srcs, and parent
clipping info so we know exactly how to crop each cell."""

import functools
import http.server
import json
import socketserver
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
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
        time.sleep(3)

        # Find the arkose frame and wait for tile cells
        cell_frame = None
        deadline = time.time() + 30
        while time.time() < deadline and not cell_frame:
            for f in page.frames:
                try:
                    n = f.evaluate("() => document.querySelectorAll('.tile-game .challenge-container button, #game_children_challenge a').length")
                    if n >= 6:
                        cell_frame = f
                        break
                except Exception:
                    pass
            if not cell_frame:
                time.sleep(1)

        if not cell_frame:
            print("no tile cells found")
            ctx.close()
            return

        print("frame url:", cell_frame.url[:120])

        probe = cell_frame.evaluate(
            """() => {
  const cells = [...document.querySelectorAll('.tile-game .challenge-container button, #game_children_challenge a')].slice(0, 2);
  function describe(el, depth) {
    if (!el || depth > 3) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const out = {
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      rect: {w: Math.round(r.width), h: Math.round(r.height)},
      styleAttr: (el.getAttribute('style') || '').slice(0, 200),
      bgImage: cs.backgroundImage.slice(0, 120),
      bgSize: cs.backgroundSize,
      bgPos: cs.backgroundPosition,
      overflow: cs.overflow,
      img: el.tagName === 'IMG' ? {src: (el.src||'').slice(0,100), nw: el.naturalWidth, nh: el.naturalHeight, style: (el.getAttribute('style')||'').slice(0,150)} : null,
      childImg: null,
      childDiv: null
    };
    const ci = el.querySelector('img');
    if (ci) {
      const cr = ci.getBoundingClientRect();
      out.childImg = {
        src: (ci.src||'').slice(0,100),
        nw: ci.naturalWidth, nh: ci.naturalHeight,
        rect: {x: Math.round(cr.x - r.x), y: Math.round(cr.y - r.y), w: Math.round(cr.width), h: Math.round(cr.height)},
        style: (ci.getAttribute('style')||'').slice(0,200),
        cls: String(ci.className).slice(0,60)
      };
    }
    const cd = el.querySelector('div');
    if (cd) out.childDiv = describe(cd, depth + 1);
    return out;
  }
  return cells.map(c => describe(c, 0));
}"""
        )
        print(json.dumps(probe, indent=2))

        cells_html = cell_frame.evaluate(
            """() => [...document.querySelectorAll('.tile-game .challenge-container button, #game_children_challenge a')].slice(0,2).map(c => c.outerHTML.slice(0, 700))"""
        )
        for h in cells_html:
            print("HTML:", h[:700])
            print("---")

        ctx.close()
    httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())

