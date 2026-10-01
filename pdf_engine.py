"""Core PDF logic: extract text segments, exchange formats, rebuild a translated PDF.

The rebuild step removes *only* the text of translated segments (via redactions
that leave images and vector graphics untouched) and writes the translation
into the same area, using the original size, colour, weight and alignment.
"""

from __future__ import annotations

import csv
import html
import io
import re
import statistics
import zipfile
from dataclasses import asdict, dataclass, field
from xml.etree import ElementTree as ET

import pymupdf

BULLET_RE = re.compile(r"^\s*(?:[•◦▪▫●○■□►▶➢➤✓✔·‣⁃]|\(?\d{1,3}[.)]\s|\(?[a-zA-Z][.)]\s)")
SERIF_HINTS = ("times", "serif", "roman", "georgia", "garamond", "cambria", "minion", "charis",
               "palatino", "book", "baskerville", "caslon", "charter", "didot", "bodoni", "libertin",
               "merriweather", "lora", "constantia", "century", "tinos", "nimbusrom", "utopia")
MONO_HINTS = ("courier", "mono", "consol", "menlo", "inconsolata", "code", "typewriter")
# Fonts whose names contain "sans" are never serif, even if they match a serif hint.
SANS_HINTS = ("sans", "arial", "helvet", "verdana", "tahoma", "calibri", "segoe")


@dataclass
class Segment:
    id: int
    page: int
    bbox: list[float]
    text: str
    size: float
    color: str
    font: str
    bold: bool
    italic: bool
    family: str  # "sans-serif" | "serif" | "monospace"
    align: str  # "left" | "center" | "right" | "justify"
    rotation: int  # 0 | 90 | 180 | 270
    line_pitch: float | None  # distance between baselines (multi-line only)
    lines: int
    origin: list[float]  # baseline origin of the first line
    redact: list[list[float]] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #

def _rotation(direction) -> int | None:
    dx, dy = direction
    if abs(dx) > 0.99:
        return 0 if dx > 0 else 180
    if abs(dy) > 0.99:
        return 90 if dy < 0 else 270
    return None  # skewed text is left untouched


def _font_family(name: str, flags: int = 0) -> str:
    """Generic CSS family from the font name, falling back to the PDF font descriptor flags."""
    low = name.lower()
    if any(h in low for h in MONO_HINTS):
        return "monospace"
    if any(h in low for h in SANS_HINTS):
        return "sans-serif"
    if any(h in low for h in SERIF_HINTS):
        return "serif"
    if flags & pymupdf.TEXT_FONT_MONOSPACED:
        return "monospace"
    if flags & pymupdf.TEXT_FONT_SERIFED:
        return "serif"
    return "sans-serif"


def _redact_rect(span: dict, rotation: int) -> list[float]:
    """A thin band through the middle of the glyphs.

    MuPDF removes every character whose box touches a redaction rectangle, and
    line boxes of tightly set text overlap. Redacting only a band around the
    x-height keeps neighbouring lines safe while still catching every glyph.
    """
    x0, y0, x1, y1 = span["bbox"]
    ox, oy = span["origin"]
    perp = (y1 - y0) if rotation in (0, 180) else (x1 - x0)
    size = min(span["size"], perp) if perp > 0 else span["size"]
    lo, hi = 0.25 * size, 0.5 * size
    if rotation == 0:
        return [x0, oy - hi, x1, oy - lo]
    if rotation == 180:
        return [x0, oy + lo, x1, oy + hi]
    if rotation == 90:
        return [ox - hi, y0, ox - lo, y1]
    return [ox + lo, y0, ox + hi, y1]  # 270


