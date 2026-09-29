importScripts('/lib/stt.js');

const DEFAULTS = {
  enabled: true,
  autoSolve: true,
  autoClick: true,
  solverMode: 'image', // 'image' = image solver first with audio fallback, 'audio' = audio only, 'image_only' = image only
  provider: 'google',
  visionApiKey: 'sk-xt-1f08ad192f4cfc85e0d9f9568c951e7922ce8ec4b12fe127',
  visionModel: 'qwen/qwen3.8-omni-flash:free',
  visionBaseUrl: 'https://api.xkiro.com/v1',
  maxAttempts: 6,
  minDelay: 1200,
  maxDelay: 3000,
  solvedCount: 0,
  // provider toggles
  solve_hcaptcha: false,
  solve_recaptcha: true,
  solve_turnstile: true,
  solve_funcaptcha: true,
  solve_awscaptcha: false,
  solve_textcaptcha: true,
  solve_human: false,
  solve_geetest: true,
  solve_lemin: false
};

let settings = { ...DEFAULTS };

chrome.storage.sync.get(DEFAULTS).then((s) => {
  settings = { ...settings, ...s };
  if (!settings.visionApiKey) {
    settings.visionApiKey = DEFAULTS.visionApiKey;
    chrome.storage.sync.set({ visionApiKey: DEFAULTS.visionApiKey });
  }
  // default hcaptcha setting
  if (s.hcaptcha_default_off !== true) {
    settings.solve_hcaptcha = false;
    chrome.storage.sync.set({ solve_hcaptcha: false, hcaptcha_default_off: true });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const k in changes) settings[k] = changes[k].newValue;
});

const tabs = new Map();
const activeTabSolvers = new Map();

function runDeduplicatedSolver(tabId, solverKey, fn) {
  const key = `${tabId}:${solverKey}`;
  if (activeTabSolvers.has(key)) {
    return activeTabSolvers.get(key);
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      activeTabSolvers.delete(key);
    }
  })();
  activeTabSolvers.set(key, promise);
  return promise;
}

const LOG_LIMIT = 300;
let globalLogs = [];
let imageDumps = [];
const IMAGE_DUMP_LIMIT = 60;
// tab recording state
let recordingState = { isRecording: false, tabId: null, startTime: 0, lastFile: null };

function ccLog(tabId, line, level) {
  const entry = { ts: new Date().toISOString().slice(11, 23), tabId, line, level: level || 'info' };
  globalLogs.push(entry);
  if (globalLogs.length > LOG_LIMIT) globalLogs.shift();
  console.log('[CC]', entry.ts, entry.line);
}

function info(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      tabId,
      status: 'idle',
      attempt: 0,
      message: 'idle',
      version: null,
      sitekey: null,
      solvedCount: 0
    });
  }
  return tabs.get(tabId);
}

function updateBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text: text || '' }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function setStatus(tabId, status, message, attempt) {
  const t = info(tabId);
  t.status = status;
  t.message = message || status;
  if (attempt != null) t.attempt = attempt;

  if (status === 'success') {
    t.solvedCount++;
    t.lastSolved = Date.now();
    settings.solvedCount++;
    chrome.storage.sync.set({ solvedCount: settings.solvedCount });
    updateBadge(tabId, String(t.solvedCount), '#22c55e');
  } else if (status === 'working') {
    updateBadge(tabId, '...', '#c084fc');
  } else if (status === 'failed') {
    updateBadge(tabId, 'X', '#ef4444');
  } else if (status === 'rate_limited') {
    updateBadge(tabId, '!', '#f59e0b');
  } else if (status === 'stt_error') {
    updateBadge(tabId, 'X', '#ef4444');
  } else if (status === 'idle') {
    updateBadge(tabId, '', '#00000000');
  }
  broadcast({ type: 'STATUS_UPDATE', state: t });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : (msg.tabId != null ? msg.tabId : null);

  switch (msg.type) {
    case 'DETECTED': {
      const t = info(tabId);
      if (msg.provider === 'textcaptcha' || msg.version === 'textcaptcha') {
        t.provider = 'textcaptcha';
        t.version = 'textcaptcha';
        t.sitekey = msg.src || 'text';
        ccLog(tabId, 'DETECTED Text CAPTCHA (' + (msg.kind || 'image') + ')');
        sendResponse({ ok: true, settings: safeSettings() });
        break;
      }

      if (msg.provider === 'geetest' || msg.version === 'geetest') {
        t.provider = 'geetest';
        t.version = 'geetest';
        t.sitekey = msg.gt || 'geetest';
        ccLog(tabId, 'DETECTED GeeTest CAPTCHA');
        sendResponse({ ok: true, settings: safeSettings() });
        break;
      }

      if (msg.provider === 'turnstile' || msg.version === 'turnstile') {
        t.provider = 'turnstile';
        t.version = 'turnstile';
        t.sitekey = msg.sitekey;
        ccLog(tabId, 'DETECTED Cloudflare Turnstile sitekey=' + (msg.sitekey || 'none'));
        if (settings.solve_turnstile === false) {
          ccLog(tabId, 'Turnstile solver is toggled OFF in Providers settings', 'warn');
        } else if (settings.enabled && settings.autoSolve) {
          setStatus(tabId, 'working', 'Cloudflare Turnstile detected — preparing solver...', 0);
          solveTurnstile(tabId, 'auto-detected');
        }
        sendResponse({ ok: true, settings: safeSettings() });
        break;
      }

      if (msg.provider === 'funcaptcha' || msg.version === 'funcaptcha') {
        t.provider = 'funcaptcha';
        t.version = 'funcaptcha';
        t.sitekey = msg.sitekey || 'funcaptcha';
        ccLog(tabId, 'DETECTED Arkose FunCAPTCHA (' + (msg.sitekey || 'arkose') + ')');
        updateBadge(tabId, 'FUN', '#10b981');
        if (settings.solve_funcaptcha === false) {
          ccLog(tabId, 'FunCAPTCHA solver is toggled OFF in Providers settings', 'warn');
        } else if (t.status === 'idle') {
          setStatus(tabId, 'working', 'FunCAPTCHA detected — waiting for puzzle...', 0);
        }
        sendResponse({ ok: true, settings: safeSettings() });
        break;
      }

      t.provider = 'recaptcha';
      t.version = msg.version;
      t.sitekey = msg.sitekey;
      ccLog(tabId, 'DETECTED v' + msg.version + ' sitekey=' + (msg.sitekey || 'none') + (msg.fromAnchor ? ' (anchor self-report)' : ' (page scan)'));
      if (settings.solve_recaptcha === false) {
        ccLog(tabId, 'reCAPTCHA solver is toggled OFF in Providers settings', 'warn');
        sendResponse({ ok: true, settings: safeSettings() });
        break;
      }
      // handle anchor ready
      if (msg.fromAnchor && settings.enabled && settings.autoClick) {
        if (settings.provider === 'custom' && !settings.customEndpoint) {
          ccLog(tabId, 'AUTO_CLICK blocked: custom endpoint empty', 'error');
        } else {
          setStatus(tabId, 'working', 'Captcha detected — auto-clicking checkbox', 0);
          ccLog(tabId, 'AUTO_CLICK (anchor-triggered): locating anchor frame...');
          relayClickToAnchor(tabId, 'anchor-auto');
        }
      }
      sendResponse({ ok: true, settings: safeSettings() });
      break;
    }

    case 'LOG': {
      ccLog(tabId, msg.line, msg.level);
      sendResponse({ ok: true });
      break;
    }

    case 'GET_SETTINGS': {
      sendResponse({ ok: true, settings: safeSettings() });
      break;
    }

    case 'GET_STATE': {
      const t = info(msg.tabId != null ? msg.tabId : tabId);
      const logs = globalLogs.filter((l) => l.tabId == null || l.tabId === (msg.tabId != null ? msg.tabId : tabId));
      sendResponse({ ok: true, state: t, settings: safeSettings(), logs, recordingState });
      break;
    }

    case 'GET_RECORDING_STATE': {
      sendResponse({ ok: true, recordingState });
      break;
    }

    case 'START_RECORDING': {
      const targetId = msg.tabId != null ? msg.tabId : tabId;
      if (!targetId) {
        sendResponse({ ok: false, error: 'no active tab to record' });
        break;
      }
      chrome.tabCapture.getMediaStreamId({ targetTabId: targetId }, async (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const err = chrome.runtime.lastError?.message || 'failed to get tab stream id';
          ccLog(targetId, 'Record error: ' + err, 'error');
          sendResponse({ ok: false, error: err });
          return;
        }
        try {
          await ensureOffscreen();
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START_RECORD',
            streamId,
            tabId: targetId
          }, (resp) => {
            if (resp && resp.ok) {
              recordingState = { isRecording: true, tabId: targetId, startTime: Date.now(), lastFile: null };
              ccLog(targetId, 'Website video recording started ⏺');
              broadcast({ type: 'RECORDING_STATUS', recordingState });
              sendResponse({ ok: true, recordingState });
            } else {
              const err = resp?.error || 'failed to start recording';
              ccLog(targetId, 'Record error: ' + err, 'error');
              sendResponse({ ok: false, error: err });
            }
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      });
      return true;
    }

    case 'STOP_RECORDING': {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORD' }, (resp) => {
        sendResponse(resp || { ok: true });
      });
      return true;
    }

    case 'RECORDING_COMPLETE': {
      const recTab = recordingState.tabId || tabId || 0;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `Nopecha-Alternative/Recordings/recording_${ts}.webm`;

      chrome.downloads.download({
        url: msg.dataUrl,
        filename,
        saveAs: false
      }, (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          ccLog(recTab, 'Recording download notice: ' + err.message, 'warn');
        } else {
          ccLog(recTab, 'Website recording saved: ' + filename + ' (' + Math.round((msg.size || 0) / 1024) + ' KB) 🎥');
        }
      });

      recordingState = {
        isRecording: false,
        tabId: null,
        startTime: 0,
        lastFile: filename,
        lastSaved: Date.now()
      };
      broadcast({ type: 'RECORDING_STATUS', recordingState });
      sendResponse({ ok: true, filename });
      break;
    }

    case 'GET_ERROR_LOGS': {
      const errs = globalLogs.filter((l) => l.level === 'error');
      sendResponse({ ok: true, logs: errs });
      break;
    }

    case 'GET_ALL_LOGS': {
      sendResponse({ ok: true, logs: globalLogs });
      break;
    }

    case 'DUMP_SOLVE_IMAGE': {
      try {
        imageDumps.push({
          ts: new Date().toISOString(),
          label: msg.label || 'image',
          mime: msg.mime || 'image/jpeg',
          b64: msg.b64 || ''
        });
        if (imageDumps.length > IMAGE_DUMP_LIMIT) imageDumps.shift();
      } catch {}
      sendResponse({ ok: true });
      break;
    }

    case 'GET_SOLVE_IMAGES': {
      sendResponse({ ok: true, images: imageDumps });
      break;
    }

    case 'SOLVE_TAB': {
      const t = info(msg.tabId);
      if (!settings.enabled) {
        sendResponse({ ok: false, error: 'Extension disabled — toggle Enabled in the popup.' });
        break;
      }
      if (t.provider === 'turnstile' || t.version === 'turnstile') {
        if (!settings.solve_turnstile) {
          sendResponse({ ok: false, error: 'Cloudflare Turnstile solver is disabled in Providers settings.' });
          break;
        }
        setStatus(msg.tabId, 'working', 'Manual solve triggered — solving Turnstile', 0);
        ccLog(msg.tabId, 'SOLVE_TAB: triggering Turnstile solver...');
        solveTurnstile(msg.tabId, 'manual');
        sendResponse({ ok: true });
        break;
      }
      if (t.provider === 'textcaptcha' || t.version === 'textcaptcha') {
        if (!settings.solve_textcaptcha) {
          sendResponse({ ok: false, error: 'Text CAPTCHA solver is disabled in Providers settings.' });
          break;
        }
        setStatus(msg.tabId, 'working', 'Manual solve triggered — solving Text Captcha', 0);
        ccLog(msg.tabId, 'SOLVE_TAB: triggering Text Captcha solver...');
        chrome.tabs.sendMessage(msg.tabId, { type: 'TEXT_CAPTCHA_SCAN' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      if (t.provider === 'geetest' || t.version === 'geetest') {
        if (!settings.solve_geetest) {
          sendResponse({ ok: false, error: 'GeeTest solver is disabled in Providers settings.' });
          break;
        }
        setStatus(msg.tabId, 'working', 'Manual solve triggered — solving GeeTest', 0);
        ccLog(msg.tabId, 'SOLVE_TAB: triggering GeeTest solver...');
        chrome.tabs.sendMessage(msg.tabId, { type: 'GEETEST_SOLVE' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      if (t.provider === 'funcaptcha' || t.version === 'funcaptcha') {
        if (!settings.solve_funcaptcha) {
          sendResponse({ ok: false, error: 'FunCAPTCHA solver is disabled in Providers settings.' });
          break;
        }
        setStatus(msg.tabId, 'working', 'Manual solve triggered — solving FunCAPTCHA', 0);
        ccLog(msg.tabId, 'SOLVE_TAB: triggering FunCAPTCHA solver...');
        chrome.tabs.sendMessage(msg.tabId, { type: 'FUNCAPTCHA_SOLVE' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      if (settings.provider === 'custom' && !settings.customEndpoint) {
        sendResponse({ ok: false, error: 'Custom endpoint selected but empty.' });
        break;
      }
      if (t.version == null) {
        chrome.tabs.sendMessage(msg.tabId, { type: 'GEETEST_SOLVE' }).catch(() => {});
        chrome.tabs.sendMessage(msg.tabId, { type: 'TEXT_CAPTCHA_SCAN' }).catch(() => {});
        sendResponse({ ok: false, error: 'No captcha detected on this tab yet. Reload the page once.' });
        break;
      }
      setStatus(msg.tabId, 'working', 'Manual solve triggered — clicking checkbox', 0);
      ccLog(msg.tabId, 'SOLVE_TAB: locating anchor frame...');
      relayClickToAnchor(msg.tabId, 'manual');
      sendResponse({ ok: true });
      break;
    }

    case 'AUTO_SOLVE_TURNSTILE': {
      if (settings.enabled && settings.autoSolve && settings.solve_turnstile !== false) {
        solveTurnstile(tabId, 'page-trigger');
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: 'disabled' });
      }
      break;
    }

    case 'TURNSTILE_RESET': {
      const t = info(tabId);
      if (t.provider && t.provider !== 'turnstile' && t.provider !== 'none') {
        sendResponse({ ok: false, reason: 'tab provider is ' + t.provider });
        break;
      }
      t.provider = 'turnstile';
      t.version = 'turnstile';
      activeTurnstileSolves.delete(tabId);
      setStatus(tabId, 'working', 'Turnstile reset detected — re-solving...', 0);
      ccLog(tabId, 'TURNSTILE_RESET: captcha reset on tab (' + (msg.reason || 'reset') + ') — re-arming solver');
      if (settings.enabled && settings.autoSolve && settings.solve_turnstile !== false) {
        setTimeout(() => {
          solveTurnstile(tabId, 'reset-re-solve');
        }, 400);
      }
      sendResponse({ ok: true });
      break;
    }

    case 'RECAPTCHA_RESET': {
      const targetTabId = tabId || sender?.tab?.id;
      if (targetTabId) {
        const t = info(targetTabId);
        if (t.provider && t.provider !== 'recaptcha' && t.provider !== 'none') {
          sendResponse({ ok: false, reason: 'tab provider is ' + t.provider });
          break;
        }
        t.status = 'working';
        t.message = 'reCAPTCHA expired — refreshing...';
        setStatus(targetTabId, 'working', 'reCAPTCHA challenge expired — refreshing...', 0);
        ccLog(targetTabId, 'RECAPTCHA_RESET: expired challenge detected (' + (msg.reason || 'expired') + ') — resetting');
        chrome.tabs.sendMessage(targetTabId, { type: 'RECAPTCHA_RESET' }, { frameId: 0 }, () => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'GEETEST_RESET': {
      const targetTabId = tabId || sender?.tab?.id;
      if (targetTabId) {
        const t = info(targetTabId);
        t.provider = 'geetest';
        t.version = 'geetest';
        setStatus(targetTabId, 'working', 'GeeTest reset detected — re-solving...', 0);
        ccLog(targetTabId, 'GEETEST_RESET: captcha reset on tab (' + (msg.reason || 'reset') + ') — re-arming solver');
        chrome.tabs.sendMessage(targetTabId, { type: 'GEETEST_SOLVE' }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'IS_BFRAME_OPEN': {
      const targetTabId = tabId || sender?.tab?.id;
      if (!targetTabId) {
        sendResponse({ ok: true, open: false });
        break;
      }
      chrome.tabs.sendMessage(targetTabId, { type: 'IS_BFRAME_OPEN' }, { frameId: 0 }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          sendResponse({ ok: true, open: false });
        } else {
          sendResponse({ ok: true, open: !!resp.open });
        }
      });
      return true;
    }

    case 'AUTO_CLICK': {
      const t = info(tabId);
      if (!settings.enabled || !settings.autoClick) {
        ccLog(tabId, 'AUTO_CLICK skipped: enabled=' + settings.enabled + ' autoClick=' + settings.autoClick);
        sendResponse({ ok: false, disabled: true });
        break;
      }
      if (settings.provider === 'custom' && !settings.customEndpoint) {
        setStatus(tabId, 'failed', 'Custom STT selected but endpoint is empty.');
        ccLog(tabId, 'AUTO_CLICK blocked: no STT provider usable');
        sendResponse({ ok: false, error: 'no stt' });
        break;
      }
      setStatus(tabId, 'working', 'Captcha detected — auto-clicking checkbox', 0);
      ccLog(tabId, 'AUTO_CLICK: locating anchor frame...');
      relayClickToAnchor(tabId, 'auto');
      sendResponse({ ok: true });
      break;
    }

    case 'AUDIO_B64': {
      transcribeAudio(tabId, msg.b64, msg.mime)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => {
          setStatus(tabId, 'stt_error', 'STT error: ' + (e.message || e));
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'STATUS': {
      setStatus(tabId, msg.status, msg.message, msg.attempt);
      sendResponse({ ok: true });
      break;
    }

    case 'GET_V3_TOKEN': {
      harvestV3Token(msg.tabId, msg.sitekey, msg.action)
        .then((token) => sendResponse({ ok: true, token }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }

    case 'READ_TOKEN': {
      chrome.tabs.sendMessage(msg.tabId, { type: 'READ_TOKEN' }, { frameId: 0 }, (resp) => {
        sendResponse(resp || { ok: false, error: 'no token found on page' });
      });
      return true;
    }

    case 'ARM_RELAY': {
      // arm bframe solver
      armBframe(tabId).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'CHECK_SOLVED':
    case 'CHECK_ANCHOR':
    case 'POLL_ANCHOR': {
      const t = info(tabId);
      const targetTab = t.tabId;
      checkSolved(targetTab).then((solved) => sendResponse({ ok: true, checked: solved, solved }));
      return true;
    }

    case 'VISION_SOLVE': {
      solveVisionChallenge(tabId, msg)
        .then((result) => sendResponse({ ok: true, tiles: result.tiles, raw: result.raw, durationMs: result.durationMs }))
        .catch((e) => {
          ccLog(tabId, 'VISION: solve failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'SOLVE_FUNCAPTCHA_VISION': {
      if (!settings.enabled || settings.solve_funcaptcha === false) {
        sendResponse({ ok: false, error: 'FunCAPTCHA solver is disabled' });
        return true;
      }
      runDeduplicatedSolver(tabId, 'vision', () => solveFunCaptchaVision(tabId, msg))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => {
          ccLog(tabId, 'FUNCAPTCHA: vision failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'SOLVE_FUNCAPTCHA_TILES': {
      if (!settings.enabled || settings.solve_funcaptcha === false) {
        sendResponse({ ok: false, error: 'FunCAPTCHA solver is disabled' });
        return true;
      }
      runDeduplicatedSolver(tabId, 'tiles', () => solveFunCaptchaTiles(tabId, msg))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => {
          ccLog(tabId, 'FUNCAPTCHA-TILE: solver failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'TEXT_CAPTCHA_VISION': {
      if (!settings.enabled || settings.solve_textcaptcha === false) {
        sendResponse({ ok: false, error: 'Text CAPTCHA solver is disabled' });
        return true;
      }
      solveTextImage(tabId, msg.b64, msg.mime)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => {
          ccLog(tabId, 'TEXT_CAPTCHA: vision failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'TEXT_CAPTCHA_CHAT': {
      if (!settings.enabled || settings.solve_textcaptcha === false) {
        sendResponse({ ok: false, error: 'Text CAPTCHA solver is disabled' });
        return true;
      }
      solveTextQuestion(tabId, msg.question)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => {
          ccLog(tabId, 'TEXT_CAPTCHA: chat failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'CAPTURE_ELEMENT_RECT': {
      const targetTab = sender.tab || (tabId != null ? { id: tabId } : null);
      captureElementRect(targetTab, msg.rect)
        .then((b64) => sendResponse({ ok: true, b64, mime: 'image/png' }))
        .catch((e) => {
          ccLog(tabId, 'CAPTURE_ELEMENT_RECT failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'GEETEST_VISION_SOLVE': {
      if (!settings.enabled || settings.solve_geetest === false) {
        sendResponse({ ok: false, error: 'GeeTest solver is disabled' });
        return true;
      }
      solveGeeTestVision(tabId, msg.b64, msg.mime)
        .then((x) => sendResponse({ ok: true, x }))
        .catch((e) => {
          ccLog(tabId, 'GEETEST_VISION: failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'GEETEST_CALCULATE_GAP': {
      if (!settings.enabled || settings.solve_geetest === false) {
        sendResponse({ ok: false, error: 'GeeTest solver is disabled' });
        return true;
      }
      calculateGeeTestGap(tabId, msg)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((e) => {
          ccLog(tabId, 'GEETEST_GAP: failed: ' + (e.message || e), 'error');
          sendResponse({ ok: false, error: String(e.message || e) });
        });
      return true;
    }

    case 'RESET_STATS': {
      settings.solvedCount = 0;
      chrome.storage.sync.set({ solvedCount: 0 });
      sendResponse({ ok: true });
      break;
    }
  }
  return false;
});

function safeSettings() {
  return {
    ...settings,
    apiKey: settings.apiKey ? '***' : '',
    visionApiKey: settings.visionApiKey ? '***' : ''
  };
}

async function armBframe(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (!frames) return;
    for (const f of frames) {
      if (/\/api2\/bframe|\/enterprise\/bframe/.test(f.url)) {
        chrome.tabs.sendMessage(tabId, { type: 'ARM_CHALLENGE' }, { frameId: f.frameId }, () => {});
        ccLog(tabId, 'ARM_RELAY: armed bframe frameId=' + f.frameId);
      }
    }
  } catch {}
}

async function checkAnchor(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (!frames) return false;
    const anchorFrame = frames.find((f) => /\/api2\/anchor|\/enterprise\/anchor/.test(f.url));
    if (!anchorFrame) return false;
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'IS_CHECKED' }, { frameId: anchorFrame.frameId }).catch(() => null);
    return !!(resp && resp.checked);
  } catch {
    return false;
  }
}

async function checkSolved(tabId) {
  try {
    // check anchor checkbox
    const anchorChecked = await checkAnchor(tabId);
    if (anchorChecked) return true;

    // check response token
    const tokenResp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'READ_TOKEN' }, { frameId: 0 }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) resolve(null);
        else resolve(resp.token);
      });
    });
    if (tokenResp && typeof tokenResp === 'string' && tokenResp.length > 20) {
      return true;
    }
  } catch {}
  return false;
}

async function dispatchCdpClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    if (!String(err.message).includes('already attached')) {
      ccLog(tabId, 'CDP attach note: ' + (err.message || err), 'warn');
      return false;
    }
  }
  try {
    // move pointer approach
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x - 25 - Math.random() * 20),
      y: Math.round(y - 15 - Math.random() * 15)
    });
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));

    // move pointer target
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y)
    });
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 60));

    // dispatch mouse down
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_CLICK_ANIM', x: Math.round(x), y: Math.round(y) }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      x: Math.round(x),
      y: Math.round(y),
      clickCount: 1
    });
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 50));

    // dispatch mouse up
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      x: Math.round(x),
      y: Math.round(y),
      clickCount: 1
    });

    await new Promise((r) => setTimeout(r, 50));
    return true;
  } catch (err) {
    ccLog(tabId, 'CDP dispatchMouseEvent error: ' + (err.message || err), 'warn');
    return false;
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

const activeTurnstileSolves = new Set();

async function solveTurnstile(tabId, source = 'auto') {
  if (activeTurnstileSolves.has(tabId)) {
    ccLog(tabId, 'TURNSTILE[' + source + ']: solver already running for tab ' + tabId + ' — ignoring duplicate trigger');
    return;
  }
  activeTurnstileSolves.add(tabId);

  try {
    setStatus(tabId, 'working', 'Cloudflare Turnstile detected — preparing solver...', 1);
    ccLog(tabId, 'TURNSTILE[' + source + ']: starting Turnstile solving sequence...');

    // inject turnstile script
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/turnstile.js']
      });
    } catch (err) {
      // ignore injection error
    }

    // pre click pause
    const initDelay = 1200 + Math.floor(Math.random() * 800);
    ccLog(tabId, 'TURNSTILE: waiting ' + initDelay + 'ms for challenge script initialization...');
    await new Promise((r) => setTimeout(r, initDelay));

    // check solved state
    const preCheck = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_TURNSTILE_SOLVED' }, { frameId: 0 }).catch(() => null);
    if (preCheck && preCheck.solved) {
      setStatus(tabId, 'success', 'Cloudflare Turnstile verified successfully!');
      ccLog(tabId, 'TURNSTILE: challenge already verified with valid token!');
      settings.solvedCount = (settings.solvedCount || 0) + 1;
      chrome.storage.sync.set({ solvedCount: settings.solvedCount });
      return;
    }

    // execute click attempts
    for (let attempt = 1; attempt <= 3; attempt++) {
      setStatus(tabId, 'working', 'Clicking Turnstile verification checkbox (attempt ' + attempt + '/3)...', attempt);
      ccLog(tabId, 'TURNSTILE: locating widget coordinates (attempt ' + attempt + ')...');

      // request viewport coordinates
      const coords = await chrome.tabs.sendMessage(tabId, { type: 'GET_TURNSTILE_COORDS' }, { frameId: 0 }).catch(() => null);

      let clickedCdp = false;
      if (coords && coords.ok && coords.x > 0 && coords.y > 0) {
        // apply coordinate jitter
        const offsetX = attempt === 2 ? 4 : (attempt === 3 ? -3 : 0);
        const offsetY = attempt === 3 ? 2 : 0;
        const targetX = coords.x + offsetX;
        const targetY = coords.y + offsetY;

        ccLog(tabId, 'TURNSTILE: acquired widget coords (' + targetX + ', ' + targetY + ') — dispatching native CDP hardware click...');
        clickedCdp = await dispatchCdpClick(tabId, targetX, targetY);
        if (clickedCdp) {
          ccLog(tabId, 'TURNSTILE: native CDP click successfully dispatched');
        }
      } else {
        ccLog(tabId, 'TURNSTILE: coordinates unavailable from main page (' + ((coords && coords.error) || 'no coords') + ')', 'warn');
      }

      // broadcast trigger message
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
      if (frames) {
        for (const f of frames) {
          if (/cloudflare\.com/.test(f.url)) {
            chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_TURNSTILE' }, { frameId: f.frameId }).catch(() => {});
          }
        }
      }

      // monitor token generation
      ccLog(tabId, 'TURNSTILE: click dispatched, monitoring response token...');
      let passed = false;
      for (let poll = 0; poll < 15; poll++) {
        await new Promise((r) => setTimeout(r, 400));
        const statusResp = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_TURNSTILE_SOLVED' }, { frameId: 0 }).catch(() => null);
        if (statusResp && statusResp.solved) {
          passed = true;
          setStatus(tabId, 'success', 'Cloudflare Turnstile verified successfully!');
          ccLog(tabId, 'TURNSTILE: success! Token captured: ' + (statusResp.token ? statusResp.token.slice(0, 16) + '...' : 'valid'));
          settings.solvedCount = (settings.solvedCount || 0) + 1;
          chrome.storage.sync.set({ solvedCount: settings.solvedCount });
          return;
        }
      }

      if (!passed && attempt < 3) {
        ccLog(tabId, 'TURNSTILE: attempt ' + attempt + ' timed out without token, retrying...');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    setStatus(tabId, 'failed', 'Turnstile verification timed out or required manual interaction');
    ccLog(tabId, 'TURNSTILE: solver completed without verified token', 'warn');
  } catch (err) {
    setStatus(tabId, 'failed', 'Turnstile error: ' + (err.message || err));
    ccLog(tabId, 'TURNSTILE error: ' + (err.message || err), 'error');
  } finally {
    activeTurnstileSolves.delete(tabId);
  }
}

async function relayClickToAnchor(tabId, source) {
  // wait for anchor ready
  const MAX_FRAME_WAIT_MS = 3000;
  const FRAME_POLL_MS = 300;
  const MSG_RETRY = 8;
  const MSG_RETRY_DELAY = 400;

  try {
    // find anchor frame
    let anchorFrames = [];
    const deadline = Date.now() + MAX_FRAME_WAIT_MS;
    while (Date.now() < deadline) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
      if (!frames) {
        ccLog(tabId, 'relay[' + source + ']: getAllFrames failed — retrying...');
        await new Promise((r) => setTimeout(r, FRAME_POLL_MS));
        continue;
      }
      ccLog(tabId, 'relay[' + source + ']: frames: ' + frames.map((f) => f.url.slice(0, 60)).join(' | '));
      anchorFrames = frames.filter((f) => /\/api2\/anchor|\/enterprise\/anchor/.test(f.url));
      if (anchorFrames.length) break;
      await new Promise((r) => setTimeout(r, FRAME_POLL_MS));
    }

    if (!anchorFrames.length) {
      ccLog(tabId, 'relay[' + source + ']: NO anchor frame found after ' + MAX_FRAME_WAIT_MS + 'ms');
      setStatus(tabId, 'failed', 'Checkbox iframe not found — reload the page (extension must load BEFORE the page).');
      return;
    }

    // cdp hardware click
    try {
      const coords = await chrome.tabs.sendMessage(tabId, { type: 'GET_RECAPTCHA_COORDS' }, { frameId: 0 }).catch(() => null);
      if (coords && coords.ok && coords.x > 0 && coords.y > 0) {
        ccLog(tabId, 'relay[' + source + ']: acquired anchor coords (' + coords.x + ', ' + coords.y + ') — dispatching native CDP click...');
        await dispatchCdpClick(tabId, coords.x, coords.y);
      }
    } catch {}

    // dispatch click command
    for (const af of anchorFrames) {
      let delivered = false;
      for (let attempt = 0; attempt < MSG_RETRY; attempt++) {
        const resp = await chrome.tabs.sendMessage(
          tabId, { type: 'CLICK_AND_SOLVE' }, { frameId: af.frameId }
        ).catch(() => null);

        if (resp && resp.ok) {
          ccLog(tabId, 'relay[' + source + ']: CLICK_AND_SOLVE delivered to frameId=' + af.frameId + ' (attempt ' + (attempt + 1) + ')');
          delivered = true;
          break;
        }
        ccLog(tabId, 'relay[' + source + ']: attempt ' + (attempt + 1) + ' — no ack from frameId=' + af.frameId + ', retrying in ' + MSG_RETRY_DELAY + 'ms');
        await new Promise((r) => setTimeout(r, MSG_RETRY_DELAY));
      }
      if (!delivered) {
        ccLog(tabId, 'relay[' + source + ']: msg delivery failed — using scripting.executeScript fallback for frameId=' + af.frameId);
        // fallback dom injection
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [af.frameId] },
            world: 'MAIN',
            func: () => {
              const SELS = [
                '#recaptcha-anchor',
                '.recaptcha-checkbox-border',
                '.recaptcha-checkbox',
                '[role="checkbox"]',
                '.rc-anchor-center-item'
              ];
              for (const sel of SELS) {
                const el = document.querySelector(sel);
                if (el) {
                  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return { clicked: true, sel };
                }
              }
              return { clicked: false, html: document.documentElement.innerHTML.slice(0, 400) };
            }
          }).catch(() => null);

          const r = results && results[0] && results[0].result;
          if (r && r.clicked) {
            ccLog(tabId, 'relay[' + source + ']: scripting fallback clicked: ' + r.sel);
          } else {
            ccLog(tabId, 'relay[' + source + ']: scripting fallback found nothing: ' + JSON.stringify(r), 'error');
          }
        } catch (se) {
          ccLog(tabId, 'relay[' + source + ']: scripting fallback exception: ' + (se.message || se), 'error');
        }
      }
    }
  } catch (e) {
    ccLog(tabId, 'relay[' + source + '] exception: ' + (e.message || e));
  }
}

