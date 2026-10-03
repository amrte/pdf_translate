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
  `engine.js` (MuPDF WASM: extraction, layout, rebuild; also runs inside Web Workers),
  `ebook.js` (EPUB/FB2: segments from the XHTML/FictionBook source, rebuild, zip; runs with the engine),
  `office.js` (DOCX/PPTX/XLSX: segments from the Office Open XML parts, rebuild, HTML preview; runs with the engine),
  `text.js` (SRT/VTT subtitles, Markdown, plain text: cues or paragraphs as segments, written back in place, laid out as a simple page; runs with the engine),
  `slides.js` (PPTX preview: the slides drawn as PDF pages – background, shapes, pictures, tables, text in place; runs with the engine),
  `pages.js` (page manager, engine side: a PDF or PPTX put together anew from reordered, removed, blank and copied pages/slides),
  `legacy.js` (OLE compound file reader; converts .doc/.xls/.ppt to the modern format on open),
  `doc.js`, `xls.js`, `ppt.js` (the three converters: Word 97–2003 → DOCX, BIFF8 → XLSX, PowerPoint 97–2003 → PPTX),
  `icon.svg` (app icon; the template embeds it as favicon and logo), `ui.js` (interface), `markup.js` (markup tools, page navigation, undo/redo), `tools.js`
  (moving/resizing fields, per-field style, full screen, passwords, OCR, comparison view), `picture.js`
  (brightness, contrast, rotation and crop for an opened picture), `pagesui.js` (the page manager dialog), `keywords.js` (keywords from the AI answer: list, PDF page, flashcards), `vocab.js` (the vocabulary: terms collected per language pair, with export to PDF and Anki and import), `theme.js` (the accent colour, chosen at random on start), `reading.js` (reading mode: a click on a text shows its translation in a bubble), `segedit.js` (splitting and joining PDF segments; the engine rebuilds them from the page's lines), `offline.js`
  (libraries stored in the browser for offline use), `main.js`
  (start-up). `standalone/Kameleon-<version>.html` is generated – do not edit it by hand.
- `app.py`, `pdf_engine.py`, `static/` – the older server version (Flask + PyMuPDF).
- `tests/` – pytest suite for the server version: `python -m pytest -q`.

## Interface texts

Add new strings to both `de` and `en` in `standalone/src/i18n.js`. German is the default.
