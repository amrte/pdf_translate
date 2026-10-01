# Changelog

PDF Translate uses simple version numbers: the first versioned release is **1.00** and every
update adds **0.01** (1.00 → 1.01 → 1.02 …). The current version is in [`VERSION`](VERSION) and is
shown in the app's top bar and help dialog.

## 1.00

First versioned release of the standalone app (`standalone/pdf-translate.html`).

- Interface in **German (default)** and English, switchable with DE / EN in the top bar; the
  choice is remembered. The AI translation prompt follows the interface language.
- Version number shown in the top bar and the help dialog.
- More compact top bar and toolbars; on narrow screens the secondary toolbar buttons show icons only.
- Sources moved to `standalone/src/` with a build script (`standalone/build.py`).

Included from earlier, unversioned work:

- Extract text segments, export (TXT, Word, XLIFF, CSV, JSON), import translations, rebuild the
  PDF with the original layout, images and drawings kept.
- Runs completely in the browser on MuPDF (WebAssembly) in background workers; fast with
  documents of several hundred pages.
- Form and table layouts: label/value columns, wrapped cells and bold labels are separate segments.
- "⟳ update PDF" per segment (Ctrl+S) updates one segment in the PDF instantly.
- Help dialog with a ready-made AI translation prompt (context, glossary, page range).
- Fields with only numbers or dates are not translated.
- Zoom with + / −, fit width, Ctrl + mouse wheel / pinch; zoomed pages scroll fully.
