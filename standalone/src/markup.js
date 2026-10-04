// ======================================================================
// Markup tools (rectangle, ellipse, highlighter, pen, arrow, text note, whiteout, eraser),
// page navigation, and undo/redo. Markups live in page coordinates (the same space as the
// segment boxes), are drawn on an SVG layer over each page, stored per document in
// localStorage, and written into the PDF as standard annotations when it is downloaded.
// ======================================================================
const SVGNS = "http://www.w3.org/2000/svg";
const TOOL_KEYS = { v: "select", r: "rect", o: "ellipse", h: "highlight", p: "ink", a: "arrow", t: "text", w: "whiteout", e: "eraser" };
const BOX_TOOLS = new Set(["rect", "ellipse", "highlight", "whiteout"]);

const mk = {
  tool: "select",
  color: "#e53935",
  highlightColor: "#ffd400",
  width: 2,
  selected: null,  // id of the selected markup
  draft: null,     // shape being drawn
  drag: null,      // markup being moved
  seq: 1,
};
const mkKey = (id) => `pdftr:mk:${id}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ---------------------------------------------------------------- history */

const history = { undo: [], redo: [] };

/** Record an undoable action: {label, undo(), redo()}. */
function pushHistory(entry) {
  history.undo.push(entry);
  if (history.undo.length > 300) history.undo.shift();
  history.redo = [];
  updateHistoryButtons();
}

function undo() {
  const e = history.undo.pop();
  if (!e) { toast(t("hist.nothing")); return; }
  e.undo();
  history.redo.push(e);
  updateHistoryButtons();
  toast(t("mk.undone", { what: e.label }));
}

function redo() {
  const e = history.redo.pop();
  if (!e) return;
  e.redo();
  history.undo.push(e);
  updateHistoryButtons();
  toast(t("mk.redone", { what: e.label }));
}

function resetHistory() {
  history.undo = [];
  history.redo = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("#btnUndo").disabled = !history.undo.length;
  $("#btnRedo").disabled = !history.redo.length;
}

/** Undo support for translation changes: `before`/`after` map segment id -> text ("" = none). */
function recordTranslations(before, after, label) {
  const apply = (map) => {
    for (const [id, text] of Object.entries(map)) {
      if (text && text.trim()) state.translations[id] = text; else delete state.translations[id];
    }
    persist();
    refreshCards();
    refreshFind(); // (the search highlights follow the restored text)
  };
  pushHistory({ label, undo: () => apply(before), redo: () => apply(after) });
}

/* ---------------------------------------------------------------- storage */

function loadMarkups() {
  try { state.markups = isBook() ? [] : JSON.parse(localStorage.getItem(mkKey(state.doc.id)) || "[]"); } catch (_) { state.markups = []; }
  mk.seq = state.markups.reduce((n, m) => Math.max(n, m.id), 0) + 1;
  mk.selected = null;
}

function saveMarkups() {
  try { localStorage.setItem(mkKey(state.doc.id), JSON.stringify(state.markups)); } catch (_) { /* quota / private mode */ }
  state.outDirty = true;
  updateDownloadButton();
}

function updateDownloadButton() {
  const turned = !isBook() && Object.keys(state.rotations || {}).length > 0;
  $("#btnDownload").hidden = !(state.hasOutput || (state.markups && state.markups.length) || turned);
  $("#btnDownloadBi").hidden = !state.hasOutput;
  $("#btnPicPdf").hidden = !(state.doc && state.doc.image);
}

/** Replace all markups (used by undo/redo) and redraw. */
function setMarkups(list) {
  state.markups = clone(list);
  if (!state.markups.some((m) => m.id === mk.selected)) mk.selected = null;
  saveMarkups();
  renderAllMarkups();
}

/** Run `change` on the markups and make it undoable. */
function changeMarkups(change) {
  const before = clone(state.markups);
  change();
  const after = clone(state.markups);
  saveMarkups();
  renderAllMarkups();
  pushHistory({ label: t("hist.markup"), undo: () => setMarkups(before), redo: () => setMarkups(after) });
}

/* -------------------------------------------------------------- rendering */

function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function layerFor(i) {
  const pageEl = document.querySelector(`.page[data-page="${i}"]`);
  if (!pageEl) return null;
  let svg = pageEl.querySelector("svg.mk-layer");
  if (!svg) {
    const p = state.doc.pages[i];
    svg = svgEl("svg", { class: "mk-layer", viewBox: `${p.x0} ${p.y0} ${p.width} ${p.height}`, preserveAspectRatio: "none" });
    pageEl.querySelector(".page-body").appendChild(svg);
  }
  return svg;
}

const boxOfMarkup = (m) => {
  if (m.type === "ink") {
    const xs = m.points.map((p) => p[0]), ys = m.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (m.type === "text") return [m.x0, m.y0, m.x0 + m.w, m.y0 + m.h];
  return [Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.x0, m.x1), Math.max(m.y0, m.y1)];
};

function arrowHead(m) {
  const len = Math.max(6, m.width * 4), ang = Math.atan2(m.y1 - m.y0, m.x1 - m.x0);
  const p = (d) => `${m.x1 - len * Math.cos(ang + d)},${m.y1 - len * Math.sin(ang + d)}`;
  return `M${p(0.45)} L${m.x1},${m.y1} L${p(-0.45)}`;
}

function markupNode(m) {
  const g = svgEl("g", { class: `mk mk-${m.type}${mk.selected === m.id ? " sel" : ""}`, "data-mk": m.id });
  const [x0, y0, x1, y1] = boxOfMarkup(m);
  const w = x1 - x0, h = y1 - y0;
  const stroke = { stroke: m.color, "stroke-width": m.width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
  const hitStroke = { stroke: "transparent", "stroke-width": Math.max(8, m.width + 6), fill: "none", class: "hit" };
  if (m.type === "rect") {
    g.append(svgEl("rect", { x: x0, y: y0, width: w, height: h, ...hitStroke }), svgEl("rect", { x: x0, y: y0, width: w, height: h, ...stroke }));
  } else if (m.type === "ellipse") {
    const e = { cx: x0 + w / 2, cy: y0 + h / 2, rx: w / 2, ry: h / 2 };
    g.append(svgEl("ellipse", { ...e, ...hitStroke }), svgEl("ellipse", { ...e, ...stroke }));
  } else if (m.type === "highlight") {
    g.append(svgEl("rect", { x: x0, y: y0, width: w, height: h, fill: m.color, "fill-opacity": 0.4, class: "hl" }));
  } else if (m.type === "whiteout") {
    g.append(svgEl("rect", { x: x0, y: y0, width: w, height: h, fill: "#fff", class: "wo" }));
  } else if (m.type === "ink") {
    const pts = m.points.map((p) => p.join(",")).join(" ");
    g.append(svgEl("polyline", { points: pts, ...hitStroke }), svgEl("polyline", { points: pts, ...stroke }));
  } else if (m.type === "arrow") {
    const d = `M${m.x0},${m.y0} L${m.x1},${m.y1} ${arrowHead(m)}`;
    g.append(svgEl("path", { d, ...hitStroke }), svgEl("path", { d, ...stroke }));
  } else if (m.type === "text") {
    const pad = notePad(m);
    if (m.opacity != null && m.opacity < 1) g.setAttribute("opacity", m.opacity);
    const rr = noteRadius(m);
    g.append(svgEl("rect", { x: x0, y: y0, width: w, height: h, fill: m.bg || "transparent", class: "hit", ...(rr ? { rx: rr, ry: rr } : {}),
      ...(m.border ? { stroke: m.border, "stroke-width": m.bw || 1 } : {}) }));
    const text = svgEl("text", { x: m.x0 + pad, y: m.y0 + pad + m.size * 0.88, fill: m.color, "font-size": m.size, "font-family": NOTE_FONTS[m.font || "sans-serif"],
      ...(m.bold ? { "font-weight": "bold" } : {}), ...(m.italic ? { "font-style": "italic" } : {}) });
    m.text.split("\n").forEach((line, i) => {
      const ts = svgEl("tspan", { x: m.x0 + pad, dy: i ? m.size * 1.2 : 0 });
      ts.textContent = line || " ";
      text.append(ts);
    });
    g.append(text);
  }
  if (mk.selected === m.id) g.append(svgEl("rect", { x: x0 - 2, y: y0 - 2, width: w + 4, height: h + 4, class: "selbox" }));
  return g;
}

function renderMarkups(i, extra) {
  const svg = layerFor(i);
  if (!svg) return;
  svg.replaceChildren(...state.markups.filter((m) => m.page === i).map(markupNode), ...(extra ? [markupNode(extra)] : []));
  cmpMarkups(i);
  updateNoteBar();
}

function renderAllMarkups() {
  const pages = new Set(state.markups.map((m) => m.page));
  document.querySelectorAll(".page svg.mk-layer").forEach((s) => pages.add(Number(s.parentElement.dataset.page)));
  for (const i of pages) if (document.querySelector(`.page[data-page="${i}"]`)?.dataset.boxes) renderMarkups(i);
}

/* ------------------------------------------------------------ interaction */

function toPagePoint(svg, e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
}

function setTool(tool) {
  mk.tool = tool;
  document.querySelectorAll("#toolRail .tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  const pages = $("#pages");
  pages.classList.toggle("drawing", tool !== "select" && tool !== "eraser");
  pages.classList.toggle("erasing", tool === "eraser");
  pages.dataset.tool = tool;
  if (tool !== "select") select(null);
  updateSwatches();
  updateNoteBar();
}

const currentColor = () => (mk.tool === "highlight" ? mk.highlightColor : mk.color);

function updateSwatches() {
  const sel = state.markups && state.markups.find((m) => m.id === mk.selected);
  const color = sel ? sel.color : currentColor();
  const width = sel && sel.width ? sel.width : mk.width;
  document.querySelectorAll("#toolRail .swatch").forEach((b) => b.classList.toggle("active", b.dataset.color === color));
  document.querySelectorAll("#toolRail .width-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.width) === width));
}

function select(id) {
  if (mk.selected === id) { updateNoteBar(); return; }
  const pagesToRedraw = new Set();
  for (const m of state.markups || []) if (m.id === mk.selected || m.id === id) pagesToRedraw.add(m.page);
  mk.selected = id;
  for (const i of pagesToRedraw) renderMarkups(i);
  updateSwatches();
  updateNoteBar();
}

function deleteMarkup(id) {
  if (mk.selected === id) mk.selected = null;
  changeMarkups(() => { state.markups = state.markups.filter((m) => m.id !== id); });
}

function onPointerDown(e) {
  if (e.button !== 0 || !state.doc || isBook()) return; // markups are PDF annotations
  if (e.target.closest(".note-bar, .mk-editor")) return; // (their own controls)
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;
  const i = Number(pageEl.dataset.page);
  ensureBoxes(i);
  const svg = layerFor(i);
  const hit = e.target.closest(".mk");
  const id = hit ? Number(hit.dataset.mk) : null;
  const pt = toPagePoint(svg, e);

  if (mk.tool === "select") {
    if (!hit) { select(null); return; } // the click may still select a segment box below
    e.preventDefault();
    e.stopPropagation();
    select(id);
    mk.drag = { id, start: pt, orig: clone(state.markups.find((m) => m.id === id)), before: clone(state.markups), svg, page: i, moved: false };
    return;
  }
  if (mk.tool === "eraser") {
    if (hit) { e.preventDefault(); deleteMarkup(id); }
    return;
  }
  e.preventDefault();
  if (mk.tool === "text") {
    const note = hit && state.markups.find((m) => m.id === id && m.type === "text");
    if (note) { select(note.id); openTextEditor(note.page, [note.x0, note.y0], note); } else openTextEditor(i, pt);
    return;
  }
  const m = { id: mk.seq++, page: i, type: mk.tool, color: currentColor(), width: mk.width, x0: pt[0], y0: pt[1], x1: pt[0], y1: pt[1] };
  if (m.type === "ink") m.points = [pt];
  mk.draft = { m, svg, page: i };
}

function onPointerMove(e) {
  // (where the pointer is over a page: a pasted markup goes there)
  const over = e.target && e.target.closest && e.target.closest("#pages .page");
  if (over && !mk.draft && !mk.drag) {
    const i = Number(over.dataset.page), svg = layerFor(i);
    if (svg) mk.lastPoint = { page: i, pt: toPagePoint(svg, e) };
  }
  if (mk.draft) {
    const { m, svg, page } = mk.draft;
    const pt = toPagePoint(svg, e);
    if (m.type === "ink") {
      const last = m.points[m.points.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.8) m.points.push(pt);
    } else {
      m.x1 = pt[0];
      m.y1 = pt[1];
      if (e.shiftKey && BOX_TOOLS.has(m.type)) { // square / circle
        const s = Math.max(Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
        m.x1 = m.x0 + Math.sign(m.x1 - m.x0 || 1) * s;
        m.y1 = m.y0 + Math.sign(m.y1 - m.y0 || 1) * s;
      }
    }
    renderMarkups(page, m);
  } else if (mk.drag) {
    const d = mk.drag;
    const pt = toPagePoint(d.svg, e);
    const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < 1) return;
    d.moved = true;
    const m = state.markups.find((x) => x.id === d.id);
    const o = d.orig;
    if (m.type === "ink") m.points = o.points.map((p) => [p[0] + dx, p[1] + dy]);
    else { m.x0 = o.x0 + dx; m.y0 = o.y0 + dy; if ("x1" in o) { m.x1 = o.x1 + dx; m.y1 = o.y1 + dy; } }
    renderMarkups(d.page);
  }
}

function onPointerUp() {
  if (mk.draft) {
    const { m, page } = mk.draft;
    mk.draft = null;
    const [x0, y0, x1, y1] = boxOfMarkup(m);
    const big = m.type === "ink" ? m.points.length > 1 : m.type === "arrow" ? Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > 3 : x1 - x0 > 2 && y1 - y0 > 2;
    if (big) {
      if (m.type === "ink") m.points = simplify(m.points, 0.4);
      changeMarkups(() => { state.markups.push(m); });
    } else {
      renderMarkups(page);
    }
  } else if (mk.drag) {
    const d = mk.drag;
    mk.drag = null;
    if (d.moved) {
      const after = clone(state.markups);
      saveMarkups();
      pushHistory({ label: t("hist.markup"), undo: () => setMarkups(d.before), redo: () => setMarkups(after) });
    }
  }
}

/** Drop pen points that add almost nothing (Ramer–Douglas–Peucker). */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  let idx = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const d = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [a, b];
  return simplify(points.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(points.slice(idx), tol));
}

/* ------------------------------------------------------------ text notes */

// A note: text in a box with its own font (family, size, bold, italic), text colour, background
// and frame colours (or none) and opacity. The style of the last note changed is the start for the
// next one. A selected note gets a small bar above it with these settings.
const NOTE_FONTS = { "sans-serif": "Helvetica, Arial, sans-serif", serif: "'Times New Roman', Times, serif", monospace: "'Courier New', Courier, monospace" };
const NOTE_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96, 120, 144];
const NOTE_SIZE_MIN = 4, NOTE_SIZE_MAX = 400;
const NOTE_DEFAULT = { font: "sans-serif", size: 12, bold: false, italic: false, color: "#e53935", bg: "", border: "", bw: 1, opacity: 1, round: true };
const NOTE_STYLE_KEYS = Object.keys(NOTE_DEFAULT);
const LS_NOTE = "pdftr:notestyle";
const notePad = (m) => (m.pad != null ? m.pad : 2);
/** Padding of a note's text: grows with the font size, so large text keeps clear of the frame. */
const notePadFor = (size) => Math.max(3, Math.round(size * 0.2));
/** Corner radius of a note's box: rounded notes follow their font size (never more than half the box). */
const noteRadius = (m) => (m.round ? Math.min(m.w / 2, m.h / 2, Math.max(3, m.size * 0.45)) : 0);

function noteStyle() {
  if (!mk.noteStyle) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_NOTE) || "{}") || {}; } catch (_) { saved = {}; }
    mk.noteStyle = { ...NOTE_DEFAULT, ...saved };
  }
  return mk.noteStyle;
}
function rememberNoteStyle(m) {
  mk.noteStyle = Object.fromEntries(NOTE_STYLE_KEYS.map((k) => [k, m[k] != null ? m[k] : NOTE_DEFAULT[k]]));
  try { localStorage.setItem(LS_NOTE, JSON.stringify(mk.noteStyle)); } catch (_) { /* storage blocked */ }
}

let measureCtx = null;
/** Width and height of a note's box for its text and style. */
function measureNote(m) {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = `${m.italic ? "italic " : ""}${m.bold ? "bold " : ""}${m.size}px ${NOTE_FONTS[m.font || "sans-serif"]}`;
  const lines = m.text.split("\n"), pad = notePad(m);
  return { w: Math.max(...lines.map((l) => measureCtx.measureText(l).width)) + 2 * pad + 2 + m.size * 0.05, h: lines.length * m.size * 1.2 + 2 * pad };
}

function openTextEditor(i, pt, existing) {
  closeTextEditor(true);
  removeNoteBar();
  const pageEl = document.querySelector(`.page[data-page="${i}"] .page-body`); // (turned with the page)
  if (!pageEl) return;
  const p = state.doc.pages[i];
  const scale = pageEl.clientWidth / p.width;
  const style = existing || noteStyle();
  const ta = document.createElement("textarea");
  ta.className = "mk-editor";
  ta.placeholder = t("mk.textPlaceholder");
  ta.value = existing ? existing.text : "";
  Object.assign(ta.style, {
    left: `${((pt[0] - p.x0) / p.width) * 100}%`, top: `${((pt[1] - p.y0) / p.height) * 100}%`,
    fontSize: `${style.size * scale}px`, color: style.color, fontFamily: NOTE_FONTS[style.font || "sans-serif"],
    fontWeight: style.bold ? "bold" : "normal", fontStyle: style.italic ? "italic" : "normal",
    ...(style.bg ? { background: style.bg } : {}),
    ...(style.round ? { borderRadius: `${Math.max(3, style.size * 0.45) * scale}px` } : {}),
  });
  pageEl.appendChild(ta);
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
  grow();
  ta.addEventListener("input", grow);
  ta.focus();
  if (existing) ta.select();
  let closed = false; // removing the box fires "blur", which must not commit a second time
  const close = () => { if (closed) return false; closed = true; mk.editor = null; ta.remove(); updateNoteBar(); return true; };
  const commit = () => {
    const text = ta.value.replace(/\s+$/, "");
    if (!close()) return;
    if (existing) {
      if (text === existing.text) return;
      if (!text) { deleteMarkup(existing.id); return; }
      changeMarkups(() => { const m = state.markups.find((x) => x.id === existing.id); m.text = text; Object.assign(m, measureNote(m)); });
    } else if (text) {
      const m = { id: mk.seq++, page: i, type: "text", ...noteStyle(), width: mk.width, x0: pt[0], y0: pt[1], text };
      m.pad = notePadFor(m.size);
      Object.assign(m, measureNote(m));
      changeMarkups(() => { state.markups.push(m); });
      // The new note is selected, with its settings at hand; the next click selects again.
      setTool("select");
      select(m.id);
    }
  };
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); close(); if (mk.tool === "text") setTool("select"); }
  });
  ta.addEventListener("blur", commit);
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  mk.editor = { ta, commit, close };
}

function closeTextEditor(commit) {
  if (!mk.editor) return;
  if (commit) mk.editor.commit(); else mk.editor.close();
}

/* ---- the bar of a selected note */

function removeNoteBar() { document.querySelectorAll(".note-bar").forEach((b) => b.remove()); }

function noteBarHtml(m) {
  const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${label}</option>`;
  const fonts = [["sans-serif", t("note.sans")], ["serif", t("note.serif")], ["monospace", t("note.mono")]];
  const b = (n, label, title, on) => `<button type="button" data-n="${n}" class="${on ? "on" : ""}" title="${escapeHtml(t(title))}" aria-label="${escapeHtml(t(title))}">${label}</button>`;
  return `
    <select data-n="font" title="${escapeHtml(t("note.font"))}" aria-label="${escapeHtml(t("note.font"))}">${fonts.map(([v, l]) => opt(v, escapeHtml(l), m.font || "sans-serif")).join("")}</select>
    <input type="number" class="nb-size" data-n="size" list="noteSizes${m.id}" min="${NOTE_SIZE_MIN}" max="${NOTE_SIZE_MAX}" step="1" value="${m.size}" title="${escapeHtml(t("note.size"))}" aria-label="${escapeHtml(t("note.size"))}"><datalist id="noteSizes${m.id}">${NOTE_SIZES.map((v) => `<option value="${v}"></option>`).join("")}</datalist>
    ${b("smaller", "A−", "note.smaller")}${b("larger", "A+", "note.larger")}
    ${b("bold", "<b>B</b>", "note.bold", m.bold)}${b("italic", "<i>I</i>", "note.italic", m.italic)}
    <span class="nb-sep"></span>
    <label class="nb-color" title="${escapeHtml(t("note.color"))}"><span class="nb-a" style="--c:${m.color}">A</span><input type="color" data-n="color" value="${m.color}"></label>
    <label class="nb-color${m.bg ? "" : " off"}" title="${escapeHtml(t("note.bg"))}"><span class="nb-fill" style="--c:${m.bg || "#ffffff"}"></span><input type="color" data-n="bg" value="${m.bg || "#fff59d"}"></label>
    ${b("bgOff", "∅", "note.bgOff", !m.bg)}
    <label class="nb-color${m.border ? "" : " off"}" title="${escapeHtml(t("note.border"))}"><span class="nb-frame" style="--c:${m.border || "#888888"}"></span><input type="color" data-n="border" value="${m.border || "#1e66f5"}"></label>
    ${b("borderOff", "∅", "note.borderOff", !m.border)}
    ${b("round", m.round ? "▢" : "□", "note.round", m.round)}
    <label class="nb-op" title="${escapeHtml(t("note.opacity"))}">◐<input type="range" data-n="opacity" min="10" max="100" step="5" value="${Math.round((m.opacity != null ? m.opacity : 1) * 100)}"></label>
    <span class="nb-sep"></span>
    ${b("edit", "✎", "note.edit")}${b("copy", "⧉", "note.copy")}${b("dup", "⊕", "note.duplicate")}${b("del", "🗑", "note.delete")}`;
}

