"""Dump the raw Arkose sprite blobs from a live count challenge to measure the
reference-row layout (where the digit and the object icon actually sit)."""

import base64
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
OUT = HERE / "results" / "sprite_dumps"
HTTP_PORT = 8643


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    OUT.mkdir(parents=True, exist_ok=True)
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
        page.on("console", lambda m: print("PAGE-CON:", m.text[:110]) if ("[CC-FunCap]" in m.text or "score" in m.text.lower()) else None)
        page.goto(f"http://127.0.0.1:{HTTP_PORT}/arkose-10-real-sessions.html")
        time.sleep(2)
        page.click("#startButton")
        print("started â€” dumping every unique challenge sprite...")

        dump_js = """async () => {
  const out = [];
  const els = [...document.querySelectorAll('img, div, canvas')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20 && getComputedStyle(el).display !== 'none';
  });
  const seen = new Set();
  for (const el of els) {
    let src = null;
    let kind = null;
    if (el.tagName === 'IMG' && el.src) { src = el.src; kind = 'img'; }
    else {
      const m = (getComputedStyle(el).backgroundImage || '').match(/url\\(["']?(.+?)["']?\\)/);
      if (m && m[1] && !m[1].includes('.svg')) { src = m[1]; kind = 'bg'; }
    }
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const info = {
      kind, src: src.slice(0, 120),
      cls: String(el.className).slice(0, 80),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bgSize: cs.backgroundSize, bgPos: cs.backgroundPosition
    };
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const buf = new FileReader();
      const b64 = await new Promise((res) => { buf.onload = () => res(buf.result); buf.readAsDataURL(blob); });
      const dims = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ nw: im.naturalWidth, nh: im.naturalHeight });
        im.onerror = () => res({ nw: -1, nh: -1 });
        im.src = b64;
      });
      out.push({ ...info, b64, dims });
    } catch (e) {
      out.push({ ...info, error: String(e) });
    }
  }
  const kf = document.querySelector('.key-frame-image, [class*="key-frame"]');
  if (kf) {
    const r = kf.getBoundingClientRect();
    const cs = getComputedStyle(kf);
    out.push({ kind: 'keyframe', cls: String(kf.className).slice(0, 80),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bgSize: cs.backgroundSize, bgPos: cs.backgroundPosition,
      bgImage: (cs.backgroundImage || '').slice(0, 120) });
  }
  return out;
}"""

        seen_sigs = set()
        dumps_done = 0
        deadline = time.time() + 180
        run_idx = 0
        last_poll_report = 0
        while time.time() < deadline and dumps_done < 3:
            polled = 0
            for f in page.frames:
                try:
                    res = f.evaluate(dump_js)
                    polled += 1
                except Exception:
                    continue
                big = [d for d in res if d.get('dims', {}).get('nw', 0) >= 300]
                if not big:
                    continue
                sig = tuple(sorted((d['dims']['nw'], d['dims']['nh']) for d in big))
                if sig in seen_sigs:
                    continue
                seen_sigs.add(sig)
                run_idx += 1
                dumps_done += 1
                print(f"\n=== sprite set #{run_idx} (sig={sig}) ===")
                for i, item in enumerate(res):
                    tag = f"s{run_idx}_{i:02d}_{item.get('kind','?')}"
                    if 'b64' in item:
                        data = item['b64'].split(',', 1)[1]
                        ext = 'png' if 'image/png' in item['b64'] else 'jpg'
                        path = OUT / f"{tag}.{ext}"
                        path.write_bytes(base64.b64decode(data))
                        print(f"{tag}: cls={item['cls'][:36]} rect={item['rect']} bg={item['bgSize']}@{item['bgPos']} dims={item['dims']} -> {path.name}")
                    else:
                        print(f"{tag}: {json.dumps({k: v for k, v in item.items() if k != 'b64'})}")
                break
            if time.time() - last_poll_report > 20:
                last_poll_report = time.time()
                print(f"polling... frames={len(page.frames)} evaluable={polled} sets={dumps_done} t={int(deadline - time.time())}s")
            time.sleep(1)

        time.sleep(2)
        ctx.close()
    httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())

