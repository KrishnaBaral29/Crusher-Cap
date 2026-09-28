// sandboxed stt worker

let puterReady = false;
let voskModel = null;
let voskReady = false;
let savedVoskUrl = null;
let voskInitPromise = null;

function sendToParent(payload) {
  try { window.parent.postMessage(payload, '*'); } catch (e) { console.error('sandbox send failed', e); }
}

// puter stt engine

async function initPuter() {
  for (let i = 0; i < 30; i++) {
    if (typeof puter !== 'undefined' && puter.ai && puter.ai.speech2txt) {
      puterReady = true;
      sendToParent({ type: 'SB_LOG', line: '[sandbox] puter.js loaded — keyless STT armed' });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  sendToParent({ type: 'SB_LOG', line: '[sandbox] puter.js never loaded', level: 'error' });
}

async function puterTranscribe(audioBytes, mime, id) {
  if (!puterReady) {
    await initPuter();
    if (!puterReady) return { ok: false, error: 'puter.js unavailable' };
  }
  const blob = new Blob([audioBytes], { type: mime || 'audio/wav' });
  const result = await puter.ai.speech2txt(blob);
  const text = (result && (result.text || result.transcript || result)) || '';
  return { ok: true, text: String(text) };
}

// vosk stt engine

async function initVosk(modelUrl) {
  if (voskReady) return true;
  if (voskInitPromise) return voskInitPromise;

  if (typeof Vosk === 'undefined') {
    return false;
  }
  
  const url = modelUrl || savedVoskUrl;
  if (!url) {
    sendToParent({ type: 'SB_LOG', line: '[sandbox] vosk: no model URL provided' });
    return false;
  }

  voskInitPromise = (async () => {
    try {
      sendToParent({ type: 'SB_LOG', line: '[sandbox] vosk: loading model (one-time extract)' });
      voskModel = await Vosk.createModel(url);
      voskReady = true;
      sendToParent({ type: 'SB_LOG', line: '[sandbox] vosk model READY — offline fallback armed' });
      return true;
    } catch (e) {
      sendToParent({ type: 'SB_LOG', line: '[sandbox] vosk init failed: ' + (e.message || e), level: 'error' });
      return false;
    }
  })();
  return voskInitPromise;
}

async function initVoskFromUrl(modelUrl) {
  return initVosk(modelUrl);
}

async function voskTranscribe(audioBytes, mime, id) {
  if (!voskReady) {
    const ok = await initVosk();
    if (!ok) return { ok: false, error: 'vosk not ready' };
  }
  try {
    const u8 = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
    const ctx = new AudioContext({ sampleRate: 16000 });
    const decoded = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    await ctx.close();

    const recognizer = new voskModel.KaldiRecognizer(16000, '["one two three four five six seven eight nine zero oh", "[unk]"]');
    const channel = decoded.getChannelData(0);
    const chunkSize = 4096 * 4;
    let finalText = '';
    for (let off = 0; off < channel.length; off += chunkSize) {
      const f32 = new Float32Array(channel.subarray(off, Math.min(off + chunkSize, channel.length)));
      if (recognizer.acceptWaveform(f32)) {
        const r = JSON.parse(recognizer.result());
        if (r.text) finalText += ' ' + r.text;
      }
    }
    const fr = JSON.parse(recognizer.finalResult());
    if (fr.text) finalText += ' ' + fr.text;
    recognizer.free();
    return { ok: true, text: finalText.trim() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// parent message protocol

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'SB_INIT': {
      // receive model url
      if (msg.voskModelUrl) {
        savedVoskUrl = msg.voskModelUrl;
        initVosk(msg.voskModelUrl);
      }
      initPuter();
      sendToParent({ type: 'SB_PONG' });
      break;
    }
    case 'SB_PING': {
      sendToParent({ type: 'SB_PONG' });
      break;
    }
    case 'SB_TRANSCRIBE': {
      const { id, engine, audioBytes, mime } = msg;
      // reconstruct audio array
      let u8;
      if (audioBytes instanceof Uint8Array) {
        u8 = audioBytes;
      } else if (Array.isArray(audioBytes)) {
        u8 = new Uint8Array(audioBytes);
      } else if (audioBytes && typeof audioBytes === 'object') {
        const len = Object.keys(audioBytes).filter((k) => !isNaN(k)).length;
        u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = audioBytes[i] || 0;
      } else {
        u8 = new Uint8Array(0);
      }
      try {
        const result = engine === 'puter'
          ? await puterTranscribe(u8, mime, id)
          : await voskTranscribe(u8, mime, id);
        sendToParent({ type: 'SB_RESULT', id, ...result });
      } catch (e) {
        sendToParent({ type: 'SB_RESULT', id, ok: false, error: String(e.message || e) });
      }
      break;
    }
  }
});
