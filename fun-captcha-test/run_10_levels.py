"""10-level Arkose FunCAPTCHA serial run — instrumented harness.

Serves fun-captcha-test/ over local HTTP, launches headed Chromium with the
CaptchaCrusher extension sideloaded, clicks "Start 10-level run", and captures:

  - every extension/service-worker log line (GET_ALL_LOGS polled from popup)
  - all Qwen model replies extracted from those logs
  - page console output from every frame
  - screenshots per level + level timeline + final tokens
  - results/report.md summary

Usage:
  python run_10_levels.py            # full 10-level run
  python run_10_levels.py --quick    # smoke: boot, click start, watch 60s
"""

import argparse
import functools
import http.server
import json
import re
import socketserver
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "Nopecha-Alternative"
PROFILE = HERE / "chrome_profile"
RESULTS = HERE / "results"
SHOTS = RESULTS / "screenshots"

PAGE_NAME = "arkose-10-real-sessions.html"
HTTP_PORT = 8642


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=str(HERE))
    httpd = socketserver.TCPServer(("127.0.0.1", HTTP_PORT), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


QWEN_LINE = re.compile(r"(FUNCAPTCHA|funcaptcha|VISION|vision|FUNCAPTCHA-TILE)")

INTERESTING = re.compile(
    r"(funcaptcha|FUNCAPTCHA|arkose|Arkose|vision|VISION|carousel|gatekeeper|submit|"
    r"challenge|detected|DETECTED|tile|orientation|digit|sprite|rotat|WARN|error|Error)",
    re.IGNORECASE,
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="60s smoke run")
    args = ap.parse_args()

    RESULTS.mkdir(exist_ok=True)
    SHOTS.mkdir(exist_ok=True)

    httpd = start_server()

    run_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Fresh profile per run — prevents Chrome from reusing a stale browser
    # process / cached extension code from a previous run.
    PROFILE_RUN = RESULTS / "profiles" / f"profile_{run_stamp}"
    PROFILE_RUN.mkdir(parents=True, exist_ok=True)
    print("profile:", PROFILE_RUN)
    sw_log_path = RESULTS / f"sw_logs_{run_stamp}.jsonl"
    qwen_path = RESULTS / f"qwen_replies_{run_stamp}.txt"
    console_path = RESULTS / f"page_console_{run_stamp}.txt"
    timeline_path = RESULTS / f"timeline_{run_stamp}.json"
    report_path = RESULTS / f"report_{run_stamp}.md"

    sw_file = open(sw_log_path, "w", encoding="utf-8")
    qwen_file = open(qwen_path, "w", encoding="utf-8")
    console_file = open(console_path, "w", encoding="utf-8")

    seen_log_keys = set()
    qwen_count = [0]
    console_count = [0]
    pending_mid_snap = [None]
    timeline = {"levels": [], "started": datetime.now().isoformat()}

    def note_console(msg):
        try:
            text = msg.text
            if not INTERESTING.search(text):
                return
            line = f"[{datetime.now().strftime('%H:%M:%S')}] {text}"
            console_file.write(line + "\n")
            console_file.flush()
            console_count[0] += 1
            print("CONSOLE:", text[:170])
        except Exception:
            pass

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_RUN),
            headless=False,
            viewport=None,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1500,1050",
                "--window-position=40,20",
            ],
        )

        # Attach console capture to every page (current + future)
        for pg in ctx.pages:
            pg.on("console", note_console)

        def on_page(pg):
            pg.on("console", note_console)
        ctx.on("page", on_page)

        # Discover extension id
        ext_id = None
        deadline = time.time() + 25
        while time.time() < deadline and not ext_id:
            for worker in ctx.service_workers:
                if "chrome-extension://" in worker.url:
                    ext_id = worker.url.split("//")[1].split("/")[0]
                    break
            if not ext_id:
                time.sleep(0.4)
        if not ext_id:
            print("FATAL: extension service worker not found")
            return 2
        print("extension id:", ext_id)

        # Poll SW logs from a dedicated extension tab
        tap = ctx.new_page()
        tap.goto(f"chrome-extension://{ext_id}/popup/popup.html")
        tap.on("console", note_console)
        time.sleep(1.0)

        def poll_sw_logs():
            try:
                resp = tap.evaluate(
                    """() => new Promise((resolve) => {
                         try {
                           chrome.runtime.sendMessage({type:'GET_ALL_LOGS'}, (r) => resolve(r || null));
                         } catch (e) { resolve(null); }
                       })"""
                )
            except Exception:
                return
            if not resp or not isinstance(resp, dict):
                return
            for entry in resp.get("logs", []):
                key = (entry.get("ts"), entry.get("tabId"), entry.get("line"))
                if key in seen_log_keys:
                    continue
                seen_log_keys.add(key)
                sw_file.write(json.dumps(entry) + "\n")
                sw_file.flush()
                line = entry.get("line", "")
                if QWEN_LINE.search(line):
                    qwen_count[0] += 1
                    qwen_file.write(f'[{entry.get("ts")}] {line}\n')
                    qwen_file.flush()
                    print("SW-QWEN:", line[:190])
                elif INTERESTING.search(line):
                    print("SW:", line[:190])

        # Main page
        page = ctx.new_page()
        page.on("console", note_console)
        url = f"http://127.0.0.1:{HTTP_PORT}/{PAGE_NAME}"
        print("opening", url)
        page.goto(url, wait_until="domcontentloaded")
        time.sleep(2)

        # Reset any stale state then start
        state = {"score": -1, "title": "", "level": 0, "stuck_since": time.time()}
        last_change = time.time()

        def read_state():
            try:
                return page.evaluate(
                    """() => ({
                        score: parseInt((document.getElementById('score')||{}).textContent||'0',10),
                        eyebrow: (document.getElementById('eyebrow')||{}).textContent||'',
                        title: (document.getElementById('stageTitle')||{}).textContent||'',
                        status: (document.getElementById('statusText')||{}).textContent||'',
                        tokens: (document.getElementById('tokens')||{}).textContent||''
                    })"""
                )
            except Exception:
                return None

        page.click("#startButton")
        print("clicked Start 10-level run")
        timeline["clicked_start"] = datetime.now().isoformat()
        time.sleep(4)

        # Baseline: after start the score reads 0/10 — adopt it so only the
        # first *real* completion (1..10) registers as a level transition.
        st0 = read_state()
        if st0:
            state["score"] = st0["score"]
            print("baseline score:", st0["score"])

        quick = args.quick
        hard_deadline = time.time() + (90 if quick else 45 * 60)

        while time.time() < hard_deadline:
            poll_sw_logs()

            # mid-level screenshot (deferred, main thread only)
            if pending_mid_snap[0] and time.time() >= pending_mid_snap[0]:
                pending_mid_snap[0] = None
                stm = read_state()
                if stm:
                    page.screenshot(path=str(SHOTS / f"level_{stm['score']+1:02d}_active.png"))
                    print(f"== mid-level shot for level {stm['score']+1}")

            st = read_state()
            if st:
                if st["score"] != state["score"]:
                    state["score"] = st["score"]
                    state["title"] = st["title"]
                    state["level"] = st["score"]

                    # level just finished (or advanced)
                    lvl = st["score"]
                    tag = f"level_{lvl:02d}_done"
                    page.screenshot(path=str(SHOTS / f"{tag}.png"))
                    timeline["levels"].append(
                        {
                            "level_done": lvl,
                            "stage_title": st["title"],
                            "eyebrow": st["eyebrow"],
                            "status": st["status"],
                            "at": datetime.now().isoformat(),
                        }
                    )
                    print(f"== level {lvl}/10 complete :: {st['title']} :: {st['status'][:80]}")

                    if lvl >= 10:
                        print("ALL 10 LEVELS COMPLETE")
                        break

                    # incremental image archive so nothing is lost on a crash
                    try:
                        imgs = tap.evaluate(
                            """() => new Promise((resolve) => {
                                 try {
                                   chrome.runtime.sendMessage({type:'GET_SOLVE_IMAGES'}, (r) => resolve(r || null));
                                 } catch (e) { resolve(null); }
                               })"""
                        )
                        dump_dir = RESULTS / "solve_images"
                        dump_dir.mkdir(exist_ok=True)
                        for i, im in enumerate((imgs or {}).get("images", [])):
                            try:
                                ext = "png" if "png" in (im.get("mime") or "") else "jpg"
                                safe_label = re.sub(r"[^A-Za-z0-9_\-]", "_", str(im.get("label", "img")))[:40]
                                fn = dump_dir / f"{i:02d}_{safe_label}.{ext}"
                                if not fn.exists():
                                    fn.write_bytes(__import__("base64").b64decode(im.get("b64", "")))
                            except Exception:
                                pass
                    except Exception:
                        pass

                    pending_mid_snap[0] = time.time() + 7
                    last_change = time.time()

                if st["eyebrow"]:
                    state["title"] = st["title"]

                # stall watchdog
                if time.time() - last_change > (60 if quick else 360):
                    print("WATCHDOG: no progress for a long while — dumping state")
                    page.screenshot(path=str(SHOTS / "stall_state.png"))
                    timeline["stall"] = read_state()
                    break
            else:
                pass
            time.sleep(1.0)

        # Final capture
        time.sleep(2)
        final = read_state() or {}
        timeline["final"] = final
        timeline["ended"] = datetime.now().isoformat()
        page.screenshot(path=str(SHOTS / "final.png"))
        try:
            tokens_text = (final.get("tokens") or "")
            (RESULTS / f"tokens_{run_stamp}.txt").write_text(tokens_text, encoding="utf-8")
        except Exception:
            pass

        # Archive the exact images sent to Qwen (before the context closes)
        try:
            imgs = tap.evaluate(
                """() => new Promise((resolve) => {
                     try {
                       chrome.runtime.sendMessage({type:'GET_SOLVE_IMAGES'}, (r) => resolve(r || null));
                     } catch (e) { resolve(null); }
                   })"""
            )
            dump_dir = RESULTS / "solve_images"
            dump_dir.mkdir(exist_ok=True)
            saved = 0
            for i, im in enumerate((imgs or {}).get("images", [])):
                try:
                    ext = "png" if "png" in (im.get("mime") or "") else "jpg"
                    safe_label = re.sub(r"[^A-Za-z0-9_\-]", "_", str(im.get("label", "img")))[:40]
                    fn = dump_dir / f"{i:02d}_{safe_label}.{ext}"
                    fn.write_bytes(__import__("base64").b64decode(im.get("b64", "")))
                    saved += 1
                except Exception:
                    pass
            print("saved", saved, "solve images to", dump_dir)
        except Exception as e:
            print("solve image dump failed:", e)

        # A last raw log sweep
        for _ in range(4):
            poll_sw_logs()
            time.sleep(0.6)

        ctx.close()

    sw_file.close()
    qwen_file.close()
    console_file.close()

    # ---- Build report ----
    with open(report_path, "w", encoding="utf-8") as r:
        r.write(f"# 10-Level FunCAPTCHA Run — {run_stamp}\n\n")
        r.write(f"- Started: {timeline.get('started')}\n")
        r.write(f"- Ended:   {timeline.get('ended')}\n")
        fin = timeline.get("final", {})
        r.write(f"- Final score: {fin.get('score')} / 10\n")
        r.write(f"- Qwen reply lines captured: {qwen_count[0]}\n")
        r.write(f"- Console lines captured: {console_count[0]}\n")
        r.write(f"- SW log entries: {len(seen_log_keys)}\n\n")
        r.write("## Level timeline\n\n")
        for lv in timeline.get("levels", []):
            r.write(f"- Level {lv['level_done']}: {lv['stage_title']} | {lv['status']}\n")
        r.write("\n## Tokens\n\n```\n")
        r.write((fin.get("tokens") or "none")[:4000])
        r.write("\n```\n")

    print("\n=== artifacts ===")
    print("sw logs   :", sw_log_path)
    print("qwen      :", qwen_path)
    print("console   :", console_path)
    print("timeline  :", timeline_path)
    print("report    :", report_path)
    print("shots     :", SHOTS)
    timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
