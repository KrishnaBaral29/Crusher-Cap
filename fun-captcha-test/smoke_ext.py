"""Smoke test: verify the CaptchaCrusher extension loads in Playwright's
bundled Chromium, discover its service worker / extension ID, and confirm
the SW log channel (GET_ALL_LOGS) responds."""

import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "Nopecha-Alternative"
PROFILE = HERE / "chrome_profile"


def main():
    print("extension path:", EXT)
    print("profile:", PROFILE)
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

        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        ext_id = None
        sw = None
        deadline = time.time() + 25
        while time.time() < deadline and not ext_id:
            for worker in ctx.service_workers:
                url = worker.url
                if "chrome-extension://" in url:
                    ext_id = url.split("//")[1].split("/")[0]
                    sw = worker
                    break
            if not ext_id:
                time.sleep(0.5)

        if not ext_id:
            print("NO EXTENSION SERVICE WORKER FOUND via ctx.service_workers")
            for t in ctx.pages:
                print("page:", t.url)
        else:
            print("EXTENSION ID:", ext_id)
            print("SW URL:", sw.url if sw else "?")

        # Try CDP target discovery as fallback / verification
        try:
            cdp = ctx.new_cdp_session(page)
            targets = cdp.send("Target.getTargets")
            for t in targets.get("targetInfos", []):
                if "service-worker" in t.get("type", "") and "chrome-extension://" in t.get("url", ""):
                    print("CDP SW target:", t["url"][:110])
        except Exception as e:
            print("CDP target query failed:", e)

        if ext_id:
            tap = ctx.new_page()
            tap.goto(f"chrome-extension://{ext_id}/popup/popup.html")
            time.sleep(1.5)
            logs = tap.evaluate(
                """() => new Promise((resolve) => {
                     try {
                       chrome.runtime.sendMessage({type:'GET_ALL_LOGS'}, (r) => resolve(r || null));
                     } catch (e) { resolve({error: String(e)}); }
                   })"""
            )
            count = len(logs.get("logs", [])) if isinstance(logs, dict) else -1
            print("GET_ALL_LOGS returned", count, "entries")
            if isinstance(logs, dict) and logs.get("logs"):
                for l in logs["logs"][-5:]:
                    print("  ", l.get("ts"), l.get("line")[:110])

        page.goto("about:blank")
        time.sleep(1)
        ctx.close()
    print("smoke done")


if __name__ == "__main__":
    sys.exit(main())

