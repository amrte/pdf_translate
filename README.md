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

[`standalone/pdf-translate.html`](standalone/pdf-translate.html) is the whole app in a single
file. Download it and open it in a modern browser (Chrome, Edge, Firefox or Safari). Everything
runs locally on [MuPDF.js](https://www.npmjs.com/package/mupdf) (WebAssembly), so your PDF is never
uploaded. The first time it runs, the browser downloads the MuPDF engine (about 4 MB) from
cdn.jsdelivr.net. The last opened PDF and its translations are kept in the browser.

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

* Scanned PDFs (text that is only an image) have no extractable text, so run OCR first.
* Each segment gets one style: the style used for most of its characters. Mixed formatting
  inside a paragraph (e.g. one bold word) is not kept.
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