async function transcribeAudio(tabId, b64, mime) {
  const bytes = b64ToBytes(b64);

  const engines = [
    { engine: 'puter', label: 'puter' }
  ];
  const errors = [];

  for (const e of engines) {
    try {
      ccLog(tabId, 'STT: trying ' + e.label);
      const result = await sandboxTranscribe(e.engine, bytes, mime);
      if (result.ok) {
        const digits = normalizeDigits(result.text);
        if (digits) {
          ccLog(tabId, 'STT: ' + e.label + ' says "' + result.text + '"');
          return digits;
        }
        errors.push(e.label + ': no digits in "' + String(result.text).slice(0, 40) + '"');
        ccLog(tabId, 'STT: ' + e.label + ' no digits, next engine', 'error');
      } else {
        errors.push(e.label + ': ' + result.error);
        ccLog(tabId, 'STT: ' + e.label + ' failed (' + result.error + ')', 'error');
      }
    } catch (err) {
      errors.push(e.label + ': ' + (err.message || err));
      ccLog(tabId, 'STT: ' + e.label + ' exception: ' + (err.message || err), 'error');
    }
  }

  const chain = buildProviderChain(settings.provider);
  for (const provider of chain) {
    try {
      ccLog(tabId, 'STT: trying cloud provider "' + provider + '"');
      const text = await transcribe({
        provider,
        apiKey: settings.apiKey,
        model: settings.model,
        watsonUrl: settings.watsonUrl,
        customEndpoint: settings.customEndpoint,
        bytes,
        mime: mime || 'audio/wav'
      });
      const digits = normalizeDigits(text);
      if (!digits) {
        errors.push(provider + ': no digits in "' + String(text).slice(0, 40) + '"');
        continue;
      }
      ccLog(tabId, 'STT: cloud "' + provider + '" says "' + text + '"');
      return digits;
    } catch (err) {
      errors.push(provider + ': ' + String(err.message || err).slice(0, 120));
      ccLog(tabId, 'STT [' + provider + '] failed: ' + String(err.message || err).slice(0, 120), 'error');
    }
  }
  throw new Error('All STT engines failed — ' + errors.join(' | '));
}

let offscreenCreating = null;

async function ensureOffscreen() {
  const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
  if (hasDoc) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen/offscreen.html'),
      reasons: ['IFRAME_SCRIPTING', 'USER_MEDIA'],
      justification: 'Hosts sandboxed STT and tab video recording'
    }).catch((e) => {
      offscreenCreating = null;
      throw e;
    });
  }
  await offscreenCreating;
  await new Promise((r) => setTimeout(r, 800));
}

function sandboxTranscribe(engine, bytes, mime) {
  return new Promise(async (resolve) => {
    try {
      await ensureOffscreen();
    } catch (e) {
      resolve({ ok: false, error: 'offscreen create failed: ' + (e.message || e) });
      return;
    }

    // serialize audio bytes
    const audioBytes = {};
    if (bytes) { for (let i = 0; i < bytes.length; i++) audioBytes[i] = bytes[i]; }

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false, error: 'sandbox engine timeout (90s)' }); }
    }, 90000);
    try {
      chrome.runtime.sendMessage(
        { type: 'SB_TRANSCRIBE', engine, audioBytes, mime: mime || 'audio/wav' },
        (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: 'no response from offscreen relay' });
        }
      );
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}


function buildProviderChain(primary) {
  // stt provider chain
  const freeProviders = ['google', 'google2', 'wit-free'];
  const keyedProviders = [
    { id: 'openai',  needs: () => !!settings.apiKey },
    { id: 'wit',     needs: () => !!settings.apiKey },
    { id: 'watson',  needs: () => !!settings.apiKey && !!settings.watsonUrl },
    { id: 'custom',  needs: () => !!settings.customEndpoint }
  ];

  const chain = [primary];
  for (const p of freeProviders) {
    if (p !== primary) chain.push(p);
  }
  for (const { id, needs } of keyedProviders) {
    if (id !== primary && needs()) chain.push(id);
  }
  return chain;
}

function normalizeDigits(text) {
  if (!text) return '';
  const words = {
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    oh: '0', o: '0', for: '4', to: '2', too: '2', ate: '8'
  };
  let s = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  s = s.split(/\s+/).map((w) => (words[w] !== undefined ? words[w] : w)).join('');
  const digits = s.replace(/\D/g, '');
  // return recognized text
  return digits || String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function harvestV3Token(tabId, sitekey, action) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    func: (sk, act) => {
      return new Promise((resolve) => {
        let resolvedKey = sk;
        if (!resolvedKey) {
          const el = document.querySelector('[data-sitekey]');
          if (el) resolvedKey = el.dataset.sitekey;
        }
        if (!resolvedKey) {
          for (const s of document.querySelectorAll('script[src*="recaptcha/api.js"]')) {
            const m = s.src.match(/render=([A-Za-z0-9_-]{20,})/);
            if (m) { resolvedKey = m[1]; break; }
          }
        }
        if (!resolvedKey) return resolve({ error: 'No sitekey found on page' });

        let waited = 0;
        const poll = () => {
          if (window.grecaptcha && window.grecaptcha.ready) {
            window.grecaptcha.ready(() => {
              window.grecaptcha.execute(resolvedKey, { action: act || 'submit' })
                .then((token) => {
                  const ta = document.querySelector('.g-recaptcha-response');
                  if (ta) ta.value = token;
                  resolve({ token });
                })
                .catch((e) => resolve({ error: String(e) }));
            });
          } else if (waited < 10000) {
            waited += 250;
            setTimeout(poll, 250);
          } else {
            resolve({ error: 'grecaptcha never loaded (10s timeout)' });
          }
        };
        poll();
      });
    },
    args: [sitekey, action]
  });

  const r = results && results[0] ? results[0].result : null;
  if (!r) throw new Error('Injection returned nothing');
  if (r.error) throw new Error(r.error);
  return r.token;
}

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const t = info(tabId);
    t.status = 'idle';
    t.message = 'idle';
    t.attempt = 0;
    t.version = null;
    t.sitekey = null;
    updateBadge(tabId, '', '#00000000');
  }
});

async function solveVisionChallenge(tabId, { imageB64, prompt, targetObject, totalTiles, rows, cols }) {
  const apiKey = settings.visionApiKey || settings.apiKey || '';
  const baseUrl = (settings.visionBaseUrl || 'https://api.xkiro.com/v1').replace(/\/+$/, '');
  const model = settings.visionModel || 'qwen/qwen3.8-omni-flash:free';
  const target = (targetObject || prompt || '').trim();
  const r = rows || (totalTiles === 16 ? 4 : 3);
  const c = cols || (totalTiles === 16 ? 4 : 3);

  ccLog(
    tabId,
    'VISION: calling ' + model + ' (grid ' + r + 'x' + c + '=' + totalTiles + ') target="' + target + '"'
  );

  const gridDescription =
    totalTiles === 9
      ? 'Row 1 (Top): [1] Top-Left, [2] Top-Center, [3] Top-Right\n' +
        'Row 2 (Middle): [4] Middle-Left, [5] Center, [6] Middle-Right\n' +
        'Row 3 (Bottom): [7] Bottom-Left, [8] Bottom-Center, [9] Bottom-Right'
      : 'Numbered 1 to ' + totalTiles + ' in reading order (row by row from top-left to bottom-right).';

  const systemPrompt =
    'You are an expert visual CAPTCHA solver specialized in Google reCAPTCHA v2.\n' +
    'You are given a high-resolution CAPTCHA image with ' + totalTiles + ' numbered tiles.\n' +
    'Each tile has a small badge in its top-left corner showing its number (1 to ' + totalTiles + ').\n\n' +
    'Grid layout:\n' + gridDescription + '\n\n' +
    'Target object to detect: "' + target + '"\n\n' +
    'CRITICAL RECAPTCHA DETECTION RULES:\n' +
    '1. Inspect EVERY tile from 1 to ' + totalTiles + ' with extreme scrutiny.\n' +
    '2. You MUST include ALL tiles containing ANY part or instance of "' + target + '".\n' +
    '3. Look closely for:\n' +
    '   - Objects in the background, distance, or street corners\n' +
    '   - Objects mounted on poles, posts, wires, or overhead arms/cantilevers (e.g. traffic signals, cameras, signs)\n' +
    '   - Partially visible or cropped objects\n' +
    '   - Horizontal, vertical, or pedestrian signals\n' +
    '4. Do NOT exclude a tile just because the object is small, distant, or off-center.\n' +
    '5. Do NOT include tiles that only have cars, roads, buildings, or trees without any "' + target + '".\n' +
    '6. Return ONLY a valid JSON array of matching numbers, e.g. [5, 7, 8, 9].\n' +
    '7. If no tiles contain "' + target + '", return [].\n' +
    '8. Absolutely NO markdown, backticks, reasoning, or commentary. ONLY the JSON array.';

  const userContent = [
    {
      type: 'text',
      text:
        'Target: "' + target + '"\n' +
        'Instruction: "' + prompt.trim() + '"\n' +
        'Inspect all ' + totalTiles + ' tiles carefully for "' + target + '" (include small, distant, or pole-mounted instances).\n' +
        'Return ONLY the JSON array of matching tile numbers.'
    },
    {
      type: 'image_url',
      image_url: {
        url: 'data:image/jpeg;base64,' + imageB64
      }
    }
  ];

  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
    headers['x-api-key'] = apiKey;
  }

  const endpoint = baseUrl + '/chat/completions';
  const startTime = Date.now();
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(18000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.05,
        max_tokens: 100
      })
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Vision API timed out after ' + elapsed + 'ms (limit: 18s)');
    }
    throw new Error('Vision API fetch failed (' + elapsed + 'ms): ' + (err.message || err));
  }

  const durationMs = Date.now() - startTime;
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('xKiro API HTTP ' + resp.status + ' (' + durationMs + 'ms): ' + errText.slice(0, 200));
  }

  const data = await resp.json();
  const rawReply =
    data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!rawReply) throw new Error('Empty response from vision model (' + durationMs + 'ms)');

  ccLog(tabId, 'VISION: reply (' + durationMs + 'ms): ' + rawReply.trim());
  const tiles = parseTileAnswer(rawReply, totalTiles);
  ccLog(tabId, 'VISION: parsed matching tiles: ' + JSON.stringify(tiles));

  return { tiles, raw: rawReply, durationMs };
}

