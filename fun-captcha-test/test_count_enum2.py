"""Validate the fixed count-enumeration prompt against a raw dumped sprite.
Crops the digit box (0,200,140,200) as target and row-1 tiles as the batch grid."""

import base64
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

API_KEY = "sk-xt-1f08ad192f4cfc85e0d9f9568c951e7922ce8ec4b12fe127"
BASE = "https://api.xkiro.com/v1"
MODEL = "qwen/qwen3.8-omni-flash:free"


def call(messages, max_tokens=120, timeout=90):
    body = json.dumps({"model": MODEL, "messages": messages, "temperature": 0, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
        "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def to_jpeg_b64(img):
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    sprite_path = Path(sys.argv[1])
    digit = int(sys.argv[2])
    obj_name = sys.argv[3] if len(sys.argv) > 3 else "rocks"
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 6

    sprite = Image.open(sprite_path)
    print("sprite:", sprite.size)

    target = sprite.crop((0, 200, 140, 400)).resize((400, 400), Image.LANCZOS)

    cols, tile, label_h = 3, 200, 30
    rows = (n + cols - 1) // cols
    batch = Image.new("RGB", (cols * tile, rows * (tile + label_h)), "#0f172a")
    for i in range(n):
        t = sprite.crop((i * tile, 0, (i + 1) * tile, tile))
        x, y = (i % cols) * tile, (i // cols) * (tile + label_h)
        batch.paste(t, (x + 1, y + 1))
        from PIL import ImageDraw
        d = ImageDraw.Draw(batch)
        d.rectangle([x, y + tile, x + tile, y + tile + label_h], fill="#1e293b")
        d.text((x + tile // 2 - 10, y + tile + 8), f"[{i+1}]", fill="#38bdf8")

    text = (
        "Arkose FunCAPTCHA counting challenge.\n"
        "IMAGE 1: a boxed number — it shows the REQUIRED count "
        f"N = {digit} (verified fact). It contains NO objects — do not count anything inside Image 1.\n"
        f"IMAGE 2: Candidate tiles [1] through [{n}].\n\n"
        f"TASK: Count ALL {obj_name} in each candidate tile. EVERY {obj_name.rstrip('s')} counts as one instance "
        "— regardless of size, color, shade, or orientation. Objects partially visible at tile edges still count.\n"
        f"- The tiles sit on a shared terrain background — ignore the terrain, shrubs and shadows; count only the {obj_name}.\n"
        f"- Tiles are in a labelled grid [1]..[{n}].\n\n"
        f'Reply ONLY: {{"counts": [<c1>, <c2>, ..., <c{n}>]}} — {n} integers, tile order [1]..[{n}]. No other text.'
    )
    reply = call([
        {"role": "system", "content": f'You count objects in tiles precisely. Reply ONLY {{"counts": [...]}} — exactly {n} integers in tile order. No commentary.'},
        {"role": "user", "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": to_jpeg_b64(target)}},
            {"type": "image_url", "image_url": {"url": to_jpeg_b64(batch)}},
        ]},
    ], max_tokens=120)
    print("raw:", reply.strip()[:200])
    m = re.search(r"\[[\s\S]*?\]", reply.replace("```", ""))
    if m:
        counts = json.loads(m.group(0))
        print("counts:", counts, "| N =", digit)
        matches = [i + 1 for i, c in enumerate(counts[:n]) if str(c).isdigit() and int(c) == digit]
        print("matches:", matches)
    else:
        print("PARSE FAILED")


if __name__ == "__main__":
    main()
