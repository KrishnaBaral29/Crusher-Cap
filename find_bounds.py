import re

with open(r"Nopecha-Alternative\background\service-worker.js", "r", encoding="utf-8") as f:
    content = f.read()

# Find start of rotation block
start_marker = "  // rotation challenge solver\n  if (isRotateChallenge && batchB64s && batchB64s.length > 0) {"
start_idx = content.find(start_marker)
print("Start idx:", start_idx)

# Find end - the closing of the if block before "  // visual grid solver"
end_marker = "  }\n\n  // visual grid solver"
end_idx = content.find(end_marker)
print("End idx:", end_idx)

if start_idx != -1 and end_idx != -1:
    block = content[start_idx:end_idx+3]
    print("Block length:", len(block))
    print("Block start:", repr(block[:80]))
    print("Block end:", repr(block[-80:]))
else:
    # try to find manually
    lines = content.split("\n")
    for i, line in enumerate(lines):
        if "rotation challenge solver" in line:
            print("Found at line", i+1, ":", repr(line[:80]))
        if "visual grid solver" in line:
            print("Found at line", i+1, ":", repr(line[:80]))