def _separators(page: pymupdf.Page) -> list[tuple[float, float, float, float]]:
    """Thin vector lines (table borders, rules) as (x0, y0, x1, y1) boxes."""
    out = []
    try:
        drawings = page.get_drawings()
    except Exception:  # pragma: no cover - malformed content streams
        return out
    for d in drawings:
        for item in d["items"]:
            if item[0] == "l":
                p, q = item[1], item[2]
                if abs(p.x - q.x) < 1.5 or abs(p.y - q.y) < 1.5:
                    out.append((min(p.x, q.x), min(p.y, q.y), max(p.x, q.x), max(p.y, q.y)))
            elif item[0] in ("re", "qu"):
                r = pymupdf.Rect(item[1]) if item[0] == "re" else item[1].rect
                if r.width < 3 or r.height < 3:  # a rule drawn as a thin rectangle
                    out.append(tuple(r))
                else:  # a cell / frame: its four edges separate text
                    out += [(r.x0, r.y0, r.x0, r.y1), (r.x1, r.y0, r.x1, r.y1),
                            (r.x0, r.y0, r.x1, r.y0), (r.x0, r.y1, r.x1, r.y1)]
    return out


def _divided(a, b, seps, horizontal_text: bool = True) -> bool:
    """True if a vector line runs between the boxes a and b (e.g. a table border)."""
    if not seps or not horizontal_text:
        return False
    a, b = pymupdf.Rect(a), pymupdf.Rect(b)
    if a.x1 <= b.x0 + 1 or b.x1 <= a.x0 + 1:  # side by side: look for a vertical line between
        lo, hi = (a.x1, b.x0) if a.x1 <= b.x0 + 1 else (b.x1, a.x0)
        lo, hi = min(lo, hi), max(lo, hi)
        mid = (max(a.y0, b.y0) + min(a.y1, b.y1)) / 2
        return any(x1 - x0 < 3 and lo - 0.5 <= (x0 + x1) / 2 <= hi + 0.5 and y0 <= mid <= y1
                   for x0, y0, x1, y1 in seps)
    upper, lower = (a, b) if a.y0 <= b.y0 else (b, a)
    lo, hi = upper.y1 - 0.2 * upper.height, lower.y0 + 0.2 * lower.height
    left, right = max(a.x0, b.x0), min(a.x1, b.x1)
    if right <= left:
        return False
    return any(y1 - y0 < 3 and lo <= (y0 + y1) / 2 <= hi and x0 < right - 1 and x1 > left + 1
               for x0, y0, x1, y1 in seps)


def _gap(prev: dict, cur: dict, rot: int) -> float:
    """Distance between two consecutive spans along the reading direction."""
    if rot == 0:
        return cur["bbox"][0] - prev["bbox"][2]
    if rot == 180:
        return prev["bbox"][0] - cur["bbox"][2]
    if rot == 90:
        return prev["bbox"][1] - cur["bbox"][3]
    return cur["bbox"][1] - prev["bbox"][3]


def _chunks(line: dict, seps=None) -> list[list[dict]]:
    """Split a line where spans are separated by a large gap or a table border.

    Whitespace-only spans are dropped (they often straddle cell borders); the spaces they
    stood for are restored from the gaps in _spans_text.
    """
    rot = _rotation(line["dir"])
    spans = [s for s in line["spans"] if s["text"].strip()]
    if not spans:
        return []
    out = [[spans[0]]]
    for prev, cur in zip(spans, spans[1:]):
        gap = _gap(prev, cur, rot)
        if gap > 2.0 * max(prev["size"], cur["size"]) or (
                gap > 0 and _divided(prev["bbox"], cur["bbox"], seps, rot in (0, 180))):
            out.append([cur])
        else:
            out[-1].append(cur)
    return out


def _spans_text(spans: list[dict], rot: int) -> str:
    text = spans[0]["text"]
    for prev, cur in zip(spans, spans[1:]):
        if (not text.endswith(" ") and not cur["text"].startswith(" ")
                and _gap(prev, cur, rot) > 0.15 * min(prev["size"], cur["size"])):
            text += " "
        text += cur["text"]
    return text


