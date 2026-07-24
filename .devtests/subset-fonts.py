"""Subset the UI fonts to the glyphs the game actually uses -> fonts/*.woff2

Fonts live full-size in .devtests/fontsrc/ (from google/fonts, OFL).
Needs a venv with fonttools+brotli:
  python -m venv .devtests/fontenv
  .devtests/fontenv/Scripts/pip install fonttools brotli
Re-run after adding new kanji/symbols to index.html or js/*.js.
"""
import re, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / '.devtests/fontenv/Scripts/python.exe'

# Collect every non-ASCII char used in UI markup / UI-generating JS
chars = set()
for f in [ROOT / 'index.html', *sorted((ROOT / 'js').glob('*.js'))]:
    chars.update(re.findall(r'[̀-￿]', f.read_text(encoding='utf-8', errors='ignore')))

extra = '←↑→↓↻▶◀▲▼◆●○◎▮─│┌┐└┘【】¥°©×·…»‹› '
text = ''.join(sorted(chars | set(extra)))
print(f'{len(text)} non-ASCII chars collected')

jobs = [
    ('MPLUSRounded1c-Regular.ttf', 'rounded-regular'),
    ('MPLUSRounded1c-Bold.ttf', 'rounded-bold'),
    ('MPLUSRounded1c-ExtraBold.ttf', 'rounded-xbold'),
]
for src, out in jobs:
    dest = ROOT / 'fonts' / f'{out}.woff2'
    subprocess.run([
        str(PY), '-m', 'fontTools.subset', str(ROOT / '.devtests/fontsrc' / src),
        f'--text={text}', '--unicodes=U+0020-007E,U+00A0-00FF',
        '--flavor=woff2', '--layout-features=*', f'--output-file={dest}',
    ], check=True)
    print(src, '->', dest.name, f'{dest.stat().st_size/1024:.0f} KB')
