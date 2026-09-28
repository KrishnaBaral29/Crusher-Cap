with open(r"Nopecha-Alternative\background\service-worker.js", "r", encoding="utf-8") as f:
    content = f.read()

start_marker = "  // rotation challenge solver\n  if (isRotateChallenge && batchB64s && batchB64s.length > 0) {"
end_marker = "  }\n\n  // visual grid solver"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

old_block = content[start_idx:end_idx + 3]  # up to and including "  }"

new_block = r"""  // rotation challenge solver
  if (isRotateChallenge && batchB64s && batchB64s.length > 0) {
    ccLog(tabId, 'FUNCAPTCHA: ROT direct-visual solver — ' + total + ' candidates in ' + batchB64s.length + ' batch(es)');
    const rStart = Date.now();

    // object-type hint for front detection
    const objectHint = (() => {
      const p = (prompt || '').toLowerCase();
      if (/car|vehicle|suv|truck|van|auto/.test(p)) return 'Vehicle: FRONT = hood/headlight end (NOT the trunk/rear).';
      if (/lawn.?mow|mower/.test(p)) return 'Lawn mower: FRONT = blade-deck cutting end.';
      if (/motor.?bike|motorcycle|bike/.test(p)) return 'Motorcycle: FRONT = headlight/front-wheel end.';
      if (/plane|aircraft|jet/.test(p)) return 'Aircraft: FRONT = nose/cockpit end.';
      if (/boat|ship/.test(p)) return 'Boat: FRONT = bow (pointed end).';
      return 'Identify the FRONT of the 3D object (lights, sharp nose, cutting edge, etc).';
    })();

    const batchDescDirect = batchB64s.length === 1
      ? 'IMAGE 2: All ' + total + ' candidate tiles labelled [1] through [' + total + '].\n'
      : 'IMAGE 2: Candidate tiles [1]-[' + Math.ceil(total / 2) + '].\n' +
        'IMAGE 3: Candidate tiles [' + (Math.ceil(total / 2) + 1) + ']-[' + total + '].\n';

    // Pass 1: direct visual comparison with confidence score
    const directText =
      'ARKOSE FUNCAPTCHA -- 3D ROTATION CHALLENGE\n\n' +
      'IMAGE 1: Wooden hand indicator. FINGERTIPS show the REQUIRED direction.\n' +
      '  Look at where extended fingers AIM, not the palm or wrist.\n\n' +
      batchDescDirect + '\n' +
      'Each tile shows the SAME 3D object rotated differently.\n' +
      objectHint + '\n\n' +
      'TASK: Which tile has the object FRONT facing the same direction as the fingertips?\n\n' +
      'Step 1 -- Hand: Which compass direction do the fingertips point? (N/S/E/W/NE/NW/SE/SW)\n' +
      'Step 2 -- Tiles: For each tile [1]-[' + total + '], which direction does the FRONT face?\n' +
      'Step 3 -- Match: Which tile best matches the hand direction?\n' +
      'Step 4 -- Confidence: How confident are you? (0-100%)\n\n' +
      'Reply ONLY with this JSON:\n' +
      '{"handDirection": "<compass>", "tileFacings": ["<t1>","<t2>",...], "winningIndex": <1-' + total + '>, "confidence": <0-100>}';

    const directContent = [
      { type: 'text', text: directText },
      { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
    ];
    for (const b of batchB64s) directContent.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });

    let directWinner = null;
    let directConfidence = 0;

    try {
      const directReply = await chatReply({
        messages: [
          {
            role: 'system',
            content: 'You are a precise 3D orientation analyst. Analyze images carefully. Wrong answers are strictly prohibited. Reply ONLY with the specified JSON. No markdown, no extra text.'
          },
          { role: 'user', content: directContent }
        ],
        temperature: 0,
        max_tokens: 200
      }, 28000);

      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 reply: ' + String(directReply).trim().slice(0, 200));
      const djm = String(directReply).replace(/```[a-z]*/gi, '').match(/\{[\s\S]*?\}/);
      if (djm) {
        try {
          const dp = JSON.parse(djm[0]);
          const wi = parseInt(dp.winningIndex !== undefined ? dp.winningIndex : dp.winning_index, 10);
          const conf = parseInt(String(dp.confidence || '0'), 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) {
            directWinner = wi;
            directConfidence = isNaN(conf) ? 50 : conf;
            ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 winner=[' + directWinner + '] confidence=' + directConfidence + '% hand=' + (dp.handDirection || '?'));
          }
        } catch {}
      }
    } catch (e) {
      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 error: ' + (e.message || e), 'warn');
    }

    // Pass 2: low-confidence chain-of-thought retry with individual tiles
    if (directWinner !== null && directConfidence < 65) {
      ccLog(tabId, 'FUNCAPTCHA: ROT confidence=' + directConfidence + '% < 65 -- Pass-2 chain-of-thought', 'warn');

      const cotText =
        'ARKOSE FUNCAPTCHA -- ROTATION CHALLENGE (Deep Analysis)\n\n' +
        'IMAGE 1: Wooden hand indicator.\n' +
        'Remaining images: same 3D object in ' + total + ' different rotations, labelled [1]-[' + total + '].\n\n' +
        objectHint + '\n\n' +
        '-- ANALYSIS PROTOCOL (follow exactly, wrong answers forbidden) --\n\n' +
        'A) HAND: Trace wrist -> index/middle fingertips. State exact compass direction + clock position.\n\n' +
        'B) TILES: For each [1]-[' + total + '], state which compass direction the FRONT faces.\n' +
        '   Format: [1]=NE, [2]=W, [3]=S ...\n\n' +
        'C) MATCH: Which tile direction is closest to the hand direction? State your winner and why.\n\n' +
        'D) VERIFY: Re-examine chosen tile vs hand one more time. Update if needed.\n\n' +
        'Conclude with:\n' +
        'FINAL_ANSWER: {"winningIndex": <1-' + total + '>, "confidence": <0-100>}';

      const cotContent = [
        { type: 'text', text: cotText },
        { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
      ];
      // individual tiles at full resolution
      if (tileB64s && tileB64s.length > 0) {
        for (let t = 0; t < Math.min(tileB64s.length, total); t++) {
          if (tileB64s[t]) {
            cotContent.push({ type: 'text', text: 'Tile [' + (t + 1) + ']:' });
            cotContent.push({ type: 'image_url', image_url: { url: toDataUrl(tileB64s[t]) } });
          }
        }
      } else {
        for (const b of batchB64s) cotContent.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });
      }

      try {
        const cotReply = await chatReply({
          messages: [
            {
              role: 'system',
              content: 'You are an expert orientation analyst. Think carefully. Hallucinations and wrong answers are strictly forbidden. Follow the analysis protocol exactly.'
            },
            { role: 'user', content: cotContent }
          ],
          temperature: 0,
          max_tokens: 600
        }, 35000);

        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 CoT: ' + String(cotReply).trim().slice(0, 300));
        const faM = String(cotReply).match(/FINAL_ANSWER\s*:\s*(\{[\s\S]*?\})/i);
        if (faM) {
          try {
            const fap = JSON.parse(faM[1]);
            const wi = parseInt(fap.winningIndex !== undefined ? fap.winningIndex : fap.winning_index, 10);
            if (!isNaN(wi) && wi >= 1 && wi <= total) {
              const rDuration = Date.now() - rStart;
              ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 CoT WIN -- tile [' + wi + '] confidence=' + (fap.confidence || '?') + '% in ' + rDuration + 'ms');
              return { winningIndex: wi, raw: String(cotReply).trim(), durationMs: rDuration, targetDigit: -1, pass: 'rotation-cot' };
            }
          } catch {}
        }
        // fallback: parse any JSON from response
        const fbMs = String(cotReply).replace(/```[a-z]*/gi, '').match(/\{[\s\S]*?\}/g);
        if (fbMs) {
          for (const m of [...fbMs].reverse()) {
            try {
              const fp = JSON.parse(m);
              const wi = parseInt(fp.winningIndex !== undefined ? fp.winningIndex : fp.winning_index, 10);
              if (!isNaN(wi) && wi >= 1 && wi <= total) {
                const rDuration = Date.now() - rStart;
                ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 JSON WIN -- tile [' + wi + '] in ' + rDuration + 'ms');
                return { winningIndex: wi, raw: String(cotReply).trim(), durationMs: rDuration, targetDigit: -1, pass: 'rotation-cot-json' };
              }
            } catch {}
          }
        }
        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 no parse -- keeping Pass-1', 'warn');
      } catch (ce) {
        ccLog(tabId, 'FUNCAPTCHA: ROT Pass-2 error: ' + (ce.message || ce), 'warn');
      }
    }

    // use Pass-1 result if available
    if (directWinner !== null) {
      const rDuration = Date.now() - rStart;
      ccLog(tabId, 'FUNCAPTCHA: ROT Pass-1 WIN -- tile [' + directWinner + '] confidence=' + directConfidence + '% in ' + rDuration + 'ms');
      return { winningIndex: directWinner, raw: JSON.stringify({ directWinner, directConfidence }), durationMs: rDuration, targetDigit: -1, pass: 'rotation-direct' };
    }

    // Pass 3: holistic fallback
    ccLog(tabId, 'FUNCAPTCHA: ROT all passes failed -- holistic fallback', 'warn');
    const batchDescR = batchB64s.length === 1
      ? 'IMAGE 2: Candidate tiles [1] through [' + total + '].\n'
      : 'IMAGE 2: Candidate tiles [1] through [' + Math.ceil(total / 2) + '].\n' +
        'IMAGE 3: Candidate tiles [' + (Math.ceil(total / 2) + 1) + '] through [' + total + '].\n';

    const fallbackText = 'Arkose FunCAPTCHA ORIENTATION challenge.\n' +
      'Prompt: "' + (prompt || 'Rotate the object to match the shown direction') + '"\n\n' +
      'IMAGE 1: Hand indicator showing required direction.\n' +
      batchDescR + '\n' + objectHint + '\n\n' +
      'Find the ONE candidate where the object FRONT faces the same direction as the hand fingertips.\n' +
      'Conclude with:\nWINNING_INDEX: <number 1-' + total + '>\n{"winningIndex": <number 1-' + total + '>}';

    const contentR = [
      { type: 'text', text: fallbackText },
      { type: 'image_url', image_url: { url: toDataUrl(targetB64) } }
    ];
    for (const b of batchB64s) contentR.push({ type: 'image_url', image_url: { url: toDataUrl(b) } });

    try {
      const rReply = await chatReply({
        messages: [
          {
            role: 'system',
            content: 'Expert Arkose orientation solver. Be concise (max 2 sentences). Conclude with:\nWINNING_INDEX: <integer 1-' + total + '>\n{"winningIndex": <integer 1-' + total + '>}'
          },
          { role: 'user', content: contentR }
        ],
        temperature: 0,
        max_tokens: 500
      }, 25000);

      const rDuration = Date.now() - rStart;
      ccLog(tabId, 'FUNCAPTCHA: ROT fallback reply (' + rDuration + 'ms): ' + String(rReply).trim());

      let rIndex = null;
      const rjm = String(rReply).replace(/```[a-z]*\n?/gi, '').match(/\{[\s\S]*?\}/);
      if (rjm) {
        try {
          const parsed = JSON.parse(rjm[0]);
          const rawIdx = parsed.winningIndex !== undefined ? parsed.winningIndex : (parsed.winning_index !== undefined ? parsed.winning_index : parsed.index);
          const wi = parseInt(rawIdx, 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) rIndex = wi;
        } catch {}
      }
      if (!rIndex) {
        const m = String(rReply).match(/WINNING_INDEX:\s*(\d+)/i) || String(rReply).match(/winningIndex"?\s*[:=]\s*(\d+)/i);
        if (m) {
          const wi = parseInt(m[1], 10);
          if (!isNaN(wi) && wi >= 1 && wi <= total) rIndex = wi;
        }
      }

      if (rIndex) {
        ccLog(tabId, 'FUNCAPTCHA: ROT fallback WIN -- tile [' + rIndex + '] in ' + rDuration + 'ms');
        return { winningIndex: rIndex, raw: rReply, durationMs: rDuration, targetDigit: -1, pass: 'orientation' };
      }
      ccLog(tabId, 'FUNCAPTCHA: ROT fallback parse failed: ' + String(rReply).trim().slice(0, 400), 'warn');
    } catch (err) {
      ccLog(tabId, 'FUNCAPTCHA: ROT fallback error: ' + (err.message || err), 'warn');
    }
  }"""

new_content = content[:start_idx] + new_block + content[end_idx + 3:]

with open(r"Nopecha-Alternative\background\service-worker.js", "w", encoding="utf-8") as f:
    f.write(new_content)

print("SUCCESS! Wrote", len(new_content), "bytes")
