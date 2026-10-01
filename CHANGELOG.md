# Changelog

PDF Translate uses simple version numbers: the first versioned release is **1.00** and every
update adds **0.01** (1.00 → 1.01 → 1.02 …). The current version is in [`VERSION`](VERSION) and is
shown in the app's top bar and help dialog.

## 1.05

- Fixed: **Help → Translate with AI**, field "Fields per part": the default 1000 (and any other
  number not on a 50-step grid) was rejected by the browser with "Please enter a valid value. The
  two nearest valid values are 970 and 1020". Any whole number from 20 upwards is now accepted.

## 1.04

Layout fixes for textbooks, exercise sheets and other mixed layouts:

- **Text flowing around a heading or picture** (a paragraph that starts to the right of a heading
  box and then continues at full width) stays one paragraph. Its translation is laid out in the
  same shape, so it no longer covers the heading.
- **Narrow table columns**: cells only half an em apart (e.g. pinyin "Èr jiā èr shì jǐ?" next to
  "zwei?") are recognised as separate columns when they line up with the cells above or below.
  Cells on the same line are no longer joined across columns, so translations are not drawn over
  the neighbouring cell.
- **Headings and subtitles**: a line in another colour or typeface (a blue heading over an italic
  subtitle) is no longer merged with the next line.
- **Bold words and coloured symbols inside a paragraph** (bold pinyin, a small blue ■) keep their
  style, colour and size where they appear in the translation.
- **Lead-ins** ("Grammatik:", "Übungen; Landeskunde:"): when the translated lead-in is longer, the
  paragraph's first line now starts after it instead of overlapping it.
- Hanging indents (list items, a numbered question with its pinyin line underneath) are kept.
- A sentence ending in a colon followed by a bold word ("…sind: **yi** (…)") is no longer split
  as if it were a form label.
- Fill-in blanks (`_____`) and dot leaders are separate from the question text.
- Lines with slightly different right edges are no longer taken for right-aligned text.
- Cyrillic "т" in bold-italic and italic sans text no longer has gaps around it.

## 1.03

- **Layout fix for address and contact blocks** (e.g. letterheads): separate lines are no longer
  merged into one paragraph and reflowed over neighbouring text. New rules:
  - a line that starts with its own label ("Postanschrift: …") starts a new segment;
  - web and e-mail addresses are their own segments; a web address broken at a hyphen
    ("…versicherung" / "-bund.de") is joined back together;
  - rows of numbers or dates never form a paragraph;
  - label/value rows ("Telefon   030/ 865-0") stay separate rows;
  - a paragraph's box may never cover other text, so a translation can no longer be drawn over
    numbers or labels that stay in place.
- Paragraphs with a bold lead-in ("Hinweis: …") or a first-line indent keep it: the translated
  first line starts after the lead-in instead of underneath it.
- Paragraphs whose first line ends a little early are no longer split into "first line" + "rest".
- **AI prompt in parts** for large documents: "Felder pro Teil" (default 1000) splits the fields
  into parts, each with its own copy button. Every part contains the full instructions plus
  "part k of N, segments [[a]] to [[b]]"; the segment numbers continue from part to part, so the
  answers can simply be imported one after another. Copied parts are ticked.
- **Full screen** button (or F): shows only the PDF view; Esc leaves it.
- The **Help / AI** window is wider (up to 1080 px) with a larger prompt box.
- **New icon** (page with translate arrows) for the browser tab and the top bar
  (`standalone/src/icon.svg`, preview in `standalone/icon-preview.png`).

## 1.02

- **Markup tools** in a tool bar left of the page: rectangle, ellipse, highlighter, freehand pen,
  arrow, text note, whiteout (white box) and eraser, with 6 colours and 3 line widths / text sizes.
  Select a markup to move it, recolour it or delete it (Delete key); double-click a text note to edit
  it; Shift draws squares and circles. Markups are kept per document and saved into the downloaded
  PDF as standard annotations (still editable in other PDF programs). Download now works with
  markups only, too.
- **Page turning:** ‹ / › buttons, a page number field, and Page Up / Page Down / Home / End.
- **Undo / redo** (buttons and Ctrl+Z / Ctrl+Y) for markups, imports, "keep", "remove all" and
  translations changed in a box (once you leave the box).
- Keyboard shortcuts for the tools: V, R, O, H, P, A, T, W, E, Esc.
- **Special signs no longer turn into "?"**: the PDF now also uses the Symbol and ZapfDingbats
  fonts (≥ ⇒ ∅ ✓ ✔ ▲ ■ ★ …) and look-alikes for signs no built-in font has (⌀ → Ø, ► → ▶, ☐ → □).
  Imported files saved by Excel ("CSV") or Notepad in Windows or UTF-16 encoding are read correctly,
  Word "Insert › Symbol" characters (Symbol, Wingdings) are converted, and characters that cannot be
  drawn are listed in a message instead of appearing as "?". Text notes show every sign as well.

## 1.01

- New button (bin icon next to the progress bar) to **remove all translations**. It asks for
  confirmation, discards the translated PDF as well, and can be undone from the message that follows.
- The **target language** defaults to the interface language: German interface → German, English
  interface → English (export dialog and AI prompt). A language you type yourself is kept.
- The **source language** is no longer entered or guessed by the app: the AI prompt tells the AI to
  detect it (it may change within the document). XLIFF exports state it as `und` (undetermined).

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