async function solveFunCaptchaVision(tabId, msg) {
  const { prompt, imageB64, candidateCount, targetB64, batchB64s, tileB64s, challengeType } = msg;
  const apiKey = settings.visionApiKey || settings.apiKey || '';
  const baseUrl = (settings.visionBaseUrl || 'https://api.xkiro.com/v1').replace(/\/+$/, '');

  // vision model chains
  const primaryModel = settings.visionModel || 'qwen/qwen3.8-omni-flash:free';
  const fallbackModel = 'qwen/qwen3.8-max:free';
  const rotPrimaryModel = (settings.rotationModel || primaryModel);
  const rotFallbackModel = 'qwen/qwen3-vl-plus:free';
  const total = candidateCount || 8;

  ccLog(tabId, 'FUNCAPTCHA: ★ Solver engine — "' + (prompt || '').slice(0, 60) + '" [' + total + ' tiles] batches=' + (batchB64s ? batchB64s.length : 0));

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) { headers['Authorization'] = 'Bearer ' + apiKey; headers['x-api-key'] = apiKey; }
  const endpoint = baseUrl + '/chat/completions';

  const toDataUrl = (b64) => (b64 && b64.startsWith('data:') ? b64 : ('data:image/jpeg;base64,' + (b64 || '')));

  // http api helpers
  async function postChat(payload, timeoutMs = 25000) {
    const candidateModels = [payload.model || primaryModel];
    if (fallbackModel && !candidateModels.includes(fallbackModel)) {
      candidateModels.push(fallbackModel);
    }

    let lastResp = null;
    let lastErr = null;

    for (const m of candidateModels) {
      payload.model = m;
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify(payload)
        });

        if (resp.ok) {
          return resp;
        }

        const clone = resp.clone();
        const txt = await clone.text().catch(() => '');
        ccLog(tabId, `FUNCAPTCHA: API HTTP ${resp.status} on ${m}: ${txt.slice(0, 100)}`, 'warn');

        // check client error
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429 && !txt.includes('safety policy')) {
          return resp;
        }

        lastResp = resp;
      } catch (err) {
        ccLog(tabId, `FUNCAPTCHA: fetch error on ${m}: ${err.message || err}`, 'warn');
        lastErr = err;
      }
    }

    if (lastResp) return lastResp;
    throw lastErr || new Error('All vision model endpoints failed');
  }

  async function chatReply(payload, timeoutMs = 25000) {
    const resp = await postChat(payload, timeoutMs);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('API HTTP ' + resp.status + ': ' + txt.slice(0, 120));
    }
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  // challenge type detection
  const promptLower = (prompt || '').toLowerCase();
  const typeLower = String(challengeType || '').toLowerCase();
  const isRotateChallenge =
    typeLower === 'rotate' ||
    /rotat|orient|direction|facing|degree|angle|tilt|kulma|suunta|rotation/.test(promptLower);

  // parse object prompt
  const objMatch = (prompt || '').match(/number of ([a-zA-Z]+)/i) ||
    (prompt || '').match(/count ([a-zA-Z]+)/i) ||
    (prompt || '').match(/select \w+ ([a-zA-Z]+)/i);
  const objName = objMatch ? objMatch[1].toLowerCase() : null;

  // rotation challenge solver — 12-hour clock dial + master comparison sheet
  if (isRotateChallenge && batchB64s && batchB64s.length > 0) {
    ccLog(tabId, 'FUNCAPTCHA: ROT 12-hour clock-dial solver — ' + total + ' candidates');
    const rStart = Date.now();

    // robust regex + JSON parser for winning index
    function extractWinningIndex(text, maxCandidates) {
      if (!text) return null;
      const str = String(text);

      const patterns = [
        /WINNING_INDEX\s*[:=]\s*(\d+)/i,
        /"winningIndex"\s*:\s*(\d+)/i,
        /winningIndex"?\s*[:=]\s*(\d+)/i,
        /"winner"\s*:\s*(\d+)/i,
        /winner\s*[:=]\s*\[?(\d+)\]?/i,
        /winning\s*(tile|candidate)\s*[:=]?\s*\[?(\d+)\]?/i,
        /tile\s*\[?(\d+)\]?\s*(is the (best )?match|is the winner|matches|faces the same)/i,
        /candidate\s*\[?(\d+)\]?\s*(is the (best )?match|is the winner|matches)/i
      ];

      for (const re of patterns) {
        const m = str.match(re);
        if (m) {
          for (let i = 1; i < m.length; i++) {
            const val = parseInt(m[i], 10);
            if (!isNaN(val) && val >= 1 && val <= maxCandidates) return val;
          }
        }
      }

      // try outer-most balanced JSON
      const first = str.indexOf('{');
      const last = str.lastIndexOf('}');
      if (first !== -1 && last > first) {
        try {
          const p = JSON.parse(str.slice(first, last + 1));
          const val = parseInt(p.winningIndex || p.winning_index || p.winner || p.index, 10);
          if (!isNaN(val) && val >= 1 && val <= maxCandidates) return val;
        } catch {}
      }

      // fallback: bracketed number e.g. [2]
      const bracketM = str.match(/\[([1-9])\]/);
      if (bracketM) {
        const val = parseInt(bracketM[1], 10);
        if (!isNaN(val) && val >= 1 && val <= maxCandidates) return val;
      }

      return null;
    }

    function extractConfidence(text) {
      if (!text) return 70;
      const m = String(text).match(/"confidence"\s*:\s*(\d+)/i) ||
                String(text).match(/confidence"?\s*[:=]\s*(\d+)/i);
      if (m) {
        const c = parseInt(m[1], 10);
        if (!isNaN(c) && c >= 0 && c <= 100) return c;
      }
      return 75;
    }

    // base64 to ImageBitmap for OffscreenCanvas
    async function b64ToBitmap(b64str) {
      const raw = atob(b64str);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      const blob = new Blob([arr], { type: 'image/jpeg' });
      return createImageBitmap(blob);
    }

    // helper: convert canvas to base64 jpeg
    async function canvasToB64(canvas, quality = 0.90) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    // draw precise 12-hour clock dial onto any canvas 2d context
    function drawClockDial(ctx, cx, cy, radius, isTarget = false) {
      const outerR = radius;
      const innerR = radius * 0.76;
      const labelR = radius * 0.88;

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      for (let h = 1; h <= 12; h++) {
        const deg = (h * 30) - 90;
        const rad = deg * Math.PI / 180;
        const isCardinal = (h === 12 || h === 3 || h === 6 || h === 9);

        const rStartTick = isCardinal ? innerR * 0.7 : innerR;
        ctx.beginPath();
        ctx.moveTo(cx + rStartTick * Math.cos(rad), cy + rStartTick * Math.sin(rad));
        ctx.lineTo(cx + outerR * Math.cos(rad), cy + outerR * Math.sin(rad));
        ctx.strokeStyle = isCardinal ? 'rgba(56, 189, 248, 0.95)' : 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = isCardinal ? 2.5 : 1.2;
        ctx.stroke();

        const lx = cx + labelR * Math.cos(rad);
        const ly = cy + labelR * Math.sin(rad);

        ctx.beginPath();
        ctx.arc(lx, ly, isCardinal ? 16 : 13, 0, Math.PI * 2);
        ctx.fillStyle = isCardinal ? 'rgba(15, 23, 42, 0.95)' : 'rgba(0, 0, 0, 0.75)';
        ctx.fill();
        ctx.strokeStyle = isCardinal ? '#38bdf8' : 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = isCardinal ? 2 : 1;
        ctx.stroke();

        ctx.fillStyle = isCardinal ? '#38bdf8' : '#ffffff';
        ctx.font = isCardinal ? 'bold 15px sans-serif' : 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(h), lx, ly);
      }

      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText('UP', cx, cy - outerR - 10);
      ctx.fillText('RIGHT', cx + outerR + 24, cy);
      ctx.fillText('DOWN', cx, cy + outerR + 10);
      ctx.fillText('LEFT', cx - outerR - 22, cy);

      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = isTarget ? '#f59e0b' : '#38bdf8';
      ctx.fill();
    }

    // annotate single image with clock dial
    async function annotateImageWithClock(b64, badgeText, isTarget = false) {
      const bmp = await b64ToBitmap(b64);
      const size = 460;
      const oc = new OffscreenCanvas(size, size);
      const ctx = oc.getContext('2d');

      ctx.fillStyle = '#0a0f1d';
      ctx.fillRect(0, 0, size, size);

      const scale = Math.min((size - 70) / bmp.width, (size - 70) / bmp.height);
      const dw = Math.round(bmp.width * scale);
      const dh = Math.round(bmp.height * scale);
      ctx.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);

      drawClockDial(ctx, size / 2, size / 2, (size - 70) / 2, isTarget);

      ctx.fillStyle = isTarget ? 'rgba(245, 158, 11, 0.9)' : 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(10, 8, isTarget ? 170 : 130, 28);
      ctx.strokeStyle = isTarget ? '#fbbf24' : '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(10, 8, isTarget ? 170 : 130, 28);

      ctx.fillStyle = isTarget ? '#ffffff' : '#38bdf8';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, 18, 22);

      return canvasToB64(oc, 0.92);
    }

    // create Master Comparison Board: Hand + All Candidates in ONE visual frame
    async function buildMasterComparisonBoard(targetB64, candB64s) {
      const numCands = candB64s.length;
      const cols = numCands <= 6 ? 3 : 4;
      const rows = Math.ceil(numCands / cols);

      const targetBoxW = 380;
      const targetBoxH = 380;
      const candTileW = 280;
      const candTileH = 280;
      const headerH = 50;

      const boardW = Math.max(targetBoxW + 40, cols * candTileW + 40);
      const boardH = headerH + targetBoxH + (rows * candTileH) + 60;

      const oc = new OffscreenCanvas(boardW, boardH);
      const ctx = oc.getContext('2d');

      ctx.fillStyle = '#080d1a';
      ctx.fillRect(0, 0, boardW, boardH);

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, boardW, headerH);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ARKOS FUNCAPTCHA: 3D ORIENTATION MASTER COMPARISON SHEET', boardW / 2, 25);

      // Section 1: TARGET HAND
      const handBmp = await b64ToBitmap(targetB64);
      const handX = (boardW - targetBoxW) / 2;
      const handY = headerH + 15;

      ctx.fillStyle = '#111827';
      ctx.fillRect(handX, handY, targetBoxW, targetBoxH);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 3;
      ctx.strokeRect(handX, handY, targetBoxW, targetBoxH);

      const handScale = Math.min((targetBoxW - 60) / handBmp.width, (targetBoxH - 60) / handBmp.height);
      const hdw = Math.round(handBmp.width * handScale);
      const hdh = Math.round(handBmp.height * handScale);
      ctx.drawImage(handBmp, handX + (targetBoxW - hdw) / 2, handY + (targetBoxH - hdh) / 2, hdw, hdh);

      drawClockDial(ctx, handX + targetBoxW / 2, handY + targetBoxH / 2, (targetBoxW - 70) / 2, true);

      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(handX + 8, handY + 8, 220, 30);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('TARGET: HAND DIRECTION', handX + 16, handY + 23);

      // Section 2: CANDIDATE TILES
      const gridStartY = handY + targetBoxH + 30;

      for (let i = 0; i < numCands; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const tx = 20 + c * candTileW;
        const ty = gridStartY + r * candTileH;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(tx + 4, ty + 4, candTileW - 8, candTileH - 8);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tx + 4, ty + 4, candTileW - 8, candTileH - 8);

        if (candB64s[i]) {
          const cBmp = await b64ToBitmap(candB64s[i]);
          const cScale = Math.min((candTileW - 50) / cBmp.width, (candTileH - 50) / cBmp.height);
          const cdw = Math.round(cBmp.width * cScale);
          const cdh = Math.round(cBmp.height * cScale);
          ctx.drawImage(cBmp, tx + (candTileW - cdw) / 2, ty + (candTileH - cdh) / 2, cdw, cdh);
        }

        drawClockDial(ctx, tx + candTileW / 2, ty + candTileH / 2, (candTileW - 60) / 2, false);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
        ctx.fillRect(tx + 8, ty + 8, 120, 26);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.strokeRect(tx + 8, ty + 8, 120, 26);

        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('TILE [' + (i + 1) + ']', tx + 68, ty + 21);
      }

      return canvasToB64(oc, 0.90);
    }

    // universal structural rules for identifying object front vs rear
    const universalRules =
      'CRITICAL RULES FOR IDENTIFYING THE FRONT OF THE 3D OBJECT:\n' +
      '- FORMULA 1 / RACECAR: FRONT has the pointed nose cone and front wing between the front wheels. REAR has the elevated rear spoiler wing.\n' +
      '- SEDAN / CAR / SUV: FRONT has the hood, headlights, and front bumper. Windshield slopes towards the front. REAR has the trunk and red tail lights.\n' +
      '- FORKLIFT: FRONT has the two protruding metal forks. REAR has the engine block and counterweight.\n' +
      '- LAWN MOWER: FRONT is the cutting deck. REAR has the tall push handle.\n' +
      '- TRUCK / VAN: FRONT has the cab, front windshield, and grille. REAR has the cargo doors or flatbed.\n' +
      '- AIRCRAFT / JET: FRONT has the pointed nose cone and cockpit. REAR has the vertical stabilizer tail.\n' +
      '- ANIMAL / PET: FRONT is the head, snout, and face. REAR is the tail.\n' +
      '- The object is FACING the direction its FRONT points on the 12-hour clock dial.';

    // generate clock-dial annotated visuals
    let masterBoardB64 = null;
    let clockHandB64 = null;
    const clockTileB64s = [];

    try {
      clockHandB64 = await annotateImageWithClock(targetB64, 'TARGET: HAND', true);
      const candInputs = (tileB64s && tileB64s.length >= total) ? tileB64s.slice(0, total) : [];

      if (candInputs.length >= total) {
        for (let i = 0; i < total; i++) {
          const ann = await annotateImageWithClock(candInputs[i], 'TILE [' + (i + 1) + ']', false);
          clockTileB64s.push(ann);
        }
        masterBoardB64 = await buildMasterComparisonBoard(targetB64, candInputs);
        ccLog(tabId, 'FUNCAPTCHA: ROT Master Comparison Board generated with ' + total + ' tiles');
      }
    } catch (err) {
      ccLog(tabId, 'FUNCAPTCHA: ROT visual clock generation error: ' + (err.message || err), 'warn');
    }

    // Pass 1: Razor-focused direct identification
    const p1Instructions =
      'Arkose FunCAPTCHA 3D Orientation Puzzle.\n' +
      'Prompt: "' + (prompt || 'Rotate the object to face in the direction of the hand') + '"\n\n' +
      '12-HOUR CLOCK FACE REFERENCE (overlaid on all images):\n' +
      '  12 = UP (↑, 0°)\n' +
      '   3 = RIGHT (→, 90°)\n' +
      '   6 = DOWN (↓, 180°)\n' +
      '   9 = LEFT (←, 270°)\n\n' +
      universalRules + '\n\n' +
      'TASK:\n' +
      '1. TARGET (top): Find the direction the hand fingertips are pointing on the 12-hour clock.\n' +
      '2. CANDIDATES (bottom grid): Find which tile [1] to [' + total + '] has the FRONT of the object pointing in the EXACT SAME direction as the hand.\n\n' +
      'Reply in this exact format:\n' +
      'WINNING_INDEX: <integer 1-' + total + '>\n' +
      '{"winningIndex": <integer 1-' + total + '>, "confidence": <integer 0-100>, "reasoning": "<1 concise sentence>"}';

    const p1Content = [{ type: 'text', text: p1Instructions }];

    if (masterBoardB64) {
      p1Content.push({
        type: 'text',
        text: 'MASTER COMPARISON BOARD (Top = Target Hand, Bottom Grid = Candidate Tiles [1] to [' + total + ']):'
      });
      p1Content.push({ type: 'image_url', image_url: { url: toDataUrl(masterBoardB64) } });
    } else if (clockHandB64 && clockTileB64s.length > 0) {
      p1Content.push({ type: 'text', text: 'TARGET HAND with 12-hour clock overlay:' });
      p1Content.push({ type: 'image_url', image_url: { url: toDataUrl(clockHandB64) } });
      for (let i = 0; i < clockTileB64s.length; i++) {
        p1Content.push({ type: 'text', text: 'Candidate Tile [' + (i + 1) + '] with 12-hour clock overlay:' });
        p1Content.push({ type: 'image_url', image_url: { url: toDataUrl(clockTileB64s[i]) } });
      }
    } else {
      p1Content.push({ type: 'image_url', image_url: { url: toDataUrl(targetB64) } });
      for (const b of batchB64s) p1Content.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });
    }

    let winner = null;
    let winnerConfidence = 0;
    let winnerReasoning = '';

    try {
      const p1Reply = await chatReply({
        model: rotPrimaryModel,
        messages: [
          {
            role: 'system',
            content: 'You are an elite spatial alignment analyst. ' +
              'Your job is to match the direction of the target hand fingertips with the front of the candidate object. ' +
              'Identify the vehicle front: headlights, front wheels, hood, or racecar nose cone. ' +
              'Wrong answers are STRICTLY FORBIDDEN.'
          },
          { role: 'user', content: p1Content }
        ],
        temperature: 0,
        max_tokens: 250
      }, 30000);

      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 reply: ' + String(p1Reply).trim().slice(0, 350));
      const parsedWinner = extractWinningIndex(p1Reply, total);
      if (parsedWinner !== null) {
        winner = parsedWinner;
        winnerConfidence = extractConfidence(p1Reply);
        winnerReasoning = String(p1Reply).trim().slice(0, 150);
        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 parsed winner=[' + winner + '] conf=' + winnerConfidence + '%');
      } else {
        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 could not parse winner', 'warn');
      }
    } catch (e) {
      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 error: ' + (e.message || e), 'warn');
    }

    // Pass 2: Fallback to high-capability model if no winner or confidence < 60%
    if (winner === null || winnerConfidence < 60) {
      ccLog(tabId, 'FUNCAPTCHA: ROT conf=' + winnerConfidence + '% — Pass-2 verification with fallback model');

      const p2Instructions =
        'DEEP SPATIAL VERIFICATION — ARKOSE 3D ROTATION\n\n' +
        universalRules + '\n\n' +
        '1. Look at the TARGET HAND. Which clock hour (1 to 12) do the fingertips point to?\n' +
        '2. Look at each candidate tile [1] to [' + total + ']. Locate the FRONT end (hood/headlights/nose) and find which tile faces the SAME clock hour.\n\n' +
        'Reply immediately with:\n' +
        'WINNING_INDEX: <integer 1-' + total + '>\n' +
        '{"winningIndex": <integer 1-' + total + '>, "confidence": <integer 0-100>}';

      const p2Content = [{ type: 'text', text: p2Instructions }];
      if (masterBoardB64) {
        p2Content.push({ type: 'image_url', image_url: { url: toDataUrl(masterBoardB64) } });
      } else {
        p2Content.push({ type: 'image_url', image_url: { url: toDataUrl(targetB64) } });
        for (const b of batchB64s) p2Content.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });
      }

      try {
        const p2Reply = await chatReply({
          model: rotFallbackModel || fallbackModel || 'qwen/qwen3.8-max:free',
          messages: [
            {
              role: 'system',
              content: 'High-precision computer vision engine. Match hand direction with object front. Reply with WINNING_INDEX and JSON.'
            },
            { role: 'user', content: p2Content }
          ],
          temperature: 0,
          max_tokens: 250
        }, 35000);

        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 reply: ' + String(p2Reply).trim().slice(0, 350));
        const p2Winner = extractWinningIndex(p2Reply, total);
        if (p2Winner !== null) {
          const rDuration = Date.now() - rStart;
          const p2Conf = extractConfidence(p2Reply);
          ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 WIN — tile [' + p2Winner + '] conf=' + p2Conf + '% in ' + rDuration + 'ms');
          return {
            winningIndex: p2Winner,
            raw: String(p2Reply).trim(),
            durationMs: rDuration,
            targetDigit: -1,
            pass: 'rotation-pass2'
          };
        }
      } catch (ce) {
        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 error: ' + (ce.message || ce), 'warn');
      }
    }

    // use Pass-1 result if available
    if (winner !== null) {
      const rDuration = Date.now() - rStart;
      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 WIN — tile [' + winner + '] conf=' + winnerConfidence + '% in ' + rDuration + 'ms');
      return {
        winningIndex: winner,
        raw: JSON.stringify({ winner, winnerConfidence, winnerReasoning }),
        durationMs: rDuration,
        targetDigit: -1,
        pass: 'rotation-clock-direct'
      };
    }

    // Pass 3: Last-resort fallback with raw images
    ccLog(tabId, 'FUNCAPTCHA: ROT all passes failed — raw fallback', 'warn');
    const fbText =
      'Arkose FunCAPTCHA rotation challenge.\n' +
      'IMAGE 1: Target hand.\n' +
      'Remaining images: ' + total + ' rotated candidate views.\n\n' +
      universalRules + '\n\n' +
      'Which tile has the object FRONT facing the SAME direction as the hand?\n' +
      'WINNING_INDEX: <integer 1-' + total + '>\n' +
      '{"winningIndex": <integer 1-' + total + '>}';

    const fbContent = [
      { type: 'text', text: fbText },
      { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
    ];
    for (const b of batchB64s) fbContent.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });

    try {
      const fbReply = await chatReply({
        model: rotPrimaryModel,
        messages: [
          { role: 'system', content: 'Expert orientation solver. Reply with WINNING_INDEX: <1-' + total + '>' },
          { role: 'user', content: fbContent }
        ],
        temperature: 0,
        max_tokens: 150
      }, 25000);

      const rDuration = Date.now() - rStart;
      ccLog(tabId, 'FUNCAPTCHA: ROT fallback reply (' + rDuration + 'ms): ' + String(fbReply).trim().slice(0, 250));
      const fbWinner = extractWinningIndex(fbReply, total);
      if (fbWinner !== null) {
        ccLog(tabId, 'FUNCAPTCHA: ROT fallback WIN — tile [' + fbWinner + '] in ' + rDuration + 'ms');
        return {
          winningIndex: fbWinner,
          raw: fbReply,
          durationMs: rDuration,
          targetDigit: -1,
          pass: 'rotation-fallback'
        };
      }
    } catch (err) {
      ccLog(tabId, 'FUNCAPTCHA: ROT fallback error: ' + (err.message || err), 'warn');
    }

    // GUARANTEED SAFE TERMINATION: Never fall through to visual grid digit OCR
    const finalChoice = winner || 1;
    const rDuration = Date.now() - rStart;
    ccLog(tabId, 'FUNCAPTCHA: ROT guaranteed safety return — tile [' + finalChoice + '] in ' + rDuration + 'ms');
    return {
      winningIndex: finalChoice,
      raw: 'rotation-safety-guaranteed',
      durationMs: rDuration,
      targetDigit: -1,
      pass: 'rotation-guaranteed'
    };
  }
  // visual grid solver
  // cached target digit
  let targetDigit = -1;

  if (batchB64s && batchB64s.length > 0 && targetB64) {
    ccLog(tabId, 'FUNCAPTCHA: ★ Two-stage visual grid solver — ' + total + ' candidates in ' + batchB64s.length + ' batch(es)');
    const vStart = Date.now();

    // calculate batch ranges
    const firstBatchCount = batchB64s.length === 1 ? total : Math.ceil(total / 2);
    const batchDesc = batchB64s.length === 1
      ? 'IMAGE 2: Candidate tiles [1] through [' + total + '].\n'
      : 'IMAGE 2: Candidate tiles [1] through [' + firstBatchCount + '].\n' +
        'IMAGE 3: Candidate tiles [' + (firstBatchCount + 1) + '] through [' + total + '].\n';

    // stage 1 digit ocr
    try {
      const ocrReply = await chatReply({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a reference tile from an Arkose FunCAPTCHA.\n' +
                    'It shows a WRITTEN COUNT FORMULA like "N × [icon]" or "[icon] × N" where N is a printed digit 0–9.\n\n' +
                    '⚠️ CRITICAL RULES:\n' +
                    '1. The digit N is the WRITTEN NUMBER (e.g. "0", "1", "2", "3") — NOT the shape of the icon.\n' +
                    '2. Even if the icon looks like a circle, horseshoe, U-shape, or C-shape, those are NOT the count.\n' +
                    '3. The printed digit N can appear on EITHER the left or right of the "×" symbol.\n' +
                    '4. Examples:\n' +
                    '   - "0 × icon" → digit is 0\n' +
                    '   - "icon × 1" → digit is 1\n' +
                    '   - "2 × icon" → digit is 2\n\n' +
                    'Find the printed digit 0-9. Reply ONLY: {"digit": <integer 0-9>}'
            },
            { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
          ]
        }],
        temperature: 0,
        max_tokens: 80
      }, 28000);
      ccLog(tabId, 'FUNCAPTCHA: Stage-1 digit OCR: ' + String(ocrReply).trim().slice(0, 120));
      const oclean = String(ocrReply).replace(/```[a-z]*\n?/gi, '').trim();
      const ojm = oclean.match(/\{[\s\S]*?\}/);
      if (ojm) {
        try {
          const p = JSON.parse(ojm[0]);
          const v = p.digit !== undefined ? p.digit : p.count;
          if (typeof v === 'number' && v >= 0 && v <= 9) targetDigit = v;
          else if (typeof v === 'string') { const n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 9) targetDigit = n; }
        } catch {}
      }
      if (targetDigit < 0) {
        const dm = String(ocrReply).match(/"digit"\s*:\s*([0-9])/) || String(ocrReply).match(/\b([0-9])\s*[×x]/i);
        if (dm) targetDigit = parseInt(dm[1], 10);
      }
    } catch (e) { ccLog(tabId, 'FUNCAPTCHA: Stage-1 digit OCR error: ' + (e.message || e), 'warn'); }
    // regex prompt fallback
    if (targetDigit < 0) {
      const pm = (prompt || '').match(/\b([0-9])\s*[x×]/i) || (prompt || '').match(/^([0-9])\b/);
      if (pm) targetDigit = parseInt(pm[1], 10);
    }

    const pinned = targetDigit >= 0;
    ccLog(tabId, 'FUNCAPTCHA: ★ Stage-1 digit = ' + targetDigit + (pinned ? ' (PINNED)' : ' (unpinned — shape-match fallback)') + ', elapsed ' + (Date.now() - vStart) + 'ms');

    // stage 2 count enumeration
    if (pinned) {
      const enumText = 'Arkose FunCAPTCHA counting challenge.\n' +
        'IMAGE 1: a boxed number — it shows the REQUIRED count N = ' + targetDigit + ' (verified fact). It contains NO objects — do not count anything inside Image 1.\n' +
        batchDesc + '\n' +
        (objName
          ? 'TASK: Count ALL ' + objName + ' in each candidate tile. EVERY ' + objName.replace(/s$/, '') + ' counts as one instance — regardless of size, color, shade, or orientation. Objects partially visible at tile edges still count.\n'
          : 'TASK: Count ALL instances of the repeated object type in each candidate tile — any size/color/orientation variant of that object counts as one instance.\n') +
        '- The tiles sit on a shared terrain background — ignore the terrain, shrubs and shadows; count only the ' + (objName || 'objects') + '.\n' +
        '- Tiles are in a labelled grid [1]..[' + total + '].\n\n' +
        'Reply ONLY: {"counts": [<c1>, <c2>, ..., <c' + total + '>]} — ' + total + ' integers, tile order [1]..[' + total + ']. No other text.';
      const enumContent = [
        { type: 'text', text: enumText },
        { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
      ];
      for (let b = 0; b < batchB64s.length; b++) {
        enumContent.push({ type: 'image_url', image_url: { url: toDataUrl(batchB64s[b]) } });
      }

      try {
        const eStart = Date.now();
        let eReply;
        try {
          eReply = await chatReply({
            messages: [
              { role: 'system', content: 'You count objects in tiles precisely. Reply ONLY {"counts": [...]} — exactly ' + total + ' integers in tile order. No commentary.' },
              { role: 'user', content: enumContent }
            ],
            temperature: 0,
            max_tokens: 120
          }, 25000);
        } catch (e400) {
          const em = String(e400.message || e400);
          if (/400/.test(em) && /safety/i.test(em)) {
            // retry without target
            ccLog(tabId, 'FUNCAPTCHA: 400 safety rejection on enumeration — retrying without target image', 'warn');
            const noTarget = enumContent.filter((c, i) => i !== 1);
            noTarget[0].text += '\nThe counting target is ' + (objName || 'the repeated object type visible across tiles') + ' — count instances of that object per tile.';
            eReply = await chatReply({
              messages: [
                { role: 'system', content: 'You count objects in tiles precisely. Reply ONLY {"counts": [...]} — exactly ' + total + ' integers in tile order. No commentary.' },
                { role: 'user', content: noTarget }
              ],
              temperature: 0,
              max_tokens: 120
            }, 25000);
          } else throw e400;
        }

        ccLog(tabId, 'FUNCAPTCHA: count enumeration (' + (Date.now() - eStart) + 'ms): ' + String(eReply).trim().slice(0, 200));
        const arrM = String(eReply).replace(/```[a-z]*\n?/gi, '').match(/\[[\s\S]*?\]/);
        if (arrM) {
          const counts = JSON.parse(arrM[0]);
          if (Array.isArray(counts) && counts.length) {
            const matches = [];
            for (let i = 0; i < total; i++) {
              const c = parseInt(counts[i], 10);
              if (!isNaN(c) && c === targetDigit) matches.push(i + 1);
            }
            ccLog(tabId, 'FUNCAPTCHA: counts=' + JSON.stringify(counts) + ' N=' + targetDigit + ' → matches=' + JSON.stringify(matches));

            if (matches.length === 1) {
              const eDuration = Date.now() - vStart;
              ccLog(tabId, 'FUNCAPTCHA: ★★ COUNT ENUM WIN — tile [' + matches[0] + '] in ' + eDuration + 'ms');
              return { winningIndex: matches[0], raw: JSON.stringify({ counts, targetDigit }), durationMs: eDuration, targetDigit, pass: 'count-enum' };
            }

            if (matches.length > 1) {
              // tie break ambiguous tiles
              try {
                const tbContent = [{
                  type: 'text',
                  text: 'IMAGE 1: a boxed number showing the required count N = ' + targetDigit + ' (verified fact) — do not count anything in it.\n' +
                    'Counting target: ' + (objName || 'the repeated object type') + '.\n' +
                    'Candidate tiles: ' + matches.map((t) => '[' + t + ']').join(', ') + '.\n' +
                    'Exactly ONE of these contains exactly ' + targetDigit + ' ' + (objName || 'instances') + '.\n' +
                    'Which one? Reply ONLY: {"winner": <tile number>}'
                }];
                tbContent.push({ type: 'image_url', image_url: { url: toDataUrl(targetB64) } });
                for (let b = 0; b < batchB64s.length; b++) {
                  tbContent.push({ type: 'image_url', image_url: { url: toDataUrl(batchB64s[b]) } });
                }
                const tbReply = await chatReply({
                  messages: [
                    { role: 'system', content: 'Count precisely. Reply ONLY {"winner": <number>}.' },
                    { role: 'user', content: tbContent }
                  ],
                  temperature: 0,
                  max_tokens: 30
                }, 15000);
                ccLog(tabId, 'FUNCAPTCHA: count tie-break reply: ' + String(tbReply).trim().slice(0, 80));
                const tbm = String(tbReply).match(/\{[\s\S]*?\}/);
                if (tbm) {
                  const p = JSON.parse(tbm[0]);
                  const w = parseInt(p.winner !== undefined ? p.winner : p.winningIndex, 10);
                  if (!isNaN(w) && matches.includes(w)) {
                    const eDuration = Date.now() - vStart;
                    ccLog(tabId, 'FUNCAPTCHA: ★★ COUNT ENUM WIN (tie-break) — tile [' + w + '] in ' + eDuration + 'ms');
                    return { winningIndex: w, raw: JSON.stringify({ counts, targetDigit, tieBreak: String(tbReply) }), durationMs: eDuration, targetDigit, pass: 'count-enum-tb' };
                  }
                }
              } catch (te) {
                ccLog(tabId, 'FUNCAPTCHA: count tie-break failed: ' + (te.message || te), 'warn');
              }
            }
          }
        }
      } catch (ee) {
        ccLog(tabId, 'FUNCAPTCHA: count enumeration error: ' + (ee.message || ee) + ' — holistic fallback', 'warn');
      }
    }

    // holistic batch fallback
    const pinnedText = 'This is an Arkose FunCAPTCHA counting challenge.\n' +
        'Task prompt: "' + (prompt || 'Match the target') + '"\n\n' +
        'IMAGE 1: a boxed number — the required count N = ' + targetDigit + ' is ALREADY read (VERIFIED FACT). It contains NO objects.\n' +
        (objName
          ? 'The counting target comes from the task prompt: count ' + objName + '. Every ' + objName.replace(/s$/, '') + ' counts — any size, color, shade, or orientation. Edge-partial ones count too.\n'
          : 'The counting target is the repeated object type across tiles — every variant of it counts.\n') +
        'The terrain background, shrubs, and shadows are NOT countable.\n\n' +
        batchDesc + '\n' +
        'INSTRUCTIONS:\n' +
        '1. Count ONLY ' + (objName || 'the repeated object type') + ' in each candidate tile (Image 2' + (batchB64s.length > 1 ? ' and Image 3' : '') + '). Ignore everything else.\n' +
        '   - Count carefully — objects may overlap or be partially hidden at tile edges.\n' +
        '   - If unsure, re-inspect every tile before deciding — never guess blindly!\n' +
        (targetDigit === 0
          ? '2. Find the ONE tile with ZERO ' + (objName || 'instances') + '.\n'
          : '2. Find the ONE tile with EXACTLY ' + targetDigit + ' ' + (objName || 'instances') + '.\n') +
        '3. ⚠️ DO NOT list or describe all tiles individually. Keep your response under 2 sentences!\n' +
        '4. Conclude with:\n' +
        'TARGET: ' + targetDigit + ' x ' + (objName || '<object>') + '\n' +
        'WINNING_INDEX: <number 1-' + total + '>\n' +
        '{"winningIndex": <number 1-' + total + '>}';
    // unpinned prompt fallback
    const shapeMatchText = 'This is an Arkose FunCAPTCHA challenge.\n' +
          'Task prompt: "' + (prompt || 'Match the target') + '"\n\n' +
          'IMAGE 1: TARGET reference tile.\n' +
          'Displays the multiplication formula between a DIGIT N (0-9) and a 3D OBJECT ICON.\n' +
          '⚠️ THE DIGIT N AND THE 3D OBJECT CAN APPEAR ON EITHER SIDE OF "x"!\n' +
          '   Formula is either [Digit N] x [3D Object] OR [3D Object] x [Digit N].\n' +
          '   "x" IS THE MULTIPLICATION OPERATOR ("times"), never an object or letter!\n' +
          '   One side is the digit N, the other side is the 3D model icon to count.\n' +
          '⚠️ DIGIT IDENTIFICATION IN IMAGE 1:\n' +
          '   - "0": Rendered as a 3D oval loop, donut, or hexagonal ring with a dark HOLE in the center. If it has a central hole/loop, it is ZERO (0), NEVER 1!\n' +
          '   - "1": A vertical numeral with a slanted top flag/serif and horizontal base. Do NOT mistake "1" for a tool or object!\n' +
          '   - Common digits N are 0, 1, 2, 3, 4, 5.\n' +
          '   - 3D Object Icons are real-world items: key, boot/shoe, goblet/cup, box/cube, snail/shell, mushroom, fish, hat, pin, leaf, etc.\n' +
          '- ⚠️ CRITICAL FOR N = 0: "0 x [object]" or "[object] x 0" means find the candidate tile that contains ZERO (0) of that specific 3D object! Other candidate tiles contain 1+ of it; the winning tile has NONE of it.\n' +
          '- ⚠️ CRITICAL FOR N >= 1: Each candidate tile contains multiple DIFFERENT mixed objects. Look closely at the exact 3D shape in Image 1, ignore distractor objects of different shapes, and count ONLY the exact matching object. Find the tile that has EXACTLY N instances of it.\n\n' +
          batchDesc + '\n' +
          'INSTRUCTIONS:\n' +
          '1. In Image 1, identify which side is the digit N (0-9) and which side is the 3D object shape.\n' +
          '2. Find the ONE candidate tile [X] that has exactly N instances of this object (or 0 if N=0).\n' +
          '   - Inspect all tiles in ' + (batchB64s.length > 1 ? 'BOTH Image 2 ([1]-[' + firstBatchCount + ']) and Image 3 ([' + (firstBatchCount + 1) + ']-[' + total + '])' : 'Image 2 ([1]-[' + total + '])') + '.\n' +
          '   - If the target object is not in ' + (batchB64s.length > 1 ? 'Image 2, check all tiles in Image 3' : 'the batch, re-inspect every tile') + ' carefully before deciding — never guess blindly!\n' +
          '3. ⚠️ DO NOT list or describe all tiles individually. Keep your response under 2 sentences!\n' +
          '4. Conclude with:\n' +
          'TARGET: <N> x <object>\n' +
          'WINNING_INDEX: <number 1-' + total + '>\n' +
          '{"winningIndex": <number 1-' + total + '>}';

    const content = [
      {
        type: 'text',
        text: pinned ? pinnedText : shapeMatchText
      },
      { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
    ];

    for (let b = 0; b < batchB64s.length; b++) {
      content.push({ type: 'image_url', image_url: { url: toDataUrl(batchB64s[b]) } });
    }

    try {
      const messages = [
        {
          role: 'system',
          content: 'You are an expert Arkose FunCAPTCHA solver. Be extremely concise (maximum 2 sentences). Do NOT list all tiles individually. You MUST conclude with:\nWINNING_INDEX: <integer 1-' + total + '>\n{"winningIndex": <integer 1-' + total + '>}'
        },
        { role: 'user', content }
      ];

      const vReply = await chatReply({
        messages,
        temperature: 0,
        max_tokens: 1000
      }, 25000);

      const vDuration = Date.now() - vStart;
      ccLog(tabId, 'FUNCAPTCHA: grid solver reply (' + vDuration + 'ms): ' + String(vReply).trim());

      let winningIndex = null;

      // parse structured json
      const jm = String(vReply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
      if (jm) {
        try {
          const parsed = JSON.parse(jm[0]);
          const rawIdx = parsed.winningIndex || parsed.winning_index || parsed.tile || parsed.candidate || parsed.index;
          const wi = parseInt(rawIdx, 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) winningIndex = wi;
        } catch {}
      }

      // parse explicit markers
      if (!winningIndex) {
        const mIdx = String(vReply).match(/WINNING_INDEX:\s*(\d+)/i) ||
                     String(vReply).match(/winningIndex"?\s*[:=]\s*(\d+)/i) ||
                     String(vReply).match(/(?:winner|matching|correct|chosen|answer)\s*(?:is|tile|candidate)?\s*\[?(\d+)\]?/i) ||
                     String(vReply).match(/(?:tile|candidate)\s*\[?(\d+)\]?\s*(?:is the winner|matches|is correct|has the exact)/i);
        if (mIdx) {
          const wi = parseInt(mIdx[1], 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) winningIndex = wi;
        }
      }

      // tail text analysis
      if (!winningIndex) {
        const tail = String(vReply).slice(-300);
        const tailMatch = tail.match(/(?:WINNING_INDEX|winner|matches|answer)\s*[:=]?\s*\[?(\d+)\]?/i) ||
                          tail.match(/\[(\d+)\]\s*(?:is correct|is the answer|matches)/i);
        if (tailMatch) {
          const wi = parseInt(tailMatch[1], 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) {
            ccLog(tabId, 'FUNCAPTCHA: tail conclusion matched tile [' + wi + ']');
            winningIndex = wi;
          }
        }
      }

      if (winningIndex) {
        ccLog(tabId, 'FUNCAPTCHA: ★★ VISUAL GRID WIN — tile [' + winningIndex + '] digit=' + (pinned ? targetDigit : '?') + ' in ' + vDuration + 'ms');
        return { winningIndex, raw: vReply, durationMs: vDuration, targetDigit: pinned ? targetDigit : undefined, pass: pinned ? 'visual-grid-pinned' : 'visual-grid' };
      }
      ccLog(tabId, 'FUNCAPTCHA: grid solver parse failed — reply was: ' + String(vReply).trim().slice(0, 400), 'warn');
    } catch (err) {
      ccLog(tabId, 'FUNCAPTCHA: visual grid solver error: ' + (err.message || err) + ' — falling back', 'warn');
    }
  }

  const isCountingChallenge = targetB64 &&
    !promptLower.includes('rotat') &&
    !promptLower.includes('direction') &&
    !promptLower.includes('facing') &&
    !promptLower.includes('match the object') &&
    !promptLower.includes('claw');

  // batch per tile counting
  if (isCountingChallenge && tileB64s && tileB64s.length === total) {
    ccLog(tabId, 'FUNCAPTCHA: ★ Batch per-tile mode — ' + total + ' tiles');
    const batchStart0 = Date.now();

    // pass 1 digit ocr
    if (targetDigit < 0) {
    try {
      const ocrReply = await chatReply({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a reference tile from an Arkose FunCAPTCHA.\n' +
                    'It shows a WRITTEN COUNT FORMULA like "N × [icon]" or "[icon] × N" where N is a printed digit 0–9.\n\n' +
                    '⚠️ CRITICAL RULES:\n' +
                    '1. The digit N is the WRITTEN NUMBER (e.g. "0", "1", "2", "3") — NOT the shape of the icon.\n' +
                    '2. Even if the icon looks like a circle, horseshoe, U-shape, or C-shape, those are NOT the count.\n' +
                    '3. The printed digit N can appear on EITHER the left or right of the "×" symbol.\n' +
                    '4. Examples:\n' +
                    '   - "0 × icon" → digit is 0\n' +
                    '   - "icon × 1" → digit is 1\n' +
                    '   - "2 × icon" → digit is 2\n\n' +
                    'Find the printed digit 0-9. Reply ONLY: {"digit": <integer 0-9>}'
            },
            { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
          ]
        }],
        temperature: 0,
        max_tokens: 80
      }, 28000);
      ccLog(tabId, 'FUNCAPTCHA: P1-A: ' + String(ocrReply).trim().slice(0, 120));
      const clean = String(ocrReply).replace(/```[a-z]*\n?/gi, '').trim();
      const jm = clean.match(/\{[\s\S]*?\}/);
      if (jm) {
        try {
          const p = JSON.parse(jm[0]);
          const v = p.digit !== undefined ? p.digit : p.count;
          if (typeof v === 'number' && v >= 0 && v <= 9) targetDigit = v;
          else if (typeof v === 'string') { const n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 9) targetDigit = n; }
        } catch {}
      }
      if (targetDigit < 0) {
        // parse target digit regex
        const dm = String(ocrReply).match(/STEP 2[^0-9]*([0-9])/) ||
                   String(ocrReply).match(/digit.*?:\s*([0-9])/) ||
                   String(ocrReply).match(/LEFT.*?([0-9])/) ||
                   String(ocrReply).match(/printed.*?([0-9])/) ||
                   String(ocrReply).match(/"digit"\s*:\s*([0-9])/) ||
                   String(ocrReply).match(/\b([0-9])\s*[×x]/i);
        if (dm) targetDigit = parseInt(dm[1], 10);
      }
    } catch (e) { ccLog(tabId, 'FUNCAPTCHA: P1-A error: ' + (e.message || e), 'warn'); }
    }

    // reference tile count
    if (targetDigit < 0) {
      try {
        const countReply = await chatReply({
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Count the distinct 3D objects shown in this Arkose FunCAPTCHA reference image.\n' +
                      'Each separate 3D shape cluster = 1. Background grain/color fringes = 0.\n' +
                      'Reply ONLY: {"count": <integer 0-9>}'
              },
              { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
            ]
          }],
          temperature: 0,
          max_tokens: 32
        }, 20000);
        ccLog(tabId, 'FUNCAPTCHA: P1-B: ' + String(countReply).trim().slice(0, 80));
        const jm2 = String(countReply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
        if (jm2) {
          try {
            const p2 = JSON.parse(jm2[0]);
            const cv = p2.count !== undefined ? p2.count : p2.digit;
            if (typeof cv === 'number' && cv >= 0 && cv <= 9) targetDigit = cv;
            else if (typeof cv === 'string') { const n = parseInt(cv, 10); if (!isNaN(n) && n >= 0 && n <= 9) targetDigit = n; }
          } catch {}
        }
        if (targetDigit < 0) {
          const dm2 = String(countReply).match(/\b([0-9])\b/);
          if (dm2) targetDigit = parseInt(dm2[1], 10);
        }
      } catch (e) { ccLog(tabId, 'FUNCAPTCHA: P1-B error: ' + (e.message || e), 'warn'); }
    }

    // prompt regex fallback
    if (targetDigit < 0) {
      const pm = (prompt || '').match(/\b([0-9])\s*[x×]/i) || (prompt || '').match(/^([0-9])\b/);
      if (pm) targetDigit = parseInt(pm[1], 10);
    }

    ccLog(tabId, 'FUNCAPTCHA: ★ targetDigit = ' + targetDigit + ' (elapsed ' + (Date.now() - batchStart0) + 'ms)');

    // pass 2 batch counting
    if (targetDigit === 0 && tileB64s.length > 0) {
      ccLog(tabId, 'FUNCAPTCHA: ★ zero-count fast-path — asking model to find empty tile directly');
      try {
        const zeroContent = [{
          type: 'text',
          text: 'This is an Arkose FunCAPTCHA challenge. The target requires ZERO (0) objects.\n' +
                'I will show you ' + total + ' candidate tiles labeled [1] through [' + total + '].\n\n' +
                'Each tile shows objects that look like 3D colored shapes (horseshoes, C-shapes, fish, keys, etc.) on a grainy dark background.\n' +
                'TASK: Find the ONE tile that has NO objects at all — only background noise/grain, no recognizable 3D shapes.\n\n' +
                '⚠️ IMPORTANT: Background grain and color noise are NOT objects. Only clear 3D shapes count.\n' +
                'The tile with 0 objects will look mostly like a blank/noisy background compared to the others.\n\n' +
                'Reply ONLY as JSON: {"emptyTile": <tile number 1-' + total + '>}'
        }];
        for (let i = 0; i < tileB64s.length; i++) {
          zeroContent.push({ type: 'text', text: 'Tile [' + (i + 1) + ']:' });
          zeroContent.push({ type: 'image_url', image_url: { url: toDataUrl(tileB64s[i]) } });
        }
        const zeroReply = await chatReply({
          messages: [{ role: 'user', content: zeroContent }],
          temperature: 0,
          max_tokens: 32
        }, 45000);
        ccLog(tabId, 'FUNCAPTCHA: zero fast-path reply: ' + String(zeroReply).trim().slice(0, 100));
        const zjm = String(zeroReply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
        if (zjm) {
          try {
            const zp = JSON.parse(zjm[0]);
            const zt = zp.emptyTile !== undefined ? zp.emptyTile : (zp.winningIndex !== undefined ? zp.winningIndex : zp.tile);
            const zwi = parseInt(zt, 10);
            if (!isNaN(zwi) && zwi >= 1 && zwi <= total) {
              ccLog(tabId, 'FUNCAPTCHA: ★★ ZERO FAST-PATH WIN — tile [' + zwi + '] is the empty tile');
              return { winningIndex: zwi, raw: zeroReply, durationMs: Date.now()-batchStart0, targetDigit: 0, pass: 'zero-direct' };
            }
          } catch {}
        }
        // digit fallback
        const zdm = String(zeroReply).match(/emptyTile.*?(\d+)/) || String(zeroReply).match(/\b([1-9][0-9]?)\b/);
        if (zdm) {
          const zwi2 = parseInt(zdm[1], 10);
          if (zwi2 >= 1 && zwi2 <= total) {
            ccLog(tabId, 'FUNCAPTCHA: ★★ ZERO FAST-PATH WIN (regex) — tile [' + zwi2 + ']');
            return { winningIndex: zwi2, raw: zeroReply, durationMs: Date.now()-batchStart0, targetDigit: 0, pass: 'zero-direct' };
          }
        }
        ccLog(tabId, 'FUNCAPTCHA: zero fast-path parse failed — falling through to batch counting', 'warn');
      } catch (e) {
        ccLog(tabId, 'FUNCAPTCHA: zero fast-path error: ' + (e.message || e), 'warn');
      }
    }

    if (targetDigit >= 0) {
      const BATCH_SIZE = 4;
      const tileCounts = new Array(total).fill(-1);
      const batchPromises = [];

      for (let bStart = 0; bStart < total; bStart += BATCH_SIZE) {
        const indices = [];
        for (let k = bStart; k < Math.min(bStart + BATCH_SIZE, total); k++) indices.push(k);

        batchPromises.push((async (idxList) => {
          // build counting prompt
          const zeroHint = targetDigit === 0
            ? '\n\u26a0\ufe0f TARGET IS 0: You are looking for a tile with NO objects at all. A tile with 0 objects shows ONLY noise/grain background with no distinct 3D shapes.\n'
            : '';

          // attach batch images
          const content = [{
            type: 'text',
            text: 'Count distinct 3D objects in each FunCAPTCHA tile below.\n' +
                  'Objects = separate glowing 3D colored shape clusters on a dark/noisy background.\n' +
                  'Background grain, color noise, and faint texture = NOT objects (count as 0).\n' +
                  'Only count shapes that are clearly defined 3D objects.' + zeroHint + '\n' +
                  'Tiles shown: ' + idxList.map(i => '[' + (i + 1) + ']').join(', ') + '\n\n' +
                  'Reply ONLY as JSON: {"counts": [' + idxList.map(i => '<int for tile ' + (i+1) + '>').join(', ') + ']}\n' +
                  'Each value is 0-9. Example for 4 tiles: {"counts": [1, 3, 2, 1]}'
          }];
          for (const i of idxList) {
            content.push({ type: 'text', text: 'Tile [' + (i + 1) + ']:' });
            content.push({ type: 'image_url', image_url: { url: toDataUrl(tileB64s[i]) } });
          }

          try {
            const t = Date.now();
            const reply = await chatReply({
              messages: [{ role: 'user', content }],
              temperature: 0,
              max_tokens: 64
            }, 40000);
            ccLog(tabId, 'FUNCAPTCHA: batch[' + idxList.map(i=>i+1).join(',') + '] ' + (Date.now()-t) + 'ms: ' + String(reply).trim().slice(0, 100));

            // parse counts json
            const clean = String(reply).replace(/```[a-z]*\n?/gi, '').trim();
            const jm = clean.match(/\{[\s\S]*?\}/);
            if (jm) {
              try {
                const parsed = JSON.parse(jm[0]);
                if (Array.isArray(parsed.counts)) {
                  for (let k = 0; k < idxList.length && k < parsed.counts.length; k++) {
                    const c = parseInt(parsed.counts[k], 10);
                    if (!isNaN(c) && c >= 0 && c <= 9) tileCounts[idxList[k]] = c;
                  }
                }
              } catch {}
            }

            // extract digits from text
            if (idxList.some(i => tileCounts[i] < 0)) {
              const nums = clean.match(/\b([0-9])\b/g);
              if (nums && nums.length >= idxList.length) {
                for (let k = 0; k < idxList.length; k++) {
                  if (tileCounts[idxList[k]] < 0) tileCounts[idxList[k]] = parseInt(nums[k], 10);
                }
              }
            }
          } catch (e) {
            ccLog(tabId, 'FUNCAPTCHA: batch[' + idxList.map(i=>i+1).join(',') + '] error: ' + (e.message || e), 'warn');
          }
        })(indices));
      }

      await Promise.all(batchPromises);
      ccLog(tabId, 'FUNCAPTCHA: ★ all tile counts = ' + tileCounts.map((c,i) => '[' + (i+1) + ']:' + c).join(' ') + ' (total ' + (Date.now()-batchStart0) + 'ms)');

      // find winning tile
      const matchingTiles = tileCounts.map((c,i) => ({tile: i+1, count: c})).filter(t => t.count === targetDigit);
      ccLog(tabId, 'FUNCAPTCHA: tiles matching digit=' + targetDigit + ': ' + JSON.stringify(matchingTiles));

      if (matchingTiles.length === 1) {
        const wi = matchingTiles[0].tile;
        ccLog(tabId, 'FUNCAPTCHA: ★★ BATCH WIN — tile [' + wi + '] confirmed ' + targetDigit + ' objects');
        return { winningIndex: wi, raw: JSON.stringify({tileCounts, targetDigit}), durationMs: Date.now()-batchStart0, targetDigit, pass: 'batch' };
      }

      // zero count lowest strategy
      if (targetDigit === 0 && matchingTiles.length === 0) {
        const validCounts = tileCounts.map((c,i) => ({tile: i+1, count: c})).filter(t => t.count >= 0);
        if (validCounts.length > 0) {
          validCounts.sort((a,b) => a.count - b.count);
          const wi = validCounts[0].tile;
          ccLog(tabId, 'FUNCAPTCHA: ★ zero-count fallback — lowest-count tile is [' + wi + '] with ' + validCounts[0].count + ' (may be 0)');
          // verify lowest count limit
          if (validCounts[0].count <= 1) {
            return { winningIndex: wi, raw: JSON.stringify({tileCounts, targetDigit}), durationMs: Date.now()-batchStart0, targetDigit, pass: 'zero-fallback' };
          }
        }
      }

      if (matchingTiles.length > 1) {
        // verify ambiguous tiles
        ccLog(tabId, 'FUNCAPTCHA: ' + matchingTiles.length + ' tiles tied — running per-tile tie-breaker...');
        const recountResults = await Promise.all(matchingTiles.map(async (mt) => {
          try {
            const reReply = await chatReply({
              messages: [{
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'This is a single FunCAPTCHA tile. Count the distinct 3D objects.\n' +
                          'Glowing 3D shape cluster = 1 object. Background grain = 0.\n' +
                          'Reply ONLY: {"count": <integer 0-9>}'
                  },
                  { type: 'image_url', image_url: { url: toDataUrl(tileB64s[mt.tile - 1]) } }
                ]
              }],
              temperature: 0,
              max_tokens: 24
            }, 20000);
            const jmR = String(reReply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
            if (jmR) {
              const pr = JSON.parse(jmR[0]);
              const cv = pr.count !== undefined ? pr.count : pr.digit;
              const rc = parseInt(cv, 10);
              if (!isNaN(rc)) { ccLog(tabId, 'FUNCAPTCHA: tie tile [' + mt.tile + '] recount=' + rc); return { tile: mt.tile, count: rc }; }
            }
          } catch {}
          return mt;
        }));
        const finalMatch = recountResults.find(t => t.count === targetDigit);
        if (finalMatch) {
          ccLog(tabId, 'FUNCAPTCHA: ★★ TIE-BREAK WIN — tile [' + finalMatch.tile + ']');
          return { winningIndex: finalMatch.tile, raw: JSON.stringify(recountResults), durationMs: Date.now()-batchStart0, targetDigit, pass: 'tiebreak' };
        }
      }

      // fall through to composite
      ccLog(tabId, 'FUNCAPTCHA: batch mode no match found (digit=' + targetDigit + ' counts=' + JSON.stringify(tileCounts) + ') — composite fallback', 'warn');
    }
  }

  // two pass composite fallback
  const isCountingFallback = targetB64 &&
    !promptLower.includes('rotat') &&
    !promptLower.includes('direction') &&
    !promptLower.includes('facing') &&
    !promptLower.includes('match the object') &&
    !promptLower.includes('claw');

  if (isCountingFallback && (!tileB64s || tileB64s.length !== total) && imageB64) {
    ccLog(tabId, 'FUNCAPTCHA: two-pass composite fallback — reading target digit...');
    let targetDigit = -1;

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const t1Resp = await postChat({
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'This is the TARGET reference from an Arkose FunCAPTCHA.\n' +
                        'Find the integer count N (0-9) shown as "N × [icon]" or a prominent digit.\n' +
                        'Reply ONLY as JSON: {"digit": <int 0-9>}'
                },
                { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
              ]
            }],
            temperature: 0,
            max_tokens: 48
          }, 28000);
          if (!t1Resp.ok) break;
          const t1Data = await t1Resp.json();
          const t1Reply = t1Data.choices && t1Data.choices[0] && t1Data.choices[0].message && t1Data.choices[0].message.content;
          if (t1Reply) {
            const jm = String(t1Reply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
            if (jm) { try { const p = JSON.parse(jm[0]); const v = p.digit !== undefined ? p.digit : p.count; if (typeof v === 'number') targetDigit = v; else if (typeof v === 'string') { const n = parseInt(v,10); if (!isNaN(n)) targetDigit = n; } } catch {} }
            if (targetDigit < 0) { const dm = String(t1Reply).match(/\b([0-9])\b/); if (dm) targetDigit = parseInt(dm[1],10); }
          }
          break;
        } catch (e) { if (attempt === 1) ccLog(tabId, 'FUNCAPTCHA: OCR fallback error: ' + (e.message||e), 'warn'); }
      }
    } catch {}

    if (targetDigit < 0) {
      const pm = (prompt||'').match(/\b([0-9])\s*[x×]/i)||(prompt||'').match(/^([0-9])\b/);
      if (pm) targetDigit = parseInt(pm[1],10);
    }

    if (targetDigit >= 0) {
      const targetDesc = targetDigit === 0
        ? 'ZERO (0) objects (tile with NO distinct 3D objects, cleanest background)'
        : 'EXACTLY ' + targetDigit + ' objects';

      try {
        const p2Resp = await postChat({
          messages: [
            {
              role: 'system',
              content: 'You are an Arkose FunCAPTCHA solver. TOP BOX = TARGET (' + targetDesc + '). BOTTOM GRID = candidates [1]-[' + total + '].\n' +
                       'Find the candidate tile with ' + targetDesc + '. Reply with 1 sentence reason then {"winningIndex": <1-' + total + '>}.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Target count = ' + targetDigit + '. Which tile [1]-[' + total + '] has ' + targetDesc + '? Reply: {"winningIndex": N}' },
                { type: 'image_url', image_url: { url: toDataUrl(imageB64) } }
              ]
            }
          ],
          temperature: 0,
          max_tokens: 100
        }, 30000);
        const p2Data = await p2Resp.json();
        const p2Reply = p2Data.choices && p2Data.choices[0] && p2Data.choices[0].message && p2Data.choices[0].message.content;
        if (p2Reply) {
          const jm2 = String(p2Reply).match(/\{[\s\S]*?\}/);
          if (jm2) {
            try {
              const parsed = JSON.parse(jm2[0]);
              const rawIdx = parsed.winningIndex !== undefined ? parsed.winningIndex : (parsed.winning_index !== undefined ? parsed.winning_index : parsed.index);
              if (rawIdx !== undefined) {
                const wi = parseInt(rawIdx, 10);
                if (!isNaN(wi) && wi >= 1 && wi <= total) {
                  ccLog(tabId, 'FUNCAPTCHA: ✓ composite two-pass result: tile [' + wi + '] (digit=' + targetDigit + ')');
                  return { winningIndex: wi, raw: p2Reply, durationMs: 0, targetDigit, pass: 2 };
                }
              }
            } catch {}
          }
          const mIdx = String(p2Reply).match(/winningIndex"?\s*[:=]\s*(\d+)/i) || String(p2Reply).match(/WINNING_INDEX:\s*(\d+)/i);
          if (mIdx) {
            const wi = Math.max(1, Math.min(total, parseInt(mIdx[1],10)));
            return { winningIndex: wi, raw: p2Reply, durationMs: 0, targetDigit, pass: 2 };
          }
        }
      } catch (e) { ccLog(tabId, 'FUNCAPTCHA: composite P2 error: ' + (e.message||e), 'warn'); }
    }
  }

  // single composite fallback
  if (!imageB64) throw new Error('No image data for FunCaptcha solve');
  ccLog(tabId, 'FUNCAPTCHA: single-composite fallback');

  const systemPrompt =
    'You are a high-precision Arkose FunCAPTCHA solver.\n' +
    'The image contains:\n' +
    '1. Top banner: TARGET reference (shows required object count or type).\n' +
    '2. Bottom grid: Numbered candidate tiles [1] through [' + total + '].\n\n' +
    'VISUAL STYLE: Glitch/psychedelic chromatic aberration — bright 3D colored clusters on dark background. Each cluster = 1 object.\n\n' +
    'CHALLENGE TYPES:\n' +
    'A. OBJECT COUNT ("N x [icon]"): Find candidate with EXACTLY N objects.\n' +
    'B. CLAW/PRIZE MATCH: Match the prize shape.\n' +
    'C. ROTATION/DIRECTION: Match the orientation.\n\n' +
    'OUTPUT: 1-line reason, then WINNING_INDEX: <1 to ' + total + '>.';

  const startTime = Date.now();
  let resp;
  try {
    resp = await postChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: 'Task: "' + prompt + '"\nFind the correct candidate [1]-[' + total + ']. Output WINNING_INDEX: <number>.' },
          { type: 'image_url', image_url: { url: toDataUrl(imageB64) } }
        ]}
      ],
      temperature: 0.05,
      max_tokens: 160
    }, 35000);
  } catch (err) {
    throw new Error('FunCaptcha vision API fetch failed: ' + (err.message || err));
  }

  const durationMs = Date.now() - startTime;
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('xKiro API HTTP ' + resp.status + ': ' + errText.slice(0, 150));
  }

  const data = await resp.json();
  const rawReply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!rawReply) throw new Error('Empty reply from vision model');

  ccLog(tabId, 'FUNCAPTCHA: composite reply (' + durationMs + 'ms): ' + rawReply.trim());

  let winningIndex = null;
  const jsonMatch2 = rawReply.match(/\{[\s\S]*?\}/);
  if (jsonMatch2) {
    try {
      const parsed = JSON.parse(jsonMatch2[0]);
      const rawIdx = parsed.winningIndex !== undefined ? parsed.winningIndex : (parsed.winning_index !== undefined ? parsed.winning_index : parsed.index);
      if (rawIdx !== undefined && rawIdx !== null) {
        const n = parseInt(rawIdx, 10);
        if (!isNaN(n) && n >= 1 && n <= total) winningIndex = n;
      }
    } catch {}
  }
  if (!winningIndex) {
    const match =
      rawReply.match(/WINNING_INDEX:\s*(\d+)/i) ||
      rawReply.match(/winningIndex"?\s*[:=]\s*(\d+)/i) ||
      rawReply.match(/candidate\s*\[?(\d+)\]?/i) ||
      rawReply.match(/tile\s*\[?(\d+)\]?/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!isNaN(n) && n >= 1 && n <= total) winningIndex = n;
    }
  }

  winningIndex = winningIndex ? Math.max(1, Math.min(total, winningIndex)) : 1;
  ccLog(tabId, 'FUNCAPTCHA: ★ final candidate: [' + winningIndex + ']');
  return { winningIndex, raw: rawReply, durationMs, targetDigit: -1, pass: 1 };
}

