#!/usr/bin/env python3
"""Place same-sized reference and Rune PNGs side by side with labels."""
import argparse
import re
from pathlib import Path
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('piece')
parser.add_argument('rune_dir', type=Path)
parser.add_argument('--scenes', required=True)
args = parser.parse_args()
if any(not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', s) for s in [args.piece, *args.scenes.split(',')]):
    parser.error('invalid piece or scene name')
out = Path('/workspace/rune-compare')
out.mkdir(parents=True, exist_ok=True)
for scene in args.scenes.split(','):
    for theme in ('light', 'dark'):
        name = f'{scene}-{theme}.png'
        with Image.open(Path('/workspace/rune-ref') / args.piece / name) as ref, Image.open(args.rune_dir / name) as rune:
            if ref.size != rune.size:
                raise ValueError(f'{name}: image sizes differ: {ref.size} and {rune.size}')
            w, h = ref.size
            result = Image.new('RGB', (w * 2, h + 30), '#222222')
            result.paste(ref.convert('RGB'), (0, 30))
            result.paste(rune.convert('RGB'), (w, 30))
            draw = ImageDraw.Draw(result)
            draw.text((10, 8), 'Electron', fill='white')
            draw.text((w + 10, 8), 'Rune', fill='white')
            target = out / f'{args.piece}-{name}'
            result.save(target)
            print(target)
