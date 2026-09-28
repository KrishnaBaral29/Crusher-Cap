"""Validate per-tile count enumeration against real dumped count-challenge images."""
import base64, json, re, sys, urllib.request
from pathlib import Path

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

def img_url(p):
    return "data:image/jpeg;base64," + base64.b64encode(Path(p).read_bytes()).decode()

def enumerate_counts(target, batch, n, digit):
    text = (
        "Arkose FunCAPTCHA counting challenge.\n"
        "IMAGE 1: reference — the target 3D object. The required count is ALREADY known: "
        f"N = {digit} (verified fact, do NOT recount the digit).\n"
        f"IMAGE 2: Candidate tiles [1] through [{n}].\n\n"
        "TASK: For EACH candidate tile, count the instances of the EXACT 3D object shown in Image 1.\n"
        "- Match by shape — ignore distractor objects of different shapes.\n"
        "- Count carefully — objects may overlap or sit at tile edges.\n"
        f"- Tiles are in a labelled grid [1]..[{n}].\n\n"
        f'Reply ONLY: {{"counts": [<c1>, <c2>, ..., <c{n}>]}} — {n} integers, tile order [1]..[{n}]. No other text.'
    )
    content = [{"type": "text", "text": text},
               {"type": "image_url", "image_url": {"url": img_url(target)}}]
    content.append({"type": "image_url", "image_url": {"url": img_url(batch)}})
    reply = call([
        {"role": "system", "content": f'You count objects in tiles precisely. Reply ONLY {{"counts": [...]}} — exactly {n} integers in tile order. No commentary.'},
        {"role": "user", "content": content}], max_tokens=120)
    m = re.search(r"\[[\s\S]*?\]", reply.replace("```", ""))
    if not m:
        return None, reply
    try:
        return json.loads(m.group(0)), reply
    except Exception:
        return None, reply

def main():
    target = Path(sys.argv[1])
    batch = Path(sys.argv[2])
    digit = int(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    counts, raw = enumerate_counts(target, batch, n, digit)
    print("raw:", raw.strip()[:200])
    print("counts:", counts, "| N =", digit)
    if counts:
        matches = [i + 1 for i in range(min(n, len(counts))) if str(counts[i]).isdigit() and int(counts[i]) == digit]
        print("matches:", matches)
    else:
        print("PARSE FAILED")

if __name__ == "__main__":
    main()