/** The bar above the selected note (or below it at the top of a page); none while editing. */
function updateNoteBar() {
  const m = state.markups && state.markups.find((x) => x.id === mk.selected);
  if (!m || m.type !== "text" || mk.tool !== "select" || mk.editor || isBook()) { removeNoteBar(); return; }
  const pageEl = document.querySelector(`.page[data-page="${m.page}"] .page-body`);
  if (!pageEl) { removeNoteBar(); return; }
  let bar = pageEl.querySelector(".note-bar");
  if (!bar || bar.dataset.mk !== String(m.id)) {
    removeNoteBar();
    bar = document.createElement("div");
    bar.className = "note-bar";
    bar.dataset.mk = m.id;
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => e.stopPropagation());
    bar.addEventListener("dblclick", (e) => e.stopPropagation());
    bar.addEventListener("input", noteBarInput);
    bar.addEventListener("change", noteBarChange);
    bar.addEventListener("click", noteBarClick);
    pageEl.appendChild(bar);
  }
  // Drawn anew when the note changed, except during a live change (a colour picker stays open).
  const sync = JSON.stringify(m);
  if (bar.dataset.sync !== sync && !noteBefore) {
    const focus = bar.contains(document.activeElement) ? document.activeElement.dataset.n : null;
    bar.innerHTML = noteBarHtml(m);
    bar.dataset.sync = sync;
    if (focus) bar.querySelector(`[data-n="${focus}"]`)?.focus();
  }
  const p = state.doc.pages[m.page];
  const top = (m.y0 - p.y0) / p.height, bottom = (m.y0 + m.h - p.y0) / p.height;
  bar.style.left = `${Math.max(0, ((m.x0 - p.x0) / p.width) * 100)}%`;
  bar.classList.toggle("below", top * pageEl.clientHeight < 48);
  bar.style.top = bar.classList.contains("below") ? `${bottom * 100}%` : `${top * 100}%`;
  // Kept within the visible part of the page view: moved left when it would stick out on the
  // right, its buttons wrapped onto a second row when the view is narrower than the bar.
  const view = (pageEl.closest("#pages") || pageEl).getBoundingClientRect();
  bar.style.maxWidth = `${Math.max(160, view.width - 12)}px`;
  bar.classList.toggle("wrap", bar.scrollWidth > view.width - 12);
  const r = bar.getBoundingClientRect(), over = r.right - (view.right - 6);
  if (over > 0) {
    const left = r.left - pageEl.getBoundingClientRect().left - over;
    bar.style.left = `${Math.max(view.left + 6 - pageEl.getBoundingClientRect().left, left)}px`;
  }
}

