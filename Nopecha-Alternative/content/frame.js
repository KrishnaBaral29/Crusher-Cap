(() => {
  const href = location.href;
  const IS_ANCHOR = href.includes('/api2/anchor') || href.includes('/enterprise/anchor');
  const IS_BFRAME = href.includes('/api2/bframe') || href.includes('/enterprise/bframe');
  if (!IS_ANCHOR && !IS_BFRAME) return;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const SEL = {
    checkboxBorder: '.recaptcha-checkbox-border',
    checkbox: '.recaptcha-checkbox',
    anchorSpan: '#recaptcha-anchor',
    audioButton: '#recaptcha-audio-button, .rc-audiochallenge-toggle-button, button[title*="audio" i], button[aria-label*="audio" i]',
    audioElement: '#audio-source, audio, source[src*="payload"]',
    downloadLink: '.rc-audiochallenge-tdownload-link, .rc-audiochallenge-download-link, .rc-audiochallenge-tdownload a, .rc-audiochallenge-control a, a[href*="payload"], a[href*="audio.mp3"], a.rc-button-download',
    playButton: '.rc-audiochallenge-play-button button, .rc-button-default',
    input: '#audio-response',
    verify: '#recaptcha-verify-button',
    reload: '#recaptcha-reload-button',
    errorBox: '.rc-audiochallenge-error-message',
    doscaptcha: '.rc-doscaptcha-body',
    imageMode: '.rc-imageselect-instructions, .rc-imageselect-desc-wrapper',
    status: '#recaptcha-accessible-status'
  };

  // selector for anchor checkbox
  const CHECKBOX_SEL =
    '#recaptcha-anchor, .recaptcha-checkbox-border, .recaptcha-checkbox, ' +
    '[role="checkbox"], .rc-anchor-checkbox, .rc-anchor-center-item > .recaptcha-checkbox';

  let busy = false;

  const ROLE = IS_ANCHOR ? 'anchor' : 'bframe';

  function log(...args) {
    const line = '[' + ROLE + '] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC]', 'color:#c084fc;font-weight:bold', line);
    sendBG({ type: 'LOG', line });
  }

  function logErr(...args) {
    const line = '[' + ROLE + '] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.error('%c[CC]', 'color:#ef4444;font-weight:bold', line);
    sendBG({ type: 'LOG', line, level: 'error' });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function isContextValid() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  }

  function sendBG(payload) {
    if (!isContextValid()) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch {
        resolve(null);
      }
    });
  }

  let cachedSettings = { enabled: true, autoSolve: true, provider: 'google' };
  try {
    chrome.storage.local.get(null, (res) => {
      if (res && res.enabled !== undefined) Object.assign(cachedSettings, res);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        for (const [k, v] of Object.entries(changes)) cachedSettings[k] = v.newValue;
      }
    });
  } catch (e) {}

  async function getSettings() {
    return cachedSettings;
  }

  function status(status, message, attempt) {
    sendBG({ type: 'STATUS', status, message, attempt });
  }

  function visible(el) {
    return !!(el && el.offsetParent !== null);
  }

  function q(sel) {
    return document.querySelector(sel);
  }

  // wait for element selector
  function waitForSelector(sel, timeoutMs) {
    return new Promise((resolve) => {
      const found = q(sel);
      if (found) return resolve(found);
      const mo = new MutationObserver(() => {
        const el = q(sel);
        if (el) {
          mo.disconnect();
          resolve(el);
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => {
        mo.disconnect();
        resolve(q(sel)); // retry finding element
      }, timeoutMs);
    });
  }

  // poll element with retry
  async function waitForSelectorRetry(selectors, timeoutMs, intervalMs = 200) {
    const sel = Array.isArray(selectors) ? selectors.join(', ') : selectors;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // await document ready state
      if (document.readyState === 'loading') {
        await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
      }
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(intervalMs);
    }
    return document.querySelector(sel); // final element check
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function isValidAudioSrc(src) {
    if (!src || typeof src !== 'string') return false;
    const s = src.trim();
    if (!s || s === '#' || s.startsWith('javascript:')) return false;
    return s.startsWith('http') || s.startsWith('blob:') || s.startsWith('/') || s.includes('payload');
  }

  function findAudioSrc() {
    // find audio element source
    const audio = q(SEL.audioElement);
    if (audio) {
      if (audio.src && isValidAudioSrc(audio.src)) return audio.src;
      if (audio.currentSrc && isValidAudioSrc(audio.currentSrc)) return audio.currentSrc;
      const attr = audio.getAttribute('src');
      if (attr && isValidAudioSrc(attr)) return attr;

      const source = audio.querySelector('source');
      if (source) {
        if (source.src && isValidAudioSrc(source.src)) return source.src;
        const sAttr = source.getAttribute('src');
        if (sAttr && isValidAudioSrc(sAttr)) return sAttr;
      }
    }

    // check fallback source tags
    const anySource = q('source[src*="payload"], source[src*="audio"]');
    if (anySource && anySource.src && isValidAudioSrc(anySource.src)) {
      return anySource.src;
    }

    // find audio download link
    const dlSelectors = [
      '.rc-audiochallenge-tdownload-link',
      '.rc-audiochallenge-download-link',
      '.rc-audiochallenge-tdownload a',
      '.rc-audiochallenge-control a',
      'a[href*="payload"]',
      'a[href*="audio.mp3"]',
      'a.rc-button-download'
    ];
    for (const sel of dlSelectors) {
      const el = q(sel);
      if (el) {
        const href = el.href || el.getAttribute('href');
        if (href && isValidAudioSrc(href)) return href;
      }
    }

    return null;
  }

  async function waitForAudioSrc(timeoutMs = 7000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isRateLimited() || isBlockedByGoogle()) {
        throw new Error('Google rate-limited this IP (doscaptcha)');
      }
      const src = findAudioSrc();
      if (src) return src;
      await sleep(intervalMs);
    }
    return findAudioSrc();
  }

  async function getAudioB64() {
    const src = await waitForAudioSrc(7000, 250);
    if (!src) throw new Error('no audio source found');
    log('audio source acquired: ' + src.slice(0, 70));

    if (src.startsWith('blob:')) {
      const blob = await fetch(src).then((r) => {
        if (!r.ok) throw new Error('blob fetch ' + r.status);
        return r.blob();
      });
      const wavBlob = await toWav16k(blob);
      const buf = await wavBlob.arrayBuffer();
      return { b64: bufToB64(buf), mime: 'audio/wav' };
    }
    const origin = location.origin || 'https://www.google.com';
    const abs = src.startsWith('http') ? src : (origin + (src.startsWith('/') ? '' : '/') + src);
    const resp = await fetch(abs, { credentials: 'include' });
    if (!resp.ok) throw new Error('audio fetch ' + resp.status);
    const raw = await resp.arrayBuffer();
    let mime = resp.headers.get('content-type') || 'audio/mpeg';
    let bytes = new Uint8Array(raw);
    if (mime.includes('mpeg') || mime.includes('mp3')) {
      const wav = await toWav16k(new Blob([raw], { type: mime }));
      bytes = new Uint8Array(await wav.arrayBuffer());
      mime = 'audio/wav';
    }
    return { b64: bufToB64(bytes.buffer), mime };
  }

  async function toWav16k(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const ac = new AudioContext();
    const decoded = await ac.decodeAudioData(arrayBuf);
    await ac.close();
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav16k(rendered.getChannelData(0), rate);
  }

  function encodeWav16k(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function transcribe() {
    const { b64, mime } = await getAudioB64();
    log('audio fetched, b64 length=' + b64.length + ' mime=' + mime);
    const resp = await sendBG({ type: 'AUDIO_B64', b64, mime });
    if (!resp) throw new Error('no response from background (STT)');
    if (!resp.ok) throw new Error(resp.error || 'STT failed');
    log('STT answered: ' + resp.text);
    return resp.text;
  }

  async function typeAnswer(text) {
    const input = q(SEL.input);
    const verify = q(SEL.verify);
    if (!input || !verify) throw new Error('input/verify missing');
    input.focus();
    input.value = '';
    for (const ch of text) {
      input.value += ch;
      await sleep(rand(55, 150));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(rand(400, 900));
    verify.click();
  }

  function isRateLimited() {
    return visible(q(SEL.doscaptcha));
  }

  function isImageMode() {
    return visible(q(SEL.imageMode));
  }

  function challengeText() {
    return (document.body && document.body.innerText) || '';
  }

  function isBlockedByGoogle() {
    const t = challengeText();
    return /automated queries|unusual traffic|try again later/i.test(t);
  }

  async function checkSolvedStatus() {
    const acc = q(SEL.status);
    if (acc && /you are verified/i.test(acc.innerText || '')) {
      return true;
    }
    const resp = await sendBG({ type: 'CHECK_SOLVED' });
    return !!(resp && (resp.solved || resp.checked));
  }

  function getChallengePrompt() {
    const descEl =
      q('.rc-imageselect-desc-wrapper') ||
      q('.rc-imageselect-instructions') ||
      q('#rc-imageselect-instructions') ||
      q('#rc-imageselect');
    if (!descEl) return '';
    return (descEl.innerText || '').trim();
  }

  function extractTargetObject(rawPrompt) {
    const strongEl =
      q('.rc-imageselect-desc-wrapper strong') ||
      q('.rc-imageselect-instructions strong') ||
      q('#rc-imageselect-instructions strong') ||
      q('#rc-imageselect strong');
    if (strongEl && (strongEl.innerText || '').trim()) {
      return strongEl.innerText.trim();
    }
    if (rawPrompt) {
      const match = rawPrompt.match(/with\s+([^\n\r\.\,]+)/i);
      if (match && match[1]) return match[1].trim();
    }
    return rawPrompt ? rawPrompt.split('\n')[0].replace(/select all (images|squares) with/i, '').trim() : '';
  }

  function isTileSelected(tileEl) {
    if (!tileEl) return false;
    return (
      tileEl.classList.contains('rc-imageselect-tileselected') ||
      tileEl.getAttribute('aria-checked') === 'true' ||
      !!tileEl.querySelector('.rc-imageselect-tileselected')
    );
  }

  function getImageError() {
    const sels = [
      '.rc-imageselect-incorrect-response',
      '.rc-imageselect-error-select-more',
      '.rc-imageselect-error-dynamic-more',
      '.rc-imageselect-error',
      '.rc-imageselect-desc-no-header'
    ];
    for (const sel of sels) {
      const el = q(sel);
      if (visible(el)) {
        const text = (el.innerText || '').trim();
        if (text.length > 0) return text;
      }
    }
    return null;
  }

  async function captureChallengeCanvas() {
    const table =
      q('.rc-imageselect-table-33') ||
      q('.rc-imageselect-table-44') ||
      q('.rc-imageselect-table-42') ||
      q('#rc-imageselect-target table');
    if (!table) return null;

    const trs = Array.from(table.querySelectorAll('tr'));
    const rows = trs.length || (q('.rc-imageselect-table-44') ? 4 : 3);
    const cols = (trs[0] && trs[0].querySelectorAll('td').length) || rows;
    const totalTiles = rows * cols;

    const tileEls = Array.from(table.querySelectorAll('.rc-imageselect-tile, td'));
    if (tileEls.length < totalTiles) return null;

    // ensure tile images loaded
    for (const tile of tileEls) {
      const img = tile.querySelector('img');
      if (img && !img.complete) {
        await new Promise((r) => {
          img.onload = img.onerror = r;
          setTimeout(r, 600);
        });
      }
    }

    // configure tile canvas size
    const tileW = cols === 4 ? 240 : 280;
    const tileH = rows === 4 ? 240 : 280;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileW;
    canvas.height = rows * tileH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // check composite tile image
    const imgs = tileEls.map((t) => t.querySelector('img')).filter(Boolean);
    const firstSrc = imgs[0] ? imgs[0].src : null;
    const allSameSrc = imgs.length === totalTiles && imgs.every((i) => i.src === firstSrc);

    if (allSameSrc && imgs[0]) {
      try {
        ctx.drawImage(imgs[0], 0, 0, canvas.width, canvas.height);
      } catch (e) {
        logErr('Failed drawing composite image: ' + (e.message || e));
      }
    } else {
      // draw individual tile canvas
      for (let i = 0; i < totalTiles; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const x = col * tileW;
        const y = row * tileH;
        const tile = tileEls[i];
        const img = tile ? tile.querySelector('img') : null;
        if (img) {
          try {
            const comp = window.getComputedStyle(img);
            const top = parseFloat(comp.top) || 0;
            const left = parseFloat(comp.left) || 0;
            if ((top < -5 || left < -5) && img.naturalWidth >= canvas.width * 0.5) {
              const sX = Math.abs(left);
              const sY = Math.abs(top);
              const sW = tile.clientWidth || 100;
              const sH = tile.clientHeight || 100;
              ctx.drawImage(img, sX, sY, sW, sH, x, y, tileW, tileH);
            } else {
              ctx.drawImage(img, 0, 0, img.naturalWidth || tileW, img.naturalHeight || tileH, x, y, tileW, tileH);
            }
          } catch (e) {
            logErr('Failed drawing tile ' + (i + 1) + ': ' + (e.message || e));
          }
        }
      }
    }

    // draw corner index badges
    for (let i = 0; i < totalTiles; i++) {
      const tileNum = i + 1;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = col * tileW;
      const y = row * tileH;

      // draw tile separator border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, tileW, tileH);

      // render top-left index badge
      const bw = 30;
      const bh = 22;
      const bx = x + 4;
      const by = y + 4;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(bx, by, bw, bh);

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(tileNum), bx + bw / 2, by + bh / 2 + 1);
    }

    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      return {
        dataUrl,
        b64: dataUrl.split(',')[1],
        cols,
        rows,
        totalTiles,
        tileEls
      };
    } catch (e) {
      logErr('canvas.toDataURL failed: ' + (e.message || e));
      return null;
    }
  }

  async function clickTile(tileEl) {
    if (!tileEl) return;
    tileEl.scrollIntoView({ block: 'nearest' });
    const rect = tileEl.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + rand(-3, 3);
    const y = rect.top + rect.height / 2 + rand(-3, 3);

    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    if (window.__ccClickAnim) window.__ccClickAnim(x, y);
    tileEl.dispatchEvent(new PointerEvent('pointerdown', opts));
    tileEl.dispatchEvent(new MouseEvent('mousedown', opts));
    tileEl.dispatchEvent(new PointerEvent('pointerup', opts));
    tileEl.dispatchEvent(new MouseEvent('mouseup', opts));
    tileEl.dispatchEvent(new MouseEvent('click', opts));
  }

  async function waitForDynamicTiles(clickedIndices, tileEls) {
    await sleep(600);
    const start = Date.now();
    while (Date.now() - start < 3500) {
      let stillLoading = false;
      for (const idx of clickedIndices) {
        const tile = tileEls[idx - 1];
        if (!tile) continue;
        const img = tile.querySelector('img');
        if (img) {
          const comp = window.getComputedStyle(img);
          const opacity = parseFloat(comp.opacity);
          if (
            comp.visibility === 'hidden' ||
            opacity < 0.7 ||
            img.classList.contains('rc-image-tile-fade') ||
            img.classList.contains('rc-image-tile-spinning') ||
            !img.complete
          ) {
            stillLoading = true;
            break;
          }
        }
      }
      if (!stillLoading) break;
      await sleep(150);
    }
    await sleep(350);
  }

  async function fallbackToAudio(attempt) {
    if (!(await isChallengeActuallyOpen())) {
      log('Challenge closed or expired — cannot fallback to audio');
      return 'closed';
    }
    const audioBtn = await waitForSelector(SEL.audioButton, 2500);
    if (audioBtn && visible(audioBtn)) {
      log('Switching to audio challenge mode...');
      status('working', 'Falling back to audio challenge...', attempt);
      audioBtn.click();
      await sleep(rand(800, 1400));
      if (!(await isChallengeActuallyOpen())) {
        log('Challenge closed after clicking audio button — aborting');
        return 'closed';
      }
      return 'fallback_audio';
    }
    log('Audio button unavailable — challenge may be closed or image-only');
    return 'closed';
  }

  async function solveImageMode(attempt, maxAttempts) {
    log('solveImageMode start (attempt ' + (attempt + 1) + '/' + maxAttempts + ')');

    if (!(await isChallengeActuallyOpen())) {
      log('Challenge closed before starting image solve — aborting');
      return 'closed';
    }

    status('working', 'Image challenge detected — preparing canvas', attempt);

    await sleep(rand(150, 300));

    const prompt = getChallengePrompt();
    if (!prompt) {
      if (!(await isChallengeActuallyOpen())) return 'closed';
      log('No challenge prompt found — checking audio fallback');
      return fallbackToAudio(attempt);
    }
    const targetObject = extractTargetObject(prompt);
    log('Image prompt: "' + prompt.replace(/\n/g, ' ') + '" | target: "' + targetObject + '"');

    let dynamicRound = 0;
    const maxDynamicRounds = 6;

    while (dynamicRound < maxDynamicRounds) {
      if (!(await isChallengeActuallyOpen())) {
        log('Challenge closed during dynamic round ' + dynamicRound + ' — aborting');
        return 'closed';
      }

      dynamicRound++;
      status('working', 'Capturing image tiles (round ' + dynamicRound + ')...', attempt);

      const capture = await captureChallengeCanvas();
      if (!capture || !capture.b64) {
        if (!(await isChallengeActuallyOpen())) return 'closed';
        logErr('Failed to capture canvas — checking audio fallback');
        return fallbackToAudio(attempt);
      }

      status('working', 'Sending to Vision AI (' + targetObject + ')...', attempt);
      const resp = await sendBG({
        type: 'VISION_SOLVE',
        imageB64: capture.b64,
        prompt,
        targetObject,
        totalTiles: capture.totalTiles,
        rows: capture.rows,
        cols: capture.cols
      });

      if (!(await isChallengeActuallyOpen())) {
        log('Challenge closed or expired while awaiting Vision AI response — aborting');
        return 'closed';
      }

      if (!resp || !resp.ok) {
        logErr('Vision AI error: ' + (resp?.error || 'no response'));
        status('working', 'Vision AI unavailable (' + (resp?.error || '') + ') — checking audio fallback', attempt);
        return fallbackToAudio(attempt);
      }

      const matchingTiles = resp.tiles || [];
      log('Vision AI selected tiles: ' + JSON.stringify(matchingTiles) + ' (' + (resp.durationMs || 0) + 'ms)');

      const isDynamic = /none left|none remain|once there are none/i.test(prompt);

      if (matchingTiles.length === 0) {
        log('No matching tiles found (' + (isDynamic ? 'none left in dynamic mode' : 'skip/verify') + ')');
        const verifyBtn = q(SEL.verify);
        if (verifyBtn && visible(verifyBtn)) {
          await sleep(rand(150, 300));
          verifyBtn.click();
          log('Verify/Skip clicked');
        }
        break;
      }

      status('working', 'Synchronizing tile selection: ' + matchingTiles.join(', '), attempt);
      for (let i = 0; i < capture.totalTiles; i++) {
        if (!(await isChallengeActuallyOpen())) {
          log('Challenge closed during tile clicks — aborting');
          return 'closed';
        }
        const tileNum = i + 1;
        const tileEl = capture.tileEls[i];
        if (!tileEl) continue;
        const shouldBeSelected = matchingTiles.includes(tileNum);
        const currentlySelected = isTileSelected(tileEl);

        if (shouldBeSelected && !currentlySelected) {
          await clickTile(tileEl);
          await sleep(rand(60, 130));
        } else if (!shouldBeSelected && currentlySelected) {
          await clickTile(tileEl);
          await sleep(rand(60, 130));
        }
      }

      if (!isDynamic) {
        log('Static challenge tiles selected — clicking Verify');
        await sleep(rand(200, 350));
        if (!(await isChallengeActuallyOpen())) {
          log('Challenge closed before clicking verify — aborting');
          return 'closed';
        }
        const verifyBtn = q(SEL.verify);
        if (verifyBtn && visible(verifyBtn)) {
          verifyBtn.click();
          log('Verify clicked');
        }
        break;
      }

      status('working', 'Waiting for replacement tiles to appear...', attempt);
      await waitForDynamicTiles(matchingTiles, capture.tileEls);
    }

    status('working', 'Verifying image solve...', attempt);
    let isSolved = false;
    let imageErrorDetected = null;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 4500) {
      await sleep(200);

      if (isRateLimited() || isBlockedByGoogle()) {
        status('rate_limited', 'Google rate-limited this IP', attempt);
        return 'blocked';
      }

      if (await checkSolvedStatus()) {
        log('Solve confirmed by anchor or token! 🎉');
        isSolved = true;
        break;
      }

      const imgErr = getImageError();
      if (imgErr) {
        log('Google image error detected: "' + imgErr + '"');
        imageErrorDetected = imgErr;
        break;
      }

      if (!(await isChallengeActuallyOpen())) {
        if (await checkSolvedStatus()) {
          log('Challenge UI closed and solve confirmed! 🎉');
          isSolved = true;
          break;
        } else {
          log('Challenge UI closed without confirmation — expired or dismissed');
          return 'closed';
        }
      }
    }

    if (isSolved) {
      log('CAPTCHA SOLVED VIA IMAGE AI! 🎉');
      status('success', 'Solved with Image AI! 🎉', attempt);
      alreadySolved = true;
      return 'solved';
    }

    if (imageErrorDetected) {
      log('Challenge not solved — Google says: "' + imageErrorDetected + '"');
    }

    if (!(await isChallengeActuallyOpen())) {
      log('Challenge no longer open after verify — aborting');
      return 'closed';
    }

    if (isImageMode()) {
      log('Image challenge still present — checking retry vs fallback (attempt ' + attempt + ')');
      if (attempt >= 2) {
        log('Multiple image attempts unsuccessful — falling back to audio solver');
        return fallbackToAudio(attempt);
      }
      return 'retry_image';
    }

    return fallbackToAudio(attempt);
  }

  let alreadySolved = false;

  async function solveLoop() {
    const settings = await getSettings();
    const maxAttempts = settings.maxAttempts || 6;
    const minDelay = settings.minDelay || 1200;
    const maxDelay = settings.maxDelay || 3000;
    let attempt = 0;
    log('solve loop start: maxAttempts=' + maxAttempts + ' provider=' + (settings.provider || '?') + ' solverMode=' + (settings.solverMode || 'image'));

    if (settings.solve_recaptcha === false) {
      log('reCAPTCHA solving is disabled in provider settings — skipping');
      return;
    }

    await sleep(rand(600, 1200));

    while (attempt < maxAttempts) {
      // verify challenge container open
      if (!(await isChallengeActuallyOpen())) {
        log('Challenge modal is closed or expired — aborting solve loop');
        status('idle', 'Challenge closed or expired', attempt);
        return;
      }

      if (isRateLimited() || isBlockedByGoogle()) {
        log('BLOCKED: doscaptcha=' + isRateLimited());
        status('rate_limited', 'Google rate-limited this IP (doscaptcha). Use a residential IP or wait.', attempt);
        return;
      }

      if (isImageMode()) {
        const mode = settings.solverMode || 'image';
        if (mode === 'audio') {
          log('Solver mode is audio only — switching to audio button');
          const aRes = await fallbackToAudio(attempt);
          if (aRes === 'closed') {
            log('Challenge closed during audio switch — aborting');
            status('idle', 'Challenge closed', attempt);
            return;
          }
        } else {
          log('Image mode active — solving with Vision AI (primary)');
          const res = await solveImageMode(attempt, maxAttempts);
          if (res === 'solved') {
            return;
          }
          if (res === 'blocked') {
            return;
          }
          if (res === 'closed') {
            log('Image challenge was closed — stopping solve loop');
            status('idle', 'Challenge closed', attempt);
            return;
          }
          if (res === 'retry_image') {
            attempt++;
            await sleep(rand(minDelay, maxDelay));
            continue;
          }
          if (res === 'fallback_audio') {
            log('Vision solve requested fallback — checking if challenge is open for audio');
            if (!(await isChallengeActuallyOpen())) {
              log('Challenge closed before audio fallback — aborting');
              status('idle', 'Challenge closed', attempt);
              return;
            }
          } else {
            return;
          }
        }
      }

      // verify audio challenge visibility
      if (!(await isChallengeActuallyOpen()) || !audioVisible()) {
        log('Audio challenge not open on screen — aborting solve loop');
        status('idle', 'Challenge closed or audio not open', attempt);
        return;
      }

      let text = null;
      try {
        status('working', 'Downloading audio + transcribing (attempt ' + (attempt + 1) + '/' + maxAttempts + ')', attempt);
        text = await transcribe();
      } catch (e) {
        logErr('STT attempt failed: ' + (e.message || e));
        status('stt_error', 'Audio/STT error: ' + (e.message || e), attempt);
        if (!(await isChallengeActuallyOpen())) {
          log('Challenge closed after STT error — aborting solve loop');
          status('idle', 'Challenge closed', attempt);
          return;
        }
        const reload = q(SEL.reload);
        if (reload) reload.click();
        await sleep(rand(minDelay, maxDelay));
        attempt++;
        continue;
      }

      if (!(await isChallengeActuallyOpen())) {
        log('Challenge closed after transcription — aborting');
        status('idle', 'Challenge closed', attempt);
        return;
      }

      status('working', 'STT says "' + text + '" — typing', attempt);
      try {
        await typeAnswer(text);
        log('answer typed + verify clicked');
      } catch (e) {
        log('submit failed: ' + (e.message || e));
        logErr('submit failed: ' + (e.message || e));
        status('failed', 'Submit failed: ' + (e.message || e), attempt);
        return;
      }

      // poll for challenge verification
      let isSolved = false;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 5000) {
        await sleep(500);

        if (isRateLimited() || isBlockedByGoogle()) {
          status('rate_limited', 'Rate-limited right after submit', attempt);
          return;
        }

        if (await checkSolvedStatus()) {
          log('Solve confirmed (anchor checked or page token received)');
          isSolved = true;
          break;
        }

        const errMsg = q(SEL.errorBox);
        if (visible(errMsg) && (errMsg.innerText || '').trim().length > 0) {
          log('Google error displayed: ' + errMsg.innerText.trim());
          break;
        }

        if (!(await isChallengeActuallyOpen())) {
          if (await checkSolvedStatus()) {
            log('Challenge UI closed and solve confirmed! 🎉');
            isSolved = true;
            break;
          } else {
            log('Challenge UI closed without confirmation');
            status('idle', 'Challenge closed', attempt);
            return;
          }
        }
      }

      if (isSolved) {
        log('CAPTCHA SOLVED SUCCESSFULLY! 🎉');
        status('success', 'Solved! 🎉', attempt);
        alreadySolved = true;
        return;
      }

      // check for error prompt
      const errMsg = q(SEL.errorBox);
      const hasError = visible(errMsg) && (errMsg.innerText || '').trim().length > 0;
      if (hasError) {
        const errText = errMsg.innerText.trim();
        log('Challenge not solved — Google says: "' + errText + '" — reloading audio');
        status('working', 'Reloading fresh audio (' + errText + ')', attempt);
        if (!(await isChallengeActuallyOpen())) {
          log('Challenge closed during error check — aborting');
          status('idle', 'Challenge closed', attempt);
          return;
        }
        const reload = q(SEL.reload);
        if (reload) reload.click();
        await sleep(rand(minDelay, maxDelay));
        attempt++;
        continue;
      }

      // fallback challenge verification check
      if (!(await isChallengeActuallyOpen())) {
        if (await checkSolvedStatus()) {
          log('Challenge UI no longer visible and solve confirmed! 🎉');
          status('success', 'Solved! 🎉', attempt);
          alreadySolved = true;
          return;
        }
        log('Challenge UI closed without confirmation');
        status('idle', 'Challenge closed', attempt);
        return;
      }

      log('Still in challenge — reloading audio');
      status('working', 'Still in challenge — retrying with fresh audio', attempt);
      const reload = q(SEL.reload);
      if (reload) reload.click();
      await sleep(rand(minDelay, maxDelay));
      attempt++;
      continue;
    }
    status('failed', 'Max attempts (' + maxAttempts + ') reached — try again or change IP', maxAttempts);
  }

  if (IS_ANCHOR) {
    let clickBusy = false;

    function selfChecked() {
      const cb = q(SEL.checkbox);
      return !!(cb && cb.classList.contains('recaptcha-checkbox-checked'));
    }

    async function clickCheckbox() {
      if (clickBusy) return;
      clickBusy = true;

      log('clickCheckbox: waiting for DOM to be interactive...');

      // await document interactive state
      if (document.readyState === 'loading') {
        await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
      }

      // wait for anchor checkbox
      const clickEl = await waitForSelectorRetry(CHECKBOX_SEL, 6000, 200);

      log('checkbox target found:', !!clickEl, clickEl ? (clickEl.id || clickEl.className) : 'NONE');

      if (!clickEl) {
        log('no checkbox target found in anchor doc (may be invisible reCAPTCHA or auto-triggered)');
        clickBusy = false;
        return;
      }

      // dispatch click event sequence
      clickEl.scrollIntoView({ block: 'center' });
      clickEl.focus();
      const rect = clickEl.getBoundingClientRect();
      if (window.__ccClickAnim) window.__ccClickAnim(rect.left + rect.width / 2, rect.top + rect.height / 2);
      try {
        clickEl.click();
      } catch {}
      clickEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
      clickEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      clickEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
      clickEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      clickEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      log('click dispatched on', clickEl.id || clickEl.className);

      chrome.runtime.sendMessage({ type: 'ARM_RELAY' }).catch(() => {});

      setTimeout(async () => {
        if (selfChecked()) {
          log('AUTO-PASS — checkbox checked without challenge');
          status('success', 'Auto-passed without challenge 🎉');
        } else {
          log('no auto-pass, challenge should be opening in bframe');
          clickBusy = false;
        }
      }, 3000);
    }

    function isAnchorExpired() {
      const err = q('.rc-anchor-error-msg, .rc-anchor-alert, #recaptcha-accessible-status, .rc-anchor-error');
      if (err && visible(err) && (err.innerText || '').trim().length > 0) {
        const txt = err.innerText.toLowerCase();
        if (txt.includes('expired') || txt.includes('समयसीमा खत्म') || txt.includes('दोबारा चुनें') || txt.includes('again')) {
          return true;
        }
      }
      const text = (document.body && document.body.innerText) || '';
      if (/expired|समयसीमा खत्म|दोबारा चुनें|check the checkbox again/i.test(text)) {
        return true;
      }
      return false;
    }

    function isQuotaExceeded() {
      const text = (document.body && document.body.innerText) || '';
      return /तय सीमा को पार|मुफ़्त चुनौतियों|quota exceeded|free challenge limit/i.test(text);
    }

    let lastExpiredHandled = 0;
    let lastQuotaLogged = 0;
    setInterval(() => {
      if (!isContextValid()) return;
      if (isQuotaExceeded()) {
        const now = Date.now();
        if (now - lastQuotaLogged > 8000) {
          lastQuotaLogged = now;
          logErr('reCAPTCHA Enterprise quota exceeded on this sitekey: "यह साइट reCAPTCHA Enterprise से मिलने वाली मुफ़्त चुनौतियों की तय सीमा को पार कर चुकी है."');
          status('failed', 'Site exceeded reCAPTCHA Enterprise free quota. Reset or try standard demo.');
        }
        return;
      }
      if (isAnchorExpired()) {
        const now = Date.now();
        if (now - lastExpiredHandled > 4000) {
          lastExpiredHandled = now;
          log('Anchor challenge expired detected — re-arming and clicking checkbox again');
          clickBusy = false;
          sendBG({ type: 'RECAPTCHA_RESET', reason: 'anchor-expired' });
          setTimeout(() => {
            clickCheckbox();
          }, 600);
        }
      }
    }, 1000);

    if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'CLICK_AND_SOLVE') {
        log('received CLICK_AND_SOLVE');
        clickCheckbox().catch((e) => {
          logErr('clickCheckbox unhandled exception: ' + (e.message || e));
          clickBusy = false;
        });
        sendResponse({ ok: true, clicked: true });
        return;
      }
      if (msg.type === 'IS_CHECKED') {
        sendResponse({ checked: selfChecked() });
        return;
      }
    });
    }

    log('anchor role initialized');

    // report detected anchor sitekey
    try {
      const u = new URL(location.href);
      const k = u.searchParams.get('k');
      log('anchor self-report: k=' + (k ? k.slice(0, 12) + '...' : 'MISSING'));
      if (k) {
        chrome.runtime.sendMessage({ type: 'DETECTED', version: 2, sitekey: k, fromAnchor: true }).catch(() => {});
      }
    } catch (e) {
      logErr('anchor self-report failed: ' + (e.message || e));
    }
  }

  function audioVisible() {
    const audioUI = q(
      '.rc-audiochallenge-contents, .rc-audiochallenge, #audio-instructions, #audio-response, .rc-audiochallenge-error-message, ' +
        SEL.audioElement
    );
    return visible(audioUI) || visible(q(SEL.input));
  }

  async function isChallengeActuallyOpen() {
    // verify frame bounding geometry
    if (window.innerHeight < 100 || window.innerWidth < 100) {
      return false;
    }

    // verify challenge element existence
    const verifyBtn = q(SEL.verify);
    const hasUI = visible(q(SEL.imageMode)) || visible(audioVisible()) || visible(q(SEL.input));
    if (!verifyBtn || !visible(verifyBtn) || !hasUI) {
      return false;
    }

    // check expired challenge prompt
    const bframeText = (document.body && document.body.innerText) || '';
    if (/expired|समयसीमा खत्म|check the checkbox again|दोबारा चुनें/i.test(bframeText)) {
      return false;
    }

    // query top frame visibility
    try {
      const resp = await sendBG({ type: 'IS_BFRAME_OPEN' });
      if (resp && resp.ok && resp.open === false) {
        return false;
      }
    } catch {}

    return true;
  }

  function challengeActuallyOpen() {
    if (window.innerHeight < 100 || window.innerWidth < 100) return false;
    const verifyBtn = q(SEL.verify);
    const hasUI = visible(q(SEL.imageMode)) || visible(audioVisible()) || visible(q(SEL.input));
    return hasUI && visible(verifyBtn);
  }

  if (IS_BFRAME) {
    let checkOpenBusy = false;

    async function triggerSolveIfOpen(source = 'unknown') {
      if (busy || alreadySolved || checkOpenBusy) return;
      if (!isContextValid()) return;

      const settings = cachedSettings;
      if (!settings.enabled || !settings.autoSolve) return;
      if (settings.solve_recaptcha === false) return;

      const verifyBtn = q(SEL.verify);
      const hasUI = visible(q(SEL.imageMode)) || visible(audioVisible()) || visible(q(SEL.input));
      if (!verifyBtn || !hasUI) return;

      checkOpenBusy = true;
      try {
        const isOpen = await isChallengeActuallyOpen();
        if (isOpen && !busy && !alreadySolved) {
          busy = true;
          log('challenge open on screen (' + source + ') — auto-solving');
          status('working', 'Challenge appeared — auto-solving', 0);
          solveLoop().finally(() => { busy = false; });
        }
      } finally {
        checkOpenBusy = false;
      }
    }

    if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'START_SOLVE') {
        if (busy) return sendResponse({ ok: false, error: 'already solving' });
        busy = true;
        alreadySolved = false;
        log('received START_SOLVE (manual)');
        status('working', 'Solver engaged (manual)', 0);
        solveLoop().finally(() => { busy = false; });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'ARM_CHALLENGE') {
        log('ARM_CHALLENGE received — checking if challenge is open');
        triggerSolveIfOpen('arm-relay');
        sendResponse({ ok: true });
        return;
      }
    });
    }

    const autoMo = new MutationObserver(() => {
      triggerSolveIfOpen('mutation');
    });
    autoMo.observe(document.documentElement, { childList: true, subtree: true });

    // poll bframe challenge solver
    let pollCount = 0;
    const bframePoll = setInterval(() => {
      pollCount++;
      if (busy || alreadySolved || pollCount > 30) {
        clearInterval(bframePoll);
        return;
      }
      triggerSolveIfOpen('poll-' + pollCount);
    }, 400);

    log('bframe role initialized');
    // initial bframe solve check
    setTimeout(() => {
      triggerSolveIfOpen('init');
    }, 250);
  }
})();