def _join(parts: list[str]) -> str:
    text = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not text:
            text = part
        elif text.endswith("-") and len(text) > 1 and text[-2].isalpha() and part[:1].islower():
            text = text[:-1] + part  # de-hyphenate words broken across lines
        else:
            text += " " + part
    return text


def _color_hex(value: int) -> str:
    return f"#{value & 0xFFFFFF:06x}"


def _dominant(spans: list[dict], key) -> object:
    weights: dict = {}
    for s in spans:
        k = key(s)
        weights[k] = weights.get(k, 0) + len(s["text"].strip()) + 0.01
    return max(weights, key=weights.get)


def _guess_align(lines: list[dict], rotation: int, page_width: float,
                 margins: tuple[float, float] | None = None) -> str:
    if rotation != 0:
        return "left"
    size = max(l["size"] for l in lines)
    tol = 0.6 * size
    lefts = [l["bbox"][0] for l in lines]
    rights = [l["bbox"][2] for l in lines]
    if len(lines) == 1:
        x0, x1 = lefts[0], rights[0]
        left_m, right_m = margins or (0.0, page_width)
        if x0 - left_m < 2 * size:
            return "left"
        centre = (x0 + x1) / 2
        if (abs(centre - page_width / 2) < 0.02 * page_width
                or abs(centre - (left_m + right_m) / 2) < 0.02 * page_width) and (x1 - x0) < 0.8 * page_width:
            return "center"
        if abs(x1 - right_m) < tol and x0 - left_m > 0.3 * page_width:
            return "right"
        return "left"
    left_ok = max(lefts) - min(lefts) < tol
    right_ok = max(rights) - min(rights) < tol
    if left_ok and len(lines) >= 3:
        body = rights[:-1]
        if max(body) - min(body) < tol and rights[-1] < max(body) - tol:
            return "justify"
    if left_ok:
        return "left"
    if right_ok:
        return "right"
    centres = [(a + b) / 2 for a, b in zip(lefts, rights)]
    if max(centres) - min(centres) < tol:
        return "center"
    return "left"


def _merge_visual_lines(lines: list[dict]) -> list[dict]:
    """Merge consecutive extracted lines that sit on the same baseline."""
    out: list[dict] = []
    for line in lines:
        if out and _same_baseline(out[-1], line):
            prev = out[-1]
            out[-1] = {**prev, "spans": prev["spans"] + line["spans"], "text": prev["text"] + " " + line["text"],
                       "bbox": tuple(pymupdf.Rect(prev["bbox"]) | pymupdf.Rect(line["bbox"])),
                       "size": max(prev["size"], line["size"])}
        else:
            out.append(line)
    return out


def _build_segment(seg_lines: list[dict], page_no: int, page_width: float, seg_id: int,
                   margins: tuple[float, float] | None = None) -> Segment | None:
    seg_lines = _merge_visual_lines(seg_lines)
    spans = [s for l in seg_lines for s in l["spans"]]
    text = _join([l["text"] for l in seg_lines])
    if not text.strip():
        return None
    rotation = seg_lines[0]["rotation"]
    rect = pymupdf.Rect()
    for s in spans:
        rect |= pymupdf.Rect(s["bbox"])
    size = float(_dominant(spans, lambda s: round(s["size"], 1)))
    font = str(_dominant(spans, lambda s: s["font"]))
    flags = spans and _dominant(spans, lambda s: s["flags"] & (pymupdf.TEXT_FONT_BOLD | pymupdf.TEXT_FONT_ITALIC))
    bold = bool(flags & pymupdf.TEXT_FONT_BOLD) or "bold" in font.lower() or "black" in font.lower()
    italic = bool(flags & pymupdf.TEXT_FONT_ITALIC) or "italic" in font.lower() or "oblique" in font.lower()
    pitch = None
    if len(seg_lines) > 1:
        axis = 1 if rotation in (0, 180) else 0
        baselines = [l["origin"][axis] for l in seg_lines]
        diffs = [abs(b - a) for a, b in zip(baselines, baselines[1:]) if abs(b - a) > 0.3 * size]
        if diffs:
            pitch = round(statistics.median(diffs), 2)
    return Segment(
        id=seg_id,
        page=page_no,
        bbox=[round(v, 2) for v in rect],
        text=text,
        size=size,
        color=_color_hex(int(_dominant(spans, lambda s: s["color"]))),
        font=font,
        bold=bold,
        italic=italic,
        family=_font_family(font, int(_dominant(
            spans, lambda s: s["flags"] & (pymupdf.TEXT_FONT_SERIFED | pymupdf.TEXT_FONT_MONOSPACED)))),
        align=_guess_align(seg_lines, rotation, page_width, margins),
        rotation=rotation,
        line_pitch=pitch,
        lines=len(seg_lines),
        origin=[round(v, 2) for v in seg_lines[0]["origin"]],
        redact=[[round(v, 2) for v in _redact_rect(s, rotation)] for s in spans if s["text"].strip()],
    )


