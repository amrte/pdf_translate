/* ------------------------------------------------------------- keywords (glossary) */
// The AI can be asked for the most important terms of the text with their translations. They
// arrive in the answer after a line "[[keywords]]", are kept per document, can be edited, and
// become a PDF page of their own (shown in the dialog, downloadable).

const KW_MARK = /^[ \t]*\[\[\s*keywords?\s*\]\][ \t]*$/im;
const kwKey = (id) => `pdftr:kw:${id}`;
let kwPreviewTimer = null;
/** Draws every page of a PDF into a container (stacked); earlier pictures are released. */
async function kwRenderPages(container, bytes, zoom = 2) {
  const n = await pool.workers[0].call("pdfPageCount", { bytes });
  const imgs = [];
  for (let p = 0; p < n; p++) {
    const png = await pool.workers[0].call("renderBytes", { bytes, page: p, zoom });
    imgs.push(URL.createObjectURL(new Blob([png], { type: "image/png" })));
  }
  container.querySelectorAll("img").forEach((im) => { if (im.src.startsWith("blob:")) URL.revokeObjectURL(im.src); });
  container.innerHTML = imgs.map((u, i) => `<img src="${u}" alt="${escapeHtml(t("page.n", { n: i + 1 }))}">`).join("");
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
  if (rows.length) {
    kwMerge(rows);
    if (pair) setCurrentPair(pair);
    const p = pair || currentPair();
    const added = p ? vocabAdd(p, rows, state.doc.name) : 0;
    toast(p ? t("kw.importedVocab", { n: rows.length, added, pair: pairLabel(p) }) : t("kw.imported", { n: rows.length }), "ok");
  }
  return text.slice(0, m.index) + (end < 0 ? "" : after.slice(end));
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
const fc = { queue: [], index: 0, flipped: false, known: 0, total: 0, all: [], scope: "new" };
const LS_FC_SCOPE = "pdftr:fcscope";
/** The vocabulary remembers which words were marked known (how often, and when). */
const rowKnown = (r) => Number(r.known) > 0;
function fcScopeRows() { return fc.scope === "new" ? fc.all.filter((r) => !rowKnown(r)) : fc.all; }
function fcSetScope(scope, remember = true) {
  fc.scope = scope;
  if (remember) try { localStorage.setItem(LS_FC_SCOPE, scope); } catch (_) { /* fine */ }
  const rows = fcScopeRows();
  fc.queue = rows.map((_, i) => i); fc.rows = rows; fc.index = 0; fc.flipped = false; fc.known = 0; fc.total = rows.length;
  fcRender();
}

let fcSource = null, fcPair = ""; // rows other than the document's (the vocabulary) and their pair, while set
function fcStart() {
  fc.pair = fcSource ? fcPair : currentPair();
  let rows = (fcSource || kwRows()).filter((r) => r.term.trim() && r.translation.trim());
  if (!fcSource && fc.pair) { // the document's terms: their learning state is kept in the vocabulary
    const known = new Map(vocabRows(fc.pair).map((r) => [r.term, r.known || 0]));
    rows = rows.map((r) => ({ ...r, known: known.get(r.term) || 0 }));
  }
  fc.all = rows;
  let scope = "new";
  try { scope = localStorage.getItem(LS_FC_SCOPE) || "new"; } catch (_) { /* fine */ }
  if (scope === "new" && rows.length && !rows.some((r) => !rowKnown(r))) scope = "all"; // nothing new left: the whole set
  fcSetScope(scope, false);
}
/** New words / the whole set, above the card; the number of words in each. */
function fcScopeHtml() {
  const fresh = fc.all.filter((r) => !rowKnown(r)).length, known = fc.all.length - fresh;
  if (!fc.all.length) return "";
  return `<div class="kw-scope">
    <div class="seg-toggle" role="group" title="${escapeHtml(t("kw.scopeTitle"))}">
      <button type="button" class="${fc.scope === "new" ? "active" : ""}" data-fc="scope-new"${fresh ? "" : " disabled"}>${escapeHtml(t("kw.scopeNew", { n: fresh }))}</button>
      <button type="button" class="${fc.scope === "all" ? "active" : ""}" data-fc="scope-all">${escapeHtml(t(fcSource ? "kw.scopeAll" : "kw.scopeAllDoc", { n: fc.all.length }))}</button>
    </div>
    ${known ? `<button type="button" class="btn ghost kw-scope-reset" data-fc="reset" title="${escapeHtml(t("kw.resetTitle"))}">${escapeHtml(t("kw.reset", { n: known }))}</button>` : ""}
  </div>`;
}
function fcShuffle() { for (let i = fc.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fc.queue[i], fc.queue[j]] = [fc.queue[j], fc.queue[i]]; } fc.index = 0; fc.flipped = false; fcRender(); }
function fcRender() {
  const box = $("#kwCards");
  const scope = fcScopeHtml();
  if (!fc.total) { box.innerHTML = `${scope}<p class="muted small">${escapeHtml(t(fc.all.length ? "kw.noNew" : "kw.noCards"))}</p>`; return; }
  if (!fc.queue.length) {
    box.innerHTML = `${scope}<div class="kw-done"><div class="kw-done-text">${escapeHtml(t("kw.allDone"))}</div><button type="button" class="btn primary" data-fc="restart">${escapeHtml(t("kw.restart"))}</button></div>`;
    box.querySelector(".kw-done [data-fc]").focus({ preventScroll: true });
    return;
  }
  const r = fc.rows[fc.queue[fc.index]];
  const pair = r._pair || fc.pair, fav = pair ? isFav(pair, r.term) : false;
  const favBtn = `<button type="button" class="kw-fav${fav ? " on" : ""}" data-fc="fav" title="${escapeHtml(t("vocab.favTitle"))}" aria-label="${escapeHtml(t("vocab.fav"))}" aria-pressed="${fav ? "true" : "false"}"${pair ? "" : " disabled"}>${KAM_ICON}</button>`;
  box.innerHTML = `${scope}
    <div class="kw-progress"><span>${escapeHtml(t("kw.progress", { i: fc.index + 1, n: fc.queue.length }))}</span><span class="muted">${escapeHtml(t("kw.knownCount", { n: fc.known, total: fc.total }))}</span></div>
    <div class="kw-card${fc.flipped ? " flipped" : ""}" tabindex="0" role="button" aria-label="${escapeHtml(t("kw.flip"))}" data-fc="flip">
      <div class="kw-card-inner">
        <div class="kw-face kw-front">${favBtn}<div class="kw-word">${escapeHtml(r.term)}</div>${r.example ? `<div class="kw-sentence">${escapeHtml(r.example)}</div>` : ""}</div>
        <div class="kw-face kw-back">${favBtn}<div class="kw-word">${escapeHtml(r.translation)}</div>${r.exampleTr ? `<div class="kw-sentence">${escapeHtml(r.exampleTr)}</div>` : ""}</div>
      </div>
    </div>
    <div class="kw-fc-actions">
      <div class="kw-fc-nav">
        <button type="button" class="btn kw-fc-arrow" data-fc="prev" title="${escapeHtml(t("kw.prev"))}" aria-label="${escapeHtml(t("kw.prev"))}">‹</button>
        <button type="button" class="btn kw-fc-flip" data-fc="flip">${escapeHtml(t("kw.flipBtn"))}</button>
        <button type="button" class="btn kw-fc-arrow" data-fc="next" title="${escapeHtml(t("kw.next"))}" aria-label="${escapeHtml(t("kw.next"))}">›</button>
      </div>
      <div class="kw-fc-judge">
        <button type="button" class="btn" data-fc="again">↻ ${escapeHtml(t("kw.again"))}</button>
        <button type="button" class="btn primary" data-fc="known">✓ ${escapeHtml(t("kw.known"))}</button>
        <button type="button" class="btn ghost" data-fc="shuffle">${escapeHtml(t("kw.shuffle"))}</button>
      </div>
    </div>`;
  // the keyboard keeps working after a card was redrawn
  (box.querySelector(".kw-card") || box.querySelector("[data-fc]"))?.focus({ preventScroll: true });
}
function fcAction(act) {
  if (act === "scope-new" || act === "scope-all") { fcSetScope(act.slice(6)); return; }
  if (act === "reset") { // the learning state of these words is forgotten: all of them are new again
    const known = fc.all.filter(rowKnown);
    if (!known.length || !confirm(t("kw.resetConfirm", { n: known.length }))) return;
    for (const r of known) { if (r._pair || fc.pair) vocabMarkKnown(r._pair || fc.pair, r.term, 0); r.known = 0; }
    fcSetScope("new");
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
  else if (act === "known") {
    const r = fc.rows[fc.queue[fc.index]], pair = r._pair || fc.pair;
    if (pair) r.known = vocabMarkKnown(pair, r.term); // (remembered: the word is not "new" any more)
    fc.queue.splice(fc.index, 1); fc.known++; if (fc.index >= fc.queue.length) fc.index = 0;
  }
  else if (act === "again") { const [i] = fc.queue.splice(fc.index, 1); fc.queue.push(i); if (fc.index >= fc.queue.length) fc.index = 0; }
  else if (act === "shuffle") { fcShuffle(); return; }
  else if (act === "restart") { fcStart(); return; }
  fc.flipped = false;
  fcRender();
}
function kwSetMode(mode) {
  if (!state.doc && mode !== "vocab" && !(mode === "cards" && fcSource)) mode = "vocab"; // without a document: the vocabulary, and cards made from it
  const cards = mode === "cards", vocab = mode === "vocab";
  $("#kwDialog").dataset.mode = mode;
  $("#kwModeList").classList.toggle("active", mode === "list");
  $("#kwModeCards").classList.toggle("active", cards);
  $("#kwModeVocab").classList.toggle("active", vocab);
  $("#kwModeList").disabled = !state.doc;
  $("#kwModeCards").disabled = !state.doc && !fcSource;
  if (!cards) fcSource = null;
  if (cards) { fcStart(); $("#kwCards .kw-card")?.focus(); }
  if (vocab) { vocabRender(); }
}
function initFlashcards() {
  $("#kwModeList").addEventListener("click", () => kwSetMode("list"));
  $("#kwModeCards").addEventListener("click", () => kwSetMode("cards"));
  $("#kwCards").addEventListener("click", (e) => { const b = e.target.closest("[data-fc]"); if (b) fcAction(b.dataset.fc); });
  document.addEventListener("keydown", (e) => {
    const dlg = $("#kwDialog");
    if (!dlg.open || dlg.dataset.mode !== "cards" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const keys = { " ": "flip", Enter: "flip", ArrowRight: "next", ArrowLeft: "prev", k: "known", K: "known", a: "again", A: "again", f: "fav", F: "fav" };
    if (keys[e.key]) { e.preventDefault(); fcAction(keys[e.key]); }
  });
  $("#kwDialog").addEventListener("close", () => { fcSource = null; $("#kwDialog").dataset.mode = "list"; });
}
