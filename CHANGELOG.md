# Changelog

PDF Translate uses simple version numbers: the first versioned release is **1.00** and every
update adds **0.01** (1.00 → 1.01 → 1.02 …). The current version is in [`VERSION`](VERSION) and is
shown in the app's top bar and help dialog.

## 2.60

- **Sharper pages.** Text and thin lines often looked soft, at any zoom. Two causes: the page picture was rendered up to a quarter step larger than its size on screen and scaled down by the browser, and the page body was centred with a transform that could leave it half a pixel off. Now the page's size on screen is snapped to whole device pixels (also on screens scaled to 125 % or 150 %), the picture is rendered at exactly that size – one picture pixel per screen pixel, in the original, the translation and the comparison view, turned pages included – and the body is placed on whole pixels. A zoom beyond about 430 dpi is still capped and scaled.

## 2.59

- **No repeated model loading.** When the formula model could not be fetched (a computer without access to the internet or to GitHub), every frame drawn by hand tried again, each time with a wait and an error. Now a failed load is remembered: "read as LaTeX at once" switches itself off with one message, frames are drawn without delay, and "Read … frames" in the bar tries again only when asked. The formula finder works without the layout model too, from the page's text alone, and says so once.

## 2.58

- **Formula finder: a formula after a lead-in on the same line.** "Dieser Strom wird in Gleich. (17.14) eingesetzt: H(r) = …" was left alone because text stood at the formula's height. A short lead-in to the left of the formula – one line ending with a colon, or of at most four words – no longer counts as running text: the formula is framed and the lead-in stays a text segment of its own, translated as usual. A sentence that merely ends in a formula ("… beträgt U = 5 V") is still left alone.

## 2.57

- **Formula finder: fewer misses, no bullets.** A line of a worked example such as "I_K = (24 + 12 − 10) mA = 26 mA" was taken for running text because of its many tokens and so kept its formula neighbours from being framed; now only words of three letters or more count as text (units like kΩ, mA and variables do not). A bullet before a heading ("• Zahlenbeispiel:") is no longer framed as a formula: a cluster needs a sign (=, +, −, ∫ …) or two formula pieces of its own.

## 2.56

- **Formula finder completed from the text itself.** The layout model alone passed over many displayed formulas on PDF pages (on one page of a textbook two of seven), and sometimes framed one twice. Now the formula pieces the PDF holds are clustered as well – pieces beside or above each other, a word such as "bzw." between them – and a cluster with no line of running text at its height is framed too; the model's and the text's finds are matched so that nothing is framed twice. In the test pages every displayed formula is found, text lines and lone letters are left alone.

## 2.55

- **Formulas found and framed automatically.** In a PDF with text, a displayed formula comes in many pieces (every run in the math font, every index, the limits of an integral are text objects of their own), so its boxes look shattered. The bar of the frame tool now offers "Find: this page / all pages": the layout model (about 7 MB, loaded once; the same that finds formulas on scans) looks at the drawn page, and every displayed formula it finds becomes a frame – the pieces inside it, with short words such as "bzw.", become one segment; long text lines next to it stay text, an equation number at the right margin is left out. With "read as LaTeX at once" the frames are read straight away, so a document's formulas can be done without drawing a single frame; a frame the model got wrong is removed like any other. Formulas within running text are not touched.
- The pieces of a PDF formula are grouped a little more generously for reading (an integral's limits, a fraction's parts).

## 2.54

- **All frames read at once:** with "read as LaTeX at once" switched off, frames are drawn first and then read together – "Read n frames" in the bar below the page reads every frame that has no LaTeX yet.
- **A prompt per picture:** a copied picture brings a prompt that lists only the numbers of the formulas on it (and says which picture of how many it is), so sending one picture at a time – when the chat takes only a few – no longer mismatches the numbers. "Copy formula prompt" lists the numbers per picture.

## 2.53

- **Quieter frames:** drawing a formula frame no longer scrolls the page and shows no message; its toolbar above the frame is the confirmation ("Remove frame" undoes). Reading it as LaTeX at once reports only when a formula could not be read reliably.

## 2.52

- **Frames read as LaTeX automatically, if wanted.** While the frame tool is on, a bar at the bottom of the page says what to do and offers "read as LaTeX at once" (on by default): every frame drawn by hand is read with the pix2tex model straight away; switched off, the choice is remembered. "Done" in the bar leaves the tool.

## 2.51

- **Formula frames from one button.** The frame tool is now only the "Formula" button, placed left of "AI" above the segment list (the ∑ tool in the rail beside the page is gone; <kbd>M</kbd> still works). After a frame is drawn, the toolbar above it appears by itself: "TeX" reads the formula without leaving the tool, so the next frame can be drawn straight away (<kbd>Esc</kbd> or the button leaves the tool).
- The OCR window says in one line how formulas are recognised by hand.

## 2.50

- **Fixed: cards drawn over each other in the segment list after formulas were framed.** A card's height was measured before its formula picture or rendered formula had arrived, and the following cards kept the old positions in some browsers. The list now measures a card again when its picture loads or its formula is set, and checks the cards on screen before placing them.

## 2.49

- **Checking the LaTeX by eye:** under a formula's picture, its card now shows the formula as the LaTeX sets it (rendered with KaTeX, fetched from the internet once), so the AI's or the model's reading can be compared with the original at a glance. Red parts are LaTeX mistakes; the LaTeX of a frame can be corrected in the box below, and the preview follows while typing. The same preview appears under the LaTeX of formulas found automatically. Where KaTeX cannot be fetched (offline), the LaTeX stands there as text.
- **"Formula" button beside "AI":** the formula-frame tool is also switched on and off from the toolbar above the segment list, not only from the rail beside the page.

## 2.48

- **Formula pictures carry their instructions.** Pasting only a picture into the AI chat left the AI without the prompt. Now every sheet has the instruction for the AI written at its top in short (formulas as LaTeX, words translated, answer as `[[n]]` lines), and a click on a picture button puts the formula prompt on the clipboard as text together with the picture, so chats that take both from one paste get both. The AI window names the order – 1. copy the formula prompt, 2. the pictures, 3. paste the answer – with the prompt button first and highlighted until it has been copied.
- **OCR window wider:** engine and languages on the left, pages, preparation, formulas and font on the right, instead of one long column.

## 2.47

- **Formula frames – formulas as pictures for the AI.** A new tool beside the page (∑, key <kbd>M</kbd>): drag a rectangle around a formula and it becomes a segment of its own, kept as it is in the translated document; the segments inside the rectangle – also what text recognition read as gibberish – belong to it from then on ("Remove frame" in its card or in the bar above it brings them back). Frames are remembered with the document (with the OCR result on recognised pages, as a segment edit elsewhere) and shown in the list with a picture of the formula.
- **AI window: "Formulas as pictures".** The frames' pictures are put together on sheets – each formula with its number [[n]] in blue at the left, as many as fit on one picture (at most about 1400 × 1400 px), so a document's formulas need only a few pictures. "Copy formula prompt" puts a prompt on the clipboard that asks for every formula as LaTeX with the words in it translated; each sheet is copied to the clipboard as a picture with one click (or all are saved as PNG files) and pasted into the same chat. The answer is pasted on the right like the text answer: `[[n]]` lines belonging to frames become their LaTeX – shown in the card (editable), copied with "copy", shown in reading mode. The page range and "only segments without translation" apply to the frames too.
- The "TeX" button of a frame reads it with the pix2tex model, as for other formulas.
- Fixed: version 2.46 did not start in English (a quote in a help text broke the interface texts).

## 2.46