// tile grid solver
async function solveFunCaptchaTiles(tabId, msg) {
  const { prompt, targetB64, batchB64s, candidateCount } = msg;
  const total = candidateCount || 6;
  const apiKey = settings.visionApiKey || settings.apiKey || '';
  const baseUrl = (settings.visionBaseUrl || 'https://api.xkiro.com/v1').replace(/\/+$/, '');

  const primaryModel = settings.visionModel || 'qwen/qwen3.8-omni-flash:free';
  const fallbackModel = 'qwen/qwen3.8-max:free';

  ccLog(tabId, 'FUNCAPTCHA-TILE: ★ solver — "' + String(prompt || '').slice(0, 60) + '" [' + total + ' cells]');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) { headers['Authorization'] = 'Bearer ' + apiKey; headers['x-api-key'] = apiKey; }
  const endpoint = baseUrl + '/chat/completions';

  const toDataUrl = (b64) => (b64 && b64.startsWith('data:') ? b64 : ('data:image/jpeg;base64,' + (b64 || '')));

  // sanitize base64 strings
  const validTarget = (targetB64 && typeof targetB64 === 'string' && targetB64.length > 200) ? targetB64 : null;
  const validBatches = (batchB64s || []).filter((b) => b && typeof b === 'string' && b.length > 200);

  if (!validBatches.length && !validTarget) {
    throw new Error('No valid candidate images provided to tile solver');
  }

  const pickAll = /\ball\b/i.test(String(prompt || ''));
  const content = [];
  content.push({
    type: 'text',
    text: 'Arkose FunCAPTCHA visual selection challenge.\n' +
      'Task prompt: "' + (prompt || 'Pick the requested object') + '"\n\n' +
      (validTarget ? 'TARGET REFERENCE: image 1.\n' : '') +
      'Candidate tiles are labelled [1] through [' + total + '] in the image.\n' +
      'Which tile(s) contain the requested object?\n' +
      (pickAll ? 'List ALL tiles that contain it.\n' : 'Select the SINGLE correct tile.\n') +
      'Reply ONLY with a JSON array of matching tile numbers, e.g. [2] or [5]. No other text.'
  });
  if (validTarget) content.push({ type: 'image_url', image_url: { url: toDataUrl(validTarget) } });
  for (const b of validBatches) content.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });

  const models = [primaryModel, fallbackModel].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastErr = null;

  for (const model of models) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a precise Arkose FunCAPTCHA tile selector. Reply ONLY with a JSON array of matching tile numbers, e.g. [1, 4]. No other text.' },
            { role: 'user', content }
          ],
          temperature: 0,
          max_tokens: 60
        })
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        lastErr = new Error('HTTP ' + resp.status + ': ' + txt.slice(0, 120));
        ccLog(tabId, 'FUNCAPTCHA-TILE: ' + model + ' HTTP error ' + resp.status + ' → trying next model', 'warn');
        continue;
      }

      const data = await resp.json();
      const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      ccLog(tabId, 'FUNCAPTCHA-TILE: reply via ' + model + ': ' + String(reply).trim().slice(0, 200));

      // catch backend proxy error
      if (/image failed to (?:load|upload)|cannot (?:view|see|load) the image|resend it/i.test(reply)) {
        ccLog(tabId, 'FUNCAPTCHA-TILE: ' + model + ' reported image load failure → trying fallback model', 'warn');
        lastErr = new Error('Model reported image load failure: ' + reply);
        continue;
      }

      const matches = [];
      const arrMatch = String(reply).match(/\[[\s\S]*?\]/);
      if (arrMatch) {
        try {
          const arr = JSON.parse(arrMatch[0]);
          if (Array.isArray(arr)) {
            for (const n of arr) {
              const v = parseInt(n, 10);
              if (!isNaN(v) && v >= 1 && v <= total) matches.push(v);
            }
          }
        } catch {}
      }
      if (!matches.length) {
        const nums = String(reply).match(/\b([1-9][0-9]?)\b/g);
        if (nums) {
          for (const n of nums) {
            const v = parseInt(n, 10);
            if (v >= 1 && v <= total) matches.push(v);
          }
        }
      }

      let finalMatches = [...new Set(matches)];

      // retry with fallback model
      if (!finalMatches.length) {
        ccLog(tabId, 'FUNCAPTCHA-TILE: no matches from ' + model + ' → trying fallback model', 'warn');
        lastErr = new Error('No matching tiles found by ' + model);
        continue;
      }

      // guard against over selection
      if (!pickAll && finalMatches.length > 2) {
        finalMatches = [finalMatches[0]];
      }

      return { matches: finalMatches, raw: reply, durationMs: 0, model };
    } catch (e) {
      lastErr = e;
      ccLog(tabId, 'FUNCAPTCHA-TILE: ' + model + ' failed (' + (e.message || e) + ') → trying fallback', 'warn');
    }
  }

  throw lastErr || new Error('All tile solver endpoints failed');
}