let noteBefore = null; // the markups before a run of live changes (a colour being picked, the opacity slider)
function noteChange(patch, live) {
  const m = state.markups.find((x) => x.id === mk.selected);
  if (!m) return;
  if (!noteBefore) noteBefore = clone(state.markups);
  const before = noteBefore;
  Object.assign(m, patch);
  if (patch.size) m.pad = notePadFor(m.size);
  Object.assign(m, measureNote(m));
  if (!live) noteBefore = null;
  renderMarkups(m.page);
  if (live) return;
  const after = clone(state.markups);
  saveMarkups();
  rememberNoteStyle(m);
  pushHistory({ label: t("hist.markup"), undo: () => setMarkups(before), redo: () => setMarkups(after) });
}
const notePatch = (el) => {
  const n = el.dataset.n, v = el.value;
  if (n === "font") return { font: v };
  if (n === "size") { const z = Math.round(Number(v)); return z ? { size: Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, z)) } : null; }
  if (n === "color" || n === "bg" || n === "border") return { [n]: v };
  if (n === "opacity") return { opacity: Number(v) / 100 };
  return null;
};
function noteBarInput(e) {
  const patch = notePatch(e.target);
  if (!patch || (e.target.type !== "color" && e.target.type !== "range")) return;
  const swatch = e.target.parentElement.querySelector("span");
  if (swatch && e.target.type === "color") { swatch.style.setProperty("--c", e.target.value); e.target.parentElement.classList.remove("off"); }
  noteChange(patch, true);
}
function noteBarChange(e) {
  const patch = notePatch(e.target);
  if (patch) noteChange(patch, false);
}
/** The next font size up or down the list (A+ / A−). */
function noteStep(size, dir) {
  if (dir > 0) return NOTE_SIZES.find((v) => v > size) || Math.min(NOTE_SIZE_MAX, Math.round(size * 1.25));
  return [...NOTE_SIZES].reverse().find((v) => v < size) || Math.max(NOTE_SIZE_MIN, size - 1);
}
function noteBarClick(e) {
  const b = e.target.closest("button[data-n]");
  if (!b) return;
  const m = state.markups.find((x) => x.id === mk.selected);
  if (!m) return;
  const n = b.dataset.n;
  if (n === "bold") noteChange({ bold: !m.bold });
  else if (n === "italic") noteChange({ italic: !m.italic });
  else if (n === "smaller" || n === "larger") noteChange({ size: noteStep(m.size, n === "larger" ? 1 : -1) });
  else if (n === "round") noteChange({ round: !m.round });
  else if (n === "bgOff") noteChange({ bg: "" });
  else if (n === "borderOff") noteChange({ border: "" });
  else if (n === "edit") openTextEditor(m.page, [m.x0, m.y0], m);
  else if (n === "copy") { copyMarkup(m); toast(t("note.copied")); }
  else if (n === "dup") pasteMarkups([m], { page: m.page, pt: [m.x0 + 12, m.y0 + 12] });
  else if (n === "del") deleteMarkup(m.id);
}