- **Formulas on scans recognised and read far better.** A formula such as 1/(jωCx) = 1/(jωCN) · R₁/(R₂‖1/(jωC₂)) bzw. 1/Cx = … came out of OCR as scattered pieces ("jot, 1 JOCN 1 Ry Ri JOL? bzw …"), partly translated, with no LaTeX:
  - **Found without the layout model too:** fraction bars on the scan mark a formula (a thin line with the fraction's parts above and below it, not wider than them – table borders and underlines do not count); the pieces around it join it, also what OCR could only read as gibberish, and the formula's area grows over ink OCR missed (a "1" over a bar). Garbled pieces no longer count as prose ("JOCN", "jot," are not words); words read with confidence still keep a line as text, so labels in drawings stay translatable.
  - **LaTeX read reliably:** the formula is read at its own letter size (tried smaller and larger when unsure), clear of the text lines around it; a line with two formulas is read in its parts, a word between them ("bzw.") as `\text{bzw.}`; a reading stuck in a loop is not taken.
  - In a test, the formula above now reads correctly with Tesseract and with PaddleOCR, with and without the layout model.

## 2.45

- **Offline libraries: what can be fetched is kept.** When some files could not be downloaded (blocked on the computer, no connection), "Download as ZIP" stopped and saved nothing. Now the ZIP is made from all files that came through (named `…-partial.zip`); the message names the missing ones, and the ZIP holds a list of them with their addresses (`MISSING-FEHLT.txt`), so they can be downloaded by hand (e.g. on another computer). Chosen together with the ZIP – "Load ZIP file…" now also accepts the loose files, or "Load folder…" – they complete the set. "Store directly in the browser" likewise stores what it got and keeps files stored earlier for this version. A set without the document engine (MuPDF) still brings the rest while the engine comes from the internet.

## 2.44

- **No more freeze when clicking a formula in a large document:** since 2.42, a click on a formula (or a number) in a long PDF – several hundred pages with formulas in their text, or a scan with a text layer – blocked the app, for longer the more formulas the document had (11 s for 400 pages in a test, a freeze for bigger ones), and again after a restart. Finding which pieces belong to one formula was done over the whole document again for every formula shown; it is now done once and kept until segments change. The click takes a few hundredths of a second.

## 2.43

- **Pages turned upright for OCR:** pages with little text among many lines – circuit diagrams, drawings – were often turned upside down, because the measurement on the text lines (ink above against below them) is fooled there. Now a turn the measurement asks for, and any page where it is unsure, is tried first: the recognition reads the page small both ways round, and the page is only turned when that reads clearly better. Real upside-down and sideways pages are still turned; this costs a few seconds for such pages only.
- **Toolbars on turned pages:** after a page was turned (↻), the toolbar above a segment, the toolbar of a text note and the reading-mode bubble were shown turned with it (upside down). They now stay upright, above their box.
- **PaddleOCR reads Cyrillic and Greek:** with Russian, Ukrainian, Belarusian, Bulgarian, Serbian, Macedonian or Kazakh chosen, PaddleOCR uses PP-OCRv5's Cyrillic model; with Greek, its Greek model (about 27 MB each, loaded once; also for "Working offline"). Both read Latin letters and digits too (the Cyrillic one also German, French, Swedish …; not Polish, Czech, Slovak or Hungarian – the dialog says so). In tests on scanned pages: no wrong words in Russian, Ukrainian and Bulgarian, one in Greek.
- New OCR languages: Russian, Belarusian, Serbian (Cyrillic), Macedonian and Kazakh (also for Tesseract).
- Greek text is no longer taken for a formula (in PDFs and in recognised text): Greek words are text, single Greek letters (α, φ, Δ) still mark formulas.

## 2.42

- **Formulas on scanned pages:** OCR turned formulas into garbled text that was then "translated", and a fraction fell apart into several lines. Now a formula becomes one segment of its own: it is kept as it is (the scan stays, nothing is painted over) and not translated. It is recognised by its signs (a line without running text with =, ·, √, Σ, Greek letters …; the numerator and denominator of a fraction above each other are joined), and more reliably with the new option **"Find formulas with a layout model"** in the OCR dialog (about 7 MB, loaded once): it finds displayed formulas on the page, even when OCR could hardly read them; lists of symbols with their meaning stay translatable text.
- **Formulas as LaTeX:** the new option **"Read formulas as LaTeX"** in the OCR dialog reads every formula found with pix2tex (about 100 MB, loaded once and kept in the browser; 1–3 s per formula). It works in PDFs with text too: a formula's card has **"Read as LaTeX"** and **"Read all … formulas"**, the bar above the segment a **TeX** button; the pieces a PDF sets a formula in are read together, as one formula. The LaTeX is shown in the card, **"Copy LaTeX"** puts it on the clipboard, and it is kept with the document. Readings the model is not sure of are left out.
- "Working offline" can include the formula models (only finding, or finding and reading); they can also be downloaded by hand and chosen there.
- The model files are stored in the repository's `models/` folder with their licences (layout model: RapidLayout/PaddleDetection, Apache-2.0; pix2tex: MIT).

## 2.41

- Text recognition: PaddleOCR now offers three models to choose in the OCR dialog – **PP-OCRv5 mobile** (as before, about 35 MB), **PP-OCRv6 small** (the most accurate: no wrong words on both typewritten test pages, and on Swedish print it keeps å, ä and ö where v5 lost them; about 45 MB, a little slower) and **PP-OCRv6 tiny** (about 20 MB and more than twice as fast as v5, as good on the typewritten pages and better on Swedish; it does not read Japanese). Each model is fetched the first time it is used and kept in the browser; the note under the choice says whether it is already there. "Offline use" includes the model you pick (or none). If jsDelivr cannot deliver a file, it is fetched from unpkg instead.
- PaddleOCR: a word space the model left out on widely spaced typewriter text is put back (from the gap between the letters).

## 2.40

- Text recognition: a second engine, **PaddleOCR** (PP-OCRv5), to choose in the OCR dialog next to Tesseract. It runs in the browser (ONNX Runtime, WebAssembly) and offline: its files (about 35 MB) are fetched once and kept in the browser, and "Offline use" can include them in the ZIP or the stored set ("Include PaddleOCR"). It reads Latin script (German, Swedish, French …), Chinese and Japanese – not Cyrillic, Greek or Arabic (the dialog says so). On typewritten pages it was clearly more accurate in tests (0–1 wrong words of 104, Tesseract 2–5); on clean print both are about equally good, and Tesseract stays the default. The chosen languages decide umlauts and accents (an unsure "a" becomes "ä" when the second reading says so; an accent a language does not have is replaced). Its results go through the same steps as Tesseract's: straightening, paragraphs, uncertain words, searchable PDF.
- Recognised text in general: wide typewriter spaces that happen to stand one above the other are no column gutter any more (lines were cut into pieces); darker or fainter grey ink no longer starts a new paragraph (only a colour of its own does).

## 2.39

- The segment list: a card can be dragged by its handle (⠿, left of the number) to another place in its page's order – a line shows where it lands, the list scrolls along at its edges, Esc cancels. Alt+Shift+↑/↓ in a translation box does the same step by step. The order is the reading order: the AI prompt and the exports follow it, "join" takes the next segment; the segments are numbered anew, translations, styles and kinds go along, and the new order is kept when the file is opened again (undo in the message). Segments stay on their page – a segment cannot be dropped among another page's (the line turns red) – and recognised text moves among recognised text.

## 2.38

- OCR of typewritten pages: segments no longer sit inside other segments, and paragraphs stay whole. Three causes are fixed: wide, uneven typewriter spaces no longer count as column gaps in recognised text (the limit for scans is now 2.5 character heights instead of one); specks that the recognition reads as "|" only count as table borders when a real line is on the page there (ink along its whole height); and pieces of a row that Tesseract returns separately become one line again, in reading order (before, "je nach Der maximale …" could come out). A piece that is still left alone inside its paragraph joins its row. A single row of running text that looks darker (struck harder) no longer counts as bold and splits its paragraph.
- Segment toolbar: drawn icons instead of characters (some looked odd), and the segment number sits on the same line as the buttons.
- The toolbar of a text note showed behind the segment toolbar when a segment had been clicked before: selecting a note now closes the segment toolbar, and the note toolbar is on top.

## 2.37

- A click on a segment on the page opens a small toolbar above it (below it near the top of the page) with what can be done to that segment: treat it as a formula or as text (∑ / Aa), split it (✂, for segments of several lines) or join it with the next one (⤵), make it a header/footer group (⧉), open its style (Aa), correct recognised text (✎, OCR), keep the original as the translation (=), delete the translation (✕), copy the original (⎘) and – after building – write a changed translation into the file right away (⟳). Only what applies to the segment is shown; the number at the left jumps to its card in the list. The toolbar moves and zooms with the page, follows a box that is dragged, updates while you type, and closes with Esc or a click beside the boxes.

## 2.36

- Scans with an invisible text layer (PDFs from scanners and "make searchable" tools): the translation used to be drawn over the scanned words, which stay visible in the picture – both texts overlapped. Now the scanned lines are covered with patches of the paper colour (measured on the page) and the translation is set on them in the ink colour, as with the app's own OCR; the invisible original text is removed. Such segments say "OCR layer of a scan".
- Word, PowerPoint, Excel, e-books and subtitles: a translation that lost a marker such as <1>…</1> (a link, bold or italic text, a field) used to drop that link or formatting without a word. Now the segment shows "⚠ n marker(s) missing" (or "do not fit" for unknown or unclosed markers, which would appear as text), the list has a filter "Lost links / formatting", and after building a message says how many segments are affected, with a button to show them.
- Bilingual PDF (both layouts) keeps the document's metadata and XMP, language, viewer settings, page labels, attached files and layers (one switch per layer for all pages); page by page, the form stays fillable on the original pages (on the translated pages its fields are drawn).
- Notes and comments, text form fields, bookmarks and the document title are translated too: they appear as segments at the end of their page (filter "Notes, fields, bookmarks, title") and are written back into their place – the note's text, the field's value, the bookmark's title, the title in the document info and XMP. A bookmark without a translation of its own takes that of the heading or contents line with the same text, numbering kept ("2.1 …"). Bilingual PDFs use the translated bookmarks and title.
- Text inside a layer (optional content) stays in that layer when translated: switching the layer off hides the translation too.
- Translating a page again after an edit kept only its links; now its notes, comments and form fields stay as well.
- Annotations drawn over the text (a reviewer's rectangle) no longer count as table borders: lines are not split at their edges any more.

## 2.35

- Links stay in the translated PDF: table-of-contents entries, "see page …" references, web addresses and e-mail links keep working. Before, the step that removes the original text also deleted every link it touched – usually nearly all of them. Each link keeps its place, so it now covers the translated text set in the same box. Links also survive when a page is translated anew after an edit, and links and bookmarks pointing to that page keep finding it.
- Bilingual PDF: links work in both layouts. Page by page, a link on an original page leads to the original of its target page and one on a translated page to the translation (before, internal links all led to page 1). Side by side, the links are on both halves and lead to the same half of the target sheet (before, there were none).
- Bilingual PDF: the bookmarks (outline) of the original come along in both layouts and lead to the original pages.

## 2.34

- Anki decks with pictures and sounds: importing an .apkg now brings its media along. Each term keeps its picture, the spoken word and the spoken example sentence; the files are stored in the browser (IndexedDB), and the language-pair dialog shows how many files and MB come with the deck, with a tick box to take the words alone.
- Flashcards: the picture appears on the answer side, 🔊 buttons sit next to the word and the example sentence (keys P and S), and "🔊 Auto-play" speaks the word as soon as it appears (reversed cards: when they are turned). Document terms that are also in the vocabulary get its pictures and sounds too.
- Vocabulary: a small picture and a 🔊 button per term. "Back up" includes the pictures and sounds, and the Anki export (.apkg) contains them again. Files no longer used by any term are deleted when terms or pairs are removed.
- Better reading of Anki decks: the front and back fields are taken from the card templates, so columns such as "Key", "Traditional" or "Part of speech" are no longer mistaken for the word or its translation, and a separate "sentence meaning" field becomes the example's translation (e.g. HSK decks: 的 (de) = indicates possession …, "我是他的朋友。" = "I'm a friend of his.").
- Flashcards: the example's gap now also works for Chinese, Japanese and Thai (written without spaces) and for terms with a pronunciation in brackets ("的 (de)" → "我是他_____朋友。"). The Flashcards tab is available right after a first import into an empty vocabulary.

## 2.33

- Keywords → Flashcards: one place for all flashcards. The extra "Flashcards" buttons at the bottom (under Words and Vocabulary) are gone; instead the Flashcards tab has a switch above the cards – "This document (n)" or "Vocabulary <pair> (n)", the latter as the Vocabulary tab shows it (pair, search, filter, favourites). Opened from the Vocabulary tab, or without a document, it starts with the vocabulary; otherwise with the document's terms.

## 2.32

- Tables of contents keep their shape in the translation: an entry of the original (title, leader dots, page number) is recognised, and its translation is laid out the same way – the title where the original title starts, the page number right-aligned exactly where the original's ends, and dot leaders between them, set so that the dots of all entries stand in columns. Whatever leader the translation itself brings (dots, an ellipsis, spaces, none) is replaced; a translation without the page number gets the original's. Long titles wrap or shrink only as far as needed – the dots no longer take their room.

## 2.31

- Start page: "DROP A DOCUMENT HERE OR CHOOSE A FILE" sits midway between the chameleon and the format tags.

## 2.30

- The drop fields ("DROP A DOCUMENT HERE OR CHOOSE A FILE", also for importing translations and in the batch) are written wholly in capital letters, 2 px smaller.

## 2.29

- "CHOOSE A FILE" (German "DATEI AUSWÄHLEN") on the start page and in the import fields is written in capital letters.

## 2.28

- Start page and import fields: "Choose a file" is capitalised and no longer underlined (still in the accent colour, still clickable).

## 2.27

- Faster text recognition: several pages are read at once (up to three at a time, as many as the computer has cores to spare), and the preparation (turning upright, straightening, cropping, flattening, white paper) runs beside the interface instead of in it. A 5-page scan took 11 instead of 19 seconds on a 4-core computer, with the same result.
- "Restore original" for PDFs too: when the pages of a document were straightened, flattened, split or arranged anew, the original is kept. "↺ Original" in the message after the preparation for text recognition and "↺ Restore original" in "Arrange pages" bring it back (as for pictures already).
- Compact PDFs: the "PDF" button now asks for full quality or compact. Compact draws the pictures anew at about 170 dpi as JPEG – the test photo 3.4 MB → 0.4 MB, still sharp to read.
- After text recognition the language of the text is checked: when it looks like a language that was not chosen (a Swedish scan read as English, say), a message offers to recognise it again with that language – the OCR window opens with the language ticked and the pages filled in.
- Recognised text can be translated in a monospace (typewriter) font too.
- Fixed: when the language data for text recognition could not be loaded, a message says so (also in the other workers).
- Help lists the files needed for working offline, each with what it is for and when it is needed (the same list is in the README of the offline ZIP).
- The reader for iPhone photos (HEIC) is now part of the offline files too, so such photos open without internet as well.

## 2.26

- Words OCR was unsure of are marked: in the segment list they are highlighted (a tooltip says how sure the recognition was), the card says "n uncertain", and the new list filter "Uncertain OCR words" shows just the segments with such words – a quick way to check a recognised document. In the correction dialog (✎) they are outlined on the cutout of the page and listed. A corrected segment is no longer marked. (Pages recognised before this version have no marks; recognise them again to get them.)

## 2.25

- White paper: new option "Make the paper white (remove shadows and colour cast)" before text recognition (on by default). Where the paper of a photo or scan is grey, unevenly lit (the shadow at a book's spine, a lamp) or tinted, it becomes white and the text a little stronger; text shining through from the back of the page disappears too. Recognition gets clearly better (the test photo: whole paragraphs, umlauts right), the page is nicer to read and the PDF smaller (the test photo 2.0 → 1.2 MB). Clean scans and pages made on a computer are left as they are.
- Picture tools: "White paper" does the same for an opened picture (with "Apply"; "Restore original" brings the photo back).

## 2.24

- Open books split into their two pages: new option "Split open books into two pages" before text recognition (on by default). A photo or scan showing both pages of an open book (wider than tall, text on both sides of the spine) becomes two pages, each cut out, straightened and flattened on its own; a picture becomes a PDF of two pages. Single pages – also in two columns – stay as they are.
- "⫼ Split" in "Arrange pages" splits the selected pages by hand: at the spine when it is found, otherwise in the middle; the corners can then be adjusted with "By hand…".
- Several photos at once: choosing several pictures together (for example the pages of a chapter photographed one by one) opens them as one document, a page for each, in the order of their file names – ready for text recognition with all its preparation. Before, they went to the batch, which skips pictures. A mix of pictures and documents still goes to the batch.
- Fixed: when the language data for text recognition could not be loaded (no connection), the app waited for ever; it now says so.

## 2.23

- Pages lying on their side or upside down are turned upright: new option "Turn pages upright (sideways or upside down)" before text recognition (on by default). Which way up the text is, is found on the page itself – lines running down the page mean it lies on its side; upside down is told by the letters (ascenders and capitals above the small letters carry more ink than the descenders below). In a PDF the page is turned without re-encoding it; a picture is turned first, then straightened and cropped as usual.
- "⟂ Straighten" in "Arrange pages" and "Auto" in the picture tools turn pages and pictures upright too.
- Scripts without ascenders and descenders (such as Chinese) are only turned when they lie on their side.

## 2.22

- Searchable PDFs: a scan or photo whose text was recognised is saved with that text lying invisibly under the picture – the PDF can be searched, its text selected and copied, while it looks exactly as before. Each word sits where it is in the picture; text corrected by hand goes in corrected.
  - The "PDF" button is now there for recognised scans too, not only for pictures: in the original view it saves the original as a searchable PDF, in the translated view the translation.
  - In the translated PDF ("Download"), recognised text that has no translation is searchable as well.

## 2.21

- Much smaller PDFs from photos: large photos are compressed to JPEG before they become a PDF page. An iPhone photo (HEIC) gave a PDF page of about 18 MB, now about 3.5 MB (about the size of the photo itself); after the OCR preparation (straightened, cropped) 11 MB, now 2 MB.
  - HEIC, AVIF and WebP photos (without transparency) are read as JPEG instead of PNG, and saved as JPG again after translating or editing.
  - Large photographic PNG, TIFF and BMP pictures and JPEGs saved at a wastefully high quality are put into the page as JPEG (quality 90) – also for pages added in "Arrange pages". Screenshots, drawings and text that PNG packs well, and pictures with transparency, stay lossless.
  - Edited pictures (picture tools, OCR preparation) are saved at JPEG quality 92 instead of 95.

## 2.20

- Recognised (OCR) segments can be split and joined like the segments of a PDF: ✂ splits a segment between two of its lines, ⤵ joins it with the next recognised segment; the toast offers to undo it. A join keeps both translations, one after the other. The lines OCR found are now kept with its result, so pages recognised with an earlier version need to be recognised again first (a message says so).
- The recognised text can be corrected: ✎ on a recognised segment opens its text together with a cutout of the page at that place, for comparison. Ctrl+Enter or "Save" keeps the correction (saved with the recognition result, also after reopening the file; Ctrl+Z / Ctrl+Y undo and redo it); a corrected segment is marked "corrected", and "Recognised text" puts back what OCR read. Joining keeps corrections; splitting a corrected segment asks first, as the parts are made from the recognised lines.
- "Join with next" passes over numbers and dates that are not shown in the list: the segment is joined with the next card, as expected (also for PDF segments).

## 2.19

- Flattened pages come out as a rectangle, not a parallelogram: after the lines are made level, the left and right edges of the text block are found from where the lines start and end (a straight edge through most of them – indented first lines and short last lines don't count) and stood upright, so the line starts line up vertically. This also happens when the lines are straight but the edges lean once the page is pulled straight from its corners. It applies to "Flatten curved text lines" before text recognition, to "Flatten lines" by hand, and in "Arrange pages".
- The traced lines now reach to their first and last letter (before, they ended up to a line height short), so the lines are bent straight right to their ends, and the cut at the spine of an open book keeps clear of the neighbouring page more reliably.

## 2.18

- Opened pictures can be saved as a PDF: the new "PDF" button beside the build button saves the version shown – the original picture, or (in the translated or comparison view, once built) the translation – with markups, notes and turns. Bilingual PDFs of pictures were already possible with the two-page button.
- Text recognition of an area: "Only an area – marked on the page" in the OCR dialog. After "Recognise", drag a rectangle over the text on any page; its four corners can then be moved one by one, so the area can be any four-sided shape (a slanted or photographed block of text). "Recognise" or Enter reads only that part, pulled straight from its corners first – a slanted line is read as one line – and the text found is placed back on the page. Text recognised earlier on the page outside the area stays, with its translations; inside, the new reading replaces it. Dragging anew replaces the area; Esc or "Cancel" leaves.

## 2.17

- Photos from Android phones open the right way up: phones store a picture taken upright lying on its side and only note how to turn it (Exif orientation); the page now follows that note (all eight orientations, mirrored ones included), without recompressing the photo. This applies to JPEG and TIFF pictures, including Ultra HDR and motion photos, and to pictures added in "Arrange pages".
- RAW photos (DNG, from the Pro/RAW mode of Android cameras) open: the full-size JPEG preview stored inside is shown, upright, and the translation is saved as JPG. A DNG without a preview gets a clear message.
- HEIF pictures are recognised by all their brands (Samsung, Xiaomi and others write .heic/.heif with different labels), and an AVIF picture labelled as generic HEIF is still read as AVIF. The file dialog now also offers .heif, .hif, .dng and .jfif.

## 2.16

- Text notes have rounded corners (new notes by default; the ▢ button in the note's bar switches them on or off). The rounding grows with the font size and is kept in the saved PDF.
- Larger text in notes: the size field takes any size from 4 to 400 pt (typed in or picked from the list, which now goes up to 144), and A− / A+ step down and up. The space around the text grows with the size, so large text no longer touches the frame.
- The bar of a selected note stays within the visible page view: near the right edge it moves left, and in a narrow view its buttons wrap onto a second row instead of being cut off.

## 2.15

- Text recognition: three new options under "Before recognition", all on by default and remembered:
  - **Straighten tilted pages** – as before, each page's tilt is measured and turned away.
  - **Flatten curved text lines** – the lines of each page are traced; where they are clearly curved (a book photographed open), the page is bent so they lie straight. Straight pages stay as they are.
  - **Crop automatically (find the page)** – the paper is found in the picture, the background (table, dark edges, the neighbouring page of an open book) is cut away and the page is pulled straight from its corners. A scan without a border stays as it is.
  
  A picture is replaced by the prepared one ("↺ Restore original" in the picture tools brings the photo back); in a PDF only the pages that needed it are drawn anew, the recognised text and translations of the others are kept. A message tells how many pages were straightened, cropped and flattened.
- Straighten by hand → Page borders: "Find page" puts the four corners on the paper automatically, ready to be adjusted.
- Fixed: page borders and flattened lines together left the lines tilted (they were levelled in the photo and then tilted again by the corners); they are now levelled on the flattened page, which also makes the text recognition of such photos much better.

## 2.14

- Pictures: "↺ Restore original" in the picture tools discards all applied changes at once (crop, turns, straightening, page borders, flattened lines, brightness …) and opens the picture as it was loaded – also after several edits and after reloading the app. (Before applying, "Reset" and "Cancel" discard the changes not yet applied.)
- Fixed: "Apply" in the picture tools did not ask before replacing a picture whose text had been recognised already.

## 2.13

- Straighten by hand → **Flatten lines** (for a book page photographed open, its lines curved near the spine): "Find lines" traces the course of the text lines (within the page borders when they are set); drag along a curved line to add one, click a line to remove it; "Show result" shows the page bent straight. The bend is one smooth surface fitted to all lines plus the fine curl of each line, so single words are not dented; two lines traced by hand (the top and the bottom one) are enough to bend everything between them. Works for opened pictures and, in "Arrange pages", for PDF pages (the page is then saved anew as a picture).
- Fixed: dragging the border between the page and the fields far to the right left a large empty area on the right; the fields column now also wraps its rows when it is narrow instead of sticking out, and the toolbar above the page wraps when the page view is narrow.

## 2.12

- Text notes work properly: after typing (Enter; Shift+Enter for a new line) the note is selected and the selection tool is active again, so it can be moved, changed or deleted straight away. A click with the text tool on an existing note edits it instead of putting a new note on top; Esc closes the box and returns to the selection tool.
- A selected note shows a bar above it: font (Sans, Serif, Mono), size, bold, italic, text colour, background colour (or none), frame colour (or none; its thickness with the line widths on the left), opacity, and buttons to edit, copy, duplicate and delete. The last style used is kept for the next note. Everything is saved into the PDF as an editable note with the same look.
- Copy and paste for all markups: Ctrl+C, Ctrl+X, Ctrl+V (pasted where the pointer is, on any page), Ctrl+D duplicates, arrow keys move the selected markup (Shift: 10 steps), Delete removes it. Text pasted from elsewhere becomes a text note.

## 2.11

- Straighten by hand: "By hand…" in the picture tools, and in "Arrange pages" for the selected page (or a double click on a page), shows the page large with three ways to straighten it:
  - **Turn** – drag the page like a dial until the text lines run along the guides; the arrow keys turn by 0.1° (with Shift 1°), the slider and −/+ too, "Auto" measures.
  - **Draw a line** – along a text line or an edge of the page; the page turns so that this line is level (or upright).
  - **Page borders** – drag four corners onto the page's corners; a page photographed at a slant becomes a straight rectangle, the rest of the picture (the neighbouring page, the table) is cut away. A PDF page flattened this way is saved anew as a picture (and can be recognised again); a page that is only turned stays as it is.
- Picture tools: the panel is now a column beside the picture instead of lying over it, so the whole picture stays in view while choosing the crop area.

## 2.10

- Straighten tilted scans and photos. The tilt is measured on the text lines (up to ±15°, to a tenth of a degree); pages without clear text lines are left alone.
- Text recognition (OCR): "Straighten tilted pages first" (on by default) – tilted pages are turned straight before they are recognised, so the recognition is better and the translation sits straight on the page. Text recognised earlier on other pages and the translations are kept.
- Arrange pages: "⟂ Straighten" measures and straightens the selected pages; the field beside it turns them by hand (in degrees, + clockwise). The correction is shown on each page's picture ("⟂ +2.5°") and goes into "Apply" and "Save selection as PDF". A scan is only turned, not saved anew – its quality and the file size stay the same.
- Picture tools: "Straighten" with "Auto" and a slider in tenths of a degree, shown live; the crop area is chosen on the straightened picture.
- HEIC photos (iPhone) open in all browsers: where the browser cannot read them, a HEIC reader is loaded on first use.

## 2.09

- Pictures: an opened picture is shown whole – it fits the viewer in width and height (a large photo is reduced, a small picture enlarged up to twice its size) and keeps fitting when the window or the border to the fields changes, until you zoom yourself.

## 2.08

- Arrange pages: a page card is more compact – the page number sits beside two rows of buttons, and notes on the page ("was 3", "↻90°", the file it came from) are shown on its picture.

## 2.07

- Arrange pages: the tick boxes are gone – a click on a page's picture selects it (Shift+click: the pages in between too), and a selected page is marked by its coloured frame.

## 2.06

- PDF: headers and footers are recognised – text that recurs at the top or bottom of the pages (the same on at least 30 % of them, numbers such as page numbers aside). Each one is listed once ("Header · 25 pages") instead of on every page; translated once, every page gets the translation with its own numbers ("Page 5 of 26").
- Per group: "Translate once" (the default), "Keep original" (company names, document numbers, classification notes stay as they are) or "Each one separately" (as before). "for all" applies the choice to all groups of the document and to new documents.
- "Show pages" lists the single occurrences under the group; "detach" takes one out (a first page with a different header). ⧉ on any segment makes all segments with the same text one group – also in the body ("Not applicable." ×20).
- The AI prompt, the copied segments, the progress and the batch count each group once: on a 26-page report 556 instead of 868 segments go to the AI. The filter "Headers & footers" shows only the groups.

## 2.05

- Arrange pages: pages can be turned – ↻ on a page turns it 90° clockwise; "Apply" saves the turn in the PDF.
- Arrange pages: pages can be selected – click the picture or the box, Shift+click selects all pages in between, "Select all" selects everything. The selection can be turned left or right, removed, or saved as a PDF of its own ("Save selection as PDF"), in the order shown and with the turns; the open file stays as it is. ⤓ on a page saves just that page. For a presentation, selected slides are saved as a PPTX.

## 2.04

- PDF: text that stays as it is (section numbers, page numbers in a contents list) no longer jumps to the top of the page when the text around it is translated. Some PDFs move to the next line with a special text command; removing the original text there pushed every line after it upwards, and parts of the original showed up again over the page head. Checked on a 26-page system description: all numbers stay in place.
- PDF: bold headings stay bold when the bold font is named just like the regular one (both "TimesNewRoman"); the style is read from the font file itself.
- PDF: a bold heading in a larger size is no longer joined with the line below it ("Table of contents" with the first entry, a section title with the smaller bold subheading under it).

## 2.03

- Translate with AI and batch: the part buttons read "Part x of y: [[1]] – [[500]]" – the whole marker range of the part; the number of segments in it is in the tooltip.

## 2.02

- Translate with AI and batch: the parts follow the marker numbers. With 500 per part, part 1 is [[1]] – [[500]], part 2 [[501]] – [[1000]] and so on; skipped segments keep their numbers, so a part may hold fewer segments to translate.

## 2.01

- PDF: a contents entry whose title wraps onto a second line stays one segment again (the second line carries the leader dots). Checked on a real report: the translated contents page keeps one entry per line, with leaders and page numbers in place.
- PDF: the style of a segment is chosen by its letters and digits, so a bold title followed by leader dots stays bold in the translation.

## 2.00

- PDF: table-of-contents entries are no longer joined into one paragraph. A line that ends in leader dots and a page number is complete, and two lines that both start with a section number are two entries – so the translated contents page keeps one entry per line.
- Translate with AI: the part buttons lead with the number of segments and name the marker range after it; a tooltip explains why the markers run further than the count (skipped segments keep their numbers). Copying a part again flashes the button again.
- Flashcards: when the example is hidden or shown as a gap on the front, the back shows the original sentence above its translation.

## 1.99

- PDF: the tall parentheses and brackets of displayed formulas are recognised too (stretched reference shapes), so they no longer stay as "�".

## 1.98

- PDF: glyphs of fonts called "Symbol" (SymbolMT, Symbol, SymbolProportionalBT …) are recognised by their drawn shape as well. Subset fonts in books are often re-encoded, so the Symbol encoding gave the wrong letters (a Greek M for φ) or nothing at all for ≈ and ×; the encoding is now only a tiebreaker and fallback. Verified on a page of "VDE 0100 und die Praxis": cos φ ≈ 1,0, sin φ ≈ 0, ρ, κ, λ, Ω, ΔU and √3 all read correctly.

## 1.97

- PDF: the recognition of unknown maths-font glyphs is more robust – the two reading passes are matched by glyph position instead of order, the glyph is found by its position when drawn in isolation, and when it cannot be drawn alone its box is used instead. Glyphs that still stay unknown are reported in the browser console ("unknown glyphs"), with font, code and the nearest shape, for bug reports.

## 1.96

- PDF: characters from maths fonts that have no Unicode value are now recognised by their drawn shape – Greek letters (φ, ε, θ, Ω, Δ …), the degree sign, primes and operators – instead of being guessed from the Symbol encoding, which gave "θC" for "°C", "M" for "φ" and "H" for "ε". Only the Symbol font itself is still read by its encoding.

## 1.95

- PDF: characters from symbol and maths fonts that arrived as "�" (Ω, ≤, Δ and the like inside a text line, from fonts without a Unicode table) are read correctly now: the engine asks for the raw glyph codes in a second pass and reads them through the Symbol encoding.

## 1.94

- Built-in decks: a Swiss German deck (Züritüütsch → Deutsch, 260 cards) is baked in; "Schweizerdeutsch" / "Swiss German" is known as the language code gsw in the pair dialog.

## 1.93

- Built-in Anki decks: `.apkg` files copied into `standalone/decks/` are baked into the app when it is built. They appear under Vocabulary → "Built-in decks (n)" with their cards, pair and a sample; "Add" puts them into the vocabulary of a language pair, confirmed in the pair dialog. A file named like `Name.de-en.apkg` presets the pair. `python standalone/decks.py` lists what the build would embed.

## 1.92

- Vocabulary: a statistics bar shows how many words of the pair are new, learning or mature, what is due today, and the streak of study days.
- Vocabulary: a filter narrows the list by learning stage (due today, new, learning, mature); flashcards and all exports take the shown rows, so "only due" or "only favourites" exports are one click away.
- Vocabulary: "Duplicates (n)" merges terms that differ only in case, an article or punctuation, keeping translations, examples, favourite and learning state.
- Vocabulary: "Card sheet PDF" prints the shown words as flashcards – eight per A4 sheet, fronts and backs on consecutive pages for duplex printing, with cut lines.
- Vocabulary: "Back up" saves the whole vocabulary with its learning state as one file; "Import…" loads it on another device and merges it with what is there.

## 1.91

- Words: a "Word groups" view lists the pairs and triples of words that repeat in the document (such as "in Betrieb nehmen"), with their counts and passages; they are selected and sent to the AI like single words.
- Words: the list can be sorted by frequency, alphabetically or in the order of first occurrence, and narrowed to the selected entries.

## 1.90

- Flashcards: the example sentence on the front is shown as a gap by default (the word blanked out), or whole, or not at all – chosen above the card and remembered. The back always shows it whole.
- Flashcards: four grades instead of two – Again, Hard, Known, Easy (keys A/H/K/E or 1–4), each button showing when the word comes back.
- Flashcards: "Due today" brings the new words first, as many per day as set ("New/day", default 20), then the reviews with the most overdue first; the rest of the new words wait for the next day.

## 1.89

- Help: a "Learn" section explains the keyword list, the Words tab, the flashcards with their intervals and keys, and the vocabulary with its exports and imports, and links to the free Anki decks at ankiweb.net/shared/decks.

## 1.88

- An easter egg: ten quick clicks on the chameleon in the top bar.

## 1.87

- Start screen: the separate "Several files at once" button under the drop area is gone; the "Batch" button in the top bar opens the batch there as well.

## 1.86

- Learn: the PDF preview of the keyword list and the vocabulary is drawn for the width it is shown at and for the screen's pixel density, so it stays sharp when zoomed to the window's width.

## 1.85

- Batch: several files at once. Drop or choose more than one file, or open the batch from the start screen (and from the top bar while it has files). The files are read in the background and their segments collected; one prompt covers them all, part by part, with the numbers running across the files. The answers pasted into the batch window are sorted back into each file's translations, so a file opened from the batch is translated already and only needs its build and download. "Open next file" steps through the batch; a downloaded file is marked.

## 1.84

- Learn: a "Words" tab lists every word of the open document by frequency, with the number of occurrences and a passage, without the most common function words of its language; words already in the vocabulary are marked. Tick words or select the most frequent ones, copy a prompt that asks the AI for translations and example sentences, and paste the answer on the right: the words arrive in the keyword list, the vocabulary and the flashcards.

## 1.83

- Flashcards: a "Due today" selection, now the default, brings up the new words and the known ones whose review is due. Known words come back after growing intervals (1, 3, 7, 14, 30 and then every 90 days); "Again" puts a word back to the start. When nothing is due, the window says when the next review comes.
- Flashcards: a "Reversed" switch (key R) asks from the translation for the term; the setting is remembered.

## 1.82

- Flashcards started from the vocabulary on the start screen (no document open) work again: the window switched straight back to the vocabulary and the cards stayed hidden.
- Flashcards: a switch above the card chooses between the new words and the whole vocabulary (or all terms of the document). "Known" is remembered in the vocabulary, so a word marked known once is no longer new; the choice is kept, and "Reset learning state" makes the words new again.

## 1.81

- The "Learn" button has moved from the editor toolbar into the top bar, left of "Help". It is there on the start screen too and opens the vocabulary when no document is open; the separate "Vocabulary" button of the start screen is gone.

## 1.80

- E-books: the cover is shown again for EPUBs whose title page wraps the cover picture in an SVG element (as Calibre and many publishers do). The page used to stay white; the book itself is saved unchanged.

## 1.79

- Translate with AI: the "Copy prompt only" button has moved into the left column, under the part buttons; only "Close" remains at the bottom right. The tick boxes ("Only segments without a translation", the term list and the PowerPoint options) sit in a row of their own under the fields instead of being squeezed beside them. The "AI" button in the toolbar is shown in the theme colour.

## 1.78

- Translate with AI: the window has two columns now. The prompt, its settings and the part buttons sit on the left; on the right the AI's answer is pasted or dropped as a file and imported straight away, with the same "replace translations already entered" option as the Import window. The window stays open, so a big document can be sent and imported part by part; a part whose segments are all translated is shown in green. The Close button sits at the right end of the window.

## 1.77

- Keywords: all fields of the window – the pair list, the search box and the term fields – have grey frames and the same corner radius as the buttons; the controls of the vocabulary bar share one height. The toolbar button is called "Learn" now, and the "PDF preview" button sits next to "Download PDF".

## 1.76

- Keywords: the fields have grey frames, and the buttons beside them are as tall as the fields.
- Keywords: the PDF preview shows every page of the list, stacked, not only the first – in the small view and in the enlarged one.
- Vocabulary: a "PDF preview" button shows the pages of the vocabulary PDF (for what is shown: the pair, the favourites or the search's hits) in place of the list; the Anki text export is gone, the Anki package (.apkg) stays.

## 1.75

- Favourites: every flashcard carries a small chameleon in its corner – a click (or F) keeps the word as a favourite, another click takes the mark off. The same chameleon sits on each row of the vocabulary. In the vocabulary a "Favourites" toggle shows only the favourites of the pair, and the pair list has an entry "Favourites (all language pairs)" that gathers them across pairs with a badge naming each pair.
- Vocabulary: flashcards, the PDF, the Anki text and the Anki package now take exactly what is shown – the whole pair, the favourites or a search's hits – so the favourites can be learnt and exported on their own.

## 1.74

- Vocabulary: the language pair of an import is confirmed in a small dialog before anything is added – prefilled with what the deck's field names say ("Hanzi", "English") or what the texts look like, and editable. Anki fields for pronunciation (Pinyin, reading, romaji …) are no longer taken as the translation but kept with the term, as in "的 (de)"; audio and picture fields are ignored.
- Vocabulary: terms can be moved to another pair – one at a time with the ⇄ button on its row, or in a batch with "Change language pair…" (all terms of the pair, or just the hits of a search).

## 1.73

- Vocabulary: Anki packages (.apkg) are read and written. "Import…" takes a deck exported from Anki or downloaded from AnkiWeb – the notes become terms (front, back, example field) of the detected or chosen language pair, HTML and sound tags stripped. "Anki package (.apkg)" writes a package of its own with a deck "Kameleon xx → yy", one card per term with the example sentences on both sides, which Anki opens by double-click. (Packages in Anki's newest compressed format need the export option "Support older Anki versions".)

## 1.72

- Vocabulary: the terms of every imported keyword list are collected per language pair (source → target) and kept in the browser across documents. The keywords window has a third mode "Vocabulary": pick a pair, search, edit or delete terms, add the open document's terms, learn the whole pair as flashcards, download it as a PDF or as a text file for Anki (File → Import; term and translation with their example sentences), and import such a file or any "term = translation" list. The AI prompt now asks for the languages ("Languages: de → en"); without that line they are detected from the texts. A "Vocabulary" button on the start screen opens it without a document.

## 1.71

- PDF: segments can be split and joined. The scissors on a card open the segment's lines with a cut between each two; the ⤵ button joins a segment with the one that follows on the page. The new segments are built from the page's lines like the others, the numbering is redone and translations follow their segments (a join keeps both translations one after the other). The changes are remembered with the document and can be undone from the message.

## 1.70

- New file types: SRT and WebVTT subtitles, Markdown and plain text. Each cue or paragraph is a segment, the translation goes back into the file in place (line breaks, timings, formatting tags such as &lt;i&gt; and position codes like {\an8} are kept; Markdown headings, lists, quotes and table cells are translated, code blocks and HTML stay), and the viewer shows the file as a laid-out page. The bilingual version puts the translation under each cue or paragraph. Files in Windows-1252 or UTF-16 are read and written back as UTF-8.
- Excel: text boxes and shapes drawn on a sheet, chart titles and axis titles, and the texts inside formulas ("Above target", "Total: ") are translated too. A workbook with translated formula texts is marked so that Excel calculates it afresh when it opens.

## 1.69

- The chameleon takes the colour of the document: while a file is open, the accent colour of the app (buttons, boxes, icon) follows the dominant colour of its first page – pulled into a range that stays readable in the light and the dark theme. A page without a clear colour (plain text, grey scans) keeps the colour of this start, and closing the file brings it back.

## 1.68

- Top bar: the DE/EN switch and the full-screen button are as tall as the buttons beside them.

## 1.67

- Keywords: a larger window with roomier fields; the list and the flashcards share the same size. A click on the PDF preview shows the page at window width, another click brings the list back.
- Flashcards: the arrows and the "Turn" button sit together in the middle under the card, with "Again", "Known" and "Shuffle" centred beneath them.
- Icon buttons in the toolbars (zoom, full screen, reading mode, page manager …) have their icons centred.

## 1.66

- Reading mode: the bubble shows the text as a reader sees it – the formatting markers of e-book and Office segments (&lt;1&gt;…&lt;/1&gt;, &lt;2/&gt;) are left out or replaced by what they stand for.

## 1.65

- Reading mode (new button next to "Segments" in the page toolbar): the segment boxes stay out of sight, and a click on any text shows its translation in a bubble right over the passage – or, on the translated view, the original. A second click, a click elsewhere or Esc closes the bubble; a text without translation says so. Works for PDFs, pictures, e-books and Office previews, and the mode is remembered.

## 1.64

- The app icon (favicon and the logo in the top bar) shows the chameleon with its mouth closed, without the tongue. The large animated chameleon on the start screen is unchanged.

## 1.63

- Top bar: the full-screen button has a new icon – two diagonal arrows that point outwards, and inwards while the app is full screen.

## 1.62

- Start screen: the tagline under the drop area is no longer shown; the line stays empty so the layout does not move.

## 1.61

- PDF: the kind of a segment can be switched by hand. Every card has a "Formula" button that makes the segment a formula (kept as it is, left out of the translation and of the AI prompt), and a formula or numbers-only segment has a "Text" button that makes it translatable again. The choice is remembered with the document, survives OCR and marks the card and the box on the page like a detected formula.

## 1.60

- PDF: formulas whose signs come from a mathematical font without readable characters (Mathematical Pi, MT Extra, TeX and MathType fonts – the "=" that shows up as "5" or "?") are recognised as formulas by their font, as are short variable terms such as "dt", "dI" or "rL" and differences like "t₁ − t₀". Function names (ln, arctan …) no longer count against a formula. A number with its unit ("4.2 M") stays text.

## 1.59

- OCR: Arabic and Japanese are available as languages (the language data is fetched on first use, or stored with the libraries for offline use like the other languages).

## 1.58

- Presentations: speaker notes are now handled as what they are. The notes a slide carries (shown in the preview as the grey page after the slide) are labelled "speaker notes" in the segment list, "Translate with AI" leaves them out unless the new tickbox "Include speaker notes" is ticked, and the slide manager shows which slides carry notes and offers "Remove speaker notes" – Apply then strips all notes from the file, and the grey notes pages disappear.

## 1.57

- PDF: formula recognition covers more of what textbooks set – single Greek letters and lone symbols (Λ, Φ, Θ, x), equations in a Symbol-encoded font, phasor and fraction parts such as "U·e^jωt·e^jφu", indexed quantities like "R₂R₃ − R₁R₄", function terms like "ln r_a / r_M" and reaction equations such as "Zn + 2 OH⁻ → ZnO + H₂O + 2e⁻". They are marked as formulas, skipped by the translation and kept as they are in the rebuilt PDF.

## 1.56

- PDF: displayed equations are recognised as formulas far more reliably – math signs, Greek letters, sub- and superscripts, single-letter variables, symbol glyphs without a Unicode value and math fonts count, real words count against. A formula needs no translation (it is marked "formula" and skipped) and is drawn again from the original when the PDF is rebuilt, so its layout survives. Sentences that merely contain "x = 5" stay text.

## 1.55

- Equations in PowerPoint and Word files (Office Math) are now shown: the segment and the slide preview show them as readable text – fractions as a/b, powers and indices with small digits, roots, sums, integrals, brackets, matrices – and the equation itself stays in the file untouched.
- Greek letters and mathematical signs set in the old Symbol font (⊥, α, β, ≤, ∞ …) are read as the characters they stand for – in PDFs as well as in Office files – in segments and in the preview; a translated Office run leaves the Symbol font behind so that its text shows correctly.
- OCR: Greek is available as a language.

## 1.54

- Presentations: a field moved or resized inside a scaled group now moves by the right amount, in the preview and in the saved file.
- "Translate with AI": the term list option is one short line ("Term list, count: 10"), with a new tickbox "with example sentences" that asks the AI for an example sentence per term, in the original and translated.
- Keywords: the list holds the example sentences (editable), the PDF page shows them under each term, and a new "Flashcards" mode turns the terms into learning cards: click or Space turns a card, "Known" takes it out of the round, "Again" puts it at the end, with shuffle and keyboard browsing.

## 1.53

- Keywords: "Translate with AI" now also asks for the most important terms of the text with their translations (10 by default, adjustable, can be switched off). When the answer is imported, the list after the line [[keywords]] is taken over. The new "Terms" button opens them: edit the list, see the PDF page, copy it or download it as a separate PDF file.

## 1.52

- Presentations: fields can be moved, resized and restyled like in a PDF. Drag a segment's box on the slide to move its text box, drag the handles to resize it, and use "Aa" on the card to set size, font, bold/italic and colour. The preview and the rebuilt file follow: the shape gets its new place and size, the text its new style.

## 1.51

- A theme switch in the top bar: click to go from "as the system" to light to dark and back; the choice is remembered.
- Presentations: hidden slides are marked in "Arrange slides" and shown there only with the new "Show hidden slides" toggle; in "Translate with AI" a new tickbox, off by default, decides whether segments of hidden slides go into the prompt.

## 1.50

- The colour set is now 23 colours: Teal, Slate, Steel, Graphite and Aubergine are gone, the yellows Lemon, Mustard and Saffron are new, plus two rare ones: Black turns up once in about 500 starts, and the Rainbow, with the icon, name, buttons and progress bar in a rainbow gradient, once in about 1000. Both can be forced with `#accent=Black` or `#accent=Rainbow`.
- The Kameleon's closed mouth line is a little shorter.

## 1.49

- Kameleon changes colour: at every start the app picks one of 25 accent colours at random, for the icon, the name, buttons, highlights and the paper tint, in light and dark mode. A colour can be forced for a look with `?accent=Name` (or `#accent=7`) added to the file's address.
- The name in the top bar is a little larger and sits, with the version number, slightly lower next to the icon.

## 1.48

- Pages of a PDF and slides of a presentation (PPTX, PPT) can be rearranged: the new "Arrange pages" button in the page view opens a grid of thumbnails where pages are dragged to another place, moved, swapped, removed, and blank pages or the pages of other files (PDF and pictures for a PDF, PPTX/PPT decks for a presentation) are inserted. Apply puts the file together anew and carries the translations of the kept pages over.

## 1.47

- PowerPoint: the text of SmartArt diagrams is now translated. Each line of a diagram is a segment (marked "diagram") in the slide's order, the "Translated" view shows the translations inside the drawn diagram, and the rebuilt file carries them both in the diagram's data and in the stored drawing, so PowerPoint and other programs show the translation.

## 1.46

- PowerPoint: slides are now shown as they look. The preview draws each slide with its background, the shapes and pictures of the slide, its layout and its master, tables, and the text in its real place, size and colour; the "Translated" view sets the translations into the same boxes and shrinks them to fit where needed. SmartArt diagrams are drawn from the copy PowerPoint stores (their text is shown, not yet translated); charts appear as a placeholder box. Speaker notes follow each slide on a page of their own. Decks that cannot be drawn fall back to the former text preview.

## 1.45

- PowerPoint preview: each slide now shows its text first and its pictures below it, smaller than before and at most six per slide (the rest are counted). Pictures no longer push a slide's text onto a following page, so the preview pages follow the slides more closely.
- Rebuilt Office and e-book files carry a valid date in their archive entries; some programs reject archives with an empty date.

## 1.44

- PowerPoint: the slide preview now shows the pictures too. Each slide's own pictures appear in their order among the text, and the slide's background artwork (its own, or the one it inherits from its layout or master) is shown as a small strip at the top. The rebuilt file always kept every picture; only the preview left them out.
- The version number in the top bar sits on the same baseline as the name "Kameleon".

## 1.43

- The Kameleon's mouth line now lies exactly where its jaw opens, in the drop area and in the app icon. The jaw and tongue animation also no longer depends on a browser feature that Safari and Chrome treat differently, so the jaw turns about the same hinge everywhere.

## 1.42

- "Fit to width" now uses almost the whole page view: the margins left and right of the page are down to a few pixels.

## 1.41

- The "Recently opened" row on the start screen no longer overlaps the drop area; it sits a few pixels below it.

## 1.40

- "Fit to width" and "Fit the whole page" now work for pictures too. A photo at its own resolution makes a very large page, and the zoom used to stop at 25 %, so the page never fitted. The zoom now goes as low as the page needs, and it is set finely enough that the fitted page no longer overhangs the view by a few pixels.

## 1.39

- Fixed the start screen of 1.38: the workflow steps were squeezed into narrow columns with cut-off text. They are back to full width.

## 1.38

- The workflow on the start screen can be folded: click its title to hide or show the six steps. The first start shows the workflow; from the second start on it is folded, and whatever you choose last is remembered for the next start.

## 1.37

- The app now says "Segments" everywhere it used to say "Fields": the "Segments" checkbox on the main screen (shows the segment boxes on the page), "Segments per part" in the AI dialog, and the part buttons, counts and hints there.

## 1.36

- **One button colour.** The download buttons, the "done" dots, the progress bar and the step-6
  badge use the same green as every other primary button, instead of a separate teal.

## 1.35

- **Several files at the same time.** Open the app in as many browser tabs as you like, each with
  its own document. A reloaded tab gets its own document back; a new tab shows the start page
  with a **"Recently opened"** list of the last eight documents, so any of them is one click
  away (the × removes an entry). The same document in two tabs stays in step: translations saved
  in one tab appear in the other.

## 1.34

- **Import: translations that begin with a quotation mark and an inline tag are no longer
  lost.** A pasted translation such as `«<1>Якщо</1> ми …` was read as a marker for segment 1
  (the mixed brackets `«<1>` looked like `[[1]]`), so the real segment kept its original text and
  segment 1 was overwritten. Markers now have to use one kind of bracket, repeated and matching
  (`[[12]]`, `((12))`, `【【12】】`). If this happened to you, import the translation again.

## 1.33

- **EPUB: no more vanishing words.** Books often embed fonts that only contain the letters of the
  original text (a bold display font on the table of contents, for instance). The translated book
  used those fonts for the new text, and readers drew nothing for the missing letters, so "РОЗДІЛ
  1" showed as "1". The rebuild now checks every embedded font (TTF, OTF, WOFF) against the
  letters of the translation and switches off the fonts that cannot show it; the reader then
  uses its default font for those parts. A message after the build says when this happened.

## 1.32

- **New logo: the Caravan.** The app icon, the favicon and the top-bar logo are now the one-colour
  camel-chameleon on forest green. In the drop area the same animal opens its mouth and puts out
  its tongue while a file hovers over it, and snaps when the file lands.
- **Colours tuned to the green mark:** a cooler, slightly green-tinted paper and borders in light
  and dark mode, a green brand line along the top bar, and the app name in the accent green.

## 1.31

- **The chameleon greets your file.** The drop area shows a larger Kameleon instead of the generic
  document icon. While a file is dragged over the area (or the mouse hovers over it), it opens
  its mouth and puts out its tongue; when the file lands, it snaps.

## 1.30

- **Offline libraries on your computer.** Help → "Working offline" now downloads the libraries
  as a ZIP file (`Kameleon-offline-<version>.zip`, with the chosen OCR languages). Without
  internet, that ZIP or its unpacked folder is loaded with one click, in Help or directly on the
  start page when the engine cannot be fetched. Storing in the browser is optional ("keep loaded
  files in the browser"), so nothing has to live in the browser cache.
- **Picture tools.** When a picture is open, the left rail has a new button that opens a panel
  with brightness, contrast, greyscale, rotation in 90° steps and a crop area dragged on the
  page. Brightness, contrast and greyscale show in the preview at once; "Apply" changes the
  picture and starts the text recognition again.
- **The app file is named after its version** (`Kameleon-1.30.html`), so downloads of different
  versions can be told apart.
- The version number in the top bar is plain text without a frame.
- The text recognition languages are listed alphabetically.

## 1.29

- **Working offline.** The Help dialog has a new section "Working offline": one click downloads
  the document engine and the text recognition library (about 15 MB) plus the language data for
  the chosen OCR languages into the browser. From then on the app starts and recognises text
  without an internet connection. The section shows what is stored and when, and the copies can
  be deleted again. After an update of the app the stored copies are refreshed with one click.

## 1.28

- **More OCR languages:** Polish, Czech, Slovak, Hungarian and Bulgarian.

## 1.27

- **Pictures can be translated.** A JPG, PNG, GIF, BMP, TIFF, WebP, AVIF or HEIC file opens as a
  one-page document; the text recognition dialog opens right away, and the recognised text is
  translated like any scanned page. The download is a picture again (JPG for JPG, PNG otherwise)
  with the original pixel size; the bilingual version is a PDF.
- **More OCR languages:** Spanish, Portuguese, Dutch and Swedish.

## 1.26

- **No more "�" in words.** Some PDFs (typically printed from Word or Excel with Calibri) draw
  letter pairs such as "ti", "fi" or "ff" as one glyph without saying which letters it stands
  for; they showed up as a replacement mark ("Ac�vity"). The pair whose width matches the drawn
  glyph is now filled in, using the font's own letter widths, so the text reads "Activity".
- **OCR for chosen pages:** the text recognition dialog has a third option, "Specific pages",
  with a page list as in a print dialog ("1-3, 7"). It starts with the page you are on.
- **Rounded rectangles instead of pills:** the format chips, the version badge, the workflow
  step numbers, the drop icon and the colour swatches no longer have round or pill shapes.

## 1.25

- **New name and look: Kameleon.** The app is now called Kameleon ("Wechselt die Sprache,
  behält die Form" / "Changes language, keeps its shape"), with a chameleon icon and a warmer
  colour scheme in green and yellow, in light and dark mode. Saved files name Kameleon as the
  author of their annotations.
- **Start screen:** the drop area is as wide as the workflow overview below it, and the workflow
  steps are numbered again.

## 1.24

- **Word, Excel and PowerPoint 97–2003 files** (`.doc`, `.xls`, `.ppt`) can be opened. They are
  converted to the modern format when opened (text, tables, headers and footers, footnotes, slide
  text and speaker notes, sheet names, cell values and simple formatting such as bold, italic, size
  and alignment; formula cells keep their last calculated value; pictures and drawings are not
  carried over), translated like any Office file, and saved as `.docx`, `.xlsx` or `.pptx`.
  Encrypted files and files older than Office 97 are refused with a clear message.

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

**Word, PowerPoint, Excel, EPUB, FB2**

- A paragraph whose only letters come from a field (a PowerPoint date placeholder, for example)
  no longer makes the whole file fail to open.
- Zip entry names that are not flagged as UTF-8 keep their original bytes, so EPUBs and Office
  files with non-ASCII part names keep all chapters and open correctly after saving.
- When a translation drops one field marker (`<1/>`) but keeps another, the dropped one goes back
  in its original order; before, Word fields could end up with their end before their start.
- Characters that are not allowed in XML are removed from translations and exports, so Word, Excel
  and translation tools accept the files.
- EPUB: the full HTML entity set (`&eacute;`, `&auml;` …) is understood; `<br>` and `<img>` without
  a closing slash no longer swallow the text after them when saving; a link with a stray `%` and
  an EPUB without `lang` are handled; DRM-protected EPUBs are refused with a clear message.
- Bilingual Word documents: the copied paragraph drops footnote and comment references and
  anchored pictures, so there are no duplicate footnotes or ids.
- Excel: cells with inline text beyond the preview limits stay translatable; an empty shared-string
  cell no longer shows the first string.
- Word content controls (form fields, cover pages) are translatable; a translation with several
  styles inside one hyperlink or field keeps one hyperlink or field; documents whose main part is
  not `word/document.xml` open; a literal `<1>` in the source text survives; the language attribute
  is added where it was missing; damaged and ZIP64 archives give a clear message.

**PDF engine**

- Formula fields that were moved or resized on several pages of a PDF with shared resources no
  longer all show the last page's formula.
- Field updates (⟳, Ctrl+S) copy a page's fonts and pictures once instead of on every update, so
  memory no longer grows with each update; saved files are smaller (fonts are subset on save).
- An unreadable file no longer leaves a destroyed document in the engine; documents, pages and
  fonts are freed when a build fails part-way; caches are cleared between documents.
- Two translated single-line fields on one row (a label and its value, say) no longer run into
  each other when both grow.
- CSV import: a quote inside a cell no longer swallows the following rows; JSON import skips
  invalid items instead of failing; broken-word widths include sub-/superscript sizes; a tiny or
  truncated DOCX gives a clear message instead of a crash.
- Office files are parsed once on open instead of twice.
- Known engine messages are shown in the interface language.

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