function parseTileAnswer(rawText, maxTile) {
  if (!rawText) return [];
  const text = String(rawText).trim();

  // parse json array
  const match = text.match(/\[\s*[\d\s,]*\s*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        return arr
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= maxTile);
      }
    } catch {}
  }

  // check negative response
  if (/none|no tiles|neither|zero/i.test(text) && !/\b[1-9]\b/.test(text)) {
    return [];
  }

  // extract matching numbers
  const nums = text.match(/\b\d+\b/g);
  if (nums) {
    return Array.from(new Set(nums.map(Number))).filter((n) => n >= 1 && n <= maxTile);
  }

  return [];
}

/* -----------------------------------------------------------------------
   TEXT CAPTCHA — xkiro vision OCR (image-text) + xkiro chat (questions)
   ----------------------------------------------------------------------- */

// Single-shot call, no sleeps: MV3 SW gets suspended during setTimeout backoff,
// which killed every retry with "Failed to fetch". Retrying is the content
// script's job (its 6-attempt loop never sleeps in SW context).
// On 5xx/429 from the primary model, one silent fallback attempt on a
// verified-working vision model keeps a transient outage from killing a solve.
const VISION_FALLBACK_MODEL = 'mistralai/mistral-medium-3.5';

async function xkiroChat(tabId, messages, { maxTokens = 64, timeoutMs = 25000, fallback = true } = {}) {
  const apiKey = settings.visionApiKey || settings.apiKey || '';
  const baseUrl = (settings.visionBaseUrl || 'https://api.xkiro.com/v1').replace(/\/+$/, '');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
    headers['x-api-key'] = apiKey;
  }

  const models = [settings.visionModel || 'qwen/qwen3.8-omni-flash:free'];
  if (fallback && models[0] !== VISION_FALLBACK_MODEL) models.push(VISION_FALLBACK_MODEL);

  let lastErr = null;
  for (const model of models) {
    const startTime = Date.now();
    try {
      const resp = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: maxTokens
        })
      });

      const durationMs = Date.now() - startTime;
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const err = new Error('xKiro HTTP ' + resp.status + ' (' + durationMs + 'ms) [' + model + ']: ' + errText.slice(0, 160));
        if ((resp.status >= 500 || resp.status === 429) && model !== models[models.length - 1]) {
          lastErr = err;
          ccLog(tabId, 'TEXT_CAPTCHA: ' + resp.status + ' on ' + model + ' — trying fallback', 'warn');
          continue;
        }
        throw err;
      }

      const data = await resp.json();
      const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!reply) throw new Error('Empty response from model (' + durationMs + 'ms)');
      ccLog(tabId, 'TEXT_CAPTCHA: model reply via ' + model + ' (' + durationMs + 'ms): ' + String(reply).trim());
      return String(reply).trim();
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        lastErr = new Error('model timeout after ' + (Date.now() - startTime) + 'ms');
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('xkiro call failed');
}

