(() => {
  // detect top-frame recaptcha
  const isTop = window === window.top;
  if (!isTop) return;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  // inject geetest trusted hook
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/geetest-inject.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}

  let detectedVersion = null;
  let autoTriggered = false;
  let funcaptchaDetected = false;
  let aliyunDetected = false;

  let pageSettings = {
    enabled: true,
    autoSolve: true,
    autoClick: true,
    solve_recaptcha: true,
    solve_turnstile: true,
    solve_funcaptcha: true,
    solve_aliyun: true
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      chrome.storage.sync.get(['enabled', 'autoSolve', 'autoClick', 'solve_recaptcha', 'solve_turnstile', 'solve_funcaptcha', 'solve_aliyun'], (s) => {
        if (s) pageSettings = { ...pageSettings, ...s };
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
          for (const k in changes) pageSettings[k] = changes[k].newValue;
        }
      });
    } catch {}
  }

  // detect arkose funcaptcha frame
  function findArkoseFunCaptcha() {
    const container = document.querySelector(
      '#fc-iframe-wrap, #fc-game-container, iframe#CaptchaFrame, #fc-overlay-wrap, #fc-iframe-overlay'
    );
    if (container) return true;
    const tokenInput = document.querySelector('input[name="fc-token"], input[name*="fc-token"], input[name*="arkose"]');
    if (tokenInput) return true;
    const themed = document.querySelector('[data-theme*="home."], [data-theme*="game."], [data-theme*="wrong."]');
    if (themed) return true;
    const widget = document.querySelector('#arkose-iframe, .arkose-fc, [id*="arkose"], [id*="fc-"][id*="frame"]');
    if (widget) return true;
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const f of frames) {
      const src = f.getAttribute('src') || '';
      if (/(^|\/)(fc|game-core|papi)\//.test(src) || /\/fc\/assets\//.test(src) || src.includes('/api.js')) return true;
      const title = (f.getAttribute('title') || '').toLowerCase();
      if (title.includes('challenge') && f.id && /captcha|arkose|fc/i.test(f.id)) return true;
    }
    return false;
  }

  function isContextValid() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {}
  }

  function log(...args) {
    const line = '[page] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC]', 'color:#22d3ee;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function findSitekey() {
    const el = document.querySelector(
      '.g-recaptcha[data-sitekey], [data-sitekey]:not([data-provider*="geetest"]):not([data-provider*="turnstile"]):not([class*="geetest"]):not([class*="cf-turnstile"])'
    );
    if (el && el.dataset.sitekey) return el.dataset.sitekey;
    for (const s of document.querySelectorAll('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise"]')) {
      const m = s.src.match(/render=([A-Za-z0-9_-]{20,})/);
      if (m) return m[1];
    }
    for (const f of document.querySelectorAll('iframe[src*="/recaptcha/"]')) {
      try {
        const u = new URL(f.src);
        const k = u.searchParams.get('k');
        if (k) return k;
      } catch {}
    }
    return null;
  }

  // check v2 anchor presence
  function hasV2AnchorIframe() {
    return !!document.querySelector(
      'iframe[src*="/api2/anchor"], iframe[src*="/enterprise/anchor"]'
    );
  }

  function isV3Only() {
    // check v3 badge presence
    if (hasV2AnchorIframe()) return false;
    if (document.querySelector('.grecaptcha-badge')) return true;
    for (const s of document.querySelectorAll('script[src*="recaptcha/api.js"]')) {
      if (/render=([A-Za-z0-9_-]{20,})/.test(s.src)) return true;
    }
    return false;
  }

  function findTurnstile() {
    const iframe = document.querySelector(
      'iframe[id*="cf-chl-widget"], div.cf-turnstile iframe, .cf-turnstile iframe, #cf-turnstile iframe, ' +
      'iframe[src*="/cdn-cgi/challenge-platform/"], #challenge-stage iframe, #cf-stage iframe, ' +
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com/cdn-cgi/"]'
    );
    const widget = document.querySelector(
      '.cf-turnstile, [data-turnstile], [name="cf-turnstile-response"], #cf-chl-widget, ' +
      '#challenge-stage, #cf-stage, #challenge-form'
    );
    if (iframe || widget) {
      let sitekey = null;
      if (widget && widget.dataset && widget.dataset.sitekey) {
        sitekey = widget.dataset.sitekey;
      } else if (iframe && iframe.src) {
        try {
          const u = new URL(iframe.src);
          sitekey = u.searchParams.get('sitekey') || u.searchParams.get('k');
        } catch {}
      }
      return { found: true, sitekey, iframe, widget };
    }
    return { found: false, sitekey: null };
  }


  let turnstileDetected = false;
  let turnstileTokenObserved = false;
  let autoTriggeredTurnstile = false;
  let lastTurnstileToken = '';
  let lastTurnstileIframe = null;

  function triggerTurnstileReset(reason = 'token-cleared') {
    if (!turnstileDetected && !findTurnstile().found) return;
    log('Turnstile reset detected (' + reason + ') — re-arming solver for fresh challenge');
    turnstileTokenObserved = false;
    autoTriggeredTurnstile = false;
    turnstileDetected = false;
    lastTurnstileToken = '';

    safeSendMessage({
      type: 'TURNSTILE_RESET',
      reason
    });

    setTimeout(() => {
      detect();
      setTimeout(requestAutoTurnstile, 400);
    }, 350);
  }

  function monitorTurnstileToken() {
    const tokenInput = document.querySelector(
      'input[name="cf-turnstile-response"], [name="cf-turnstile-response"]'
    );
    const currentVal = (tokenInput && tokenInput.value) || '';

    if (currentVal && currentVal.length > 20) {
      if (currentVal !== lastTurnstileToken) {
        lastTurnstileToken = currentVal;
        turnstileTokenObserved = true;
        log('Cloudflare Turnstile token detected on main page (' + currentVal.slice(0, 16) + '...)');
        safeSendMessage({
          type: 'STATUS',
          status: 'success',
          message: 'Cloudflare Turnstile verified successfully'
        });
      }
    } else {
      // handle turnstile token reset
      if (turnstileTokenObserved) {
        triggerTurnstileReset('token-cleared');
      }
    }

    // check replaced turnstile iframe
    const currentIframe = document.querySelector(
      'iframe[id*="cf-chl-widget"], div.cf-turnstile iframe, .cf-turnstile iframe, #cf-turnstile iframe, iframe[src*="/cdn-cgi/challenge-platform/"]'
    );
    if (currentIframe && lastTurnstileIframe && currentIframe !== lastTurnstileIframe) {
      log('Turnstile iframe replaced in DOM — re-arming solver');
      lastTurnstileIframe = currentIframe;
      if (turnstileTokenObserved || autoTriggeredTurnstile) {
        triggerTurnstileReset('iframe-replaced');
      }
    } else if (currentIframe) {
      lastTurnstileIframe = currentIframe;
    }
  }

  function deepQuerySelectorAll(selector, root = document) {
    const results = [];
    function search(node) {
      if (!node) return;
      try {
        if (node.querySelectorAll) {
          const matches = node.querySelectorAll(selector);
          for (let i = 0; i < matches.length; i++) {
            results.push(matches[i]);
          }
        }
      } catch {}
      if (node.shadowRoot) {
        search(node.shadowRoot);
      }
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        try {
          const closedSr = chrome.dom.openOrClosedShadowRoot(node);
          if (closedSr && closedSr !== node.shadowRoot) {
            search(closedSr);
          }
        } catch {}
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) {
        search(children[i]);
      }
    }
    search(root);
    return results;
  }

  function getTurnstileCoords() {
    // Strategy 1: Deep scan for all IFRAME elements across light DOM and shadow roots
    const allIframes = deepQuerySelectorAll('iframe', document);

    // First pass: iframes matching known challenge keywords
    for (const f of allIframes) {
      const src = (f.src || '').toLowerCase();
      const id = (f.id || '').toLowerCase();
      const name = (f.name || '').toLowerCase();
      const title = (f.title || '').toLowerCase();
      const isCf = src.includes('challenge-platform') || src.includes('challenges.cloudflare') ||
                   src.includes('turnstile') || src.includes('cdn-cgi') ||
                   id.includes('cf-chl') || name.includes('cf-chl') || title.includes('cloudflare');
      if (isCf) {
        try {
          const r = f.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return {
              ok: true,
              x: Math.round(r.left + Math.min(32, Math.max(25, r.width * 0.11))),
              y: Math.round(r.top + r.height / 2),
              source: 'deep-cf-iframe',
              rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            };
          }
        } catch {}
      }
    }

    // Second pass: ANY visible iframe with typical Turnstile dimensions (~100-450px wide, ~35-120px tall)
    for (const f of allIframes) {
      try {
        const r = f.getBoundingClientRect();
        if (r.width >= 100 && r.width <= 450 && r.height >= 35 && r.height <= 120) {
          return {
            ok: true,
            x: Math.round(r.left + Math.min(32, Math.max(25, r.width * 0.11))),
            y: Math.round(r.top + r.height / 2),
            source: 'deep-sized-iframe',
            rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
          };
        }
      } catch {}
    }

    // Strategy 2: Check known container elements
    const containerSelectors = [
      '#challenge-stage', '#cf-stage', '#challenge-form',
      '.cf-turnstile', '#cf-turnstile', '[data-turnstile]',
      '.ctp-checkbox-container'
    ];
    for (const sel of containerSelectors) {
      const containers = deepQuerySelectorAll(sel, document);
      for (const container of containers) {
        try {
          const r = container.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            // Check if it contains a child with widget dimensions
            const allChildren = deepQuerySelectorAll('*', container);
            for (const child of allChildren) {
              const cr = child.getBoundingClientRect();
              if (cr.width >= 120 && cr.width <= 420 && cr.height >= 40 && cr.height <= 100) {
                return {
                  ok: true,
                  x: Math.round(cr.left + 30),
                  y: Math.round(cr.top + cr.height / 2),
                  source: 'container-sized-child',
                  rect: { left: Math.round(cr.left), top: Math.round(cr.top), width: Math.round(cr.width), height: Math.round(cr.height) }
                };
              }
            }

            // If the container itself has typical widget dimensions:
            if (r.width >= 120 && r.width <= 450 && r.height >= 40 && r.height <= 120) {
              return {
                ok: true,
                x: Math.round(r.left + 30),
                y: Math.round(r.top + r.height / 2),
                source: 'container-direct',
                rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
              };
            }

            // If the container is full-width (like #challenge-stage or #challenge-form on interstitial pages):
            // The challenge widget (300px wide) is centered inside it
            if (r.width > 450 && r.height >= 40) {
              const widgetLeft = r.left + (r.width - 300) / 2;
              return {
                ok: true,
                x: Math.round(widgetLeft + 30),
                y: Math.round(r.top + r.height / 2),
                source: 'container-fullwidth-centered',
                rect: { left: Math.round(widgetLeft), top: Math.round(r.top), width: 300, height: Math.round(r.height) }
              };
            }
          }
        } catch {}
      }
    }

    // Strategy 3: Visual inspection — look for ANY element that has Turnstile widget box dimensions (~300x65)
    const allElements = deepQuerySelectorAll('div, section, article', document);
    for (const el of allElements) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width >= 240 && r.width <= 360 && r.height >= 50 && r.height <= 85 && r.top > 50) {
          const sig = (el.id + ' ' + el.className).toLowerCase();
          if (sig.includes('cf') || sig.includes('chl') || sig.includes('ctp') || sig.includes('stage') || sig.includes('challenge') || el.querySelector('input, svg, label')) {
            return {
              ok: true,
              x: Math.round(r.left + 30),
              y: Math.round(r.top + r.height / 2),
              source: 'deep-visual-box',
              rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            };
          }
        }
      } catch {}
    }

    return { ok: false, error: 'Turnstile element not visible or not found' };
  }


  function requestAutoTurnstile() {
    if (pageSettings.enabled === false || pageSettings.solve_turnstile === false) return;
    if (autoTriggeredTurnstile || !turnstileDetected) return;
    autoTriggeredTurnstile = true;
    log('Turnstile detected — requesting AUTO_SOLVE_TURNSTILE from background');
    safeSendMessage({ type: 'AUTO_SOLVE_TURNSTILE' });
  }

  function findAliyun() {
    const specific = document.querySelector(
      '[id*="aliyunCaptcha"], [class*="aliyunCaptcha"], [id*="aliyun-captcha"], [class*="aliyun-captcha"], [class*="baxia"], #captcha-element, .nc_scale, .nc_container'
    );
    if (specific) {
      const text = specific.textContent || '';
      const m = text.match(/CertifyId:\s*([a-zA-Z0-9_-]+)/i);
      return { found: true, certifyId: m ? m[1] : null };
    }

    const containers = document.querySelectorAll('[role="dialog"], .modal, [class*="dialog"], [class*="modal"], div');
    for (const c of containers) {
      if (c === document.body || c === document.documentElement) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 180 || r.height < 140 || r.width > 750 || r.height > 850) continue;
      const txt = (c.textContent || '');
      if (
        txt.includes('CertifyId') ||
        txt.includes('drag the slider to restore the complete image') ||
        txt.includes('Please complete security verification') ||
        txt.includes('请完成安全验证') ||
        txt.includes('向右滑动验证') ||
        txt.includes('拖动滑块完成拼图') ||
        txt.includes('请拖动滑块')
      ) {
        const m = txt.match(/CertifyId:\s*([a-zA-Z0-9_-]+)/i);
        return { found: true, certifyId: m ? m[1] : null };
      }
    }
    return { found: false, certifyId: null };
  }

  function detect() {
    if (!isContextValid()) return false;
    if (pageSettings.enabled === false) return false;

    // scan aliyun captcha / universal slider
    if (pageSettings.solve_aliyun !== false) {
      const aliyun = findAliyun();
      if (aliyun.found && !aliyunDetected) {
        aliyunDetected = true;
        log('detect: Aliyun / Slider CAPTCHA detected on page');
        safeSendMessage({
          type: 'DETECTED',
          version: 'aliyun',
          provider: 'aliyun',
          sitekey: aliyun.certifyId || 'aliyun'
        });
      }
    }

    // scan cloudflare turnstile
    if (pageSettings.solve_turnstile !== false) {
      const ts = findTurnstile();
      if (ts.found && !turnstileDetected) {
        turnstileDetected = true;
        log('detect: Cloudflare Turnstile found sitekey=' + (ts.sitekey || 'none'));
        safeSendMessage({
          type: 'DETECTED',
          version: 'turnstile',
          provider: 'turnstile',
          sitekey: ts.sitekey
        });
        setTimeout(requestAutoTurnstile, 800 + Math.random() * 500);
      }
    }

    // scan arkose funcaptcha
    if (pageSettings.solve_funcaptcha !== false) {
      if (findArkoseFunCaptcha() && !funcaptchaDetected) {
        funcaptchaDetected = true;
        log('detect: Arkose FunCAPTCHA detected on page');
        safeSendMessage({
          type: 'DETECTED',
          version: 'funcaptcha',
          provider: 'funcaptcha',
          sitekey: 'arkose'
        });
      }
    }

    if (pageSettings.solve_turnstile !== false) {
      monitorTurnstileToken();
    }

    if (pageSettings.solve_recaptcha === false) return false;
    if (detectedVersion) return true;

    const sitekey = findSitekey();
    const hasIframe = !!document.querySelector('iframe[src*="/recaptcha/api2/"], iframe[src*="/recaptcha/enterprise/"]');
    const hasRecaptchaScript = !!document.querySelector('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise"]');
    const hasRecaptchaBadge = !!document.querySelector('.grecaptcha-badge, .g-recaptcha');

    if (!sitekey && !hasIframe) return false;
    // verify recaptcha page elements
    if (!hasIframe && !hasRecaptchaScript && !hasRecaptchaBadge && !document.querySelector('.g-recaptcha[data-sitekey]')) {
      return false;
    }

    // prioritize v2 anchor iframe
    if (hasV2AnchorIframe()) {
      detectedVersion = 2;
    } else if (isV3Only()) {
      detectedVersion = 3;
    } else if (hasIframe) {
      detectedVersion = 2; // fallback to v2
    } else {
      return false;
    }

    log('detect: version=' + detectedVersion + ' sitekey=' + sitekey + ' anchorIframe=' + hasV2AnchorIframe());
    safeSendMessage({ type: 'DETECTED', version: detectedVersion, sitekey });
    return true;
  }

  function isBframeOpenOnPage() {
    const bframes = document.querySelectorAll(
      'iframe[src*="/bframe"], iframe[src*="bframe"], iframe[title*="challenge" i], iframe[title*="चुनौती" i]'
    );
    if (!bframes.length) return false;

    for (const bf of bframes) {
      const style = window.getComputedStyle(bf);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const parent = bf.parentElement;
      if (parent) {
        const ps = window.getComputedStyle(parent);
        if (ps.display === 'none' || ps.visibility === 'hidden') continue;
        const pr = parent.getBoundingClientRect();
        if (pr.top < -2000 || pr.left < -2000) continue;
      }

      const grandParent = parent ? parent.parentElement : null;
      if (grandParent && grandParent !== document.body && grandParent !== document.documentElement) {
        const gps = window.getComputedStyle(grandParent);
        if (gps.display === 'none' || gps.visibility === 'hidden') continue;
        const gpr = grandParent.getBoundingClientRect();
        if (gpr.top < -2000 || gpr.left < -2000) continue;
      }

      const rect = bf.getBoundingClientRect();
      if (rect.width >= 150 && rect.height >= 150 && rect.top > -2000) {
        return true;
      }
    }
    return false;
  }

  function getRecaptchaCoords() {
    const iframe = document.querySelector(
      'iframe[src*="/api2/anchor"], iframe[src*="/enterprise/anchor"]'
    );
    if (!iframe) return { ok: false, error: 'no anchor iframe found' };
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 20) return { ok: false, error: 'anchor iframe too small' };
    // compute anchor checkbox coords
    const x = Math.round(rect.left + 28 + (Math.random() * 4 - 2));
    const y = Math.round(rect.top + 37 + (Math.random() * 4 - 2));
    return { ok: true, x, y };
  }

  function triggerRecaptchaReset(reason = 'reset-button') {
    if (detectedVersion !== 2 && !hasV2AnchorIframe()) return;
    log('reCAPTCHA reset detected (' + reason + ') — re-arming solver for fresh challenge');
    autoTriggered = false;
    detectedVersion = null;
    safeSendMessage({ type: 'RECAPTCHA_RESET', reason });
    setTimeout(() => {
      detect();
      setTimeout(requestAutoClick, 500);
    }, 400);
  }

  function requestAutoClick() {
    if (autoTriggered || detectedVersion !== 2) return;
    autoTriggered = true;
    log('v2 detected — requesting AUTO_CLICK from background');
    safeSendMessage({ type: 'AUTO_CLICK' });
  }

  // monitor page reset clicks
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const target = e.target;
    if (!target) return;
    const btn = target.closest('button, a, [role="button"], input[type="button"], input[type="reset"]');
    if (!btn) return;
    const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
    const isReset = txt.includes('reset') || btn.id === 'reset' || (btn.className && String(btn.className).includes('reset'));
    if (isReset) {
      log('User clicked "Reset" button — broadcasting reset to captcha modules');
      window.dispatchEvent(new CustomEvent('CC_CAPTCHA_RESET', { detail: { reason: 'user-click-reset' } }));
      if (turnstileDetected || findTurnstile().found) {
        setTimeout(() => {
          triggerTurnstileReset('user-click-reset');
        }, 300);
      }
      if (detectedVersion === 2 || hasV2AnchorIframe()) {
        setTimeout(() => {
          triggerRecaptchaReset('user-click-reset');
        }, 350);
      }
    }
  }, true);

  // observe late widget mutations
  let settleTimer = null;
  const detectMo = new MutationObserver(() => {
    if (!isContextValid()) {
      detectMo.disconnect();
      return;
    }
    monitorTurnstileToken();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (detect()) {
        if (detectedVersion === 2 && !autoTriggered) {
          log('late v2 detection — settling before auto-click');
          setTimeout(requestAutoClick, 900 + Math.random() * 900);
        }
      }
    }, 300);
  });
  detectMo.observe(document.documentElement, { childList: true, subtree: true });

  // turnstile watchdog loop
  let polls = 0;
  const watchdog = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(watchdog);
      if (detectMo) detectMo.disconnect();
      return;
    }
    polls++;
    monitorTurnstileToken();

    if (detectedVersion === 2 && !autoTriggered) {
      log('v2 detection done — settling before auto-click');
      setTimeout(requestAutoClick, 900 + Math.random() * 900);
    }

    // trigger auto turnstile solve
    const ts = findTurnstile();
    if (ts.found && !turnstileTokenObserved && !autoTriggeredTurnstile) {
      detect();
      setTimeout(requestAutoTurnstile, 400);
    }
  }, 500);

  if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'IS_BFRAME_OPEN') {
      sendResponse({ ok: true, open: isBframeOpenOnPage() });
      return true;
    }

    if (msg.type === 'RECAPTCHA_RESET') {
      if (detectedVersion === 2 || hasV2AnchorIframe()) {
        log('reCAPTCHA reset received — clearing autoTriggered flag');
        autoTriggered = false;
        detectedVersion = 2;
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_RECAPTCHA_COORDS') {
      sendResponse(getRecaptchaCoords());
      return true;
    }

    if (msg.type === 'GET_TURNSTILE_COORDS') {
      sendResponse(getTurnstileCoords());
      return true;
    }

    if (msg.type === 'CHECK_TURNSTILE_SOLVED') {
      const tokenInput = document.querySelector(
        'input[name="cf-turnstile-response"], [name="cf-turnstile-response"]'
      );
      const isTokenSolved = !!(tokenInput && tokenInput.value && tokenInput.value.length > 20);

      // Check visual success elements
      const successEl = document.querySelector(
        '#challenge-success, .ctp-checkbox-checked, [data-state="success"], svg.ctp-checkbox-checked'
      );
      const isSuccessState = !!(successEl && (successEl.offsetWidth > 0 || successEl.offsetHeight > 0));

      // Check page text indicators
      const bodyText = (document.body && document.body.innerText) || '';
      const isTextSolved = /success|verified/i.test(bodyText) && !/verify you are human/i.test(bodyText);

      const isSolved = isTokenSolved || isSuccessState || isTextSolved;
      sendResponse({
        ok: true,
        solved: isSolved,
        token: isTokenSolved ? tokenInput.value : (isSolved ? 'verified' : null)
      });
      return true;
    }

    if (msg.type === 'READ_TOKEN') {
      const tas = document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
      for (const ta of tas) {
        if (ta.value) {
          sendResponse({ ok: true, token: ta.value, provider: 'recaptcha' });
          return;
        }
      }
      const cfInput = document.querySelector('input[name="cf-turnstile-response"], [name="cf-turnstile-response"]');
      if (cfInput && cfInput.value) {
        sendResponse({ ok: true, token: cfInput.value, provider: 'turnstile' });
        return;
      }
      sendResponse({ ok: false, error: 'no captcha response token on page' });
      return;
    }

    if (msg.type === 'CLICK_AND_SOLVE') {
      sendResponse({ ok: true, relayed: true });
      return;
    }

    if (msg.type === 'DETECT_STATUS') {
      sendResponse({ version: detectedVersion, sitekey: findSitekey(), turnstile: turnstileDetected });
      return;
    }
  });
  }
})();
