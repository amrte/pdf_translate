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
    const mm = /^(.+?)\s*(?:=|—|–|->|→|\||\t)\s*(.+)$/.exec(line) || /^(.+?):\s+(.+)$/.exec(line);
    if (mm) rows.push({ term: mm[1].trim(), translation: mm[2].trim() });
  }
  if (rows.length) { kwMerge(rows); toast(t("kw.imported", { n: rows.length }), "ok"); }
  return text.slice(0, m.index) + (end < 0 ? "" : after.slice(end));
}
function kwMerge(rows) {
  const have = new Map((state.keywords || []).map((r) => [r.term.trim().toLowerCase(), r]));
  for (const r of rows) {
    const k = r.term.trim().toLowerCase();
    if (!k) continue;
    if (have.has(k)) have.get(k).translation = r.translation; else { state.keywords.push({ term: r.term, translation: r.translation }); have.set(k, r); }
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
      <input data-k="term" value="${escapeHtml(r.term)}" data-i18n-placeholder="kw.term" placeholder="${escapeHtml(t("kw.term"))}">
      <input data-k="translation" value="${escapeHtml(r.translation)}" placeholder="${escapeHtml(t("kw.translation"))}">
      <button type="button" class="mini" data-act="del" title="${escapeHtml(t("kw.remove"))}" aria-label="${escapeHtml(t("kw.remove"))}">✕</button>
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
    state.keywords.push({ term: "", translation: "" });
    kwSave(); kwRenderList();
    const inputs = list.querySelectorAll('[data-k="term"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $("#kwCopy").addEventListener("click", () => copyText(kwRows().map((r) => `${r.term} = ${r.translation}`).join("\n"), t("kw.copied")));
  $("#kwDownload").addEventListener("click", async () => {
    try { saveBlob(new Blob([await kwPdfBytes()], { type: "application/pdf" }), `${stem()}.keywords.pdf`); } catch (err) { toast(userError(err), "error"); }
  });
}
