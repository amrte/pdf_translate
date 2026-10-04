// ======================================================================
// Field layout and style (move and resize boxes on the page; size, font, colour per field),
// full screen for the whole app, fit page, password-protected PDFs, and OCR for scanned pages.
// ======================================================================

/* ------------------------------------------------------ per-field overrides */

// state.overrides: segment id -> {bbox, size, font, bold, italic, color}, stored per document.
const ovKey = (id) => `pdftr:ov:${id}`;
/** Fields can be moved, resized and restyled in PDFs and in presentations (not in e-books, Word, Excel). */
const fieldsEditable = () => Boolean(state.doc && (!isBook() || state.doc.kind === "pptx"));

function loadOverrides() {
  try { state.overrides = !fieldsEditable() ? {} : JSON.parse(localStorage.getItem(ovKey(state.doc.id)) || "{}"); } catch (_) { state.overrides = {}; }
}

function saveOverrides() {
  try { localStorage.setItem(ovKey(state.doc.id), JSON.stringify(state.overrides)); } catch (_) { /* storage blocked */ }
}

/* ---- the kind of a segment: text (translated) or formula (kept as it is) – the user's choice overrides the detection */
const kindKey = (id) => `pdftr:kind:${id}`;
const kindsEditable = () => Boolean(state.doc && !isBook());

function loadKinds() {
  try { state.kinds = kindsEditable() ? JSON.parse(localStorage.getItem(kindKey(state.doc.id)) || "{}") : {}; } catch (_) { state.kinds = {}; }
  applyKinds();
}
function saveKinds() {
  try { localStorage.setItem(kindKey(state.doc.id), JSON.stringify(state.kinds)); } catch (_) { /* storage blocked */ }
}
/** Sets skip/formula on every segment from the detection, then from the user's choices. */
function applyKinds() {
  for (const s of state.doc.segments) {
    if (s.auto === undefined) s.auto = { skip: Boolean(s.skip), formula: Boolean(s.formula) };
    const k = state.kinds[s.id];
    if (k === "formula") { s.skip = true; s.formula = true; }
    else if (k === "text") { s.skip = false; s.formula = false; }
    else { s.skip = s.auto.skip; s.formula = s.auto.formula; }
  }
}
/** Text → formula, or formula (and numbers) → text; the detection's own result needs no entry. */
function toggleKind(id) {
  const s = segById(id);
  if (!s || !kindsEditable()) return;
  const want = s.skip ? "text" : "formula";
  if ((want === "formula") === s.auto.skip && (want === "formula") === s.auto.formula) delete state.kinds[id]; else state.kinds[id] = want;
  applyKinds();
  saveKinds();
  if (s.skip) { // a formula has no translation
    if (state.translations[id]) { delete state.translations[id]; persist(); }
    if (state.overrides[id]) { delete state.overrides[id]; saveOverrides(); }
  }
  disposeOutput(); // the translated file is built again with the new kinds
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((b) => b.classList.toggle("skip", s.skip));
  refreshCards();
  toast(t(s.skip ? "msg.kindFormula" : "msg.kindText", { n: id }));
}

const ROT_DIR = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] };

/** The box shown for a segment: the user's box when the field was moved or resized. */
const shownBox = (s) => (state.overrides[s.id] && state.overrides[s.id].bbox) || s.bbox;

/** A segment as the rebuild lays it out: with the user's box, size, font, style and colour. */
function effSeg(s) {
  const o = state.overrides && state.overrides[s.id];
  if (!o) return s;
  if (isBook()) return state.doc.kind === "pptx" ? { ...s, ov: { ...o } } : s; // (slides: the engine applies the choices)
  // (styled: an untranslated field is set again in its own style; orig_size: for formulas,
  // which are drawn again from the original, scaled)
  const e = { ...s, styled: true, orig_size: s.size };
  const [ox0, oy0, ox1, oy1] = s.bbox;
  if (o.bbox) {
    const [x0, y0, x1, y1] = o.bbox;
    const dx = x0 - ox0, dy = y0 - oy0;
    const sameSize = Math.abs((x1 - x0) - (ox1 - ox0)) < 0.5 && Math.abs((y1 - y0) - (oy1 - oy0)) < 0.5;
    e.orig_bbox = s.bbox; // the original text there is still removed (and kept, if untranslated)
    e.bbox = o.bbox;
    e.origin = [s.origin[0] + dx, s.origin[1] + dy];
    e.fixed = true; // laid out in exactly this box
    if (s.rows && sameSize) {
      const d = ROT_DIR[s.rotation], n = [-d[1], d[0]];
      const da = dx * d[0] + dy * d[1], db = dx * n[0] + dy * n[1];
      e.rows = s.rows.map(([a, b]) => [a + da, b + db]);
    } else delete e.rows;
  }
  if (o.size && o.size > 0) {
    const k = o.size / s.size;
    e.size = o.size;
    e.exact_size = true; // never made smaller to fit the box
    if (s.line_pitch) e.line_pitch = s.line_pitch * k;
    if (!o.bbox && s.rotation === 0 && k > 1) {
      // Bigger text gets a box that is taller by the same factor (downwards).
      e.bbox = [ox0, oy0, ox1, oy0 + (oy1 - oy0) * k];
      e.origin = [s.origin[0], oy0 + (s.origin[1] - oy0) * k];
      e.orig_bbox = s.bbox;
    }
  }
  if (o.font) e.font_choice = o.font;
  if (o.bold !== undefined) e.bold = o.bold;
  if (o.italic !== undefined) e.italic = o.italic;
  if (o.color) e.color = o.color;
  return e;
}