/* ---- copy and paste (any markup; plain text pasted becomes a note) */

const MK_MIME = "application/x-kameleon-markup";

function copyMarkup(m, data) {
  mk.clip = clone(m);
  mk.pasted = 0;
  const text = m.type === "text" ? m.text : "";
  if (data) { data.setData("text/plain", text); data.setData(MK_MIME, JSON.stringify(m)); return; }
  navigator.clipboard?.writeText(text).catch(() => {}); // (the markup itself is kept here)
}

/** Places copies of `list` (one markup) at `at` ({page, pt}: its top left corner there). */
function pasteMarkups(list, at) {
  if (!list.length || !state.doc) return;
  const added = [];
  changeMarkups(() => {
    for (const src of list) {
      const m = clone(src);
      m.id = mk.seq++;
      const [bx, by] = boxOfMarkup(m);
      const dx = at.pt[0] - bx, dy = at.pt[1] - by;
      m.page = at.page;
      if (m.points) m.points = m.points.map((p) => [p[0] + dx, p[1] + dy]);
      m.x0 += dx; m.y0 += dy;
      if ("x1" in m) { m.x1 += dx; m.y1 += dy; }
      state.markups.push(m);
      added.push(m);
    }
  });
  if (mk.tool !== "select") setTool("select");
  select(added[added.length - 1].id);
}