def _page_lines(page: pymupdf.Page, seps) -> list[list[dict]]:
    """Return text blocks as lists of normalised visual lines."""
    data = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    blocks = []
    for block in data["blocks"]:
        if block.get("type") != 0:
            continue
        lines = []
        for line in block["lines"]:
            rot = _rotation(line["dir"])
            if rot is None:
                continue
            chunks = _chunks(line, seps)
            for chunk in chunks:
                text = _spans_text(chunk, rot)
                if not text.strip():
                    continue
                rect = pymupdf.Rect()
                for s in chunk:
                    rect |= pymupdf.Rect(s["bbox"])
                lines.append({
                    "spans": chunk,
                    "text": text,
                    "bbox": tuple(rect),
                    "origin": chunk[0]["origin"],
                    "size": max(s["size"] for s in chunk),
                    "rotation": rot,
                    "standalone": len(chunks) > 1,
                })
        if lines:
            blocks.append(lines)
    return blocks


def _same_baseline(a: dict, b: dict) -> bool:
    axis = 1 if a["rotation"] in (0, 180) else 0
    return abs(a["origin"][axis] - b["origin"][axis]) < 0.3 * min(a["size"], b["size"])


def extract_segments(doc: pymupdf.Document) -> list[Segment]:
    segments: list[Segment] = []
    for page in doc:
        width = page.cropbox.width  # text coordinates are in unrotated page space
        seps = _separators(page)
        blocks = _page_lines(page, seps)
        horizontal = [l["bbox"] for lines in blocks for l in lines if l["rotation"] == 0]
        margins = (min(b[0] for b in horizontal), max(b[2] for b in horizontal)) if horizontal else None
        for lines in blocks:
            groups: list[list[dict]] = []
            for line in lines:
                cur = groups[-1] if groups else None
                if cur is None or line["standalone"] or cur[-1]["standalone"]:
                    groups.append([line])
                    continue
                prev = cur[-1]
                ratio = max(line["size"], prev["size"]) / max(0.1, min(line["size"], prev["size"]))
                axis = 1 if prev["rotation"] in (0, 180) else 0
                pitch = abs(line["origin"][axis] - prev["origin"][axis])
                if line["rotation"] == prev["rotation"] and _same_baseline(line, prev):
                    # Same visual line: keep together unless far apart (table cells, tab stops).
                    a, b = pymupdf.Rect(prev["bbox"]), pymupdf.Rect(line["bbox"])
                    gap = max(b.x0 - a.x1, a.x0 - b.x1) if axis == 1 else max(b.y0 - a.y1, a.y0 - b.y1)
                    if gap > 2.0 * max(line["size"], prev["size"]) or _divided(prev["bbox"], line["bbox"], seps, axis == 1):
                        groups.append([line])
                    else:
                        cur.append(line)
                    continue
                if (
                    line["rotation"] != prev["rotation"]
                    or ratio > 1.25
                    or pitch > 2.0 * max(line["size"], prev["size"])
                    or BULLET_RE.match(line["text"])
                    or _divided(prev["bbox"], line["bbox"], seps, axis == 1)
                ):
                    groups.append([line])
                else:
                    cur.append(line)
            for group in groups:
                seg = _build_segment(group, page.number, width, len(segments) + 1, margins)
                if seg:
                    segments.append(seg)
    return segments