/** Change a field's overrides (undoable); null values remove a setting. */
function setOverride(id, patch, label, mergeKey) {
  let before = state.overrides[id] ? clone(state.overrides[id]) : null;
  const next = patch === null ? {} : { ...(state.overrides[id] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined || next[k] === "") delete next[k];
  const after = Object.keys(next).length ? next : null;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  applyOverride(id, after);
  // Typing "14" into a field is one step to undo, not two.
  const last = history.undo[history.undo.length - 1];
  const key = mergeKey && `${mergeKey}:${id}`;
  if (key && last && last.mergeKey === key && Date.now() - last.at < 2000) {
    before = last.before;
    history.undo.pop();
  }
  pushHistory({ label: label || t("hist.field"), mergeKey: key, at: Date.now(), before,
    undo: () => applyOverride(id, before), redo: () => applyOverride(id, after) });
}

function applyOverride(id, value) {
  if (value) state.overrides[id] = clone(value); else delete state.overrides[id];
  saveOverrides();
  refreshBox(id);
  refreshStylePanel(id);
  scheduleApply(id);
}

// With a translated PDF open, a changed field is written into it right away.
const applyTimers = new Map();
function scheduleApply(id) {
  if (!state.hasOutput) return; // (also untranslated fields: numbers and formulas keep their text in a new size)
  clearTimeout(applyTimers.get(id));
  applyTimers.set(id, setTimeout(() => { applyTimers.delete(id); applyField(id); }, 250));
}

/** Position of a box element on its page, from a box in page coordinates. */
function placeBox(el, bbox, page) {
  const [x0, y0, x1, y1] = bbox;
  el.style.left = `${((x0 - page.x0) / page.width) * 100}%`;
  el.style.top = `${((y0 - page.y0) / page.height) * 100}%`;
  el.style.width = `${((x1 - x0) / page.width) * 100}%`;
  el.style.height = `${((y1 - y0) / page.height) * 100}%`;
}

function refreshBox(id) {
  const s = segById(id);
  if (!s || !fieldsEditable()) return;
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((el) => {
    const page = viewPages()[Number(el.closest(".page").dataset.page)];
    placeBox(el, shownBox(s), page);
    el.classList.toggle("custom", Boolean(state.overrides[id] && state.overrides[id].bbox));
  });
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `<span class="rh rh-${h}" data-h="${h}"></span>`).join("");

/** Resize handles on the selected box (PDFs only). */
function showHandles(id) {
  document.querySelectorAll(".box .rh").forEach((h) => h.remove());
  if (!fieldsEditable() || id === null || id === undefined) return;
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((el) => el.insertAdjacentHTML("beforeend", HANDLES));
}

/* ----------------------------------------------- moving and resizing boxes */

const boxDrag = { cur: null, justDragged: false };

/** The page point under the pointer (also on a turned page). */
function pagePoint(pageEl, e) {
  const i = Number(pageEl.dataset.page), p = viewPages()[i], body = pageEl.querySelector(".page-body");
  const r = body.getBoundingClientRect();
  let vx = e.clientX - (r.left + r.right) / 2, vy = e.clientY - (r.top + r.bottom) / 2;
  const rot = pageRotation(i); // undo the clockwise turn of the body
  if (rot === 90) [vx, vy] = [vy, -vx]; else if (rot === 180) [vx, vy] = [-vx, -vy]; else if (rot === 270) [vx, vy] = [-vy, vx];
  const W = body.offsetWidth, H = body.offsetHeight;
  return [p.x0 + ((vx + W / 2) / W) * p.width, p.y0 + ((vy + H / 2) / H) * p.height];
}

function onBoxDown(e) {
  if (e.button !== 0 || !state.doc || !fieldsEditable() || mk.tool !== "select" || document.body.classList.contains("reading")) return;
  const box = e.target.closest(".box");
  if (!box) return;
  const pageEl = box.closest(".page"), id = Number(box.dataset.id), s = segById(id);
  if (!s) return;
  boxDrag.cur = { id, box, pageEl, handle: e.target.dataset.h || null, start: pagePoint(pageEl, e), orig: shownBox(s).slice(), moved: false };
  try { box.setPointerCapture(e.pointerId); } catch (_) { /* not a pointer event */ }
  if (boxDrag.cur.handle) { e.preventDefault(); e.stopPropagation(); }
}

function onBoxMove(e) {
  const d = boxDrag.cur;
  if (!d) return;
  const pt = pagePoint(d.pageEl, e);
  const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
  const page = viewPages()[Number(d.pageEl.dataset.page)];
  if (!d.moved) {
    const scale = d.pageEl.querySelector(".page-body").offsetWidth / page.width; // screen px per point
    if (Math.hypot(dx, dy) * scale < 4) return;
    d.moved = true;
    document.body.classList.add("box-dragging");
  }
  e.preventDefault();
  let [x0, y0, x1, y1] = d.orig;
  const h = d.handle, min = 4;
  if (!h) { x0 += dx; x1 += dx; y0 += dy; y1 += dy; } else {
    if (h.includes("w")) x0 = Math.min(x1 - min, x0 + dx);
    if (h.includes("e")) x1 = Math.max(x0 + min, x1 + dx);
    if (h.includes("n")) y0 = Math.min(y1 - min, y0 + dy);
    if (h.includes("s")) y1 = Math.max(y0 + min, y1 + dy);
  }
  d.bbox = [x0, y0, x1, y1].map((v) => Math.round(v * 100) / 100);
  placeBox(d.box, d.bbox, page);
}

function onBoxUp() {
  const d = boxDrag.cur;
  boxDrag.cur = null;
  if (!d || !d.moved) return;
  document.body.classList.remove("box-dragging");
  boxDrag.justDragged = true; // the click that follows must not count as a click on the box
  setTimeout(() => { boxDrag.justDragged = false; }, 300);
  const s = segById(d.id);
  if (!s) return;
  const same = d.bbox.every((v, i) => Math.abs(v - s.bbox[i]) < 0.3);
  setOverride(d.id, { bbox: same ? null : d.bbox }, t(d.handle ? "hist.resize" : "hist.move"));
  if (state.activeId !== d.id) setActive(d.id, { scrollList: true });
}

/* ------------------------------------------------------ style of one field */

const styleOpen = new Set(); // cards whose style panel is open

/** Forget what belongs to the previous document (when a file is opened or closed). */
function resetToolsState() {
  styleOpen.clear();
  for (const timer of applyTimers.values()) clearTimeout(timer);
  applyTimers.clear();
  boxDrag.cur = null;
  document.body.classList.remove("box-dragging");
  cmp.savedZoom = null;
  cmp.expect = { main: null, cmp: null };
}

function stylePanelHtml(s) {
  const o = state.overrides[s.id] || {};
  const bold = o.bold !== undefined ? o.bold : s.bold, italic = o.italic !== undefined ? o.italic : s.italic;
  const fonts = [["", "st.fontOrig"], ["sans-serif", "st.sans"], ["serif", "st.serif"], ["monospace", "st.mono"]];
  if (state.customFont || o.font === "custom") fonts.push(["custom", "st.custom"]);
  // A formula is drawn again from the original, only larger or smaller.
  if (s.formula) {
    return `<div class="seg-style">
    <label title="${escapeHtml(t("st.sizeTitle"))}">${t("st.size")} <input type="number" data-st="size" min="0.5" step="any" value="${o.size || Math.round(s.size * 10) / 10}"></label>
    <button type="button" class="mini" data-st="reset" title="${escapeHtml(t("st.resetTitle"))}">↺</button>
    <span class="muted small st-hint">${escapeHtml(t("st.formulaHint"))}</span>
  </div>`;
  }
  return `<div class="seg-style">
    <label title="${escapeHtml(t("st.sizeTitle"))}">${t("st.size")} <input type="number" data-st="size" min="0.5" step="any" value="${o.size || Math.round(s.size * 10) / 10}"></label>
    <select data-st="font" title="${escapeHtml(t("st.font"))}">${fonts.map(([v, k]) => `<option value="${v}"${(o.font || "") === v ? " selected" : ""}>${escapeHtml(t(k))}</option>`).join("")}</select>
    <button type="button" class="mini toggle${bold ? " on" : ""}" data-st="bold" title="${escapeHtml(t("st.bold"))}"><b>B</b></button>
    <button type="button" class="mini toggle${italic ? " on" : ""}" data-st="italic" title="${escapeHtml(t("st.italic"))}"><i>I</i></button>
    <input type="color" data-st="color" value="${o.color || s.color || "#000000"}" title="${escapeHtml(t("st.color"))}">
    <button type="button" class="mini" data-st="reset" title="${escapeHtml(t("st.resetTitle"))}">↺</button>
    <span class="muted small st-hint">${escapeHtml(t("st.hint"))}</span>
  </div>`;
}

/** Add or update the style panel of a card that is open. */
function refreshStylePanel(id) {
  const card = vl.rendered.get(id);
  if (!card) return;
  card.querySelector('[data-act="style"]')?.classList.toggle("on", Boolean(state.overrides[id]));
  const panel = card.querySelector(".seg-style");
  if (!styleOpen.has(id)) { panel?.remove(); return; }
  const html = stylePanelHtml(segById(id));
  if (!panel) { card.querySelector(".seg-src").insertAdjacentHTML("beforebegin", html); return; }
  // Update the open panel in place: rebuilding it would take the focus out of the size field
  // after the first digit, so "12" could never be typed.
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  for (const fresh of tmp.querySelectorAll("[data-st]")) {
    const el = panel.querySelector(`[data-st="${fresh.dataset.st}"]`);
    if (!el) continue;
    if (el.tagName === "BUTTON") el.className = fresh.className;
    else if (el !== document.activeElement) el.value = fresh.value;
  }
}

function onStyleInput(e) {
  const el = e.target.closest("[data-st]");
  if (!el) return;
  const id = Number(el.closest(".seg").dataset.id), s = segById(id);
  const st = el.dataset.st;
  if (st === "size") {
    const v = Math.min(500, Number(el.value) || 0);
    // The field shows the original size rounded to 0.1 pt; that value means "as in the original".
    setOverride(id, { size: v > 0 && Math.abs(v - Math.round(s.size * 10) / 10) > 0.001 ? v : null }, t("hist.field"), "size");
  } else if (st === "font") setOverride(id, { font: el.value || null }, t("hist.field"));
  else if (st === "color") setOverride(id, { color: el.value.toLowerCase() === s.color ? null : el.value.toLowerCase() }, t("hist.field"), "color");
}

function onStyleClick(e) {
  const el = e.target.closest("[data-st]");
  if (!el || el.tagName !== "BUTTON") return;
  const id = Number(el.closest(".seg").dataset.id), s = segById(id), o = state.overrides[id] || {};
  const st = el.dataset.st;
  if (st === "bold" || st === "italic") {
    const cur = o[st] !== undefined ? o[st] : s[st];
    setOverride(id, { [st]: !cur === Boolean(s[st]) ? null : !cur }, t("hist.field"));
  } else if (st === "reset") setOverride(id, null, t("hist.fieldReset"));
}

/* ------------------------------------------------- full screen and fit page */

function toggleAppFullscreen() {
  if (document.body.classList.contains("viewer-only")) toggleFullscreen(false);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => toast(t("msg.noFullscreen"), "error"));
}

/** Zoom so that the whole current page is visible. */
function fitPage() {
  if (!state.doc) return;
  const box = $("#pages"), i = currentPageIndex(), [w, h] = shownSize(i);
  const zw = (box.clientWidth - PAGE_SIDE) / (w * 1.25), zh = (box.clientHeight - 44) / (h * 1.25);
  setZoom(Math.min(zw, zh));
  requestAnimationFrame(() => goToPage(i));
}

/* ------------------------------------------------------------ turning pages */

const rotKey = (id) => `pdftr:rot:${id}`;

function loadRotations() {
  try { state.rotations = isBook() ? {} : JSON.parse(localStorage.getItem(rotKey(state.doc.id)) || "{}"); } catch (_) { state.rotations = {}; }
}

function setRotation(i, deg) {
  if (deg) state.rotations[i] = deg; else delete state.rotations[i];
  try { localStorage.setItem(rotKey(state.doc.id), JSON.stringify(state.rotations)); } catch (_) { /* storage blocked */ }
  const el = document.querySelector(`.page[data-page="${i}"]`);
  if (el) sizePage(el);
  state.outDirty = true; // the saved copy must be made again
  updateDownloadButton();
  requestAnimationFrame(() => goToPage(i));
}