/** Where a paste goes: where the pointer was over a page, else near the top left of the page in view. */
function pastePoint() {
  mk.pasted = (mk.pasted || 0) + 1;
  const off = 12 * (mk.pasted - 1);
  if (mk.lastPoint && pageElements()[mk.lastPoint.page]) return { page: mk.lastPoint.page, pt: [mk.lastPoint.pt[0] + off, mk.lastPoint.pt[1] + off] };
  const i = currentPageIndex(), p = state.doc.pages[i];
  return { page: i, pt: [p.x0 + p.width * 0.1 + off, p.y0 + p.height * 0.1 + off] };
}

function onCopy(e, cut) {
  if (!state.doc || isTyping(e) || mk.selected === null) return;
  const m = state.markups.find((x) => x.id === mk.selected);
  if (!m) return;
  e.preventDefault();
  copyMarkup(m, e.clipboardData);
  if (cut) deleteMarkup(m.id);
  toast(t(cut ? "note.cut" : "note.copied"));
}

function onPaste(e) {
  if (!state.doc || isBook() || isTyping(e)) return;
  const data = e.clipboardData, raw = data && data.getData(MK_MIME), text = data ? data.getData("text/plain") : "";
  let m = null;
  try { m = raw ? JSON.parse(raw) : null; } catch (_) { m = null; }
  if (!m && mk.clip && (text === "" || (mk.clip.type === "text" && text === mk.clip.text))) m = mk.clip;
  if (m && m.type) { e.preventDefault(); pasteMarkups([m], pastePoint()); return; }
  if (text && text.trim()) { // plain text: a new note with the current note style
    e.preventDefault();
    const at = pastePoint();
    const n = { id: 0, page: at.page, type: "text", ...noteStyle(), width: mk.width, x0: at.pt[0], y0: at.pt[1], text: text.replace(/\r\n?/g, "\n").replace(/\s+$/, "") };
    n.pad = notePadFor(n.size);
    Object.assign(n, measureNote(n));
    pasteMarkups([n], at);
  }
}

