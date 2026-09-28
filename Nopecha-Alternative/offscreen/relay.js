// sandbox message relay

const frame = document.getElementById('sbframe');
const pending = new Map();
let msgId = 0;
let frameReady = false;

frame.addEventListener('load', () => {
  frameReady = true;
  frame.contentWindow.postMessage({
    type: 'SB_INIT',
    voskModelUrl: chrome.runtime.getURL('lib/vosk/model.tar.gz')
  }, '*');
});

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'SB_PONG':
      frameReady = true;
      break;
    case 'SB_RESULT': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p(msg);
      }
      break;
    }
    case 'SB_LOG': {
      try { chrome.runtime.sendMessage({ type: 'LOG', line: msg.line, level: msg.level || 'info' }).catch(() => {}); } catch {}
      console.log('[CC][sandbox]', msg.line);
      break;
    }
  }
});

async function waitForFrame(timeoutMs) {
  const start = Date.now();
  while (!frameReady && Date.now() - start < timeoutMs) {
    try { frame.contentWindow.postMessage({ type: 'SB_PING' }, '*'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return frameReady;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_RECORD') {
    startTabRecording(msg.streamId).then(sendResponse);
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP_RECORD') {
    sendResponse(stopTabRecording());
    return true;
  }

  if (msg.type === 'SB_TRANSCRIBE') {
    (async () => {
      const ok = await waitForFrame(15000);
      if (!ok) {
        sendResponse({ ok: false, error: 'sandbox iframe never loaded' });
        return;
      }
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        sendResponse({ ok: false, error: 'sandbox engine timeout (90s)' });
      }, 90000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        sendResponse(result);
      });
      frame.contentWindow.postMessage({
        type: 'SB_TRANSCRIBE',
        id,
        engine: msg.engine,
        audioBytes: msg.audioBytes,
        mime: msg.mime
      }, '*');
    })();
    return true;
  }
});

// tab video recording
let activeTabRecorder = null;
let activeStream = null;
let recordedChunks = [];

// start tab recorder
async function startTabRecording(streamId) {
  try {
    if (activeTabRecorder && activeTabRecorder.state !== 'inactive') {
      activeTabRecorder.stop();
    }
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    activeStream = stream;
    recordedChunks = [];
    activeTabRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

    activeTabRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    activeTabRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
        activeStream = null;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          dataUrl: reader.result,
          size: blob.size
        }).catch(() => {});
      };
      reader.readAsDataURL(blob);
    };

    activeTabRecorder.start(1000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// stop tab recorder
function stopTabRecording() {
  if (activeTabRecorder && activeTabRecorder.state !== 'inactive') {
    activeTabRecorder.stop();
    return { ok: true };
  }
  return { ok: false, error: 'no active recording' };
}

