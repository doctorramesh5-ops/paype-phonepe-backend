import re, os, sys
if not os.path.exists("public/admin"):
    sys.exit("Run this from inside paype-phonepe-uat")
ROOT_SWAPS = [
    ("#141026", "#FBF3F8"), ("#5B2EDD", "#DA0077"), ("#3E1FA0", "#FF3D95"),
    ("#F3F1FB", "#140611"), ("#E2DDF3", "#3A1730"), ("#166534", "#3DD9A0"),
    ("#DCFCE7", "rgba(61,217,160,.15)"), ("#B3261E", "#FF6B7A"),
    ("#FEE2E2", "rgba(255,107,122,.15)"), ("#B45309", "#F5B94A"),
    ("#FEF3C7", "rgba(245,185,74,.15)"), ("#59527A", "#A794A2"), ("#7A7396", "#74606F"),
]
def repaint(path):
    src = open(path).read()
    m = re.search(r":root\{[^}]*\}", src)
    if not m: return None, "no :root block found"
    root_old = m.group(0); root_new = root_old; n = 0
    for old, new in ROOT_SWAPS:
        c = root_new.count(old)
        if c: root_new = root_new.replace(old, new); n += c
    src = src.replace(root_old, root_new, 1)
    for pat, rep in [(r"background:\s*#fff;", "background:#1E0A1A;"), (r"background:\s*#FFFFFF;", "background:#1E0A1A;")]:
        found = re.findall(pat, src)
        if found: src = re.sub(pat, rep, src); n += len(found)
    if "#F0EDFA" in src:
        c = src.count("#F0EDFA"); src = src.replace("#F0EDFA", "#24101F"); n += c
    open(path, "w").write(src)
    return n, None
for f in ["public/admin/dashboard.html", "public/admin/merchants.html", "public/merchant/dashboard.html"]:
    if not os.path.exists(f): print(f"  skip: {f}"); continue
    n, err = repaint(f)
    print(f"  {os.path.basename(f):22} SKIPPED - {err}" if err else f"  {os.path.basename(f):22} {n:3} values swapped")
print("\nDone. Hard-refresh (Cmd+Shift+R) each page to see it.")
