"""Test the clock-encoding rotation pipeline against real dumped images.
Reads target image + candidate batch, runs Stage A + Stage B prompts, prints
the clock hours and the deterministic match. Compare the output against what
the actual images show."""

import base64
import json
import re
import sys
from pathlib import Path

import urllib.request

HERE = Path(__file__).resolve().parent
IMG_DIR = HERE / "results" / "solve_images"
API_KEY = "sk-xt-1f08ad192f4cfc85e0d9f9568c951e7922ce8ec4b12fe127"
BASE = "https://api.xkiro.com/v1"
MODEL = "qwen/qwen3.8-omni-flash:free"
MODEL_FALLBACK = "qwen/qwen3.8-max:free"


def call(messages, model=MODEL, max_tokens=120, timeout=60):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + API_KEY,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"]


def img_url(path):
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    return "data:image/jpeg;base64," + b64


def clock_guide():
    return (
        "Use a CLOCK FACE overlaid on the image to describe directions.\n"
        "  12 = up, 3 = right, 6 = down, 9 = left,\n"
        "  1-2 = up-right, 4-5 = down-right, 7-8 = down-left, 10-11 = up-left.\n"
        "Answer with the hour that best matches the direction."
    )


def stage_a(target_img):
    reply = call([
        {"role": "user", "content": [
            {"type": "text", "text":
                "IMAGE 1: a target image from an Arkose FunCAPTCHA rotation challenge.\n"
                "It contains a human hand (or arrow/indicator) showing a direction.\n\n" +
                clock_guide() + "\n\n"
                "In which general direction does the hand/indicator POINT?\n"
                "Consider which way the fingers/thumb point (not the palm or wrist).\n"
                'Reply ONLY: {"hour": <integer 1-12>}'},
            {"type": "image_url", "image_url": {"url": img_url(target_img)}},
        ]},
    ], max_tokens=40)
    m = re.search(r"\{[\s\S]*?\}", reply)
    if m:
        try:
            v = int(json.loads(m.group(0)).get("hour", -1))
            if 1 <= v <= 12:
                return v, reply
        except Exception:
            pass
    m2 = re.search(r"\b(1[0-2]|[1-9])\b", reply)
    return (int(m2.group(1)) if m2 else None), reply


def stage_b(batch_img, total=6):
    reply = call([
        {"role": "system", "content":
            "You analyze object orientations. Reply ONLY with {\"hours\": [...]} — exactly "
            f"{total} integer hour values 1-12, in tile order [1]..[{total}]. No commentary."},
        {"role": "user", "content": [
            {"type": "text", "text":
                "Arkose FunCAPTCHA rotation challenge — candidate tiles, each showing a vehicle/object at a different rotation.\n\n"
                f"IMAGE 2: Candidate tiles [1] through [{total}].\n\n" +
                clock_guide() + "\n\n"
                "For EACH candidate tile, determine the direction the object FACES\n"
                "(for a vehicle: the direction its front/hood points — headlights, windshield, front wheels).\n"
                "Judge only by the object itself, not its shadow.\n\n"
                'Reply ONLY with a JSON array of ' + str(total) + ' hour values, e.g.: {"hours": [3, 7, 12, 9, 1, 5]}\n'
                "Each value 1-12. No other text."},
            {"type": "image_url", "image_url": {"url": img_url(batch_img)}},
        ]},
    ], max_tokens=120)
    m = re.search(r"\[[\s\S]*?\]", reply)
    if m:
        try:
            arr = json.loads(m.group(0))
            out = []
            for i in range(total):
                v = int(arr[i]) if i < len(arr) else None
                out.append(v if v and 1 <= v <= 12 else None)
            return out, reply
        except Exception:
            pass
    return None, reply


def circ_dist(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def main():
    files = sorted(IMG_DIR.glob("*.jpg"))
    # pair up: target then batch(es), generated in order 04 target, 05 batch(es)
    # We'll test by scanning for pairs where a target is followed by 1-2 batched images
    # For simplicity, allow explicit pair args:
    if len(sys.argv) >= 3:
        target = Path(sys.argv[1])
        batches = [Path(p) for p in sys.argv[2:]]
    else:
        groups = {}
        for f in files:
            m = re.match(r"(\d+)_match_(\d+)", f.name)
            if not m:
                continue
            groups.setdefault(m.group(2), []).append(f)
        # choose the largest group (most candidates captured)
        if not groups:
            print("no match images found")
            return
        key = sorted(groups.keys())[-2] if len(groups) > 1 else sorted(groups.keys())[-1]
        group = sorted(groups[key])
        target = group[0]
        batches = group[1:]

    print("target:", target.name)
    for b in batches:
        print("batch :", b.name)

    h, rawA = stage_a(target)
    print("\nStage A raw:", rawA.strip())
    print("Stage A target hour:", h)

    if h is None:
        print("Stage A failed")
        return

    hours, rawB = stage_b(batches[0], total=6)
    print("\nStage B raw:", rawB.strip())
    print("Stage B hours:", hours)

    if not hours:
        print("Stage B failed")
        return

    t_angle = (h % 12) * 30
    best, best_d = None, 999
    for i, hh in enumerate(hours):
        if hh is None:
            continue
        d = circ_dist(t_angle, (hh % 12) * 30)
        print(f"  tile [{i+1}] hour={hh} delta={d}°")
        if d < best_d:
            best_d, best = d, i + 1

    print(f"\n>>> MATCH: tile [{best}] (delta={best_d}°) <<<")


if __name__ == "__main__":
    main()
