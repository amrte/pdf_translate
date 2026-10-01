// ======================================================================
// Field layout and style (move and resize boxes on the page; size, font, colour per field),
// full screen for the whole app, fit page, password-protected PDFs, and OCR for scanned pages.
// ======================================================================

/* ------------------------------------------------------ per-field overrides */

// state.overrides: segment id -> {bbox, size, font, bold, italic, color}, stored per document.
const ovKey = (id) => `pdftr:ov:${id}`;

function loadOverrides() {
  try { state.overrides = isBook() ? {} : JSON.parse(localStorage.getItem(ovKey(state.doc.id)) || "{}"); } catch (_) { state.overrides = {}; }
}

function saveOverrides() {
  try { localStorage.setItem(ovKey(state.doc.id), JSON.stringify(state.overrides)); } catch (_) { /* storage blocked */ }
}

const ROT_DIR = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] };

/** The box shown for a segment: the user's box when the field was moved or resized. */
const shownBox = (s) => (state.overrides[s.id] && state.overrides[s.id].bbox) || s.bbox;

/** A segment as the rebuild lays it out: with the user's box, size, font, style and colour. */
function effSeg(s) {
  const o = state.overrides && state.overrides[s.id];
  if (!o || isBook()) return s;
  const e = { ...s };
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
  if (!state.hasOutput || !hasTr(id)) return;
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
  if (!s || isBook()) return;
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
  if (isBook() || id === null || id === undefined) return;
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
  if (e.button !== 0 || !state.doc || isBook() || mk.tool !== "select") return;
  const box = e.target.closest(".box");
  if (!box) return;
  const pageEl = box.closest(".page"), id = Number(box.dataset.id), s = segById(id);
  if (!s) return;
  boxDrag.cur = { id, box, pageEl, handle: e.target.dataset.h || null, start: pagePoint(pageEl, e), orig: shownBox(s).slice(), moved: false };
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
  const same = d.bbox.every((v, i) => Math.abs(v - s.bbox[i]) < 0.3);
  setOverride(d.id, { bbox: same ? null : d.bbox }, t(d.handle ? "hist.resize" : "hist.move"));
  if (state.activeId !== d.id) setActive(d.id, { scrollList: true });
}

/* ------------------------------------------------------ style of one field */

const styleOpen = new Set(); // cards whose style panel is open

