#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

layer = Path(__file__).resolve().parent.parent
version = (layer / "VERSION").read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("Invalid product version")
check = len(sys.argv) == 3 and sys.argv[1] == "--check"
if len(sys.argv) != 2 and not check:
    raise SystemExit("Usage: python3 stamp-product-version.py [--check] <built index.html>")
changelog = (layer / "deploy" / "CHANGELOG.md").read_text(encoding="utf-8")
sections = [
    (m.group(1), m.group(2).strip())
    for m in re.finditer(r"^## (\d+\.\d+\.[\dx]+)(?![\w.-])[^\n]*\n(.*?)(?=^## |\Z)", changelog, re.S | re.M)
]
current = next((i for i, (heading, _) in enumerate(sections) if heading == version), None)
if current is None or not sections[current][1]:
    raise SystemExit(f"No release notes for v{version} in deploy/CHANGELOG.md")
history = [{"version": heading, "notes": body} for heading, body in sections[current + 1 :] if body]
notes = json.dumps(
    {"version": version, "notes": sections[current][1], "history": history}, ensure_ascii=False
).replace("<", "\\u003c")
ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}")
TOKEN_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,47}")
COLOR_PATTERN = re.compile(r"#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")


def check_half(theme_id, name, half):
    if not isinstance(half, dict) or not half:
        raise SystemExit(f"Theme {theme_id}: missing {name} colours")
    for token, color in half.items():
        if not TOKEN_PATTERN.fullmatch(token):
            raise SystemExit(f"Theme {theme_id}: invalid token name {token!r}")
        if not isinstance(color, str) or not COLOR_PATTERN.fullmatch(color):
            raise SystemExit(f"Theme {theme_id}: invalid colour for {token}: {color!r}")


def load_themes():
    source = layer / "deploy" / "themes.json"
    if not source.exists():
        return None
    try:
        themes = json.loads(source.read_text(encoding="utf-8"))["themes"]
    except (ValueError, KeyError, TypeError):
        raise SystemExit("Invalid deploy/themes.json")
    if not isinstance(themes, list):
        raise SystemExit("Invalid deploy/themes.json")
    seen = set()
    for theme in themes:
        if not isinstance(theme, dict):
            raise SystemExit("Invalid theme entry")
        theme_id = theme.get("id")
        if not isinstance(theme_id, str) or not ID_PATTERN.fullmatch(theme_id):
            raise SystemExit(f"Invalid theme id {theme_id!r}")
        if theme_id in seen:
            raise SystemExit(f"Duplicate theme id {theme_id}")
        seen.add(theme_id)
        name = theme.get("name")
        if not isinstance(name, str) or not name or len(name) > 12:
            raise SystemExit(f"Theme {theme_id}: invalid name")
        check_half(theme_id, "light", theme.get("light"))
        check_half(theme_id, "dark", theme.get("dark"))
    return json.dumps({"themes": themes}, ensure_ascii=False).replace("<", "\\u003c")


themes = load_themes()
target = Path(sys.argv[-1])
original = target.read_bytes().decode("utf-8")
if original.count("</head>") != 1:
    raise SystemExit("Expected one HTML head")
clean = re.sub(
    r'<meta name="coworker-product-version" content="[^"]*">\n<style id="coworker-product-version">[\s\S]*?</style>\n'
    r'(?:<script type="application/json" id="coworker-release-notes">[^<]*</script>\n)?',
    "",
    re.sub(r'<script type="application/json" id="coworker-themes">[^<]*</script>\n?', "", original),
)
stamp = """<meta name="coworker-product-version" content="${version}">
<style id="coworker-product-version">
.brand-name::after,.mobile-brand::after{content:"v${version}";display:inline-block;margin-inline-start:8px;font-size:11px;font-weight:400;line-height:1.4;letter-spacing:0;color:var(--muted-foreground,#667085);white-space:nowrap;vertical-align:middle}
.brand-lockup{flex-wrap:wrap;row-gap:4px}
.layout.sidebar-closed .brand-name::after{display:none}
</style>
<script type="application/json" id="coworker-release-notes">${notes}</script>""".replace("${version}", version).replace(
    "${notes}", notes
)
if themes is not None:
    stamp += f'\n<script type="application/json" id="coworker-themes">{themes}</script>'
result = clean.replace("</head>", stamp + "\n</head>")
if check and result != original:
    raise SystemExit(f"Product version mismatch: expected {version}")
if result != original:
    target.write_bytes(result.encode("utf-8"))
print(f"Moqi v{version}: {'already stamped' if result == original else 'stamped'}")
