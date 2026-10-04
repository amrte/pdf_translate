/* ------------------------------------------------------------- keywords (glossary) */
// The AI can be asked for the most important terms of the text with their translations. They
// arrive in the answer after a line "[[keywords]]", are kept per document, can be edited, and
// become a PDF page of their own (shown in the dialog, downloadable).

const KW_MARK = /^[ \t]*\[\[\s*keywords?\s*\]\][ \t]*$/im;
const kwKey = (id) => `pdftr:kw:${id}`;
let kwPreviewTimer = null;
/**
 * Draws every page of a PDF into a container (stacked); earlier pictures are released. The
 * pages are rendered for the width they are shown at, on the screen's pixel density, so they
 * stay sharp when the preview is zoomed to the window's width: a container that grows is drawn
 * again from the same bytes.
 */
const KW_PAGE_W = 595.28; // A4, the keyword and vocabulary PDFs
function kwPreviewZoom(container) {
  const width = container.clientWidth || 340;
  return Math.min(6, Math.max(1.5, Math.ceil((width * (window.devicePixelRatio || 1)) / KW_PAGE_W * 4) / 4));
}
async function kwRenderPages(container, bytes, zoom = null) {
  zoom = zoom || kwPreviewZoom(container);
  const seq = (container._kwSeq = (container._kwSeq || 0) + 1); // (a newer render replaces an older one still drawing)
  container._kwBytes = bytes;
  const n = await pool.workers[0].call("pdfPageCount", { bytes });
  const imgs = [];
  for (let p = 0; p < n; p++) {
    const png = await pool.workers[0].call("renderBytes", { bytes, page: p, zoom });
    if (container._kwSeq !== seq) return n;
    imgs.push(URL.createObjectURL(new Blob([png], { type: "image/png" })));
  }
  container.querySelectorAll("img").forEach((im) => { if (im.src.startsWith("blob:")) URL.revokeObjectURL(im.src); });
  container.innerHTML = imgs.map((u, i) => `<img src="${u}" alt="${escapeHtml(t("page.n", { n: i + 1 }))}">`).join("");
  container._kwZoom = zoom;
  if (!container._kwObserver && typeof ResizeObserver !== "undefined") {
    container._kwObserver = new ResizeObserver(() => {
      if (!container._kwBytes || !container.clientWidth) return;
      if (kwPreviewZoom(container) > (container._kwZoom || 0) + 0.3) kwRenderPages(container, container._kwBytes); // shown larger: drawn sharper
    });
    container._kwObserver.observe(container);
  }
  return n;
}

function kwLoad() {
  try { state.keywords = JSON.parse(localStorage.getItem(kwKey(state.doc.id)) || "[]"); } catch (_) { state.keywords = []; }
  if (!Array.isArray(state.keywords)) state.keywords = [];
  kwRefreshButton();
}
function kwSave() {
  try { localStorage.setItem(kwKey(state.doc.id), JSON.stringify(state.keywords)); } catch (_) { /* storage blocked */ }
  kwRefreshButton();
}
function kwRefreshButton() {
  const b = $("#btnKeywords");
  if (!b) return;
  const n = state.doc ? (state.keywords || []).filter((r) => r.term.trim()).length : 0;
  b.querySelector(".kw-count").textContent = n ? String(n) : "";
}

