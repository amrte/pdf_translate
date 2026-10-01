# PDF Translate

A small web app for translating PDF documents **without losing their layout**:

1. **Extract**: upload a PDF. Every paragraph, heading, label and table cell becomes a numbered
   segment. Its position, font size, colour, weight, alignment and rotation are recorded.
2. **Translate anywhere**: export the segments for any external translator (DeepL, Google
   Translate, ChatGPT/Claude, a CAT tool or a human translator), or type translations directly in the app.
3. **Rebuild**: import the translated file. The app removes the original text and writes the
   translation in the same place. **Images, vector drawings, backgrounds, links and all
   untranslated text stay exactly as they were.**

![workflow](https://img.shields.io/badge/PDF-extract%20%E2%86%92%20translate%20%E2%86%92%20rebuild-3158d4)

## Standalone version (one HTML file, no server)

Current version: see [`VERSION`](VERSION) and [`CHANGELOG.md`](CHANGELOG.md). Each update adds 0.01.
The interface is in German by default; switch to English with DE / EN in the top bar.

The file is generated from `standalone/src/` with `python standalone/build.py`.

[`standalone/pdf-translate.html`](standalone/pdf-translate.html) is the whole app in a single
file. Download it and open it in a modern browser (Chrome, Edge, Firefox or Safari). Everything
runs locally on [MuPDF.js](https://www.npmjs.com/package/mupdf) (WebAssembly), so your PDF is never
uploaded. The first time it runs, the browser downloads the MuPDF engine (about 4 MB) from
cdn.jsdelivr.net. The last opened PDF and its translations are kept in the browser.

It is built for large documents. The PDF engine runs in background workers (up to 4, sharing
the extraction between them), so the page stays responsive. Only the visible part of the
segment list and the pages near the viewport are drawn. Redactions are merged into as few
rectangles as possible. As a reference point, a 615-page document with 20,000 segments opens
in about 3.5 s and rebuilds in about 7 s in headless Chromium on 4 cores.

**E-books:** the standalone version also translates **EPUB** and **FB2** books (also zipped FB2,
`.fb2.zip` / `.fbz`). Paragraphs, headings, list items, table cells, verse lines, footnotes, the
title and the table of contents become segments. Inline formatting is kept as numbered markers
(`<1>italic</1>`, `<2/>` for an image or footnote reference). The rebuild writes the translations
into the book's own XHTML / FictionBook files, so images, styles, links and footnotes are kept
unchanged, and you download a new `.epub` / `.fb2`. The viewer shows the book laid out as pages.

Extra features in the standalone version:

* **⟳ update PDF** on a segment card (or <kbd>Ctrl</kbd>+<kbd>S</kbd> in its text box) writes that one
  translation into the translated PDF immediately. Only its page is rebuilt from the original,
  so it takes milliseconds, and it works before or after a full **Build PDF**.
* **Help → Translate with AI** generates a prompt for ChatGPT, Claude or Gemini. The prompt
  keeps the `[[n]]` markers and asks for translations that fit the original space, keep form
  labels, and leave codes, numbers and paths unchanged. It can include document context, a
  glossary and a page range, and it copies the prompt together with the segments; you paste
  the AI's answer into **Import**.
* Markup tools (rectangle, ellipse, highlighter, pen, arrow, text note, whiteout, eraser) with
  colours and line widths; saved into the downloaded PDF as standard annotations.
* Page turning (‹ / ›, page field, Page Up / Page Down / Home / End) and undo / redo (Ctrl+Z / Ctrl+Y).
* AI prompt split into parts (default 1000 fields per part) for very large documents; numbering
  continues across parts.
* Full-screen PDF view (button or F), full screen for the whole app, fit width / fit page.
* Fields can be moved and resized on the page (drag the box / its handles); size, font, bold,
  italic and colour can be set per field (**Aa** on a card).
* Password protection is removed (restrictions automatically, an open password after you enter it).
* **OCR** for scanned pages (English, German, French, Ukrainian, Finnish, Chinese) with Tesseract.js,
  loaded on demand from cdn.jsdelivr.net; the translation is set on a patch of the paper colour.
* Fields with no letters (numbers, amounts, dates such as `30.09.2026`, times, `-`) need no
  translation. They are left out of exports, Copy, the AI prompt and the progress count, keep
  their original text, and appear under the "Numbers only (kept)" filter.
* Zoom with + / −, the fit-width button, or Ctrl + mouse wheel / pinch (zooms around the
  pointer); zoomed pages scroll fully in both directions.
* Form and table layouts: label/value columns without borders, wrapped cells and bold
  "Label:" + regular value pairs are detected as separate segments.
* Formulas (math fonts, or math signs without words) are kept as they are and are not sent for
  translation; superscripts and subscripts (m³, CO₂) are extracted as Unicode characters.
* Textbook layouts: paragraphs that flow around a heading or picture keep their shape, narrow
  table columns are kept apart, and lead-ins ("Grammatik:") never overlap the text after them.

How it differs from the server version: the built-in fonts cover Latin, Greek, Cyrillic,
Chinese, Japanese and Korean. For other alphabets you can load your own font. Right-to-left and
complex scripts (Arabic, Hebrew, Indic, Thai) are not shaped correctly in this version.

## Server version: quick start

```bash
pip install -r requirements.txt
python app.py
# open http://localhost:5000
```

Options (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `5000` / `127.0.0.1` | Where the server listens |
| `PDF_TRANSLATE_DATA` | `./data` | Where uploaded and generated PDFs are stored |
| `PDF_TRANSLATE_TTL_HOURS` | `48` | Uploaded documents older than this are deleted |
| `PDF_TRANSLATE_MAX_MB` | `100` | Upload size limit |

## Using it

* **Viewer (left):** the PDF pages with every segment outlined. Click a box to jump to its
  segment. After you build the PDF, switch between *Original* and *Translated* to compare them.
* **Editor (right):** the source text and a translation field for each segment. You can
  search, filter by page or status, and use **Ctrl+Enter** / **Alt+↓** to move to the next
  segment. Translations are saved in your browser automatically.
* **Export** offers these formats:

  | Format | Good for | How to import back |
  | --- | --- | --- |
  | `.txt` with `[[n]]` markers | DeepL, chatbots, any text translator | Keep the `[[n]]` lines |
  | `.docx` | Google Translate / DeepL document translation | Upload the translated `.docx` |
  | `.xlf` (XLIFF 1.2) | Trados, memoQ, OmegaT, Phrase, Crowdin… | `<target>` elements (XLIFF 2.0 also works) |
  | `.csv` | Excel / Google Sheets, human translators | Fill in the `target` column |
  | `.json` | Scripts and translation APIs | `segments[].target` or `{ "id": "text" }` |

* **Copy all** puts the whole document on the clipboard with `[[n]]` markers. Paste it into a
  translator, then paste the result into **Import**.
* **Build PDF** writes the translations into the PDF. Options:
  * *Font*: match the original style (sans / serif / mono), force one, or upload your own
    `.ttf`/`.otf` font.
  * *Use free space*: a single-line label whose translation is longer may grow into free space
    beside it, but never past a frame, table border, image or other text. Only then is it shrunk.
  * *Smallest text size*: the lowest scale allowed when a translation is too long for its box.

Built-in fonts cover Latin, Cyrillic, Greek, CJK, Arabic, Hebrew, Devanagari, Thai and more.

## How the rebuild keeps the layout

* Text is removed with PDF **redactions** set to remove *text only*
  (`PDF_REDACT_IMAGE_NONE`, `PDF_REDACT_LINE_ART_NONE`), so pictures and drawings under, over
  or around the text are not changed.
* The redaction area for each run of text is a thin band through the middle of the glyphs,
  so tightly set neighbouring lines are not caught by accident.
* The translation is laid out in the original box with MuPDF's HTML engine
  (`insert_htmlbox`). It uses the original size, colour, bold/italic, alignment
  (left/centre/right/justified), line spacing and rotation (0/90/180/270°). The first baseline
  is placed on the original baseline. If the text is too long, it is shrunk to fit.
* Table borders and other vector lines split text into separate segments, so table cells are
  translated separately.

## Limitations

* Scanned PDFs: use the OCR button in the standalone version (the server version needs OCR beforehand).
* Each segment gets one main style: the style used for most of its characters. In the
  standalone version, words in another style (bold, italic, colour, size) keep that style where
  the same word appears in the translation (names, romanisations, symbols, codes); other mixed
  formatting inside a paragraph is not kept.
* Text at an angle other than 0/90/180/270° is not changed.

## Project layout

```
app.py              Flask server and REST API
pdf_engine.py       extraction, exchange formats, PDF rebuild (PyMuPDF)
static/             single-page frontend (HTML/CSS/vanilla JS, no build step)
tests/              pytest suite and a sample-PDF generator
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/documents` | Upload a PDF (`file`) and get its segments |
| `GET` | `/api/documents/<id>` | Document info and segments |
| `GET` | `/api/documents/<id>/pages/<n>.png?variant=original\|translated&zoom=1.5` | Page image |
| `POST` | `/api/documents/<id>/export` | `{format, translations?, include_translations?, source_lang?, target_lang?}` returns a file |
| `POST` | `/api/documents/<id>/import` | Translated `file`, or JSON `{text}`, returns `{translations, matched, unknown, missing}` |
| `POST` | `/api/documents/<id>/font` | Upload a custom font |
| `POST` | `/api/documents/<id>/build` | `{translations, options}` builds the translated PDF |
| `GET` | `/api/documents/<id>/translated.pdf` | Download the result |

## Tests

```bash
pip install pytest
python -m pytest -q
```
