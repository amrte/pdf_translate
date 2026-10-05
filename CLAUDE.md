# Kameleon (formerly PDF Translate) – notes for contributors

## Versioning (required for every update)

- The version lives in `VERSION` (e.g. `1.00`). **Every update to the app adds 0.01**:
  1.00 → 1.01 → 1.02 … Bump it once per delivered update, not per commit within the same update.
- Add a section for the new version at the top of `CHANGELOG.md` describing the change in
  user-facing terms.
- Rebuild the standalone app after changing `VERSION` or anything in `standalone/src/`:
  `python standalone/build.py` (it writes `standalone/Kameleon-<version>.html`, named after the
  version, and removes the previous build; commit the new file and the removal together).

## Layout

- `standalone/src/` – sources of the single-file app: `template.html`, `style.css`,
  `i18n.js` (German default + English; every UI text goes through `t()` / `data-i18n`),
  `engine.js` (MuPDF WASM: extraction, layout, rebuild; also runs inside Web Workers; texts outside the page content – notes, text form fields, bookmarks, the title – are segments with `extra`, written back by `applyExtras`; invisible text (a scan's OCR layer) and text in optional content layers are marked per glyph by `glyphMarks`),
  `ebook.js` (EPUB/FB2: segments from the XHTML/FictionBook source, rebuild, zip; runs with the engine),
  `office.js` (DOCX/PPTX/XLSX: segments from the Office Open XML parts, rebuild, HTML preview; runs with the engine),
  `text.js` (SRT/VTT subtitles, Markdown, plain text: cues or paragraphs as segments, written back in place, laid out as a simple page; runs with the engine),
  `slides.js` (PPTX preview: the slides drawn as PDF pages – background, shapes, pictures, tables, text in place; runs with the engine),
  `pages.js` (page manager, engine side: a PDF or PPTX put together anew from reordered, removed, blank and copied pages/slides),
  `deskew.js` (straightening: the tilt of a scanned page or photo measured on its text lines, a PDF page's content turned straight, perspective and curved-line correction of pictures, the paper found in a photo for cropping, an open book split into its two pages, pages turned upright, the paper made white – used by OCR to prepare pages (preparePage); runs with the engine),
  `legacy.js` (OLE compound file reader; converts .doc/.xls/.ppt to the modern format on open),
  `doc.js`, `xls.js`, `ppt.js` (the three converters: Word 97–2003 → DOCX, BIFF8 → XLSX, PowerPoint 97–2003 → PPTX),
  `icon.svg` (app icon; the template embeds it as favicon and logo), `egg.jpg` (the easter-egg picture, embedded by the build as a data URI), `ui.js` (interface), `markup.js` (markup tools, page navigation, undo/redo), `tools.js`
  (moving/resizing fields, per-field style, full screen, passwords, OCR, comparison view), `picture.js`
  (brightness, contrast, rotation and crop for an opened picture), `pagesui.js` (the page manager dialog), `straighten.js` (straightening by hand: a page shown large, turned like a dial, along a drawn line, flattened from its four corners, or its curved text lines found/traced and bent straight), `keywords.js` (keywords from the AI answer: list, PDF page, flashcards), `words.js` (the document's words by frequency: a selection, a prompt for the AI, the answer imported as keywords), `batch.js` (several files at once: read by a worker of their own, one prompt across the files, the answers sorted back into each file's translations), `repeats.js` (headers and footers of a PDF: repeated text grouped, translated once or kept, members follow their lead), `vocab.js` (the vocabulary: terms collected per language pair, with export to PDF and Anki and import; the pictures and sounds of imported Anki decks are kept in IndexedDB as `vm:<hash>`, a row names them in `img`/`audio`/`exAudio`), `paddle.js` (the second OCR engine PaddleOCR: a PP-OCRv5 or PP-OCRv6 small/tiny model (`PADDLE_MODELS`: files, dictionary format, detection thresholds) run with ONNX Runtime Web in a worker of its own – detection, recognition, CTC decoding with the languages' accents – handing on Tesseract's result shape; files fetched once from jsDelivr and kept in IndexedDB as `paddle:<name>`), `anki.js` (Anki packages: a small SQLite reader and writer – decks imported from .apkg with their pictures and sounds, front/back taken from the card templates; the vocabulary exported as .apkg with its media), `theme.js` (the accent colour, chosen at random on start), `reading.js` (reading mode: a click on a text shows its translation in a bubble), `segedit.js` (splitting and joining PDF and OCR segments – the engine rebuilds them from the page's lines or the stored OCR lines – and correcting recognised text), `offline.js`
  (libraries stored in the browser for offline use), `main.js`
  (start-up). `standalone/Kameleon-<version>.html` is generated – do not edit it by hand.
- `standalone/decks.py` + `standalone/decks/` – Anki decks baked into the app: `.apkg` files in the
  folder are converted at build time (Python sqlite3) and embedded as JSON (`{{DECKS}}`); the app
  lists them under Vocabulary → "Built-in decks". The `.apkg` files are not committed.
- `app.py`, `pdf_engine.py`, `static/` – the older server version (Flask + PyMuPDF).
- `tests/` – pytest suite for the server version: `python -m pytest -q`.

## Interface texts

Add new strings to both `de` and `en` in `standalone/src/i18n.js`. German is the default.