/** Take the keyword list out of an imported text (stored); the rest is returned for the translations. */
function kwExtract(text) {
  const m = KW_MARK.exec(text);
  if (!m || !state.doc) return text;
  const after = text.slice(m.index + m[0].length);
  const end = after.search(/^\s*\[\[\s*\d+\s*\]\]/m); // (a numbered marker ends the list)
  const block = end < 0 ? after : after.slice(0, end);
  const { rows, pair } = kwParseRows(block);
  if (rows.length) kwTakeRows(rows, pair);
  return text.slice(0, m.index) + (end < 0 ? "" : after.slice(end));
}
/** The rows of a keyword list: "term = translation | example | translated example" lines, and the language pair line. */
function kwParseRows(block) {
  const rows = [];
  let pair = "";
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!line) continue;
    const lm = /^(?:sprachen|languages?|langs?)?\s*:?\s*([a-z]{2,3})\s*(?:→|->|–|-|>|⇒)\s*([a-z]{2,3})\s*$/i.exec(line); // "Sprachen: de → en"
    if (lm) { pair = `${lm[1].toLowerCase().slice(0, 2)}-${lm[2].toLowerCase().slice(0, 2)}`; continue; }
    // "term = translation | example sentence | translated example" (the examples are optional)
    const parts = line.split(/\s\|\s/);
    const mm = /^(.+?)\s*(?:=|—|–|->|→|\t)\s*(.+)$/.exec(parts[0]) || /^(.+?):\s+(.+)$/.exec(parts[0]);
    if (mm) rows.push({ term: mm[1].trim(), translation: mm[2].trim(), example: (parts[1] || "").trim(), exampleTr: (parts[2] || "").trim() });
  }
  return { rows, pair };
}
/** Imported rows go into the document's list and into the vocabulary of the pair. */
function kwTakeRows(rows, pair) {
  kwMerge(rows);
  if (pair) setCurrentPair(pair);
  const p = pair || currentPair();
  const added = p ? vocabAdd(p, rows, state.doc.name) : 0;
  toast(p ? t("kw.importedVocab", { n: rows.length, added, pair: pairLabel(p) }) : t("kw.imported", { n: rows.length }), "ok");
  return added;
}
function kwMerge(rows) {
  const have = new Map((state.keywords || []).map((r) => [r.term.trim().toLowerCase(), r]));
  for (const r of rows) {
    const k = r.term.trim().toLowerCase();
    if (!k) continue;
    if (have.has(k)) { const cur = have.get(k); cur.translation = r.translation; if (r.example) cur.example = r.example; if (r.exampleTr) cur.exampleTr = r.exampleTr; }
    else { state.keywords.push({ term: r.term, translation: r.translation, example: r.example || "", exampleTr: r.exampleTr || "" }); have.set(k, r); }
  }
  kwSave();
}

const kwRows = () => (state.keywords || []).filter((r) => r.term.trim() || r.translation.trim());
function kwPdfArgs() {
  const rows = kwRows();
  return {
    title: t("kw.title"), headers: [t("kw.term"), t("kw.translation")], rows,
    subtitle: t("kw.subtitle", { name: state.doc.name, n: rows.length, date: new Date().toLocaleDateString(LANG === "de" ? "de-DE" : "en-GB") }),
  };
}
async function kwPdfBytes() { return new Uint8Array(await pool.workers[0].call("keywordsPdf", kwPdfArgs())); }

function openKeywordsDialog() {
  kwRenderList();
  if (state.doc) kwSchedulePreview(0);
  openModal($("#kwDialog"));
  kwSetMode(state.doc ? "list" : "vocab"); // (without a document the window opens on the vocabulary)
}
function kwRenderList() {
  const list = $("#kwList");
  const rows = state.keywords || [];
  list.innerHTML = rows.length ? rows.map((r, i) => `<div class="kw-row" data-i="${i}">
      <input data-k="term" value="${escapeHtml(r.term)}" placeholder="${escapeHtml(t("kw.term"))}">
      <input data-k="translation" value="${escapeHtml(r.translation)}" placeholder="${escapeHtml(t("kw.translation"))}">
      <button type="button" class="mini" data-act="del" title="${escapeHtml(t("kw.remove"))}" aria-label="${escapeHtml(t("kw.remove"))}">✕</button>
      <input class="kw-ex" data-k="example" value="${escapeHtml(r.example || "")}" placeholder="${escapeHtml(t("kw.example"))}">
      <input class="kw-ex" data-k="exampleTr" value="${escapeHtml(r.exampleTr || "")}" placeholder="${escapeHtml(t("kw.exampleTr"))}">
    </div>`).join("") : `<p class="muted small">${escapeHtml(t("kw.empty"))}</p>`;
}
function kwSchedulePreview(delay = 500) {
  clearTimeout(kwPreviewTimer);
  kwPreviewTimer = setTimeout(async () => {
    try { await kwRenderPages($("#kwPreviewWrap"), await kwPdfBytes()); } catch (err) { console.warn("keyword preview failed", err); }
  }, delay);
}

