import asyncio
import io
import os
from pathlib import Path
import random
import re
import string
import time
from playwright.async_api import async_playwright


BROWSER_PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brave_profile")
import concurrent.futures
import requests

PROXIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxies.txt")
GOOD_PROXIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "good_proxies.txt")


def load_good_proxies():
    if not os.path.exists(GOOD_PROXIES_FILE):
        return []
    with open(GOOD_PROXIES_FILE, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return lines


def save_good_proxy(proxy_line):
    existing = set(load_good_proxies())
    if proxy_line and proxy_line not in existing:
        with open(GOOD_PROXIES_FILE, "a", encoding="utf-8") as f:
            f.write(proxy_line + "\n")
        print(f"🌟 Saved successful working proxy to: {GOOD_PROXIES_FILE} -> {proxy_line}")


def load_saved_proxies():
    if not os.path.exists(PROXIES_FILE):
        return []
    with open(PROXIES_FILE, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return lines


def get_brave_path():
    candidates = [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


NOPECHA_EXTENSION_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nopecha_extension")
BUSTER_EXTENSION_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "buster_extension")
CAPTCHA_CRUSHER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Nopecha-Alternative")


def get_installed_extensions():
    exts = []
    # CaptchaCrusher first — it's the primary audio solver (no API key needed)
    if os.path.exists(os.path.join(CAPTCHA_CRUSHER_DIR, "manifest.json")):
        exts.append(CAPTCHA_CRUSHER_DIR)
    if os.path.exists(os.path.join(NOPECHA_EXTENSION_DIR, "manifest.json")):
        exts.append(NOPECHA_EXTENSION_DIR)
    if os.path.exists(os.path.join(BUSTER_EXTENSION_DIR, "manifest.json")):
        exts.append(BUSTER_EXTENSION_DIR)
    return exts



def generate_password(length=12):
    chars = string.ascii_lowercase + string.digits + "!@#$%^&*"
    pw = [
        random.choice(string.ascii_uppercase),
        random.choice(string.digits),
        random.choice("!@#$%^&*"),
    ]
    pw += random.choices(chars, k=length - len(pw))
    random.shuffle(pw)
    return "".join(pw)


def load_saved_proxies():
    if not os.path.exists(PROXIES_FILE):
        return []
    with open(PROXIES_FILE, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return lines


def test_single_proxy(proxy_info):
    ip = proxy_info.get("ip")
    port = proxy_info.get("port")
    proto = proxy_info.get("protocols", ["http"])[0]
    proxy_url = f"{proto}://{ip}:{port}"
    proxies = {"http": proxy_url, "https": proxy_url}
    try:
        resp = requests.get("https://httpbin.org/ip", proxies=proxies, timeout=4)
        if resp.status_code == 200:
            return {
                "server": f"http://{ip}:{port}",
                "ip": ip,
                "port": port,
                "latency": proxy_info.get("latency", 0),
            }
    except Exception:
        pass
    return None


def find_verified_geonode_proxy():
    print("🔍 Fetching & testing stable free proxies from Geonode...")
    url = "https://proxylist.geonode.com/api/proxy-list?limit=40&page=1&sort_by=upTime&sort_type=desc&protocols=http%2Chttps"
    try:
        r = requests.get(url, timeout=8)
        if r.status_code != 200:
            return None
        proxy_list = r.json().get("data", [])
    except Exception as e:
        print(f"  error querying Geonode API: {e}")
        return None

    # Test top candidates concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(test_single_proxy, p) for p in proxy_list[:25]]
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            if res:
                print(f"  ⚡ Found verified working proxy: {res['server']} (latency: {res['latency']}ms)")
                return res
    print("  No responsive Geonode proxy found, using fallback.")
    return None


async def get_email_from_6d6f(email_page):
    print("opening / clearing 6d6f mailbox for a fresh address...")
    for retry in range(3):
        try:
            await email_page.goto("https://www.6d6f.com/mailbox", wait_until="domcontentloaded", timeout=60000)
            break
        except Exception as e:
            print(f"  retry {retry+1}: {e}")
            await email_page.wait_for_timeout(3000)

    # Click Delete button on 6d6f to ensure a brand-new, fresh temp email is generated
    try:
        del_btn = await email_page.query_selector("div.actions div:has-text('Delete'), [wire\\:click*='deleteEmail'], div:has(.fa-trash-alt)")
        if del_btn:
            await del_btn.click()
            print("clicked Delete on 6d6f to generate a brand new fresh email")
            await email_page.wait_for_timeout(2500)
    except Exception:
        pass

    await email_page.wait_for_timeout(2000)

    # Wait for #email_id to have a valid email string
    email_text = ""
    for _ in range(15):
        try:
            el = await email_page.query_selector("#email_id")
            if el:
                email_text = (await el.inner_text()).strip()
                if email_text and "@" in email_text:
                    break
        except Exception:
            pass
        await email_page.wait_for_timeout(1000)

    copy_btn = await email_page.query_selector(".btn_copy")
    if copy_btn:
        try:
            await copy_btn.click()
            print("clicked Copy on 6d6f")
        except Exception:
            pass

    print(f"Generated fresh email: {email_text}")
    return email_text


async def check_email_exists_error(page):
    try:
        return await page.evaluate("""() => {
            const bodyText = document.body.innerText;
            if (bodyText.includes('Email address already exists') || bodyText.includes('already exists')) {
                return true;
            }
            const errEl = document.querySelector('.text-danger, .invalid-feedback, .error, [class*="error"]');
            if (errEl && errEl.innerText.toLowerCase().includes('already exists')) {
                return true;
            }
            return false;
        }""")
    except Exception:
        return False


async def solve_recaptcha(page):
    print("\nWaiting for NopeCHA extension to solve reCAPTCHA (up to 2m 30s)...")
    for second in range(150):
        # Check if navigated away from register
        if "register" not in page.url:
            print(f"  Navigated to: {page.url}")
            return True

        # Check if email duplicate error appeared
        if await check_email_exists_error(page):
            print("  Email already exists error detected!")
            return False

        # Check if reCAPTCHA checkbox is checked
        for frame in page.frames:
            if "recaptcha/api2/anchor" in frame.url:
                try:
                    checked = await frame.evaluate("""() => {
                        const el = document.querySelector('.recaptcha-checkbox');
                        return el ? el.classList.contains('recaptcha-checkbox-checked') : false;
                    }""")
                    if checked:
                        print("  reCAPTCHA checkbox solved by extension!")
                        return True
                except Exception:
                    pass

        # Trigger anchor click if not yet clicked
        if second == 2:
            for frame in page.frames:
                if "recaptcha/api2/anchor" in frame.url:
                    try:
                        await frame.evaluate("""() => {
                            let el = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox') || document.querySelector('[role="checkbox"]');
                            if (el) el.click();
                        }""")
                    except Exception:
                        pass

        # Trigger Buster solver button if an audio/image challenge popup is open
        for frame in page.frames:
            if "recaptcha/api2/bframe" in frame.url:
                try:
                    await frame.evaluate("""() => {
                        const busterBtn = document.querySelector('#solver-button, .help-button-holder, .rc-button-default, .rc-audiochallenge-control');
                        if (busterBtn) busterBtn.click();
                    }""")
                except Exception:
                    pass

        if second % 5 == 0 and second > 0:
            print(f"  waiting for CAPTCHA solver extension... ({second}s / 150s)")

        await page.wait_for_timeout(1000)

    print("  Extension solve wait finished (150s limit reached).")
    return False


async def verify_webshare_email_on_6d6f(email_page, webshare_page):
    print("\n--- Checking for Webshare Verification Email on 6d6f ---")
    await email_page.bring_to_front()
    verify_url = None

    for attempt in range(20):
        print(f"  polling inbox (attempt {attempt + 1}/20)...")

        result = await email_page.evaluate("""() => {
            const checkAnchors = (doc) => {
                const anchors = doc.querySelectorAll('a');
                for (const a of anchors) {
                    const h = a.href || a.getAttribute('href') || '';
                    if (h.includes('webshare.io/activation') && h.includes('confirm')) {
                        return h;
                    }
                }
                return null;
            };

            let u = checkAnchors(document);
            if (u) return { url: u, found: true };

            const iframes = document.querySelectorAll('iframe');
            for (const ifr of iframes) {
                try {
                    const ifrDoc = ifr.contentDocument || ifr.contentWindow.document;
                    if (ifrDoc) {
                        u = checkAnchors(ifrDoc);
                        if (u) return { url: u, found: true };
                        const m = ifrDoc.body.innerHTML.match(/https:\\/\\/[^\\s"'<>]*webshare\\.io\\/activation[^\\s"'<>]*confirm[^\\s"'<>!]*/i);
                        if (m) return { url: m[0], found: true };
                    }
                } catch (e) {}
            }

            const m = document.body.innerHTML.match(/https:\\/\\/[^\\s"'<>]*webshare\\.io\\/activation[^\\s"'<>]*confirm[^\\s"'<>!]*/i);
            if (m) return { url: m[0], found: true };

            const rows = document.querySelectorAll('table tbody tr, .cursor-pointer, [wire\\\\:click*="fetchMessage"], [wire\\\\:click*="show"], .in-app-page tr');
            for (const r of rows) {
                const txt = r.innerText.toLowerCase();
                if (txt.includes('webshare') || txt.includes('verify') || txt.includes('account')) {
                    r.click();
                    const sub = r.querySelectorAll('a, button, td, span, div');
                    sub.forEach(el => el.click());
                    return { clicked: true };
                }
            }

            return { found: false };
        }""")

        if result and result.get("url"):
            verify_url = result["url"]
            print(f"  ⚡ Found verification link: {verify_url}")
            break
        elif result and result.get("clicked"):
            print("  ⚡ Opened message, waiting for link...")
            await email_page.wait_for_timeout(1000)

        # Trigger refresh on 6d6f
        try:
            refresh_btn = await email_page.query_selector("#refresh, div.actions div:has-text('Refresh')")
            if refresh_btn:
                await refresh_btn.click()
        except Exception:
            pass

        await email_page.wait_for_timeout(1500)

    if verify_url:
        print(f"\n⚡ Navigating to verification link in Webshare tab...")
        await webshare_page.bring_to_front()
        await webshare_page.goto(verify_url, wait_until="domcontentloaded")
        await webshare_page.wait_for_timeout(3000)
        print("✅ Email verification confirmed!")

        # Always navigate to dashboard first
        print("Navigating to https://dashboard.webshare.io/dashboard ...")
        await webshare_page.goto("https://dashboard.webshare.io/dashboard", wait_until="domcontentloaded")
        await webshare_page.wait_for_timeout(3000)
        return True
    else:
        print("❌ Failed: Verification email was not received within 30 seconds.")
        return False


async def extract_webshare_proxies(webshare_page):
    await webshare_page.bring_to_front()

    print("\n--- Navigating to Proxy List & Extracting Proxies ---")

    # Step 1: Ensure clean dashboard page without popups
    if "dashboard" not in webshare_page.url or "showQuickStart" in webshare_page.url:
        print("Navigating cleanly to https://dashboard.webshare.io/dashboard ...")
        await webshare_page.goto("https://dashboard.webshare.io/dashboard", wait_until="domcontentloaded")
        await webshare_page.wait_for_timeout(2000)

    # Check if any popup/modal appeared and dismiss it
    has_popup = await webshare_page.evaluate("""() => {
        const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="backdrop"], [class*="overlay"]');
        if (modal) {
            const closeBtn = modal.querySelector('button, [aria-label="Close"], svg');
            if (closeBtn) closeBtn.click();
            return true;
        }
        return false;
    }""")
    if has_popup:
        print("Popup detected! Dismissing and refreshing clean dashboard...")
        await webshare_page.keyboard.press("Escape")
        await webshare_page.wait_for_timeout(500)
        await webshare_page.goto("https://dashboard.webshare.io/dashboard", wait_until="domcontentloaded")
        await webshare_page.wait_for_timeout(2000)

    print(f"Current page URL: {webshare_page.url}")

    # Step 2: Click "View My Proxy List" button using Playwright's native locator click
    print("Clicking 'View My Proxy List' button on dashboard...")
    clicked = False
    try:
        btn = webshare_page.locator("button:has-text('View My Proxy List'), a:has-text('View My Proxy List')").first
        if await btn.is_visible(timeout=4000):
            await btn.click()
            clicked = True
            print("  Successfully clicked 'View My Proxy List' via Playwright locator!")
    except Exception as e:
        print(f"  Locator click attempt: {e}")

    if not clicked:
        clicked = await webshare_page.evaluate("""() => {
            const elements = Array.from(document.querySelectorAll('button, a, div'));
            const btn = elements.find(el => el.innerText && el.innerText.trim().toLowerCase().includes('view my proxy list'));
            if (btn) {
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                btn.click();
                return true;
            }
            return false;
        }""")
        if clicked:
            print("  Clicked 'View My Proxy List' via JS dispatch!")

    # Fallback: If still not navigated after 2s, click sidebar Free -> Proxy List
    await webshare_page.wait_for_timeout(2000)
    if "proxy/list" not in webshare_page.url:
        print("Checking sidebar fallback (Free -> Proxy List)...")
        try:
            free_btn = webshare_page.locator("text='Free', button:has-text('Free'), div:has-text('Free')").first
            if await free_btn.is_visible(timeout=2000):
                await free_btn.click()
                await webshare_page.wait_for_timeout(1000)
            pl_btn = webshare_page.locator("a:has-text('Proxy List'), div:has-text('Proxy List'), text='Proxy List'").first
            if await pl_btn.is_visible(timeout=2000):
                await pl_btn.click()
                print("  Clicked Proxy List from sidebar!")
        except Exception:
            pass

    # Wait 5 seconds for proxies to load dynamically as requested
    print("Waiting 5 seconds for proxies to load dynamically...")
    await webshare_page.wait_for_timeout(5000)
    print(f"Current page URL: {webshare_page.url}")

    # Step 3: Wait up to 20 seconds for the dynamic table to populate
    for sec in range(20):
        has_table = await webshare_page.evaluate("""() => {
            const ipRegex = /\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b/;
            const rows = document.querySelectorAll('table tbody tr, tbody tr, [role="row"]');
            for (const r of rows) {
                if (ipRegex.test(r.innerText)) return true;
            }
            return false;
        }""")
        if has_table:
            print("Proxy table loaded successfully!")
            break
        await webshare_page.wait_for_timeout(1000)

    # Step 4: Extract all 10 proxies dynamically via JS
    proxies = await webshare_page.evaluate("""() => {
        const results = [];
        const ipRegex = /^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/;
        const rows = document.querySelectorAll('table tbody tr, tbody tr, tr, [role="row"]');

        for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td, [role="cell"], span, div'))
                .map(c => c.innerText.trim())
                .filter(t => t.length > 0);

            const clean = [];
            for (const c of cells) {
                if (clean.length === 0 || clean[clean.length - 1] !== c) {
                    clean.push(c);
                }
            }

            const ipIdx = clean.findIndex(c => ipRegex.test(c));
            if (ipIdx !== -1 && ipIdx + 3 < clean.length) {
                const ip = clean[ipIdx];
                const port = clean[ipIdx + 1];
                const user = clean[ipIdx + 2];
                const pass = clean[ipIdx + 3];

                if (/^\\d{2,5}$/.test(port) && user && pass && !user.includes('.') && !pass.includes('ago') && !pass.includes('Working')) {
                    const formatted = `${ip}:${port}:${user}:${pass}`;
                    if (!results.some(r => r.formatted === formatted)) {
                        results.push({ ip, port, user, pass, formatted });
                    }
                }
            }
        }

        if (results.length === 0) {
            const allText = document.body.innerText;
            const matches = allText.matchAll(/(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\s+(\\d{2,5})\\s+([a-zA-Z0-9_-]+)\\s+([a-zA-Z0-9_-]+)/g);
            for (const m of matches) {
                const formatted = `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
                if (!results.some(r => r.formatted === formatted)) {
                    results.push({ ip: m[1], port: m[2], user: m[3], pass: m[4], formatted });
                }
            }
        }

        return results;
    }""")

    print(f"\n🔥 Extracted {len(proxies)} Proxies:")
    proxy_lines = []
    for idx, p in enumerate(proxies, 1):
        formatted = p.get('formatted')
        print(f"  {idx}. {formatted}")
        proxy_lines.append(formatted)

    if proxy_lines:
        existing = set()
        if os.path.exists(PROXIES_FILE):
            with open(PROXIES_FILE, "r", encoding="utf-8") as f:
                existing = set(line.strip() for line in f if line.strip())

        new_proxies = [p for p in proxy_lines if p not in existing]
        with open(PROXIES_FILE, "a", encoding="utf-8") as f:
            for p in new_proxies:
                f.write(p + "\n")
        print(f"\n✅ Saved {len(new_proxies)} new proxies (Total in file: {len(existing) + len(new_proxies)}) to: {PROXIES_FILE}")

    return proxies


async def process_single_account(account_num, total_accounts):
    password = generate_password()
    print(f"Password generated: {password}")

    brave_path = get_brave_path()
    if brave_path:
        print(f"Launching Brave Browser from: {brave_path}")
    else:
        print("Brave Browser not found in standard paths, falling back to Chrome channel")

    # Load verified proxy (prioritizes good_proxies.txt, then proxies.txt)
    chosen_proxy = None
    chosen_proxy_raw = None
    good_proxies = load_good_proxies()
    saved_proxies = load_saved_proxies()
    candidate_proxies = good_proxies if good_proxies else saved_proxies

    if candidate_proxies:
        chosen = random.choice(candidate_proxies)
        chosen_proxy_raw = chosen
        parts = chosen.split(":")
        source_label = "good_proxies.txt" if good_proxies else "proxies.txt"
        if len(parts) == 4:
            ip, port, u, pw = parts
            chosen_proxy = {"server": f"http://{ip}:{port}", "username": u, "password": pw}
            print(f"🛡️ Using proxy from {source_label}: {ip}:{port} (authenticated)")
        elif len(parts) == 2:
            ip, port = parts
            chosen_proxy = {"server": f"http://{ip}:{port}"}
            print(f"🛡️ Using proxy from {source_label}: {ip}:{port}")

    import subprocess, socket

    def find_free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('', 0))
            return s.getsockname()[1]

    debug_port = find_free_port()

    # Build Brave launch command — launched as a NORMAL process, not by Playwright
    brave_args = [
        brave_path or "chrome",
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={BROWSER_PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--start-maximized",
    ]

    if chosen_proxy:
        proxy_server = chosen_proxy["server"]
        brave_args.append(f"--proxy-server={proxy_server}")
        brave_args.append("--proxy-bypass-list=<-loopback>;*.nopecha.com;api.nopecha.com")

    ext_dirs = get_installed_extensions()
    if ext_dirs:
        ext_str = ",".join(ext_dirs)
        print(f"🧩 Loading extensions: {[os.path.basename(e) for e in ext_dirs]}")
        brave_args.append(f"--load-extension={ext_str}")
        brave_args.append(f"--disable-extensions-except={ext_str}")
    else:
        print("⚠️ No extensions found in workspace")

    print(f"🚀 Launching Brave normally on debug port {debug_port}...")
    brave_proc = subprocess.Popen(brave_args)

    # Wait for Brave to start and open the debug port
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", debug_port), timeout=1):
                break
        except (ConnectionRefusedError, OSError):
            await asyncio.sleep(0.5)
    else:
        print("❌ Brave failed to start. Aborting.")
        brave_proc.kill()
        return False

    async with async_playwright() as p:
        # Connect to the already-running Brave via CDP — completely undetectable
        browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{debug_port}")
        context = browser.contexts[0]

        # Automatic proxy authentication handler for CDP
        async def setup_page_proxy_auth(page):
            if chosen_proxy and "username" in chosen_proxy:
                try:
                    cdp = await context.new_cdp_session(page)
                    await cdp.send('Fetch.enable', {'handleAuthRequests': True})

                    async def handle_auth(event):
                        if event.get('responseStatusCode') == 407 or 'authChallenge' in event:
                            await cdp.send('Fetch.continueWithAuth', {
                                'requestId': event['requestId'],
                                'authChallengeResponse': {
                                    'response': 'ProvideCredentials',
                                    'username': chosen_proxy['username'],
                                    'password': chosen_proxy['password']
                                }
                            })
                        else:
                            try:
                                await cdp.send('Fetch.continueRequest', {'requestId': event['requestId']})
                            except Exception:
                                pass

                    cdp.on('Fetch.authRequired', handle_auth)
                    cdp.on('Fetch.requestPaused', lambda ev: asyncio.create_task(handle_auth(ev)))
                except Exception:
                    pass

        context.on('page', lambda page: asyncio.create_task(setup_page_proxy_auth(page)))
        for p_page in context.pages:
            await setup_page_proxy_auth(p_page)

        # Clear cookies & sessions so every lot starts with fresh temp mail & fresh webshare session
        print("Clearing site cookies for fresh session...")
        await context.clear_cookies()

        # Confirm outgoing IP via proxy
        if chosen_proxy:
            try:
                check_tab = await context.new_page()
                await check_tab.goto("http://ipv4.webshare.io/", timeout=10000)
                current_ip = (await check_tab.inner_text("body")).strip()
                print(f"🔒 Outgoing IP confirmed: {current_ip} (Proxy Active)")
                await check_tab.close()
            except Exception:
                pass

        # Close leftover tabs
        if len(context.pages) > 1:
            for old_tab in context.pages[1:]:
                try:
                    await old_tab.close()
                except Exception:
                    pass

        # Tab 1: 6d6f Mailbox (Kept open permanently for receiving verification link)
        email_page = context.pages[0] if context.pages else await context.new_page()
        await setup_page_proxy_auth(email_page)
        email_text = await get_email_from_6d6f(email_page)

        # Tab 2: Webshare Registration
        print("\nOpening Webshare register in a new tab (keeping 6d6f mailbox open)...")
        webshare_page = await context.new_page()
        await setup_page_proxy_auth(webshare_page)
        await webshare_page.goto("https://dashboard.webshare.io/register/?source=nav_register", wait_until="domcontentloaded")
        await webshare_page.wait_for_timeout(3000)

        # Registration attempt loop
        while True:
            await webshare_page.bring_to_front()
            print(f"\nAttempting registration with email: {email_text}")

            email_input = await webshare_page.query_selector("input[name='email'], input[type='email']")
            if email_input:
                await email_input.click()
                await email_input.fill("")
                await email_input.fill(email_text)
                print(f"filled email: {email_text}")

            pw_input = await webshare_page.query_selector("input[name='password'], input[type='password']")
            if pw_input:
                await pw_input.click()
                await pw_input.fill("")
                await pw_input.fill(password)
                print("filled password")

            tos = await webshare_page.query_selector("input[type='checkbox']")
            if tos:
                if not await tos.is_checked():
                    await tos.click()
                    print("checked TOS")

            await webshare_page.wait_for_timeout(500)

            submit = await webshare_page.query_selector("button:has-text('Sign Up With Email')")
            if submit:
                await submit.click()
                print("clicked submit")

            await webshare_page.wait_for_timeout(2500)

            # Check if Webshare threw "Email address already exists."
            if await check_email_exists_error(webshare_page):
                print("⚠️ Email address already exists! Switching to 6d6f tab for a new email...")
                await email_page.bring_to_front()
                email_text = await get_email_from_6d6f(email_page)
                continue

            # Check if page already navigated away (registration succeeded without CAPTCHA)
            if "register" not in webshare_page.url:
                print(f"✅ Registration succeeded immediately! Navigated to: {webshare_page.url}")
                break

            # Check if CAPTCHA actually appeared (look for reCAPTCHA iframe within 10 seconds)
            print("Checking if CAPTCHA triggered...")
            captcha_found = False
            for wait_sec in range(10):
                # Check if page navigated (success without captcha)
                if "register" not in webshare_page.url:
                    print(f"✅ Registration succeeded! Navigated to: {webshare_page.url}")
                    captcha_found = None  # signal success
                    break

                for frame in webshare_page.frames:
                    if "recaptcha" in frame.url:
                        captcha_found = True
                        break
                if captcha_found:
                    break
                await webshare_page.wait_for_timeout(1000)

            # If navigated away during captcha check = success
            if captcha_found is None:
                break

            if not captcha_found:
                print("❌ No CAPTCHA triggered after 10 seconds. Full restart needed.")
                brave_proc.kill()
                return False

            # CAPTCHA appeared — let NopeCHA solve it
            print("🔐 CAPTCHA detected! Waiting for NopeCHA extension to solve it...")
            solved = await solve_recaptcha(webshare_page)

            if not solved:
                # Check if page navigated during solve (success)
                if "register" not in webshare_page.url:
                    print(f"✅ Registration succeeded during CAPTCHA solve! URL: {webshare_page.url}")
                    break
                print("❌ NopeCHA failed to solve CAPTCHA. Full restart needed.")
                brave_proc.kill()
                return False

            # CAPTCHA solved — wait a moment and check result
            await webshare_page.wait_for_timeout(3000)

            # Check again for duplicate email error after CAPTCHA
            if await check_email_exists_error(webshare_page):
                print("⚠️ Email address already exists! Switching to 6d6f tab for a new email...")
                await email_page.bring_to_front()
                email_text = await get_email_from_6d6f(email_page)
                continue

            # Check if registration succeeded (navigated away from register page)
            if "register" not in webshare_page.url:
                print(f"✅ Registration succeeded! Navigated to: {webshare_page.url}")
                break

            # Still on register page after CAPTCHA solved — something went wrong
            print("❌ Still on register page after CAPTCHA solve. Full restart needed.")
            brave_proc.kill()
            return False

        screenshot_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webshare_final.png")
        await webshare_page.screenshot(path=screenshot_path)
        print(f"Saved final screenshot: {screenshot_path}")

        print(f"\nRegistered Email: {email_text}")
        print(f"Password: {password}")

        # Step 1: Fast Email Verification on 6d6f
        verified = await verify_webshare_email_on_6d6f(email_page, webshare_page)

        if not verified:
            print("⏳ Closing browser lot in 10 seconds due to failure...")
            await asyncio.sleep(10)
            brave_proc.kill()
            return False

        # Step 2: Extract all 10 proxies dynamically via JS
        extracted_proxies = await extract_webshare_proxies(webshare_page)

        # Automatically save the proxy that powered this successful extraction into good_proxies.txt
        if chosen_proxy_raw and extracted_proxies:
            save_good_proxy(chosen_proxy_raw)

        print(f"\n🔥 Lot {account_num}/{total_accounts} completed successfully!")
        await webshare_page.wait_for_timeout(4000)
        brave_proc.kill()
        return True


async def main():
    try:
        user_input = input("How many accounts to create? (e.g. 1, 2, 5) [default: 1]: ").strip()
        total_accounts = int(user_input) if user_input.isdigit() and int(user_input) > 0 else 1
    except Exception:
        total_accounts = 1

    print(f"\n🚀 Starting automation for {total_accounts} account lot(s)...\n")

    for idx in range(1, total_accounts + 1):
        print(f"\n{'='*50}")
        print(f"🎯 Processing Account {idx} of {total_accounts}")
        print(f"{'='*50}\n")

        success = False
        for attempt in range(1, 4):  # up to 3 retries
            if attempt > 1:
                print(f"\n🔄 Retry attempt {attempt}/3 for account {idx} (full restart)...")
                await asyncio.sleep(3)
            success = await process_single_account(idx, total_accounts)
            if success:
                break
            print(f"⚠️ Account {idx} attempt {attempt} failed.")

        if not success:
            print(f"❌ Account {idx} failed after 3 attempts. Skipping.")

        if idx < total_accounts:
            print(f"\n⏳ Waiting 5 seconds before starting account lot {idx + 1}...")
            await asyncio.sleep(5)

    print(f"\n🎉 All {total_accounts} account lot(s) completed!")


if __name__ == "__main__":
    asyncio.run(main())
