// arkose funcaptcha solver module

(() => {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (window.__CC_FUNCAPTCHA_LOADED__) return;
  window.__CC_FUNCAPTCHA_LOADED__ = true;

  let settings = {
    enabled: true,
    autoSolve: true,
    autoClick: true,
    solve_funcaptcha: true
  };

  let isSolving = false;
  let hasClickedStart = false;
  let lastSolveAttempt = 0;
  let lastPromptSolved = '';
  let lastSpriteSolved = '';
  let lastSubmittedTime = 0;
  let lastStartClickTime = 0;
  let lastFailureClickTime = 0;
  let lastVariant = null;
  const START_COOLDOWN_MS = 5000;
  const FAILURE_COOLDOWN_MS = 4000;
  const TILE_W = 200;

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
    const line = '[funcaptcha] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC-FunCap]', 'color:#10b981;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function notifyDetected() {
    safeSendMessage({
      type: 'DETECTED',
      provider: 'funcaptcha',
      version: 'funcaptcha',
      sitekey: document.title || 'challenge-frame'
    });
  }

  function loadSettings() {
    if (!isContextValid()) return;
    try {
      chrome.storage.sync.get(['enabled', 'autoSolve', 'autoClick', 'solve_funcaptcha'], (s) => {
        if (s) settings = { ...settings, ...s };
      });
    } catch {}
  }
  loadSettings();

  if (isContextValid()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
          for (const k in changes) settings[k] = changes[k].newValue;
        }
      });
    } catch {}

    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'FUNCAPTCHA_SOLVE') {
          hasClickedStart = false;
          lastSolveAttempt = 0;
          checkAndSolve();
          sendResponse({ ok: true });
        }
      });
    } catch {}
  }

  function simulateClick(el) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      if (window.__ccClickAnim) window.__ccClickAnim(rect.left + rect.width / 2, rect.top + rect.height / 2);
    } catch {}
    try {
      if (typeof el.click === 'function') {
        el.click();
        return;
      }
    } catch {}
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function has(sel) {
    try {
      return !!document.querySelector(sel);
    } catch {
      return false;
    }
  }

  // detect arkose structural markers
  function isChallengeFrame() {
    // check primary arkose signals
    const strong = [
      '#home_children_button', '#wrong_children_button',
      '#game_children_text', '#game_children_challenge', '#game_challengeItem_image', '#game_challenge',
      '[data-theme*="home."]', '[data-theme*="game."]', '[data-theme*="wrong."]',
      '.key-frame-image'
    ];
    if (strong.some(has)) return true;

    // check secondary widget signals
    let weak = 0;
    if (has('.match-game')) weak++;
    if (has('.tile-game')) weak++;
    if (has('.right-arrow')) weak++;
    if (has('.left-arrow')) weak++;
    if (has('#home')) weak++;
    if (has('#wrong, #wrongTimeout')) weak++;
    return weak >= 2;
  }

  function detectVariant() {
    if (has('#game_children_challenge a')) return 'tile';
    if (has('.tile-game')) return 'tile-v2';
    if (has('.match-game, .key-frame-image, .right-arrow, .left-arrow')) return 'match';
    return null;
  }

  function isActiveChallenge() {
    const variant = detectVariant();
    if (variant === 'tile') return has('#game_children_challenge a');
    if (variant === 'tile-v2') return has('.tile-game .challenge-container button, .tile-game button');
    if (variant === 'match') {
      const { leftBtn, rightBtn } = findNavigationArrows();
      return !!(rightBtn || leftBtn) && !!findSubmitButton();
    }
    return false;
  }

  // find puzzle start button
  function findStartButton() {
    if (isActiveChallenge() || isLoadingScreen()) return null;

    const directSelectors = [
      'button[data-theme="home.verifyButton"]',
      'button[data-theme*="verify" i]',
      'button[data-theme*="start" i]',
      '#home_children_button',
      '[data-theme="home.verify_button"]',
      '.sc-145n3b6-0 button'
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    const homeContainer = document.querySelector('#home, [data-theme*="home"], .home-container');
    const container = homeContainer || document;
    const candidates = Array.from(
      container.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"]')
    );
    const keywords = [
      'start puzzle', 'solve puzzle', 'verify', 'start', 'authenticate',
      'vahvista', 'vahvistus',
      'commencer', 'vérifier',
      'iniciar', 'verificar', 'comenzar',
      'bestätigen', 'starten',
      'отправить', 'проверить',
      'authentifier'
    ];

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (el.className && (el.className.includes('audio') || el.className.includes('restart') || el.className.includes('reload'))) continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (keywords.some((k) => text === k || text.includes(k))) {
        return el;
      }
    }

    if (homeContainer) {
      const mainBtn = homeContainer.querySelector('button.button:not([class*="audio"]):not([class*="restart"]):not([class*="reload"])');
      if (mainBtn && isVisible(mainBtn)) return mainBtn;
    }

    return null;
  }

  function findPromptText() {
    const selectors = [
      '#game_children_text h2',
      '#game_children_text',
      '.tile-game h2',
      '.match-game h2',
      'h2 [role="text"]',
      'h2 span',
      'h2',
      '#game_header',
      '.challenge-instructions',
      '[data-theme="game.header"]',
      'h3',
      '[role="heading"]',
      '.sc-1io4bok-0'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const text = (el.innerText || '').trim();
        if (text.length > 3) return text;
      }
    }

    const allDivs = Array.from(document.querySelectorAll('div, p, span, h2, h3'));
    for (const d of allDivs) {
      if (!isVisible(d)) continue;
      const t = (d.innerText || '').trim();
      if (
        (t.includes('arrows') || t.includes('match') || t.includes('image') ||
         t.includes('Pick') || t.includes('Find') || t.includes('Rotate') ||
         t.includes('nuolia') || t.includes('nuolen') || t.includes('esineiden') ||
         t.includes('määrää') || t.includes('flèches') || t.includes('utiliser') ||
         t.includes('flechas') || t.includes('utiliza') ||
         t.includes('Pfeile') || t.includes('Verwende') ||
         t.match(/\(\d+\s*[\/\-of]\s*\d+\)/i)) &&
        t.length > 8 && t.length < 300
      ) {
        return t;
      }
    }

    return 'Find the matching image';
  }

  function findNavigationArrows() {
    let leftBtn = document.querySelector('a.left-arrow, button.left-arrow, [class*="left-arrow"]');
    let rightBtn = document.querySelector('a.right-arrow, button.right-arrow, [class*="right-arrow"]');

    if (leftBtn && rightBtn && isVisible(leftBtn) && isVisible(rightBtn)) {
      return { leftBtn, rightBtn };
    }

    leftBtn = document.querySelector('button[aria-label*="previous" i], button[aria-label*="left" i], a[aria-label*="previous" i], a[aria-label*="left" i], [aria-label*="edellinen" i], [aria-label*="edellise" i]');
    rightBtn = document.querySelector('button[aria-label*="next" i], button[aria-label*="right" i], a[aria-label*="next" i], a[aria-label*="right" i], [aria-label*="seuraava" i]');

    if (leftBtn && rightBtn && isVisible(leftBtn) && isVisible(rightBtn)) {
      return { leftBtn, rightBtn };
    }

    const buttons = Array.from(document.querySelectorAll('a[role="button"], button, div[role="button"], a'));
    for (const b of buttons) {
      if (!isVisible(b)) continue;
      const html = (b.innerHTML || '').toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const cls = String(b.className || '').toLowerCase();
      const rect = b.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;
      if (!leftBtn && (html.includes('left') || html.includes('prev') || cls.includes('left') || aria.includes('edellinen') || aria.includes('edellise') || aria.includes('previous') || aria.includes('left'))) leftBtn = b;
      else if (!rightBtn && (html.includes('right') || html.includes('next') || cls.includes('right') || aria.includes('seuraava') || aria.includes('next') || aria.includes('right'))) rightBtn = b;
    }

    return { leftBtn, rightBtn };
  }

  function findSubmitButton() {
    const direct = document.querySelector('[data-theme*="submit" i], #victory-submit, button.button.victory-submit, button[data-theme="game.submit"]');
    if (direct && isVisible(direct)) return direct;

    const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], input[type="submit"]'));
    const submitWords = [
      'submit', 'lähetä', 'valider', 'envoyer', 'enviar', 'bestätigen', 'senden',
      'отправить', 'подтвердить', 'verificar', 'invia', 'conferma', 'verzenden',
      'indienen', 'skicka', 'send', 'prześlij', 'wyślij', 'zatwierdź', 'gönder',
      'doğrula', 'küldés', 'potvrdi', 'odeslat', 'submeter', '送信', '決定', '提交',
      '验证', '제출', '확인'
    ];

    for (const b of candidates) {
      if (!isVisible(b)) continue;
      if (b.className && (b.className.includes('audio') || b.className.includes('restart') || b.className.includes('reload') || b.className.includes('arrow'))) continue;
      const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
      if (submitWords.some((w) => t === w || t.includes(w))) {
        return b;
      }
    }

    for (const b of candidates) {
      if (!isVisible(b)) continue;
      if (b.className && (b.className.includes('audio') || b.className.includes('restart') || b.className.includes('reload') || b.className.includes('arrow'))) continue;
      const rect = b.getBoundingClientRect();
      if (rect.width >= 140 && rect.height >= 25) {
        return b;
      }
    }

    const themeBtn = document.querySelector('button.button, button[data-theme*="game"], #home_children_button');
    if (themeBtn && isVisible(themeBtn)) return themeBtn;

    return null;
  }

  function findTryAgainButton() {
    const wrongContainer = document.querySelector('#wrong, #wrongTimeout, [data-theme*="wrong"], [id*="error_screen"], .wrong-container');
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();

    const failurePhrases = [
      'ei mennyt aivan oikein', 'ei aivan oikein', 'mennyt aivan oikein', 'se ei mennyt',
      'not quite right', 'incorrect', 'that was wrong', 'wrong answer',
      'väärä vastaus', 'verification failed', 'vahvistus epäonnistui',
      'whoops', 'try again', 'yritä uudelleen'
    ];
    const hasFailureText = failurePhrases.some((p) => bodyText.includes(p));
    if (!hasFailureText && !wrongContainer) return null;

    const directWrongBtn = document.querySelector('#wrong_children_button, #wrongTimeout button, button[data-theme*="wrong"], [data-theme*="wrong"] button');
    if (directWrongBtn && isVisible(directWrongBtn)) return directWrongBtn;

    // find retry clickable element
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
    const retryWords = ['yritä uudelleen', 'recommencer', 'reintentar', 'erneut versuchen', 'повторить', 'try again'];
    let best = null;
    let bestArea = Infinity;
    for (const b of candidates) {
      if (!isVisible(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 14) continue;
      if (b.className && (b.className.includes('audio') || b.className.includes('reload') || b.className.includes('restart'))) continue;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('restart') || aria.includes('reload') || aria.includes('audio')) continue;
      const t = (b.innerText || b.value || aria).trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (retryWords.some((w) => t === w || t.includes(w))) {
        const area = r.width * r.height;
        if (area < bestArea) { bestArea = area; best = b; }
      }
    }
    return best;
  }

  function isLoadingScreen() {
    if (has('.fc-loading, .loading-spinner')) return true;
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
    const loadingPhrases = [
      'working, please wait', 'bitte warten', 'veuillez patienter',
      'espere por favor', 'attendez', 'por favor espere',
      'загрузка', 'odottakaa', 'vahvistetaan selainta'
    ];
    if (loadingPhrases.some((p) => bodyText.includes(p))) return true;
    return false;
  }

  function getCandidateElement() {
    const el = document.querySelector('img.sc-7csxyx-1, [class*="sc-7csxyx-1"], .answer-frame img, [data-theme*="answer"] img');
    if (el && isVisible(el)) return el;
    const allImgs = Array.from(document.querySelectorAll('img'));
    for (const img of allImgs) {
      if (img.classList.contains('key-frame-image') || (img.className && String(img.className).includes('key-frame'))) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width >= 150 && rect.height >= 150) {
        const bg = window.getComputedStyle(img).backgroundImage;
        if (bg && (bg.includes('blob:') || bg.includes('data:image'))) return img;
      }
    }
    return null;
  }

  function getCurrentCandidateIndex(candidateCount) {
    const candEl = getCandidateElement();
    if (!candEl) return 1;
    try {
      const bgPos = window.getComputedStyle(candEl).backgroundPosition;
      const match = bgPos.match(/(-?\d+)px/);
      if (match) {
        const xOffset = Math.abs(parseInt(match[1], 10));
        const idx = Math.round(xOffset / TILE_W) + 1;
        if (idx >= 1 && idx <= candidateCount) return idx;
      }
    } catch {}
    return 1;
  }

  // navigate to option index
  async function navigateForwardToCandidate(targetIndex, candidateCount) {
    let current = getCurrentCandidateIndex(candidateCount);
    log(`carousel start=[${current}] target=[${targetIndex}] count=${candidateCount}`);
    let guard = 0;

    while (current !== targetIndex && guard < candidateCount + 4) {
      const { rightBtn } = findNavigationArrows();
      if (!rightBtn) {
        log('right arrow not found during navigation');
        break;
      }

      simulateClick(rightBtn);
      await sleep(300);
      let pos = getCurrentCandidateIndex(candidateCount);

      if (pos === current) {
        await sleep(120);
        const rb2 = findNavigationArrows().rightBtn;
        if (rb2) simulateClick(rb2);
        await sleep(300);
        pos = getCurrentCandidateIndex(candidateCount);
      }

      if (pos === current) {
        log('arrow click had no effect — aborting navigation');
        break;
      }

      current = pos;
      guard++;
    }

    log(`carousel end=[${current}] target=[${targetIndex}] reached=${current === targetIndex}`);
    return current === targetIndex;
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error('Empty src'));
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = src;
    });
  }

  // detect blank canvas crops
  function isBlankCanvas(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 64) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      return (max - min) < 20;
    } catch {
      return true;
    }
  }

  // extract challenge canvas images
  async function extractChallengeImages() {
    const allImgs = Array.from(document.querySelectorAll('img, canvas, div')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return isVisible(el) && rect.width > 40 && rect.height > 40;
    });

    let spriteUrl = null;
    let refEl = document.querySelector('.key-frame-image') || document.querySelector('[class*="key-frame"]');
    let candEl = getCandidateElement() || document.querySelector('[class*="right-arrow"]')?.parentElement?.querySelector('img') || allImgs[1] || allImgs[0];

    for (let retry = 0; retry < 5; retry++) {
      const currentImgs = Array.from(document.querySelectorAll('img, canvas, div')).filter((el) => {
        const rect = el.getBoundingClientRect();
        return isVisible(el) && rect.width > 40 && rect.height > 40;
      });
      for (const el of [candEl, refEl, ...currentImgs].filter(Boolean)) {
        const bg = window.getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(['"]?(.*?)['"]?\)/);
        if (m && m[1] && m[1] !== 'none' && !m[1].includes('.svg')) {
          spriteUrl = m[1];
          break;
        }
      }
      if (spriteUrl) break;
      await sleep(200);
    }

    if (spriteUrl) {
      try {
        const spriteImg = await loadImg(spriteUrl);
        if (spriteImg && spriteImg.naturalWidth >= 400) {
          // archive raw sprite debug
          try {
            const rawCanvas = document.createElement('canvas');
            rawCanvas.width = spriteImg.naturalWidth;
            rawCanvas.height = spriteImg.naturalHeight;
            rawCanvas.getContext('2d').drawImage(spriteImg, 0, 0);
            dumpSolveImages('rawsprite_' + Date.now() + '_' + spriteImg.naturalWidth + 'x' + spriteImg.naturalHeight, [
              { b64: rawCanvas.toDataURL('image/png').split(',')[1], mime: 'image/png' }
            ]);
            log('raw sprite dumped: ' + spriteImg.naturalWidth + 'x' + spriteImg.naturalHeight);
          } catch {}
          const tileW = TILE_W;
          const tileH = TILE_W;
          const candidateCount = Math.max(2, Math.round(spriteImg.naturalWidth / tileW));
          const hasRow2 = spriteImg.naturalHeight >= 400;

          const targetCanvas = document.createElement('canvas');
          targetCanvas.width = 400;
          targetCanvas.height = 400;
          const targetCtx = targetCanvas.getContext('2d');
          targetCtx.imageSmoothingEnabled = true;
          targetCtx.imageSmoothingQuality = 'high';

          // extract target reference strip
          const drawTargetRef = async () => {
            targetCtx.fillStyle = '#0f172a';
            targetCtx.fillRect(0, 0, 400, 400);
            if (hasRow2) {
              // scale reference image uniformly
              const srcW = 140;
              const srcH = tileH;
              const scale = Math.min(400 / srcW, 400 / srcH);
              const dw = Math.round(srcW * scale);
              const dh = Math.round(srcH * scale);
              const dx = Math.round((400 - dw) / 2);
              const dy = Math.round((400 - dh) / 2);
              targetCtx.drawImage(spriteImg, 0, tileH, srcW, srcH, dx, dy, dw, dh);
              if (!isBlankCanvas(targetCanvas)) return true;
            }
            if (refEl) {
              const refImg = await loadElementImage(refEl);
              if (refImg && !isBlankCanvas(refImg)) {
                const rw = refImg.naturalWidth || refImg.width || 300;
                const rh = refImg.naturalHeight || refImg.height || 300;
                const scale = Math.min(400 / rw, 400 / rh);
                const dw = Math.round(rw * scale);
                const dh = Math.round(rh * scale);
                targetCtx.drawImage(refImg, Math.round((400 - dw) / 2), Math.round((400 - dh) / 2), dw, dh);
                return true;
              }
            }
            return false;
          };

          let targetOk = await drawTargetRef();
          if (!targetOk) {
            log('target reference blank — retrying extraction');
            await sleep(250);
            targetOk = await drawTargetRef();
          }

          const targetB64 = targetCanvas.toDataURL('image/jpeg', 0.88).split(',')[1];

          // generate indexed contact sheet
          const gridTileW = TILE_W;
          const gridTileH = TILE_W;
          const gridLabelH = 30;
          const batchB64s = [];

          const batchSizes = candidateCount <= 6
            ? [candidateCount]
            : [Math.ceil(candidateCount / 2), Math.floor(candidateCount / 2)];

          let startIdx = 0;
          for (const countInBatch of batchSizes) {
            const cols = countInBatch <= 6 ? 3 : 4;
            const rows = Math.ceil(countInBatch / cols);

            const bCanvas = document.createElement('canvas');
            bCanvas.width = cols * gridTileW;
            bCanvas.height = rows * (gridTileH + gridLabelH);
            const bCtx = bCanvas.getContext('2d');
            bCtx.imageSmoothingEnabled = true;
            bCtx.imageSmoothingQuality = 'high';

            bCtx.fillStyle = '#0f172a';
            bCtx.fillRect(0, 0, bCanvas.width, bCanvas.height);

            for (let i = 0; i < countInBatch; i++) {
              const tileIdx = startIdx + i;
              const col = i % cols;
              const row = Math.floor(i / cols);
              const x = col * gridTileW;
              const y = row * (gridTileH + gridLabelH);

              bCtx.drawImage(spriteImg, tileIdx * tileW, 0, tileW, tileH, x + 1, y + 1, gridTileW - 2, gridTileH - 2);

              bCtx.fillStyle = '#1e293b';
              bCtx.fillRect(x, y + gridTileH, gridTileW, gridLabelH);

              bCtx.fillStyle = '#38bdf8';
              bCtx.font = 'bold 18px monospace';
              bCtx.textAlign = 'center';
              bCtx.fillText('[' + (tileIdx + 1) + ']', x + gridTileW / 2, y + gridTileH + 21);
              bCtx.textAlign = 'left';

              bCtx.strokeStyle = '#334155';
              bCtx.lineWidth = 1;
              bCtx.strokeRect(x, y, gridTileW, gridTileH + gridLabelH);
            }

            batchB64s.push(bCanvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
          }

          const tileB64s = [];
          for (let i = 0; i < candidateCount; i++) {
            const tileCanvas = document.createElement('canvas');
            tileCanvas.width = 400;
            tileCanvas.height = 400;
            const tileCtx = tileCanvas.getContext('2d');
            tileCtx.imageSmoothingEnabled = true;
            tileCtx.imageSmoothingQuality = 'high';
            tileCtx.drawImage(spriteImg, i * tileW, 0, tileW, tileH, 0, 0, 400, 400);
            tileB64s.push(tileCanvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
          }

          const compositeB64 = compositeSpriteSheet(spriteImg, targetCanvas, candidateCount);

          log('extracted ' + candidateCount + ' candidate tiles in ' + batchB64s.length + ' labelled batch(es) + target reference');

          return {
            mode: 'sprite',
            compositeB64,
            targetB64,
            batchB64s,
            tileB64s,
            candidateCount,
            candEl: getCandidateElement(),
            spriteUrl
          };
        }
      } catch (e) {
        log('sprite extraction error:', e.message);
      }
    }

    return null;
  }

  function compositeSpriteSheet(spriteImg, refCanvas, candidateCount) {
    const tileW = TILE_W;
    const tileH = TILE_W;
    const labelH = 30;
    const cols = 4;
    const rows = Math.ceil(candidateCount / cols);

    const refW = 240;
    const refH = 240;
    const headerH = refH + 16;
    const gridW = tileW * cols;
    const gridH = (tileH + labelH) * rows;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(gridW, refW + 20);
    canvas.height = headerH + gridH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, headerH);

    ctx.drawImage(refCanvas, 8, 8, refW, refH);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.strokeRect(5, 5, refW + 6, refH + 6);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('TARGET OBJECT', refW + 20, 36);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    ctx.fillText('Find the candidate tile', refW + 20, 58);
    ctx.fillText('that matches this reference', refW + 20, 76);

    for (let i = 0; i < candidateCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * tileW;
      const y = headerH + row * (tileH + labelH);

      ctx.drawImage(spriteImg, i * tileW, 0, tileW, tileH, x + 2, y + 2, tileW - 4, tileH - 4);

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x, y + tileH, tileW, labelH);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('[' + (i + 1) + ']', x + tileW / 2, y + tileH + 22);
      ctx.textAlign = 'left';

      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1, y + 1, tileW - 2, tileH + labelH - 2);
    }

    return canvas.toDataURL('image/png').split(',')[1];
  }

  function elImageUrl(el) {
    if (!el) return null;
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (img && img.src) return img.src;
    const nodes = [el, ...el.querySelectorAll('*')];
    for (const n of nodes) {
      const bg = window.getComputedStyle(n).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
      if (m && m[1] && m[1] !== 'none' && !m[1].includes('.svg')) return m[1];
    }
    return null;
  }

  function resolveBgPosPart(part, elemDim, drawnDim) {
    if (!part) return 0;
    part = String(part).trim();
    if (part.endsWith('px')) return parseFloat(part);
    if (part.endsWith('%')) return (elemDim - drawnDim) * (parseFloat(part) / 100);
    if (part === 'left' || part === 'top') return 0;
    if (part === 'right' || part === 'bottom') return elemDim - drawnDim;
    if (part === 'center') return (elemDim - drawnDim) / 2;
    return 0;
  }

  // extract background sprite crop
  async function loadElementImage(el) {
    if (!el) return null;

    const imgChild = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (imgChild && imgChild.src && !imgChild.src.startsWith('data:')) {
      try {
        return await loadImg(imgChild.src);
      } catch {}
    }

    const cs = window.getComputedStyle(el);
    const bg = cs.backgroundImage;
    const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
    if (!m || m[1] === 'none' || m[1].includes('.svg')) return null;

    let sprite;
    try {
      sprite = await loadImg(m[1]);
    } catch {
      return null;
    }

    const rect = el.getBoundingClientRect();
    const w = el.clientWidth || Math.round(rect.width);
    const h = el.clientHeight || Math.round(rect.height);
    if (w < 8 || h < 8) return null;

    // compute relative css percentages
    let drawnW = sprite.naturalWidth;
    let drawnH = sprite.naturalHeight;
    const sizeParts = String(cs.backgroundSize || '').trim().split(/\s+/);
    if (sizeParts.length >= 1 && sizeParts[0] !== 'auto' && sizeParts[0] !== 'cover' && sizeParts[0] !== 'contain') {
      if (sizeParts[0].endsWith('px')) drawnW = parseFloat(sizeParts[0]);
      else if (sizeParts[0].endsWith('%')) drawnW = w * (parseFloat(sizeParts[0]) / 100);
    }
    if (sizeParts.length >= 2 && sizeParts[1] !== 'auto' && sizeParts[1] !== 'cover' && sizeParts[1] !== 'contain') {
      if (sizeParts[1].endsWith('px')) drawnH = parseFloat(sizeParts[1]);
      else if (sizeParts[1].endsWith('%')) drawnH = h * (parseFloat(sizeParts[1]) / 100);
    } else {
      // preserve sprite aspect ratio
      drawnH = drawnW * (sprite.naturalHeight / sprite.naturalWidth);
    }

    const posParts = String(cs.backgroundPosition || '0% 0%').trim().split(/\s+/);
    const pxOff = resolveBgPosPart(posParts[0], w, drawnW);
    const pyOff = resolveBgPosPart(posParts[1] !== undefined ? posParts[1] : posParts[0], h, drawnH);

    const scaleX = sprite.naturalWidth / drawnW;
    const scaleY = sprite.naturalHeight / drawnH;
    const sx = (-pxOff) * scaleX;
    const sy = (-pyOff) * scaleY;
    const sw = w * scaleX;
    const sh = h * scaleY;

    const out = document.createElement('canvas');
    out.width = 300;
    out.height = 300;
    const octx = out.getContext('2d');
    octx.fillStyle = '#0f172a';
    octx.fillRect(0, 0, 300, 300);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    try {
      octx.drawImage(sprite, sx, sy, sw, sh, 0, 0, 300, 300);
    } catch {
      return null;
    }
    return out;
  }

  async function elementToB64(el, size = 400) {
    const img = await loadElementImage(el);
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }

  function imgDims(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return { w, h };
  }

  function buildLabeledGrid(images) {
    const valid = images.filter(Boolean);
    if (!valid.length) return null;
    const size = 220;
    const labelH = 30;
    const cols = valid.length <= 6 ? 3 : 4;
    const rows = Math.ceil(valid.length / cols);

    const canvas = document.createElement('canvas');
    canvas.width = cols * size;
    canvas.height = rows * (size + labelH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    valid.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * size;
      const y = row * (size + labelH);
      const { w, h } = imgDims(img);
      const scale = Math.min(size / w, size / h);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);
      ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x, y + size, size, labelH);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('[' + (i + 1) + ']', x + size / 2, y + size + 22);
      ctx.textAlign = 'left';

      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size + labelH - 1);
    });

    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (!dataUrl || dataUrl.length < 500) return null;
      return dataUrl.split(',')[1];
    } catch {
      return null;
    }
  }

  function dumpSolveImages(label, images) {
    if (!isContextValid()) return;
    try {
      for (const img of images) {
        if (!img || !img.b64) continue;
        chrome.runtime.sendMessage({
          type: 'DUMP_SOLVE_IMAGE',
          label,
          mime: img.mime || 'image/jpeg',
          b64: img.b64
        }).catch(() => {});
      }
    } catch {}
  }

  function sendVisionQuery({ prompt, imageB64, candidateCount, targetB64, batchB64s, tileB64s, challengeType }) {
    return new Promise((resolve, reject) => {
      if (!isContextValid()) return reject(new Error('Extension context invalidated'));
      chrome.runtime.sendMessage(
        {
          type: 'SOLVE_FUNCAPTCHA_VISION',
          prompt,
          imageB64,
          candidateCount,
          targetB64,
          batchB64s,
          tileB64s,
          challengeType
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve(resp.result);
          else reject(new Error((resp && resp.error) || 'Vision solve failed'));
        }
      );
    });
  }

  function sendTilesQuery({ prompt, targetB64, batchB64, candidateCount }) {
    return new Promise((resolve, reject) => {
      if (!isContextValid()) return reject(new Error('Extension context invalidated'));
      chrome.runtime.sendMessage(
        {
          type: 'SOLVE_FUNCAPTCHA_TILES',
          prompt,
          targetB64: targetB64 || null,
          batchB64s: batchB64 ? [batchB64] : [],
          candidateCount
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (resp && resp.ok) resolve(resp.result);
          else reject(new Error((resp && resp.error) || 'Tile solve failed'));
        }
      );
    });
  }

  function checkCompletion() {
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
    const successPhrases = [
      'verification complete', 'olet läpäissyt', 'tehtävä suoritettu', 'you have passed',
      'vahvistus onnistui', 'onnistui', 'läpäissyt', 'suoritettu', 'passed the verification',
      'verification successful', 'congratulations', 'great job'
    ];
    const hasPhrase = successPhrases.some(p => bodyText.includes(p));
    const hasSuccessSvg = Array.from(document.querySelectorAll('svg')).some(s => {
      const cls = String(s.getAttribute('class') || '').toLowerCase();
      const aria = String(s.getAttribute('aria-label') || '').toLowerCase();
      return cls.includes('check') || cls.includes('success') || aria.includes('success') || aria.includes('complete');
    });

    if (hasPhrase || (hasSuccessSvg && !isActiveChallenge())) {
      log('Arkose solved ✓');
      safeSendMessage({ type: 'STATUS', status: 'success', message: 'FunCAPTCHA solved successfully!' });
      return true;
    }
    return false;
  }

  async function solveMatch(now) {
    const promptText = findPromptText();
    const { rightBtn, leftBtn } = findNavigationArrows();
    const submitBtn = findSubmitButton();
    if (!rightBtn && !leftBtn) return;
    if (!submitBtn) return;

    const isNewRound = promptText !== lastPromptSolved;
    if (!isNewRound && now - lastSubmittedTime < 5000) return;
    if (now - lastSolveAttempt < 2000) return;

    isSolving = true;
    lastSolveAttempt = now;
    log('match challenge detected: "' + promptText + '"');
    safeSendMessage({ type: 'STATUS', status: 'working', message: 'FunCAPTCHA solving: ' + promptText.slice(0, 35) + '...' });

    try {
      const imgs = await extractChallengeImages();
      if (!imgs || !imgs.compositeB64) throw new Error('Unable to extract puzzle sprite');

      if (imgs.spriteUrl && imgs.spriteUrl === lastSpriteSolved && now - lastSubmittedTime < 5000) {
        log('sprite unchanged — waiting for round advance');
        return;
      }

      const cleanPrompt = promptText.replace(/\(\s*\d+\s*[\/\-of]+\s*\d+\s*\)/gi, '').trim();
      const lower = promptText.toLowerCase();
      const challengeType = /rotat|orient|direction|facing|degree|angle|tilt|kulma|suunta/.test(lower) ? 'rotate' : 'count';
      dumpSolveImages('match_' + Date.now(), [
        { b64: imgs.targetB64, mime: 'image/jpeg' },
        ...(imgs.batchB64s || []).map((b) => ({ b64: b, mime: 'image/jpeg' }))
      ]);
      const result = await sendVisionQuery({
        prompt: cleanPrompt,
        imageB64: imgs.compositeB64,
        candidateCount: imgs.candidateCount,
        targetB64: imgs.targetB64,
        batchB64s: imgs.batchB64s,
        tileB64s: imgs.tileB64s,
        challengeType
      });

      if (!result || !result.winningIndex) throw new Error('No winning candidate returned by vision model');

      const target = Math.max(1, Math.min(imgs.candidateCount, result.winningIndex));
      log(`qwen winningIndex=[${target}] of [${imgs.candidateCount}] digit=${result.targetDigit !== undefined ? result.targetDigit : '?'} raw="${String(result.raw || '').trim().slice(0, 400)}"`);

      let reached = await navigateForwardToCandidate(target, imgs.candidateCount);
      if (!reached) {
        await sleep(200);
        reached = await navigateForwardToCandidate(target, imgs.candidateCount);
      }
      if (!reached) {
        log(`could not reach candidate [${target}] — aborting submit to prevent strike`);
        return;
      }

      log(`submitting candidate [${target}]`);
      await sleep(2800);
      simulateClick(findSubmitButton() || submitBtn);

      lastPromptSolved = promptText;
      lastSpriteSolved = imgs.spriteUrl || '';
      lastSubmittedTime = Date.now();
      hasClickedStart = false;
      lastStartClickTime = 0;
      await sleep(2000);
      checkCompletion();
    } catch (err) {
      log('match solve error:', err.message || err);
    } finally {
      isSolving = false;
    }
  }

  async function solveTile(now, variant) {
    if (now - lastSolveAttempt < 2500) return;
    if (now - lastSubmittedTime < 3500) return;

    const cellSel = variant === 'tile'
      ? '#game_children_challenge a'
      : '.tile-game .challenge-container button, .tile-game button';
    const readCells = () => Array.from(document.querySelectorAll(cellSel)).filter(isVisible);

    // verify tile cell presence
    let cells = readCells();
    let promptText = findPromptText();
    if (!cells.length || !promptText) return;

    if (cells.length < 6) {
      await sleep(200);
      cells = readCells();
    }
    if (!cells.length) return;

    isSolving = true;
    lastSolveAttempt = now;
    log(`tile challenge detected (${variant}, ${cells.length} cells): "${promptText}"`);
    safeSendMessage({ type: 'STATUS', status: 'working', message: 'FunCAPTCHA tile solving...' });

    try {
      // extract target reference sample
      let targetB64 = null;
      if (/match|same|shown|reference/i.test(promptText)) {
        const targetEl = document.querySelector('#game_challengeItem_image, .tile-game .key-frame-image');
        if (targetEl && isVisible(targetEl)) {
          targetB64 = await elementToB64(targetEl);
        }
      }

      // await complete grid decode
      let batchB64 = null;
      for (let attempt = 0; attempt < 4 && !batchB64; attempt++) {
        const cellImgs = [];
        for (const c of cells) {
          let im = await loadElementImage(c);
          if (!im) {
            await sleep(200);
            im = await loadElementImage(c);
          }
          cellImgs.push(im);
        }
        const loaded = cellImgs.filter(Boolean).length;
        if (loaded === cells.length) {
          batchB64 = buildLabeledGrid(cellImgs);
        } else {
          log(`tile extraction attempt ${attempt + 1}: only ${loaded}/${cells.length} cells loaded — retrying`);
          await sleep(250);
        }
      }
      if (!batchB64) throw new Error('Unable to extract tile images');

      const cleanPrompt = promptText.replace(/\(\s*\d+\s*[\/\-of]+\s*\d+\s*\)/gi, '').trim();
      dumpSolveImages('tile_' + Date.now(), [
        ...(targetB64 ? [{ b64: targetB64, mime: 'image/jpeg' }] : []),
        { b64: batchB64, mime: 'image/jpeg' }
      ]);
      const res = await sendTilesQuery({
        prompt: cleanPrompt,
        targetB64,
        batchB64,
        candidateCount: cells.length
      });

      const matches = ((res && res.matches) || []).filter((i) => i >= 1 && i <= cells.length);
      if (!matches.length) throw new Error('No matching tile returned');

      // refresh current cell elements
      const cellsNow = readCells();
      if (cellsNow.length !== cells.length) {
        log('cell set changed mid-solve (' + cells.length + '→' + cellsNow.length + ') — aborting');
        return;
      }

      log('qwen tile selection: ' + JSON.stringify(matches) + ' raw="' + String(res.raw || '').trim().slice(0, 400) + '"');

      // click target tile cells
      for (const i of matches) {
        simulateClick(cellsNow[i - 1]);
        await sleep(220);
      }

      lastPromptSolved = promptText;
      lastSubmittedTime = Date.now();

      // observe round completion state
      await sleep(2000);
      checkCompletion();
    } catch (err) {
      log('tile solve error:', err.message || err);
      // cooldown on challenge failure
      lastSolveAttempt = Date.now() + 2000;
    } finally {
      isSolving = false;
    }
  }

  async function checkAndSolve() {
    if (isSolving) return;
    if (!settings.enabled || settings.solve_funcaptcha === false) return;
    if (!isChallengeFrame()) return;

    notifyDetected();
    if (checkCompletion()) return;

    const now = Date.now();
    const variant = detectVariant();

    if (variant !== lastVariant) {
      log('challenge variant: ' + variant);
      lastVariant = variant;
    }

    // prioritize retry screen reset
    if (now - lastFailureClickTime > FAILURE_COOLDOWN_MS) {
      const retryBtn = findTryAgainButton();
      if (retryBtn) {
        log('failure screen detected — auto-clicking retry');
        hasClickedStart = false;
        lastPromptSolved = '';
        lastSpriteSolved = '';
        lastSubmittedTime = 0;
        lastSolveAttempt = 0;
        lastFailureClickTime = now;
        await sleep(700);
        simulateClick(retryBtn);
        await sleep(2500);
        return;
      }
    }

    if (!isActiveChallenge()) {
      const startBtn = findStartButton();
      if (startBtn) {
        if (hasClickedStart && !isActiveChallenge() && now - lastStartClickTime > 7000) {
          hasClickedStart = false;
          lastPromptSolved = '';
          lastSpriteSolved = '';
          lastSubmittedTime = 0;
        }
        if (!hasClickedStart && now - lastStartClickTime > 4000 && settings.autoClick) {
          log('gatekeeper detected — clicking start/verify');
          hasClickedStart = true;
          lastStartClickTime = now;
          safeSendMessage({ type: 'STATUS', status: 'working', message: 'Gatekeeper detected — clicking Start Puzzle...' });
          await sleep(350 + Math.random() * 250);
          simulateClick(startBtn);
          await sleep(1800);
        }
        return;
      }
      return;
    }

    if (variant === 'tile') return void solveTile(now, 'tile');
    if (variant === 'tile-v2') return void solveTile(now, 'tile-v2');
    if (variant === 'match') return void solveMatch(now);
  }

  setInterval(checkAndSolve, 800);
  log('Arkose solver initialized (structural detection)');
})();