async function solveTextImage(tabId, b64, mime) {
  const messages = [
    {
      role: 'system',
      content:
        'You are CAPTCHA_OCR, a precision optical character recognition engine for distorted text CAPTCHAs.\n\n' +
        'TASK: Transcribe the exact characters rendered in the image.\n\n' +
        'RULES:\n' +
        '1. The image contains a short sequence of characters (letters, digits, or both), often distorted, rotated, overlapping, or obscured by noise lines, dots, waves, or color gradients.\n' +
        '2. Mentally filter out ALL noise: background patterns, strikethrough lines, speckles, gradients, and borders. Focus ONLY on the character glyphs.\n' +
        '3. Distinguish confusable glyphs carefully: 0 vs O vs o, 1 vs l vs I vs |, 5 vs S, 8 vs B, 2 vs Z, 6 vs G, 9 vs g, U vs V, C vs c.\n' +
        '4. Preserve the case style you observe: if characters look uppercase, output uppercase; if lowercase, output lowercase. Mixed case → mixed.\n' +
        '5. Output the characters with NO spaces between them unless a space is clearly visible in the image.\n' +
        '6. Output NOTHING except the transcribed characters. No explanations, no quotes, no labels, no punctuation that is not in the image, no markdown.\n\n' +
        'EXAMPLES:\n' +
        'Image shows "r e a l" spaced out → output: real\n' +
        'Image shows "W6 2RZ" → output: W62RZ\n' +
        'Image shows "5PSJ8" → output: 5PSJ8\n' +
        'Image shows "d2hm2" → output: d2hm2\n\n' +
        'If the image contains no readable characters at all, output a single question mark: ?'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe the captcha characters now. Remember: output ONLY the characters, nothing else.' },
        { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/png') + ';base64,' + b64 } }
      ]
    }
  ];
  return await xkiroChat(tabId, messages, { maxTokens: 32, timeoutMs: 25000 });
}