/** Turn the current page by 90° clockwise (counter-clockwise with Shift). Undoable. */
function rotateCurrentPage(e) {
  if (!state.doc || isBook()) return;
  const i = currentPageIndex(), before = state.rotations[i] || 0;
  const after = (before + (e && e.shiftKey ? 270 : 90)) % 360;
  setRotation(i, after);
  pushHistory({ label: t("hist.rotate"), undo: () => setRotation(i, before), redo: () => setRotation(i, after) });
}

/* ------------------------------------------------------ password dialog */

/** Ask for the password of a protected PDF; null if the user cancels. */
function askPassword(name, wrong) {
  return new Promise((resolve) => {
    const dlg = $("#pwDialog");
    $("#pwName").textContent = name;
    $("#pwWrong").hidden = !wrong;
    $("#pwInput").value = "";
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? $("#pwInput").value : null);
    openModal(dlg);
    $("#pwInput").focus();
  });
}

/* --------------------------------------------------------------------- OCR */

const OCR_LIB = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js";
const OCR_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js";
const OCR_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0";
const OCR_LANG_PATH = ""; // "" = the language data on jsDelivr (@tesseract.js-data/<lang>)
const OCR_LANGS = ["eng", "deu", "fra", "spa", "por", "nld", "swe", "pol", "ces", "slk", "hun", "bul", "ukr", "fin", "ell", "ara", "jpn", "chi_sim", "chi_tra"];
const LS_OCR = "pdftr:ocr-options";
/** The OCR languages in alphabetical order of their names in the interface language. */
const sortedOcrLangs = () => [...OCR_LANGS].sort((a, b) => t("ocrlang." + a).localeCompare(t("ocrlang." + b), LANG));

/** Pages with no text but a picture covering much of the page (scans). */
function scannedPages() {
  const has = new Set(state.doc.segments.map((s) => s.page));
  return state.doc.pages.map((p, i) => i).filter((i) => {
    if (has.has(i)) return false;
    const p = state.doc.pages[i], area = p.width * p.height;
    return ((p.graphics && p.graphics.containers) || []).some((c) => (c[2] - c[0]) * (c[3] - c[1]) > 0.3 * area);
  });
}

/**
 * Segments of the document with the OCR results merged in: on each page, the text segments
 * first, then the recognised ones. `ocr` is {page: {segs, seps}}. Ids are numbered anew.
 */
function mergeOcr(base, ocr, pages) {
  const byPage = new Map();
  const add = (p, s) => { if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(s); };
  for (const s of base) add(s.page, s);
  for (const [p, r] of Object.entries(ocr || {})) {
    for (const s of r.segs) add(Number(p), s);
    const g = pages[p] && pages[p].graphics;
    if (g) { g.baseSeps = g.baseSeps || g.seps; g.seps = g.baseSeps.concat(r.seps || []); }
  }
  const out = [];
  for (const p of [...byPage.keys()].sort((a, b) => a - b)) out.push(...byPage.get(p));
  return out;
}

function openOcrDialog() {
  if (!state.doc || isBook()) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_OCR) || "{}"); } catch (_) { /* default */ }
  const langs = saved.langs || (LANG === "de" ? ["deu", "eng"] : ["eng"]);
  $("#ocrLangs").innerHTML = sortedOcrLangs().map((l) =>
    `<label class="check"><input type="checkbox" value="${l}"${langs.includes(l) ? " checked" : ""}> ${escapeHtml(t("ocrlang." + l))}</label>`).join("");
  const scans = scannedPages().length;
  $("#ocrPagesEmpty").checked = scans > 0;
  $("#ocrPagesAll").checked = scans === 0;
  $("#ocrScanCount").textContent = t("ocr.scanCount", { n: scans });
  $("#ocrRange").value = String(currentPageIndex() + 1);
  $("#ocrFamily").value = saved.family || "serif";
  $("#ocrDeskew").checked = saved.deskew !== false;
  $("#ocrDewarp").checked = saved.dewarp !== false;
  $("#ocrCrop").checked = saved.crop !== false;
  openModal($("#ocrDialog"));
}

/**
 * Page numbers typed as in a print dialog ("1-3, 7"; "5-" runs to the end) to sorted 0-based
 * indexes; null when the text is not a page list or names a page the document does not have.
 */
