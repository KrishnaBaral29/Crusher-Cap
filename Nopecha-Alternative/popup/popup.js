const $ = (id) => document.getElementById(id);
let currentTabId = null;
let errorsOnly = false;
let lastRenderedLogs = [];

const PROVIDER_KEYS = [
  'solve_hcaptcha',
  'solve_recaptcha',
  'solve_turnstile',
  'solve_funcaptcha',
  'solve_awscaptcha',
  'solve_textcaptcha',
  'solve_human',
  'solve_geetest',
  'solve_lemin'
];

function applyTheme(theme) {
  const t = theme || 'dark';
  document.documentElement.setAttribute('data-theme', t);
}

// Initial theme check
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
  chrome.storage.sync.get(['theme'], (res) => {
    if (res && res.theme) applyTheme(res.theme);
  });
}

// Tab Switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = document.getElementById(btn.dataset.tab);
    if (pane) pane.classList.add('active');
  });
});

// Log Filters
if ($('btn-filter-all')) {
  $('btn-filter-all').addEventListener('click', (e) => {
    e.stopPropagation();
    errorsOnly = false;
    $('btn-filter-all').classList.add('active');
    if ($('btn-filter-err')) $('btn-filter-err').classList.remove('active');
    if ($('btn-copylogs')) $('btn-copylogs').textContent = 'Copy logs';
    refresh();
  });
}
if ($('btn-filter-err')) {
  $('btn-filter-err').addEventListener('click', (e) => {
    e.stopPropagation();
    errorsOnly = true;
    $('btn-filter-err').classList.add('active');
    if ($('btn-filter-all')) $('btn-filter-all').classList.remove('active');
    if ($('btn-copylogs')) $('btn-copylogs').textContent = 'Copy errors';
    refresh();
  });
}

// Provider Toggles
PROVIDER_KEYS.forEach((key) => {
  const row = document.querySelector(`.provider-row[data-key="${key}"]`);
  if (!row) return;
  const input = row.querySelector('input');
  if (!input) return;

  input.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    row.classList.toggle('active', isChecked);
    chrome.storage.sync.set({ [key]: isChecked });
  });
});

function render(state, settings, logs, recState) {
  if (!state) return;
  settings = settings || {};
  // render status box
  const dot = $('status-dot');
  const txt = $('status-text');
  const info = $('attempt-info');
  if (dot) dot.className = 'dot ' + (state.status || 'idle');
  if (txt) txt.textContent = state.message || (state.status || 'idle');
  if (info) info.textContent = 'attempt ' + (state.attempt || 0) + ' · solved this tab: ' + (state.solvedCount || 0);

  // render activity logs
  if (logs) {
    lastRenderedLogs = logs;
    const filtered = errorsOnly ? logs.filter((l) => l.level === 'error') : logs;
    const pre = $('logs');
    if (pre) {
      pre.textContent = filtered.length
        ? filtered.slice(-60).map((l) => `${l.ts} [${(l.level || 'info').toUpperCase()}] ${l.line}`).join('\n')
        : (errorsOnly ? 'no errors — clean run' : 'no activity logs yet');
      pre.scrollTop = pre.scrollHeight;
    }
  }

  // Provider Toggles state
  PROVIDER_KEYS.forEach((key) => {
    const row = document.querySelector(`.provider-row[data-key="${key}"]`);
    if (!row) return;
    const input = row.querySelector('input');
    if (!input) return;

    // default provider states
    let isChecked = false;
    if (
      key === 'solve_recaptcha' ||
      key === 'solve_turnstile' ||
      key === 'solve_textcaptcha' ||
      key === 'solve_geetest' ||
      key === 'solve_funcaptcha'
    ) {
      isChecked = settings[key] !== false;
    } else {
      isChecked = !!settings[key];
    }
    input.checked = isChecked;
    row.classList.toggle('active', isChecked);
  });

  // apply settings values
  if ($('opt-theme')) $('opt-theme').value = settings.theme || 'dark';
  applyTheme(settings.theme || 'dark');
  if ($('opt-maxattempts')) $('opt-maxattempts').value = settings.maxAttempts || 6;
  
  // update solved badge
  const totalSolved = settings.solvedCount || 0;
  if ($('solved-count')) {
    $('solved-count').textContent = totalSolved + ' captcha' + (totalSolved === 1 ? '' : 's') + ' solved';
  }

  const v = state.version;
  const p = state.provider;
  const badge = $('detected-badge');
  if (badge) {
    if (p === 'funcaptcha' || v === 'funcaptcha') {
      badge.className = 'badge funcaptcha';
      badge.textContent = 'funcaptcha';
    } else if (p === 'geetest' || v === 'geetest') {
      badge.className = 'badge geetest';
      badge.textContent = 'geetest';
    } else if (p === 'turnstile' || v === 'turnstile') {
      badge.className = 'badge turnstile';
      badge.textContent = 'turnstile';
    } else if (p === 'textcaptcha' || v === 'textcaptcha') {
      badge.className = 'badge v2';
      badge.textContent = 'captcha';
    } else if (v === 2) {
      badge.className = 'badge v2';
      badge.textContent = 'v2 detected';
    } else if (v === 3) {
      badge.className = 'badge v3';
      badge.textContent = 'v3 detected';
    } else {
      badge.className = 'badge none';
      badge.textContent = 'no captcha';
    }
  }
  if (recState) updateRecordUI(recState);
}

