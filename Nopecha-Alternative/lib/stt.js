// speech recognition provider chain

// primary google speech key
const GOOGLE_FREE_KEY = 'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw';

// backup google keys
const GOOGLE_FALLBACK_KEYS = [
  'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
  'AIzaSyDCWh5I-4tTTUCNYUYH6FNSkucE4OLLIYs',
  'AIzaSyCkc7PK3QzPIR3qs3dBGNKBKoXwGNLlFOY'
];

async function transcribe(opts) {
  const { provider } = opts;
  switch (provider) {
    case 'google':    return await viaGoogleFree(opts);
    case 'google2':   return await viaGoogleFreeAlt(opts);   // second Google endpoint
    case 'wit-free':  return await viaWitFree(opts);         // Wit.ai without a key (public demo)
    case 'openai':    return await viaOpenAI(opts);
    case 'wit':       return await viaWit(opts);
    case 'watson':    return await viaWatson(opts);
    case 'custom':    return await viaCustom(opts);
    default:          return await viaGoogleFree(opts);
  }
}

// google speech v2 provider
async function viaGoogleFree({ bytes }) {
  // raw pcm format required
  const pcm = stripWavHeader(bytes);

  for (const key of GOOGLE_FALLBACK_KEYS) {
    try {
      const resp = await fetch(
        'https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=' + key,
        {
          method: 'POST',
          headers: { 'Content-Type': 'audio/l16; rate=16000' },
          body: new Blob([pcm], { type: 'audio/l16' })
        }
      );
      if (resp.status === 403 || resp.status === 429) continue; // try next key
      if (!resp.ok) throw new Error('Google STT ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
      const raw = await resp.text();
      let text = '';
      for (const line of raw.trim().split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.result && j.result.length && j.result[0].alternative && j.result[0].alternative.length) {
            text = j.result[0].alternative[0].transcript || text;
          }
        } catch {}
      }
      if (text) return text;
    } catch (e) {
      if (e.message && e.message.includes('403')) continue;
      throw e;
    }
  }
  return '';
}

// google cloud speech provider
async function viaGoogleFreeAlt({ bytes }) {
  const pcm = stripWavHeader(bytes);
  const b64 = bytesToB64(pcm);
  const body = JSON.stringify({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'en-US',
      model: 'command_and_search',
      useEnhanced: false
    },
    audio: { content: b64 }
  });

  const resp = await fetch(
    'https://speech.googleapis.com/v1/speech:recognize?key=' + GOOGLE_FREE_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }
  );
  if (!resp.ok) throw new Error('Google v1 STT ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  if (!data.results || !data.results.length) return '';
  return data.results.map((r) => r.alternatives[0].transcript).join(' ');
}

function stripWavHeader(bytes) {
  // extract pcm data chunk
  if (bytes.length < 12) return bytes;
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!isRiff) return bytes;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const size = bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24);
    if (id === 'data') return bytes.subarray(off + 8, Math.min(off + 8 + size, bytes.length));
    off += 8 + size + (size % 2);
  }
  return bytes;
}

// openai whisper speech provider
async function viaOpenAI({ apiKey, model, bytes, mime }) {
  if (!apiKey) throw new Error('OpenAI API key missing');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), 'audio.wav');
  form.append('model', model || 'whisper-1');
  form.append('language', 'en');
  form.append('prompt', 'Only English digits spoken aloud: zero one two three four five six seven eight nine.');
  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: form
  });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  return data.text || '';
}

// wit ai speech provider
async function viaWit({ apiKey, bytes, mime }) {
  if (!apiKey) throw new Error('wit.ai key missing');
  return _witRequest(apiKey, bytes, mime);
}

// public wit tokens
async function viaWitFree({ bytes, mime }) {
  const TOKENS = [
    'JVHWCNWJLTWSNWHKQW4TFZDBZORWMWRM',
    'RRLM4MRXACVBJ7XQVHPKLLPHNPQPVQKL'
  ];
  for (const tok of TOKENS) {
    try {
      const text = await _witRequest(tok, bytes, mime);
      if (text) return text;
    } catch {}
  }
  throw new Error('wit-free: all public tokens failed');
}

async function _witRequest(token, bytes, mime) {
  const resp = await fetch('https://api.wit.ai/speech?v=20240304', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': mime || 'audio/wav'
    },
    body: new Blob([bytes], { type: mime || 'audio/wav' })
  });
  if (!resp.ok) throw new Error('wit.ai ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  const raw = await resp.text();
  try {
    const lines = raw.trim().split('\n');
    const data = JSON.parse(lines[lines.length - 1]);
    return data.text || '';
  } catch {
    return raw.slice(0, 150);
  }
}

// watson speech provider
async function viaWatson({ apiKey, watsonUrl, bytes, mime }) {
  if (!apiKey) throw new Error('Watson key missing');
  if (!watsonUrl) throw new Error('Watson instance URL missing');
  const resp = await fetch(watsonUrl.replace(/\/$/, '') + '/v1/recognize?model=en-US_BroadbandModel', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa('apikey:' + apiKey),
      'Content-Type': mime || 'audio/mpeg'
    },
    body: new Blob([bytes], { type: mime })
  });
  if (!resp.ok) throw new Error('Watson ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  if (!data.results || !data.results.length) return '';
  return data.results.map((r) => r.alternatives[0].transcript).join(' ');
}

// custom endpoint provider
async function viaCustom({ customEndpoint, bytes, mime }) {
  if (!customEndpoint) throw new Error('Custom endpoint missing');
  const b64 = bytesToB64(bytes);
  const resp = await fetch(customEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_b64: b64, mime })
  });
  if (!resp.ok) throw new Error('Custom STT ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  return data.text || '';
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
