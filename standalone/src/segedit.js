/* ------------------------------------------------------------- splitting and joining segments */
// A PDF segment that glues two paragraphs can be split between two of its lines; a paragraph the
// extraction cut in two can be joined with the segment that follows it. The engine builds the new
// segments from the page's lines, the numbering is redone, and the operations are remembered with
// the document and repeated when it opens again.

const segKey = (id) => `pdftr:seg:${id}`;
const segEditable = (s) => Boolean(state.doc && !isBook() && !state.doc.image && s && !s.ocr);
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

/** The next segment after `s` on the same page that can be joined with it. */
function nextJoinable(segments, s) {
  const i = segments.indexOf(s);
  for (let k = i + 1; k < segments.length; k++) {
    const n = segments[k];
    if (n.page !== s.page) return null;
    if (!n.ocr) return n;
  }
  return null;
}

/**
 * Carry out one operation on a segment list: {page, op: "split", box, at} or {page, op: "join",
 * boxes: [a, b]}. Returns the new list (ids redone) and the id map, or null if the sources are gone.
 */
async function applySegEdit(segments, op) {
  const onPage = segments.filter((s) => s.page === op.page && !s.ocr);
  const lines = await pool.workers[0].call("pageLines", { page: op.page });
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
  const fresh = await pool.workers[0].call("resegment", { page: op.page, groups });
  if (!fresh.length) return null;
  const at = segments.indexOf(sources[0]);
  const list = segments.filter((s) => !sources.includes(s));
  list.splice(at, 0, ...fresh);
  const oldId = new Map(segments.map((s) => [s, s.id]));
  const remap = new Map();
  list.forEach((s, i) => { if (oldId.has(s)) remap.set(oldId.get(s), i + 1); s.id = i + 1; });
  return { list, remap, sources, fresh };
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
  let lines;
  try { lines = linesInside(await pool.workers[0].call("pageLines", { page: s.page }), s); } catch (err) { toast(userError(err), "error"); return; }
  if (lines.length < 2) { toast(t("seg.oneLine"), "error"); return; }
  splitFor = { id, box: s.bbox.slice(), page: s.page };
  $("#splitList").innerHTML = lines.map((l, k) => `${k ? `<button type="button" class="split-cut" data-at="${k}" title="${escapeHtml(t("seg.cutTitle"))}"><span>✂ ${escapeHtml(t("seg.cutHere"))}</span></button>` : ""}<div class="split-line">${escapeHtml(l.text)}</div>`).join("");
  openModal($("#splitDialog"));
}

async function joinWithNext(id) {
  const s = segById(id);
  if (!segEditable(s)) return;
  const n = nextJoinable(state.doc.segments, s);
  if (!n) { toast(t("seg.noNext"), "error"); return; }
  await runSegEdit({ page: s.page, op: "join", boxes: [s.bbox.slice(), n.bbox.slice()] });
}

function initSegEdit() {
  const dlg = $("#splitDialog");
  $("#splitList").addEventListener("click", async (e) => {
    const b = e.target.closest(".split-cut");
    if (!b || !splitFor) return;
    const op = { page: splitFor.page, op: "split", box: splitFor.box, at: Number(b.dataset.at) };
    dlg.close("cut");
    await runSegEdit(op);
  });
  dlg.addEventListener("close", () => { splitFor = null; });
}