def segments_to_json(segments: list[Segment]) -> list[dict]:
    return [asdict(s) for s in segments]


def segments_from_json(items: list[dict]) -> list[Segment]:
    return [Segment(**item) for item in items]


# --------------------------------------------------------------------------- #
# Exchange formats (for external translators)
# --------------------------------------------------------------------------- #

MARKER = "[[{}]]"
_OPEN = r"[\[［【〔(（<«]"
_CLOSE = r"[\]］】〕)）>»]"
MARKER_LINE_RE = re.compile(rf"^\s*{_OPEN}{{2}}\s*#?\s*(\d+)\s*{_CLOSE}{{2}}\s*(.*)$")


def export_txt(segments: list[Segment], translations: dict[int, str] | None = None) -> str:
    out = []
    for s in segments:
        out.append(MARKER.format(s.id))
        out.append((translations or {}).get(s.id) or s.text)
        out.append("")
    return "\n".join(out)


def parse_marked_text(text: str) -> dict[int, str]:
    result: dict[int, str] = {}
    current: int | None = None
    buf: list[str] = []

    def flush():
        if current is not None:
            value = "\n".join(buf).strip()
            if value:
                result[current] = value

    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        m = MARKER_LINE_RE.match(raw)
        if m:
            flush()
            current = int(m.group(1))
            buf = [m.group(2)] if m.group(2).strip() else []
        elif current is not None:
            buf.append(raw)
    flush()
    return result


def export_csv(segments: list[Segment], translations: dict[int, str] | None = None) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "page", "source", "target"])
    for s in segments:
        writer.writerow([s.id, s.page + 1, s.text, (translations or {}).get(s.id, "")])
    return "﻿" + buf.getvalue()  # BOM so Excel detects UTF-8


def parse_csv(text: str) -> dict[int, str]:
    text = text.lstrip("﻿")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    if not rows:
        return {}
    header = [h.strip().lower() for h in rows[0]]
    id_col, target_col, body = 0, len(rows[0]) - 1, rows
    if "id" in header:
        id_col = header.index("id")
        body = rows[1:]
        for name in ("target", "translation", "translated"):
            if name in header:
                target_col = header.index(name)
                break
    result = {}
    for row in body:
        if len(row) <= max(id_col, target_col):
            continue
        try:
            seg_id = int(row[id_col].strip())
        except ValueError:
            continue
        value = row[target_col].strip()
        if value:
            result[seg_id] = value
    return result


def export_json(segments: list[Segment], translations: dict[int, str] | None = None, name: str = "") -> dict:
    return {
        "document": name,
        "segments": [
            {"id": s.id, "page": s.page + 1, "source": s.text, "target": (translations or {}).get(s.id, "")}
            for s in segments
        ],
    }


def parse_json(data) -> dict[int, str]:
    result = {}
    if isinstance(data, dict) and "segments" in data:
        for item in data["segments"]:
            value = (item.get("target") or item.get("translation") or "").strip()
            if value:
                result[int(item["id"])] = value
    elif isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str) and value.strip() and str(key).strip().isdigit():
                result[int(key)] = value.strip()
    elif isinstance(data, list):
        for item in data:
            value = (item.get("target") or item.get("translation") or "").strip()
            if value:
                result[int(item["id"])] = value
    return result


