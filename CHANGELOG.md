# Changelog

PDF Translate uses simple version numbers: the first versioned release is **1.00** and every
update adds **0.01** (1.00 → 1.01 → 1.02 …). The current version is in [`VERSION`](VERSION) and is
shown in the app's top bar and help dialog.

## 1.23

Fixes from a full audit of the code and the interface.

**Dialogs and files**

- **Enter confirms a dialog** instead of cancelling it: the password of a protected PDF, the
  language in Export, the e-book language in Build. Before, Enter in those fields closed the dialog
  as if Cancel had been pressed, so a protected PDF silently did not open.
- A dialog that was confirmed earlier no longer carries that answer over to its next use.
- Dropping a Word, PowerPoint, Excel, EPUB or FB2 file onto the open workspace opens it (before only
  PDFs were accepted there; the start page accepted everything).
- Only the most recent file load counts: a file dropped while the last session is still being
  restored replaces that load instead of mixing with it. Files cannot be opened while a document is
  being built.
- Closing or replacing a document forgets everything that belonged to it: comparison view, open
  style panels, pending field updates, markups, undo history, translations in memory. The last edit
  before closing is saved even when ✕ is pressed within half a second.
- Opening another file while the comparison view is on no longer restores the previous document's
  zoom into the new one; the new file fits the width as usual.
- Cancelling OCR before the first page is finished keeps the built document and the undo history
  (before, both were discarded). Cancel now stops at once, also during the download of the
  recognition engine.
- If the browser storage is full, the app says so once instead of silently no longer saving
  translations.
- When the clipboard is unavailable, the copied source text shown in the Import window is no longer
  imported as translations by accident.
- A crashed engine worker is replaced and the document is reloaded into it; the message is shown
  in the interface language.
- Export errors and the "password-protected PDFs are not supported" message (passwords are
  supported) are gone or translated.

**Interface and accessibility**

- The drop zone on the start page can be reached with the keyboard (Tab, then Enter opens the
  file picker) and shows a focus ring.
- Messages and the busy overlay are announced to screen readers; every search, filter, page and
  translation field has an accessible name; dialogs are labelled by their titles; the colour
  swatches say their colour; the Download buttons are real buttons.
- The border between pages and fields can be moved with the arrow keys when it has the focus.
- Dark mode: search highlights use dark text on yellow; text on the blue, green and red fills and
  the active language switch meet the contrast minimum. Light mode: the muted grey and the green
  Download button are a little darker for the same reason.
- The top bar wraps on very narrow screens instead of running off the edge.
- Smaller fixes: the find highlights follow undo/redo of Replace all; Replace all cannot be
  triggered with Ctrl+Enter while its button is disabled; "whole word" search works in browsers
  without look-behind; the size field is capped at 500 pt; the full-screen button of the top bar
  leaves the view-only layout cleanly, and Esc leaves it also when the browser refused full screen;
  dragging a field keeps working when the mouse leaves the window; keyboard shortcuts are ignored
  while the busy overlay is shown; Ctrl+F in a text-note editor no longer closes the note; the
  resize handles of the active field are above the markups; reduced-motion settings are respected;
  texts that said "PDF" now say "document" where other formats apply.

## 1.22

- **New start page**: a larger drop zone with a big icon, a short title and badges for the formats
  (PDF, Word, PowerPoint, Excel, EPUB, FB2) on a soft colour wash; below it the workflow cards, each
  with an icon, and shorter texts. Still fits one screen from about 1280 × 700.
- Removed the long description and the privacy line under the drop zone, and the step indicator
  (1 Text extrahieren · 2 Übersetzen · 3 PDF erstellen) from the top bar.

## 1.21

- **One search field**: the field above the list now does everything. Typing filters the list to the
  segments with a match and highlights the matches; the number of matches and ‹ › (or Enter /
  Shift+Enter, F3) step through them. **⇄** next to it (or 🔍, Ctrl+H) opens the options (in both /
  in translations / in the original, match case, whole word) and replace. Ctrl+F puts the cursor in
  the field; Esc clears it. The separate find bar is gone.
- **"Segmente anzeigen" is now "Felder"** ("Fields").
- The tool bar above the pages no longer runs past the edge when the page view is narrow: it gets
  more compact and finally wraps onto a second line.

## 1.20

- **Start page**: the drop zone is the main element again, on top and in the middle (compact); the
  workflow is below it. The workflow cards no longer have coloured frames. The page still fits one
  screen from about 1280 × 700.

## 1.19

