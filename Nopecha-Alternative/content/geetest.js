(() => {
  // geetest universal puzzle solver

  // check valid runtime context
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  // optimize 2d canvas contexts
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
  const MAX_ATTEMPTS = 5;
  const DONE_ATTR = 'data-cc-geetest-done';

  // inject page context patch
  let _injected = false;
  function injectPageScript() {
    if (_injected) return;
    _injected = true;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('content/geetest-inject.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
      log('Page-context isTrusted patch injected ✓');
    } catch (e) {
      log('Page-context inject failed (sandboxed?):', e.message);
    }
  }

  function abortActiveSolve(reason = 'aborted') {
    if (solving) {
      log('Aborting active solve sequence (' + reason + ')');
    }
    activeSolveId++;
    solving = false;
    attempts = 0;
  }

  function handleGeeTestReset(reason = 'user-click-reset') {
    log('Reset event detected (' + reason + ') — re-arming GeeTest solver');
    abortActiveSolve(reason);

    // clear previous done markers
    const marked = document.querySelectorAll(`[${DONE_ATTR}]`);
    for (const el of marked) el.removeAttribute(DONE_ATTR);

    // scan mounting geetest container
    setTimeout(scheduleScan, 200);
    setTimeout(scheduleScan, 600);
    setTimeout(scheduleScan, 1200);
    setTimeout(scheduleScan, 2200);
    setTimeout(scheduleScan, 3500);
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
    const line = '[geetest] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC-GeeTest]', 'color:#06b6d4;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function logErr(...args) {
    const line = '[geetest] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.error('%c[CC-GeeTest]', 'color:#ef4444;font-weight:bold', line);
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

    // ignore hidden ghost containers
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = window.getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      const pr = p.getBoundingClientRect();
      if ((pr.width <= 0 || pr.height <= 0) && ps.overflow === 'hidden') return false;
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

  // dom discovery helpers

  function getInstanceHash(el) {
    if (!el) return null;
    const cls = el.className || '';
    const m = cls.match(/geetest_[a-z0-9_]*?_([a-f0-9]{8})/i) ||
              (el.parentElement ? (el.parentElement.className || '').match(/geetest_[a-z0-9_]*?_([a-f0-9]{8})/i) : null);
    return m ? m[1] : null;
  }

  function checkSolvedState(radar) {
    const el = radar || document.querySelector('.geetest_holder, [class*="geetest_holder"], .geetest_btn_click, .geetest_radar_btn');
    if (!el) return false;

    // check success classes
    const holder = el.closest('.geetest_holder') || document.querySelector('.geetest_holder');
    if (holder) {
      if (holder.classList.contains('geetest_radar_success') ||
          holder.classList.contains('geetest_radar_passed') ||
          holder.classList.contains('geetest_lock_success')) {
        return true;
      }
    }

    const solvedClasses = ['geetest_radar_success', 'geetest_lock_success', 'geetest_radar_passed', 'geetest_ghost_success'];
    for (const cls of solvedClasses) {
      const found = document.querySelector('.' + cls);
      if (found && isVisible(found) && !found.classList.contains('geetest_success_btn')) {
        return true;
      }
    }

    // check success tip text
    const successTips = document.querySelectorAll('.geetest_success_radar_tip, .geetest_ghost_success, .geetest_result_content, [class*="geetest_success"]');
    for (const tip of successTips) {
      if (isVisible(tip)) {
        const t = (tip.textContent || '').trim().toLowerCase();
        if (t.includes('verification success') || t.includes('验证成功') || t.includes('verification passed') || t.includes('验证通过') || t.includes('passed') || t.includes('beat') || /^[0-9.]+\s*s$/.test(t)) {
          return true;
        }
      }
    }

    // check error state
    if (el.classList.contains('geetest_radar_error') || el.querySelector('.geetest_radar_error')) {
      return false;
    }

    return false;
  }

  function checkFailState() {
    const failSelectors = [
      '.geetest_panel_error',
      '[class*="geetest_err_tips"]',
      '.geetest_radar_error'
    ];
    for (const sel of failSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 10) return true;
      }
    }

    // check active result tips
    const tips = document.querySelectorAll('.geetest_result_tips, [class*="geetest_result_tip"], .geetest_panel_error');
    for (const tip of tips) {
      if (isVisible(tip)) {
        const t = (tip.textContent || '').toLowerCase();
        if (t.includes('please try again') || t.includes('请重试') || t.includes('little monster') || t.includes('小怪物')) {
          return true;
        }
      }
    }
    return false;
  }

  function findRadarButton() {
    // find radar button
    const directBtnSelectors = [
      '.geetest_radar_btn',
      '.geetest_btn_click',
      '.geetest_radar_click',
      '[class*="geetest_radar_btn"]',
      '[class*="geetest_btn_click"]',
      '.geetest_radar',
      '[class*="geetest_radar"]'
    ];

    for (const sel of directBtnSelectors) {
      const els = document.querySelectorAll(sel);
      for (let i = els.length - 1; i >= 0; i--) {
        const el = els[i];
        if (!isVisible(el)) continue;
        if (checkSolvedState(el)) continue;
        return el;
      }
    }

    // find holder with button
    const holders = document.querySelectorAll('.geetest_holder, [class*="geetest_holder"]');
    for (let i = holders.length - 1; i >= 0; i--) {
      const holder = holders[i];
      if (!isVisible(holder)) continue;
      if (checkSolvedState(holder)) continue;
      const btn = holder.querySelector('.geetest_radar_btn, .geetest_btn_click, .geetest_radar_click, [role="button"]');
      if (btn && isVisible(btn) && !checkSolvedState(btn)) {
        return btn;
      }
      return holder;
    }

    // find text fallback
    const cands = document.querySelectorAll('[aria-label*="Click to verify" i], [title*="Click to verify" i], [aria-label*="点击验证" i], [title*="点击验证" i], div, span, button, a');
    for (const c of cands) {
      if (c.children.length > 3) continue;
      const t = (c.textContent || '').trim().toLowerCase();
      if ((t === 'click to verify' || t === '点击来验证' || t === '点击验证' || t === '安全验证' || t === 'retry' || t === '重试') && isVisible(c)) {
        if (checkSolvedState(c)) continue;
        return c;
      }
    }
    return null;
  }

  function findPuzzleElements(radar) {
    const hash = getInstanceHash(radar);
    let popup = null;

    if (hash) {
      popup = document.querySelector(`.geetest_popup_wrap_${hash}, .geetest_box_wrap_${hash}, .geetest_popup_${hash}`);
    }

    if (!popup) {
      const popups = Array.from(document.querySelectorAll([
        '.geetest_window',
        '.geetest_table_box',
        '[class*="geetest_popup_wrap"]',
        '[class*="geetest_popup"]',
        '[class*="geetest_box_wrap"]',
        '.geetest_widget',
        '.geetest_panel'
      ].join(', '))).filter(p => !p.classList.contains('geetest_lock_success') && !p.classList.contains('geetest_radar_passed'));

      // find active popup container
      popup = popups.find(p => isVisible(p) && (p.querySelector('canvas') || p.querySelector('.geetest_slider_button, [class*="slider"]')))
           || popups.find(p => isVisible(p))
           || popups[popups.length - 1]
           || null;
    }

    const scope = popup || document;

    function findFirstVisible(selectors, rootScope) {
      const roots = rootScope && rootScope !== document ? [rootScope, document] : [document];
      for (const root of roots) {
        for (const sel of selectors) {
          const els = root.querySelectorAll(sel);
          for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            if (isVisible(el)) return el;
          }
        }
      }
      return null;
    }

    function findLastCanvas(selectors, rootScope) {
      const roots = rootScope && rootScope !== document ? [rootScope, document] : [document];
      for (const root of roots) {
        for (const sel of selectors) {
          const els = root.querySelectorAll(sel);
          for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            if (el.isConnected && (el.width >= 50 || el.getBoundingClientRect().width > 20)) return el;
          }
        }
      }
      return null;
    }

    // find challenge background
    const bgSelectors = [
      'canvas.geetest_canvas_bg',
      'canvas[class*="geetest_canvas_bg"]',
      'div.geetest_bg[style*="background-image"]',
      '[class*="geetest_bg"][style*="background-image"]',
      '[class*="geetest_bg"]:not([class*="slice"])'
    ];
    const bg = findFirstVisible(bgSelectors, scope);

    // find clean background canvas
    const fullbgSelectors = [
      'canvas.geetest_canvas_fullbg',
      'canvas[class*="geetest_canvas_fullbg"]'
    ];
    const fullbg = findLastCanvas(fullbgSelectors, scope);

    // find slice cutout element
    const sliceSelectors = [
      'canvas.geetest_canvas_slice',
      'canvas[class*="geetest_canvas_slice"]',
      '[class*="geetest_slice_bg"]',
      '[class*="geetest_slice"]'
    ];
    const slice = findFirstVisible(sliceSelectors, scope);

    // find slider handle
    const sliderSelectors = [
      '.geetest_slider_button',
      '[class*="geetest_slider_button"]',
      '[class*="geetest_slider"] [class*="geetest_btn"]',
      '.geetest_btn[role="slider"]',
      '.geetest_slider_btn',
      '[class*="geetest_btn"][class*="slider"]',
      '[class*="geetest_arrow"]'
    ];
    const slider = findFirstVisible(sliderSelectors, scope);

    // find refresh button
    const resetBtn = scope.querySelector([
      '[class*="geetest_refresh"]',
      '.geetest_refresh',
      '.geetest_reset',
      '[aria-label*="refresh" i]',
      '[title*="refresh" i]'
    ].join(', '));

    const bgRect = bg ? bg.getBoundingClientRect() : null;
    const bgHasSize = !!(bg && bgRect && bgRect.width > 20 && bgRect.height > 20);
    const sliderHasSize = !!(slider && isVisible(slider));
    const isOpen = bgHasSize && sliderHasSize;

    return {
      bg,
      fullbg,
      slice,
      slider,
      resetBtn,
      popup,
      isOpen,
      isReady: bgHasSize && sliderHasSize
    };
  }

  // wait for puzzle render

  // wait for painted pixels
  async function waitForCaptchaToLoad(maxWaitMs = 12000) {
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < maxWaitMs) {
      const radar = findRadarButton();
      const puzzle = findPuzzleElements(radar);

      if (puzzle.bg && puzzle.slider && isVisible(puzzle.slider)) {
        // v3 canvas check
        if (puzzle.bg.tagName === 'CANVAS') {
          const bg = puzzle.bg;
          const w = bg.width;
          const h = bg.height;

          if (w >= 50 && h >= 50 && isVisible(bg)) {
            try {
              const ctx = bg.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                // test canvas pixel samples
                const samplePoints = [
                  [Math.round(w * 0.2), Math.round(h * 0.3)],
                  [Math.round(w * 0.5), Math.round(h * 0.5)],
                  [Math.round(w * 0.8), Math.round(h * 0.7)],
                  [Math.round(w * 0.3), Math.round(h * 0.8)]
                ];
                let paintedCount = 0;
                for (const [x, y] of samplePoints) {
                  const pixel = ctx.getImageData(x, y, 1, 1).data;
                  // check non blank pixel
                  if (pixel[3] > 0 && (pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0)) {
                    paintedCount++;
                  }
                }

                // confirm ready pixel threshold
                if (paintedCount >= 3) {
                  return { ready: true, puzzle };
                }
              }
            } catch (e) {
              // handle tainted canvas fallback
              if (bg.getBoundingClientRect().width > 50) {
                return { ready: true, puzzle };
              }
            }
          }
        } else {
          // v4 css background check
          const style = window.getComputedStyle(puzzle.bg);
          const bgImg = style.backgroundImage || '';
          if (bgImg.includes('url(') && !bgImg.includes('about:blank') && isVisible(puzzle.bg)) {
            return { ready: true, puzzle };
          }
        }
      }

      if (Date.now() - lastLog > 1500) {
        log('waiting for captcha elements & images to finish loading...');
        lastLog = Date.now();
      }

      await sleep(200);
    }

    return { ready: false, puzzle: findPuzzleElements(findRadarButton()) };
  }

  // trigger radar click

  async function clickRadar(radar) {
    if (!radar || !radar.isConnected) radar = findRadarButton();
    if (!radar) return false;

    log('clicking GeeTest radar button ("Click to verify")...');
    try { radar.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    await sleep(rand(80, 160));

    // pick clickable button target
    const target = radar.matches('.geetest_radar_btn, .geetest_btn_click, .geetest_radar_click')
      ? radar
      : (radar.querySelector('.geetest_radar_btn, .geetest_btn_click, .geetest_radar_click, [role="button"]') || radar);
    const rect = target.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    const baseOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: window.screenX + cx,
      screenY: window.screenY + cy,
      button: 0,
      buttons: 0
    };

    target.dispatchEvent(new MouseEvent('mouseover', baseOpts));
    await sleep(rand(50, 100));
    if (window.__ccClickAnim) window.__ccClickAnim(cx, cy);
    target.dispatchEvent(new MouseEvent('mousedown', { ...baseOpts, buttons: 1 }));
    await sleep(rand(60, 120));
    target.dispatchEvent(new MouseEvent('mouseup', baseOpts));
    target.dispatchEvent(new MouseEvent('click', baseOpts));

    if (typeof target.click === 'function') {
      target.click();
    } else if (target !== radar && typeof radar.click === 'function') {
      radar.click();
    }

    return true;
  }

  // canvas gap calculation

  function tryDirectCanvasDiff(bgCanvas, fullbgCanvas, sliceCanvas) {
    try {
      const bg = (bgCanvas && bgCanvas.tagName === 'CANVAS') ? bgCanvas : document.querySelector('canvas.geetest_canvas_bg');
      const full = (fullbgCanvas && fullbgCanvas.tagName === 'CANVAS') ? fullbgCanvas : document.querySelector('canvas.geetest_canvas_fullbg');
      if (!bg || !full) return null;

      const w = bg.width;
      const h = bg.height;
      if (!w || !h || w < 50 || h < 50) return null;

      const bgCtx = bg.getContext('2d', { willReadFrequently: true });
      const fullCtx = full.getContext('2d', { willReadFrequently: true });
      if (!bgCtx || !fullCtx) return null;

      const bgData = bgCtx.getImageData(0, 0, w, h).data;
      const fullData = fullCtx.getImageData(0, 0, w, h).data;

      // verify non empty canvas
      let bgSampleHits = 0;
      let fullSampleHits = 0;
      for (let i = 0; i < Math.min(bgData.length, 3000); i += 30) {
        if (bgData[i] > 10 || bgData[i + 1] > 10 || bgData[i + 2] > 10) bgSampleHits++;
        if (fullData[i] > 10 || fullData[i + 1] > 10 || fullData[i + 2] > 10) fullSampleHits++;
      }
      if (bgSampleHits < 15 || fullSampleHits < 15) {
        return null;
      }

      let sliceMinX = 5;
      const sl = (sliceCanvas && sliceCanvas.tagName === 'CANVAS') ? sliceCanvas : document.querySelector('canvas.geetest_canvas_slice');
      if (sl) {
        try {
          const sCtx = sl.getContext('2d', { willReadFrequently: true });
          const sData = sCtx.getImageData(0, 0, w, h).data;
          for (let x = 0; x < w; x++) {
            let found = false;
            for (let y = 0; y < h; y++) {
              if (sData[(y * w + x) * 4 + 3] > 100) {
                sliceMinX = x;
                found = true;
                break;
              }
            }
            if (found) break;
          }
        } catch {}
      }

      // scan for cutout notch
      let firstGapX = 0;
      for (let x = 40; x < w - 20; x++) {
        let diffCount = 0;
        for (let y = 30; y < h - 10; y++) {
          const idx = (y * w + x) * 4;
          const d = Math.abs(bgData[idx] - fullData[idx]) +
                    Math.abs(bgData[idx + 1] - fullData[idx + 1]) +
                    Math.abs(bgData[idx + 2] - fullData[idx + 2]);
          if (d > 70) diffCount++;
        }
        if (diffCount >= 15) {
          firstGapX = x;
          break;
        }
      }

      if (firstGapX >= 40) {
        log('local canvas diff calculated: firstGapX=' + firstGapX + ' sliceMinX=' + sliceMinX + ' gapX=' + (firstGapX - sliceMinX));
        return {
          gapX: firstGapX - sliceMinX,
          directDistance: true,
          naturalWidth: w,
          naturalHeight: h,
          method: 'local_canvas_diff'
        };
      }
    } catch (e) {
      log('local canvas diff skipped:', e.message);
    }
    return null;
  }

  function extractBackgroundInfo(bgEl, sliceEl, fullbgEl) {
    // export v3 canvas payload
    const canvasBg = (bgEl && bgEl.tagName === 'CANVAS') ? bgEl : document.querySelector('canvas.geetest_canvas_bg');
    const canvasSlice = (sliceEl && sliceEl.tagName === 'CANVAS') ? sliceEl : document.querySelector('canvas.geetest_canvas_slice');
    const canvasFullbg = (fullbgEl && fullbgEl.tagName === 'CANVAS') ? fullbgEl : document.querySelector('canvas.geetest_canvas_fullbg');

    if (canvasBg) {
      try {
        const bgB64 = canvasBg.toDataURL('image/png').split(',')[1];
        let sliceB64 = null;
        if (canvasSlice) {
          try { sliceB64 = canvasSlice.toDataURL('image/png').split(',')[1]; } catch {}
        }
        let fullbgB64 = null;
        if (canvasFullbg) {
          try { fullbgB64 = canvasFullbg.toDataURL('image/png').split(',')[1]; } catch {}
        }

        if (bgB64 && bgB64.length > 200) {
          return {
            type: 'canvas',
            bgB64,
            sliceB64,
            fullbgB64,
            canvasBg,
            canvasSlice,
            canvasFullbg,
            relativeY: 0
          };
        }
      } catch (e) {
        log('canvas export restricted (tainted):', e.message);
      }
    }

    // extract v4 css images
    if (bgEl) {
      const bgStyle = window.getComputedStyle(bgEl);
      const bgMatch = bgStyle.backgroundImage ? bgStyle.backgroundImage.match(/url\(["']?([^"']+)["']?\)/) : null;
      if (bgMatch && bgMatch[1] && !bgMatch[1].includes('about:blank')) {
        let sliceUrl = null;
        const sliceCandidate = sliceEl ? (sliceEl.querySelector('[class*="geetest_slice_bg"]') || sliceEl) : document.querySelector('[class*="geetest_slice_bg"]');
        if (sliceCandidate) {
          const sStyle = window.getComputedStyle(sliceCandidate);
          const sMatch = sStyle.backgroundImage ? sStyle.backgroundImage.match(/url\(["']?([^"']+)["']?\)/) : null;
          if (sMatch) sliceUrl = sMatch[1];
        }

        const bgRect = bgEl.getBoundingClientRect();
        const sliceRect = sliceCandidate ? sliceCandidate.getBoundingClientRect() : null;
        const scaleY = 200 / (bgRect.height || 200);
        const relativeY = sliceRect && bgRect ? Math.round((sliceRect.top - bgRect.top) * scaleY) : 80;

        return {
          type: 'url',
          bgUrl: bgMatch[1],
          sliceUrl,
          relativeY
        };
      }
    }

    return null;
  }

  async function waitForBackgroundInfo(bgEl, sliceEl, fullbgEl, maxWaitMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const info = extractBackgroundInfo(bgEl, sliceEl, fullbgEl);
      if (info && (info.bgUrl || info.bgB64)) return info;
      await sleep(200);
    }
    return null;
  }

  async function requestGapCalculation(info) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'GEETEST_CALCULATE_GAP',
        bgUrl: info.bgUrl,
        sliceUrl: info.sliceUrl,
        bgB64: info.bgB64,
        sliceB64: info.sliceB64,
        fullbgB64: info.fullbgB64,
        relativeY: info.relativeY
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          log('gap service calculation failed:', chrome.runtime.lastError?.message || resp?.error);
          return resolve(null);
        }
        resolve(resp);
      });
    });
  }

  // humanoid drag trajectory simulation

  // cubic bezier helper
  function bezier(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  }

  // generate human drag track
  function generateHumanTrack(distance) {
    const track = [];
    const steps = rand(34, 40);

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      // apply cubic ease out
      const ease = 1 - Math.pow(1 - progress, 3);
      const curX = Math.round(distance * ease);
      const curY = Math.round((Math.sin(progress * Math.PI) * 1.5) + (Math.random() - 0.5) * 0.5);
      const delay = 16;

      track.push({ x: curX, y: curY, delay });
    }

    return track;
  }

  async function simulateHumanDrag(sliderButton, distance) {
    if (!sliderButton) return;
    const thisSolveId = activeSolveId;
    const rect = sliderButton.getBoundingClientRect();

    const startX = Math.round(rect.left + rect.width / 2);
    const startY = Math.round(rect.top + rect.height / 2);

    log('executing humanoid serial drag: distance=' + distance + 'px from (' + startX + ',' + startY + ')');

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

    // start mouse drag
    if (window.__ccCursorMove) window.__ccCursorMove(startX, startY);
    fire('mousedown', startX, startY, 1);
    await sleep(rand(100, 140));

    // dispatch movement points
    const track = generateHumanTrack(distance);
    for (const pt of track) {
      if (thisSolveId !== activeSolveId) return;
      const curX = startX + pt.x;
      const curY = startY + pt.y;
      if (window.__ccCursorMove) window.__ccCursorMove(curX, curY);
      fire('mousemove', curX, curY, 1);
      await sleep(pt.delay);
    }

    // settle before release
    await sleep(rand(160, 200));

    const finalX = startX + distance;
    if (window.__ccCursorRelease) window.__ccCursorRelease(finalX, startY);
    fire('mouseup', finalX, startY, 0);

    log('drag released at X=' + finalX + ' (target=' + finalX + ')');
  }

  // main solve flow

  async function solveGeeTestChallenge() {
    if (solving) return;
    solving = true;
    const thisSolveId = ++activeSolveId;

    try {
      safeSendMessage({ type: 'STATUS', status: 'working', message: 'GeeTest: challenge in progress', attempt: attempts });

      for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
        if (thisSolveId !== activeSolveId) {
          log('Solve loop interrupted by reset event');
          return false;
        }

        log('solve attempt ' + attempts + '/' + MAX_ATTEMPTS);

        let radar = findRadarButton();
        let puzzle = findPuzzleElements(radar);

        // open radar if closed
        if (!puzzle.isOpen || !puzzle.isReady) {
          radar = findRadarButton();
          if (radar) {
            log('clicking GeeTest radar button ("Click to verify")...');
            await clickRadar(radar);
            log('radar clicked — waiting for captcha challenge to load...');
            safeSendMessage({ type: 'STATUS', status: 'working', message: 'GeeTest: waiting for captcha to load...', attempt: attempts - 1 });
          }
        }

        // wait for puzzle render
        log('waiting for captcha elements & images to load completely...');
        const loadResult = await waitForCaptchaToLoad(12000);
        if (thisSolveId !== activeSolveId) return false;

        puzzle = loadResult.puzzle;
        if (!loadResult.ready || !puzzle.bg || !puzzle.slider) {
          log('captcha challenge failed to load in time — retrying attempt');
          await sleep(1500);
          continue;
        }

        log('captcha fully loaded and painted: slider=' + (puzzle.slider ? puzzle.slider.className : 'unknown'));

        // settling delay for popup
        const humanDelay = rand(450, 650);
        log(`puzzle settled — natural settling delay (${humanDelay}ms)...`);
        safeSendMessage({ type: 'STATUS', status: 'working', message: 'GeeTest: inspecting puzzle...', attempt: attempts - 1 });
        await sleep(humanDelay);
        if (thisSolveId !== activeSolveId) return false;

        // compute gap offset
        safeSendMessage({ type: 'STATUS', status: 'working', message: 'GeeTest: analyzing puzzle gap (attempt ' + attempts + '/' + MAX_ATTEMPTS + ')', attempt: attempts - 1 });

        // try direct canvas diff
        let gapResult = tryDirectCanvasDiff(puzzle.bg, puzzle.fullbg, puzzle.slice);

        // retry canvas diff once
        if (!gapResult && puzzle.bg.tagName === 'CANVAS') {
          await sleep(350);
          gapResult = tryDirectCanvasDiff(puzzle.bg, puzzle.fullbg, puzzle.slice);
        }

        // fallback to background worker
        if (!gapResult) {
          const bgInfo = await waitForBackgroundInfo(puzzle.bg, puzzle.slice, puzzle.fullbg, 4000);
          if (!bgInfo) {
            logErr('could not extract background information');
            if (puzzle.resetBtn && isVisible(puzzle.resetBtn)) {
              puzzle.resetBtn.click();
            }
            await sleep(1500);
            continue;
          }

          gapResult = await requestGapCalculation(bgInfo);
        }

        if (!gapResult || typeof gapResult.gapX !== 'number') {
          logErr('gap calculation returned null or invalid — refreshing');
          if (puzzle.resetBtn && isVisible(puzzle.resetBtn)) {
            puzzle.resetBtn.click();
          }
          await sleep(1500);
          continue;
        }

        const bgRect = puzzle.bg.getBoundingClientRect();
        const naturalWidth = gapResult.naturalWidth || (puzzle.bg.tagName === 'CANVAS' ? puzzle.bg.width : 300);
        const scale = bgRect.width > 0 ? (bgRect.width / naturalWidth) : 1;

        let targetDistance;
        if (gapResult.directDistance) {
          targetDistance = Math.round(gapResult.gapX * scale);
        } else {
          const minX = typeof gapResult.minX === 'number' ? gapResult.minX : (puzzle.bg.tagName === 'CANVAS' ? 6 : 14);
          targetDistance = Math.round(Math.max(15, (gapResult.gapX - minX) * scale));
        }

        log('target move X=' + targetDistance + 'px (scale=' + scale.toFixed(2) + ', method=' + gapResult.method + ', rawX=' + gapResult.gapX + ')');
        safeSendMessage({ type: 'STATUS', status: 'working', message: 'GeeTest: sliding puzzle piece (' + targetDistance + 'px)', attempt: attempts - 1 });

        // pause before grabbing
        await sleep(rand(120, 200));
        if (thisSolveId !== activeSolveId) return false;

        // perform humanoid drag
        await simulateHumanDrag(puzzle.slider, targetDistance);

        // await validation response
        log('waiting for validation response...');
        let resolved = false;
        for (let wait = 0; wait < 28; wait++) {
          if (thisSolveId !== activeSolveId) return false;
          await sleep(250);

          radar = findRadarButton() || radar;
          if (checkSolvedState(radar)) {
            log('GeeTest verification success detected 🎉');
            safeSendMessage({ type: 'STATUS', status: 'success', message: 'GeeTest solved 🎉' });
            if (puzzle.popup) puzzle.popup.setAttribute(DONE_ATTR, 'true');
            if (radar) radar.setAttribute(DONE_ATTR, 'true');
            const holder = document.querySelector('.geetest_holder');
            if (holder) holder.setAttribute(DONE_ATTR, 'true');
            // reset page reload counter
            try { sessionStorage.removeItem('__cc_gt_reloads__'); } catch {}
            resolved = true;
            return true;
          }

          if (checkFailState()) {
            log('GeeTest indicated failure/retry');
            break;
          }
        }

        if (resolved) return true;

        log('attempt failed or timed out — refreshing challenge');
        if (puzzle.resetBtn && isVisible(puzzle.resetBtn)) {
          puzzle.resetBtn.click();
        } else {
          const retryBtn = document.querySelector('.geetest_radar_btn, .geetest_btn_click, .geetest_radar_error');
          if (retryBtn) {
            try { retryBtn.click(); } catch {}
          }
        }
        await sleep(rand(1800, 2800));
      }

      logErr('max GeeTest attempts reached without verification');
      safeSendMessage({ type: 'STATUS', status: 'failed', message: 'GeeTest: max attempts reached' });

      // reload fallback if stuck
      const RELOAD_KEY = '__cc_gt_reloads__';
      const RELOAD_MAX = 3;
      let reloadCount = 0;
      try { reloadCount = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10) || 0; } catch {}

      await sleep(rand(1500, 2500));
      const radarStillThere = findRadarButton();
      const stillUnsolved = radarStillThere && !checkSolvedState(radarStillThere);

      if (stillUnsolved && reloadCount < RELOAD_MAX) {
        const next = reloadCount + 1;
        log(`Captcha still present after max attempts — reload ${next}/${RELOAD_MAX} in 3s...`);
        safeSendMessage({ type: 'STATUS', status: 'working', message: `GeeTest: reloading page (${next}/${RELOAD_MAX})...` });
        try { sessionStorage.setItem(RELOAD_KEY, String(next)); } catch {}

        // calculate backoff delay
        const backOff = [3000, 5000, 8000][reloadCount] || 3000;
        await sleep(backOff + rand(0, 800));

        // verify solved state
        const radarFinal = findRadarButton();
        if (radarFinal && !checkSolvedState(radarFinal)) {
          log('Reloading page now.');
          window.location.reload();
        } else {
          log('Captcha resolved during back-off wait — skipping reload.');
          try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
        }
      } else if (stillUnsolved && reloadCount >= RELOAD_MAX) {
        logErr(`Max page reloads (${RELOAD_MAX}) reached — giving up to avoid infinite loop.`);
        safeSendMessage({ type: 'STATUS', status: 'failed', message: `GeeTest: max reloads (${RELOAD_MAX}) exhausted` });
        try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
      } else {
        // reset reload counter
        try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
      }

      return false;
    } finally {
      if (thisSolveId === activeSolveId) {
        solving = false;
      }
    }
  }

  // scanner and lifecycle

  let scanBusy = false;
  let scanTimer = null;

  async function scan() {
    if (scanBusy || solving) return;
    if (!isContextValid()) return;

    if (!settingsCache) settingsCache = await getSettings();
    if (!settingsCache || settingsCache.enabled === false) return;
    if (settingsCache.solve_geetest === false) return;
    if (!settingsCache.autoSolve && !settingsCache.autoClick) return;

    // cleanup stale done flags
    const marked = document.querySelectorAll(`[${DONE_ATTR}]`);
    for (const el of marked) {
      if (!checkSolvedState(el)) {
        el.removeAttribute(DONE_ATTR);
      }
    }

    const radar = findRadarButton();
    const puzzle = findPuzzleElements(radar);

    if (checkSolvedState(radar)) return;

    scanBusy = true;
    try {
      if (puzzle.isReady) {
        log('live GeeTest puzzle window detected');
        safeSendMessage({ type: 'DETECTED', provider: 'geetest', version: 'geetest' });
        await solveGeeTestChallenge();
        return;
      }

      if (radar && !radar.getAttribute(DONE_ATTR)) {
        log('GeeTest radar button detected');
        safeSendMessage({ type: 'DETECTED', provider: 'geetest', version: 'geetest' });
        await solveGeeTestChallenge();
        return;
      }
    } catch (e) {
      logErr('scan exception: ' + (e.message || e));
    } finally {
      scanBusy = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  }

  // handle reset click
  window.addEventListener('CC_CAPTCHA_RESET', (e) => {
    handleGeeTestReset((e.detail && e.detail.reason) || 'cc-captcha-reset');
  });

  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const target = e.target;
    if (!target) return;
    const btn = target.closest('button, a, [role="button"], input[type="button"], input[type="reset"]');
    if (!btn) return;
    const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
    const isReset = txt.includes('reset') || btn.id === 'reset' || (btn.className && String(btn.className).includes('reset'));
    if (isReset) {
      handleGeeTestReset('user-click-reset');
    }
  }, true);

  const mo = new MutationObserver(() => {
    if (!isContextValid()) {
      mo.disconnect();
      return;
    }
    scheduleScan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(scan, 800);
  setInterval(scan, 4000);
  setInterval(async () => {
    const s = await getSettings();
    if (s) settingsCache = s;
  }, 10000);

  if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'GEETEST_SCAN' || msg.type === 'GEETEST_SOLVE') {
        settingsCache = null;
        handleGeeTestReset('message-trigger');
        solveGeeTestChallenge();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'GEETEST_RESET') {
        handleGeeTestReset('message-reset');
        sendResponse({ ok: true });
        return;
      }
    });
  }

  // patch page context
  injectPageScript();

  log('GeeTest scanner initialized');
})();
