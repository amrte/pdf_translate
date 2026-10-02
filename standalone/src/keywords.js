/* ------------------------------------------------------------- keywords (glossary) */
// The AI can be asked for the most important terms of the text with their translations. They
// arrive in the answer after a line "[[keywords]]", are kept per document, can be edited, and
// become a PDF page of their own (shown in the dialog, downloadable).

const KW_MARK = /^[ \t]*\[\[\s*keywords?\s*\]\][ \t]*$/im;
const kwKey = (id) => `pdftr:kw:${id}`;
let kwPreviewTimer = null, kwPreviewUrl = null;

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
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!line) continue;
    // "term = translation | example sentence | translated example" (the examples are optional)
    const parts = line.split(/\s\|\s/);
    const mm = /^(.+?)\s*(?:=|—|–|->|→|\t)\s*(.+)$/.exec(parts[0]) || /^(.+?):\s+(.+)$/.exec(parts[0]);
    if (mm) rows.push({ term: mm[1].trim(), translation: mm[2].trim(), example: (parts[1] || "").trim(), exampleTr: (parts[2] || "").trim() });
  }
  if (rows.length) { kwMerge(rows); toast(t("kw.imported", { n: rows.length }), "ok"); }
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
  if (!state.doc) return;
  kwRenderList();
  kwSchedulePreview(0);
  openModal($("#kwDialog"));
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
    const img = $("#kwPreview");
    try {
      const bytes = await kwPdfBytes();
      const png = await pool.workers[0].call("renderBytes", { bytes, page: 0, zoom: 1.2 });
      if (kwPreviewUrl) URL.revokeObjectURL(kwPreviewUrl);
      kwPreviewUrl = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      img.src = kwPreviewUrl;
    } catch (err) { console.warn("keyword preview failed", err); }
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
const fc = { queue: [], index: 0, flipped: false, known: 0, total: 0 };

function fcStart() {
  const rows = kwRows().filter((r) => r.term.trim() && r.translation.trim());
  fc.queue = rows.map((_, i) => i); fc.rows = rows; fc.index = 0; fc.flipped = false; fc.known = 0; fc.total = rows.length;
  fcRender();
}
function fcShuffle() { for (let i = fc.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fc.queue[i], fc.queue[j]] = [fc.queue[j], fc.queue[i]]; } fc.index = 0; fc.flipped = false; fcRender(); }
function fcRender() {
  const box = $("#kwCards");
  if (!fc.total) { box.innerHTML = `<p class="muted small">${escapeHtml(t("kw.noCards"))}</p>`; return; }
  if (!fc.queue.length) {
    box.innerHTML = `<div class="kw-done"><div class="kw-done-text">${escapeHtml(t("kw.allDone"))}</div><button type="button" class="btn primary" data-fc="restart">${escapeHtml(t("kw.restart"))}</button></div>`;
    box.querySelector("[data-fc]").focus({ preventScroll: true });
    return;
  }
  const r = fc.rows[fc.queue[fc.index]];
  box.innerHTML = `
    <div class="kw-progress"><span>${escapeHtml(t("kw.progress", { i: fc.index + 1, n: fc.queue.length }))}</span><span class="muted">${escapeHtml(t("kw.knownCount", { n: fc.known, total: fc.total }))}</span></div>
    <div class="kw-card${fc.flipped ? " flipped" : ""}" tabindex="0" role="button" aria-label="${escapeHtml(t("kw.flip"))}" data-fc="flip">
      <div class="kw-card-inner">
        <div class="kw-face kw-front"><div class="kw-word">${escapeHtml(r.term)}</div>${r.example ? `<div class="kw-sentence">${escapeHtml(r.example)}</div>` : ""}<div class="kw-tap muted small">${escapeHtml(t("kw.tapHint"))}</div></div>
        <div class="kw-face kw-back"><div class="kw-word">${escapeHtml(r.translation)}</div>${r.exampleTr ? `<div class="kw-sentence">${escapeHtml(r.exampleTr)}</div>` : ""}</div>
      </div>
    </div>
    <div class="kw-fc-actions">
      <button type="button" class="btn" data-fc="prev" title="${escapeHtml(t("kw.prev"))}">‹</button>
      <button type="button" class="btn" data-fc="flip">${escapeHtml(t("kw.flipBtn"))}</button>
      <button type="button" class="btn" data-fc="next" title="${escapeHtml(t("kw.next"))}">›</button>
      <span class="spacer"></span>
      <button type="button" class="btn" data-fc="again">↻ ${escapeHtml(t("kw.again"))}</button>
      <button type="button" class="btn primary" data-fc="known">✓ ${escapeHtml(t("kw.known"))}</button>
      <button type="button" class="btn ghost" data-fc="shuffle">${escapeHtml(t("kw.shuffle"))}</button>
    </div>`;
  // the keyboard keeps working after a card was redrawn
  (box.querySelector(".kw-card") || box.querySelector("[data-fc]"))?.focus({ preventScroll: true });
}
function fcAction(act) {
  if (!fc.queue.length && act !== "restart") return;
  if (act === "flip") { fc.flipped = !fc.flipped; $("#kwCards .kw-card")?.classList.toggle("flipped", fc.flipped); return; }
  if (act === "next") fc.index = (fc.index + 1) % fc.queue.length;
  else if (act === "prev") fc.index = (fc.index - 1 + fc.queue.length) % fc.queue.length;
  else if (act === "known") { fc.queue.splice(fc.index, 1); fc.known++; if (fc.index >= fc.queue.length) fc.index = 0; }
  else if (act === "again") { const [i] = fc.queue.splice(fc.index, 1); fc.queue.push(i); if (fc.index >= fc.queue.length) fc.index = 0; }
  else if (act === "shuffle") { fcShuffle(); return; }
  else if (act === "restart") { fcStart(); return; }
  fc.flipped = false;
  fcRender();
}
function kwSetMode(mode) {
  const cards = mode === "cards";
  $("#kwDialog").dataset.mode = mode;
  $("#kwModeList").classList.toggle("active", !cards);
  $("#kwModeCards").classList.toggle("active", cards);
  if (cards) { fcStart(); $("#kwCards .kw-card")?.focus(); }
}
function initFlashcards() {
  $("#kwModeList").addEventListener("click", () => kwSetMode("list"));
  $("#kwModeCards").addEventListener("click", () => kwSetMode("cards"));
  $("#kwCards").addEventListener("click", (e) => { const b = e.target.closest("[data-fc]"); if (b) fcAction(b.dataset.fc); });
  document.addEventListener("keydown", (e) => {
    const dlg = $("#kwDialog");
    if (!dlg.open || dlg.dataset.mode !== "cards" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const keys = { " ": "flip", Enter: "flip", ArrowRight: "next", ArrowLeft: "prev", k: "known", K: "known", a: "again", A: "again" };
    if (keys[e.key]) { e.preventDefault(); fcAction(keys[e.key]); }
  });
  $("#kwDialog").addEventListener("close", () => kwSetMode("list"));
}