/* -------------------------------------------------------- page navigation */

function pageElements() { return [...document.querySelectorAll("#pages .page")]; }

/** Index of the page at the upper third of the viewer. */
function currentPageIndex() {
  const box = $("#pages");
  const y = box.scrollTop + box.clientHeight * 0.33;
  const els = pageElements();
  let lo = 0, hi = els.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (els[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function updatePageNav() {
  if (!state.doc) return;
  const n = viewPages().length, i = currentPageIndex();
  if (document.activeElement !== $("#pageInput")) $("#pageInput").value = i + 1;
  $("#pageInput").max = n;
  $("#pageCount").textContent = `/ ${n}`;
  $("#pagePrev").disabled = i <= 0;
  $("#pageNext").disabled = i >= n - 1;
}

function goToPage(i) {
  if (!state.doc) return;
  i = Math.max(0, Math.min(viewPages().length - 1, i));
  const el = pageElements()[i];
  if (el) $("#pages").scrollTop = el.offsetTop - 22;
  updatePageNav();
}

/* ------------------------------------------------------------ full screen */

/** Show only the PDF view, in browser full screen when allowed. */
async function toggleFullscreen(force) {
  const on = force !== undefined ? force : !document.body.classList.contains("viewer-only");
  document.body.classList.toggle("viewer-only", on);
  $("#btnFullscreen").title = t(on ? "view.exitFullscreen" : "view.fullscreen");
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch (_) { /* full screen not allowed (e.g. in a frame): the view-only layout still applies */ }
  requestAnimationFrame(() => { refreshImages(); updatePageNav(); });
}

/* ------------------------------------------------------------ keyboard */

function isTyping(e) {
  const tag = e.target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable || document.querySelector("dialog[open]") || !$("#busy").hidden;
}

function onKeyDown(e) {
  if (!state.doc || isTyping(e)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === "d" && mk.selected !== null) { // duplicate the selected markup
      e.preventDefault();
      const m = state.markups.find((x) => x.id === mk.selected);
      if (m) { const [bx, by] = boxOfMarkup(m); pasteMarkups([m], { page: m.page, pt: [bx + 12, by + 12] }); }
    }
    return;
  }
  if (mk.selected !== null && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)) { // nudge it
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1, dx = k === "arrowleft" ? -d : k === "arrowright" ? d : 0, dy = k === "arrowup" ? -d : k === "arrowdown" ? d : 0;
    changeMarkups(() => {
      const m = state.markups.find((x) => x.id === mk.selected);
      if (m.points) m.points = m.points.map((p) => [p[0] + dx, p[1] + dy]);
      m.x0 += dx; m.y0 += dy;
      if ("x1" in m) { m.x1 += dx; m.y1 += dy; }
    });
    return;
  }
  if (e.altKey) return;
  if (k === "pagedown") { e.preventDefault(); goToPage(currentPageIndex() + 1); }
  else if (k === "pageup") { e.preventDefault(); goToPage(currentPageIndex() - 1); }
  else if (k === "home") { e.preventDefault(); goToPage(0); }
  else if (k === "end") { e.preventDefault(); goToPage(viewPages().length - 1); }
  else if ((k === "delete" || k === "backspace") && mk.selected !== null) { e.preventDefault(); deleteMarkup(mk.selected); }
  else if (k === "escape") {
    if (mk.draft) { const p = mk.draft.page; mk.draft = null; renderMarkups(p); }
    setTool("select"); select(null); clearActive();
    // (Esc leaves the view-only layout also when the browser refused full screen)
    if (document.body.classList.contains("viewer-only") && !document.fullscreenElement) toggleFullscreen(false);
  }
  else if (k === "f" && !e.shiftKey) toggleFullscreen();
  else if (TOOL_KEYS[k] && !e.shiftKey && !isBook()) setTool(TOOL_KEYS[k]); // no markups on e-books
}

/* ------------------------------------------------------------------ setup */

/** Called when a document is opened. */
function initMarkupsForDocument() {
  loadMarkups();
  resetHistory();
  setTool("select");
  updateDownloadButton();
  requestAnimationFrame(updatePageNav);
}

function initMarkup() {
  const pages = $("#pages");
  pages.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  pages.addEventListener("dblclick", (e) => {
    const hit = e.target.closest(".mk-text");
    if (!hit || mk.tool !== "select") return;
    const m = state.markups.find((x) => x.id === Number(hit.dataset.mk));
    if (m) openTextEditor(m.page, [m.x0, m.y0], m);
  });
  // A click that selected or drew a markup must not also select the segment box below it.
  pages.addEventListener("click", (e) => { if (mk.tool !== "select" || e.target.closest(".mk")) e.stopPropagation(); }, true);

  document.querySelectorAll("#toolRail .tool[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("#toolRail .swatch").forEach((b) => b.addEventListener("click", () => {
    const color = b.dataset.color;
    const sel = state.markups.find((m) => m.id === mk.selected);
    if (sel && sel.type !== "whiteout") {
      changeMarkups(() => { state.markups.find((m) => m.id === sel.id).color = color; });
      if (sel.type === "text") rememberNoteStyle(state.markups.find((m) => m.id === sel.id));
    } else if (mk.tool === "text") { noteStyle().color = color; rememberNoteStyle(noteStyle()); mk.color = color; }
    else if (mk.tool === "highlight") mk.highlightColor = color;
    else mk.color = color;
    updateSwatches();
  }));
  document.querySelectorAll("#toolRail .width-btn").forEach((b) => b.addEventListener("click", () => {
    const width = Number(b.dataset.width);
    mk.width = width;
    const sel = state.markups.find((m) => m.id === mk.selected);
    if (sel) {
      changeMarkups(() => {
        const m = state.markups.find((x) => x.id === sel.id);
        m.width = width;
        if (m.type === "text") m.bw = width; // (for a note: the frame's width)
      });
    }
    updateSwatches();
  }));
  $("#btnUndo").addEventListener("click", undo);
  $("#btnRedo").addEventListener("click", redo);
  $("#btnClearMarkups").addEventListener("click", () => {
    if (!state.doc || !state.markups.length) { toast(t("mk.none")); return; }
    if (!confirm(t("mk.clearConfirm", { n: state.markups.length }))) return;
    changeMarkups(() => { state.markups = []; });
    mk.selected = null;
  });

  $("#pagePrev").addEventListener("click", () => goToPage(currentPageIndex() - 1));
  $("#pageNext").addEventListener("click", () => goToPage(currentPageIndex() + 1));
  $("#pageInput").addEventListener("change", (e) => goToPage(Number(e.target.value) - 1));
  $("#pageInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { goToPage(Number(e.target.value) - 1); e.target.blur(); } });
  let raf = 0;
  pages.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; updatePageNav(); }); }, { passive: true });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("copy", (e) => onCopy(e, false));
  document.addEventListener("cut", (e) => onCopy(e, true));
  document.addEventListener("paste", onPaste);
  $("#btnFullscreen").addEventListener("click", () => toggleFullscreen());
  // Leaving browser full screen (Esc) also leaves the PDF-only view.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("viewer-only")) toggleFullscreen(false);
  });
}
