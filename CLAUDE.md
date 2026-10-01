# PDF Translate – notes for contributors

## Versioning (required for every update)

- The version lives in `VERSION` (e.g. `1.00`). **Every update to the app adds 0.01**:
  1.00 → 1.01 → 1.02 … Bump it once per delivered update, not per commit within the same update.
- Add a section for the new version at the top of `CHANGELOG.md` describing the change in
  user-facing terms.
- Rebuild the standalone app after changing `VERSION` or anything in `standalone/src/`:
  `python standalone/build.py` (it embeds the version into `standalone/pdf-translate.html`).

## Layout

- `standalone/src/` – sources of the single-file app: `template.html`, `style.css`,
  `i18n.js` (German default + English; every UI text goes through `t()` / `data-i18n`),
  `engine.js` (MuPDF WASM: extraction, layout, rebuild; also runs inside Web Workers),
  `ebook.js` (EPUB/FB2: segments from the XHTML/FictionBook source, rebuild, zip; runs with the engine),
  `office.js` (DOCX/PPTX/XLSX: segments from the Office Open XML parts, rebuild, HTML preview; runs with the engine),
  `icon.svg` (app icon; the template embeds it as favicon and logo), `ui.js` (interface), `markup.js` (markup tools, page navigation, undo/redo), `tools.js`
  (moving/resizing fields, per-field style, full screen, passwords, OCR, comparison view), `main.js`
  (start-up). `standalone/pdf-translate.html` is generated – do not edit it by hand.
- `app.py`, `pdf_engine.py`, `static/` – the older server version (Flask + PyMuPDF).
- `tests/` – pytest suite for the server version: `python -m pytest -q`.

## Interface texts

Add new strings to both `de` and `en` in `standalone/src/i18n.js`. German is the default.
