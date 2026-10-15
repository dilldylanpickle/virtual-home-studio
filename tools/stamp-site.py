"""Stamp a prepared static site so a deploy never mixes cached old and new files.

GitHub Pages lets browsers cache every file for ten minutes. Right after a deploy, a
visitor could get the new page with an old cached stylesheet or module (or the reverse)
and see a broken studio. Stamping gives every page asset and every module import a
deploy-specific URL, so one deploy's files always load together. The source tree is
untouched: the local server sends no-cache headers and needs no stamping.

Usage: python3 tools/stamp-site.py <site directory> <version>
"""
import re
import sys
from pathlib import Path

if len(sys.argv) != 3 or not re.fullmatch(r'[0-9A-Za-z._-]+', sys.argv[2]):
    sys.exit('usage: stamp-site.py <site directory> <version: letters, digits, . _ ->')
site, version = Path(sys.argv[1]), sys.argv[2]
SPEC = r'(\.{1,2}/[^\'"`?#\s]+?\.js)'  # a relative module path without a query

# index.html: every ./static/ URL in href, src and srcset (fragments such as #disc stay last).
page = site / 'index.html'
html, assets = re.subn(r'(\./static/[^\s"\'?#,)]+)', rf'\1?v={version}', page.read_text())
page.write_text(html)

# Modules: static imports and re-exports, side-effect imports, dynamic imports, workers and
# the audio worklet (which keeps its engine version and gains the build).
patterns = [
    (re.compile(rf'(\bfrom\s*)([\'"]){SPEC}\2'), rf'\1\2\3?v={version}\2'),
    (re.compile(rf'(\bimport\s*)([\'"]){SPEC}\2'), rf'\1\2\3?v={version}\2'),
    (re.compile(rf'(\bimport\(\s*)([\'"]){SPEC}\2'), rf'\1\2\3?v={version}\2'),
    (re.compile(rf'(\bnew URL\(\s*)([\'"]){SPEC}\2(\s*,\s*import\.meta\.url)'), rf'\1\2\3?v={version}\2\4'),
    (re.compile(r'(\bnew URL\(\s*`\.{1,2}/[^`?]+\.js\?[^`]*)(`\s*,\s*import\.meta\.url)'), rf'\1&build={version}\2'),
]
imports = 0
for path in sorted((site / 'static').rglob('*.js')):
    text = original = path.read_text()
    for pattern, replacement in patterns:
        text, count = pattern.subn(replacement, text); imports += count
    if text != original: path.write_text(text)

# Nothing unstamped may remain: a fresh page must never load a cached module.
left = [str(path) for path in (site / 'static').rglob('*.js')
        if re.search(rf'(\bfrom\s*|\bimport\s*\(?\s*)[\'"]{SPEC}[\'"]', path.read_text())]
if not assets or left:
    sys.exit(f'stamping incomplete: {assets} page URLs; unstamped imports in {left}')
print(f'stamped {assets} page URLs and {imports} module references with v={version}')
