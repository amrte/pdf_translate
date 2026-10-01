"""PDF Translate - web app for translating PDFs while keeping their layout.

Run:  python app.py   then open http://localhost:5000
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import time
from pathlib import Path

import pymupdf
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

import pdf_engine as engine

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("PDF_TRANSLATE_DATA", BASE_DIR / "data"))
TTL_HOURS = float(os.environ.get("PDF_TRANSLATE_TTL_HOURS", "48"))
MAX_UPLOAD_MB = int(os.environ.get("PDF_TRANSLATE_MAX_MB", "100"))
DOC_ID_RE = re.compile(r"^[0-9a-f]{24}$")
FONT_EXTS = (".ttf", ".otf", ".ttc")

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


# --------------------------------------------------------------------------- #
# Storage helpers
# --------------------------------------------------------------------------- #

def doc_dir(doc_id: str) -> Path:
    if not DOC_ID_RE.match(doc_id or ""):
        abort(404)
    path = DATA_DIR / doc_id
    if not (path / "original.pdf").exists():
        abort(404, description="Document not found - please upload it again.")
    return path


def load_meta(path: Path) -> dict:
    return json.loads((path / "meta.json").read_text("utf-8"))


def load_segments(path: Path) -> list[engine.Segment]:
    return engine.segments_from_json(json.loads((path / "segments.json").read_text("utf-8")))


def cleanup_old() -> None:
    if not DATA_DIR.exists() or TTL_HOURS <= 0:
        return
    cutoff = time.time() - TTL_HOURS * 3600
    for child in DATA_DIR.iterdir():
        if child.is_dir() and DOC_ID_RE.match(child.name) and child.stat().st_mtime < cutoff:
            shutil.rmtree(child, ignore_errors=True)


def parse_translations(raw) -> dict[int, str]:
    out = {}
    for key, value in (raw or {}).items():
        try:
            out[int(key)] = str(value)
        except (TypeError, ValueError):
            continue
    return out


def view_payload(path: Path) -> dict:
    """Document info for the browser, with segment boxes in displayed (rotated) page space."""
    meta = load_meta(path)
    segments = load_segments(path)
    pages = meta["pages"]
    items = []
    for s in segments:
        page = pages[s.page]
        r = pymupdf.Rect(s.bbox) * pymupdf.Matrix(page["rotation_matrix"])
        r.normalize()
        items.append({
            "id": s.id, "page": s.page, "text": s.text, "size": s.size, "bold": s.bold,
            "italic": s.italic, "color": s.color, "font": s.font, "align": s.align,
            "rotation": s.rotation, "lines": s.lines,
            "view": [r.x0 / page["width"], r.y0 / page["height"], r.x1 / page["width"], r.y1 / page["height"]],
        })
    return {
        "id": path.name,
        "name": meta["name"],
        "pages": [{"width": p["width"], "height": p["height"]} for p in pages],
        "segments": items,
        "has_translated": (path / "translated.pdf").exists(),
        "has_font": any((path / f"userfont{ext}").exists() for ext in FONT_EXTS),
    }


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/documents")
def upload():
    file = request.files.get("file")
    if not file:
        abort(400, description="No file uploaded.")
    data = file.read()
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        abort(400, description="This file is not a readable PDF.")
    if doc.needs_pass:
        abort(400, description="Password-protected PDFs are not supported.")
    if doc.page_count == 0:
        abort(400, description="The PDF has no pages.")

    cleanup_old()
    doc_id = hashlib.sha256(data).hexdigest()[:24]
    path = DATA_DIR / doc_id
    path.mkdir(parents=True, exist_ok=True)
    (path / "original.pdf").write_bytes(data)
    segments = engine.extract_segments(doc)
    (path / "segments.json").write_text(json.dumps(engine.segments_to_json(segments)), "utf-8")
    pages = [{"width": p.rect.width, "height": p.rect.height, "rotation_matrix": list(p.rotation_matrix)}
             for p in doc]
    meta = {"name": file.filename or "document.pdf", "pages": pages, "uploaded": time.time()}
    (path / "meta.json").write_text(json.dumps(meta), "utf-8")
    doc.close()
    os.utime(path)
    return jsonify(view_payload(path))


@app.get("/api/documents/<doc_id>")
def get_document(doc_id):
    path = doc_dir(doc_id)
    os.utime(path)  # keep documents that are in use
    return jsonify(view_payload(path))


@app.get("/api/documents/<doc_id>/pages/<int:page_no>.png")
def page_image(doc_id, page_no):
    path = doc_dir(doc_id)
    variant = request.args.get("variant", "original")
    file = path / ("translated.pdf" if variant == "translated" else "original.pdf")
    if not file.exists():
        abort(404)
    zoom = min(max(float(request.args.get("zoom", 1.5)), 0.5), 4.0)
    with pymupdf.open(file) as doc:
        if not 0 <= page_no < doc.page_count:
            abort(404)
        pix = doc[page_no].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), annots=True)
        png = pix.tobytes("png")
    resp = send_file(io.BytesIO(png), mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store" if variant == "translated" else "max-age=3600"
    return resp


@app.post("/api/documents/<doc_id>/export")
def export(doc_id):
    path = doc_dir(doc_id)
    body = request.get_json(silent=True) or {}
    fmt = body.get("format", "txt")
    translations = parse_translations(body.get("translations")) if body.get("include_translations") else {}
    segments = load_segments(path)
    name = load_meta(path)["name"]
    stem = Path(name).stem or "document"

    if fmt == "txt":
        payload, mime, ext = engine.export_txt(segments, translations).encode("utf-8"), "text/plain", "txt"
    elif fmt == "docx":
        payload = engine.export_docx(segments, translations)
        mime, ext = "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
    elif fmt == "xliff":
        payload = engine.export_xliff(segments, translations, name, body.get("source_lang", "en"),
                                      body.get("target_lang", "")).encode("utf-8")
        mime, ext = "application/xliff+xml", "xlf"
    elif fmt == "csv":
        payload, mime, ext = engine.export_csv(segments, translations).encode("utf-8"), "text/csv", "csv"
    elif fmt == "json":
        payload = json.dumps(engine.export_json(segments, translations, name), ensure_ascii=False,
                             indent=2).encode("utf-8")
        mime, ext = "application/json", "json"
    else:
        abort(400, description=f"Unknown format: {fmt}")
    return send_file(io.BytesIO(payload), mimetype=mime, as_attachment=True,
                     download_name=f"{stem}.segments.{ext}")


@app.post("/api/documents/<doc_id>/import")
def import_translation(doc_id):
    path = doc_dir(doc_id)
    file = request.files.get("file")
    if file:
        parsed = engine.parse_import(file.filename or "", file.read())
    else:
        text = (request.get_json(silent=True) or {}).get("text", "")
        parsed = engine.parse_import("pasted.txt", text.encode("utf-8"))
    known = {s.id for s in load_segments(path)}
    matched = {k: v for k, v in parsed.items() if k in known}
    return jsonify({
        "translations": matched,
        "matched": len(matched),
        "unknown": sorted(set(parsed) - known),
        "missing": len(known) - len(matched),
    })


@app.post("/api/documents/<doc_id>/font")
def upload_font(doc_id):
    path = doc_dir(doc_id)
    file = request.files.get("file")
    ext = Path(file.filename or "").suffix.lower() if file else ""
    if not file or ext not in FONT_EXTS:
        abort(400, description="Please upload a .ttf, .otf or .ttc font file.")
    data = file.read()
    try:
        pymupdf.Font(fontbuffer=data)
    except Exception:
        abort(400, description="This font file could not be read.")
    for old in FONT_EXTS:
        (path / f"userfont{old}").unlink(missing_ok=True)
    (path / f"userfont{ext}").write_bytes(data)
    return jsonify({"ok": True, "name": file.filename})


@app.post("/api/documents/<doc_id>/build")
def build(doc_id):
    path = doc_dir(doc_id)
    body = request.get_json(silent=True) or {}
    translations = parse_translations(body.get("translations"))
    opts = body.get("options") or {}
    font_mode = opts.get("font_mode", "auto")
    if font_mode not in ("auto", "sans-serif", "serif", "monospace", "custom"):
        font_mode = "auto"
    font_path = None
    if font_mode == "custom":
        font_path = next((str(path / f"userfont{e}") for e in FONT_EXTS if (path / f"userfont{e}").exists()), None)
        if not font_path:
            abort(400, description="Upload a font file first, or choose another font option.")
    options = engine.BuildOptions(
        font_mode=font_mode,
        custom_font_path=font_path,
        expand=bool(opts.get("expand", True)),
        min_scale=min(max(float(opts.get("min_scale", 0) or 0), 0.0), 1.0),
    )
    started = time.time()
    pdf, stats = engine.build_translated_pdf(str(path / "original.pdf"), load_segments(path), translations, options)
    (path / "translated.pdf").write_bytes(pdf)
    stats["seconds"] = round(time.time() - started, 2)
    stats["bytes"] = len(pdf)
    return jsonify(stats)


@app.get("/api/documents/<doc_id>/translated.pdf")
def download_translated(doc_id):
    path = doc_dir(doc_id)
    file = path / "translated.pdf"
    if not file.exists():
        abort(404, description="Build the translated PDF first.")
    stem = Path(load_meta(path)["name"]).stem or "document"
    inline = request.args.get("inline") == "1"
    return send_file(file, mimetype="application/pdf", as_attachment=not inline,
                     download_name=f"{stem}.translated.pdf", max_age=0)


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
def json_error(err):
    if request.path.startswith("/api/"):
        message = getattr(err, "description", str(err))
        if err.code == 413:
            message = f"File too large (limit {MAX_UPLOAD_MB} MB)."
        return jsonify({"error": message}), err.code
    return err


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5000")),
            debug=os.environ.get("FLASK_DEBUG") == "1")
