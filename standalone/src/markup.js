// ======================================================================
// Markup tools (rectangle, ellipse, highlighter, pen, arrow, text note, whiteout, eraser),
// page navigation, and undo/redo. Markups live in page coordinates (the same space as the
// segment boxes), are drawn on an SVG layer over each page, stored per document in
// localStorage, and written into the PDF as standard annotations when it is downloaded.
// ======================================================================
const SVGNS = "http://www.w3.org/2000/svg";
const TOOL_KEYS = { v: "select", r: "rect", o: "ellipse", h: "highlight", p: "ink", a: "arrow", t: "text", w: "whiteout", e: "eraser" };
const BOX_TOOLS = new Set(["rect", "ellipse", "highlight", "whiteout"]);
const TEXT_SIZES = { 1: 9, 2: 12, 4: 16 };

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
    g.append(svgEl("rect", { x: x0, y: y0, width: w, height: h, fill: "transparent", class: "hit" }));
    const text = svgEl("text", { x: m.x0 + 2, y: m.y0 + 2 + m.size * 0.88, fill: m.color, "font-size": m.size, "font-family": "Helvetica, Arial, sans-serif" });
    m.text.split("\n").forEach((line, i) => {
      const ts = svgEl("tspan", { x: m.x0 + 2, dy: i ? m.size * 1.2 : 0 });
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
  if (mk.selected === id) return;
  const pagesToRedraw = new Set();
  for (const m of state.markups || []) if (m.id === mk.selected || m.id === id) pagesToRedraw.add(m.page);
  mk.selected = id;
  for (const i of pagesToRedraw) renderMarkups(i);
  updateSwatches();
}

function deleteMarkup(id) {
  changeMarkups(() => { state.markups = state.markups.filter((m) => m.id !== id); });
  if (mk.selected === id) mk.selected = null;
}

function onPointerDown(e) {
  if (e.button !== 0 || !state.doc || isBook()) return; // markups are PDF annotations
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
  if (mk.tool === "text") { openTextEditor(i, pt); return; }
  const m = { id: mk.seq++, page: i, type: mk.tool, color: currentColor(), width: mk.width, x0: pt[0], y0: pt[1], x1: pt[0], y1: pt[1] };
  if (m.type === "ink") m.points = [pt];
  mk.draft = { m, svg, page: i };
}

function onPointerMove(e) {
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

let measureCtx = null;
function measureText(text, size) {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  const lines = text.split("\n");
  return { w: Math.max(...lines.map((l) => measureCtx.measureText(l).width)) + 6, h: lines.length * size * 1.2 + 4 };
}

function openTextEditor(i, pt, existing) {
  closeTextEditor(true);
  const pageEl = document.querySelector(`.page[data-page="${i}"] .page-body`); // (turned with the page)
  const p = state.doc.pages[i];
  const scale = pageEl.clientWidth / p.width;
  const size = existing ? existing.size : TEXT_SIZES[mk.width] || 12;
  const color = existing ? existing.color : mk.color;
  const ta = document.createElement("textarea");
  ta.className = "mk-editor";
  ta.placeholder = t("mk.textPlaceholder");
  ta.value = existing ? existing.text : "";
  Object.assign(ta.style, {
    left: `${((pt[0] - p.x0) / p.width) * 100}%`, top: `${((pt[1] - p.y0) / p.height) * 100}%`,
    fontSize: `${size * scale}px`, color,
  });
  pageEl.appendChild(ta);
  ta.focus();
  let closed = false; // removing the box fires "blur", which must not commit a second time
  const close = () => { if (closed) return false; closed = true; mk.editor = null; ta.remove(); return true; };
  const commit = () => {
    const text = ta.value.replace(/\s+$/, "");
    if (!close()) return;
    if (existing) {
      if (text === existing.text) return;
      if (!text) { deleteMarkup(existing.id); return; }
      changeMarkups(() => { const m = state.markups.find((x) => x.id === existing.id); Object.assign(m, { text }, measureText(text, m.size)); });
    } else if (text) {
      changeMarkups(() => { state.markups.push({ id: mk.seq++, page: i, type: "text", color, size, width: mk.width, x0: pt[0], y0: pt[1], text, ...measureText(text, size) }); });
    }
  };
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === "Escape") close();
  });
  ta.addEventListener("blur", commit);
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  mk.editor = { ta, commit, close };
}

function closeTextEditor(commit) {
  if (!mk.editor) return;
  if (commit) mk.editor.commit(); else mk.editor.close();
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
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable || document.querySelector("dialog[open]");
}

function onKeyDown(e) {
  if (!state.doc || isTyping(e)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    return;
  }
  if (e.altKey) return;
  if (k === "pagedown") { e.preventDefault(); goToPage(currentPageIndex() + 1); }
  else if (k === "pageup") { e.preventDefault(); goToPage(currentPageIndex() - 1); }
  else if (k === "home") { e.preventDefault(); goToPage(0); }
  else if (k === "end") { e.preventDefault(); goToPage(viewPages().length - 1); }
  else if ((k === "delete" || k === "backspace") && mk.selected !== null) { e.preventDefault(); deleteMarkup(mk.selected); }
  else if (k === "escape") { if (mk.draft) { const p = mk.draft.page; mk.draft = null; renderMarkups(p); } setTool("select"); select(null); clearActive(); }
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
    if (sel && sel.type !== "whiteout") changeMarkups(() => { state.markups.find((m) => m.id === sel.id).color = color; });
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
        if (m.type === "text") { m.size = TEXT_SIZES[width]; Object.assign(m, measureText(m.text, m.size)); }
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
  $("#btnFullscreen").addEventListener("click", () => toggleFullscreen());
  // Leaving browser full screen (Esc) also leaves the PDF-only view.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("viewer-only")) toggleFullscreen(false);
  });
}
