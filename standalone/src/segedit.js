/* ------------------------------------------------------------- splitting and joining segments */
// A PDF segment that glues two paragraphs can be split between two of its lines; a paragraph the
// extraction cut in two can be joined with the segment that follows it. The engine builds the new
// segments from the page's lines, the numbering is redone, and the operations are remembered with
// the document and repeated when it opens again. Recognised (OCR) segments are split and joined
// the same way from the lines OCR found (kept with its result); the changed result itself is saved.
// The text of a recognised segment can also be corrected by hand.

const segKey = (id) => `pdftr:seg:${id}`;
const segEditable = (s) => Boolean(state.doc && !isBook() && s && !s.extra && (s.ocr || !state.doc.image));
/** The stored OCR result of a page, when it has its lines (results from before 2.20 have not). */
const ocrRecord = (p) => { const r = state.doc && state.doc.ocr && state.doc.ocr[p]; return r && r.raw ? r : null; };
const sameBox = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.6);

function loadSegEdits(id) {
  try { return JSON.parse(localStorage.getItem(segKey(id)) || "[]"); } catch (_) { return []; }
}
function saveSegEdits() {
  try { localStorage.setItem(segKey(state.doc.id), JSON.stringify(state.segEdits || [])); } catch (_) { /* storage blocked */ }
}

/** The page's lines that lie inside a segment's box (same rotation), in reading order. */
function linesInside(lines, s) {
  const [x0, y0, x1, y1] = s.bbox;
  return lines.filter((l) => {
    if (l.rotation !== s.rotation) return false;
    const cx = (l.bbox[0] + l.bbox[2]) / 2, cy = (l.bbox[1] + l.bbox[3]) / 2;
    return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
  });
}

/** The next segment after `s` on the same page that can be joined with it (recognised with recognised, text with text). */
function nextJoinable(segments, s) {
  const i = segments.indexOf(s);
  for (let k = i + 1; k < segments.length; k++) {
    const n = segments[k];
    if (n.page !== s.page) return null;
    // (numbers and dates, not shown in the list, are passed over: the next card is meant)
    if (Boolean(n.ocr) === Boolean(s.ocr) && (s.skip || !n.skip)) return n;
  }
  return null;
}

/** The lines of the page a segment is made of: the PDF's text lines, or the lines OCR found. */
async function pageLinesOf(page, ocr) {
  if (!ocr) return pool.workers[0].call("pageLines", { page });
  const r = ocrRecord(page);
  return r ? pool.workers[0].call("ocrLines", { page, raw: r.raw, seps: r.seps, family: r.family }) : null;
}

/**
 * Carry out one operation on a segment list: {page, op: "split", box, at} or {page, op: "join",
 * boxes: [a, b]}. Returns the new list (ids redone) and the id map, or null if the sources are gone.
 */
async function applySegEdit(segments, op) {
  const plan = await planSegEdit(segments, op);
  if (!plan) return null;
  const { sources, fresh } = plan;
  const at = segments.indexOf(sources[0]);
  const list = segments.filter((s) => !sources.includes(s));
  list.splice(at, 0, ...fresh);
  const oldId = new Map(segments.map((s) => [s, s.id]));
  const remap = new Map();
  list.forEach((s, i) => { if (oldId.has(s)) remap.set(oldId.get(s), i + 1); s.id = i + 1; });
  return { list, remap, sources, fresh };
}

/** The segments an operation replaces (`sources`) and the ones built in their place (`fresh`). */
async function planSegEdit(segments, op) {
  const onPage = segments.filter((s) => s.page === op.page && Boolean(s.ocr) === Boolean(op.ocr));
  const lines = await pageLinesOf(op.page, op.ocr);
  if (!lines) return null;
  let sources, groups;
  if (op.op === "split") {
    const s = onPage.find((x) => sameBox(x.bbox, op.box));
    if (!s) return null;
    const mine = linesInside(lines, s);
    if (mine.length < 2 || op.at < 1 || op.at >= mine.length) return null;
    sources = [s];
    groups = [mine.slice(0, op.at).map((l) => l.i), mine.slice(op.at).map((l) => l.i)];
  } else {
    const a = onPage.find((x) => sameBox(x.bbox, op.boxes[0])), b = onPage.find((x) => sameBox(x.bbox, op.boxes[1]));
    if (!a || !b) return null;
    const idx = [...linesInside(lines, a), ...linesInside(lines, b)].map((l) => l.i).sort((p, q) => p - q);
    if (!idx.length) return null;
    sources = [a, b];
    groups = [idx];
  }
  const r = op.ocr ? ocrRecord(op.page) : null;
  const fresh = r
    ? await pool.workers[0].call("ocrResegment", { page: op.page, raw: r.raw, seps: r.seps, family: r.family, groups })
    : await pool.workers[0].call("resegment", { page: op.page, groups });
  return fresh.length ? { sources, fresh } : null;
}

