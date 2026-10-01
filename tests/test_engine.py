import io
import json
import sys
from pathlib import Path

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import pdf_engine as engine  # noqa: E402
from make_sample import make_sample  # noqa: E402


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    path = tmp_path_factory.mktemp("pdf") / "sample.pdf"
    make_sample(str(path))
    return str(path)


@pytest.fixture(scope="module")
def segments(sample):
    with pymupdf.open(sample) as doc:
        return engine.extract_segments(doc)


def by_text(segments, start):
    return next(s for s in segments if s.text.startswith(start))


# ----------------------------------------------------------------- extraction

def test_paragraph_lines_are_merged(segments):
    para = by_text(segments, "Portable Document Format")
    assert para.lines == 3
    assert para.text.endswith("into the same box.")
    assert para.family == "serif"
    assert para.align == "justify"


def test_styles_are_captured(segments):
    title = by_text(segments, "Annual Report")
    assert title.size == 24 and title.bold and title.color == "#ffffff"
    assert by_text(segments, "Text inside a frame").italic
    assert by_text(segments, "1,234,567").family == "monospace"


def test_table_cells_on_one_baseline_are_split(segments):
    assert by_text(segments, "Total revenue").text == "Total revenue"
    assert by_text(segments, "1,234,567").text == "1,234,567 EUR"


def test_bullets_are_separate_segments(segments):
    assert "Revenue grew" in by_text(segments, "· Revenue").text
    assert "Costs" not in by_text(segments, "· Revenue").text


def test_rotation_and_centre(segments):
    assert by_text(segments, "Rotated margin note").rotation == 90
    assert by_text(segments, "Centered footer").align == "center"


def test_bordered_table_cells_split():
    doc = pymupdf.open()
    page = doc.new_page()
    for x0, x1 in ((50, 120), (120, 190)):
        page.draw_rect(pymupdf.Rect(x0, 100, x1, 120), color=(0, 0, 0))
    page.insert_text((54, 114), "Alpha", fontsize=10)
    page.insert_text((124, 114), "Beta", fontsize=10)
    texts = [s.text for s in engine.extract_segments(doc)]
    assert texts == ["Alpha", "Beta"]


# ------------------------------------------------------------ exchange formats

TRANSLATIONS = {1: "Jahresbericht 2026", 3: "Kennzahlen\nzweite Zeile", 6: 'Umsatz "gesamt" & <mehr>'}


@pytest.mark.parametrize("fmt", ["txt", "csv", "json", "xliff", "docx"])
def test_export_import_roundtrip(segments, fmt):
    if fmt == "txt":
        data = engine.export_txt(segments, TRANSLATIONS).encode()
    elif fmt == "csv":
        data = engine.export_csv(segments, TRANSLATIONS).encode()
    elif fmt == "json":
        data = json.dumps(engine.export_json(segments, TRANSLATIONS)).encode()
    elif fmt == "xliff":
        data = engine.export_xliff(segments, TRANSLATIONS, "a.pdf", "en", "de").encode()
    else:
        data = engine.export_docx(segments, TRANSLATIONS)
    parsed = engine.parse_import(f"file.{fmt if fmt != 'xliff' else 'xlf'}", data)
    for seg_id, text in TRANSLATIONS.items():
        assert parsed[seg_id] == text
    if fmt in ("txt", "docx"):  # untranslated segments carry their source text
        assert len(parsed) == len(segments)
    else:  # only filled targets are imported
        assert set(parsed) == set(TRANSLATIONS)


def test_marker_parsing_is_tolerant():
    text = "[[1]]\nHallo\n\n[[ 2 ]]\nWelt\n［［3］］\nVoll\n【【4】】 Inline text\n[[5]]\n\n"
    assert engine.parse_marked_text(text) == {1: "Hallo", 2: "Welt", 3: "Voll", 4: "Inline text"}


def test_csv_semicolon_and_header_order():
    text = "target;id;source\nHallo;7;Hello\n;8;Empty\n"
    assert engine.parse_csv(text) == {7: "Hallo"}


def test_xliff2_import():
    xml = b"""<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0">
    <file id="f"><unit id="4"><segment><source>Hi</source><target>Salut</target></segment></unit></file></xliff>"""
    assert engine.parse_xliff(xml) == {4: "Salut"}


# --------------------------------------------------------------------- rebuild

def test_build_replaces_text_and_keeps_graphics(sample, segments):
    tr = {
        by_text(segments, "Annual Report").id: "Jahresbericht 2026",
        by_text(segments, "Text over an image").id: "Text über einem Bild",
        by_text(segments, "Circle").id: "Kreis",
        by_text(segments, "Portable Document Format").id: "Привет мир. " * 12,
        by_text(segments, "Rotated").id: "Randnotiz",
    }
    pdf, stats = engine.build_translated_pdf(sample, segments, tr)
    assert stats["replaced"] == len(tr)
    out = pymupdf.open(stream=pdf)
    src = pymupdf.open(sample)
    text = out[0].get_text()
    for value in tr.values():
        assert value.split(".")[0].strip() in text
    for gone in ("Annual Report", "Text over an image", "Circle", "Rotated margin note"):
        assert gone not in text
    # untouched segments are still there
    assert "Key figures" in text and "Total revenue" in text
    # images and vector graphics survive
    assert len(out[0].get_images()) == len(src[0].get_images())
    assert len(out[0].get_drawings()) == len(src[0].get_drawings())
    # rotated text stays rotated
    note = [l for b in out[0].get_text("dict")["blocks"] if b["type"] == 0 for l in b["lines"]
            if "Randnotiz" in "".join(s["text"] for s in l["spans"])]
    assert note and round(note[0]["dir"][1]) == -1


def test_build_keeps_neighbouring_lines():
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((60, 80), "First line here", fontsize=11)
    page.insert_text((60, 90), "Second line tight", fontsize=11)  # boxes overlap vertically
    page.insert_text((60, 160), "Far away", fontsize=11)
    buf = io.BytesIO()
    doc.save(buf)
    path = Path(pytest.importorskip("tempfile").mkdtemp()) / "tight.pdf"
    path.write_bytes(buf.getvalue())
    segs = engine.extract_segments(pymupdf.open(path))
    far = by_text(segs, "Far away")
    pdf, _ = engine.build_translated_pdf(str(path), segs, {far.id: "Weit weg"})
    text = pymupdf.open(stream=pdf)[0].get_text()
    assert "Weit weg" in text and "Far away" not in text
    assert "First line here" in text and "Second line tight" in text


def test_baseline_is_preserved(sample, segments):
    seg = by_text(segments, "Total revenue")
    pdf, _ = engine.build_translated_pdf(sample, segments, {seg.id: "Gesamtumsatz"})
    lines = [l for b in pymupdf.open(stream=pdf)[0].get_text("dict")["blocks"] if b["type"] == 0
             for l in b["lines"] if l["spans"][0]["text"].startswith("Gesamtumsatz")]
    ox, oy = lines[0]["spans"][0]["origin"]
    assert abs(oy - seg.origin[1]) < 1.0 and abs(ox - seg.origin[0]) < 1.0