function parsePageRange(text, count) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?(?:\s*[-–]\s*(\d+)?)?$/.exec(part);
    if (!m || (!m[1] && !m[2])) return null;
    const from = m[1] ? Number(m[1]) : 1, to = part.includes("-") || part.includes("–") ? (m[2] ? Number(m[2]) : count) : from;
    if (from < 1 || to > count || from > to) return null;
    for (let i = from; i <= to; i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** The pages chosen in the OCR dialog, or null when the typed page list is not valid. */
function ocrPageChoice() {
  if ($("#ocrPagesEmpty").checked) return scannedPages();
  if ($("#ocrPagesRange").checked) return parsePageRange($("#ocrRange").value, state.doc.pages.length);
  return state.doc.pages.map((p, i) => i);
}

let ocrCancel = false;

/** Options for a Tesseract worker: from the stored copies (offline use) or from the network. */
function ocrWorkerOptions(stored) {
  return {
    workerPath: stored ? stored.worker : OCR_WORKER, corePath: stored ? stored.core : OCR_CORE, workerBlobURL: !stored,
    ...(OCR_LANG_PATH ? { langPath: OCR_LANG_PATH } : {}),
  };
}

/**
 * Recognition of the pages chosen in the dialog, or (`area`: {page, quad}, four page points) of
 * one area marked on a page: then only that part is read, nothing else is straightened, and the
 * text recognised earlier on the page outside the area stays (with its translations).
 */
async function startOcr({ area = null } = {}) {
  const langs = [...document.querySelectorAll("#ocrLangs input:checked")].map((i) => i.value);
  if (!langs.length) { toast(t("ocr.noLang"), "error"); return; }
  const family = $("#ocrFamily").value, deskew = $("#ocrDeskew").checked, dewarp = $("#ocrDewarp").checked, crop = $("#ocrCrop").checked;
  try { localStorage.setItem(LS_OCR, JSON.stringify({ langs, family, deskew, dewarp, crop })); } catch (_) { /* fine */ }
  const pages = area ? [area.page] : ocrPageChoice() || [];
  if (!pages.length) { toast(t("ocr.none")); return; }
  ocrCancel = false;
  if (!area && (deskew || dewarp || crop)) await ocrStraighten(pages, { deskew, dewarp, crop });
  if (ocrCancel || !state.doc) return;
  const doc = state.doc, results = {};
  let worker = null;
  // Cancel stops the recognition at once (a running step fails, which is fine); the pages that
  // are finished are kept.
  const cancel = () => { ocrCancel = true; if (worker) worker.terminate().catch(() => {}); };
  try {
    busy(t("ocr.loading"), cancel);
    const libs = await offlineLibs(), stored = libs && libs.ocr; // Tesseract saved for offline use, if any
    const T = await import(stored ? stored.lib : OCR_LIB);
    if (ocrCancel) return;
    const createWorker = T.createWorker || (T.default && T.default.createWorker);
    worker = await createWorker(langs.join("+"), 1, ocrWorkerOptions(stored));
    if (ocrCancel) return;
    await worker.setParameters({ tessedit_pageseg_mode: "11" }); // sparse text: table cells and labels too
    for (const [k, p] of pages.entries()) {
      if (ocrCancel || state.doc !== doc) break;
      busy(t("ocr.page", { i: k + 1, n: pages.length }), cancel);
      const page = doc.pages[p];
      const zoom = Math.min(3, 3600 / Math.max(page.width, page.height));
      const buf = await pool.workers[0].call("render", { page: p, zoom, variant: "original" });
      if (ocrCancel) break;
      let blob = new Blob([buf], { type: "image/png" }), whole = null, back = null;
      if (area) {
        // Only the area, pulled straight from its four corners into a rectangle (a slanted block
        // reads like a level one), with a white margin: Tesseract reads text at an edge poorly.
        // What it finds is taken back through the same corners onto the page.
        whole = await imageDataOf(blob);
        const q = area.quad.map(([x, y]) => [(x - page.x0) / page.width, (y - page.y0) / page.height]);
        const res = Engine.warpPixels(whole.data, whole.width, whole.height, 4, { quad: q });
        const m = 24, c = new OffscreenCanvas(res.width + 2 * m, res.height + 2 * m), cx = c.getContext("2d");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
        cx.putImageData(new ImageData(res.data, res.width, res.height), m, m);
        blob = await c.convertToBlob({ type: "image/png" });
        const to = Engine.quadMap(q.map(([x, y]) => [x * whole.width, y * whole.height]));
        back = (x, y) => to((x - m) / res.width, (y - m) / res.height);
      }
      const first = (await worker.recognize(blob, {}, { blocks: true })).data;
      // Rows Tesseract was unsure of are read again as single lines.
      await worker.setParameters({ tessedit_pageseg_mode: "7" });
      const data = await Engine.refineOcr(first, async (rectangle) => (await worker.recognize(blob, { rectangle }, { blocks: true })).data);
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      if (ocrCancel || state.doc !== doc) break;
      if (back) mapOcrData(data, back);
      const img = whole || await imageDataOf(blob);
      const { blocks, seps } = Engine.ocrToBlocks(data, zoom, [page.x0, page.y0], (box) => Engine.sampleColors(img, box));
      let segs = blocks.length ? await pool.workers[0].call("ocrPage", { page: p, lines: blocks, seps, family }) : [];
      // On a page that has a text layer, only text that is not there yet (e.g. in pictures) is added.
      const text = doc.segments.filter((s) => s.page === p && !s.ocr).map((s) => s.bbox);
      segs = segs.filter((s) => !text.some((b) => overlapShare(s.bbox, b) > 0.3));
      // (the recognised lines are kept with the result: segments can be split and joined later)
      const raw = blocks.length ? blocks[0].lines : [];
      if (area) {
        // Text read earlier outside the area stays; inside, the new reading replaces it.
        const before = doc.ocr && doc.ocr[p] ? doc.segments.filter((s) => s.ocr && s.page === p) : [];
        const kept = before.filter((s) => !insidePolygon(area.quad, (s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2));
        const top = Math.min(...area.quad.map((q) => q[1]));
        const at = kept.findIndex((s) => s.bbox[1] >= top);
        segs = at < 0 ? kept.concat(segs) : [...kept.slice(0, at), ...segs, ...kept.slice(at)];
        const prevRaw = (doc.ocr && doc.ocr[p] && doc.ocr[p].raw) || [];
        const keptRaw = prevRaw.filter((l) => {
          const xs = l.words.flatMap((w) => [w.bbox[0], w.bbox[2]]), ys = l.words.flatMap((w) => [w.bbox[1], w.bbox[3]]);
          return !insidePolygon(area.quad, (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
        });
        results[p] = { segs, seps: ((doc.ocr && doc.ocr[p] && doc.ocr[p].seps) || []).concat(seps), raw: keptRaw.concat(raw), family };
        continue;
      }
      results[p] = { segs, seps, raw, family };
    }
  } catch (err) {
    if (!ocrCancel) {
      console.error(err);
      toast(t("ocr.failed", { err: userError(err) }), "error");
      return;
    }
  } finally {
    if (worker) worker.terminate().catch(() => {});
    busy("");
  }
  if (state.doc !== doc) return;
  // Nothing recognised (cancelled early, or empty pages): the document stays as it is.
  const found = Object.values(results).reduce((n, r) => n + r.segs.length, 0);
  const added = found ? addOcrResults(results) : 0;
  toast(ocrCancel ? t("ocr.cancelled", { n: added }) : t("ocr.done", { n: added, p: Object.keys(results).length }), "ok");
}

/**
 * Prepares `pages` before they are recognised: tilted pages are turned straight (`deskew`), the
 * paper is cut out of its background (`crop`) and curved text lines are bent straight (`dewarp`;
 * see deskew.js). A picture is edited and opened again (its original stays restorable), a PDF is
 * put together anew; text recognised earlier on the other pages and the translations are kept.
 */
async function ocrStraighten(pages, { deskew = true, dewarp = false, crop = false } = {}) {
  const doc = state.doc, fixes = new Map();
  const cancel = () => { ocrCancel = true; };
  for (const [k, p] of pages.entries()) {
    if (ocrCancel || state.doc !== doc) return 0;
    busy(t("ocr.preparing", { i: k + 1, n: pages.length }), cancel);
    try {
      let tilt = 0;
      if (deskew) {
        const r = await pool.workers[0].call("skewDetect", { page: p });
        if (r && r.confidence >= 0.15 && Math.abs(r.angle) >= 0.1) tilt = r.angle;
      }
      let quad = null, tracks = null;
      if (dewarp || crop) {
        // the page as a picture of about 1600 pixels, turned straight, in grey
        const page = doc.pages[p], zoom = Math.min(4, 1600 / Math.max(page.width, page.height));
        const buf = await pool.workers[0].call("render", { page: p, zoom, variant: "original" });
        const img = await imageDataOf(new Blob([buf], { type: "image/png" }));
        const turned = Engine.warpPixels(img.data, img.width, img.height, 4, { angle: -tilt });
        const gray = new Uint8Array(turned.width * turned.height);
        for (let i = 0; i < gray.length; i++) gray[i] = (turned.data[i * 4] * 30 + turned.data[i * 4 + 1] * 59 + turned.data[i * 4 + 2] * 11) / 100;
        ({ quad, tracks } = Engine.autoPrepare(gray, turned.width, turned.height, { crop, dewarp }));
      }
      if (tilt || quad || tracks) fixes.set(p, { skew: tilt, quad, tracks });
    } catch (err) { console.warn("prepare", err); }
  }
  busy("");
  if (!fixes.size || ocrCancel || state.doc !== doc) return 0;
  if (doc.image) {
    const f = fixes.get(0);
    Object.assign(picEdit, PIC_DEFAULT, { fine: f.skew ? -Math.round(f.skew * 10) / 10 : 0, quad: f.quad, tracks: f.tracks });
    await picApply(true);
  } else {
    busy(t("ocr.straightening", { n: fixes.size }));
    try {
      const plan = doc.pages.map((_, i) => ({ from: 0, page: i, rot: 0, skew: 0, quad: null, tracks: null, ...(fixes.get(i) || {}) }));
      const kept = {}; // recognised text of the pages that stay as they are
      for (const [p, r] of Object.entries(doc.ocr || {})) if (!fixes.has(Number(p))) kept[p] = { segs: r.segs.map((x) => ({ ...x })), seps: r.seps, ...(r.raw ? { raw: r.raw, family: r.family } : {}) };
      const cap = pmCaptureTranslations();
      const bytes = await pool.workers[0].call("rearrange", { plan });
      await loadBytes(new Uint8Array(bytes), doc.name, true);
      if (!state.doc || state.doc === doc) return 0;
      if (Object.keys(kept).length) addOcrResults(kept);
      pmRestoreTranslations(cap, plan);
    } catch (err) {
      console.error(err);
      toast(t("ocr.straightFailed", { err: userError(err) }), "error");
      return 0;
    } finally {
      busy("");
    }
  }
  if ($("#ocrDialog").open) $("#ocrDialog").close(); // (opened again for the new picture or scan)
  const count = (key) => [...fixes.values()].filter((f) => key === "skew" ? f.skew : f[key]).length;
  toast(t("ocr.prepared", { s: count("skew"), c: count("quad"), l: count("tracks") }), "ok");
  return fixes.size;
}

/** Share of box a that overlaps box b. */
function overlapShare(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1])) : 0;
}

async function imageDataOf(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Add recognised segments to the document. Segments are numbered in page order again, so the
 * translations, field settings and the translated PDF are carried over to the new numbers.
 */
function addOcrResults(results) {
  const doc = state.doc;
  const ocr = { ...(doc.ocr || {}) };
  let added = 0;
  const current = new Set(doc.segments);
  for (const [p, r] of Object.entries(results)) {
    // (segments already in the document – kept beside a newly read area – stay the same objects,
    // so their translations follow)
    ocr[p] = { segs: r.segs.map((s) => (current.has(s) ? s : { ...s, page: Number(p), ocr: true })), seps: r.seps, ...(r.raw ? { raw: r.raw, family: r.family } : {}) };
    added += r.segs.filter((s) => !current.has(s)).length;
  }
  const oldId = new Map(doc.segments.map((s) => [s, s.id]));
  const base = doc.segments.filter((s) => !s.ocr);
  // Earlier OCR results of other pages are the same objects, so their translations follow.
  const merged = mergeOcr(base, ocr, doc.pages);
  const remap = new Map();
  merged.forEach((s, i) => { if (oldId.has(s)) remap.set(oldId.get(s), i + 1); s.id = i + 1; });
  const move = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) if (remap.has(Number(k))) out[remap.get(Number(k))] = v;
    return out;
  };
  state.translations = move(state.translations);
  state.overrides = move(state.overrides);
  state.kinds = move(state.kinds);
  doc.segments = merged;
  applyKinds();
  saveKinds();
  doc.ocr = ocr;
  idbPut(ocr, `ocr:${doc.id}`);
  persist();
  saveOverrides();
  // The translated PDF used the old numbers: it is built again on the next Build.
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
  return added;
}

/* ---- OCR of an area: four corners on a page */

// A rectangle is dragged over the text; its corners can then be moved one by one (a slanted or
// photographed block of text), and "Recognise" (or Enter) reads it. The corners are page points:
// top left, top right, bottom right, bottom left.
const ocrArea = { active: false, doc: null, page: -1, quad: null };

function ocrAreaBegin() {
  Object.assign(ocrArea, { active: true, doc: state.doc, page: -1, quad: null });
  $("#pages").classList.add("ocr-area-mode");
  $("#ocrAreaHint").hidden = false;
  ocrAreaSync();
}