async function solveTextQuestion(tabId, question) {
  const messages = [
    {
      role: 'system',
      content:
        'You solve text-based CAPTCHA questions.\n' +
        'Reply with ONLY the answer — one word, number, or day name.\n' +
        'No explanation, no punctuation, no "The answer is".\n' +
        'Examples:\n' +
        'Q: If tomorrow is Saturday, what day is today? → friday\n' +
        'Q: What is 7 + 5? → 12\n' +
        'Q: How many letters are in the word "captcha"? → 7'
    },
    {
      role: 'user',
      content: 'Q: ' + question + '\nA:'
    }
  ];
  return await xkiroChat(tabId, messages, { maxTokens: 24, timeoutMs: 18000 });
}

async function captureElementRect(tab, rect) {
  if (!tab || !tab.id) throw new Error('No active tab in sender');
  let windowId = tab.windowId;
  if (windowId == null) {
    const tabObj = await chrome.tabs.get(tab.id).catch(() => null);
    windowId = tabObj ? tabObj.windowId : undefined;
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (!dataUrl) throw new Error('captureVisibleTab returned empty dataUrl');

  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const fullBitmap = await createImageBitmap(blob);
  const fullW = fullBitmap.width;
  const fullH = fullBitmap.height;

  const dpr = (rect && rect.dpr) || 1;
  const rawX = Math.round(rect.x * dpr);
  const rawY = Math.round(rect.y * dpr);
  const rawW = Math.round(rect.width * dpr);
  const rawH = Math.round(rect.height * dpr);

  const clampX = Math.max(0, Math.min(rawX, fullW - 1));
  const clampY = Math.max(0, Math.min(rawY, fullH - 1));
  const clampW = Math.max(1, Math.min(rawW, fullW - clampX));
  const clampH = Math.max(1, Math.min(rawH, fullH - clampY));

  const canvas = new OffscreenCanvas(clampW, clampH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(fullBitmap, clampX, clampY, clampW, clampH, 0, 0, clampW, clampH);
  fullBitmap.close();

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  const arrayBuffer = await croppedBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function solveGeeTestVision(tabId, b64, mime) {
  const messages = [
    {
      role: 'system',
      content:
        'You are an expert computer vision system analyzing jigsaw slider CAPTCHA images.\n' +
        'TASK: Find the horizontal pixel coordinate (X position) of the missing jigsaw puzzle piece cutout hole.\n\n' +
        'RULES:\n' +
        '1. The image shows a background scene with a missing puzzle cutout hole/slot.\n' +
        '2. The image width is typically 260 to 300 pixels.\n' +
        '3. Locate the LEFT edge of the missing jigsaw cutout hole.\n' +
        '4. Reply with ONLY the integer number of the X pixel coordinate (e.g. 136). Do not write words, explanations, or units.\n\n' +
        'Example output: 142'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Where is the left edge of the missing jigsaw puzzle cutout? Output ONLY the integer X pixel coordinate.' },
        { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/png') + ';base64,' + b64 } }
      ]
    }
  ];
  const reply = await xkiroChat(tabId, messages, { maxTokens: 16, timeoutMs: 20000 });
  const num = parseInt(String(reply).replace(/[^0-9]/g, ''), 10);
  if (isNaN(num) || num < 20 || num > 280) {
    throw new Error('Unusable vision coordinate: ' + reply);
  }
  return num;
}

async function calculateGeeTestGap(tabId, msg) {
  let bgBlob = null;
  let sliceBlob = null;
  let fullbgBlob = null;

  if (msg.bgUrl) {
    const bgResp = await fetch(msg.bgUrl);
    bgBlob = await bgResp.blob();
  } else if (msg.bgB64) {
    const bytes = Uint8Array.from(atob(msg.bgB64), (c) => c.charCodeAt(0));
    bgBlob = new Blob([bytes], { type: msg.mime || 'image/png' });
  }

  if (msg.fullbgUrl) {
    try {
      const fullResp = await fetch(msg.fullbgUrl);
      fullbgBlob = await fullResp.blob();
    } catch {}
  } else if (msg.fullbgB64) {
    try {
      const bytes = Uint8Array.from(atob(msg.fullbgB64), (c) => c.charCodeAt(0));
      fullbgBlob = new Blob([bytes], { type: 'image/png' });
    } catch {}
  }

  if (msg.sliceUrl) {
    try {
      const sliceResp = await fetch(msg.sliceUrl);
      sliceBlob = await sliceResp.blob();
    } catch {}
  } else if (msg.sliceB64) {
    try {
      const bytes = Uint8Array.from(atob(msg.sliceB64), (c) => c.charCodeAt(0));
      sliceBlob = new Blob([bytes], { type: 'image/png' });
    } catch {}
  }

  if (!bgBlob) throw new Error('No background image data provided');

  const [bgBitmap, sliceBitmap, fullbgBitmap] = await Promise.all([
    createImageBitmap(bgBlob),
    sliceBlob ? createImageBitmap(sliceBlob).catch(() => null) : null,
    fullbgBlob ? createImageBitmap(fullbgBlob).catch(() => null) : null
  ]);

  const bw = bgBitmap.width;
  const bh = bgBitmap.height;
  const bgCanvas = new OffscreenCanvas(bw, bh);
  const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
  bgCtx.drawImage(bgBitmap, 0, 0);
  const bgData = bgCtx.getImageData(0, 0, bw, bh).data;
  bgBitmap.close();

  // background pixel diff method
  if (fullbgBitmap) {
    const fullCanvas = new OffscreenCanvas(fullbgBitmap.width, fullbgBitmap.height);
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    fullCtx.drawImage(fullbgBitmap, 0, 0);
    const fullData = fullCtx.getImageData(0, 0, fullbgBitmap.width, fullbgBitmap.height).data;
    fullbgBitmap.close();

    let sliceMinX = 5;
    if (sliceBitmap) {
      const sw = sliceBitmap.width;
      const sh = sliceBitmap.height;
      const sliceCanvas = new OffscreenCanvas(sw, sh);
      const sliceCtx = sliceCanvas.getContext('2d', { willReadFrequently: true });
      sliceCtx.drawImage(sliceBitmap, 0, 0);
      const sliceData = sliceCtx.getImageData(0, 0, sw, sh).data;
      for (let x = 0; x < sw; x++) {
        let found = false;
        for (let y = 0; y < sh; y++) {
          if (sliceData[(y * sw + x) * 4 + 3] > 100) {
            sliceMinX = x;
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    let firstGapX = 0;
    for (let x = 40; x < bw - 20; x++) {
      let diffCount = 0;
      for (let y = 0; y < bh; y++) {
        const idx = (y * bw + x) * 4;
        const d = Math.abs(bgData[idx] - fullData[idx]) +
                  Math.abs(bgData[idx + 1] - fullData[idx + 1]) +
                  Math.abs(bgData[idx + 2] - fullData[idx + 2]);
        if (d > 50) diffCount++;
      }
      if (diffCount > 5) {
        firstGapX = x;
        break;
      }
    }

    if (firstGapX >= 40) {
      const bestDx = firstGapX - sliceMinX;
      ccLog(tabId, 'GEETEST: canvas diff ground truth gapX=' + bestDx);
      if (sliceBitmap) sliceBitmap.close();
      return { gapX: bestDx, directDistance: true, naturalWidth: bw, naturalHeight: bh, method: 'canvas_diff' };
    }
  }

  // gradient correlation method
  if (sliceBitmap) {
    const sw = sliceBitmap.width;
    const sh = sliceBitmap.height;
    const sliceCanvas = new OffscreenCanvas(sw, sh);
    const sliceCtx = sliceCanvas.getContext('2d', { willReadFrequently: true });
    sliceCtx.drawImage(sliceBitmap, 0, 0);
    const sliceData = sliceCtx.getImageData(0, 0, sw, sh).data;
    sliceBitmap.close();

    const mask = [];
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const a = sliceData[(y * sw + x) * 4 + 3];
        if (a > 100) {
          const aL = sliceData[(y * sw + (x - 1)) * 4 + 3];
          const aR = sliceData[(y * sw + (x + 1)) * 4 + 3];
          const aT = sliceData[((y - 1) * sw + x) * 4 + 3];
          const aB = sliceData[((y + 1) * sw + x) * 4 + 3];
          if (aL < 50 || aR < 50 || aT < 50 || aB < 50) {
            mask.push({ x, y });
          }
        }
      }
    }

    if (mask.length > 20) {
      const sliceY = typeof msg.relativeY === 'number' ? msg.relativeY : 70;
      const minY = Math.max(1, sliceY - 10);
      const maxY = Math.min(bh - 2, sliceY + sh + 10);

      const bgGrad = new Float32Array(bw * bh);
      for (let y = minY; y <= maxY; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const idx = (y * bw + x) * 4;
          const b = bgData[idx] * 0.299 + bgData[idx + 1] * 0.587 + bgData[idx + 2] * 0.114;
          const bR = bgData[idx + 4] * 0.299 + bgData[idx + 5] * 0.587 + bgData[idx + 6] * 0.114;
          const bB = bgData[idx + bw * 4] * 0.299 + bgData[idx + bw * 4 + 1] * 0.587 + bgData[idx + bw * 4 + 2] * 0.114;
          const gx = bR - b;
          const gy = bB - b;
          bgGrad[y * bw + x] = Math.sqrt(gx * gx + gy * gy);
        }
      }

      let bestDx = 40;
      let maxScore = 0;
      for (let dx = 35; dx < bw - sw + 20; dx++) {
        let score = 0;
        for (const pt of mask) {
          const gx = dx + pt.x;
          const gy = sliceY + pt.y;
          if (gx >= 0 && gx < bw && gy >= 0 && gy < bh) {
            score += bgGrad[gy * bw + gx];
          }
        }
        if (score > maxScore) {
          maxScore = score;
          bestDx = dx;
        }
      }

      if (maxScore > 800) {
        ccLog(tabId, 'GEETEST: edge mask correlation bestDx=' + bestDx + ' score=' + Math.round(maxScore));
        return { gapX: bestDx, directDistance: true, naturalWidth: bw, naturalHeight: bh, method: 'edge_mask' };
      }
    }
  }

  // shadow edge detection
  const shadowScores = new Array(bw).fill(0);
  for (let x = 45; x < bw - 45; x++) {
    for (let y = 12; y < bh - 12; y++) {
      const idx = (y * bw + x) * 4;
      const brightness = (bgData[idx] * 0.299 + bgData[idx + 1] * 0.587 + bgData[idx + 2] * 0.114);
      if (brightness < 68 && x >= 3) {
        const lIdx = (y * bw + (x - 3)) * 4;
        const lBrightness = (bgData[lIdx] * 0.299 + bgData[lIdx + 1] * 0.587 + bgData[lIdx + 2] * 0.114);
        if (lBrightness - brightness > 25) {
          shadowScores[x]++;
        }
      }
    }
  }

  let bestX = 0, maxScore = 0;
  for (let x = 45; x < bw - 45; x++) {
    let win = 0;
    for (let k = -2; k <= 2; k++) win += shadowScores[x + k] || 0;
    if (win > maxScore) {
      maxScore = win;
      bestX = x;
    }
  }

  if (maxScore >= 40 && bestX >= 48) {
    ccLog(tabId, 'GEETEST: shadow edge analysis bestX=' + bestX + ' score=' + maxScore);
    return { gapX: bestX, minX: 14, naturalWidth: bw, naturalHeight: bh, method: 'shadow' };
  }

  // ai vision fallback
  try {
    let b64 = msg.bgB64;
    if (!b64 && bgBlob) {
      const arrayBuffer = await bgBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      b64 = btoa(binary);
    }
    if (b64) {
      ccLog(tabId, 'GEETEST: calling Qwen Vision model...');
      const x = await solveGeeTestVision(tabId, b64, 'image/png');
      return { gapX: x, minX: 14, naturalWidth: bw, naturalHeight: bh, method: 'vision' };
    }
  } catch (e) {
    ccLog(tabId, 'GEETEST: vision fallback error: ' + (e.message || e), 'warn');
  }

  if (bestX > 30) {
    return { gapX: bestX, minX: 14, naturalWidth: bw, naturalHeight: bh, method: 'shadow_fallback' };
  }

  throw new Error('Could not confidently calculate GeeTest gap position');
}



