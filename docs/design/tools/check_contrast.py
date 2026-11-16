#!/usr/bin/env python3
"""WCAG 2.x contrast check for the Tin Can colour tokens.

Reads the colour token table and the pairing table from docs/design/style-guide.md,
computes the contrast ratio of every pairing in every theme, and prints a Markdown results
table. Themes (style guide §3.2) are checked by apps/web/src/theme/theme.test.ts.
Exits 1 if any pairing is below its minimum.

    python docs/design/tools/check_contrast.py           # check and print
    python docs/design/tools/check_contrast.py --write   # also refresh the results
                                                          # block in style-guide.md

Stdlib only. M1 replaces this with a test that reads the real tokens.css (16).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

GUIDE = Path(__file__).resolve().parent.parent / "style-guide.md"
THEMES = ("Light", "Dark", "High contrast")
TOKEN = re.compile(r"`(--color-[a-z0-9-]+)`")
HEX = re.compile(r"`(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)`")


def rows(text: str, header_start: str):
    """Yield the cells of each body row of the first table whose header starts with header_start."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(header_start):
            for body in lines[i + 2 :]:
                if not body.startswith("|"):
                    return
                yield [c.strip() for c in body.strip().strip("|").split("|")]
    return


def parse_tokens(text: str) -> dict[str, dict[str, str]]:
    tokens: dict[str, dict[str, str]] = {}
    for cells in rows(text, "| Colour token |"):
        name = TOKEN.search(cells[0])
        values = [HEX.search(c) for c in cells[1:4]]
        if name and all(values):
            tokens[name.group(1)] = {t: v.group(1) for t, v in zip(THEMES, values)}
    return tokens


def parse_pairs(text: str):
    for cells in rows(text, "| Foreground |"):
        fg, bg = TOKEN.search(cells[0]), TOKEN.search(cells[1])
        if fg and bg:
            yield fg.group(1), bg.group(1), float(cells[2]), cells[3]




def rgba(hex_: str) -> tuple[float, float, float, float]:
    h = hex_.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
    return r, g, b, a


def over(top, bottom):
    """Composite top (with alpha) over an opaque bottom colour."""
    a = top[3]
    return tuple(top[i] * a + bottom[i] * (1 - a) for i in range(3)) + (1.0,)


def luminance(c) -> float:
    def lin(v: float) -> float:
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(v) for v in c[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg_hex: str, bg_hex: str) -> float:
    """Contrast ratio; a translucent background is judged over white and black, worst case wins."""
    fg, bg = rgba(fg_hex), rgba(bg_hex)
    backdrops = [bg] if bg[3] == 1.0 else [over(bg, (1, 1, 1, 1)), over(bg, (0, 0, 0, 1))]
    worst = None
    for b in backdrops:
        f = over(fg, b) if fg[3] < 1.0 else fg
        l1, l2 = sorted((luminance(f), luminance(b)), reverse=True)
        r = (l1 + 0.05) / (l2 + 0.05)
        worst = r if worst is None else min(worst, r)
    return worst


def replace_block(text: str, name: str, table: str) -> str:
    begin, end = f"<!-- {name}:begin -->", f"<!-- {name}:end -->"
    start, stop = text.find(begin), text.find(end)
    if start < 0 or stop < 0:
        raise SystemExit(f"{name} markers not found in style-guide.md")
    return text[: start + len(begin)] + "\n" + table + "\n" + text[stop:]


def main() -> int:
    text = GUIDE.read_text(encoding="utf-8")
    tokens = parse_tokens(text)
    pairs = list(parse_pairs(text))
    unknown = sorted({t for fg, bg, _, _ in pairs for t in (fg, bg)} - tokens.keys())
    if unknown:
        print(f"unknown token(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    out = [
        "| Foreground | Background | Min | " + " | ".join(THEMES) + " |",
        "|---|---|---|" + "---|" * len(THEMES),
    ]
    failures = 0
    for fg, bg, minimum, _rule in pairs:
        cells = []
        for theme in THEMES:
            r = ratio(tokens[fg][theme], tokens[bg][theme])
            ok = r + 1e-9 >= minimum
            failures += not ok
            cells.append(f"{r:.2f}" + ("" if ok else " **FAIL**"))
        out.append(f"| `{fg}` | `{bg}` | {minimum:g} | " + " | ".join(cells) + " |")

    print("\n".join(out))
    print(f"\n{len(tokens)} tokens, {len(pairs)} pairings x {len(THEMES)} themes, "
          f"{failures} failing", file=sys.stderr)

    if "--write" in sys.argv:
        text = replace_block(text, "contrast", "\n".join(out))
        GUIDE.write_text(text, encoding="utf-8", newline="\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