/** The remembered operations, repeated on a freshly extracted document (before anything is keyed by id). */
async function replaySegEdits(id, segments) {
  const ops = loadSegEdits(id);
  if (!ops.length) return segments;
  let list = segments;
  const kept = [];
  for (const op of ops) {
    try {
      const r = await applySegEdit(list, op);
      if (r) { list = r.list; kept.push(op); }
    } catch (err) { console.warn("segment edit not repeated", err); }
  }
  if (kept.length !== ops.length) { try { localStorage.setItem(segKey(id), JSON.stringify(kept)); } catch (_) { /* fine */ } }
  return list;
}

/** Carry out an operation on the open document and refresh everything that hangs on the numbering. */
async function runSegEdit(op) {
  if (op.ocr) return runOcrSegEdit(op);
  const doc = state.doc;
  busy(t("seg.working"));
  try {
    const r = await applySegEdit(doc.segments, op);
    if (!r) { toast(t("seg.notFound"), "error"); return false; }
    const move = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) if (r.remap.has(Number(k))) out[r.remap.get(Number(k))] = v;
      return out;
    };
    const joined = op.op === "join" ? r.sources.map((s) => (state.translations[s.id] || "").trim()).filter(Boolean).join(" ") : "";
    state.translations = move(state.translations);
    state.overrides = move(state.overrides);
    state.kinds = move(state.kinds);
    if (joined) state.translations[r.fresh[0].id] = joined; // a join keeps both translations, one after the other
    doc.segments = r.list;
    applyKinds(); saveKinds();
    state.segEdits = [...(state.segEdits || []), op];
    saveSegEdits();
    persist(); saveOverrides();
    disposeOutput();
    pool.workers[0].call("resetOutput").catch(() => {});
    state.shrunk = new Set();
    segIndex.clear();
    for (const s of doc.segments) segIndex.set(s.id, s);
    repSetup(); repSync(); // (header/footer groups of the new numbering)
    resetHistory();
    renderPages();
    vl.reset();
    applyFilter();
    setBuilt(false);
    setVariant("original");
    updateProgress();
    const first = r.fresh[0].id;
    setActive(first, { scrollList: true, scrollViewer: true });
    toast(t(op.op === "split" ? "seg.split" : "seg.joined", { n: r.fresh.length }), "ok", { label: t("seg.undo"), run: undoLastSegEdit });
    return true;
  } catch (err) {
    console.error(err);
    toast(t("seg.failed", { err: userError(err) }), "error");
    return false;
  } finally {
    busy("");
  }
}

/* ---- recognised segments: split and joined in the stored OCR result */

const segState = (id) => ({ tr: state.translations[id], ov: state.overrides[id], kind: state.kinds[id] });

/** Translations, field settings and kinds put back onto segments (after their numbers changed). */
function restoreSegStates(pairs) {
  for (const [s, v] of pairs) {
    if (!v) continue;
    for (const [key, obj] of [["tr", state.translations], ["ov", state.overrides], ["kind", state.kinds]]) {
      if (v[key] === undefined) delete obj[s.id]; else obj[s.id] = v[key];
    }
  }
  applyKinds(); saveKinds();
  persist(); saveOverrides();
  refreshCards();
}

async function runOcrSegEdit(op) {
  const doc = state.doc, rec = ocrRecord(op.page);
  if (!rec) { toast(t("seg.ocrOld"), "error"); return false; }
  busy(t("seg.working"));
  try {
    const plan = await planSegEdit(doc.segments, op);
    if (!plan || state.doc !== doc) { if (state.doc === doc) toast(t("seg.notFound"), "error"); return false; }
    const prev = rec.segs.slice(), saved = new Map(prev.map((s) => [s, segState(s.id)]));
    const at = rec.segs.indexOf(plan.sources[0]);
    // (a join keeps text corrected by hand, and both translations, one after the other)
    const fresh = plan.fresh.map((f) => ({ ...f, page: op.page, ocr: true }));
    if (op.op === "join" && plan.sources.some((x) => x.edited)) Object.assign(fresh[0], { text: plan.sources.map((x) => x.text.trim()).join(" "), edited: true });
    const joined = op.op === "join" ? plan.sources.map((x) => (state.translations[x.id] || "").trim()).filter(Boolean).join(" ") : "";
    const segs = rec.segs.filter((x) => !plan.sources.includes(x));
    segs.splice(at, 0, ...fresh);
    addOcrResults({ [op.page]: { segs, seps: rec.seps, raw: rec.raw, family: rec.family } });
    const first = doc.ocr[op.page].segs[at];
    if (joined) restoreSegStates([[first, { tr: joined }]]);
    setActive(first.id, { scrollList: true, scrollViewer: true });
    const undo = () => {
      if (state.doc !== doc) return;
      const r = ocrRecord(op.page);
      addOcrResults({ [op.page]: { segs: prev, seps: r.seps, raw: r.raw, family: r.family } });
      restoreSegStates(doc.ocr[op.page].segs.map((x, i) => [x, saved.get(prev[i])]));
    };
    toast(t(op.op === "split" ? "seg.split" : "seg.joined", { n: fresh.length }), "ok", { label: t("seg.undo"), run: undo });
    return true;
  } catch (err) {
    console.error(err);
    toast(t("seg.failed", { err: userError(err) }), "error");
    return false;
  } finally {
    busy("");
  }
}