def export_xliff(segments: list[Segment], translations: dict[int, str] | None = None, name: str = "",
                 source_lang: str = "en", target_lang: str = "") -> str:
    esc = html.escape
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
        f'  <file original="{esc(name)}" source-language="{esc(source_lang or "en")}"'
        + (f' target-language="{esc(target_lang)}"' if target_lang else "")
        + ' datatype="plaintext">',
        "    <body>",
    ]
    for s in segments:
        target = (translations or {}).get(s.id)
        out.append(f'      <trans-unit id="{s.id}">')
        out.append(f"        <source>{esc(s.text, quote=False)}</source>")
        if target:
            out.append(f'        <target state="translated">{esc(target, quote=False)}</target>')
        out.append(f"        <note>page {s.page + 1}</note>")
        out.append("      </trans-unit>")
    out += ["    </body>", "  </file>", "</xliff>", ""]
    return "\n".join(out)


def parse_xliff(data: bytes) -> dict[int, str]:
    root = ET.fromstring(data)
    result = {}

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    for el in root.iter():
        if local(el.tag) not in ("trans-unit", "unit"):
            continue
        try:
            seg_id = int(str(el.get("id", "")).strip())
        except ValueError:
            continue
        targets = [t for t in el.iter() if local(t.tag) == "target"]
        value = "".join("".join(t.itertext()) for t in targets).strip()
        if value:
            result[seg_id] = value
    return result


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_DOCX_FILES = {
    "[Content_Types].xml": (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    ),
    "_rels/.rels": (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>'
    ),
}


def export_docx(segments: list[Segment], translations: dict[int, str] | None = None) -> bytes:
    """A minimal Word file: a grey marker paragraph followed by the text of each segment.

    Useful for translators that only accept documents (Google Translate, DeepL).
    """

    def para(text: str, marker: bool = False) -> str:
        props = '<w:rPr><w:color w:val="999999"/><w:sz w:val="16"/></w:rPr>' if marker else ""
        runs = []
        for i, line in enumerate(text.split("\n")):
            if i:
                runs.append("<w:br/>")
            runs.append(f'<w:t xml:space="preserve">{html.escape(line, quote=False)}</w:t>')
        return f"<w:p><w:r>{props}{''.join(runs)}</w:r></w:p>"

    body = []
    for s in segments:
        body.append(para(MARKER.format(s.id), marker=True))
        body.append(para((translations or {}).get(s.id) or s.text))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{_W_NS}"><w:body>{"".join(body)}</w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in _DOCX_FILES.items():
            zf.writestr(path, content)
        zf.writestr("word/document.xml", document)
    return buf.getvalue()


def parse_docx(data: bytes) -> dict[int, str]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    w = f"{{{_W_NS}}}"
    paragraphs = []
    for p in root.iter(f"{w}p"):
        parts = []
        for el in p.iter():
            if el.tag == f"{w}t" and el.text:
                parts.append(el.text)
            elif el.tag in (f"{w}br", f"{w}cr"):
                parts.append("\n")
            elif el.tag == f"{w}tab":
                parts.append("\t")
        paragraphs.append("".join(parts))
    return parse_marked_text("\n".join(paragraphs))


def parse_import(filename: str, data: bytes) -> dict[int, str]:
    """Detect the format of an uploaded translation file and parse it."""
    import json

    name = (filename or "").lower()
    if name.endswith(".docx") or data[:2] == b"PK":
        return parse_docx(data)
    text = data.decode("utf-8-sig", errors="replace")
    stripped = text.lstrip()
    if name.endswith((".xlf", ".xliff")) or (stripped.startswith("<") and "xliff" in stripped[:500]):
        return parse_xliff(data)
    if name.endswith(".json") or stripped.startswith(("{", "[")):
        try:
            return parse_json(json.loads(text))
        except ValueError:
            pass
    if name.endswith((".csv", ".tsv")):
        return parse_csv(text)
    return parse_marked_text(text)


# --------------------------------------------------------------------------- #
# Rebuild
# --------------------------------------------------------------------------- #

