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
    console.log('%c[CC-Aliyun-ERR]', 'color:#ef4444;font-weight:bold', line);
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

  function findPuzzleBackground(track, container) {
    const scope = container || document;

    // Must be actual visual media: <img> with src, <canvas>, or <div> with url()
    const mediaElements = Array.from(scope.querySelectorAll('canvas, img')).filter(isVisible);
    const bgDivs = Array.from(scope.querySelectorAll('div[style*="url("], div[style*="url ("]')).filter(isVisible);
    for (const d of bgDivs) {
      if (!mediaElements.includes(d)) mediaElements.push(d);
    }

    const candidates = mediaElements.map((el) => {
      const r = el.getBoundingClientRect();
      const cls = String(el.className || '').toLowerCase();
      const id = String(el.id || '').toLowerCase();
      const isLogo = cls.includes('logo') || id.includes('logo') || cls.includes('icon') || cls.includes('watermark') || cls.includes('avatar');
      const isModal = cls.includes('modal') || cls.includes('dialog') || cls.includes('popup') || cls.includes('wrapper') || cls.includes('card');
      const aspectRatio = r.width > 0 ? (r.height / r.width) : 0;
      return { el, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, area: r.width * r.height, aspectRatio, isLogo, isModal };
    }).filter((item) => {
      return (
        !item.isLogo &&
        !item.isModal &&
        item.width >= 160 && item.width <= 480 &&
        item.height >= 90 && item.height <= 360 &&
        item.aspectRatio >= 0.35 && item.aspectRatio <= 1.25
      );
    });

    if (track) {
      const tr = track.getBoundingClientRect();
      const above = candidates.filter((item) => item.bottom <= tr.top + 45 && item.top < tr.top);
      if (above.length > 0) {
        above.sort((a, b) => b.area - a.area);
        return above[0].el;
      }
    }

    if (candidates.length > 0) {
      // Prioritize <img> or <canvas> over <div>
      candidates.sort((a, b) => {
        const aIsImg = a.el.tagName === 'IMG' || a.el.tagName === 'CANVAS' ? 1 : 0;
        const bIsImg = b.el.tagName === 'IMG' || b.el.tagName === 'CANVAS' ? 1 : 0;
        if (aIsImg !== bIsImg) return bIsImg - aIsImg;
        return b.area - a.area;
      });
      return candidates[0].el;
    }

    return null;
  }

  function findSliderTrack(bg) {
    const allElements = Array.from(document.querySelectorAll('*')).filter(isVisible);

    // 1. If bg is known, track is immediately underneath bg
    if (bg) {
      const bgr = bg.getBoundingClientRect();
      const underBg = allElements.filter((el) => {
        if (el === bg || el.contains(bg)) return false;
        const cls = String(el.className || '').toLowerCase();
        const id = String(el.id || '').toLowerCase();
        if (cls.includes('logo') || id.includes('logo') || cls.includes('footer') || cls.includes('header')) return false;
        const r = el.getBoundingClientRect();
        return (
          r.top >= bgr.bottom - 12 &&
          r.top <= bgr.bottom + 95 &&
          r.width >= 160 && r.width <= 500 &&
          r.height >= 22 && r.height <= 75 &&
          Math.abs(r.left - bgr.left) <= 45
        );
      });

      if (underBg.length > 0) {
        // Prefer element containing prompt text or track class
        const withTextOrClass = underBg.filter((el) => {
          const txt = (el.textContent || '').toLowerCase();
          const cls = String(el.className || '').toLowerCase();
          const id = String(el.id || '').toLowerCase();
          return (
            txt.includes('drag') || txt.includes('slider') || txt.includes('slide') ||
            txt.includes('滑动') || txt.includes('拖动') ||
            cls.includes('track') || id.includes('track') ||
            cls.includes('sliding') || id.includes('sliding') ||
            cls.includes('scale')
          );
        });
        if (withTextOrClass.length > 0) {
          withTextOrClass.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
          return withTextOrClass[0];
        }
        underBg.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        return underBg[0];
      }
    }

    // 2. Specific Aliyun 2.0 / Baxia track selectors
    const specificSelectors = [
      '#aliyunCaptcha-sliding-wrapper',
      '[id*="sliding-wrapper"]',
      '[class*="sliding-track"]',
      '[class*="slider-track"]',
      '[class*="sliding-body"]',
      '.nc_scale',
      '[class*="nc_scale"]',
      '[class*="scale_text"]',
      '[class*="slidetounlock"]'
    ];
    for (const sel of specificSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 20 && r.height <= 85) return el;
      }
    }

    // 3. Text-based search
    for (const el of allElements) {
      const txt = (el.textContent || '');
      const isTrackText = (
        txt.includes('drag the slider to restore the complete image') ||
        txt.includes('Please drag the slider') ||
        txt.includes('向右滑动验证') ||
        txt.includes('向右滑动') ||
        txt.includes('拖动滑块') ||
        txt.includes('slide to verify')
      );
      if (isTrackText) {
        const r = el.getBoundingClientRect();
        if (r.width >= 160 && r.width <= 500 && r.height >= 20 && r.height <= 85) {
          const p = el.parentElement;
          if (p) {
            const pr = p.getBoundingClientRect();
            if (pr.width >= 160 && pr.width <= 500 && pr.height >= 20 && pr.height <= 85 && pr.width >= r.width) {
              return p;
            }
          }
          return el;
        }
      }
    }

    return null;
  }

  function findSliderHandle(track, bg) {
    const allElements = Array.from(document.querySelectorAll('*')).filter(isVisible);

    // If bg is known, the slider button is strictly below bg and at the left side of bg
    if (bg) {
      const bgr = bg.getBoundingClientRect();
      const candidates = allElements.filter((el) => {
        if (el === bg || el.contains(bg) || (track && el === track)) return false;
        const cls = String(el.className || '').toLowerCase();
        const id = String(el.id || '').toLowerCase();
        if (
          cls.includes('logo') || id.includes('logo') ||
          cls.includes('close') || id.includes('close') ||
          cls.includes('refresh') || id.includes('refresh') ||
          cls.includes('reload') || id.includes('reload') ||
          cls.includes('title') || id.includes('title') ||
          cls.includes('header') || id.includes('header') ||
          cls.includes('footer') || id.includes('footer') ||
          cls.includes('desc') || cls.includes('prompt')
        ) {
          return false;
        }

        const r = el.getBoundingClientRect();
        return (
          r.top >= bgr.bottom - 10 &&
          r.top <= bgr.bottom + 95 &&
          r.left >= bgr.left - 25 &&
          r.left <= bgr.left + 90 &&
          r.width >= 22 && r.width <= 80 &&
          r.height >= 22 && r.height <= 70
        );
      });

      if (candidates.length > 0) {
        // Priority 1: Known handle classes or IDs
        for (const el of candidates) {
          const cls = String(el.className || '').toLowerCase();
          const id = String(el.id || '').toLowerCase();
          if (
            cls.includes('slider') || id.includes('slider') ||
            cls.includes('btn') || id.includes('btn') ||
            cls.includes('handler') || id.includes('handler') ||
            cls.includes('drag') || id.includes('drag') ||
            cls.includes('iconfont') ||
            el.getAttribute('role') === 'slider'
          ) {
            return el;
          }
        }

        // Priority 2: Contains arrow or icon child
        for (const el of candidates) {
          const txt = (el.textContent || '').trim();
          if (txt === '>>' || txt === '»' || txt === '>' || txt === '→' || txt === '›' || el.querySelector('svg, i, span')) {
            return el;
          }
        }

        // Priority 3: The leftmost candidate element
        candidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return candidates[0];
      }
    }

    // Fallback: If track is known but bg is null (pure slider without puzzle image)
    if (track) {
      const tr = track.getBoundingClientRect();
      const inTrack = allElements.filter((el) => {
        if (el === track || el.contains(track)) return false;
        const cls = String(el.className || '').toLowerCase();
        if (cls.includes('logo') || cls.includes('text') || cls.includes('prompt') || cls.includes('desc')) return false;
        const r = el.getBoundingClientRect();
        return (
          r.width >= 22 && r.width <= 80 &&
          r.height >= 22 && r.height <= 70 &&
          Math.abs((r.top + r.height / 2) - (tr.top + tr.height / 2)) <= 25 &&
          r.left >= tr.left - 15 && r.left <= tr.left + 90
        );
      });

      if (inTrack.length > 0) {
        inTrack.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return inTrack[0];
      }
    }

    return null;
  }

  function getEffectiveTrack(sliderHandle, sliderTrack) {
    if (sliderHandle && sliderHandle.parentElement) {
      let p = sliderHandle.parentElement;
      let best = p;
      let bestWidth = p.getBoundingClientRect().width;
      while (p && p !== document.body && p !== document.documentElement) {
        const pr = p.getBoundingClientRect();
        if (pr.height >= 20 && pr.height <= 85 && pr.width >= 160 && pr.width <= 550) {
          if (pr.width > bestWidth) {
            best = p;
            bestWidth = pr.width;
          }
        } else if (pr.height > 100) {
          break;
        }
        p = p.parentElement;
      }
      if (bestWidth >= 160) return best;
    }
    return sliderTrack;
  }

  function findAliyunChallenge() {
    // 1. Locate background image first (largest visual puzzle image)
    const bg = findPuzzleBackground(null, null);

    // 2. Locate track relative to bg
    const sliderTrack = findSliderTrack(bg);

    // 3. Locate handle strictly below bg
    let sliderHandle = findSliderHandle(sliderTrack, bg);

    // Failsafe: Handle must NEVER be inside or above puzzle background image!
    if (bg && sliderHandle) {
      const hr = sliderHandle.getBoundingClientRect();
      const br = bg.getBoundingClientRect();
      if (hr.top < br.bottom - 10) {
        sliderHandle = null;
      }
    }

    // 4. Locate modal container by walking up from bg or track
    let container = null;
    const anchor = bg || sliderTrack;
    if (anchor) {
      let p = anchor.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        const pr = p.getBoundingClientRect();
        if (pr.width >= 200 && pr.width <= 650 && pr.height >= 200 && pr.height <= 750) {
          container = p;
          let gp = p.parentElement;
          if (gp && gp !== document.body && gp !== document.documentElement) {
            const gpr = gp.getBoundingClientRect();
            if (gpr.width >= 200 && gpr.width <= 650 && gpr.height >= 200 && gpr.height <= 750 && gpr.width >= pr.width) {
              container = gp;
            }
          }
          break;
        }
        p = p.parentElement;
      }
    }

    // 5. Locate cutout slice if separated in DOM
    let slice = null;
    if (bg) {
      const bgr = bg.getBoundingClientRect();
      const scope = container || document;
      const media = Array.from(scope.querySelectorAll('canvas, img, div[style*="background-image"], div[style*="url("]')).filter(isVisible);
      const sliceCandidates = media.filter((el) => {
        if (el === bg) return false;
        const cls = String(el.className || '').toLowerCase();
        if (cls.includes('logo') || cls.includes('track') || cls.includes('icon')) return false;
        const r = el.getBoundingClientRect();
        return (
          r.width >= 18 && r.width <= 120 &&
          r.height >= 18 && r.height <= 120 &&
          r.top >= bgr.top - 25 &&
          r.bottom <= bgr.bottom + 25
        );
      });
      if (sliceCandidates.length > 0) {
        slice = sliceCandidates[0];
      }
    }

    // 6. Refresh button
    let refreshBtn = null;
    const scope = container || document;
    refreshBtn = scope.querySelector([
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

    const certifyId = extractCertifyId(container || document);
    const isReady = !!(sliderHandle && bg && isVisible(sliderHandle) && isVisible(bg));

    return {
      found: !!(sliderTrack || sliderHandle || container || bg),
      container: container || (sliderTrack ? sliderTrack.parentElement : null),
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

  async function extractImageData(el) {
    if (!el) return null;

    // 1. Canvas export
    if (el.tagName === 'CANVAS') {
      try {
        const b64 = el.toDataURL('image/png').split(',')[1];
        if (b64 && b64.length > 50) return { b64, mime: 'image/png' };
      } catch (e) {
        log('Canvas toDataURL error (CORS):', e.message);
      }
    }

    // 2. Image tag
    if (el.tagName === 'IMG') {
      if (el.src && el.src.startsWith('data:image/')) {
        const parts = el.src.split(',');
        const mimeMatch = el.src.match(/data:([^;]+);/);
        return { b64: parts[1], mime: mimeMatch ? mimeMatch[1] : 'image/png', url: el.src };
      }
      try {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth || el.width || Math.round(el.getBoundingClientRect().width);
        c.height = el.naturalHeight || el.height || Math.round(el.getBoundingClientRect().height);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(el, 0, 0);
        const b64 = c.toDataURL('image/png').split(',')[1];
        if (b64 && b64.length > 50) return { b64, mime: 'image/png' };
      } catch (e) {
        log('Image canvas draw error (CORS):', e.message);
      }

      // Try direct content script fetch
      try {
        const resp = await fetch(el.src);
        if (resp.ok) {
          const blob = await resp.blob();
          const reader = new FileReader();
          const b64Promise = new Promise((resolve) => {
            reader.onloadend = () => {
              const res = reader.result;
              if (typeof res === 'string' && res.includes(',')) {
                resolve(res.split(',')[1]);
              } else {
                resolve(null);
              }
            };
            reader.onerror = () => resolve(null);
          });
          reader.readAsDataURL(blob);
          const fetchedB64 = await b64Promise;
          if (fetchedB64 && fetchedB64.length > 50) {
            log('Image fetched and converted via content fetch ✓');
            return { b64: fetchedB64, mime: blob.type || 'image/png', url: el.src };
          }
        }
      } catch (_) {}

      // Fallback: visual element capture via background tab capture
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 20) {
          const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: 'CAPTURE_ELEMENT_RECT',
                rect: {
                  x: Math.round(r.left),
                  y: Math.round(r.top),
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                  dpr: window.devicePixelRatio || 1
                }
              },
              resolve
            );
          });
          if (resp && resp.ok && resp.b64) {
            log('Element visual crop captured via background tab capture ✓');
            return { b64: resp.b64, mime: 'image/png', url: el.src };
          }
        }
      } catch (e) {
        log('CAPTURE_ELEMENT_RECT fallback error:', e.message);
      }

      if (el.src && /^https?:\/\//i.test(el.src)) {
        return { url: el.src };
      }
    }

    // 3. CSS Background-Image
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
      if (/^https?:\/\//i.test(u)) {
        return { url: u };
      }
    }

    // 4. Bulletproof Fallback: Capture exact element rectangle via background captureVisibleTab
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: 'CAPTURE_ELEMENT_RECT',
              rect: {
                x: Math.round(r.left),
                y: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
                dpr: window.devicePixelRatio || 1
              }
            },
            resolve
          );
        });
        if (resp && resp.ok && resp.b64) {
          log('Element visual crop captured via background tab capture ✓');
          return { b64: resp.b64, mime: 'image/png' };
        }
      }
    } catch (e) {
      log('CAPTURE_ELEMENT_RECT fallback error:', e.message);
    }

    return null;
  }

  async function waitForCaptchaToLoad(maxWaitMs = 10000) {
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < maxWaitMs) {
      const ch = findAliyunChallenge();

      if (ch.isReady) {
        const bgRect = ch.bg.getBoundingClientRect();
        const handleRect = ch.sliderHandle.getBoundingClientRect();
        log(`Elements located: handle=${ch.sliderHandle.tagName}.${ch.sliderHandle.className} (${Math.round(handleRect.width)}x${Math.round(handleRect.height)}) at (${Math.round(handleRect.left)},${Math.round(handleRect.top)}) | bg=${ch.bg.tagName} (${Math.round(bgRect.width)}x${Math.round(bgRect.height)})`);

        const bgData = await extractImageData(ch.bg);
        if (bgData && (bgData.b64 || bgData.url)) {
          return { ready: true, challenge: ch, bgData };
        }
      }

      if (Date.now() - lastLog > 2000) {
        const bgInfo = ch.bg ? `${ch.bg.tagName}.${ch.bg.className || ''}(${Math.round(ch.bg.getBoundingClientRect().width)}x${Math.round(ch.bg.getBoundingClientRect().height)})` : 'null';
        const trackInfo = ch.sliderTrack ? `${ch.sliderTrack.tagName}.${ch.sliderTrack.className || ''}(${Math.round(ch.sliderTrack.getBoundingClientRect().width)}x${Math.round(ch.sliderTrack.getBoundingClientRect().height)})` : 'null';
        const handleInfo = ch.sliderHandle ? `${ch.sliderHandle.tagName}.${ch.sliderHandle.className || ''}(${Math.round(ch.sliderHandle.getBoundingClientRect().width)}x${Math.round(ch.sliderHandle.getBoundingClientRect().height)})` : 'null';
        log(`Waiting for elements... track=${!!ch.sliderTrack} handle=${!!ch.sliderHandle} bg=${!!ch.bg} ready=${ch.isReady} | bg=${bgInfo} track=${trackInfo} handle=${handleInfo}`);
        lastLog = Date.now();
      }

      await sleep(250);
    }

    const finalCh = findAliyunChallenge();
    const finalBgData = finalCh.bg ? await extractImageData(finalCh.bg) : null;
    return { ready: false, challenge: finalCh, bgData: finalBgData };
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

    log('executing hardware CDP drag: distance=' + distance + 'px from (' + startX + ',' + startY + ') to (' + targetX + ',' + targetY + ')');

    // Strategy A: Chrome DevTools Protocol hardware drag via background (isTrusted: true)
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

        const handleRect = ch.sliderHandle.getBoundingClientRect();
        log('captcha fully ready: handle=' + (ch.sliderHandle.className || 'btn') + ' at (' + Math.round(handleRect.left) + ',' + Math.round(handleRect.top) + ')');

        // Natural settling pause
        const settleMs = rand(350, 550);
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

        const sliceData = ch.slice ? await extractImageData(ch.slice) : null;
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
        const scale = bgRect.width > 0 ? (bgRect.width / naturalWidth) : 1;
        const gapCssX = Math.round(gapResult.gapX * scale);

        const btnRect = ch.sliderHandle.getBoundingClientRect();
        const effectiveTrack = getEffectiveTrack(ch.sliderHandle, ch.sliderTrack);
        const trackRect = effectiveTrack ? effectiveTrack.getBoundingClientRect() : null;
        let maxTravel = trackRect ? Math.round(trackRect.width - btnRect.width) : Math.round(bgRect.width - btnRect.width);
        if (maxTravel < 40) {
          maxTravel = Math.max(40, Math.round(bgRect.width - btnRect.width));
        }

        // Only consider sliceStartOffset if slice is a valid small piece (< 75px)
        const isValidSlice = sliceRect && sliceRect.width >= 15 && sliceRect.width <= 75 && sliceRect.height >= 15;
        const sliceStartOffset = isValidSlice ? Math.max(0, Math.round(sliceRect.left - bgRect.left)) : 0;
        const sliceTravelNeeded = Math.max(0, gapCssX - sliceStartOffset);

        // Track-to-image scale ratio: In Aliyun Captcha 2.0, track travel directly maps to image coordinates
        let travelRatio = 1.0;
        const usableImgWidth = Math.max(40, bgRect.width - btnRect.width);
        const rawRatio = maxTravel / usableImgWidth;
        if (rawRatio >= 0.85 && rawRatio <= 1.15) {
          travelRatio = 1.0;
        } else if (rawRatio > 0.4 && rawRatio < 2.5) {
          travelRatio = rawRatio;
        }

        const targetDistance = Math.max(12, Math.min(maxTravel - 2, Math.round(sliceTravelNeeded * travelRatio)));

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
        const ch = findAliyunChallenge();
        if (!ch.found && !ch.bg && !ch.sliderTrack) {
          sendResponse({ ok: false, reason: 'no_captcha_in_frame' });
          return;
        }
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