function ocrAreaEnd() {
  Object.assign(ocrArea, { active: false, page: -1, quad: null });
  $("#pages").classList.remove("ocr-area-mode");
  $("#ocrAreaHint").hidden = true;
  document.querySelectorAll(".ocr-area").forEach((r) => r.remove());
}

function ocrAreaGo() {
  if (!ocrArea.active || !ocrArea.quad) return;
  const area = { page: ocrArea.page, quad: ocrArea.quad.map((q) => q.slice()) };
  ocrAreaEnd();
  startOcr({ area });
}

/** The hint above the pages and the outline with its corner handles (drawn anew when the page was). */
function ocrAreaSync() {
  const ready = Boolean(ocrArea.quad);
  $("#ocrAreaText").textContent = t(ready ? "ocr.areaAdjust" : "ocr.areaHint");
  $("#ocrAreaGo").hidden = !ready;
  document.querySelectorAll(".ocr-area").forEach((el) => { if (!ready || Number(el.dataset.page) !== ocrArea.page) el.remove(); });
  if (!ready) return;
  const body = document.querySelector(`#pages .page[data-page="${ocrArea.page}"] .page-body`);
  if (!body) return;
  const p = viewPages()[ocrArea.page];
  let box = body.querySelector(".ocr-area");
  if (!box) {
    box = document.createElement("div");
    box.className = "ocr-area";
    box.dataset.page = ocrArea.page;
    box.innerHTML = `<svg viewBox="0 0 ${p.width} ${p.height}" preserveAspectRatio="none"><polygon /></svg>` + [0, 1, 2, 3].map((k) => `<span class="ocr-area-handle" data-k="${k}"></span>`).join("");
    body.append(box);
  }
  const rel = ocrArea.quad.map(([x, y]) => [x - p.x0, y - p.y0]);
  box.querySelector("polygon").setAttribute("points", rel.map((q) => q.join(",")).join(" "));
  box.querySelectorAll(".ocr-area-handle").forEach((h, k) => { h.style.left = `${(rel[k][0] / p.width) * 100}%`; h.style.top = `${(rel[k][1] / p.height) * 100}%`; });
}

// (registered on the document in the capture phase, before the markup tools see the pointer)
function ocrAreaDown(e) {
  if (!ocrArea.active || e.button !== 0) return;
  if (state.doc !== ocrArea.doc) { ocrAreaEnd(); return; }
  const pageEl = e.target.closest && e.target.closest("#pages .page");
  if (!pageEl || !pageEl.querySelector(".page-body")) return;
  e.preventDefault(); e.stopPropagation();
  const i = Number(pageEl.dataset.page), p = viewPages()[i];
  const clamp = ([x, y]) => [Math.min(p.x0 + p.width, Math.max(p.x0, x)), Math.min(p.y0 + p.height, Math.max(p.y0, y))];
  const handle = e.target.closest(".ocr-area-handle");
  let move;
  if (handle && i === ocrArea.page) { // one corner moved
    const k = Number(handle.dataset.k);
    move = (ev) => { ocrArea.quad[k] = clamp(pagePoint(pageEl, ev)); ocrAreaSync(); };
  } else { // a new rectangle
    const a = clamp(pagePoint(pageEl, e));
    ocrArea.page = i;
    move = (ev) => {
      const b = clamp(pagePoint(pageEl, ev)), x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
      ocrArea.quad = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      ocrAreaSync();
    };
  }
  const up = (ev) => {
    document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true);
    move(ev);
    // a click or a sliver: nothing chosen
    const q = ocrArea.quad, xs = q ? q.map((c) => c[0]) : [0], ys = q ? q.map((c) => c[1]) : [0];
    if (!q || Math.max(...xs) - Math.min(...xs) < 6 || Math.max(...ys) - Math.min(...ys) < 6) ocrArea.quad = null;
    ocrAreaSync();
  };
  document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", up, true);
}

/** Whether point (x, y) lies inside the polygon `poly` ([[x, y], …]). */
function insidePolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Tesseract's boxes (blocks down to letters, baselines) taken through `map` (x, y) → [x, y]. */
function mapOcrData(data, map) {
  const seen = new Set();
  const box = (b) => {
    if (!b || seen.has(b)) return;
    seen.add(b);
    // (the mean of opposite corners, not the box around all four: a slanted line keeps its
    // height, so its font size is measured right)
    const [tl, tr, br, bl] = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => map(x, y));
    b.x0 = (tl[0] + bl[0]) / 2; b.x1 = (tr[0] + br[0]) / 2;
    b.y0 = (tl[1] + tr[1]) / 2; b.y1 = (bl[1] + br[1]) / 2;
  };
  for (const block of data.blocks || []) {
    box(block.bbox);
    for (const para of block.paragraphs || []) {
      box(para.bbox);
      for (const line of para.lines || []) {
        box(line.bbox);
        const bl = line.baseline;
        if (bl && !seen.has(bl) && bl.x0 != null) { seen.add(bl); [bl.x0, bl.y0] = map(bl.x0, bl.y0); [bl.x1, bl.y1] = map(bl.x1, bl.y1); }
        for (const w of line.words || []) { box(w.bbox); for (const c of w.symbols || []) box(c.bbox); }
      }
    }
  }
}

/** On opening a document: OCR results from an earlier session. */
async function restoreOcr(id, segments, pages) {
  const ocr = await idbGet(`ocr:${id}`);
  if (!ocr || !Object.keys(ocr).length) return { segments, ocr: null };
  const merged = mergeOcr(segments, ocr, pages);
  merged.forEach((s, i) => { s.id = i + 1; });
  return { segments: merged, ocr };
}

/** After opening a PDF: offer OCR for pages that are scans. */
function suggestOcr() {
  if (!state.doc || isBook() || state.doc.ocr) return;
  const n = scannedPages().length;
  if (n) toast(t("ocr.suggest", { n }), "", { label: t("ocr.suggestAction"), run: openOcrDialog });
}

/* ------------------------------------------------------- find and replace */

// One search field above the list: it filters the cards and highlights its matches, which are
// {id, where: "src" | "tr", index, length}, in document order (in the source text with <mark>, in
// the translation box with a layer behind it). ⇄ opens the options and replace.
const find = { open: false, matches: [], cur: -1, timer: 0 };

