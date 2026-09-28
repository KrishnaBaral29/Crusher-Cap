# CaptchaCrusher — reCAPTCHA Audio Solver (NopeCHA Alternative)

Browser extension (Chrome MV3) that auto-solves **reCAPTCHA v2** via the **audio challenge** and harvests **reCAPTCHA v3** tokens.

## Install (Load Unpacked)
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `Nopecha-Alternative` folder
4. Pin the extension (puzzle icon → pin)

## Configure STT
Open the extension popup → pick provider → paste API key:
- **OpenAI Whisper** (recommended, best accuracy): key from platform.openai.com
- **wit.ai** (free): create app at wit.ai → copy server token
- **IBM Watson**: key + instance URL
- **Custom**: your own endpoint accepting `{audio_b64, mime}` → returns `{text}`

## How It Works
- **v2 checkbox**: click "Solve This Tab" (or auto-solve when challenge opens) → challenge is switched to audio → MP3 downloaded → sent to speech-to-text → digits typed in with human-like delays → verified → retries with randomized delays on failure (rate-limit aware)
- **v3 invisible**: no audio exists — it's score-based. Button "Get v3 Token" runs `grecaptcha.execute` in the page, copies the token. Score depends on your IP/fingerprint — a residential IP scores high.

## Test Sites (v2 + v3 demos)
- https://www.google.com/recaptcha/api2/demo — official v2 demo
- https://recaptcha-demo.appspot.com/ — v2 checkbox + v3 pages
- https://2captcha.com/demo/recaptcha-v2 and /demo/recaptcha-v3
- https://antcpt.com/engin/ — v3 score tester
- https://nopecha.com/demo/recaptcha — v2 + v3 tabs
- https://democaptcha.com/demo-form-eng/recaptcha-v2.html

## Where These Captchas Appear in the Wild
Signup/login pages (Google, Discord, Steam), WordPress comment forms, contact forms, checkout flows, ticketing sites, sneaker drops, betting sites, API portals.

## Files
```
manifest.json              MV3 config
background/service-worker  STT routing + v3 token harvester
content/page-detector      detects v2/v3 widgets on pages
content/recaptcha-frames   solver loop inside recaptcha iframes
lib/stt.js                 providers: OpenAI / wit / Watson / custom
popup/                     status + settings UI
options/                   full settings page
```