/* ---- words OCR was unsure of: marked for checking */

const UNSURE = 70; // (Tesseract's confidence below which a word is marked)
const unsureCache = new WeakMap();

/** The words of a recognised segment OCR was unsure of ([{text, conf, bbox}]); none once corrected. */
function unsureWords(s) {
  if (!s || !s.ocr || s.edited) return [];
  if (unsureCache.has(s)) return unsureCache.get(s);
  const r = ocrRecord(s.page), out = [];
  if (r) {
    const [x0, y0, x1, y1] = s.bbox;
    for (const l of r.raw) for (const w of l.words) {
      if (w.conf == null || w.conf >= UNSURE || !/[\p{L}\p{N}]/u.test(w.text)) continue;
      const cx = (w.bbox[0] + w.bbox[2]) / 2, cy = (w.bbox[1] + w.bbox[3]) / 2;
      if (cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1) out.push(w);
    }
  }
  unsureCache.set(s, out);
  return out;
}

/** A segment's text as HTML, the words OCR was unsure of marked (in reading order). */
function srcHtml(s) {
  const words = unsureWords(s);
  if (!words.length) return escapeHtml(s.text);
  let html = "", pos = 0;
  for (const w of words) {
    const i = s.text.indexOf(w.text, pos);
    if (i < 0) continue; // (a word joined across a line break, say)
    html += `${escapeHtml(s.text.slice(pos, i))}<span class="unsure" title="${escapeHtml(t("ocr.unsureWord", { n: w.conf }))}">${escapeHtml(w.text)}</span>`;
    pos = i + w.text.length;
  }
  return html + escapeHtml(s.text.slice(pos));
}

/* ---- the text of a recognised segment corrected by hand */

let srcFor = null;
async function openSrcDialog(id) {
  const s = segById(id);
  if (!s || !s.ocr) return;
  srcFor = { id, seg: s };
  $("#srcText").value = s.text;
  $("#srcReset").hidden = !s.edited;
  const unsure = unsureWords(s);
  $("#srcUnsure").hidden = !unsure.length;
  $("#srcUnsure").textContent = unsure.length ? t("src.unsure", { words: unsure.map((w) => w.text).join(", ") }) : "";
  const img = $("#srcSnip");
  img.removeAttribute("src");
  img.hidden = true;
  openModal($("#srcDialog"));
  $("#srcText").focus();
  // The place on the page, for comparison: the segment's box with a little room around it.
  try {
    const page = state.doc.pages[s.page], [x0, y0, x1, y1] = s.bbox, pad = Math.max(4, s.size * 0.6);
    const zoom = Math.max(1, Math.min(4, 760 / Math.max(20, x1 - x0 + 2 * pad)));
    const png = await pool.workers[0].call("render", { page: s.page, zoom, variant: "original" });
    if (!srcFor || srcFor.seg !== s) return;
    const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const sx = Math.max(0, (x0 - pad - page.x0) * zoom), sy = Math.max(0, (y0 - pad - page.y0) * zoom);
    const sw = Math.min(bmp.width - sx, (x1 - x0 + 2 * pad) * zoom), sh = Math.min(bmp.height - sy, Math.min(y1 - y0 + 2 * pad, 400) * zoom);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh));
    const cx = c.getContext("2d");
    cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    // the words OCR was unsure of, outlined
    cx.strokeStyle = "rgba(217, 119, 6, 0.95)"; cx.lineWidth = 2; cx.fillStyle = "rgba(245, 158, 11, 0.18)";
    for (const w of unsureWords(s)) {
      const rx = (w.bbox[0] - page.x0) * zoom - sx - 2, ry = (w.bbox[1] - page.y0) * zoom - sy - 2;
      const rw = (w.bbox[2] - w.bbox[0]) * zoom + 4, rh = (w.bbox[3] - w.bbox[1]) * zoom + 4;
      cx.fillRect(rx, ry, rw, rh); cx.strokeRect(rx, ry, rw, rh);
    }
    img.src = c.toDataURL("image/png");
    img.hidden = false;
  } catch (err) { console.warn("snippet", err); }
}