function refresh() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    currentTabId = tab.id;
    chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: tab.id }, (resp) => {
      if (chrome.runtime.lastError) {
        if ($('status-text')) $('status-text').textContent = 'background: ' + chrome.runtime.lastError.message;
        return;
      }
      if (resp && resp.ok) render(resp.state, resp.settings, resp.logs, resp.recordingState);
    });
  });
}

// bind settings listeners
if ($('opt-theme')) {
  $('opt-theme').addEventListener('change', (e) => {
    const theme = e.target.value;
    applyTheme(theme);
    chrome.storage.sync.set({ theme });
  });
}
if ($('opt-maxattempts')) {
  $('opt-maxattempts').addEventListener('change', (e) => {
    chrome.storage.sync.set({ maxAttempts: parseInt(e.target.value, 10) || 6 });
  });
}


if ($('btn-copylogs')) {
  $('btn-copylogs').addEventListener('click', () => {
    const list = lastRenderedLogs && lastRenderedLogs.length ? lastRenderedLogs : [];
    const filtered = errorsOnly ? list.filter((l) => l.level === 'error') : list;
    const text = filtered.length
      ? filtered.map((l) => `${l.ts} [${(l.level || 'info').toUpperCase()}] ${l.line}`).join('\n')
      : (errorsOnly ? 'no errors logged' : 'no activity logged');
    navigator.clipboard.writeText(text);
    $('btn-copylogs').textContent = 'copied ✓';
    setTimeout(() => {
      $('btn-copylogs').textContent = errorsOnly ? 'Copy errors' : 'Copy logs';
    }, 1200);
  });
}

// record state variables
let isRecording = false;
let recordStartTime = 0;
let recordInterval = null;

// update recording ui
function updateRecordUI(recState) {
  if (!recState) return;
  isRecording = !!recState.isRecording;
  recordStartTime = recState.startTime || 0;

  const btn = $('btn-record');
  const txt = $('record-btn-text');
  const timer = $('record-timer');
  const note = $('record-status-note');

  if (isRecording) {
    if (btn) btn.classList.add('recording');
    if (txt) txt.textContent = 'Stop Recording';
    if (timer) timer.style.display = 'inline-block';
    if (!recordInterval) {
      recordInterval = setInterval(updateRecordTimer, 500);
      updateRecordTimer();
    }
    if (note) note.textContent = 'capturing website...';
  } else {
    if (btn) btn.classList.remove('recording');
    if (txt) txt.textContent = 'Record';
    if (timer) timer.style.display = 'none';
    if (recordInterval) {
      clearInterval(recordInterval);
      recordInterval = null;
    }
    if (recState.lastFile) {
      if (note) note.textContent = 'saved to Recordings/';
    } else {
      if (note) note.textContent = '';
    }
  }
}

// update recording timer
function updateRecordTimer() {
  if (!isRecording || !recordStartTime) return;
  const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  const timer = $('record-timer');
  if (timer) timer.textContent = `${m}:${s}`;
}

// bind record button
if ($('btn-record')) {
  $('btn-record').addEventListener('click', () => {
    if (!currentTabId) return;
    if (isRecording) {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, () => {
        if (chrome.runtime.lastError) {}
        updateRecordUI({ isRecording: false, lastFile: 'saving' });
      });
    } else {
      chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: currentTabId }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok) {
          updateRecordUI(resp.recordingState);
        }
      });
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' && msg.state && msg.state.tabId === currentTabId) {
    refresh();
  }
  if (msg.type === 'RECORDING_STATUS' && msg.recordingState) {
    updateRecordUI(msg.recordingState);
  }
});

refresh();
setInterval(refresh, 2500);