function findRegex() {
  const q = $("#search").value;
  if (!q) return null;
  const src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags = "gu" + ($("#findCase").checked ? "" : "i");
  if (!$("#findWord").checked) return new RegExp(src, flags);
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`, flags);
  } catch (_) { // no lookbehind (older Safari): word boundaries
    return new RegExp(`\\b${src}\\b`, flags);
  }
}

function collectMatches() {
  const re = findRegex(), scope = $("#findScope").value, out = [];
  if (re && state.doc) {
    for (const s of state.doc.segments) {
      if (scope !== "tr") for (const m of s.text.matchAll(re)) if (m[0]) out.push({ id: s.id, where: "src", index: m.index, length: m[0].length });
      const tr = state.translations[s.id] || "";
      if (scope !== "src" && tr) for (const m of tr.matchAll(re)) if (m[0]) out.push({ id: s.id, where: "tr", index: m.index, length: m[0].length });
    }
  }
  return out;
}

/** Search again (after typing, an option change or an edit), keeping the position if possible. */
function refreshFind() {
  const was = find.open;
  find.open = Boolean($("#search").value) && Boolean(state.doc);
  if (!find.open) {
    find.matches = []; find.cur = -1;
    updateFindCount();
    if (was) for (const [id, el] of vl.rendered) decorateCard(el, id);
    return;
  }
  const prev = find.matches[find.cur];
  find.matches = collectMatches();
  find.cur = prev ? find.matches.findIndex((m) => m.id === prev.id && m.where === prev.where && m.index >= prev.index) : -1;
  if (find.cur < 0 && prev) find.cur = find.matches.findIndex((m) => m.id > prev.id);
  updateFindCount();
  for (const [id, el] of vl.rendered) decorateCard(el, id);
}

function updateFindCount() {
  const n = find.matches.length;
  $("#findCount").textContent = !$("#search").value ? "" : n ? t("find.count", { i: find.cur >= 0 ? find.cur + 1 : 0, n }) : t("find.none");
  $("#search").classList.toggle("no-match", Boolean($("#search").value) && !n);
  $("#findPrev").disabled = $("#findNext").disabled = !n;
  const tr = find.matches.some((m) => m.where === "tr");
  $("#replaceOne").disabled = !tr;
  $("#replaceAll").disabled = !tr;
}

const markText = (text, ranges, cur) => {
  let out = "", pos = 0;
  for (const r of ranges) {
    out += escapeHtml(text.slice(pos, r.index)) + `<mark class="find${r === cur ? " cur" : ""}">${escapeHtml(text.slice(r.index, r.index + r.length))}</mark>`;
    pos = r.index + r.length;
  }
  return out + escapeHtml(text.slice(pos));
};

/** Show the matches of one card (or remove the highlights when the search is closed). */
function decorateCard(el, id) {
  const s = segById(id), src = el.querySelector(".seg-src"), ta = el.querySelector("textarea");
  if (!s || !src || !ta) return;
  const cur = find.matches[find.cur];
  const mine = find.open ? find.matches.filter((m) => m.id === id) : [];
  const inSrc = mine.filter((m) => m.where === "src"), inTr = mine.filter((m) => m.where === "tr");
  src.innerHTML = inSrc.length ? markText(s.text, inSrc, cur) : escapeHtml(s.text);
  let back = el.querySelector(".ta-backdrop");
  if (!inTr.length) {
    if (back) { back.remove(); ta.classList.remove("findable"); }
    return;
  }
  if (!back) {
    back = document.createElement("div");
    back.className = "ta-backdrop";
    ta.before(back);
    ta.classList.add("findable");
  }
  // The layer wraps exactly like the box: same font, same width for the text (scroll bar or not).
  const cs = getComputedStyle(ta);
  back.style.font = cs.font;
  back.style.letterSpacing = cs.letterSpacing;
  back.style.overflowY = ta.scrollHeight > ta.clientHeight + 1 ? "scroll" : "hidden";
  back.style.top = `${ta.offsetTop}px`;
  back.style.height = `${ta.offsetHeight}px`;
  back.innerHTML = markText(ta.value, inTr, cur) + "\n";
  back.scrollTop = ta.scrollTop;
}

/** Put the cursor into the search field (Ctrl+F); `replace` also opens options and replace (Ctrl+H). */
function openFind(replace) {
  if (!state.doc) return;
  if (replace) setReplaceMode(true);
  // A word selected in a translation box becomes the search text.
  const sel = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    ? document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) : "";
  if (sel && !sel.includes("\n")) { $("#search").value = sel; searchChanged(); }
  $("#search").focus();
  $("#search").select();
}

/** Clear the search: all cards again, no highlights, options and replace closed. */
function closeFind() {
  $("#search").value = "";
  setReplaceMode(false);
  searchChanged();
}

/** After the search text or an option changed: filter the list and mark the matches. */
function searchChanged() {
  find.cur = -1;
  applyFilter();
  refreshFind();
}

function setReplaceMode(on) {
  $("#findBar").hidden = !on;
  $("#findReplaceToggle").classList.toggle("on", on);
  $("#btnFind").classList.toggle("on", on);
}

/** Go to the next (dir 1) or previous (dir -1) match: its card is shown and highlighted. */
function gotoMatch(dir) {
  const n = find.matches.length;
  if (!n) return;
  find.cur = find.cur < 0 ? (dir > 0 ? 0 : n - 1) : (find.cur + dir + n) % n;
  const m = find.matches[find.cur];
  if (!vl.pos.has(m.id)) { $("#filterStatus").value = "all"; $("#filterPage").value = "all"; applyFilter(); }
  setActive(m.id, { scrollList: true, scrollViewer: true });
  updateFindCount();
  requestAnimationFrame(() => {
    for (const [id, el] of vl.rendered) decorateCard(el, id);
    const card = vl.rendered.get(m.id);
    const mark = card && card.querySelector("mark.find.cur");
    if (mark && m.where === "tr") { // scroll a long translation box to the match
      const ta = card.querySelector("textarea"), back = card.querySelector(".ta-backdrop");
      ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 2);
      back.scrollTop = ta.scrollTop;
    }
  });
}

/** Replace the current match (or the next one in a translation), then go on to the next. */
function replaceOne() {
  if (!find.matches.length) return;
  let i = find.cur;
  if (i < 0 || find.matches[i].where !== "tr") {
    const from = Math.max(0, i);
    i = find.matches.findIndex((m, k) => k >= from && m.where === "tr");
    if (i < 0) i = find.matches.findIndex((m) => m.where === "tr");
    if (i < 0) return;
    find.cur = i;
    gotoMatch(0);
    return; // the first press shows the match, the next one replaces it
  }
  const m = find.matches[i], before = state.translations[m.id] || "";
  const after = before.slice(0, m.index) + $("#replaceText").value + before.slice(m.index + m.length);
  writeTranslations({ [m.id]: after }, { [m.id]: before }, t("hist.replace"));
  find.matches = collectMatches();
  // the next match: the first one after the replaced text
  const next = find.matches.findIndex((x) => x.id > m.id || (x.id === m.id && (x.where === "tr" && x.index >= m.index + $("#replaceText").value.length)));
  find.cur = next >= 0 ? next - 1 : find.matches.length - 1;
  if (find.matches.length) gotoMatch(1); else { updateFindCount(); for (const [id, el] of vl.rendered) decorateCard(el, id); }
}

function replaceAll() {
  const re = findRegex();
  if (!re || $("#replaceAll").disabled) return;
  const repl = $("#replaceText").value, before = {}, after = {};
  let n = 0;
  for (const [id, text] of Object.entries(state.translations)) {
    if (!segById(id)) continue;
    const out = text.replace(re, () => { n++; return repl; });
    if (out !== text) { before[id] = text; after[id] = out; }
  }
  if (!n) { toast(t("find.none")); return; }
  writeTranslations(after, before, t("hist.replaceAll", { n }));
  find.cur = -1;
  refreshFind();
  toast(t("find.replaced", { n, k: Object.keys(after).length }), "ok");
}

/** Set several translations at once (undoable), updating the cards that are shown. */
function writeTranslations(after, before, label) {
  for (const [id, text] of Object.entries(after)) {
    setTranslation(Number(id), text);
    const el = vl.rendered.get(Number(id));
    if (el) {
      const ta = el.querySelector("textarea");
      ta.value = text;
      autoGrow(ta);
      el.classList.toggle("pending", isPending(Number(id)));
    }
  }
  recordTranslations(before, after, label);
}

function onFindKey(e) {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "f" || k === "h") && state.doc && !document.querySelector("dialog[open]") && !e.target.closest(".mk-editor")) {
    e.preventDefault();
    openFind(k === "h" ? true : undefined);
  } else if (k === "f3" && find.open) {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (k === "escape" && e.target.closest && e.target.closest("#findBar, .search-box") && ($("#search").value || !$("#findBar").hidden)) {
    closeFind();
  }
}

/* ------------------------------------------------------------------- setup */

function initTools() {
  initCompare();
  initLayout();
  const pages = $("#pages");
  pages.addEventListener("pointerdown", onBoxDown);
  window.addEventListener("pointermove", onBoxMove);
  window.addEventListener("pointerup", onBoxUp);
  window.addEventListener("pointercancel", onBoxUp);
  pages.addEventListener("click", (e) => {
    if (boxDrag.justDragged) { boxDrag.justDragged = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
  const list = $("#segments");
  list.addEventListener("change", onStyleInput);
  list.addEventListener("click", onStyleClick);
  $("#btnAppFullscreen").addEventListener("click", toggleAppFullscreen);
  document.addEventListener("fullscreenchange", () => {
    $("#btnAppFullscreen").classList.toggle("on", Boolean(document.fullscreenElement) && !document.body.classList.contains("viewer-only"));
  });
  $("#zoomPage").addEventListener("click", fitPage);
  $("#pageRotate").addEventListener("click", rotateCurrentPage);
  $("#btnDownloadBi").addEventListener("click", (e) => { e.preventDefault(); askBilingual(); });
  $("#biDialog").addEventListener("close", () => {
    if ($("#biDialog").returnValue !== "ok") return;
    const layout = document.querySelector('input[name="biLayout"]:checked').value;
    try { localStorage.setItem("pdftr:bi-layout", layout); } catch (_) { /* storage blocked */ }
    downloadBilingual(layout);
  });
  $("#btnFind").addEventListener("click", () => { setReplaceMode($("#findBar").hidden); $("#search").focus(); });
  $("#findClose").addEventListener("click", () => setReplaceMode(false));
  $("#findReplaceToggle").addEventListener("click", () => setReplaceMode($("#findBar").hidden));
  $("#search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } });
  $("#replaceText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); } });
  for (const id of ["#findScope", "#findCase", "#findWord"]) $(id).addEventListener("change", searchChanged);
  $("#findPrev").addEventListener("click", () => gotoMatch(-1));
  $("#findNext").addEventListener("click", () => gotoMatch(1));
  $("#replaceOne").addEventListener("click", replaceOne);
  $("#replaceAll").addEventListener("click", replaceAll);
  document.addEventListener("keydown", onFindKey, true);
  // Edits while searching update the matches (a little later, while typing).
  list.addEventListener("input", (e) => {
    if (!find.open || e.target.tagName !== "TEXTAREA") return;
    clearTimeout(find.timer);
    find.timer = setTimeout(refreshFind, 200);
  });
  list.addEventListener("scroll", (e) => {
    if (e.target.tagName === "TEXTAREA" && e.target.previousElementSibling && e.target.previousElementSibling.classList.contains("ta-backdrop")) {
      e.target.previousElementSibling.scrollTop = e.target.scrollTop;
    }
  }, true);
  $("#btnOcr").addEventListener("click", openOcrDialog);
  $("#ocrGo").addEventListener("click", (e) => {
    e.preventDefault();
    if ($("#ocrPagesRange").checked && !parsePageRange($("#ocrRange").value, state.doc.pages.length)) {
      toast(t("ocr.badRange", { n: state.doc.pages.length }), "error"); $("#ocrRange").focus(); return;
    }
    $("#ocrDialog").close();
    if ($("#ocrPagesArea").checked) {
      if (!document.querySelectorAll("#ocrLangs input:checked").length) { toast(t("ocr.noLang"), "error"); return; }
      ocrAreaBegin();
    } else startOcr();
  });
  $("#ocrAreaCancel").addEventListener("click", ocrAreaEnd);
  $("#ocrAreaGo").addEventListener("click", ocrAreaGo);
  document.addEventListener("pointerdown", ocrAreaDown, true);
  document.addEventListener("keydown", (e) => {
    if (!ocrArea.active) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ocrAreaEnd(); }
    else if (e.key === "Enter" && ocrArea.quad) { e.preventDefault(); e.stopPropagation(); ocrAreaGo(); }
  }, true);
  // (the outline is drawn again when its page was, e.g. after zooming)
  new MutationObserver(() => { if (ocrArea.active && ocrArea.quad && !document.querySelector("#pages .ocr-area")) ocrAreaSync(); })
    .observe($("#pages"), { childList: true, subtree: true });
  // Typing a page list selects that choice.
  $("#ocrRange").addEventListener("focus", () => { $("#ocrPagesRange").checked = true; });
  $("#ocrRange").addEventListener("input", () => { $("#ocrPagesRange").checked = true; });
}

/* ---------------------------------------------------------- comparison view */

// Original (the main viewer, left) and translation (right) side by side, scrolling together.
// PDF pages correspond one to one; the pages of a translated e-book or Office document are
// matched through the segments shown near the top of the view.
const cmp = { on: false, observer: null, visible: new Set(), queue: [], busy: false, cache: new Map(), expect: { main: null, cmp: null }, savedZoom: null };
const CMP_CACHE_MAX = 30;

const cmpPages = () => (isBook() && state.outView ? state.outView.pages : state.doc.pages);
const cmpKey = (i) => `${state.buildNo}.${state.pageVersion.get(i) || 0}:${i}:${renderZoom(cmpPages()[i])}`;

function setCompare(on) {
  if (on && (!state.doc || !state.hasOutput)) return;
  if (on === cmp.on) return;
  cmp.on = on;
  if (on && state.variant !== "original") setVariant("original");
  document.body.classList.toggle("comparing", on);
  $("#pagesCmp").hidden = !on;
  $("#viewCompare").classList.toggle("active", on);
  $("#viewOriginal").classList.toggle("active", !on && state.variant === "original");
  if (on) {
    cmp.savedZoom = state.zoom;
    renderCmpPages();
    requestAnimationFrame(() => { fitWidth(); syncCmp("main"); });
  } else {
    cmp.observer?.disconnect();
    $("#pagesCmp").innerHTML = "";
    for (const url of cmp.cache.values()) URL.revokeObjectURL(url);
    cmp.cache.clear();
    // The zoom from before the comparison comes back, unless another document is open by then.
    const z = cmp.savedZoom, doc = state.doc;
    cmp.savedZoom = null;
    if (z) requestAnimationFrame(() => { if (doc && state.doc === doc) setZoom(z); });
  }
}

function sizeCmpPage(el) {
  const i = Number(el.dataset.cpage), page = cmpPages()[i];
  if (!page) return;
  const rot = isBook() ? 0 : pageRotation(i);
  const w = pageCssWidth(page), h = Math.round((w * page.height) / page.width);
  el.style.width = `${rot % 180 ? h : w}px`;
  el.style.aspectRatio = rot % 180 ? `${page.height} / ${page.width}` : `${page.width} / ${page.height}`;
  const body = el.querySelector(".page-body");
  body.style.width = `${w}px`;
  body.style.height = `${h}px`;
  body.style.transform = `translate(-50%, -50%)${rot ? ` rotate(${rot}deg)` : ""}`;
}

/** Where each segment is shown on the two sides: {id: [page, bbox]} (the first box). */
function cmpPlaces(side) {
  const out = new Map();
  for (const s of state.doc.segments) {
    const boxes = side === "cmp"
      ? (isBook() ? state.outView && state.outView.boxes[s.id] : s.bbox && [[s.page, shownBox(s)]])
      : s.boxes || (s.bbox && [[s.page, shownBox(s)]]);
    if (boxes && boxes.length) out.set(s.id, boxes);
  }
  return out;
}

function renderCmpPages() {
  if (!cmp.on) return;
  const wrap = $("#pagesCmp");
  cmp.observer?.disconnect();
  cmp.visible.clear();
  cmp.queue = [];
  cmp.places = { main: cmpPlaces("main"), cmp: cmpPlaces("cmp") };
  wrap.innerHTML = cmpPages().map((p, i) =>
    `<div class="cpage" data-cpage="${i}"><span class="page-label">${t("page.n", { n: i + 1 })}</span><div class="page-body"><img alt=""></div></div>`).join("");
  wrap.querySelectorAll(".cpage").forEach(sizeCmpPage);
  // Boxes to click on the translated side (by page, added as the page comes near).
  cmp.byPage = new Map();
  for (const [id, boxes] of cmp.places.cmp) for (const [p, bbox] of boxes) {
    if (!cmp.byPage.has(p)) cmp.byPage.set(p, []);
    cmp.byPage.get(p).push([id, bbox]);
  }
  cmp.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.cpage);
      if (e.isIntersecting) { cmp.visible.add(i); cmpBoxes(e.target, i); cmpQueue(i); } else cmp.visible.delete(i);
    }
  }, { root: wrap, rootMargin: "800px 0px" });
  wrap.querySelectorAll(".cpage").forEach((el) => cmp.observer.observe(el));
}

/** The markups of page i on the translated side as well (shown only; they are edited on the left). */
function cmpMarkups(i) {
  if (!cmp.on || isBook()) return;
  const el = document.querySelector(`#pagesCmp .cpage[data-cpage="${i}"]`);
  if (!el || !el.dataset.boxes) return;
  let svg = el.querySelector("svg.mk-layer");
  const list = state.markups.filter((m) => m.page === i);
  if (!svg && !list.length) return;
  if (!svg) {
    const p = state.doc.pages[i];
    svg = svgEl("svg", { class: "mk-layer", viewBox: `${p.x0} ${p.y0} ${p.width} ${p.height}`, preserveAspectRatio: "none" });
    el.querySelector(".page-body").appendChild(svg);
  }
  svg.replaceChildren(...list.map(markupNode));
}