@dataclass
class BuildOptions:
    font_mode: str = "auto"  # auto | sans-serif | serif | monospace | custom
    custom_font_path: str | None = None
    expand: bool = True  # let single-line text grow into free space before shrinking
    min_scale: float = 0.0  # 0 = shrink as much as needed to fit


def _obstacles(page: pymupdf.Page, segments: list[Segment]) -> tuple[list[pymupdf.Rect], list[pymupdf.Rect]]:
    """What expanded text must not run into.

    Returns (edges, containers): vertical edges of other text, images and vector shapes, and
    the bounding boxes of shapes/images, so text that sits inside a frame stays inside it.
    """
    edges = [pymupdf.Rect(s.bbox) for s in segments]
    containers = []

    def add_box(r: pymupdf.Rect) -> None:
        if r.is_empty and r.width == 0 and r.height == 0:
            return
        containers.append(r)
        edges.extend([pymupdf.Rect(r.x0, r.y0, r.x0, r.y1), pymupdf.Rect(r.x1, r.y0, r.x1, r.y1)])

    for img in page.get_image_info():
        add_box(pymupdf.Rect(img["bbox"]))
    try:
        drawings = page.get_drawings()
    except Exception:  # pragma: no cover - malformed content streams
        drawings = []
    for d in drawings:
        if d.get("fill") is not None or d.get("closePath"):
            add_box(pymupdf.Rect(d["rect"]))
        for item in d["items"]:
            if item[0] == "re":
                add_box(pymupdf.Rect(item[1]))
            elif item[0] == "qu":
                add_box(item[1].rect)
            elif item[0] == "l":
                p, q = item[1], item[2]
                if abs(p.x - q.x) < 1:
                    edges.append(pymupdf.Rect(p.x, min(p.y, q.y), p.x, max(p.y, q.y)))
    return edges, containers


def _expanded_rect(seg: Segment, page_rect: pymupdf.Rect,
                   obstacles: tuple[list[pymupdf.Rect], list[pymupdf.Rect]]) -> pymupdf.Rect:
    r = pymupdf.Rect(seg.bbox)
    edges, containers = obstacles
    margin = min(0.04 * page_rect.width, 24)
    gap = 0.4 * seg.size
    right_limit = page_rect.x1 - margin
    left_limit = page_rect.x0 + margin
    for c in containers:
        if c.width < 0.97 * page_rect.width and c.x0 - 1 <= r.x0 and r.x1 <= c.x1 + 1 \
                and c.y0 - 1 <= r.y0 and r.y1 <= c.y1 + 1:
            right_limit = min(right_limit, c.x1 - gap)
            left_limit = max(left_limit, c.x0 + gap)
    band_y0, band_y1 = r.y0 + 0.2 * r.height, r.y1 - 0.2 * r.height
    for o in edges:
        if o.y1 < band_y0 or o.y0 > band_y1:
            continue
        if o.x0 >= r.x1 - 0.5:
            right_limit = min(right_limit, o.x0 - gap)
        if o.x1 <= r.x0 + 0.5:
            left_limit = max(left_limit, o.x1 + gap)
    right_limit = max(right_limit, r.x1)
    left_limit = min(left_limit, r.x0)
    if seg.align == "left" or seg.align == "justify":
        r.x1 = right_limit
    elif seg.align == "right":
        r.x0 = left_limit
    else:  # centre: grow symmetrically
        grow = min(r.x0 - left_limit, right_limit - r.x1)
        r.x0 -= grow
        r.x1 += grow
    return r


def _line_height(seg: Segment) -> float:
    return max(seg.line_pitch or 1.15 * seg.size, seg.size)


def _html_for(seg: Segment, text: str, family: str) -> str:
    style = [
        f"font-family:{family}",
        f"font-size:{seg.size:.2f}px",
        f"line-height:{_line_height(seg):.2f}px",
        f"color:{seg.color}",
        f"text-align:{seg.align}",
        f"font-weight:{'bold' if seg.bold else 'normal'}",
        f"font-style:{'italic' if seg.italic else 'normal'}",
        "margin:0",
        "padding:0",
    ]
    body = "<br>".join(html.escape(line) for line in text.strip().split("\n"))
    return f'<p style="{";".join(style)}">{body}</p>'


