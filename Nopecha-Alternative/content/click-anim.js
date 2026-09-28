// click animation engine
(() => {
  if (window.__ccClickAnimInstalled) return;
  window.__ccClickAnimInstalled = true;

  const STYLE_ID = '__cc_cursor_style__';
  let activeCursor = null;

  // ensure animation styles
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .__cc_anim_root {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        transform: translate(-50%, -50%);
        will-change: transform, opacity, left, top;
      }
      .__cc_ring {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid #00f2fe;
        background: radial-gradient(circle, rgba(0, 242, 254, 0.22) 0%, rgba(0, 198, 255, 0.05) 60%, transparent 100%);
        box-shadow: 0 0 12px rgba(0, 242, 254, 0.8), 0 0 24px rgba(0, 198, 255, 0.35), inset 0 0 8px rgba(0, 242, 254, 0.5);
        animation: __cc_ring_pop 0.22s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
      }
      .__cc_dot {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ffffff;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 6px #00f2fe, 0 0 10px #00f2fe;
      }
      .__cc_wave {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid rgba(0, 242, 254, 0.9);
        box-shadow: 0 0 10px rgba(0, 242, 254, 0.7);
        transform: translate(-50%, -50%) scale(0.6);
        animation: __cc_wave_expand 0.55s ease-out forwards;
      }
      @keyframes __cc_ring_pop {
        0% { transform: scale(0.3); opacity: 0; }
        60% { transform: scale(1.15); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes __cc_wave_expand {
        0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.95; }
        50% { opacity: 0.6; }
        100% { transform: translate(-50%, -50%) scale(2.3); opacity: 0; }
      }
      @keyframes __cc_fade_out {
        0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // display click animation
  function showClickAnim(x, y, duration = 650) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    ensureStyles();

    const host = document.createElement('div');
    host.className = '__cc_anim_root';
    host.style.left = `${Math.round(x)}px`;
    host.style.top = `${Math.round(y)}px`;

    const ring = document.createElement('div');
    ring.className = '__cc_ring';

    const dot = document.createElement('div');
    dot.className = '__cc_dot';

    const wave = document.createElement('div');
    wave.className = '__cc_wave';

    host.appendChild(ring);
    host.appendChild(dot);
    host.appendChild(wave);

    (document.body || document.documentElement).appendChild(host);

    setTimeout(() => {
      host.style.animation = '__cc_fade_out 0.25s ease-in forwards';
      setTimeout(() => host.remove(), 260);
    }, duration);
  }

  // move cursor during drag
  function moveCursor(x, y) {
    ensureStyles();
    if (!activeCursor) {
      activeCursor = document.createElement('div');
      activeCursor.className = '__cc_anim_root';
      const ring = document.createElement('div');
      ring.className = '__cc_ring';
      const dot = document.createElement('div');
      dot.className = '__cc_dot';
      activeCursor.appendChild(ring);
      activeCursor.appendChild(dot);
      (document.body || document.documentElement).appendChild(activeCursor);
    }
    activeCursor.style.left = `${Math.round(x)}px`;
    activeCursor.style.top = `${Math.round(y)}px`;
  }

  // release active cursor
  function releaseCursor(x, y) {
    if (activeCursor) {
      showClickAnim(x, y, 400);
      activeCursor.remove();
      activeCursor = null;
    }
  }

  window.__ccClickAnim = showClickAnim;
  window.__ccCursorMove = moveCursor;
  window.__ccCursorRelease = releaseCursor;

  // listen for animation messages
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'CC_CLICK_ANIM') {
      showClickAnim(e.data.x, e.data.y);
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'SHOW_CLICK_ANIM') {
        showClickAnim(msg.x, msg.y);
      }
    });
  }
})();