function initKeywords() {
  $("#btnKeywords").addEventListener("click", openKeywordsDialog);
  const list = $("#kwList");
  list.addEventListener("input", (e) => {
    const row = e.target.closest(".kw-row"), k = e.target.dataset.k;
    if (!row || !k) return;
    state.keywords[Number(row.dataset.i)][k] = e.target.value;
    kwSave();
    kwSchedulePreview();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act=del]"), row = e.target.closest(".kw-row");
    if (!b || !row) return;
    state.keywords.splice(Number(row.dataset.i), 1);
    kwSave(); kwRenderList(); kwSchedulePreview();
  });
  $("#kwPreviewWrap").addEventListener("click", () => $("#kwDialog").classList.toggle("kw-zoom")); // the page at window width, and back
  $("#kwDialog").addEventListener("close", () => $("#kwDialog").classList.remove("kw-zoom"));
  $("#kwAdd").addEventListener("click", () => {
    state.keywords.push({ term: "", translation: "", example: "", exampleTr: "" });
    kwSave(); kwRenderList();
    const inputs = list.querySelectorAll('[data-k="term"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $("#kwCopy").addEventListener("click", () => copyText(kwRows().map((r) => `${r.term} = ${r.translation}${r.example || r.exampleTr ? ` | ${r.example || ""} | ${r.exampleTr || ""}` : ""}`).join("\n"), t("kw.copied")));
  initFlashcards();
  $("#kwDownload").addEventListener("click", async () => {
    try { saveBlob(new Blob([await kwPdfBytes()], { type: "application/pdf" }), `${stem()}.keywords.pdf`); } catch (err) { toast(userError(err), "error"); }
  });
}

/* ---------------------------------------------------------------- learning cards */
// The terms as flashcards: front the term (with its example sentence), back the translation.
// Click or Space turns a card; "Known" takes it out of the round, "Again" puts it at the end.
const fc = { queue: [], index: 0, flipped: false, known: 0, total: 0, all: [], scope: "new", example: "cloze", newCap: 20 };
const LS_FC_SCOPE = "pdftr:fcscope", LS_FC_REVERSE = "pdftr:fcreverse", LS_FC_EXAMPLE = "pdftr:fcexample", LS_FC_NEWCAP = "pdftr:fcnewcap", LS_FC_NEWDAY = "pdftr:fcnewday";
/** New words shown for the first time today, per pair: the daily cap counts against this. */
function fcNewToday(add = 0) {
  const day = new Date().toISOString().slice(0, 10), key = fc.pair || "doc";
  let rec = {};
  try { rec = JSON.parse(localStorage.getItem(LS_FC_NEWDAY) || "{}"); } catch (_) { /* fine */ }
  if (rec.day !== day) rec = { day, pairs: {} };
  rec.pairs[key] = (rec.pairs[key] || 0) + add;
  if (add) try { localStorage.setItem(LS_FC_NEWDAY, JSON.stringify(rec)); } catch (_) { /* fine */ }
  return rec.pairs[key];
}
/**
 * The vocabulary remembers which words were marked known (how often, and when). A word comes
 * up again after a growing interval: 1, 3, 7, 14, 30 and then every 90 days. "Again" puts it
 * back to the start.
 */
const FC_STEPS = [1, 3, 7, 14, 30, 90];
const DAY = 864e5;
const rowKnown = (r) => Number(r.known) > 0;
const fcInterval = (r) => FC_STEPS[Math.min(Number(r.known) || 1, FC_STEPS.length) - 1] * DAY;
const fcDueAt = (r) => (rowKnown(r) ? (Number(r.last) || 0) + fcInterval(r) : 0);
const fcDue = (r) => !rowKnown(r) || fcDueAt(r) <= Date.now();
/** The round: new words first (at most the day's cap in "due today"), then the reviews, the most overdue first. */
function fcScopeRows() {
  const fresh = fc.all.filter((r) => !rowKnown(r));
  if (fc.scope === "new") return fresh;
  if (fc.scope === "due") {
    const cap = Math.max(0, fc.newCap - fcNewToday());
    const due = fc.all.filter((r) => rowKnown(r) && fcDueAt(r) <= Date.now()).sort((a, b) => fcDueAt(a) - fcDueAt(b));
    return [...fresh.filter((r) => r._seen).concat(fresh.filter((r) => !r._seen)).slice(0, Math.max(cap, fresh.filter((r) => r._seen).length)), ...due];
  }
  return fc.all;
}
const fcWaiting = () => { // new words held back by the day's cap
  const fresh = fc.all.filter((r) => !rowKnown(r)).length;
  return fc.scope === "due" ? Math.max(0, fresh - Math.max(fc.newCap - fcNewToday(), fc.all.filter((r) => !rowKnown(r) && r._seen).length)) : 0;
};
function fcSetScope(scope, remember = true) {
  if (!["new", "due", "all"].includes(scope)) scope = "due";
  fc.scope = scope;
  if (remember) try { localStorage.setItem(LS_FC_SCOPE, scope); } catch (_) { /* fine */ }
  const rows = fcScopeRows();
  fc.queue = rows.map((_, i) => i); fc.rows = rows; fc.index = 0; fc.flipped = false; fc.known = 0; fc.total = rows.length;
  fcRender();
}

let fcSource = null, fcPair = ""; // rows other than the document's (the vocabulary) and their pair, while set
// The cards come from the open document's terms ("doc") or from the vocabulary as the Vocabulary
// tab shows it – pair, search, filter, favourites ("vocab"); a switch above the cards changes it.
let fcSrc = "doc";
const fcDocRows = () => (state.doc ? kwRows().filter((r) => r.term.trim() && r.translation.trim()) : []);
function fcVocabRows() {
  if (!vb.pair) { const pairs = vocabPairs(), cur = currentPair(); vb.pair = pairs.includes(cur) && cur ? cur : pairs[0] || ""; }
  return vb.pair ? vocabFiltered().filter((r) => r.term && r.translation) : [];
}
function fcStart() {
  // (without a document, or without terms in it: the vocabulary)
  if (fcSrc === "doc" && !fcDocRows().length && fcVocabRows().length) fcSrc = "vocab";
  if (fcSrc === "vocab") { fcSource = fcVocabRows(); fcPair = vb.pair; } else fcSource = null;
  fc.pair = fcSource ? fcPair : currentPair();
  let rows = (fcSource || kwRows()).filter((r) => r.term.trim() && r.translation.trim());
  if (!fcSource && fc.pair) { // the document's terms: their learning state is kept in the vocabulary
    const known = new Map(vocabRows(fc.pair).map((r) => [r.term, r.known || 0]));
    rows = rows.map((r) => ({ ...r, known: known.get(r.term) || 0 }));
  }
  fc.all = rows;
  let scope = "due";
  try {
    scope = localStorage.getItem(LS_FC_SCOPE) || "due";
    fc.reverse = localStorage.getItem(LS_FC_REVERSE) === "1";
    fc.example = localStorage.getItem(LS_FC_EXAMPLE) || "cloze";
    fc.newCap = Math.max(0, Number(localStorage.getItem(LS_FC_NEWCAP) ?? 20));
  } catch (_) { /* fine */ }
  fcSetScope(scope, false);
}
/** The example sentence on the front: as it is, with the word as a gap, or not at all. */
function fcFrontSentence(sentence, word) {
  if (!sentence || fc.example === "hide") return "";
  if (fc.example === "show") return sentence;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const core = word.replace(/^(der|die|das|the|a|an|le|la|les|un|une|el|los|las|il|lo|gli|o|os|as)\s+/i, "").trim();
  let out = sentence.replace(new RegExp(`(?<![\\p{L}\\p{M}])${esc(core)}(?![\\p{L}\\p{M}])`, "giu"), "_____");
  if (out === sentence && core.length >= 5) { // an inflected form: the stem with any ending
    const stem = core.slice(0, Math.max(4, core.length - 2));
    out = sentence.replace(new RegExp(`(?<![\\p{L}\\p{M}])${esc(stem)}[\\p{L}\\p{M}]*`, "giu"), "_____");
  }
  return out;
}
const fcIntervalLabel = (n) => (n <= 0 ? t("kw.intervalNow") : t("kw.days", { n: FC_STEPS[Math.min(n, FC_STEPS.length) - 1] }));
/** Due today / new words / the whole set, and the direction of the cards, above the card. */
function fcScopeHtml() {
  // where the cards come from: this document or the vocabulary
  const nDoc = fcDocRows().length, nVocab = fcVocabRows().length;
  const src = (key, n, label) => `<button type="button" class="${fcSrc === key ? "active" : ""}" data-fc="src-${key}"${n ? "" : " disabled"}>${label}</button>`;
  const srcHtml = state.doc || nVocab ? `<div class="kw-src"><div class="seg-toggle" role="group" title="${escapeHtml(t("kw.srcTitle"))}">
    ${src("doc", nDoc, escapeHtml(t("kw.srcDoc", { n: nDoc })))}${src("vocab", nVocab, escapeHtml(t("kw.srcVocab", { pair: vb.pair && vb.pair !== FAV_ALL ? pairLabel(vb.pair) : t("vocab.favAll"), n: nVocab })))}</div></div>` : "";
  if (!fc.all.length) return srcHtml ? `<div class="kw-scope">${srcHtml}</div>` : "";
  const fresh = fc.all.filter((r) => !rowKnown(r)).length, known = fc.all.length - fresh;
  const due = fc.all.filter((r) => rowKnown(r) && fcDueAt(r) <= Date.now()).length + Math.min(fresh, Math.max(fc.newCap - fcNewToday(), fc.all.filter((r) => !rowKnown(r) && r._seen).length));
  const seg = (key, n, label) => `<button type="button" class="${fc.scope === key ? "active" : ""}" data-fc="scope-${key}"${n ? "" : " disabled"}>${escapeHtml(t(label, { n }))}</button>`;
  return `<div class="kw-scope">
    ${srcHtml}
    <div class="seg-toggle" role="group" title="${escapeHtml(t("kw.scopeTitle"))}">
      ${seg("due", due, "kw.scopeDue")}${seg("new", fresh, "kw.scopeNew")}${seg("all", fc.all.length, fcSource ? "kw.scopeAll" : "kw.scopeAllDoc")}
    </div>
    <button type="button" class="btn ghost kw-reverse${fc.reverse ? " on" : ""}" data-fc="reverse" aria-pressed="${fc.reverse ? "true" : "false"}" title="${escapeHtml(t("kw.reverseTitle"))}">⇄ ${escapeHtml(t("kw.reverse"))}</button>
    <label class="kw-opt-inline" title="${escapeHtml(t("kw.exampleFrontTitle"))}"><span>${escapeHtml(t("kw.exampleFront"))}</span>
      <select data-fc-select="example">${["cloze", "show", "hide"].map((v) => `<option value="${v}"${fc.example === v ? " selected" : ""}>${escapeHtml(t(`kw.example_${v}`))}</option>`).join("")}</select></label>
    <label class="kw-opt-inline" title="${escapeHtml(t("kw.newPerDayTitle"))}"><span>${escapeHtml(t("kw.newPerDay"))}</span>
      <input type="number" min="0" max="500" value="${fc.newCap}" data-fc-input="newcap"></label>
    ${known ? `<button type="button" class="btn ghost kw-scope-reset" data-fc="reset" title="${escapeHtml(t("kw.resetTitle"))}">${escapeHtml(t("kw.reset", { n: known }))}</button>` : ""}
  </div>`;
}
/** "Nothing is due today": when the next word comes up. */
function fcNextDueText() {
  const next = Math.min(...fc.all.filter(rowKnown).map(fcDueAt));
  if (!isFinite(next)) return t("kw.noNew");
  const days = Math.max(1, Math.ceil((next - Date.now()) / DAY));
  return t("kw.noDue", { when: days === 1 ? t("kw.tomorrow") : t("kw.inDays", { n: days }) });
}
function fcShuffle() { for (let i = fc.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fc.queue[i], fc.queue[j]] = [fc.queue[j], fc.queue[i]]; } fc.index = 0; fc.flipped = false; fcRender(); }
function fcRender() {
  const box = $("#kwCards");
  const scope = fcScopeHtml();
  if (!fc.total) { box.innerHTML = `${scope}<p class="muted small">${escapeHtml(!fc.all.length ? t("kw.noCards") : fc.scope === "due" ? fcNextDueText() : t("kw.noNew"))}</p>`; return; }
  if (!fc.queue.length) {
    box.innerHTML = `${scope}<div class="kw-done"><div class="kw-done-text">${escapeHtml(t("kw.allDone"))}</div><button type="button" class="btn primary" data-fc="restart">${escapeHtml(t("kw.restart"))}</button></div>`;
    box.querySelector(".kw-done [data-fc]").focus({ preventScroll: true });
    return;
  }
  const r = fc.rows[fc.queue[fc.index]];
  const pair = r._pair || fc.pair, fav = pair ? isFav(pair, r.term) : false;
  const sides = [{ word: r.term, sentence: r.example }, { word: r.translation, sentence: r.exampleTr }];
  const [front, back] = fc.reverse ? sides.reverse() : sides; // reversed: asked from the translation
  const frontFull = front.sentence;
  front.sentence = fcFrontSentence(front.sentence, front.word);
  // The back keeps its own sentence whole and, when the front's was hidden or gapped, shows that one too.
  const backSentences = [fc.example !== "show" && frontFull !== front.sentence ? frontFull : "", back.sentence].filter(Boolean);
  const n = Number(r.known) || 0;
  const grade = (g, cls, label, next) => `<button type="button" class="btn${cls}" data-fc="${g}" title="${escapeHtml(t(`kw.${g}Title`))}"><span>${label}</span><small>${escapeHtml(fcIntervalLabel(next))}</small></button>`;
  const waiting = fcWaiting();
  const favBtn = `<button type="button" class="kw-fav${fav ? " on" : ""}" data-fc="fav" title="${escapeHtml(t("vocab.favTitle"))}" aria-label="${escapeHtml(t("vocab.fav"))}" aria-pressed="${fav ? "true" : "false"}"${pair ? "" : " disabled"}>${KAM_ICON}</button>`;
  box.innerHTML = `${scope}
    <div class="kw-progress"><span>${escapeHtml(t("kw.progress", { i: fc.index + 1, n: fc.queue.length }))}${rowKnown(r) ? "" : ` <span class="kw-new-badge">${escapeHtml(t("kw.newBadge"))}</span>`}</span><span class="muted">${escapeHtml(t("kw.knownCount", { n: fc.known, total: fc.total }))}${waiting ? ` · ${escapeHtml(t("kw.waiting", { n: waiting }))}` : ""}</span></div>
    <div class="kw-card${fc.flipped ? " flipped" : ""}" tabindex="0" role="button" aria-label="${escapeHtml(t("kw.flip"))}" data-fc="flip">
      <div class="kw-card-inner">
        <div class="kw-face kw-front">${favBtn}<div class="kw-word">${escapeHtml(front.word)}</div>${front.sentence ? `<div class="kw-sentence">${escapeHtml(front.sentence)}</div>` : ""}</div>
        <div class="kw-face kw-back">${favBtn}<div class="kw-word">${escapeHtml(back.word)}</div>${backSentences.map((x, i) => `<div class="kw-sentence${i === 0 && backSentences.length > 1 ? " kw-sentence-src" : ""}">${escapeHtml(x)}</div>`).join("")}</div>
      </div>
    </div>
    <div class="kw-fc-actions">
      <div class="kw-fc-nav">
        <button type="button" class="btn kw-fc-arrow" data-fc="prev" title="${escapeHtml(t("kw.prev"))}" aria-label="${escapeHtml(t("kw.prev"))}">‹</button>
        <button type="button" class="btn kw-fc-flip" data-fc="flip">${escapeHtml(t("kw.flipBtn"))}</button>
        <button type="button" class="btn kw-fc-arrow" data-fc="next" title="${escapeHtml(t("kw.next"))}" aria-label="${escapeHtml(t("kw.next"))}">›</button>
      </div>
      <div class="kw-fc-judge">
        ${grade("again", "", `↻ ${escapeHtml(t("kw.again"))}`, 0)}
        ${grade("hard", "", escapeHtml(t("kw.hard")), Math.max(1, n))}
        ${grade("known", " primary", `✓ ${escapeHtml(t("kw.known"))}`, n + 1)}
        ${grade("easy", "", escapeHtml(t("kw.easy")), n + 2)}
        <button type="button" class="btn ghost" data-fc="shuffle">${escapeHtml(t("kw.shuffle"))}</button>
      </div>
    </div>`;
  // the keyboard keeps working after a card was redrawn
  (box.querySelector(".kw-card") || box.querySelector("[data-fc]"))?.focus({ preventScroll: true });
}
/**
 * The four grades. Again: back to the start, the card comes up again at the end of this round.
 * Hard: the step stays (a new word gets its first day). Known: one step up. Easy: two steps up.
 * A new word graded for the first time counts against the day's cap.
 */
const LS_FC_DAYS = "pdftr:fcdays";
/** The days on which cards were graded (for the streak in the vocabulary's statistics). */
function fcNoteDay() {
  const day = new Date().toISOString().slice(0, 10);
  let days = [];
  try { days = JSON.parse(localStorage.getItem(LS_FC_DAYS) || "[]"); } catch (_) { /* fine */ }
  if (!Array.isArray(days)) days = [];
  if (days[days.length - 1] === day) return;
  days.push(day);
  try { localStorage.setItem(LS_FC_DAYS, JSON.stringify(days.slice(-400))); } catch (_) { /* fine */ }
}
function fcStreak() {
  let days = [];
  try { days = JSON.parse(localStorage.getItem(LS_FC_DAYS) || "[]"); } catch (_) { /* fine */ }
  const set = new Set(days);
  const d = new Date();
  const key = () => d.toISOString().slice(0, 10);
  if (!set.has(key())) d.setDate(d.getDate() - 1); // today not yet: the streak counts up to yesterday
  let n = 0;
  while (set.has(key())) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function fcGrade(grade) {
  const r = fc.rows[fc.queue[fc.index]], pair = r._pair || fc.pair;
  fcNoteDay();
  if (!rowKnown(r) && !r._seen) { r._seen = true; fcNewToday(1); }
  const was = Number(r.known) || 0;
  const n = grade === "again" ? 0 : grade === "hard" ? Math.max(1, was) : grade === "known" ? was + 1 : was + 2;
  if (pair) vocabMarkKnown(pair, r.term, n); // (remembered, with the time)
  r.known = n; r.last = Date.now();
  if (grade === "again") { const [i] = fc.queue.splice(fc.index, 1); fc.queue.push(i); }
  else { fc.queue.splice(fc.index, 1); fc.known++; }
  if (fc.index >= fc.queue.length) fc.index = 0;
  fc.flipped = false;
  fcRender();
}
function fcAction(act) {
  if (act === "src-doc" || act === "src-vocab") { fcSrc = act.slice(4); fcStart(); return; } // (where the cards come from)
  if (act.startsWith("scope-")) { fcSetScope(act.slice(6)); return; }
  if (act === "reverse") {
    fc.reverse = !fc.reverse;
    try { localStorage.setItem(LS_FC_REVERSE, fc.reverse ? "1" : "0"); } catch (_) { /* fine */ }
    fc.flipped = false; fcRender();
    return;
  }
  if (act === "reset") { // the learning state of these words is forgotten: all of them are new again
    const known = fc.all.filter(rowKnown);
    if (!known.length || !confirm(t("kw.resetConfirm", { n: known.length }))) return;
    for (const r of known) { if (r._pair || fc.pair) vocabMarkKnown(r._pair || fc.pair, r.term, 0); r.known = 0; }
    fcSetScope(fc.scope);
    return;
  }
  if (!fc.queue.length && act !== "restart") return;
  if (act === "flip") { fc.flipped = !fc.flipped; $("#kwCards .kw-card")?.classList.toggle("flipped", fc.flipped); return; }
  if (act === "fav") { // the chameleon: this card into the favourites (and out again)
    const r = fc.rows[fc.queue[fc.index]], pair = r._pair || fc.pair;
    if (!pair) { toast(t("vocab.noPair"), "error"); return; }
    const on = toggleFav(pair, r);
    document.querySelectorAll("#kwCards .kw-fav").forEach((b) => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    toast(t(on ? "vocab.favAdded" : "vocab.favRemoved", { term: r.term, pair: pairLabel(pair) }), on ? "ok" : "");
    return;
  }
  if (act === "next") fc.index = (fc.index + 1) % fc.queue.length;
  else if (act === "prev") fc.index = (fc.index - 1 + fc.queue.length) % fc.queue.length;
  else if (act === "again" || act === "hard" || act === "known" || act === "easy") { fcGrade(act); return; }
  else if (act === "shuffle") { fcShuffle(); return; }
  else if (act === "restart") { fcStart(); return; }
  fc.flipped = false;
  fcRender();
}
function kwSetMode(mode) {
  if (!state.doc && mode !== "vocab" && mode !== "cards") mode = "vocab"; // without a document: the vocabulary, and cards made from it
  const cards = mode === "cards", vocab = mode === "vocab", words = mode === "words";
  $("#kwDialog").dataset.mode = mode;
  $("#kwModeList").classList.toggle("active", mode === "list");
  $("#kwModeWords").classList.toggle("active", words);
  $("#kwModeCards").classList.toggle("active", cards);
  $("#kwModeVocab").classList.toggle("active", vocab);
  $("#kwModeList").disabled = $("#kwModeWords").disabled = !state.doc;
  if (words) wordsRender();
  $("#kwModeCards").disabled = !state.doc && !vocabPairs().length;
  if (!cards) fcSource = null;
  if (cards) { fcStart(); $("#kwCards .kw-card")?.focus(); }
  if (vocab) { vocabRender(); }
}
function initFlashcards() {
  $("#kwModeList").addEventListener("click", () => kwSetMode("list"));
  // (from the Vocabulary tab, or without a document: cards from the vocabulary as shown there)
  $("#kwModeCards").addEventListener("click", () => { fcSrc = $("#kwDialog").dataset.mode === "vocab" || !state.doc ? "vocab" : "doc"; kwSetMode("cards"); });
  $("#kwModeWords").addEventListener("click", () => kwSetMode("words"));
  $("#kwCards").addEventListener("click", (e) => { const b = e.target.closest("[data-fc]"); if (b) fcAction(b.dataset.fc); });
  $("#kwCards").addEventListener("change", (e) => {
    if (e.target.dataset.fcSelect === "example") {
      fc.example = e.target.value;
      try { localStorage.setItem(LS_FC_EXAMPLE, fc.example); } catch (_) { /* fine */ }
      fc.flipped = false; fcRender();
    } else if (e.target.dataset.fcInput === "newcap") {
      fc.newCap = Math.max(0, Math.min(500, Number(e.target.value) || 0));
      try { localStorage.setItem(LS_FC_NEWCAP, String(fc.newCap)); } catch (_) { /* fine */ }
      fcSetScope(fc.scope);
    }
  });
  document.addEventListener("keydown", (e) => {
    const dlg = $("#kwDialog");
    if (!dlg.open || dlg.dataset.mode !== "cards" || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    const keys = { " ": "flip", Enter: "flip", ArrowRight: "next", ArrowLeft: "prev", k: "known", K: "known", a: "again", A: "again", h: "hard", H: "hard", e: "easy", E: "easy", f: "fav", F: "fav", r: "reverse", R: "reverse", 1: "again", 2: "hard", 3: "known", 4: "easy" };
    if (keys[e.key]) { e.preventDefault(); fcAction(keys[e.key]); }
  });
  $("#kwDialog").addEventListener("close", () => { fcSource = null; $("#kwDialog").dataset.mode = "list"; });
}
