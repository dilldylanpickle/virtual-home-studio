# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""Derive the shipped Studio background plates from the unpublished master.

    uv run tools/make-plates.py

Reads docs/source/studio-plate-master.png (never shipped) and writes WebP
derivatives into static/assets/. Camera calibration in static/studio-plate.js is
expressed as fractions of the plate, so it holds for every derivative width.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / 'docs/source/studio-plate-master.png'
OUTPUTS = {'studio-plate-xl.webp': 5600, 'studio-plate.webp': 3200, 'studio-plate-mobile.webp': 1600}
QUALITY = 82


def main():
    with Image.open(MASTER) as master:
        source = master.convert('RGB')
    for name, width in OUTPUTS.items():
        height = round(source.height * width / source.width)
        plate = source.resize((width, height), Image.Resampling.LANCZOS)
        target = ROOT / 'static/assets' / name
        plate.save(target, 'WEBP', quality=QUALITY, method=6)
        print(f'{target.relative_to(ROOT)}: {width}x{height}, {target.stat().st_size / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