/** A recognised segment gets new text (undoable); it is saved with the OCR result. */
function setSourceText(s, text, edited) {
  const doc = state.doc;
  s.text = text;
  if (edited) s.edited = true; else { delete s.edited; delete s.recognised; }
  s.skip = !/\p{L}/u.test(text) || Boolean(s.formula);
  idbPut(doc.ocr, `ocr:${doc.id}`);
  refreshCards();
}

function saveSrcDialog() {
  if (!srcFor) return;
  const s = srcFor.seg, text = $("#srcText").value.replace(/\s+$/, "");
  if (!text.trim() || text === s.text) return;
  const doc = state.doc, before = { text: s.text, edited: Boolean(s.edited), recognised: s.recognised };
  const recognised = s.edited ? s.recognised : s.text;
  // (back to what OCR read: no longer marked as corrected)
  const after = { text, edited: text !== recognised, recognised };
  const put = (v) => {
    if (state.doc !== doc) return;
    if (v.edited) s.recognised = v.recognised;
    setSourceText(s, v.text, v.edited);
  };
  put(after);
  pushHistory({ label: t("src.hist"), undo: () => put(before), redo: () => put(after) });
}

/** The last operation is taken back: the document is read afresh with the remaining ones. */
async function undoLastSegEdit() {
  if (!state.doc || !(state.segEdits || []).length) return;
  const ops = state.segEdits.slice(0, -1);
  try { localStorage.setItem(segKey(state.doc.id), JSON.stringify(ops)); } catch (_) { /* fine */ }
  const { srcBytes, doc } = state;
  await loadBytes(srcBytes, doc.name, false, doc.id);
}

/* ---- the split dialog: the segment's lines, with a cut between each two */
let splitFor = null;
async function openSplitDialog(id) {
  const s = segById(id);
  if (!segEditable(s)) return;
  if (s.ocr && !ocrRecord(s.page)) { toast(t("seg.ocrOld"), "error"); return; }
  // (a split is made from the recognised lines: text corrected by hand goes back to them)
  if (s.ocr && s.edited && !window.confirm(t("seg.editedSplit"))) return;
  let lines;
  try { lines = linesInside(await pageLinesOf(s.page, s.ocr), s); } catch (err) { toast(userError(err), "error"); return; }
  if (lines.length < 2) { toast(t("seg.oneLine"), "error"); return; }
  splitFor = { id, box: s.bbox.slice(), page: s.page, ocr: Boolean(s.ocr) };
  $("#splitList").innerHTML = lines.map((l, k) => `${k ? `<button type="button" class="split-cut" data-at="${k}" title="${escapeHtml(t("seg.cutTitle"))}"><span>✂ ${escapeHtml(t("seg.cutHere"))}</span></button>` : ""}<div class="split-line">${escapeHtml(l.text)}</div>`).join("");
  openModal($("#splitDialog"));
}

async function joinWithNext(id) {
  const s = segById(id);
  if (!segEditable(s)) return;
  const n = nextJoinable(state.doc.segments, s);
  if (!n) { toast(t("seg.noNext"), "error"); return; }
  await runSegEdit({ page: s.page, op: "join", boxes: [s.bbox.slice(), n.bbox.slice()], ...(s.ocr ? { ocr: true } : {}) });
}

function initSegEdit() {
  const dlg = $("#splitDialog");
  $("#splitList").addEventListener("click", async (e) => {
    const b = e.target.closest(".split-cut");
    if (!b || !splitFor) return;
    const op = { page: splitFor.page, op: "split", box: splitFor.box, at: Number(b.dataset.at), ...(splitFor.ocr ? { ocr: true } : {}) };
    dlg.close("cut");
    await runSegEdit(op);
  });
  dlg.addEventListener("close", () => { splitFor = null; });
  $("#srcSave").addEventListener("click", (e) => { e.preventDefault(); saveSrcDialog(); $("#srcDialog").close(); });
  $("#srcReset").addEventListener("click", () => { if (srcFor && srcFor.seg.recognised !== undefined) $("#srcText").value = srcFor.seg.recognised; });
  $("#srcText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveSrcDialog(); $("#srcDialog").close(); } });
  $("#srcDialog").addEventListener("close", () => { srcFor = null; });
}
