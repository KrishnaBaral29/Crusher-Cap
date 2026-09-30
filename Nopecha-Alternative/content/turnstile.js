(() => {
  // cloudflare turnstile solver script

  function hasTurnstileDom() {
    try {
      const direct = document.querySelector(
        '#cf-chl-widget, [id*="cf-chl-widget"], #challenge-stage, #cf-stage, ' +
        '.ctp-checkbox-container, .cf-turnstile, [name="cf-turnstile-response"], ' +
        'input[type="checkbox"]#cf-chl-widget-input'
      );
      if (direct) return true;
      const nodes = document.querySelectorAll('div, label, span, iframe');
      const limit = Math.min(nodes.length, 3000);
      for (let i = 0; i < limit; i++) {
        const n = nodes[i];
        const sig = n.id + ' ' + (typeof n.className === 'string' ? n.className : '');
        if (/cf-chl-widget|ctp-checkbox|challenge-stage|cf-stage/.test(sig)) return true;
        if (n.tagName === 'IFRAME' && typeof n.src === 'string' && n.src.includes('/cdn-cgi/challenge-platform/')) return true;
      }
    } catch {}
    return false;
  }

  let armed = hasTurnstileDom();

  // check valid runtime context
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  let solving = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 4;
  let observer = null;
  let solvedNotified = false;

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
    const line = '[turnstile] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC-Turnstile]', 'color:#f97316;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function getSettings() {
    const defaults = {
      enabled: true,
      solve_turnstile: true,
      autoSolve: true,
      minDelay: 1200,
      maxDelay: 2800
    };
    if (!isContextValid() || !chrome.storage || !chrome.storage.sync) {
      return Promise.resolve(defaults);
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(defaults, (s) => {
          if (!isContextValid() || chrome.runtime.lastError) {
            resolve(defaults);
          } else {
            resolve(s || defaults);
          }
        });
      } catch {
        resolve(defaults);
      }
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // scan open shadow roots
  function findTurnstileElements(root = document) {
    const results = {
      label: null,
      checkbox: null,
      container: null,
      success: null,
      error: null,
      spinner: null
    };

    function scan(node) {
      if (!node) return;

      // check success state elements
      if (!results.success) {
        const s = node.querySelector(
          '#challenge-success, .ctp-checkbox-checked, [data-state="success"], svg.ctp-checkbox-checked'
        );
        if (s && isVisible(s)) results.success = s;
      }

      // check error state elements
      if (!results.error) {
        const err = node.querySelector(
          '#challenge-error, .ctp-error, [data-state="error"], .ctp-status-error'
        );
        if (err && isVisible(err)) results.error = err;
      }

      // check spinner loading states
      if (!results.spinner) {
        const spin = node.querySelector(
          '#challenge-running, .ctp-status-waiting, .ctp-spinner, [data-state="running"]'
        );
        if (spin && isVisible(spin)) results.spinner = spin;
      }

      // find checkbox label element
      if (!results.label) {
        const l = node.querySelector(
          'label.ctp-checkbox-label, .ctp-checkbox-label, label[for*="cf-chl-widget"]'
        );
        if (l && isVisible(l)) results.label = l;
      }

      // find checkbox input element
      if (!results.checkbox) {
        const cb = node.querySelector(
          'input[type="checkbox"]#cf-chl-widget-input, input[type="checkbox"], [role="checkbox"]'
        );
        if (cb) results.checkbox = cb;
      }

      // find widget container element
      if (!results.container) {
        const cont = node.querySelector(
          '#challenge-stage, #cf-stage, .ctp-checkbox-container, .ctp-stage'
        );
        if (cont && isVisible(cont)) results.container = cont;
      }

      // traverse nested shadow roots
      const children = node.querySelectorAll('*');
      for (const child of children) {
        if (child.shadowRoot) {
          scan(child.shadowRoot);
        }
      }
    }

    scan(root);
    return results;
  }

  function isChallengeSolved(elements) {
    if (elements.success) return true;
    if (elements.checkbox && elements.checkbox.checked) return true;

    // check document success text
    const bodyText = document.body ? document.body.innerText || '' : '';
    if (/success|verified/i.test(bodyText) && !/verify you are human/i.test(bodyText)) {
      return true;
    }

    return false;
  }

  function notifySuccess() {
    if (solvedNotified) return;
    solvedNotified = true;
    log('Turnstile challenge successfully solved & verified!');
    safeSendMessage({
      type: 'STATUS',
      status: 'success',
      message: 'Cloudflare Turnstile verified successfully'
    });
  }

  // generate curved mouse trajectory
  function generateHumanTrajectory(fromX, fromY, toX, toY, steps = 6) {
    const points = [];
    // quadratic curve control point
    const midX = (fromX + toX) / 2 + (Math.random() - 0.5) * 30;
    const midY = (fromY + toY) / 2 + (Math.random() - 0.5) * 20;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // compute bezier curve point
      const inv = 1 - t;
      const x = inv * inv * fromX + 2 * inv * t * midX + t * t * toX + (Math.random() - 0.5) * 2;
      const y = inv * inv * fromY + 2 * inv * t * midY + t * t * toY + (Math.random() - 0.5) * 2;
      points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }
    return points;
  }

  // dispatch humanoid pointer clicks
  function dispatchHumanClick(targetElement) {
    return new Promise((resolve) => {
      const rect = targetElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        log('Target element has 0 dimensions, fallback direct click');
        try { targetElement.click(); } catch {}
        resolve(true);
        return;
      }

      // target left checkbox circle
      const isWide = rect.width > 55;
      const targetX = isWide ? (rect.left + 26 + Math.random() * 8) : (rect.left + rect.width * 0.2 + Math.random() * (rect.width * 0.6));
      const targetY = rect.top + rect.height * 0.3 + Math.random() * (rect.height * 0.4);

      // compute approach trajectory origin
      const startX = Math.max(0, targetX - 50 - Math.random() * 80);
      const startY = Math.max(0, targetY - 40 - Math.random() * 60);

      const trajectory = generateHumanTrajectory(startX, startY, targetX, targetY, 5);

      const win = window;
      const doc = document;

      // dispatch approach mouse movements
      trajectory.forEach((pt, idx) => {
        setTimeout(() => {
          const moveInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: win,
            clientX: pt.x,
            clientY: pt.y,
            screenX: (win.screenX || 0) + pt.x,
            screenY: (win.screenY || 0) + pt.y,
            buttons: 0,
            pressure: 0
          };
          targetElement.dispatchEvent(new PointerEvent('pointermove', moveInit));
          targetElement.dispatchEvent(new MouseEvent('mousemove', moveInit));
        }, idx * 25);
      });

      const approachTime = trajectory.length * 25 + 40;

      setTimeout(() => {
        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: win,
          clientX: targetX,
          clientY: targetY,
          screenX: (win.screenX || 0) + targetX,
          screenY: (win.screenY || 0) + targetY,
          pageX: targetX + (win.scrollX || 0),
          pageY: targetY + (win.scrollY || 0),
          button: 0,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: 0.5
        };

        // dispatch pointer enter events
        targetElement.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, buttons: 0, pressure: 0 }));
        targetElement.dispatchEvent(new MouseEvent('mouseover', { ...eventInit, buttons: 0 }));
        targetElement.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, buttons: 0, pressure: 0 }));
        targetElement.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, buttons: 0 }));

        // simulate pre-click delay
        setTimeout(() => {
          // dispatch pointerdown mouse events
          if (window.__ccClickAnim) window.__ccClickAnim(targetX, targetY);
          targetElement.dispatchEvent(new PointerEvent('pointerdown', eventInit));
          targetElement.dispatchEvent(new MouseEvent('mousedown', eventInit));

          // focus target element
          if (typeof targetElement.focus === 'function') {
            try { targetElement.focus(); } catch {}
          }

          // simulate click hold duration
          const holdTime = 70 + Math.floor(Math.random() * 70);

          setTimeout(() => {
            const releaseInit = { ...eventInit, buttons: 0, pressure: 0 };
            targetElement.dispatchEvent(new PointerEvent('pointerup', releaseInit));
            targetElement.dispatchEvent(new MouseEvent('mouseup', releaseInit));
            targetElement.dispatchEvent(new MouseEvent('click', releaseInit));

            // trigger underlying checkbox click
            const input =
              targetElement.querySelector('input[type="checkbox"]') ||
              (targetElement.tagName === 'INPUT' ? targetElement : null);
            if (input && !input.checked) {
              try { input.click(); } catch {}
            }

            resolve(true);
          }, holdTime);
        }, 50 + Math.floor(Math.random() * 60));
      }, approachTime);
    });
  }

  async function attemptSolve() {
    if (solving || solvedNotified) return;
    if (!armed) {
      armed = hasTurnstileDom();
      if (!armed) return;
    }

    const settings = await getSettings();
    if (!settings.enabled || settings.solve_turnstile === false) {
      // only log once to prevent spam
      if (!attemptSolve._disabledLogged) {
        log('Turnstile solver disabled in extension settings');
        attemptSolve._disabledLogged = true;
      }
      return;
    }
    attemptSolve._disabledLogged = false;

    const elements = findTurnstileElements();

    // check if already verified
    if (isChallengeSolved(elements)) {
      notifySuccess();
      return;
    }

    // await active challenge completion
    if (elements.spinner && !elements.label && !elements.checkbox) {
      log('Challenge running in background (non-interactive mode), monitoring...');
      return;
    }

    // select best click target
    const clickTarget = elements.checkbox || elements.label || elements.container;
    if (!clickTarget) {
      // element not yet visible
      return;
    }

    if (attempts >= MAX_ATTEMPTS) {
      log('Max solve attempts reached (' + MAX_ATTEMPTS + '), pausing');
      return;
    }

    solving = true;
    attempts++;

    // await wasm pow completion
    const humanDelay = 1400 + Math.floor(Math.random() * 1200);
    log('Interactive checkbox detected. Waiting humanoid delay: ' + humanDelay + 'ms (attempt ' + attempts + '/' + MAX_ATTEMPTS + ')');

    safeSendMessage({
      type: 'STATUS',
      status: 'working',
      message: 'Turnstile detected — simulating human click (' + humanDelay + 'ms)'
    });

    await new Promise((r) => setTimeout(r, humanDelay));

    // verify state before clicking
    const currentElements = findTurnstileElements();
    if (isChallengeSolved(currentElements)) {
      solving = false;
      notifySuccess();
      return;
    }

    const target = currentElements.label || currentElements.container || currentElements.checkbox;
    if (!target) {
      solving = false;
      return;
    }

    log('Dispatching humanoid pointer interaction to Turnstile checkbox...');
    await dispatchHumanClick(target);

    // monitor post-click state transitions
    let waitedMs = 0;
    const pollInterval = setInterval(() => {
      waitedMs += 350;
      const elState = findTurnstileElements();

      if (isChallengeSolved(elState)) {
        clearInterval(pollInterval);
        solving = false;
        notifySuccess();
        return;
      }

      if (elState.error) {
        clearInterval(pollInterval);
        solving = false;
        log('Turnstile reported challenge error, scheduling retry...');
        // wait for retry button
        setTimeout(() => {
          if (!solvedNotified) attemptSolve();
        }, 2500);
        return;
      }

      // poll for verification response
      if (waitedMs > 12000) {
        clearInterval(pollInterval);
        solving = false;
        log('Solve timeout (12s) without success or error, checking state...');
        if (!solvedNotified && attempts < MAX_ATTEMPTS) {
          attemptSolve();
        }
      }
    }, 350);
  }

  // observe late mounting widgets
  function init() {
    if (!armed) {
      const armObserver = new MutationObserver(() => {
        if (hasTurnstileDom()) {
          armed = true;
          armObserver.disconnect();
          init();
        }
      });
      try {
        armObserver.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch {}
      return;
    }

    log('Turnstile frame script armed at ' + location.href.slice(0, 80));

    // check immediate dom state
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(attemptSolve, 400);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(attemptSolve, 400), { once: true });
    }

    // observe dom mutation events
    observer = new MutationObserver(() => {
      if (!isContextValid()) {
        if (observer) observer.disconnect();
        return;
      }
      if (solving) return;
      const el = findTurnstileElements();
      if (solvedNotified) {
        // handle widget reset state
        if (!isChallengeSolved(el) && (el.checkbox || el.label || el.container)) {
          log('Turnstile frame widget reset to unsolved state — re-arming frame solver');
          solvedNotified = false;
          attempts = 0;
          attemptSolve();
        }
        return;
      }
      attemptSolve();
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-state']
      });
    }

    // poll for widget reset
    const interval = setInterval(() => {
      if (!isContextValid()) {
        clearInterval(interval);
        if (observer) observer.disconnect();
        return;
      }
      if (solving) return;
      const el = findTurnstileElements();
      if (solvedNotified) {
        if (!isChallengeSolved(el) && (el.checkbox || el.label)) {
          log('Turnstile frame detected unchecked state during poll — re-arming');
          solvedNotified = false;
          attempts = 0;
          attemptSolve();
        }
        return;
      }
      attemptSolve();
    }, 1500);
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'TRIGGER_TURNSTILE' || msg.type === 'RESET_TURNSTILE') {
        log('TRIGGER/RESET received in frame — re-arming Turnstile solver');
        solvedNotified = false;
        solving = false;
        attempts = 0;
        attemptSolve();
        sendResponse({ ok: true });
        return;
      }
    });
  }

  init();
})();
