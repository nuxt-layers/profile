"""Validate Markdown headings and local links; external links only in RESOURCES.md, pinned (ADR-0010)."""
from pathlib import Path
from urllib.parse import unquote, urlsplit
import re
import sys

root = Path(__file__).resolve().parents[1]
# ADR-0004: links to nuxt-layers documents must be pinned to a tag or commit.
moving_ref = re.compile(
    r"^https?://github\.com/nuxt-layers/[^/]+/(?:blob|tree|raw)/(?:master|main|HEAD|develop)(?:/|$)",
    re.IGNORECASE,
)
errors = []
files = sorted(root.rglob("*.md"))
for file in files:
    if any(part in {".git", "node_modules", ".nuxt"} for part in file.relative_to(root).parts):
        continue
    lines = file.read_text(encoding="utf-8").splitlines()
    if not any(re.match(r"^#\s+\S", line) for line in lines):
        errors.append(f"{file.relative_to(root)}: missing H1 heading")
    # ADR-0010: every document under docs/ opens with an In short line.
    if file.relative_to(root).parts[0] == "docs" and not any(line.startswith("> **In short:**") for line in lines):
        errors.append(f"{file.relative_to(root)}: missing In short summary")
    in_fence = False
    for number, line in enumerate(lines, 1):
        if re.match(r"^\s*(?:`{3,}|~{3,})", line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in re.finditer(r"!?\[[^\]]*\]\(([^\s)]+)\)", line):
            href = match.group(1).strip("<>")
            parsed = urlsplit(href)
            if moving_ref.match(href):
                errors.append(f"{file.relative_to(root)}:{number}: unpinned link to a moving branch {href}")
                continue
            if parsed.scheme or parsed.netloc:
                if file.relative_to(root).as_posix() != "RESOURCES.md":
                    errors.append(f"{file.relative_to(root)}:{number}: external link outside RESOURCES.md {href}")
                continue
            if not parsed.path:
                continue
            target = (file.parent / unquote(parsed.path)).resolve()
            if not target.is_relative_to(root) or not target.exists():
                errors.append(f"{file.relative_to(root)}:{number}: broken local link {href}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Checked {len(files)} Markdown files for headings, local links and external links")
