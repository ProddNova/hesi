"""Build the condensed SHUTOKO SIGNAL UI font.

The source is Dosis, released under the SIL Open Font License 1.1.
This derivative is given a new family name and is horizontally tightened to
match the narrow, softly rounded lettering in the NIGHT-RUNNERS references.

Install the build tools once, then run from the repository root:

    python -m pip install "fonttools[woff]" brotli
    python .devtests/build-shutoko-signal.py
"""

from pathlib import Path

from fontTools import subset
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / ".devtests" / "fontsrc" / "Dosis-wght.ttf"
OUTPUT_DIR = ROOT / "fonts"
WIDTH_SCALE = 0.92

BUILDS = (
    {
        "filename": "shutoko-signal-regular.woff2",
        "family": "Shutoko Signal",
        "style": "Regular",
        "weight": 500,
        "css_weight": 400,
    },
    {
        "filename": "shutoko-signal-bold.woff2",
        "family": "Shutoko Signal",
        "style": "Bold",
        "weight": 700,
        "css_weight": 700,
    },
    {
        "filename": "shutoko-signal-display.woff2",
        "family": "Shutoko Signal Display",
        "style": "Regular",
        "weight": 600,
        "css_weight": 400,
    },
)


def collect_codepoints() -> set[int]:
    """Collect UI characters and retain a dependable Latin/punctuation base."""

    codepoints = set(range(0x20, 0x100))
    sources = [
        ROOT / "index.html",
        ROOT / "styles.css",
        *sorted((ROOT / "styles").glob("*.css")),
        *sorted((ROOT / "js").glob("*.js")),
    ]
    for source in sources:
        codepoints.update(map(ord, source.read_text(encoding="utf-8")))

    # Common interface arrows, bullets, shapes, math and currency glyphs.
    codepoints.update(range(0x2000, 0x2070))
    codepoints.update(range(0x20A0, 0x20D0))
    codepoints.update(range(0x2190, 0x2200))
    codepoints.update(range(0x2200, 0x2300))
    codepoints.update(range(0x2500, 0x2600))
    return codepoints


def condense_glyphs(font: TTFont, scale: float) -> None:
    """Tighten outlines and horizontal metrics without changing cap height."""

    glyph_set = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    transformed = {}

    for glyph_name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[glyph_name].draw(TransformPen(pen, (scale, 0, 0, 1, 0, 0)))
        transformed[glyph_name] = pen.glyph()

    glyf = font["glyf"]
    for glyph_name, glyph in transformed.items():
        glyf[glyph_name] = glyph

    metrics = font["hmtx"].metrics
    for glyph_name, (advance, left_side_bearing) in tuple(metrics.items()):
        metrics[glyph_name] = (
            round(advance * scale),
            round(left_side_bearing * scale),
        )


def set_font_names(font: TTFont, family: str, style: str, css_weight: int) -> None:
    """Replace upstream naming so the derivative is unambiguously its own."""

    name = font["name"]
    full_name = f"{family} {style}"
    postscript_name = full_name.replace(" ", "-")
    unique_name = f"ShutokoSignal-{css_weight}-{style}"
    values = {
        1: family,
        2: style,
        3: unique_name,
        4: full_name,
        6: postscript_name,
        13: (
            "Shutoko Signal is a modified version of Dosis. "
            "Licensed under the SIL Open Font License, Version 1.1."
        ),
        14: "https://openfontlicense.org",
        16: family,
        17: style,
    }

    # Clear stale upstream records for the IDs we replace, then add consistent
    # Unicode Windows and Macintosh English records.
    name.names = [record for record in name.names if record.nameID not in values]
    for name_id, value in values.items():
        name.setName(value, name_id, 3, 1, 0x0409)
        name.setName(value, name_id, 1, 0, 0)

    font["OS/2"].usWeightClass = css_weight


def subset_font(font: TTFont, codepoints: set[int]) -> None:
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_glyph = True
    options.recommended_glyphs = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)


def build_font(spec: dict[str, object], codepoints: set[int]) -> Path:
    font = TTFont(SOURCE, recalcBBoxes=True, recalcTimestamp=False)
    instantiateVariableFont(font, {"wght": spec["weight"]}, inplace=True)
    condense_glyphs(font, WIDTH_SCALE)
    subset_font(font, codepoints)
    set_font_names(
        font,
        family=str(spec["family"]),
        style=str(spec["style"]),
        css_weight=int(spec["css_weight"]),
    )

    destination = OUTPUT_DIR / str(spec["filename"])
    font.flavor = "woff2"
    font.save(destination)
    return destination


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source font: {SOURCE}")

    OUTPUT_DIR.mkdir(exist_ok=True)
    codepoints = collect_codepoints()
    for spec in BUILDS:
        destination = build_font(spec, codepoints)
        size_kib = destination.stat().st_size / 1024
        print(f"{destination.name}: {size_kib:.1f} KiB")


if __name__ == "__main__":
    main()
