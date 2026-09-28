(() => {
  // text captcha dom solver

  const isTop = window === window.top;
  if (!isTop) return;

  // check extension runtime context
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  let settingsCache = null;
  const BUSY_ATTR = 'data-cc-text-solving';
  const DONE_ATTR = 'data-cc-text-done';
  const MAX_ATTEMPTS = 6;

  function isContextValid() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  }

  function log(...args) {
    const line = '[textcaptcha] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log('%c[CC]', 'color:#a3e635;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line });
  }

  function logErr(...args) {
    const line = '[textcaptcha] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.error('%c[CC]', 'color:#ef4444;font-weight:bold', line);
    safeSendMessage({ type: 'LOG', line, level: 'error' });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.settings) return resolve(null);
          resolve(resp.settings);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // local question solver

  const NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90, hundred: 100
  };
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  function parseNumToken(tok) {
    tok = tok.toLowerCase().trim();
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    if (NUM_WORDS[tok] !== undefined) return NUM_WORDS[tok];
    // parse compound numbers
    const parts = tok.split(/[\s-]+/);
    let total = 0;
    for (const p of parts) {
      if (NUM_WORDS[p] === undefined) return null;
      total += NUM_WORDS[p];
    }
    return total || null;
  }

  function solveQuestionLocal(raw) {
    const q = raw.toLowerCase().replace(/[?.!]/g, ' ').replace(/\s+/g, ' ').trim();

    // evaluate basic arithmetic
    const arith = q.match(/(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\s*(?:\+|plus|and|\-|minus|less|–|\*|x|×|times|multiplied|\/|÷|divided)\s*(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)/);
    if (arith) {
      const a = parseNumToken(arith[1]);
      const b = parseNumToken(arith[2]);
      const opRaw = arith[0];
      if (a != null && b != null) {
        if (/\+|plus|\band\b/.test(opRaw)) return String(a + b);
        if (/\-|minus|less|–/.test(opRaw)) return String(a - b);
        if (/\*|x|×|times|multiplied/.test(opRaw)) return String(a * b);
        if (/\/|÷|divided/.test(opRaw)) return String(Math.floor(a / b));
      }
    }

    // evaluate number sum
    const sum = q.match(/sum\s+of\s+(\d+)\s+and\s+(\d+)/);
    if (sum) return String(parseInt(sum[1], 10) + parseInt(sum[2], 10));

    // evaluate weekday riddle
    const dayMatch = q.match(/if\s+(tomorrow|yesterday)\s+(?:is|was)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
    if (dayMatch) {
      const ref = DAYS.indexOf(dayMatch[2]);
      const shift = dayMatch[1] === 'tomorrow' ? -1 : 1;
      return DAYS[(ref + shift + 7) % 7];
    }
    const dayOf = q.match(/what\s+day\s+(?:was|is|will)\s+(?:it\s+)?(today|tomorrow|yesterday)/);
    if (dayMatch || dayOf) {
      // check relative day offset
      const refDay = q.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
      if (refDay && dayOf) {
        const ref = DAYS.indexOf(refDay[1]);
        const m = q.match(/\b(today|tomorrow|yesterday)\b/);
        if (m) {
          const shift = m[1] === 'tomorrow' ? 1 : m[1] === 'yesterday' ? -1 : 0;
          return DAYS[(ref + shift + 7) % 7];
        }
      }
      const afterBefore = q.match(/what\s+day\s+comes\s+(after|before)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
      if (afterBefore) {
        const ref = DAYS.indexOf(afterBefore[2]);
        return DAYS[(ref + (afterBefore[1] === 'after' ? 1 : -1) + 7) % 7];
      }
      return DAYS[(new Date().getDay() + (dayOf && dayOf[1] === 'tomorrow' ? 1 : dayOf && dayOf[1] === 'yesterday' ? -1 : 0) + 7) % 7];
    }
    const afterBeforeDay = q.match(/what\s+day\s+comes\s+(after|before)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
    if (afterBeforeDay) {
      const ref = DAYS.indexOf(afterBeforeDay[2]);
      return DAYS[(ref + (afterBeforeDay[1] === 'after' ? 1 : -1) + 7) % 7];
    }

    // count word letters
    const letters = q.match(/how\s+many\s+(letters|characters|chars)\s+(?:are\s+)?(?:there\s+)?in\s+(?:the\s+word\s+)?["']?([a-z]+)["']?/);
    if (letters) return String(letters[2].length);

    // find adjacent number
    const afterNum = q.match(/(?:comes|goes)\s+(?:after|before)\s+(the\s+number\s+)?(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/);
    if (afterNum) {
      const n = parseNumToken(afterNum[2]);
      if (n != null) return String(afterNum[0].includes('after') ? n + 1 : n - 1);
    }

    // find adjacent month
    const afterMonth = q.match(/(?:month\s+)?comes\s+(after|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)/);
    if (afterMonth) {
      const ref = MONTHS.indexOf(afterMonth[2]);
      return MONTHS[(ref + (afterMonth[1] === 'after' ? 1 : -1) + 12) % 12];
    }

    // find min or max
    const largest = q.match(/(largest|biggest|smallest|lowest)\s+number\s+(?:in|of|among)\s+([\d\s,]+)/);
    if (largest) {
      const nums = largest[2].match(/\d+/g).map(Number);
      if (nums.length) {
        return String(largest[1].startsWith('s') || largest[1] === 'lowest'
          ? Math.min(...nums)
          : Math.max(...nums));
      }
    }

    // skip ambiguous questions
    return null;
  }

  // candidate scanner

  const IMG_SRC_PAT = /(captcha|captch|securimage|kcaptcha|botdetect|anti[-_]?bot|code[-_]?(image|img)|imagecode|verif[a-z]*[_-]?image)/i;
  const IMG_BLOCK_PAT = /(logo|icon|avatar|banner|\.svg|favicon|sprite|thumbs?|photo|profile|bg|background|button|header|footer|emoji|ytimg|googlevideo|twimg|fbcdn|yt-core)/i;
  const STRICT_CAPTCHA_INPUT_PAT = /(captcha|captch|securimage|security[_-]?code|verif[a-z]*[_-]?code|code[_-]?image|img[_-]?code|captcha[_-]?word|anti[_-]?bot|robot[_-]?check)/i;
  const SOFT_CAPTCHA_INPUT_PAT = /\b(security|captcha|verification|challenge)\b/i;
  const NON_CAPTCHA_INPUT_PAT = /^(q|search|search_query|query|keyword|term|user|username|email|password|tel|phone|comment|message|title|url|href|link)$/i;
  const SUBMIT_PAT = /(verify|submit|check|confirm|login|log[\s-]?in|sign[\s-]?in|register|continue|next|send|go\b|validate|post|answer)/i;
  const ERROR_PAT = /(incorrect|wrong|invalid|try\s+again|failed|mismatch|error|didn.?t\s+match|not\s+correct|retry)/i;

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function isNonCaptchaContext(el) {
    if (!el) return true;
    // ignore non captcha elements
    if (el.closest('ytd-searchbox, #search-form, form[role="search"], [role="search"], ytd-comments, #comments, .comments-area, yt-live-chat-renderer, header, nav, footer')) {
      return true;
    }
    return false;
  }

  function scoreImage(img) {
    const src = (img.currentSrc || img.src || '').toLowerCase();
    const alt = (img.alt || '').toLowerCase();
    const idcls = ((img.id || '') + ' ' + (img.className || '')).toLowerCase();
    const rect = img.getBoundingClientRect();

    // verify captcha dimensions
    if (rect.width < 40 || rect.width > 420 || rect.height < 14 || rect.height > 170) return 0;
    const aspect = rect.width / Math.max(1, rect.height);
    if (aspect < 1 || aspect > 10) return 0;

    // filter standard assets
    if (IMG_BLOCK_PAT.test(src) || IMG_BLOCK_PAT.test(idcls) || IMG_BLOCK_PAT.test(alt)) return 0;
    if (isNonCaptchaContext(img)) return 0;

    // check captcha attributes
    const hasExplicit = IMG_SRC_PAT.test(src) || IMG_SRC_PAT.test(alt) || IMG_SRC_PAT.test(idcls);
    const isCanvasInCaptcha = img.tagName === 'CANVAS' && (/(captcha|security|verify)/i.test(img.parentElement?.className || '') || /(captcha|security|verify)/i.test(img.parentElement?.id || ''));

    if (!hasExplicit && !isCanvasInCaptcha) return 0;

    let score = 5;
    if (IMG_SRC_PAT.test(src)) score += 3;
    if (IMG_SRC_PAT.test(alt) || IMG_SRC_PAT.test(idcls)) score += 2;
    if (img.naturalWidth && img.naturalWidth <= 400 && img.naturalHeight <= 160) score += 1;

    return score;
  }

  function scoreInput(input) {
    if (!input || input.type === 'hidden' || input.type === 'password' || input.type === 'email') return 0;
    if (input.type === 'search' || input.getAttribute('role') === 'searchbox') return 0;

    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    if (NON_CAPTCHA_INPUT_PAT.test(name) || NON_CAPTCHA_INPUT_PAT.test(id)) return 0;

    if (isNonCaptchaContext(input)) return 0;

    const placeholder = (input.placeholder || '').toLowerCase();
    const aria = (input.getAttribute('aria-label') || '').toLowerCase();
    if (/search|comment|chat|message|title|video|channel|browse|filter/i.test(placeholder) ||
        /search|comment|chat|message|title|video|channel|browse|filter/i.test(aria)) {
      return 0;
    }

    const sig = [
      name, id, placeholder, aria,
      input.className, input.title
    ].filter(Boolean).join(' ').toLowerCase();

    if (!sig) return 0;

    // score explicit input indicators
    if (STRICT_CAPTCHA_INPUT_PAT.test(sig)) return 6;
    if (SOFT_CAPTCHA_INPUT_PAT.test(sig) && /code|answer|word|char|text|box/i.test(sig)) return 4;

    // inspect parent container
    const parent = input.closest('form, div, td, label');
    if (parent) {
      const parentSig = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();
      if (STRICT_CAPTCHA_INPUT_PAT.test(parentSig)) return 4;
    }

    return 0;
  }

  function textAround(el, radius) {
    // collect nearby text
    const rect = el.getBoundingClientRect();
    const out = [];
    const scope = el.closest('form') || el.closest('div') || el.parentElement;
    if (scope) {
      const txt = (scope.innerText || '').slice(0, 600);
      out.push(txt);
    }
    for (const cand of document.querySelectorAll('label, p, span, div, td, th')) {
      if (!cand.innerText || cand.innerText.length > 300) continue;
      const cr = cand.getBoundingClientRect();
      const dy = Math.abs((cr.top + cr.height / 2) - (rect.top + rect.height / 2));
      const dx = Math.abs((cr.left + cr.width / 2) - (rect.left + rect.width / 2));
      if (dy < radius && dx < radius * 3) out.push(cand.innerText);
    }
    return out.join(' \n ').slice(0, 1500);
  }

  function findSubmitFor(input) {
    // inspect enclosing form
    const form = input.closest('form');
    if (form) {
      const btns = form.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a.btn, div.btn');
      for (const b of btns) {
        if (!visible(b)) continue;
        const t = ((b.textContent || b.value || '') + ' ' + (b.className || '') + ' ' + (b.innerHTML || '')).toLowerCase();
        if (SUBMIT_PAT.test(t) || /fa-check|icon-check|checkmark|fa-arrow|submit|check/i.test(t)) return b;
      }
      const anySubmit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (anySubmit && visible(anySubmit)) return anySubmit;
    }

    // inspect enclosing container
    const container = input.closest('.modal, .card, .box, .container, .dialog, [class*="captcha"], [class*="login"], [class*="form"]') || input.parentElement?.parentElement;
    if (container) {
      const btns = Array.from(container.querySelectorAll('button, input[type="submit"], [role="button"], a.btn, div.btn')).filter(visible);
      for (const b of btns) {
        const t = ((b.textContent || b.value || '') + ' ' + (b.className || '') + ' ' + (b.innerHTML || '')).toLowerCase();
        if (SUBMIT_PAT.test(t) || /fa-check|icon-check|checkmark|submit|check/i.test(t)) return b;
      }
      // check button position
      const ir = input.getBoundingClientRect();
      const below = btns.filter((b) => {
        const br = b.getBoundingClientRect();
        return br.top >= ir.top - 5 && br.top <= ir.bottom + 140 && Math.abs((br.left + br.width / 2) - (ir.left + ir.width / 2)) < 350;
      });
      if (below.length > 0) return below[0];
    }

    // inspect tree siblings
    let p = input.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      const btns = Array.from(p.querySelectorAll('button, input[type="submit"], [role="button"]')).filter(visible);
      for (const b of btns) {
        const t = ((b.textContent || b.value || '') + ' ' + (b.className || '') + ' ' + (b.innerHTML || '')).toLowerCase();
        if (SUBMIT_PAT.test(t) || /fa-check|icon-check|checkmark|check/i.test(t)) return b;
      }
      p = p.parentElement;
    }
    return form ? form.querySelector('button, input[type="submit"]') : null;
  }

  function findRefreshFor(img, input) {
    const scope = img.closest('div, td, form, .card, .box') || img.parentElement?.parentElement;
    const root = scope || document;
    const cands = root.querySelectorAll(
      '[title*="refresh" i], [title*="reload" i], [title*="new" i], [alt*="refresh" i], [alt*="reload" i],' +
      '[aria-label*="refresh" i], [aria-label*="reload" i], a[href*="reload"], a[href*="refresh"],' +
      '.refresh, .reload, .captcha-refresh, img[src*="refresh"], img[src*="reload"],' +
      '[class*="sync" i], [class*="reload" i], [class*="refresh" i], [class*="repeat" i], [class*="rotate" i], [class*="redo" i]'
    );
    for (const c of cands) {
      if (c !== img && visible(c)) return c;
    }
    // check reload button
    const ir = img.getBoundingClientRect();
    const allBtns = root.querySelectorAll('button, [role="button"], a, i, span.btn');
    for (const b of allBtns) {
      if (b === img || !visible(b)) continue;
      const br = b.getBoundingClientRect();
      const dist = Math.hypot((br.left + br.width / 2) - ir.right, (br.top + br.height / 2) - ir.top);
      if (dist < 70 && br.width < 60 && br.height < 60) return b;
    }
    return null;
  }

  function findQuestionCaptcha() {
    // find question captcha
    const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="search"], input:not([type])');
    for (const input of inputs) {
      if (input.type === 'hidden' || !visible(input)) continue;
      if (input.getAttribute(BUSY_ATTR) || input.getAttribute(DONE_ATTR)) continue;
      const ish = scoreInput(input);
      if (ish <= 0) continue;
      const around = textAround(input, 140);
      const m = around.match(/[^.\n!?]*?(?:what\s+(?:day|is|number|comes|was)|how\s+many|sum\s+of|calculate|if\s+\w+\s+(?:is|was)|\d+\s*[+\-x×*÷\/]\s*\d+)[^.\n!?]*/i);
      if (m && m[0].trim().length > 8 && m[0].trim().length < 250) {
        return { kind: 'question', input, question: m[0].trim(), score: ish };
      }
    }
    return null;
  }

  function findImageCaptcha() {
    const results = [];
    const imgs = document.querySelectorAll('img, canvas');
    for (const img of imgs) {
      if (!visible(img)) continue;
      const s = scoreImage(img);
      if (s < 3) continue;

      // pair with input
      let bestInput = null;
      let bestDist = Infinity;
      const rect = img.getBoundingClientRect();
      const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="search"], input:not([type])');
      for (const input of inputs) {
        if (input.type === 'hidden' || !visible(input)) continue;
        if (input.getAttribute(BUSY_ATTR) || input.getAttribute(DONE_ATTR)) continue;
        const ish = scoreInput(input);
        if (ish <= 0) continue;
        const ir = input.getBoundingClientRect();
        const dy = Math.abs((ir.top + ir.height / 2) - (rect.top + rect.height / 2));
        const dx = Math.abs((ir.left + ir.width / 2) - (rect.left + rect.width / 2));
        const dist = dy + dx * 0.5;
        if (dy < 260 && dx < 600 && dist < bestDist) {
          bestDist = dist;
          bestInput = input;
        }
      }
      if (!bestInput) continue;

      // Same form bonus
      let score = s + (img.closest('form') && bestInput.closest('form') === img.closest('form') ? 2 : 0);
      const around = textAround(bestInput, 120).toLowerCase();
      if (/enter\s+(the\s+)?(word|code|text|characters|chars)|type\s+the|shown\s+in\s+the\s+image/i.test(around)) score += 3;
      results.push({ kind: 'image', img, input: bestInput, score, src: img.currentSrc || img.src || '' });
    }
    results.sort((a, b) => b.score - a.score);
    return results[0] || null;
  }

  // image extraction pipeline

  function extractViaCanvas(el) {
    try {
      if (el.tagName === 'CANVAS') {
        const dataUrl = el.toDataURL('image/png');
        if (dataUrl && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 100) {
          return { b64: dataUrl.split(',')[1], mime: 'image/png' };
        }
        return null;
      }
      const w = el.naturalWidth || el.width || Math.round(el.getBoundingClientRect().width);
      const h = el.naturalHeight || el.height || Math.round(el.getBoundingClientRect().height);
      if (!w || !h || w < 5 || h < 5) return null;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(el, 0, 0, w, h);
      const dataUrl = c.toDataURL('image/png');
      if (dataUrl && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 100) {
        return { b64: dataUrl.split(',')[1], mime: 'image/png' };
      }
    } catch (e) {
      // handle tainted canvas
    }
    return null;
  }

  async function extractViaScreenshot(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(100);
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return null;
      const dpr = window.devicePixelRatio || 1;
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_ELEMENT_RECT',
          rect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            dpr
          }
        }, (r) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(r || { ok: false, error: 'no response' });
        });
      });
      if (resp && resp.ok && resp.b64 && resp.b64.length > 100) {
        return { b64: resp.b64, mime: 'image/png' };
      }
    } catch (e) {}
    return null;
  }

  async function imageToB64(img) {
    const src = img.currentSrc || img.src || '';

    // check inline data url
    if (src.startsWith('data:image/')) {
      const parts = src.split(',');
      if (parts[1] && parts[1].length > 100) {
        const mime = (src.match(/^data:([^;]+)/) || [])[1] || 'image/png';
        return normalizeCaptchaImage(parts[1], mime);
      }
    }

    // extract canvas pixels directly
    const direct = extractViaCanvas(img);
    if (direct) {
      log('extracted image directly via in-memory canvas (' + Math.round(direct.b64.length * 3 / 4 / 1024) + 'KB)');
      return normalizeCaptchaImage(direct.b64, direct.mime);
    }

    // capture viewport screenshot
    log('canvas direct extract unavailable — capturing via viewport screenshot');
    const shot = await extractViaScreenshot(img);
    if (shot) {
      log('extracted image via viewport screenshot (' + Math.round(shot.b64.length * 3 / 4 / 1024) + 'KB)');
      return normalizeCaptchaImage(shot.b64, shot.mime);
    }

    // fallback to fetch
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      try {
        log('trying fetch fallback as last resort...');
        const resp = await fetch(src, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        if (contentType && !contentType.startsWith('image/')) {
          throw new Error('Non-image response: ' + contentType);
        }
        const blob = await resp.blob();
        if (blob.size < 50) throw new Error('Blob too small (' + blob.size + 'b)');
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        }
        const b64 = btoa(bin);
        return normalizeCaptchaImage(b64, blob.type || 'image/png');
      } catch (e) {
        logErr('fetch fallback failed: ' + (e.message || e));
      }
    }

    throw new Error('All image extraction methods failed');
  }

  // upscale for ocr model
  async function normalizeCaptchaImage(b64, mime) {
    if (!b64 || typeof b64 !== 'string' || b64.length < 50) {
      throw new Error('invalid or empty image base64 data');
    }
    const cleanMime = (mime && mime.startsWith('image/')) ? mime : 'image/png';

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      const timer = setTimeout(() => {
        im.onload = null;
        im.onerror = null;
        reject(new Error('image decode timeout'));
      }, 6000);
      im.onload = () => {
        clearTimeout(timer);
        resolve(im);
      };
      im.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('image decode rejected by browser'));
      };
      im.src = 'data:' + cleanMime + ';base64,' + b64;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('image has zero dimensions');

    // scale preserving aspect ratio
    const targetH = Math.max(120, Math.min(260, Math.round(h * 2)));
    const scale = targetH / h;
    const targetW = Math.round(w * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const out = canvas.toDataURL('image/png');
    log('normalized captcha image: ' + w + 'x' + h + ' → ' + canvas.width + 'x' + canvas.height + ' png (' + Math.round(out.length * 3 / 4 / 1024) + 'KB)');
    return { b64: out.split(',')[1] || '', mime: 'image/png' };
  }

  // solve flows

  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function humanType(input, text) {
    return new Promise((resolve) => {
      const rect = input.getBoundingClientRect();
      if (window.__ccClickAnim) window.__ccClickAnim(rect.left + 20, rect.top + rect.height / 2);
      input.focus();
      setNativeValue(input, '');
      let i = 0;
      const timer = setInterval(() => {
        if (i >= text.length) {
          clearInterval(timer);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          resolve();
          return;
        }
        setNativeValue(input, input.value + text[i]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        i++;
      }, rand(55, 140));
    });
  }

  function normalizeAnswer(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    // clean prefix conversational noise
    s = s.replace(/^(?:the\s+(?:captcha\s+)?(?:characters?|text|letters?|code|word)\s+(?:is|are|shows?):?|answer:?|captcha:?|text:?)\s*/i, '');
    s = s.replace(/^["'`\s]+|["'`\s.]+$/g, '');
    if (s.includes('\n')) {
      s = s.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    }
    // collapse spaced letters
    if (/^[a-zA-Z0-9\s\-]+$/.test(s)) {
      s = s.replace(/\s+/g, '');
    }
    return s.slice(0, 32);
  }

  function clickSubmit(input) {
    let clicked = false;
    const btn = findSubmitFor(input);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      if (window.__ccClickAnim) window.__ccClickAnim(rect.left + rect.width / 2, rect.top + rect.height / 2);
      btn.scrollIntoView({ block: 'center' });
      btn.focus();
      btn.click();
      log('clicked submit:', (btn.textContent || btn.value || btn.className || btn.tagName).trim().slice(0, 30));
      clicked = true;
    }

    // dispatch enter key event
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch {}

    const form = input.closest('form');
    if (!clicked && form && form.requestSubmit) {
      try {
        form.requestSubmit();
        log('form.requestSubmit()');
        clicked = true;
      } catch {}
    }

    if (!clicked) log('submit triggered via Enter key');
    return true;
  }

  function submissionFailed(container, input) {
    // error keywords anywhere near
    const around = textAround(input, 160).toLowerCase();
    if (ERROR_PAT.test(around)) return true;
    // input cleared check
    if (visible(input) && input.value === '') return true;
    return false;
  }

  function captchaGone(container, input) {
    if (!document.body.contains(input)) return true;
    if (!visible(input)) return true;
    return false;
  }

  async function refreshImage(img) {
    const refreshBtn = findRefreshFor(img);
    if (refreshBtn) {
      log('clicking refresh control');
      refreshBtn.click();
      await sleep(rand(800, 1400));
      return true;
    }
    // cache-buster re-fetch
    const src = img.currentSrc || img.src;
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      try {
        const u = new URL(src, location.href);
        u.searchParams.set('cc', String(Date.now()));
        img.src = u.toString();
        await sleep(rand(800, 1400));
        return true;
      } catch {}
    }
    return false;
  }

  async function solveImageCaptcha(cand) {
    const { img, input } = cand;
    input.setAttribute(BUSY_ATTR, '1');
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        safeSendMessage({ type: 'STATUS', status: 'working', message: 'Text captcha: reading image (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')', attempt: attempt - 1 });
        log('attempt ' + attempt + ' — extracting image');

        let payload;
        try {
          payload = await imageToB64(img);
        } catch (e) {
          logErr('image extraction failed: ' + (e.message || e));
          await sleep(1500);
          continue;
        }

        const resp = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'TEXT_CAPTCHA_VISION', b64: payload.b64, mime: payload.mime }, (r) => {
              if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
              resolve(r || { ok: false, error: 'no response' });
            });
          } catch (e) {
            resolve({ ok: false, error: String(e.message || e) });
          }
        });

        if (!resp.ok) {
          logErr('vision failed: ' + (resp.error || 'unknown'));
          await sleep(rand(1200, 2200));
          continue;
        }

        const answer = normalizeAnswer(resp.text);
        log('vision says "' + resp.text + '" → normalized "' + answer + '"');
        if (!answer || answer === '?' || answer.length < 1 || answer.length > 20) {
          log('unusable answer — refreshing + retrying');
          await refreshImage(img);
          continue;
        }

        await humanType(input, answer);
        await sleep(rand(300, 700));
        clickSubmit(input);
        await sleep(rand(1800, 2800));

        if (captchaGone(null, input)) {
          log('captcha container gone — SOLVED 🎉');
          input.setAttribute(DONE_ATTR, '1');
          safeSendMessage({ type: 'STATUS', status: 'success', message: 'Text captcha solved 🎉' });
          return true;
        }
        if (submissionFailed(null, input)) {
          log('submission failed — refreshing + retrying');
          await refreshImage(img);
          continue;
        }
        // mark solved successfully
        log('no error detected — accepting as solved');
        input.setAttribute(DONE_ATTR, '1');
        safeSendMessage({ type: 'STATUS', status: 'success', message: 'Text captcha solved 🎉' });
        return true;
      }
      safeSendMessage({ type: 'STATUS', status: 'failed', message: 'Text captcha: max attempts reached' });
      return false;
    } finally {
      input.removeAttribute(BUSY_ATTR);
    }
  }

  async function solveQuestionCaptcha(cand) {
    const { input, question } = cand;
    input.setAttribute(BUSY_ATTR, '1');
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        safeSendMessage({ type: 'STATUS', status: 'working', message: 'Text captcha: solving question', attempt: attempt - 1 });
        let answer = solveQuestionLocal(question);
        let via = 'local';
        if (!answer) {
          log('local solver missed — asking xkiro chat');
          const resp = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({ type: 'TEXT_CAPTCHA_CHAT', question }, (r) => {
                if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
                resolve(r || { ok: false, error: 'no response' });
              });
            } catch (e) {
              resolve({ ok: false, error: String(e.message || e) });
            }
          });
          if (!resp.ok) {
            logErr('chat failed: ' + (resp.error || 'unknown'));
            await sleep(1500);
            continue;
          }
          answer = resp.text;
          via = 'xkiro';
        }
        answer = String(answer).trim().slice(0, 40);
        log('answer (' + via + '): "' + answer + '"');

        await humanType(input, answer);
        await sleep(rand(300, 700));
        clickSubmit(input);
        await sleep(rand(1800, 2800));

        if (captchaGone(null, input)) {
          log('captcha container gone — SOLVED 🎉');
          input.setAttribute(DONE_ATTR, '1');
          safeSendMessage({ type: 'STATUS', status: 'success', message: 'Text captcha solved 🎉' });
          return true;
        }
        if (submissionFailed(null, input)) {
          log('wrong answer — retrying');
          continue;
        }
        log('no error detected — accepting as solved');
        input.setAttribute(DONE_ATTR, '1');
        safeSendMessage({ type: 'STATUS', status: 'success', message: 'Text captcha solved 🎉' });
        return true;
      }
      safeSendMessage({ type: 'STATUS', status: 'failed', message: 'Text captcha: question unsolved after 3 tries' });
      return false;
    } finally {
      input.removeAttribute(BUSY_ATTR);
    }
  }

  // scan loop

  let scanBusy = false;
  let scanTimer = null;

  function captchaProviderActive() {
    // skip specialized captchas
    if (document.querySelector('iframe[src*="/recaptcha/api2/"], iframe[id*="cf-chl-widget"], iframe[src*="/cdn-cgi/challenge-platform/"]')) return true;
    return false;
  }

  async function scan() {
    if (scanBusy) return;
    if (!isContextValid()) return;
    if (captchaProviderActive()) return;
    if (!settingsCache) settingsCache = await getSettings();
    if (!settingsCache || settingsCache.enabled === false || !settingsCache.solve_textcaptcha) return;
    if (!settingsCache.autoSolve && !settingsCache.autoClick) return;

    scanBusy = true;
    try {
      const qc = findQuestionCaptcha();
      if (qc) {
        log('question captcha detected: "' + qc.question.slice(0, 80) + '"');
        safeSendMessage({ type: 'DETECTED', provider: 'textcaptcha', version: 'textcaptcha', kind: 'question' });
        await solveQuestionCaptcha(qc);
        return;
      }
      const ic = findImageCaptcha();
      if (ic) {
        log('image captcha detected: score=' + ic.score + ' src=' + ic.src.slice(0, 60));
        safeSendMessage({ type: 'DETECTED', provider: 'textcaptcha', version: 'textcaptcha', kind: 'image', src: ic.src });
        await solveImageCaptcha(ic);
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
    scanTimer = setTimeout(scan, 700);
  }

  const mo = new MutationObserver(() => {
    if (!isContextValid()) {
      mo.disconnect();
      return;
    }
    scheduleScan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
          if (!settingsCache) settingsCache = {};
          for (const k in changes) settingsCache[k] = changes[k].newValue;
        }
      });
    } catch {}
  }

  // initialize background scan
  setTimeout(scan, 1200);
  setInterval(scan, 5000);
  setInterval(async () => {
    const s = await getSettings();
    if (s) settingsCache = s;
  }, 10000);

  if (chrome && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'TEXT_CAPTCHA_SCAN') {
        settingsCache = null;
        scan();
        sendResponse({ ok: true });
        return;
      }
    });
  }

  log('textcaptcha scanner initialized');
})();
