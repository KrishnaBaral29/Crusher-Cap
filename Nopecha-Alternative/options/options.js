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

const DEFAULTS = {
  enabled: true,
  autoSolve: true,
  autoClick: true,
  solverMode: 'image',
  provider: 'google',
  visionApiKey: 'sk-xt-1f08ad192f4cfc85e0d9f9568c951e7922ce8ec4b12fe127',
  visionModel: 'qwen/qwen3.8-omni-flash:free',
  visionBaseUrl: 'https://api.xkiro.com/v1',
  maxAttempts: 6,
  minDelay: 1200,
  maxDelay: 3000,
  solvedCount: 0,
  // Captcha Providers toggles
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

const FIELD_KEYS = [
  'solverMode',
  'visionApiKey',
  'visionModel',
  'visionBaseUrl',
  'provider',
  'maxAttempts',
  'minDelay',
  'maxDelay'
];

const els = Object.fromEntries(FIELD_KEYS.map((k) => [k, document.getElementById(k)]));

// Provider Toggles UI
PROVIDER_KEYS.forEach((key) => {
  const row = document.querySelector(`.provider-row[data-key="${key}"]`);
  if (!row) return;
  const input = row.querySelector('input');
  if (!input) return;

  input.addEventListener('change', (e) => {
    row.classList.toggle('active', e.target.checked);
  });
});

chrome.storage.sync.get(DEFAULTS, (s) => {
  // Load input fields
  for (const k in els) {
    if (els[k]) {
      els[k].value = s[k] != null ? s[k] : DEFAULTS[k];
    }
  }

  // Load provider toggles
  PROVIDER_KEYS.forEach((key) => {
    const row = document.querySelector(`.provider-row[data-key="${key}"]`);
    if (!row) return;
    const input = row.querySelector('input');
    if (!input) return;

    let isChecked = false;
    if (
      key === 'solve_recaptcha' ||
      key === 'solve_turnstile' ||
      key === 'solve_textcaptcha' ||
      key === 'solve_geetest' ||
      key === 'solve_funcaptcha'
    ) {
      isChecked = s[key] !== false;
    } else {
      isChecked = !!s[key];
    }
    input.checked = isChecked;
    row.classList.toggle('active', isChecked);
  });
});

document.getElementById('save').addEventListener('click', () => {
  const out = {};
  for (const k in els) {
    if (els[k]) {
      out[k] = els[k].type === 'number' ? parseInt(els[k].value, 10) || DEFAULTS[k] : els[k].value;
    }
  }

  PROVIDER_KEYS.forEach((key) => {
    const row = document.querySelector(`.provider-row[data-key="${key}"]`);
    if (row) {
      const input = row.querySelector('input');
      if (input) out[key] = input.checked;
    }
  });

  chrome.storage.sync.set(out, () => {
    document.getElementById('saved').textContent = '✓ saved';
    setTimeout(() => { document.getElementById('saved').textContent = ''; }, 1500);
  });
});
