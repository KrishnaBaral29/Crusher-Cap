let model = null;
let ready = false;
let initPromise = null;

const MODEL_URL = chrome.runtime.getURL('lib/vosk/model.tar.gz');

function report(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (typeof Vosk === 'undefined') throw new Error('vosk.js failed to load (script tag missing or blocked)');
      report({ type: 'LOG', line: '[vosk] engine loaded — downloading/extracting model (one-time)', level: 'info' });
      model = await Vosk.createModel(MODEL_URL);
      ready = true;
      report({ type: 'LOG', line: '[vosk] model READY — offline STT armed', level: 'info' });
      report({ type: 'VOSK_READY' });
    } catch (e) {
      report({ type: 'LOG', line: '[vosk] init failed: ' + String(e.message || e), level: 'error' });
      report({ type: 'VOSK_ERROR', error: String(e.message || e) });
    }
  })();
  return initPromise;
}

async function recognize(b64, mime) {
  if (!ready) {
    await init();
    if (!ready) return { ok: false, error: 'vosk model not ready (still loading or failed)' };
  }
  try {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const ctx = new AudioContext({ sampleRate: 16000 });
    const decoded = await ctx.decodeAudioData(u8.buffer);
    await ctx.close();

    const recognizer = new model.KaldiRecognizer(16000, '["one two three four five six seven eight nine zero oh", "[unk]"]');
    recognizer.setWords(false);

    const channel = decoded.getChannelData(0);
    const chunkSize = 4096 * 4;
    let finalText = '';

    for (let off = 0; off < channel.length; off += chunkSize) {
      const chunk = channel.subarray(off, Math.min(off + chunkSize, channel.length));
      const f32 = new Float32Array(chunk.length);
      f32.set(chunk);
      const accepted = recognizer.acceptWaveform(f32);
      if (accepted) {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VOSK_TRANSCRIBE') {
    recognize(msg.b64, msg.mime).then(sendResponse);
    return true;
  }
});

init();