function cmpBoxes(el, i) {
  if (el.dataset.boxes) return;
  el.dataset.boxes = "1";
  cmpMarkups(i);
  const page = cmpPages()[i];
  el.querySelector(".page-body").insertAdjacentHTML("beforeend", (cmp.byPage.get(i) || []).map(([id, [x0, y0, x1, y1]]) =>
    `<div class="cbox${id === state.activeId ? " active" : ""}" data-id="${id}" title="#${id}" style="left:${((x0 - page.x0) / page.width) * 100}%;top:${((y0 - page.y0) / page.height) * 100}%;width:${((x1 - x0) / page.width) * 100}%;height:${((y1 - y0) / page.height) * 100}%"></div>`).join(""));
}

/** Show the active segment on the translated side too. */
function cmpMarkActive(id) {
  if (!cmp.on) return;
  document.querySelectorAll("#pagesCmp .cbox.active").forEach((b) => b.classList.remove("active"));
  if (id !== null && id !== undefined) document.querySelectorAll(`#pagesCmp .cbox[data-id="${id}"]`).forEach((b) => b.classList.add("active"));
}

function cmpQueue(i) {
  const el = $("#pagesCmp").querySelector(`.cpage[data-cpage="${i}"]`);
  if (!el) return;
  const key = cmpKey(i), img = el.querySelector("img");
  if (img.dataset.key === key) return;
  const url = cmp.cache.get(key);
  if (url) { img.src = url; img.dataset.key = key; return; }
  if (!cmp.queue.includes(i)) cmp.queue.push(i);
  cmpPump();
}

async function cmpPump() {
  if (cmp.busy) return;
  cmp.busy = true;
  const doc = state.doc;
  try {
    while (cmp.on && state.doc === doc && cmp.queue.length) {
      cmp.queue = cmp.queue.filter((i) => cmp.visible.has(i));
      if (!cmp.queue.length) break;
      const i = cmp.queue.shift(), key = cmpKey(i), page = cmpPages()[i];
      // The translated document lives in worker 0.
      const buf = await pool.workers[0].call("render", { page: i, zoom: renderZoom(page), variant: "translated" });
      if (!cmp.on || state.doc !== doc) break;
      const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
      cmp.cache.set(key, url);
      while (cmp.cache.size > CMP_CACHE_MAX) {
        const [oldKey, oldUrl] = cmp.cache.entries().next().value;
        cmp.cache.delete(oldKey);
        URL.revokeObjectURL(oldUrl);
        const stale = document.querySelector(`#pagesCmp img[data-key="${CSS.escape(oldKey)}"]`);
        if (stale) { stale.removeAttribute("src"); delete stale.dataset.key; }
      }
      const img = document.querySelector(`#pagesCmp .cpage[data-cpage="${i}"] img`);
      if (img && cmpKey(i) === key) { img.src = url; img.dataset.key = key; }
    }
  } catch (err) {
    console.warn("compare render failed", err);
  } finally {
    cmp.busy = false;
  }
}