- **Start page fits one screen** (e.g. a 13" laptop, from about 1280 × 700): on wide windows the drop
  zone is on the left and the workflow on the right, in compact cards.
- The overview is called **Der Arbeitsablauf / The workflow**, and its steps are no longer numbered
  (the arrows show the order).

## 1.18

- **Workflow overview** on the start page and in **Help**: the six steps (open, hand out, import,
  rebuild, review and adjust, save), each with the app's own buttons as they look in the app, in
  German or English with the language switch.
- **Close a file**: the new **✕ Close** button in the top bar closes the open file and goes back to
  the start page (it is not reopened at the next start; its translations stay saved in the
  browser). **Open another file** now opens the file chooser at once; cancelling keeps the open file.

## 1.17

- **Comparison view**: one scrollbar (on the right) for both sides, and the two sides now move
  together in the same scroll step: a PDF's translated side follows exactly, e-books and Office
  documents follow paragraph by paragraph.
- **Markups in the comparison view**: rectangles, highlights, arrows, notes and the other markups
  are now shown on the translated side too (they are still drawn and edited on the original side).
- **Tool bar folds away**: the arrow at the top of the markup tool bar on the left folds it to a
  thin strip at the edge (and unfolds it again); the setting is remembered.
- **Adjustable border** between the page view and the translation fields: drag it left or right
  (double-click resets it). The pages fit the new width while you drag; the width is remembered.
  Pages also follow later size changes (window, full screen, folded tool bar) as long as the zoom
  is "fit width".

## 1.16

- **Comparison view**: the pages sit close together, with slim margins at the sides (the page
  number is shown in the toolbar). Going full screen, resizing the window or the panels fits both
  sides to the width again.
- **Font size of numbers and formulas**: number and formula fields now have the **Aa** button too.
  A number (or any untranslated field given its own style) is set again from its original text in
  the chosen size, font, weight and colour. A formula is drawn again from the original page, only
  scaled to the chosen size, so fractions, exponents and math fonts stay exact; dragging its box
  moves it, dragging the handles scales it.

## 1.15

- **Word, PowerPoint and Excel** (`.docx`, `.pptx`, `.xlsx`): open them like a PDF or e-book.
  Paragraphs, headings, list items, table cells, text boxes, headers, footers, footnotes, slide
  texts, speaker notes and the text cells of every sheet become segments. Text with its own
  formatting (bold, italic, colour, links) is marked `<1>…</1>`; fields (page numbers,
  references), tabs and footnote references `<2/>`. **Build** writes the translations back into the
  file, keeping styles, images, charts, formulas and numbers, and the download is a file in the
  same format. The bilingual download repeats each paragraph with its translation (Excel: both in
  the cell). The viewer shows a simple preview of the text: the document as one flow, one page per
  slide, one page per sheet. The AI prompt has rules for Office documents.
- **Compare view**: the new **Compare** button next to Original / Translated shows the original and
  the translation side by side. Both sides scroll together: page by page for a PDF, by matching
  paragraphs for e-books and Office documents (their translated pages differ). A click on a field
  on either side selects its segment; zoom applies to both sides.

## 1.14

- **Both languages on one page**: the bilingual download of a PDF now asks for the layout.
  *Side by side on one page* keeps the number of pages of the original and makes each page twice as
  large: portrait pages show the original on the left and the translation on the right, landscape
  pages the original on top and the translation below. Turned and cropped pages are placed as they
  are shown. *Alternating pages* is the earlier layout (odd pages original, even pages translated).
- **Font size arrows**: the size field (**Aa**) now shows the current size, so the up and down
  arrows start from it. Before, it was empty and jumped back to empty when the arrows reached the
  original size, so they could not go past it.

## 1.13

- **Font size of a field (Aa)**: the size field lost the cursor after the first digit, so sizes of
  10 and more could not be typed. It now keeps the cursor, and any size can be entered (there is no
  upper limit; the text may run past its box). Typing a number is one step for undo.
- **Fit width** button shows horizontal arrows.
- **AI** opens only the AI prompt, **Help** only the help.
- **Close cross (×)** in the top right corner of every pop-up window.

## 1.12

- **Import of answers copied from chat apps** such as Copilot: their answers come as Markdown, so a
  copy turns `[[12]]` into `\[\[12]]`, `2.` into `2\.` and can put all segments on one line.
  Pasted text like that is now recognised: the escapes are removed and markers inside a line start a
  new segment (as long as the numbers keep counting up, so a number in brackets inside the text
  stays text). Markers in **bold** or with one bracket lost are accepted too.

## 1.11

- **Layout fix for paragraphs tagged with "ActualText"** (replacement text that some PDF writers
  attach to whole paragraphs, e.g. for accessibility): such a paragraph was read as one line with a
  wrong, far too large box, and its translation came out as a single tiny line. On pages with
  ActualText the text is now read as it is drawn on the page (unless that would lose characters
  only the replacement text provides).
- **Deselect a segment** by clicking beside the boxes on the page, on the empty part of the segment
  list, or with Esc. The highlight and the resize handles disappear.

## 1.10

- **Font size above the limit**: a size set for a field (**Aa**) is now used exactly. The text is
  no longer made smaller to fit the box; it wraps at the box width and may run on below it (move
  or resize the box to make room).
- The **full-screen button** for the whole app is now in the top-right corner.
- **Find and replace** (🔍 button, Ctrl+F; Ctrl+H with replace): search the translations, the
  original or both, optionally case-sensitive or whole words. Matches are highlighted in the
  cards (also inside the translation boxes); Enter / Shift+Enter or F3 go to the next / previous
  match, which is shown on the page as well. Replace one match at a time or all at once; both
  can be undone.

## 1.09

- **Turn pages**: new ↻ button in the page toolbar turns the current page by 90° clockwise (with
  Shift: counter-clockwise). The page is shown turned, fields can still be moved on it, and the
  downloaded PDF has the page turned. Undo / redo work. (PDFs only.)
- **Bilingual download** (new button next to Download):
  - **PDF**: the odd pages are the original, the even pages the translation (page 1 original,
    page 2 translated page 1, page 3 original page 2 …). Turned pages and markups are included.
  - **EPUB / FB2**: e-books have no fixed pages, so each paragraph, heading, list item, quote
    and line of verse in the original is followed by its translation (same formatting); table
    cells hold both, one under the other; the title and the table of contents read
    "original / translation". With a language code in the build dialog, the translated
    paragraphs are marked with that language.
- Fixed: markups drawn before **Build PDF** were missing from the download.

## 1.08

- **Full screen for the whole app**: new button in the top bar (the existing button in the page
  toolbar still shows the pages only).
- **Fit page**: new zoom button that fits the whole page into the view (next to "fit width").
- **Move and resize fields on the page**: drag a segment's box to move its translation; select it
  and drag one of the eight handles to resize it. The original text is still removed from its old
  place. On the translated PDF the change is applied at once; the boxes there appear when you
  point at them. Moved boxes are dashed. Undo / redo work.
- **Size, font and colour per field**: the new **Aa** button on a card opens size (pt), font
  (as original / sans-serif / serif / monospace / your own font file), bold, italic, text colour
  and a reset button (↺) that also undoes moving and resizing.
- **Password-protected PDFs**: restrictions (no copying, no editing) are removed automatically. A PDF
  that needs a password to open asks for it once; afterwards the protection is removed. The
  translated PDF has no password. (Unknown passwords are not guessed.)
- **OCR for scanned PDFs**: new **OCR** button (and an offer when a PDF has pages without text).
  Languages: English, German, French, Ukrainian, Finnish, Chinese (simplified and traditional),
  in any combination. It runs in the browser with Tesseract; the engine and language data are
  downloaded the first time. Recognised text becomes normal segments (paragraphs, table cells,
  bullets, headings with size, bold and colour); when the PDF is built, each translation is set
  on a patch of the paper colour over the original text. Results are kept for the next session.
  Choose "All pages" to also recognise text inside pictures of normal PDFs.

## 1.07

PDF layout fixes for tables and formulas (technical and school books):

- **Formulas stay as they are.** Text set in math fonts, or with math signs (=, ·, ≈, π, ρ …) and no
  real word, is recognised as a formula: it is not translated, not exported and not sent to the AI,
  and the rebuild leaves it untouched. Before, fractions and exponents were flattened onto one line
  and the fraction bars struck through the text. Formulas are listed under the
  "Numbers & formulas (kept)" filter.
- **Superscripts and subscripts** (m³, 10¹⁰, CO₂) are extracted as ³, ¹⁰, ₂, so they come back as
  superscripts in the translation instead of "m3".
- **Table columns are no longer shifted**: the lead-in rule from 1.04 ("Grammatik:" followed by
  text) only applies across a word space. Before, a value cell could be pushed right by the full
  column gap when the translated label in front of it was longer.
- **Sans-serif text stays sans-serif** when the font's name does not reveal its family: the family
  is then taken from the measured letter widths instead of the font flags, which are often wrong.
  "Roman" and "Book" in a font name are no longer taken to mean serif (Univers-Roman, Gotham-Book).
- **Bold beginnings** such as "**Tabelle 2.3** Heizwerte …" stay bold in the translation up to the
  number ("**Таблиця 2.3** Теплота …").

## 1.06

- **EPUB and FB2 e-books** can now be translated, as well as PDFs. Open an `.epub`, `.fb2` or zipped
  FB2 (`.fb2.zip`, `.fbz`) the same way as a PDF.
  - Every paragraph, heading, list item, table cell, line of verse, footnote, the book title and the
    table of contents become segments. Export, Copy, Import, the AI prompt and the per-field
    **⟳ update** button work as for PDFs.
  - Inline formatting is shown as numbered markers: `<1>italic words</1>`, `<2/>` for an image or
    a footnote reference. Keep them in the translation to keep the formatting. If a translator
    drops them, the text is still used; images, anchors and footnote references are put back
    anyway. A drop-cap first letter goes onto the first letter of the translation.
  - **EPUB / FB2 erstellen** writes the translations into the book's own files: all other markup,
    images, styles, links and footnotes stay exactly as they were. The result is downloaded in the
    same format (`….translated.epub` / `.fb2`). Optionally the book's language code is set to the
    target language.
  - The viewer shows the book laid out as pages (original and translation), with a box for each
    segment; click a box to jump to its segment.
  - The AI prompt has rules for books (natural, complete translation; keep the `<n>` markers).
  - Markup tools are for PDFs only and are hidden for e-books.

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
