(() => {
  // Aliyun Captcha 2.0 & Universal Slider Puzzle Solver
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  // Optimize 2D canvas readback performance if not already done
  try {
    const _origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === '2d') {
        options = Object.assign({}, options, { willReadFrequently: true });
      }
      return _origGetContext.call(this, type, options);
    };
  } catch (_) {}

  let settingsCache = null;
  let solving = false;
  let attempts = 0;
  let activeSolveId = 0;
  let scanBusy = false;
  let scanTimer = null;
  const MAX_ATTEMPTS = 5;
  const DONE_ATTR = 'data-cc-aliyun-done';

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
    const line = '[aliyun] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC-Aliyun]', 'color:#f97316;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function logErr(...args) {
    const line = '[aliyun] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.error('%c[CC-Aliyun]', 'color:#ef4444;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line, level: 'error' });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Check ancestors for hidden overflow or offscreen positioning
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const ps = window.getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      const pr = p.getBoundingClientRect();
      if ((pr.width <= 0 || pr.height <= 0) && ps.overflow === 'hidden') return false;
      if (pr.left < -3000 || pr.top < -3000) return false;
      p = p.parentElement;
    }
    return true;
  }

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.settings) {
            return resolve(null);
          }
          resolve(resp.settings);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // --- Element Discovery ---

  function findChallengeContainer() {
    // 1. Specific Aliyun 2.0 / Baxia selectors
    const specificSelectors = [
      '[id*="aliyunCaptcha"]',
      '[class*="aliyunCaptcha"]',
      '[id*="aliyun-captcha"]',
      '[class*="aliyun-captcha"]',
      '[class*="baxia"]',
      '#captcha-element',
      '[class*="nc_scale"]',
      '.nc_container'
    ];

    for (const sel of specificSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (isVisible(el)) {
          // Find dialog parent if wrapped in modal
          const modalParent = el.closest('[role="dialog"], .modal, [class*="dialog"], [class*="modal"]');
          return modalParent || el;
        }
      }
    }

    // 2. Text signatures inside dialogs / modals / cards
    const containers = document.querySelectorAll('div, section, [role="dialog"], .modal, [class*="dialog"], [class*="modal"]');
    for (const c of containers) {
      if (!isVisible(c)) continue;
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
        txt.includes('请拖动滑块') ||
        txt.includes('向右滑动')
      ) {
        return c;
      }
    }

    return null;
  }

  function findSliderHandle(scope) {
    const root = scope || document;

    // 1. Match handle containing arrow text ">>", "»", ">", "→"
    const allDivs = root.querySelectorAll('div, span, button, [role="slider"]');
    for (const el of allDivs) {
      if (!isVisible(el)) continue;
      const txt = (el.textContent || '').trim();
      if (txt === '>>' || txt === '»' || txt === '>' || txt === '→') {
        const r = el.getBoundingClientRect();
        if (r.width >= 20 && r.width <= 85 && r.height >= 20 && r.height <= 85) {
          return el;
        }
      }
    }

    // 2. Class name matches
    const selectors = [
      '.btn_slide',
      '[class*="btn_slide"]',
      '[class*="sliding-slider"]',
      '[class*="slider-btn"]',
      '[class*="slider_btn"]',
      '[class*="slider_button"]',
      '[class*="slider-handle"]',
      '[class*="slider-thumb"]',
      '.nc_iconfont.btn_slide',
      '[role="slider"]',
      '.slider',
      '[class*="handler"]'
    ];

    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        if (isVisible(el)) {
          const r = el.getBoundingClientRect();
          if (r.width >= 20 && r.width <= 85 && r.height >= 20 && r.height <= 85) {
            return el;
          }
        }
      }
    }

    return null;
  }

  function findSliderTrack(sliderHandle, scope) {
    if (sliderHandle) {
      let p = sliderHandle.parentElement;
      while (p && p !== (scope || document.body)) {
        const r = p.getBoundingClientRect();
        const hr = sliderHandle.getBoundingClientRect();
        if (r.width >= hr.width * 2.2 && r.width >= 160 && r.height >= hr.height * 0.7 && r.height <= hr.height * 2.8) {
          return p;
        }
        p = p.parentElement;
      }
    }

    const root = scope || document;
    const trackSelectors = [
      '.nc_scale',
      '[class*="nc_scale"]',
      '[class*="sliding-track"]',
      '[class*="slider-track"]',
      '[class*="slide-track"]',
      '[class*="slidetounlock"]',
      '[class*="scale_text"]'
    ];

    for (const sel of trackSelectors) {
      const el = root.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    return null;
  }

  function findPuzzleImages(scope) {
    const root = scope || document;
    const mediaElements = Array.from(root.querySelectorAll('canvas, img, div[style*="background-image"]')).filter(isVisible);

    const sorted = mediaElements
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, width: r.width, height: r.height, area: r.width * r.height, top: r.top, left: r.left };
      })
      .filter((item) => item.width > 20 && item.height > 20);

    sorted.sort((a, b) => b.area - a.area);

    let bg = null;
    let slice = null;

    // Largest media element is the background image
    const bgCandidate = sorted.find((item) => item.width >= 160 && item.height >= 80);
    if (bgCandidate) {
      bg = bgCandidate.el;

      // Slice candidate is a smaller media element positioned in or over the background
      const sliceCandidate = sorted.find(
        (item) =>
          item.el !== bg &&
          item.width >= 24 &&
          item.width <= 110 &&
          item.height >= 24 &&
          item.height <= 110 &&
          item.top >= bgCandidate.top - 30 &&
          item.top <= bgCandidate.top + bgCandidate.height + 10
      );

      if (sliceCandidate) {
        slice = sliceCandidate.el;
      }
    }

    if (!bg) {
      const bgSel = root.querySelector('[class*="sliding-img"], [class*="bg-img"], canvas:not([class*="slice"])');
      if (bgSel && isVisible(bgSel)) bg = bgSel;
    }
    if (!slice) {
      const sliceSel = root.querySelector('[class*="sliding-slice"], [class*="slice"], canvas[class*="slice"]');
      if (sliceSel && isVisible(sliceSel)) slice = sliceSel;
    }

    return { bg, slice };
  }

  function findRefreshButton(scope) {
    const root = scope || document;
    const btn = root.querySelector([
      '[class*="refresh"]',
      '[class*="reload"]',
      '[class*="reset"]',
      '[aria-label*="refresh" i]',
      '[aria-label*="reload" i]',
      '[title*="refresh" i]',
      '[title*="reload" i]',
      '[title*="换一张"]',
      '[aria-label*="换一张"]'
    ].join(', '));
    return btn && isVisible(btn) ? btn : null;
  }

  function extractCertifyId(scope) {
    const text = ((scope && scope.textContent) || document.body.textContent || '');
    const m = text.match(/CertifyId:\s*([a-zA-Z0-9_-]+)/i);
    return m ? m[1] : null;
  }

  function checkSolvedState(container) {
    if (!container || !container.isConnected) return true;
    const style = window.getComputedStyle(container);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;

    const txt = (container.textContent || '').toLowerCase();
    if (txt.includes('verification success') || txt.includes('验证通过') || txt.includes('验证成功') || txt.includes('passed')) {
      return true;
    }

    const tick = container.querySelector('[class*="success"], [class*="passed"], [class*="icon-ok"], svg[class*="success"]');
    if (tick && isVisible(tick)) return true;

    return false;
  }

  function findAliyunChallenge() {
    const container = findChallengeContainer();
    if (!container) return { found: false };

    const sliderHandle = findSliderHandle(container);
    const sliderTrack = findSliderTrack(sliderHandle, container);
    const { bg, slice } = findPuzzleImages(container);
    const refreshBtn = findRefreshButton(container);
    const certifyId = extractCertifyId(container);

    const isReady = !!(sliderHandle && bg && isVisible(sliderHandle) && isVisible(bg));

    return {
      found: true,
      container,
      sliderHandle,
      sliderTrack,
      bg,
      slice,
      refreshBtn,
      certifyId,
      isReady
    };
  }

  // --- Image Extraction & Gap Calculation ---

  function extractImageData(el) {
    if (!el) return null;
    if (el.tagName === 'CANVAS') {
      try {
        const b64 = el.toDataURL('image/png').split(',')[1];
        if (b64 && b64.length > 100) return { b64, mime: 'image/png' };
      } catch {}
    }
    if (el.tagName === 'IMG') {
      if (el.src && el.src.startsWith('data:image/')) {
        const parts = el.src.split(',');
        const mimeMatch = el.src.match(/data:([^;]+);/);
        return { b64: parts[1], mime: mimeMatch ? mimeMatch[1] : 'image/png', url: el.src };
      }
      if (el.src && /^https?:\/\//i.test(el.src)) {
        return { url: el.src };
      }
      try {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth || el.width || 300;
        c.height = el.naturalHeight || el.height || 200;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(el, 0, 0);
        const b64 = c.toDataURL('image/png').split(',')[1];
        return { b64, mime: 'image/png' };
      } catch {}
    }

    const style = window.getComputedStyle(el);
    const bgImg = style.backgroundImage || '';
    const match = bgImg.match(/url\(["']?([^"']+)["']?\)/);
    if (match && match[1]) {
      const u = match[1];
      if (u.startsWith('data:image/')) {
        const parts = u.split(',');
        const mimeMatch = u.match(/data:([^;]+);/);
        return { b64: parts[1], mime: mimeMatch ? mimeMatch[1] : 'image/png', url: u };
      }
      return { url: u };
    }

    return null;
  }

  async function waitForCaptchaToLoad(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const ch = findAliyunChallenge();
      if (ch.isReady) {
        const bgData = extractImageData(ch.bg);
        if (bgData && (bgData.b64 || bgData.url)) {
          return { ready: true, challenge: ch, bgData };
        }
      }
      await sleep(200);
    }
    const finalCh = findAliyunChallenge();
    return { ready: false, challenge: finalCh, bgData: extractImageData(finalCh.bg) };
  }

  async function requestGapCalculation(bgData, sliceData, relativeY) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'ALIYUN_CALCULATE_GAP',
          bgUrl: bgData ? bgData.url : null,
          bgB64: bgData ? bgData.b64 : null,
          mime: bgData ? bgData.mime : 'image/png',
          sliceUrl: sliceData ? sliceData.url : null,
          sliceB64: sliceData ? sliceData.b64 : null,
          relativeY: relativeY || 0
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            log('gap calculation service error:', chrome.runtime.lastError?.message || resp?.error);
            return resolve(null);
          }
          resolve(resp);
        }
      );
    });
  }

  // --- Drag Execution ---

  function generateHumanTrack(distance) {
    const track = [];
    const steps = rand(30, 42);

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      let ease;
      if (progress < 0.25) {
        ease = (progress / 0.25) * (progress / 0.25) * 0.12;
      } else {
        const p = (progress - 0.25) / 0.75;
        ease = 0.12 + 0.88 * (1 - Math.pow(1 - p, 2.5));
      }

      const curX = Math.round(distance * ease);
      const curY = Math.round((Math.sin(progress * Math.PI) * 1.5) + (Math.random() - 0.5) * 0.8);
      const delay = rand(12, 18);

      track.push({ x: curX, y: curY, delay });
    }

    return track;
  }

  async function simulateSyntheticDrag(sliderButton, distance) {
    if (!sliderButton) return;
    const rect = sliderButton.getBoundingClientRect();
    const startX = Math.round(rect.left + rect.width / 2);
    const startY = Math.round(rect.top + rect.height / 2);

    log('fallback synthetic drag: distance=' + distance + 'px from (' + startX + ',' + startY + ')');

    function fire(type, x, y, buttons) {
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: Math.round(window.screenX + x),
        screenY: Math.round(window.screenY + y),
        button: 0,
        buttons: buttons
      };
      sliderButton.dispatchEvent(new MouseEvent(type, opts));
    }

    if (window.__ccCursorMove) window.__ccCursorMove(startX, startY);
    fire('mousedown', startX, startY, 1);
    await sleep(rand(100, 150));

    const track = generateHumanTrack(distance);
    for (const pt of track) {
      const curX = startX + pt.x;
      const curY = startY + pt.y;
      if (window.__ccCursorMove) window.__ccCursorMove(curX, curY);
      fire('mousemove', curX, curY, 1);
      await sleep(pt.delay);
    }

    await sleep(rand(160, 220));
    const finalX = startX + distance;
    if (window.__ccCursorRelease) window.__ccCursorRelease(finalX, startY);
    fire('mouseup', finalX, startY, 0);
  }

  async function executeDrag(sliderButton, distance) {
    const rect = sliderButton.getBoundingClientRect();
    const startX = Math.round(rect.left + rect.width / 2);
    const startY = Math.round(rect.top + rect.height / 2);
    const targetX = startX + distance;
    const targetY = startY;

    log('executing drag: distance=' + distance + 'px to (' + targetX + ',' + targetY + ')');

    // Strategy A: Chrome DevTools Protocol hardware drag via background
    const cdpResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'CDP_DRAG',
          startX,
          startY,
          targetX,
          targetY
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message || resp?.error });
          } else {
            resolve({ ok: true });
          }
        }
      );
    });

    if (cdpResult.ok) {
      log('CDP hardware drag completed successfully ✓');
      return true;
    }

    log('CDP drag unavailable (' + cdpResult.error + ') — using synthetic drag fallback');
    await simulateSyntheticDrag(sliderButton, distance);
    return true;
  }

  // --- Main Solve Flow ---

  async function solveAliyunChallenge() {
    if (solving) return;
    solving = true;
    const thisSolveId = ++activeSolveId;

    try {
      safeSendMessage({
        type: 'STATUS',
        status: 'working',
        message: 'Aliyun CAPTCHA: solving slider challenge...',
        attempt: attempts
      });

      for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
        if (thisSolveId !== activeSolveId) return false;

        log('solve attempt ' + attempts + '/' + MAX_ATTEMPTS);

        log('waiting for captcha elements & images to load completely...');
        const loadResult = await waitForCaptchaToLoad(10000);
        if (thisSolveId !== activeSolveId) return false;

        const ch = loadResult.challenge;
        if (!loadResult.ready || !ch.bg || !ch.sliderHandle) {
          log('captcha challenge failed to load in time — retrying attempt');
          await sleep(1500);
          continue;
        }

        log('captcha fully loaded and painted: handle=' + (ch.sliderHandle.className || 'btn'));

        // Natural settling pause
        const settleMs = rand(400, 600);
        await sleep(settleMs);
        if (thisSolveId !== activeSolveId) return false;

        safeSendMessage({
          type: 'STATUS',
          status: 'working',
          message: 'Aliyun CAPTCHA: calculating gap position (attempt ' + attempts + '/' + MAX_ATTEMPTS + ')',
          attempt: attempts - 1
        });

        // Calculate relative Y of slice if present
        const bgRect = ch.bg.getBoundingClientRect();
        const sliceRect = ch.slice ? ch.slice.getBoundingClientRect() : null;
        const relativeY = sliceRect ? Math.round(sliceRect.top - bgRect.top) : 0;

        const sliceData = ch.slice ? extractImageData(ch.slice) : null;
        const gapResult = await requestGapCalculation(loadResult.bgData, sliceData, relativeY);

        if (!gapResult || typeof gapResult.gapX !== 'number') {
          logErr('gap calculation returned null or invalid — refreshing challenge');
          if (ch.refreshBtn && isVisible(ch.refreshBtn)) {
            ch.refreshBtn.click();
          }
          await sleep(1500);
          continue;
        }

        log('gap calculated: gapX=' + gapResult.gapX + ' method=' + (gapResult.method || 'unknown'));

        // Geometry & travel scaling
        const naturalWidth = gapResult.naturalWidth || (ch.bg.tagName === 'CANVAS' ? ch.bg.width : 300);
        const scale = bgRect.width > 0 ? bgRect.width / naturalWidth : 1;
        const gapCssX = Math.round(gapResult.gapX * scale);

        const btnRect = ch.sliderHandle.getBoundingClientRect();
        const trackRect = ch.sliderTrack ? ch.sliderTrack.getBoundingClientRect() : null;
        const maxTravel = trackRect ? Math.round(trackRect.width - btnRect.width) : Math.round(bgRect.width - btnRect.width);

        const sliceStartOffset = sliceRect ? Math.round(sliceRect.left - bgRect.left) : 0;
        const sliceTravelNeeded = Math.max(0, gapCssX - sliceStartOffset);

        // Track-to-image scale ratio
        const usableImageWidth = Math.max(1, bgRect.width - (sliceRect ? sliceRect.width : btnRect.width));
        const ratio = maxTravel / usableImageWidth;
        const travelRatio = (ratio > 0.82 && ratio < 1.18) ? 1.0 : ratio;

        const targetDistance = Math.max(10, Math.min(maxTravel, Math.round(sliceTravelNeeded * travelRatio)));

        log('drag geometry: gapCssX=' + gapCssX + 'px sliceStart=' + sliceStartOffset + 'px travelNeeded=' + sliceTravelNeeded + 'px maxTravel=' + maxTravel + 'px finalDistance=' + targetDistance + 'px');

        await executeDrag(ch.sliderHandle, targetDistance);

        // Verification settling check
        await sleep(rand(1200, 1800));
        if (thisSolveId !== activeSolveId) return false;

        const updatedCh = findAliyunChallenge();
        if (!updatedCh.found || checkSolvedState(updatedCh.container)) {
          log('Aliyun CAPTCHA verified successfully ✓');
          if (ch.container) ch.container.setAttribute(DONE_ATTR, 'true');
          safeSendMessage({
            type: 'STATUS',
            status: 'success',
            message: 'Aliyun CAPTCHA solved successfully'
          });
          return true;
        }

        log('verification did not pass on attempt ' + attempts + ' — refreshing');
        if (updatedCh.refreshBtn && isVisible(updatedCh.refreshBtn)) {
          updatedCh.refreshBtn.click();
        }
        await sleep(1500);
      }

      logErr('max attempts reached without passing Aliyun CAPTCHA');
      safeSendMessage({
        type: 'STATUS',
        status: 'failed',
        message: 'Aliyun CAPTCHA: max attempts reached'
      });
      return false;
    } catch (e) {
      logErr('solve exception: ' + (e.message || e));
    } finally {
      solving = false;
    }
  }

  // --- Scanner & Observers ---

  async function scan() {
    if (!isContextValid() || scanBusy || solving) return;

    if (!settingsCache) {
      settingsCache = await getSettings();
    }
    if (settingsCache && settingsCache.enabled === false) return;
    if (settingsCache && settingsCache.solve_aliyun === false) return;

    const challenge = findAliyunChallenge();
    if (!challenge.found || (challenge.container && challenge.container.getAttribute(DONE_ATTR))) {
      return;
    }

    if (checkSolvedState(challenge.container)) return;

    scanBusy = true;
    try {
      log('Aliyun Captcha 2.0 challenge detected on page');
      safeSendMessage({
        type: 'DETECTED',
        provider: 'aliyun',
        version: 'aliyun',
        sitekey: challenge.certifyId || 'aliyun'
      });

      if (!settingsCache || settingsCache.autoSolve !== false) {
        await solveAliyunChallenge();
      }
    } catch (e) {
      logErr('scan exception: ' + (e.message || e));
    } finally {
      scanBusy = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }

  const mo = new MutationObserver(() => {
    if (!isContextValid()) {
      mo.disconnect();
      return;
    }
    scheduleScan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(scan, 600);
  setInterval(scan, 2500);
  setInterval(async () => {
    const s = await getSettings();
    if (s) settingsCache = s;
  }, 10000);

  if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'ALIYUN_SOLVE' || msg.type === 'SLIDER_SOLVE') {
        settingsCache = null;
        solveAliyunChallenge();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'ALIYUN_SCAN') {
        scan();
        sendResponse({ ok: true });
        return;
      }
    });
  }

  log('Aliyun / Slider CAPTCHA scanner initialized');
})();
