"""Build the icon font the status bar uses for each agent's logo.

VS Code's status bar draws icons only from icon fonts, so the two marks are
turned into glyphs of one small WOFF font, contributed in the extension
manifest as `turntrail-claude` and `turntrail-openai`.

The marks come from Simple Icons (https://simpleicons.org), whose SVG data is
released under CC0; the marks themselves remain their owners' trademarks and
are used only to say which agent a number belongs to.

The font is checked in, so this runs only when a mark changes:

    python -m pip install fonttools
    python scripts/build-brand-icons.py
"""

import pathlib
import re

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

ROOT = pathlib.Path(__file__).resolve().parent.parent
MEDIA = ROOT / "packages" / "vscode" / "media"
OUT = MEDIA / "turntrail-icons.woff"

# Glyph name, private-use code point, source file. The code points are what
# the manifest's `fontCharacter` entries name.
GLYPHS = [
    ("claude", 0xE000, MEDIA / "brand" / "claude.svg"),
    ("openai", 0xE001, MEDIA / "brand" / "openai.svg"),
]

UNITS_PER_EM = 1000
VIEWBOX = 24.0
# The marks fill their 24-unit box edge to edge; a little margin keeps them
# from looking larger than the codicons beside them.
SCALE = UNITS_PER_EM / VIEWBOX * 0.9
OFFSET = UNITS_PER_EM * 0.05
DESCENT = 150


def glyph_from_svg(svg_path):
    source = svg_path.read_text(encoding="utf-8")
    paths = re.findall(r'<path[^>]*\sd="([^"]+)"', source)
    if not paths:
        raise SystemExit(f"no path data in {svg_path}")
    pen = TTGlyphPen(None)
    # SVG's y axis points down and a font's points up, so flip, then sit the
    # mark on the baseline shifted down by the descent so it centres on text.
    transform = (SCALE, 0, 0, -SCALE, OFFSET, UNITS_PER_EM - DESCENT - OFFSET)
    quadratic = Cu2QuPen(TransformPen(pen, transform), max_err=1.0, reverse_direction=True)
    for d in paths:
        parse_path(d, quadratic)
    return pen.glyph()


def main():
    names = [".notdef"] + [name for name, _, _ in GLYPHS]
    empty = TTGlyphPen(None).glyph()
    glyphs = {".notdef": empty}
    for name, _, svg in GLYPHS:
        glyphs[name] = glyph_from_svg(svg)

    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap({code: name for name, code, _ in GLYPHS})
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (UNITS_PER_EM, 0) for name in names})
    builder.setupHorizontalHeader(ascent=UNITS_PER_EM - DESCENT, descent=-DESCENT)
    builder.setupNameTable({"familyName": "Turntrail Icons", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=UNITS_PER_EM - DESCENT, sTypoDescender=-DESCENT, usWinAscent=UNITS_PER_EM - DESCENT, usWinDescent=DESCENT)
    builder.setupPost()
    builder.font.flavor = "woff"
    builder.save(str(OUT))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes): " + ", ".join(f"{name} U+{code:04X}" for name, code, _ in GLYPHS))


if __name__ == "__main__":
    main()