/** After a zoom, a build or an applied field: resize and redraw the translated side. */
function refreshCmp(rebuild = false) {
  if (!cmp.on) return;
  if (rebuild || $("#pagesCmp").querySelectorAll(".cpage").length !== cmpPages().length) { renderCmpPages(); syncCmp("main"); return; }
  $("#pagesCmp").querySelectorAll(".cpage").forEach(sizeCmpPage);
  for (const i of cmp.visible) cmpQueue(i);
}

/** The page at the top of a side and how far down it is shown: {i, f} (f from 0 to 1). */
function cmpAnchor(wrap, sel, attr) {
  const top = wrap.getBoundingClientRect().top;
  for (const el of wrap.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) return { i: Number(el.dataset[attr]), f: Math.max(0, (top - r.top) / r.height), el };
  }
  return null;
}

/** Scroll the other side so it shows the same place as `from` ("main" or "cmp"). */
function syncCmp(from) {
  if (!cmp.on) return;
  const main = $("#pages"), other = $("#pagesCmp");
  const [src, dst] = from === "main" ? [main, other] : [other, main];
  const [srcSel, srcAttr, dstSel, dstAttr] = from === "main" ? [".page", "page", ".cpage", "cpage"] : [".cpage", "cpage", ".page", "page"];
  // PDF: both sides have the same pages at the same size, so the same scroll position.
  if (!isBook()) { moveTo(dst, src.scrollTop, src.scrollLeft); return; }
  const a = cmpAnchor(src, srcSel, srcAttr);
  if (!a) return;
  let target = { i: a.i, f: a.f };
  if (isBook()) {
    // The first segment shown from the top of this side, found on the other side.
    const srcPages = from === "main" ? state.doc.pages : cmpPages(), dstPages = from === "main" ? cmpPages() : state.doc.pages;
    const sp = srcPages[a.i];
    const y = sp.y0 + a.f * sp.height;
    let best = null;
    for (const [id, boxes] of cmp.places[from]) {
      for (const [p, b] of boxes) {
        if (p < a.i || (p === a.i && b[3] < y)) continue;
        if (!best || p < best.p || (p === best.p && b[1] < best.y)) best = { id, p, y: b[1] };
        break;
      }
    }
    const there = best && cmp.places[from === "main" ? "cmp" : "main"].get(best.id);
    if (there) {
      // Keep the segment the same distance below the top on both sides.
      const dp = dstPages[there[0][0]];
      const gap = best.p === a.i ? (best.y - y) / sp.height : 0;
      target = { i: there[0][0], f: (there[0][1][1] - dp.y0) / dp.height - gap };
    } else {
      const pos = (a.i + a.f) / srcPages.length * dstPages.length;
      target = { i: Math.min(dstPages.length - 1, Math.floor(pos)), f: pos % 1 };
    }
  }
  const el = dst.querySelector(`${dstSel}[data-${dstAttr}="${target.i}"]`);
  if (!el) return;
  const delta = el.getBoundingClientRect().top - dst.getBoundingClientRect().top + target.f * el.getBoundingClientRect().height;
  moveTo(dst, dst.scrollTop + delta, src.scrollLeft);
}

/** Scroll `el` without syncing the move back (its scroll event is recognised and skipped). */
function moveTo(el, top, left) {
  const side = el.id === "pages" ? "main" : "cmp";
  const before = [el.scrollTop, el.scrollLeft];
  el.scrollTop = top;
  el.scrollLeft = left;
  if (Math.abs(el.scrollTop - before[0]) >= 0.5 || Math.abs(el.scrollLeft - before[1]) >= 0.5) cmp.expect[side] = [el.scrollTop, el.scrollLeft];
}

function initCompare() {
  $("#viewCompare").addEventListener("click", () => setCompare(!cmp.on));
  // When the viewer gets wider or narrower (full screen, window size, the border to the fields, the
  // folded tool rail), the pages fit the width again: always in the comparison view, otherwise when
  // the zoom was "fit width".
  let lastWidth = 0, fitTimer = 0;
  new ResizeObserver(() => {
    const w = $("#pages").clientWidth;
    if (!state.doc || !w || Math.abs(w - lastWidth) < 2) { lastWidth = w; return; }
    lastWidth = w;
    if (!cmp.on && !state.fitMode && !splitDrag) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!cmp.on && state.fitMode === "page" && state.doc && state.doc.image) { setZoom(fitPictureZoom()); state.fitMode = "page"; return; }
      if (cmp.on || state.fitMode || splitDrag) { fitWidth(); syncCmp("main"); }
    }, splitDrag ? 0 : 100);
  }).observe($("#pages"));
  // The other side follows in the same scroll event, so both move together.
  for (const [id, side] of [["#pages", "main"], ["#pagesCmp", "cmp"]]) {
    const el = $(id);
    el.addEventListener("scroll", () => {
      if (!cmp.on) return;
      const exp = cmp.expect[side];
      if (exp) {
        cmp.expect[side] = null;
        if (Math.abs(el.scrollTop - exp[0]) < 1 && Math.abs(el.scrollLeft - exp[1]) < 1) return; // our own move
      }
      syncCmp(side);
    }, { passive: true });
  }
  $("#pagesCmp").addEventListener("click", (e) => {
    const box = e.target.closest(".cbox");
    if (box) setActive(Number(box.dataset.id), { scrollList: true, scrollViewer: true, focus: true });
    else clearActive();
  });
}

/* ------------------------------------------- page view / fields border, tool rail */

const SPLIT_KEY = "pdftr:split", RAIL_KEY = "pdftr:rail-folded";
let splitDrag = null;

/** Width of the page view as a share of the workspace (null: the default layout). */
function setSplit(share) {
  const wv = $("#workView");
  if (share === null) { wv.style.gridTemplateColumns = ""; return; }
  // (in hundreds: fr factors that add up to less than 1 leave part of the width empty once a
  // column is held at its minimum)
  wv.style.gridTemplateColumns = `minmax(240px, ${share * 100}fr) 6px minmax(320px, ${(1 - share) * 100}fr)`;
}

function initLayout() {
  const split = $("#splitter"), wv = $("#workView");
  try { const v = Number(localStorage.getItem(SPLIT_KEY)); if (v > 0 && v < 1) setSplit(v); } catch (_) { /* storage blocked */ }
  split.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    splitDrag = { left: wv.getBoundingClientRect().left, width: wv.getBoundingClientRect().width };
    document.body.classList.add("splitting");
  });
  split.addEventListener("pointermove", (e) => {
    if (!splitDrag) return;
    const x = Math.min(splitDrag.width - 320, Math.max(240, e.clientX - splitDrag.left));
    setSplit(x / splitDrag.width);
  });
  const end = () => {
    if (!splitDrag) return;
    splitDrag = null;
    document.body.classList.remove("splitting");
    const cols = getComputedStyle(wv).gridTemplateColumns.split(" ").map(parseFloat);
    try { localStorage.setItem(SPLIT_KEY, String(cols[0] / (cols[0] + cols[2]))); } catch (_) { /* storage blocked */ }
    if (state.doc) fitWidth(); // the pages fit the new width
  };
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
  split.addEventListener("keydown", (e) => { // arrow keys move the border too
    const step = e.key === "ArrowLeft" ? -0.02 : e.key === "ArrowRight" ? 0.02 : 0;
    if (!step) return;
    e.preventDefault();
    const cols = getComputedStyle(wv).gridTemplateColumns.split(" ").map(parseFloat);
    const share = Math.min(0.8, Math.max(0.2, cols[0] / (cols[0] + cols[2]) + step));
    setSplit(share);
    try { localStorage.setItem(SPLIT_KEY, String(share)); } catch (_) { /* storage blocked */ }
    if (state.doc) fitWidth();
  });
  split.addEventListener("dblclick", () => { // back to the default layout
    setSplit(null);
    try { localStorage.removeItem(SPLIT_KEY); } catch (_) { /* storage blocked */ }
    if (state.doc) requestAnimationFrame(fitWidth);
  });

  const rail = $("#toolRail");
  const fold = (on) => {
    rail.classList.toggle("folded", on);
    $("#railFold").title = t(on ? "tool.unfold" : "tool.fold");
    try { localStorage.setItem(RAIL_KEY, on ? "1" : ""); } catch (_) { /* storage blocked */ }
  };
  let folded = false;
  try { folded = localStorage.getItem(RAIL_KEY) === "1"; } catch (_) { /* storage blocked */ }
  fold(folded);
  $("#railFold").addEventListener("click", () => fold(!rail.classList.contains("folded")));
  document.addEventListener("languagechange", () => { $("#railFold").title = t(rail.classList.contains("folded") ? "tool.unfold" : "tool.fold"); });
}