def _insert_rect(seg: Segment) -> pymupdf.Rect:
    """Box for the translation, placed so its first baseline matches the original one.

    MuPDF's HTML layout puts the first baseline (L - size) / 2 + 0.85 * size below the top
    of the box (L = line height) and indents by 1pt.
    """
    r = pymupdf.Rect(seg.bbox)
    lh = _line_height(seg)
    offset = (lh - seg.size) / 2 + 0.85 * seg.size
    need = seg.lines * lh + 0.1 * seg.size
    ox, oy = seg.origin
    if seg.rotation == 0:
        r.y0 = oy - offset
        r.y1 = max(r.y1, r.y0 + need)
        r.x0 -= 1
        r.x1 -= 1
    elif seg.rotation == 180:
        r.y1 = oy + offset
        r.y0 = min(r.y0, r.y1 - need)
    elif seg.rotation == 90:
        r.x0 = ox - offset
        r.x1 = max(r.x1, r.x0 + need)
    else:
        r.x1 = ox + offset
        r.x0 = min(r.x0, r.x1 - need)
    return r


def build_translated_pdf(src_path: str, segments: list[Segment], translations: dict[int, str],
                         options: BuildOptions | None = None) -> tuple[bytes, dict]:
    options = options or BuildOptions()
    doc = pymupdf.open(src_path)
    by_page: dict[int, list[Segment]] = {}
    for seg in segments:
        by_page.setdefault(seg.page, []).append(seg)

    css, archive = "", None
    custom = options.font_mode == "custom" and options.custom_font_path
    if custom:
        import os
        archive = pymupdf.Archive(os.path.dirname(options.custom_font_path))
        css = f"@font-face {{font-family: userfont; src: url({os.path.basename(options.custom_font_path)});}}"

    stats = {"replaced": 0, "untranslated": 0, "shrunk": [], "pages": len(doc)}
    for page_no, page_segments in by_page.items():
        todo = [(s, translations[s.id].strip()) for s in page_segments
                if (translations.get(s.id) or "").strip()]
        stats["untranslated"] += len(page_segments) - len(todo)
        if not todo:
            continue
        page = doc[page_no]
        obstacles = _obstacles(page, page_segments) if options.expand else ([], [])
        area = pymupdf.Rect(0, 0, page.cropbox.width, page.cropbox.height)  # unrotated page space

        # 1. Remove the original glyphs only - images and vector graphics stay.
        for seg, _ in todo:
            for rect in seg.redact:
                page.add_redact_annot(pymupdf.Rect(rect), fill=False)
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )

        # 2. Write the translations into the freed areas.
        for seg, text in todo:
            family = "userfont" if custom else (seg.family if options.font_mode == "auto" else options.font_mode)
            content = _html_for(seg, text, family)
            rect = _insert_rect(seg)
            if options.expand and seg.lines == 1 and seg.rotation == 0:
                wide = _expanded_rect(seg, area, obstacles)
                rect.x0, rect.x1 = wide.x0 - 1, wide.x1 - 1
            spare, scale = page.insert_htmlbox(
                rect, content, css=css, archive=archive, scale_low=options.min_scale,
                rotate=seg.rotation, overlay=True,
            )
            if spare < 0:  # did not fit even at min_scale: retry without a lower limit
                spare, scale = page.insert_htmlbox(rect, content, css=css, archive=archive, scale_low=0,
                                                   rotate=seg.rotation, overlay=True)
            stats["replaced"] += 1
            if scale < 0.98:
                stats["shrunk"].append({"id": seg.id, "scale": round(scale, 2)})

    doc.subset_fonts()
    out = doc.tobytes(garbage=4, deflate=True, clean=False)
    doc.close()
    return out, stats