function stylePanelHtml(s) {
  const o = state.overrides[s.id] || {};
  const bold = o.bold !== undefined ? o.bold : s.bold, italic = o.italic !== undefined ? o.italic : s.italic;
  const fonts = [["", "st.fontOrig"], ["sans-serif", "st.sans"], ["serif", "st.serif"], ["monospace", "st.mono"]];
  if (state.customFont || o.font === "custom") fonts.push(["custom", "st.custom"]);
  return `<div class="seg-style">
    <label title="${escapeHtml(t("st.sizeTitle"))}">${t("st.size")} <input type="number" data-st="size" min="0.5" step="any" value="${o.size || ""}" placeholder="${Math.round(s.size * 10) / 10}"></label>
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
    const v = Number(el.value);
    setOverride(id, { size: v > 0 && Math.abs(v - s.size) > 0.01 ? v : null }, t("hist.field"), "size");
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
  document.body.classList.remove("viewer-only");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => toast(t("msg.noFullscreen"), "error"));
}

/** Zoom so that the whole current page is visible. */
function fitPage() {
  if (!state.doc) return;
  const box = $("#pages"), i = currentPageIndex(), [w, h] = shownSize(i);
  const zw = (box.clientWidth - 48) / (w * 1.25), zh = (box.clientHeight - 44) / (h * 1.25);
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
    dlg.showModal();
    $("#pwInput").focus();
  });
}

/* --------------------------------------------------------------------- OCR */

const OCR_LIB = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js";
const OCR_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js";
const OCR_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0";
const OCR_LANG_PATH = ""; // "" = the language data on jsDelivr (@tesseract.js-data/<lang>)
const OCR_LANGS = ["eng", "deu", "fra", "ukr", "fin", "chi_sim", "chi_tra"];
const LS_OCR = "pdftr:ocr-options";

function idbSet(key, value) {
  return idb().then((db) => new Promise((resolve) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(value, key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  })).catch(() => {});
}

function idbGetKey(key) {
  return idb().then((db) => new Promise((resolve) => {
    const req = db.transaction("files").objectStore("files").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })).catch(() => null);
}

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
  $("#ocrLangs").innerHTML = OCR_LANGS.map((l) =>
    `<label class="check"><input type="checkbox" value="${l}"${langs.includes(l) ? " checked" : ""}> ${escapeHtml(t("ocrlang." + l))}</label>`).join("");
  const scans = scannedPages().length;
  $("#ocrPagesEmpty").checked = scans > 0;
  $("#ocrPagesAll").checked = scans === 0;
  $("#ocrScanCount").textContent = t("ocr.scanCount", { n: scans });
  $("#ocrFamily").value = saved.family || "serif";
  $("#ocrDialog").showModal();
}

let ocrCancel = false;

async function startOcr() {
  const langs = [...document.querySelectorAll("#ocrLangs input:checked")].map((i) => i.value);
  if (!langs.length) { toast(t("ocr.noLang"), "error"); return; }
  const family = $("#ocrFamily").value;
  try { localStorage.setItem(LS_OCR, JSON.stringify({ langs, family })); } catch (_) { /* fine */ }
  const pages = $("#ocrPagesEmpty").checked ? scannedPages() : state.doc.pages.map((p, i) => i);
  if (!pages.length) { toast(t("ocr.none")); return; }
  ocrCancel = false;
  const doc = state.doc;
  let worker = null;
  try {
    busy(t("ocr.loading"), () => { ocrCancel = true; });
    const T = await import(OCR_LIB);
    const createWorker = T.createWorker || (T.default && T.default.createWorker);
    worker = await createWorker(langs.join("+"), 1, {
      workerPath: OCR_WORKER, corePath: OCR_CORE, workerBlobURL: true, ...(OCR_LANG_PATH ? { langPath: OCR_LANG_PATH } : {}),
    });
    await worker.setParameters({ tessedit_pageseg_mode: "11" }); // sparse text: table cells and labels too
    const results = {};
    for (const [k, p] of pages.entries()) {
      if (ocrCancel || state.doc !== doc) break;
      busy(t("ocr.page", { i: k + 1, n: pages.length }), () => { ocrCancel = true; });
      const page = doc.pages[p];
      const zoom = Math.min(3, 3600 / Math.max(page.width, page.height));
      const buf = await pool.workers[0].call("render", { page: p, zoom, variant: "original" });
      const blob = new Blob([buf], { type: "image/png" });
      const first = (await worker.recognize(blob, {}, { blocks: true })).data;
      // Rows Tesseract was unsure of are read again as single lines.
      await worker.setParameters({ tessedit_pageseg_mode: "7" });
      const data = await Engine.refineOcr(first, async (rectangle) => (await worker.recognize(blob, { rectangle }, { blocks: true })).data);
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      const img = await imageDataOf(blob);
      const { blocks, seps } = Engine.ocrToBlocks(data, zoom, [page.x0, page.y0], (box) => Engine.sampleColors(img, box));
      let segs = blocks.length ? await pool.workers[0].call("ocrPage", { page: p, lines: blocks, seps, family }) : [];
      // On a page that has a text layer, only text that is not there yet (e.g. in pictures) is added.
      const text = doc.segments.filter((s) => s.page === p && !s.ocr).map((s) => s.bbox);
      segs = segs.filter((s) => !text.some((b) => overlapShare(s.bbox, b) > 0.3));
      results[p] = { segs, seps };
    }
    if (state.doc !== doc) return;
    const added = addOcrResults(results);
    toast(ocrCancel ? t("ocr.cancelled", { n: added }) : t("ocr.done", { n: added, p: Object.keys(results).length }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("ocr.failed", { err: err.message || err }), "error");
  } finally {
    if (worker) worker.terminate().catch(() => {});
    busy("");
  }
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
  for (const [p, r] of Object.entries(results)) {
    ocr[p] = { segs: r.segs.map((s) => ({ ...s, page: Number(p), ocr: true })), seps: r.seps };
    added += r.segs.length;
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
  doc.segments = merged;
  doc.ocr = ocr;
  idbSet(`ocr:${doc.id}`, ocr);
  persist();
  saveOverrides();
  // The translated PDF used the old numbers: it is built again on the next Build.
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
  return added;
}

/** On opening a document: OCR results from an earlier session. */
async function restoreOcr(id, segments, pages) {
  const ocr = await idbGetKey(`ocr:${id}`);
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

// Matches are {id, where: "src" | "tr", index, length}, in document order. They are highlighted
// in the cards: in the source text with <mark>, in the translation box with a layer behind it.
const find = { open: false, matches: [], cur: -1, timer: 0 };

function findRegex() {
  const q = $("#findText").value;
  if (!q) return null;
  let src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if ($("#findWord").checked) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, "gu" + ($("#findCase").checked ? "" : "i"));
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
  if (!find.open) return;
  const prev = find.matches[find.cur];
  find.matches = collectMatches();
  find.cur = prev ? find.matches.findIndex((m) => m.id === prev.id && m.where === prev.where && m.index >= prev.index) : -1;
  if (find.cur < 0 && prev) find.cur = find.matches.findIndex((m) => m.id > prev.id);
  updateFindCount();
  for (const [id, el] of vl.rendered) decorateCard(el, id);
}

function updateFindCount() {
  const n = find.matches.length;
  $("#findCount").textContent = !$("#findText").value ? "" : n ? t("find.count", { i: find.cur >= 0 ? find.cur + 1 : 0, n }) : t("find.none");
  $("#findText").classList.toggle("no-match", Boolean($("#findText").value) && !n);
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

function openFind(replace) {
  if (!state.doc) return;
  find.open = true;
  $("#findBar").hidden = false;
  $("#btnFind").classList.add("on");
  if (replace !== undefined) setReplaceMode(replace);
  // A word selected in a translation box becomes the search text.
  const sel = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    ? document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) : "";
  if (sel && !sel.includes("\n")) $("#findText").value = sel;
  $("#findText").focus();
  $("#findText").select();
  refreshFind();
}

function closeFind() {
  find.open = false;
  find.matches = [];
  find.cur = -1;
  $("#findBar").hidden = true;
  $("#btnFind").classList.remove("on");
  for (const [id, el] of vl.rendered) decorateCard(el, id);
}

function setReplaceMode(on) {
  $("#replaceRow").hidden = !on;
  $("#findReplaceToggle").classList.toggle("on", on);
  if (on && $("#findScope").value === "src") $("#findScope").value = "tr"; // (only translations are replaced)
}

/** Go to the next (dir 1) or previous (dir -1) match: its card is shown and highlighted. */
function gotoMatch(dir) {
  const n = find.matches.length;
  if (!n) return;
  find.cur = find.cur < 0 ? (dir > 0 ? 0 : n - 1) : (find.cur + dir + n) % n;
  const m = find.matches[find.cur];
  if (!vl.pos.has(m.id)) { $("#search").value = ""; $("#filterStatus").value = "all"; $("#filterPage").value = "all"; applyFilter(); }
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
  if (!re) return;
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
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "f" || k === "h") && state.doc && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    openFind(k === "h" ? true : undefined);
  } else if (k === "f3" && find.open) {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (k === "escape" && find.open && e.target.closest && e.target.closest("#findBar")) {
    closeFind();
  }
}

/* ------------------------------------------------------------------- setup */

function initTools() {
  const pages = $("#pages");
  pages.addEventListener("pointerdown", onBoxDown);
  window.addEventListener("pointermove", onBoxMove);
  window.addEventListener("pointerup", onBoxUp);
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
  $("#btnDownloadBi").addEventListener("click", (e) => { e.preventDefault(); downloadBilingual(); });
  $("#btnFind").addEventListener("click", () => (find.open ? closeFind() : openFind()));
  $("#findClose").addEventListener("click", closeFind);
  $("#findReplaceToggle").addEventListener("click", () => setReplaceMode($("#replaceRow").hidden));
  $("#findText").addEventListener("input", () => { find.cur = -1; refreshFind(); });
  $("#findText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } });
  $("#replaceText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); } });
  for (const id of ["#findScope", "#findCase", "#findWord"]) $(id).addEventListener("change", () => { find.cur = -1; refreshFind(); });
  $("#findScope").addEventListener("change", () => { if ($("#findScope").value === "src") setReplaceMode(false); });
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
  $("#ocrGo").addEventListener("click", (e) => { e.preventDefault(); $("#ocrDialog").close(); startOcr(); });
}
