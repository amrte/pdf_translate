// ======================================================================
// User interface. The PDF engine runs in a pool of Web Workers so the page stays responsive;
// the segment list is virtualised so documents with thousands of segments stay fast.
// ======================================================================
const ENGINE_SRC = document.getElementById("engine-src").textContent;
const { Engine, createHandler } = await import(URL.createObjectURL(new Blob(
  [ENGINE_SRC, "\nexport { Engine, createHandler };\n"], { type: "text/javascript" })));
// Workers are classic scripts (module workers are refused on file:// pages); the engine
// loads MuPDF with a dynamic import(), which classic workers support.
const WORKER_URL = URL.createObjectURL(new Blob([ENGINE_SRC], { type: "text/javascript" }));

const $ = (sel) => document.querySelector(sel);
const LS_LAST = "pdftr:last";
const lsKey = (id) => `pdftr:tr:${id}`;
const GAP = 10; // px between segment cards

const state = {
  doc: null,          // {id, name, pages, segments}
  srcBytes: null,     // original PDF
  outBytes: null,     // translated PDF (saved copy; may lag behind single-field updates)
  hasOutput: false,   // worker 0 holds an editable translated PDF
  outDirty: false,    // the editable PDF changed since outBytes was saved
  applied: {},        // id -> translation currently in the translated PDF
  pageVersion: new Map(), // page -> number of single-field updates (for preview caching)
  buildNo: 0,
  translations: {},
  variant: "original",
  zoom: 1,
  activeId: null,
  customFont: null,   // {name, bytes}
  shrunk: new Set(),
  markups: [],        // drawings on the pages (see markup.js)
  outView: null,      // e-books: {pages, boxes} of the laid-out translated book
  overrides: {},      // id -> the user's box, size, font, colour for that field (see tools.js)
  rotations: {},      // page -> degrees the user turned it (PDFs; applied when saving)
};

/** The open document is an e-book (EPUB/FB2) rather than a PDF. */
const isBook = () => Boolean(state.doc && state.doc.kind && state.doc.kind !== "pdf");
const FORMAT_LABEL = { pdf: "PDF", epub: "EPUB", fb2: "FB2" };
/** Pages shown in the viewer: the translated e-book has its own page count. */
const viewPages = () => (state.variant === "translated" && state.outView ? state.outView.pages : state.doc.pages);

/* --------------------------------------------------------------- workers */

class LocalWorker { // fallback when module workers are unavailable: same protocol, in the page
  constructor() { this.handle = createHandler(); this.load = 0; }
  async call(cmd, args, transfer, onProgress) {
    this.load++;
    try { return (await this.handle(cmd, args, onProgress)).result; } finally { this.load--; }
  }
}

class RemoteWorker {
  constructor(url) {
    this.w = new Worker(url, { name: "pdf-engine" });
    this.pending = new Map();
    this.seq = 0;
    this.load = 0;
    this.w.onmessage = (e) => {
      const { id, result, error, progress } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) { if (p.onProgress) p.onProgress(...progress); return; }
      this.pending.delete(id);
      this.load--;
      if (error) p.reject(new Error(error)); else p.resolve(result);
    };
    this.w.onerror = (e) => {
      e.preventDefault();
      const err = new Error(e.message || "The PDF engine worker failed to start.");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.load = 0;
      this.dead = true;
    };
  }
  call(cmd, args = {}, transfer = [], onProgress = null) {
    if (this.dead) return Promise.reject(new Error("The PDF engine worker stopped."));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, onProgress });
      this.load++;
      this.w.postMessage({ id, cmd, args }, transfer);
    });
  }
  terminate() { this.w.terminate(); }
}

const pool = {
  workers: [],
  local: false,
  ready: null,
  maxSize: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
  spawn() {
    let w;
    if (!this.local) {
      try { w = new RemoteWorker(WORKER_URL); } catch (_) { this.local = true; }
    }
    if (this.local) w = new LocalWorker();
    w.ready = w.call("init");
    this.workers.push(w);
    return w;
  },
  /** Start the first worker; fall back to the page itself if module workers fail. */
  start() {
    if (!this.ready) {
      const first = this.spawn();
      this.ready = first.ready.catch(async (err) => {
        if (this.local) throw err;
        console.warn("Worker failed, running the engine in the page instead:", err);
        first.terminate && first.terminate();
        this.workers = [];
        this.local = true;
        this.maxSize = 1;
        const w = this.spawn();
        await w.ready;
      }).catch((err) => {
        this.ready = null;
        throw new Error(t("msg.engineFailed") + " " + (err.message || ""));
      });
    }
    return this.ready;
  },
  async ensure(n) {
    await this.start();
    n = Math.min(n, this.local ? 1 : this.maxSize);
    while (this.workers.length < n) this.spawn();
    const results = await Promise.allSettled(this.workers.map((w) => w.ready));
    this.workers = this.workers.filter((w, i) => results[i].status === "fulfilled");
    if (!this.workers.length) throw new Error("The PDF engine could not start.");
  },
  leastBusy(exclude) {
    const list = this.workers.filter((w) => w !== exclude);
    return (list.length ? list : this.workers).reduce((a, b) => (b.load < a.load ? b : a));
  },
  all(cmd, argsFn) { return Promise.all(this.workers.map((w) => w.call(cmd, argsFn ? argsFn() : {}))); },
};

/* ------------------------------------------------------------------ utils */

/** Show a message; `action` ({label, run}) adds a button such as "Undo". */
function toast(message, kind = "", action = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (action) {
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "toast-action", textContent: action.label });
    btn.addEventListener("click", () => { el.remove(); action.run(); });
    el.appendChild(btn);
  }
  $("#toasts").appendChild(el);
  while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
  setTimeout(() => el.remove(), action ? 12000 : kind === "error" ? 8000 : 4500);
}

/** Show a busy overlay with `text` (hidden when empty); `onCancel` adds a Cancel button. */
function busy(text, onCancel = null) {
  $("#busyText").textContent = text || "";
  $("#busy").hidden = !text;
  $("#busyCancel").hidden = !onCancel;
  $("#busyCancel").onclick = onCancel;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stem = () => (state.doc.name || "document.pdf").replace(/\.(pdf|epub|fb2|fbz|fb2\.zip|zip)$/i, "") || "document";
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(lsKey(state.doc.id), JSON.stringify(state.translations)); } catch (_) { /* quota / private mode */ }
  }, 400);
}

const hasTr = (id) => Boolean((state.translations[id] || "").trim());

/* ------------------------------------------- IndexedDB: remember the last PDF */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pdf-translate", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value) {
  try {
    const db = await idb();
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(value, "last");
    await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
  } catch (_) { /* storage unavailable: the session simply won't be restored */ }
}

async function idbGet() {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction("files").objectStore("files").get("last");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}

/* ------------------------------------------------------------- loading */

async function openPdf(file) {
  if (!file) return;
  if (!/\.(pdf|epub|fb2|fbz|zip)$/i.test(file.name) && !/pdf|epub|fictionbook/i.test(file.type)) {
    toast(t("msg.chooseFile"), "error");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadBytes(bytes, file.name, true);
  $("#fileInput").value = "";
}

function setLoading(text) {
  $("#uploadProgress").hidden = !text;
  $("#uploadProgressText").textContent = text || "";
  if (state.doc && text) busy(text); else if (!text) busy("");
}

/** Extract all pages, spreading chunks of pages over the worker pool. */
async function extractAll(pageCount, onProgress) {
  const size = Math.max(2, Math.min(12, Math.ceil(pageCount / (pool.workers.length * 6))));
  const chunks = [];
  for (let p = 0; p < pageCount; p += size) chunks.push(Array.from({ length: Math.min(size, pageCount - p) }, (_, i) => p + i));
  const pages = new Array(pageCount), raw = [];
  let done = 0;
  await Promise.all(pool.workers.map(async (w) => {
    while (chunks.length) {
      const chunk = chunks.shift();
      const r = await w.call("extract", { pages: chunk }, [], () => onProgress(++done, pageCount));
      for (const [p, info] of Object.entries(r.pages)) pages[p] = info;
      raw.push(...r.segments);
    }
  }));
  raw.sort((a, b) => a.page - b.page || a.id - b.id);
  raw.forEach((s, i) => { s.id = i + 1; });
  return { pages, segments: raw };
}

async function loadBytes(bytes, name, remember, knownId = null) {
  setLoading(t("msg.loadingEngine"));
  try {
    await pool.start();
    // (an unlocked PDF keeps the id of the protected file, so its translations are found again)
    const id = knownId || await sha256(bytes);
    const kind = Engine.detectKind(bytes, name);
    if (kind === "pdf") {
      // Password protection is removed: restrictions at once, an open password after asking.
      let password = "";
      for (;;) {
        const u = await pool.workers[0].call("unlock", { bytes, password });
        if (u.status === "plain") break;
        if (u.status === "unlocked") { bytes = u.bytes; toast(t("msg.unlocked"), "ok"); break; }
        setLoading("");
        password = await askPassword(name, u.status === "wrong");
        if (password === null) return;
        setLoading(t("msg.opening"));
      }
    }
    // More workers for bigger documents, fewer for huge files (each worker holds a copy).
    // An e-book is read in one worker; the others only draw its pages.
    const mb = bytes.length / 1048576;
    await pool.ensure(kind !== "pdf" ? 2 : mb > 150 ? 1 : mb > 60 ? 2 : pool.maxSize);
    setLoading(t("msg.opening"));
    const counts = await pool.all("open", () => ({ bytes, kind }));
    const pageCount = counts[0];
    const started = performance.now();
    const { pages, segments } = kind === "pdf"
      ? await extractAll(pageCount, (i, n) => setLoading(t("msg.extracting", { i, n })))
      : (setLoading(t("msg.readingBook")), await pool.workers[0].call("extractBook"));
    console.info(`Extracted ${segments.length} segments from ${pageCount} pages in ${Math.round(performance.now() - started)} ms using ${pool.workers.length} worker(s)`);
    if (remember) idbPut({ name, bytes, id });
    const restored = kind === "pdf" ? await restoreOcr(id, segments, pages) : { segments, ocr: null };
    openDocument({ id, name, kind, pages, segments: restored.segments, ocr: restored.ocr }, bytes);
    suggestOcr();
  } catch (err) {
    console.error(err);
    toast(/password/i.test(err.message) ? t("msg.password") : t("msg.openFailed", { err: err.message || err }), "error");
  } finally {
    setLoading("");
  }
}

function disposeOutput() {
  state.outBytes = null;
  state.hasOutput = false;
  state.outDirty = false;
  state.applied = {};
  state.pageVersion = new Map();
  state.outView = null;
}

function openDocument(doc, bytes) {
  disposeOutput();
  state.doc = doc;
  state.srcBytes = bytes;
  state.variant = "original";
  state.activeId = null;
  state.shrunk = new Set();
  segIndex.clear();
  for (const s of doc.segments) segIndex.set(s.id, s);
  try {
    state.translations = JSON.parse(localStorage.getItem(lsKey(doc.id)) || "{}");
    localStorage.setItem(LS_LAST, doc.id);
  } catch (_) {
    state.translations = {};
  }
  $("#uploadView").hidden = true;
  $("#workView").hidden = false;
  $("#btnNew").hidden = false;
  $("#docName").textContent = doc.name;
  $("#docName").title = doc.name;
  document.body.classList.toggle("is-book", isBook());
  setDocFormat(FORMAT_LABEL[doc.kind || "pdf"]);
  document.title = `${doc.name} · PDF Translate`;

  loadOverrides();
  loadRotations();
  fillPageFilter();
  $("#search").value = "";
  $("#filterStatus").value = "all";

  state.zoom = fitZoom();
  initMarkupsForDocument();
  renderPages();
  vl.reset();
  applyFilter();
  setBuilt(false);
  setVariant("original");
  updateProgress();
  const unknown = doc.segments.reduce((n, s) => n + (s.text.match(/\ufffd/g) || []).length, 0);
  if (unknown) toast(t("msg.unknownChars", { n: unknown }), "error");
  if (!doc.segments.length && (isBook() || !scannedPages().length)) { // (scans: OCR is offered instead)
    toast(t("msg.noText"), "error");
  }
}

function fillPageFilter() {
  const sel = $("#filterPage"), cur = sel.value;
  sel.innerHTML = `<option value="all">${t("filter.allPages")}</option>` +
    state.doc.pages.map((_, i) => `<option value="${i}">${t("page.n", { n: i + 1 })}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
}

/**
 * Default languages follow the interface: German interface -> translate into German (from
 * English), English interface -> into English (from German). Fields the user typed in are kept.
 */
function applyLanguageDefaults() {
  for (const [sel, key] of [["#tgtLang", "default.targetCode"], ["#aiTarget", "default.targetName"]]) {
    const el = $(sel);
    if (!el.dataset.userSet) el.value = t(key);
  }
}

/** Rebuild the visible cards and page outlines after translations changed in bulk. */
function refreshCards() {
  for (const [, el] of vl.rendered) { el.remove(); ro.unobserve(el); }
  vl.rendered.clear();
  vl.heights.clear();
  vl.dirty = true;
  applyFilter();
  document.querySelectorAll(".box").forEach((b) => b.classList.toggle("done", hasTr(b.dataset.id)));
  updateProgress();
}

/** Remove every translation (after confirmation) and discard the translated PDF; undoable. */
async function clearAllTranslations() {
  if (!state.doc) return;
  const n = Object.keys(state.translations).filter((id) => hasTr(id)).length;
  if (!n) { toast(t("clear.none")); return; }
  if (!confirm(t("clear.confirm", { n }))) return;
  const backup = { ...state.translations };
  const docId = state.doc.id;
  state.translations = {};
  persist();
  disposeOutput();
  state.shrunk = new Set();
  state.buildNo++;
  pool.workers[0]?.call("resetOutput").catch(() => {});
  setBuilt(false);
  if (state.variant === "translated") setVariant("original");
  refreshCards();
  recordTranslations(backup, Object.fromEntries(Object.keys(backup).map((id) => [id, ""])), t("hist.clear"));
  toast(t("clear.done", { n }), "ok", {
    label: t("common.undo"),
    run: () => {
      if (!state.doc || state.doc.id !== docId) return;
      state.translations = { ...backup, ...state.translations };
      persist();
      refreshCards();
      toast(t("clear.restored", { n }), "ok");
    },
  });
}

/** Re-render everything that was built from translated strings. */
function onLanguageChange() {
  applyLanguageDefaults();
  updateProgress();
  if (!state.doc) return;
  fillPageFilter();
  document.querySelectorAll(".page").forEach((el) => { el.querySelector(".page-label").textContent = t("page.n", { n: Number(el.dataset.page) + 1 }); });
  for (const [, el] of vl.rendered) { el.remove(); ro.unobserve(el); }
  vl.rendered.clear();
  applyFilter();
  if ($("#helpDialog").open) refreshAiPrompt();
}

function closeDocument() {
  closeFind();
  disposeOutput();
  state.doc = null;
  try { localStorage.removeItem(LS_LAST); } catch (_) { /* ignore */ }
  pool.all("close").catch(() => {});
  observer.disconnect();
  clearImageCache();
  $("#pages").innerHTML = "";
  vl.reset();
  $("#workView").hidden = true;
  $("#uploadView").hidden = false;
  $("#btnNew").hidden = true;
  $("#docName").textContent = "";
  document.title = "PDF Translate";
  document.body.classList.remove("is-book");
  setDocFormat("PDF");
  updateSteps();
}

/* --------------------------------------------------------------- viewer */

function fitZoom() {
  const avail = $("#pages").clientWidth - 48;
  const widest = Math.max(...state.doc.pages.map((p, i) => (state.rotations[i] % 180 ? p.height : p.width)));
  const z = Math.floor((avail / (widest * 1.25)) * 10) / 10;
  return Math.min(1.5, Math.max(0.4, z || 1));
}

const pageCssWidth = (page) => Math.round(page.width * 1.25 * state.zoom);

/** How far the user turned page i (PDF pages only). */
const pageRotation = (i) => (isBook() ? 0 : state.rotations[i] || 0);

/** Width and height of page i as shown (turned pages swap them), in points. */
function shownSize(i) {
  const p = viewPages()[i];
  return pageRotation(i) % 180 ? [p.height, p.width] : [p.width, p.height];
}

/** Size a page element for the zoom, and turn its body for a rotated page. */
function sizePage(el) {
  const i = Number(el.dataset.page), page = viewPages()[i], rot = pageRotation(i);
  const w = pageCssWidth(page), h = Math.round((w * page.height) / page.width);
  el.style.width = `${rot % 180 ? h : w}px`;
  el.style.aspectRatio = rot % 180 ? `${page.height} / ${page.width}` : `${page.width} / ${page.height}`;
  const body = el.querySelector(".page-body");
  body.style.width = `${w}px`;
  body.style.height = `${h}px`;
  body.style.transform = `translate(-50%, -50%)${rot ? ` rotate(${rot}deg)` : ""}`;
}

function renderZoom(page) {
  const px = pageCssWidth(page) * Math.min(2, window.devicePixelRatio || 1);
  return Math.min(6, Math.max(0.5, Math.ceil((px / page.width) * 4) / 4));
}

// Page images are rendered by the workers, only for pages near the viewport, and kept in a
// small LRU cache so memory stays bounded on long documents.
const IMG_CACHE_MAX = 60;
const imgCache = new Map(); // key -> object URL (insertion order = LRU order)
const visiblePages = new Set();
let renderQueue = [];
let inflight = 0;

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const i = Number(e.target.dataset.page);
    if (e.isIntersecting) {
      visiblePages.add(i);
      ensureBoxes(i);
      queueRender(i);
    } else {
      visiblePages.delete(i);
    }
  }
}, { root: $("#pages"), rootMargin: "800px 0px" });

const imgKey = (i) => `${state.variant}:${state.variant === "translated" ? `${state.buildNo}.${state.pageVersion.get(i) || 0}` : 0}:${i}:${renderZoom(viewPages()[i])}`;

function queueRender(i) {
  const el = document.querySelector(`.page[data-page="${i}"]`);
  if (!el) return;
  const key = imgKey(i);
  const img = el.querySelector("img");
  if (img.dataset.key === key) return;
  const url = imgCache.get(key);
  if (url) {
    imgCache.delete(key); imgCache.set(key, url); // refresh LRU position
    img.src = url; img.dataset.key = key;
    return;
  }
  if (!renderQueue.includes(i)) renderQueue.push(i);
  pump();
}

function pump() {
  const max = Math.max(1, pool.workers.length);
  while (inflight < max && renderQueue.length && state.doc) {
    // Render what is on screen first, nearest pages first.
    renderQueue = renderQueue.filter((i) => visiblePages.has(i));
    if (!renderQueue.length) break;
    const i = renderQueue.shift();
    const key = imgKey(i);
    const page = viewPages()[i];
    const doc = state.doc;
    if (!page) continue;
    inflight++;
    // The editable translated PDF lives in worker 0; originals render on any idle worker.
    (state.variant === "translated" ? pool.workers[0] : pool.leastBusy(building ? pool.workers[0] : null))
      .call("render", { page: i, zoom: renderZoom(page), variant: state.variant })
      .then((buf) => {
        if (state.doc !== doc) return;
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        imgCache.set(key, url);
        while (imgCache.size > IMG_CACHE_MAX) {
          const [oldKey, oldUrl] = imgCache.entries().next().value;
          imgCache.delete(oldKey);
          URL.revokeObjectURL(oldUrl);
          const stale = document.querySelector(`.page img[data-key="${CSS.escape(oldKey)}"]`);
          if (stale) { stale.removeAttribute("src"); delete stale.dataset.key; }
        }
        const img = document.querySelector(`.page[data-page="${i}"] img`);
        if (img && imgKey(i) === key) { img.src = url; img.dataset.key = key; }
      })
      .catch((err) => console.warn("render failed", i, err))
      .finally(() => { inflight--; pump(); });
  }
}

function clearImageCache() {
  for (const url of imgCache.values()) URL.revokeObjectURL(url);
  imgCache.clear();
  renderQueue = [];
}

function renderPages() {
  const wrap = $("#pages");
  observer.disconnect();
  clearImageCache();
  visiblePages.clear();
  // The picture, boxes and markups are in .page-body, which is turned for pages the user rotated.
  const html = viewPages().map((page, i) =>
    `<div class="page" data-page="${i}"><span class="page-label">${t("page.n", { n: i + 1 })}</span><div class="page-body"><img alt=""></div></div>`).join("");
  wrap.innerHTML = html;
  wrap.querySelectorAll(".page").forEach((el) => sizePage(el));
  segsByPage = new Map();
  boxesByPage = new Map();
  const addBox = (page, s, bbox) => {
    if (!boxesByPage.has(page)) boxesByPage.set(page, []);
    boxesByPage.get(page).push([s, bbox]);
  };
  for (const s of state.doc.segments) {
    if (!segsByPage.has(s.page)) segsByPage.set(s.page, []);
    segsByPage.get(s.page).push(s);
    // E-books: where each text is in the laid-out original or translated book (if found).
    const boxes = state.variant === "translated" && state.outView ? state.outView.boxes[s.id] : s.boxes || (s.bbox && [[s.page, shownBox(s)]]);
    for (const [page, bbox] of boxes || []) addBox(page, s, bbox);
  }
  wrap.querySelectorAll(".page").forEach((el) => observer.observe(el));
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

let segsByPage = new Map(), boxesByPage = new Map();
/** Page where a segment's box is in the current view (e-book texts may move when translated). */
function boxPage(s) {
  const boxes = state.variant === "translated" && state.outView ? state.outView.boxes[s.id] : null;
  return boxes ? boxes[0][0] : s.page;
}
/** Segment outlines are added to a page the first time it comes near the viewport. */
function ensureBoxes(i) {
  const el = document.querySelector(`.page[data-page="${i}"]`);
  if (!el || el.dataset.boxes) return el;
  el.dataset.boxes = "1";
  const page = viewPages()[i];
  const html = (boxesByPage.get(i) || []).map(([s, bbox]) => {
    const [x0, y0, x1, y1] = bbox;
    const active = s.id === state.activeId, custom = !isBook() && state.overrides[s.id] && state.overrides[s.id].bbox;
    const cls = "box" + (hasTr(s.id) ? " done" : "") + (s.skip ? " skip" : "") + (active ? " active" : "") + (custom ? " custom" : "");
    return `<div class="${cls}" data-id="${s.id}" title="#${s.id}" style="left:${((x0 - page.x0) / page.width) * 100}%;top:${((y0 - page.y0) / page.height) * 100}%;width:${((x1 - x0) / page.width) * 100}%;height:${((y1 - y0) / page.height) * 100}%">${active && !isBook() ? HANDLES : ""}</div>`;
  }).join("");
  el.querySelector(".page-body").insertAdjacentHTML("beforeend", html);
  renderMarkups(i);
  return el;
}

function refreshImages() {
  if (!state.doc) return;
  document.querySelectorAll(".page").forEach((el) => {
    sizePage(el);
  });
  renderQueue = [];
  for (const i of visiblePages) queueRender(i);
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setVariant(variant) {
  // A translated e-book has its own pages: rebuild the page list, keeping the reading position.
  const relayout = isBook() && variant !== state.variant;
  const at = relayout ? currentPageIndex() / Math.max(1, viewPages().length) : 0;
  state.variant = variant;
  if (relayout) {
    renderPages();
    goToPage(Math.round(at * viewPages().length));
  }
  $("#viewOriginal").classList.toggle("active", variant === "original");
  $("#viewTranslated").classList.toggle("active", variant === "translated");
  $("#pages").classList.toggle("translated", variant === "translated");
  refreshImages();
}

const ZOOM_MIN = 0.25, ZOOM_MAX = 5;
let zoomRenderTimer = null;

/**
 * Change the zoom, keeping the point under `anchor` (viewer coordinates; default: the centre
 * of the viewer) in place. Page images are re-rendered once zooming pauses.
 */
function setZoom(z, anchor) {
  const box = $("#pages");
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  if (!state.doc || z === state.zoom) return;
  const ax = anchor ? anchor[0] : box.clientWidth / 2, ay = anchor ? anchor[1] : box.clientHeight / 2;
  const cx = box.scrollLeft + ax, cy = box.scrollTop + ay;
  const pages = [...box.querySelectorAll(".page")];
  const el = pages.find((p) => p.offsetTop + p.offsetHeight + 11 >= cy) || pages[pages.length - 1];
  const fx = (cx - el.offsetLeft) / el.offsetWidth, fy = (cy - el.offsetTop) / el.offsetHeight;
  state.zoom = z;
  for (const p of pages) sizePage(p);
  box.scrollLeft = el.offsetLeft + fx * el.offsetWidth - ax;
  box.scrollTop = el.offsetTop + fy * el.offsetHeight - ay;
  $("#zoomLabel").textContent = `${Math.round(z * 100)}%`;
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(refreshImages, 180);
}

function fitWidth() {
  const box = $("#pages");
  const widest = Math.max(...viewPages().map((p, i) => shownSize(i)[0]));
  setZoom((box.clientWidth - 48) / (widest * 1.25));
}

/* ------------------------------------------------- virtualised segment list */

const segIndex = new Map();
const segById = (id) => segIndex.get(Number(id));

/** Segments that need a translation (not numbers/dates only). */
const translatable = () => state.doc.segments.filter((s) => !s.skip);

function segMeta(s) {
  const page = t("meta.page", { n: s.page + 1 });
  if (s.skip) return `${page} · ${t(s.formula ? "meta.formula" : "meta.numbers")}`;
  if (isBook()) return s.hidden ? `${t("meta.notShown")} · ${s.tag}` : `${page} · ${s.tag}`;
  if (s.ocr) return `${page} · OCR · ${Math.round(s.size * 10) / 10}pt${s.bold ? " " + t("meta.bold") : ""}`;
  const style = [s.bold && t("meta.bold"), s.italic && t("meta.italic")].filter(Boolean).join(" ");
  const rot = s.rotation ? ` · ${t("meta.rotated", { deg: s.rotation })}` : "";
  return `${page} · ${Math.round(s.size * 10) / 10}pt${style ? " " + style : ""} · ${t("meta." + s.align)}${rot}`;
}

/**
 * Only the cards in (and near) the visible part of the list exist in the DOM. Heights of
 * cards that have been shown are measured; the rest are estimated from their text length.
 */
const vl = {
  ids: [],              // filtered segment ids, in order
  pos: new Map(),       // id -> index in ids
  heights: new Map(),   // id -> measured height incl. gap
  offsets: [0],         // prefix sums of heights
  rendered: new Map(),  // id -> element
  dirty: true,
  charsPerLine: 60,

  el: () => $("#segments"),
  inner: null,

  reset() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.heights.clear();
    this.ids = [];
    this.pos.clear();
    this.dirty = true;
    if (!this.inner) {
      this.inner = document.createElement("div");
      this.inner.className = "vl-inner";
      this.el().appendChild(this.inner);
    }
    this.inner.style.height = "0px";
    this.el().scrollTop = 0;
    this.charsPerLine = Math.max(20, Math.floor((this.el().clientWidth - 50) / 7.6));
  },
  setIds(ids) {
    this.ids = ids;
    this.pos = new Map(ids.map((id, i) => [id, i]));
    this.dirty = true;
    this.render();
  },
  estimate(id) {
    const s = segById(id);
    const lines = (t) => Math.max(1, Math.ceil((t || "").length / this.charsPerLine) + ((t || "").match(/\n/g) || []).length);
    return 62 + lines(s.text) * 20 + Math.min(14, lines(state.translations[id])) * 20 + GAP;
  },
  height(id) { return this.heights.get(id) || this.estimate(id); },
  layout() {
    if (!this.dirty) return;
    const off = new Array(this.ids.length + 1);
    off[0] = 0;
    for (let i = 0; i < this.ids.length; i++) off[i + 1] = off[i] + this.height(this.ids[i]);
    this.offsets = off;
    this.inner.style.height = `${off[off.length - 1]}px`;
    this.dirty = false;
  },
  indexAt(y) { // first index whose bottom is below y
    let lo = 0, hi = this.ids.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid + 1] <= y) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo);
  },
  render() {
    if (!state.doc) return;
    this.layout();
    const box = this.el();
    const top = box.scrollTop, bottom = top + box.clientHeight;
    const start = this.ids.length ? this.indexAt(Math.max(0, top - 400)) : 0;
    const end = this.ids.length ? Math.min(this.ids.length, this.indexAt(bottom + 400) + 1) : 0;
    const want = new Set(this.ids.slice(start, end));
    for (const [id, el] of this.rendered) {
      if (!want.has(id) && !el.contains(document.activeElement)) { el.remove(); this.rendered.delete(id); ro.unobserve(el); }
    }
    const created = [];
    for (let i = start; i < end; i++) {
      const id = this.ids[i];
      let el = this.rendered.get(id);
      if (!el) {
        el = makeCard(id);
        this.rendered.set(id, el);
        this.inner.appendChild(el);
        created.push(el);
      }
      el.style.transform = `translateY(${this.offsets[i]}px)`;
    }
    for (const [id, el] of this.rendered) { // a focused card kept outside the window
      if (!this.pos.has(id)) { el.remove(); this.rendered.delete(id); ro.unobserve(el); }
      else if (!want.has(id)) el.style.transform = `translateY(${this.offsets[this.pos.get(id)]}px)`;
    }
    // Size new textareas in one pass (read after all writes), then watch the card sizes.
    const tas = created.map((el) => el.querySelector("textarea"));
    tas.forEach((ta) => { ta.style.height = "auto"; });
    const hs = tas.map((ta) => ta.scrollHeight);
    tas.forEach((ta, k) => { ta.style.height = `${Math.min(hs[k] + 2, 320)}px`; });
    created.forEach((el) => ro.observe(el));
  },
  /** Re-measure after cards changed size, keeping the first visible card in place. */
  remeasure(entries) {
    const box = this.el();
    const anchorIdx = this.ids.length ? this.indexAt(box.scrollTop) : 0;
    const anchorId = this.ids[anchorIdx];
    const delta = anchorId !== undefined ? box.scrollTop - this.offsets[anchorIdx] : 0;
    let changed = false;
    for (const e of entries) {
      const id = Number(e.target.dataset.id);
      if (!e.target.isConnected) continue;
      const h = Math.round(e.target.offsetHeight) + GAP;
      if (this.heights.get(id) !== h) { this.heights.set(id, h); changed = true; }
    }
    if (!changed) return;
    this.dirty = true;
    this.layout();
    if (anchorId !== undefined && this.pos.has(anchorId)) box.scrollTop = this.offsets[this.pos.get(anchorId)] + delta;
    this.render();
  },
  scrollTo(id) {
    if (!this.pos.has(id)) return false;
    this.layout();
    const i = this.pos.get(id);
    const box = this.el();
    box.scrollTop = Math.max(0, this.offsets[i] - box.clientHeight / 2 + this.height(id) / 2);
    this.render();
    return true;
  },
};

const ro = new ResizeObserver((entries) => vl.remeasure(entries));

const isPending = (id) => (state.translations[id] || "").trim() !== (state.applied[id] || "").trim();

function makeCard(id) {
  const s = segById(id);
  const el = document.createElement("div");
  el.className = "seg" + (hasTr(id) ? " done" : "") + (state.shrunk.has(id) ? " shrunk" : "") + (id === state.activeId ? " active" : "") + (isPending(id) ? " pending" : "");
  el.dataset.id = id;
  el.innerHTML = `
    <div class="seg-head">
      <span class="seg-status"></span>
      <span class="seg-id">#${id}</span>
      <span class="seg-meta" data-shrunk="${escapeHtml(t("meta.shrunk"))}">${escapeHtml(segMeta(s))}</span>
      <button type="button" class="mini" data-act="copy" title="${escapeHtml(t("card.copyTitle"))}">${t("card.copy")}</button>
      <button type="button" class="mini" data-act="same" title="${escapeHtml(t("card.keepTitle"))}">${t("card.keep")}</button>
      ${isBook() || s.skip ? "" : `<button type="button" class="mini${state.overrides[id] ? " on" : ""}" data-act="style" title="${escapeHtml(t("card.styleTitle"))}">Aa</button>`}
      <button type="button" class="mini apply" data-act="apply" title="${escapeHtml(t("card.applyTitle"))}">${t("card.apply")}</button>
    </div>
    ${styleOpen.has(id) && !isBook() ? stylePanelHtml(s) : ""}
    <div class="seg-src">${escapeHtml(s.text)}</div>
    <textarea rows="1" spellcheck="true" placeholder="${escapeHtml(t("card.placeholder"))}"></textarea>`;
  el.querySelector("textarea").value = state.translations[id] || "";
  if (find.open) requestAnimationFrame(() => decorateCard(el, id)); // (once it has its size)
  return el;
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`;
}

function markDone(id) {
  const done = hasTr(id);
  vl.rendered.get(id)?.classList.toggle("done", done);
  vl.rendered.get(id)?.classList.toggle("pending", isPending(id));
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((b) => b.classList.toggle("done", done));
}

function updateProgress() {
  let total = 0, done = 0;
  if (state.doc) for (const s of state.doc.segments) if (!s.skip) { total++; if (hasTr(s.id)) done++; }
  $("#progressText").textContent = t("progress", { done, total });
  $("#progressBar").style.width = total ? `${(done / total) * 100}%` : "0";
  updateSteps(done > 0);
}

function updateSteps(any) {
  const steps = [...document.querySelectorAll("#steps li")];
  steps.forEach((li) => li.classList.remove("active", "done"));
  if (!state.doc) { steps[0].classList.add("active"); return; }
  steps[0].classList.add("done");
  if (state.hasOutput) {
    steps[1].classList.add("done");
    steps[2].classList.add("done");
  } else {
    steps[1].classList.add(any ? "done" : "active");
    if (any) steps[2].classList.add("active");
  }
}

function applyFilter() {
  if (!state.doc) return;
  const q = $("#search").value.trim().toLowerCase();
  const status = $("#filterStatus").value;
  const page = $("#filterPage").value === "all" ? null : Number($("#filterPage").value);
  const ids = [];
  for (const s of state.doc.segments) {
    if (page !== null && s.page !== page) continue;
    if (status === "numbers" ? !s.skip : s.skip) continue; // numbers-only segments have their own filter
    if ((status === "todo" || status === "done") && (status === "done") !== hasTr(s.id)) continue;
    if (q && !s.text.toLowerCase().includes(q) && !(state.translations[s.id] || "").toLowerCase().includes(q)) continue;
    ids.push(s.id);
  }
  $("#segments").classList.toggle("is-empty", !ids.length);
  $("#segments").dataset.empty = state.doc.segments.length ? t("filter.empty") : t("filter.noText");
  vl.setIds(ids);
}

function setActive(id, { scrollList = false, scrollViewer = false, focus = false } = {}) {
  if (state.activeId !== null) {
    vl.rendered.get(state.activeId)?.classList.remove("active");
    document.querySelectorAll(`.box[data-id="${state.activeId}"]`).forEach((b) => b.classList.remove("active"));
  }
  state.activeId = id;
  if (scrollList || focus) {
    if (!vl.pos.has(id)) {
      $("#search").value = ""; $("#filterStatus").value = segById(id).skip ? "numbers" : "all"; $("#filterPage").value = "all";
      applyFilter();
    }
    if (scrollList) vl.scrollTo(id);
  }
  vl.rendered.get(id)?.classList.add("active");
  const s = segById(id);
  ensureBoxes(boxPage(s));
  const box = document.querySelector(`.box[data-id="${id}"]`);
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((b) => b.classList.add("active"));
  showHandles(id);
  if (scrollViewer && box) box.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  if (focus) vl.rendered.get(id)?.querySelector("textarea").focus({ preventScroll: true });
}

/** No segment selected any more (a click beside the boxes or the cards, or Esc). */
function clearActive() {
  if (state.activeId === null) return;
  vl.rendered.get(state.activeId)?.classList.remove("active");
  document.querySelectorAll(`.box[data-id="${state.activeId}"]`).forEach((b) => b.classList.remove("active"));
  state.activeId = null;
  showHandles(null);
  const focused = document.activeElement;
  if (focused && focused.closest && focused.closest(".seg")) focused.blur();
}

let progressTimer = null;
function setTranslation(id, value) {
  if (value && value.trim()) state.translations[id] = value;
  else delete state.translations[id];
  markDone(id);
  persist();
  clearTimeout(progressTimer);
  progressTimer = setTimeout(updateProgress, 150);
}

/* -------------------------------------------------------- export/import */

async function copyAll() {
  const segs = translatable();
  const text = Engine.exportTxt(segs);
  try {
    await navigator.clipboard.writeText(text);
    toast(t("msg.copied", { n: segs.length }), "ok");
  } catch (_) {
    $("#pasteArea").value = text;
    $("#importDialog").showModal();
    $("#pasteArea").select();
    toast(t("msg.noClipboard"));
  }
}

function doExport() {
  const format = document.querySelector('input[name="fmt"]:checked').value;
  const tr = $("#includeTranslations").checked ? state.translations : {};
  const segs = translatable();
  const name = `${stem()}.segments`;
  try {
    if (format === "txt") saveBlob(new Blob([Engine.exportTxt(segs, tr)], { type: "text/plain;charset=utf-8" }), `${name}.txt`);
    else if (format === "csv") saveBlob(new Blob([Engine.exportCsv(segs, tr)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
    else if (format === "json") saveBlob(new Blob([Engine.exportJson(segs, tr, state.doc.name)], { type: "application/json" }), `${name}.json`);
    else if (format === "xliff") saveBlob(new Blob([Engine.exportXliff(segs, tr, state.doc.name, "und", $("#tgtLang").value.trim())], { type: "application/xliff+xml" }), `${name}.xlf`);
    else if (format === "docx") saveBlob(Engine.exportDocx(segs, tr), `${name}.docx`);
  } catch (err) {
    toast(err.message, "error");
  }
}

function mergeImported(parsed) {
  const ids = Object.keys(parsed).map(Number);
  const matched = ids.filter((id) => segIndex.has(id));
  const unknown = ids.length - matched.length;
  const overwrite = $("#importOverwrite").checked;
  let applied = 0;
  const before = {}, after = {};
  for (const id of matched) {
    if (!overwrite && hasTr(id)) continue;
    before[id] = state.translations[id] || "";
    after[id] = parsed[id];
    state.translations[id] = parsed[id];
    vl.heights.delete(id);
    applied++;
  }
  persist();
  if (applied) recordTranslations(before, after, t("hist.import"));
  // Update what is on screen; everything else picks the new text up when it is shown.
  for (const [id, el] of vl.rendered) {
    const ta = el.querySelector("textarea");
    if (ta.value !== (state.translations[id] || "")) { ta.value = state.translations[id] || ""; autoGrow(ta); }
    el.classList.toggle("done", hasTr(id));
    el.classList.toggle("pending", isPending(id));
  }
  document.querySelectorAll(".box").forEach((b) => b.classList.toggle("done", hasTr(b.dataset.id)));
  vl.dirty = true;
  applyFilter();
  updateProgress();
  let msg = t("msg.imported", { n: applied });
  if (unknown) msg += t("msg.unknownMarkers", { n: unknown });
  const got = new Set(matched);
  const missing = translatable().filter((s) => !got.has(s.id)).length;
  if (missing && matched.length) msg += t("msg.missing", { n: missing });
  toast(msg, applied ? "ok" : "error");
  if (!matched.length) toast(t("msg.noMarkers"), "error");
}

async function importFile(file) {
  if (!file) return;
  $("#importDialog").close();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    mergeImported(await Engine.parseImport(file.name, bytes));
  } catch (err) {
    toast(t("msg.readFailed", { file: file.name, err: err.message }), "error");
  } finally {
    $("#importFile").value = "";
  }
}

function importPasted() {
  const text = $("#pasteArea").value;
  if (!text.trim()) { toast(t("msg.pasteFirst"), "error"); return; }
  mergeImported(Engine.parseMarkedText(text));
  $("#pasteArea").value = "";
}

/* ---------------------------------------------------------------- build */

function setBuilt(built) {
  $("#viewTranslated").disabled = !built;
  updateDownloadButton();
  updateProgress();
}

async function downloadOutput() {
  try {
    // (the copy saved by the build has no markups and no turned pages: those are added on saving)
    const extras = (state.markups && state.markups.length) || (!isBook() && Object.keys(state.rotations).length);
    if (!state.outBytes || state.outDirty || extras) {
      busy(t("msg.saving"));
      state.outBytes = await pool.workers[0].call("save", { markups: state.markups, rotations: isBook() ? {} : state.rotations });
      state.outDirty = false;
    }
    const kind = state.doc.kind || "pdf";
    const type = { pdf: "application/pdf", epub: "application/epub+zip", fb2: "application/x-fictionbook+xml" }[kind];
    saveBlob(new Blob([state.outBytes], { type }), `${stem()}.translated.${kind}`);
  } catch (err) {
    toast(t("msg.saveFailed", { err: err.message || err }), "error");
  } finally {
    busy("");
  }
}

/**
 * Both languages in one file: a PDF with original and translation on one sheet ("side") or on
 * alternating pages ("pages"); an e-book with each paragraph followed by its translation.
 */
function askBilingual() {
  if ((state.doc.kind || "pdf") !== "pdf") { downloadBilingual(); return; }
  let layout = "side";
  try { layout = localStorage.getItem("pdftr:bi-layout") || "side"; } catch (_) { /* storage blocked */ }
  const radio = document.querySelector(`input[name="biLayout"][value="${layout}"]`);
  if (radio) radio.checked = true;
  $("#biDialog").showModal();
}

async function downloadBilingual(layout = "pages") {
  try {
    busy(t("msg.saving"));
    const kind = state.doc.kind || "pdf";
    const bytes = kind === "pdf"
      ? await pool.workers[0].call("saveBilingual", { markups: state.markups, rotations: state.rotations, layout })
      : await pool.workers[0].call("saveBilingual", { segments: state.doc.segments, translations: state.applied, opts: buildOptions() });
    const type = { pdf: "application/pdf", epub: "application/epub+zip", fb2: "application/x-fictionbook+xml" }[kind];
    saveBlob(new Blob([bytes], { type }), `${stem()}.bilingual.${kind}`);
  } catch (err) {
    toast(t("msg.saveFailed", { err: err.message || err }), "error");
  } finally {
    busy("");
  }
}

function buildOptions() {
  const fontMode = $("#fontMode").value === "custom" && !state.customFont ? "auto" : $("#fontMode").value;
  return {
    fontMode,
    customFont: state.customFont && state.customFont.bytes,
    expand: $("#optExpand").checked,
    minScale: Number($("#minScale").value),
    lang: isBook() ? $("#bookLang").value.trim() : "", // e-books: language code of the translation
  };
}

/**
 * Write one segment's translation into the translated PDF right away. Its page is rebuilt
 * from the original with every translation already applied on that page plus this one.
 */
let applyChain = Promise.resolve();
function applyField(id) {
  applyChain = applyChain.then(async () => {
    if (!state.doc || !segIndex.has(id)) return;
    const s = segById(id);
    if (hasTr(id)) state.applied[id] = state.translations[id]; else delete state.applied[id];
    if (isBook()) { await applyBook(id); return; }
    const segs = segsByPage.get(s.page) || [];
    const translations = {};
    for (const x of segs) if ((state.applied[x.id] || "").trim()) translations[x.id] = state.applied[x.id];
    try {
      const stats = await pool.workers[0].call("updatePage", {
        page: s.page, segments: segs.map(effSeg), translations, pageInfo: state.doc.pages[s.page], opts: buildOptions(),
      });
      state.hasOutput = true;
      state.outDirty = true;
      state.pageVersion.set(s.page, (state.pageVersion.get(s.page) || 0) + 1);
      for (const x of segs) state.shrunk.delete(x.id);
      for (const x of stats.shrunk) state.shrunk.add(x.id);
      for (const x of segs) {
        const el = vl.rendered.get(x.id);
        if (el) { el.classList.toggle("shrunk", state.shrunk.has(x.id)); el.classList.toggle("pending", isPending(x.id)); }
      }
      setBuilt(true);
      if (state.variant !== "translated") setVariant("translated"); else queueRender(s.page);
      ensureBoxes(s.page);
      document.querySelector(`.box[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (stats.missing) toast(t("msg.fontMissing", { n: stats.missing, chars: stats.missingChars }), "error");
    } catch (err) {
      toast(t("msg.updateFailed", { err: err.message || err }), "error");
    }
  });
  return applyChain;
}

/** E-books are rebuilt as a whole (in well under a second) with the applied translations. */
async function applyBook(id) {
  try {
    busy(t("msg.updating"));
    const { bytes, view } = await pool.workers[0].call("build", { segments: state.doc.segments, translations: state.applied, opts: buildOptions() });
    state.outBytes = bytes;
    state.outView = view;
    state.hasOutput = true;
    state.outDirty = false;
    state.buildNo++;
    for (const [x, el] of vl.rendered) el.classList.toggle("pending", isPending(x));
    setBuilt(true);
    if (state.variant !== "translated") setVariant("translated"); else renderPages();
    const page = boxPage(segById(id));
    ensureBoxes(page);
    const box = document.querySelector(`.box[data-id="${id}"]`);
    if (box) box.scrollIntoView({ block: "center", behavior: "smooth" }); else goToPage(page);
  } catch (err) {
    toast(t("msg.updateFailed", { err: err.message || err }), "error");
  } finally {
    busy("");
  }
}

let building = false;
async function doBuild() {
  const count = Object.keys(state.translations).filter((id) => segIndex.has(Number(id)) && hasTr(id)).length;
  if (!count) {
    toast(t("msg.noTranslations"), "error");
    return;
  }
  const fontMode = $("#fontMode").value;
  if (fontMode === "custom" && !state.customFont && !isBook()) {
    toast(t("msg.chooseFont"), "error");
    return;
  }
  busy(t("msg.building", { n: count }));
  building = true;
  try {
    const started = performance.now();
    const translations = {};
    for (const [id, t] of Object.entries(state.translations)) if (segIndex.has(Number(id)) && t.trim()) translations[id] = t;
    const result = await pool.workers[0].call("build", {
      segments: state.doc.segments.map(effSeg),
      translations,
      pages: state.doc.pages,
      opts: buildOptions(),
    }, [], (i, n) => busy(t("msg.buildingPage", { i, n })));
    const { bytes, stats } = result;
    disposeOutput();
    state.outBytes = bytes;
    state.outView = result.view || null;
    state.hasOutput = true;
    state.applied = { ...translations };
    state.buildNo++;
    state.shrunk = new Set(stats.shrunk.map((x) => x.id));
    for (const [id, el] of vl.rendered) {
      el.classList.toggle("shrunk", state.shrunk.has(id));
      el.classList.toggle("pending", isPending(id));
    }
    setBuilt(true);
    if (isBook() && state.variant === "translated") { state.variant = "original"; } // force the page list to be rebuilt
    setVariant("translated");
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    let msg = t("msg.built", { n: stats.replaced, secs, mb: (bytes.length / 1048576).toFixed(1) });
    if (stats.shrunk.length) msg += t("msg.shrunk", { n: stats.shrunk.length });
    toast(msg, "ok");
    if (stats.missing) {
      toast(t("msg.fontMissing", { n: stats.missing, chars: stats.missingChars }), "error");
    }
  } catch (err) {
    console.error(err);
    toast(t("msg.buildFailed", { err: err.message || err }), "error");
  } finally {
    building = false;
    busy("");
    pump();
  }
}

async function chooseFont(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sig = String.fromCharCode(...bytes.slice(0, 4));
  if (!(sig === "OTTO" || sig === "true" || sig === "ttcf" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0))) {
    state.customFont = null;
    $("#fontStatus").textContent = t("msg.notFont");
    toast(t("msg.notFont"), "error");
    return;
  }
  state.customFont = { name: file.name, bytes };
  $("#fontStatus").textContent = t("msg.usingFont", { name: file.name });
}

/* --------------------------------------------------------------- wiring */

function setupDropzone(zone, onFile) {
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { e.stopPropagation(); onFile(e.dataTransfer.files[0]); });
}

function init() {
  setupDropzone($("#dropzone"), openPdf);
  $("#fileInput").addEventListener("change", (e) => openPdf(e.target.files[0]));
  $("#btnNew").addEventListener("click", closeDocument);

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.pdf$/i.test(file.name) && !document.querySelector("dialog[open]")) openPdf(file);
  });

  $("#viewOriginal").addEventListener("click", () => setVariant("original"));
  $("#viewTranslated").addEventListener("click", () => setVariant("translated"));
  $("#zoomIn").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#zoomOut").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#zoomFit").addEventListener("click", fitWidth);
  // Ctrl/Cmd + wheel (and touchpad pinch) zooms around the pointer.
  $("#pages").addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
    e.preventDefault();
    const r = $("#pages").getBoundingClientRect();
    setZoom(state.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), [e.clientX - r.left, e.clientY - r.top]);
  }, { passive: false });
  $("#showBoxes").addEventListener("change", (e) => $("#pages").classList.toggle("no-boxes", !e.target.checked));
  $("#pages").addEventListener("click", (e) => {
    const box = e.target.closest(".box");
    if (box) setActive(Number(box.dataset.id), { scrollList: true, focus: true });
    else if (mk.tool === "select" && !e.target.closest(".mk, .mk-editor")) clearActive(); // clicked beside the boxes
  });

  const list = $("#segments");
  let scrollRaf = 0;
  list.addEventListener("scroll", () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; vl.render(); });
  }, { passive: true });
  list.addEventListener("input", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    setTranslation(Number(e.target.closest(".seg").dataset.id), e.target.value);
    autoGrow(e.target);
  });
  list.addEventListener("change", (e) => { // fires when a changed translation box is left
    if (e.target.tagName !== "TEXTAREA") return;
    const id = e.target.closest(".seg").dataset.id;
    const before = e.target.dataset.before || "", after = e.target.value;
    e.target.dataset.before = after;
    if (before !== after) recordTranslations({ [id]: before }, { [id]: after }, t("hist.translation"));
  });
  list.addEventListener("focusin", (e) => {
    if (e.target.tagName === "TEXTAREA") e.target.dataset.before = e.target.value;
    const card = e.target.closest(".seg");
    if (card && Number(card.dataset.id) !== state.activeId) setActive(Number(card.dataset.id), { scrollViewer: true });
  });
  list.addEventListener("click", (e) => {
    const card = e.target.closest(".seg");
    if (!card) { clearActive(); return; } // clicked beside the cards
    const id = Number(card.dataset.id);
    const act = e.target.dataset.act;
    if (act === "copy") {
      navigator.clipboard?.writeText(segById(id).text).then(() => toast(t("msg.sourceCopied")));
    } else if (act === "same") {
      const ta = card.querySelector("textarea");
      const before = state.translations[id] || "";
      ta.value = segById(id).text;
      ta.dataset.before = ta.value;
      setTranslation(id, ta.value);
      autoGrow(ta);
      recordTranslations({ [id]: before }, { [id]: ta.value }, t("hist.translation"));
    } else if (act === "apply") {
      applyField(id);
    } else if (act === "style") {
      if (styleOpen.has(id)) styleOpen.delete(id); else styleOpen.add(id);
      refreshStylePanel(id);
    } else if (e.target.closest(".seg-src")) { // (also on a highlighted search match)
      setActive(id, { scrollViewer: true, focus: true });
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { // update this field in the PDF
      e.preventDefault();
      applyField(Number(e.target.closest(".seg").dataset.id));
      return;
    }
    const down = (e.key === "Enter" && (e.ctrlKey || e.metaKey)) || (e.altKey && e.key === "ArrowDown");
    const up = e.altKey && e.key === "ArrowUp";
    if (!down && !up) return;
    e.preventDefault();
    const i = vl.pos.get(Number(e.target.closest(".seg").dataset.id));
    const next = vl.ids[i + (down ? 1 : -1)];
    if (next !== undefined) setActive(next, { scrollList: true, scrollViewer: true, focus: true });
  });
  let searchTimer = null;
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilter, 150); });
  $("#filterStatus").addEventListener("change", applyFilter);
  $("#filterPage").addEventListener("change", (e) => {
    applyFilter();
    if (e.target.value !== "all") document.querySelector(`.page[data-page="${e.target.value}"]`)?.scrollIntoView({ behavior: "smooth" });
  });

  $("#btnExport").addEventListener("click", () => $("#exportDialog").showModal());
  $("#exportDialog").addEventListener("close", () => { if ($("#exportDialog").returnValue === "ok") doExport(); });
  $("#btnCopy").addEventListener("click", copyAll);
  $("#btnClear").addEventListener("click", clearAllTranslations);
  for (const sel of ["#tgtLang", "#aiTarget"]) {
    $(sel).addEventListener("input", (e) => { e.target.dataset.userSet = e.target.value.trim() ? "1" : ""; });
  }
  applyLanguageDefaults();

  $("#btnImport").addEventListener("click", () => $("#importDialog").showModal());
  setupDropzone($("#importDrop"), importFile);
  $("#importFile").addEventListener("change", (e) => importFile(e.target.files[0]));
  $("#importDialog").addEventListener("close", () => { if ($("#importDialog").returnValue === "ok") importPasted(); });

  $("#btnDownload").addEventListener("click", (e) => { e.preventDefault(); downloadOutput(); });
  $("#btnBuild").addEventListener("click", () => {
    $("#fontUploadRow").hidden = $("#fontMode").value !== "custom";
    $("#buildDialog").showModal();
  });
  $("#fontMode").addEventListener("change", (e) => { $("#fontUploadRow").hidden = e.target.value !== "custom"; });
  $("#fontFile").addEventListener("change", (e) => chooseFont(e.target.files[0]));
  $("#buildDialog").addEventListener("close", () => { if ($("#buildDialog").returnValue === "ok") doBuild(); });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.doc) return;
      refreshImages();
      vl.charsPerLine = Math.max(20, Math.floor((vl.el().clientWidth - 50) / 7.6));
      vl.heights.clear(); vl.dirty = true; vl.render();
    }, 150);
  });

  // Start the engine right away, and restore the last session.
  pool.start().then(() => { $("#engineStatus").hidden = true; }).catch((err) => {
    $("#engineStatus").textContent = err.message;
    $("#engineStatus").classList.add("error");
  });
  let last = null;
  try { last = localStorage.getItem(LS_LAST); } catch (_) { /* ignore */ }
  updateSteps();
  if (last) {
    idbGet().then((saved) => {
      if (saved && saved.bytes) loadBytes(saved.bytes, saved.name, false, saved.id);
    });
  }
}


/* ------------------------------------------------------------ AI prompt */

function aiSegments() {
  const n = state.doc.pages.length;
  const from = Math.min(n, Math.max(1, Number($("#aiFrom").value) || 1)) - 1;
  const to = Math.min(n, Math.max(from + 1, Number($("#aiTo").value) || n)) - 1;
  return state.doc.segments.filter((s) => !s.skip && s.page >= from && s.page <= to && (!$("#aiOnlyTodo").checked || !hasTr(s.id)));
}

/** The selected segments split into parts of "Fields per part" (numbers stay global). */
function aiParts() {
  const segs = aiSegments();
  const size = Math.max(20, Number($("#aiPartSize").value) || 1000);
  const parts = [];
  for (let i = 0; i < segs.length; i += size) parts.push(segs.slice(i, i + size));
  return parts;
}

function aiPromptText(part) {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#aiTarget").value.trim() || P.target;
  const context = $("#aiContext").value.trim();
  const glossary = $("#aiGlossary").value.trim();
  const lines = [P.intro(target), "", ...(isBook() ? P.bookRules : P.rules)];
  if (context) lines.push("", P.context(context.replace(/\.$/, "")));
  if (glossary) lines.push("", P.glossary, ...glossary.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`));
  if (part && part.total > 1) lines.push("", P.part(part.k, part.total, part.a, part.b));
  lines.push("", P.segments);
  return lines.join("\n");
}

const aiCopied = new Set(); // parts already copied; kept until the selection of fields changes
let aiSelection = "";

function refreshAiPrompt() {
  if (!state.doc) { $("#aiPrompt").value = aiPromptText(); $("#aiParts").innerHTML = ""; return; }
  const parts = aiParts();
  const segs = parts.flat();
  const selection = JSON.stringify([state.doc.id, parts.map((p) => [p[0].id, p.length])]);
  if (selection !== aiSelection) { aiCopied.clear(); aiSelection = selection; }
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  $("#aiPrompt").value = aiPromptText(parts.length > 1 ? { k: 1, total: parts.length, a: parts[0][0].id, b: parts[0][parts[0].length - 1].id } : null);
  let msg = t("ai.stats2", { n: segs.length, chars: chars.toLocaleString(LANG), parts: parts.length });
  const sizes = parts.map((p) => p.reduce((n, s) => n + s.text.length, 0));
  const long = sizes.findIndex((c) => c > 40000);
  if (long >= 0) msg += t("ai.partLong", { k: long + 1, chars: sizes[long].toLocaleString(LANG) });
  $("#aiStats").textContent = msg;
  $("#aiParts").innerHTML = parts.map((p, i) =>
    `<button type="button" class="btn${aiCopied.has(i) ? " copied" : i === 0 || aiCopied.has(i - 1) ? " primary" : ""}" data-part="${i}">${aiCopied.has(i) ? "✓ " : ""}${escapeHtml(t("ai.partBtn", { k: i + 1, total: parts.length, a: p[0].id, b: p[p.length - 1].id, n: p.length }))}</button>`).join("");
}

function copyAiPart(i) {
  if (!state.doc) { toast(t("msg.openFirst"), "error"); return; }
  const parts = aiParts();
  const p = parts[i];
  if (!p) { toast(t("msg.noSelection"), "error"); return; }
  const info = { k: i + 1, total: parts.length, a: p[0].id, b: p[p.length - 1].id };
  copyText(`${aiPromptText(info)}\n\n${Engine.exportTxt(p)}`, t("ai.partCopied", { k: i + 1, total: parts.length, n: p.length }));
  aiCopied.add(i);
  refreshAiPrompt();
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, "ok");
  } catch (_) {
    $("#aiPrompt").value = text;
    $("#aiPrompt").select();
    toast(t("msg.noClipboard"));
  }
}

let helpDocId = null;
function openHelp(focusAi) {
  if (state.doc) {
    $("#aiTo").max = $("#aiFrom").max = state.doc.pages.length;
    if (helpDocId !== state.doc.id) { $("#aiFrom").value = 1; $("#aiTo").value = state.doc.pages.length; helpDocId = state.doc.id; }
  }
  refreshAiPrompt();
  const dlg = $("#helpDialog");
  dlg.classList.toggle("mode-ai", focusAi);
  dlg.classList.toggle("mode-help", !focusAi);
  dlg.showModal();
  dlg.scrollTop = 0;
}

/** A close cross in the top right corner of every pop-up window. */
function addCloseButtons() {
  for (const dlg of document.querySelectorAll("dialog.modal")) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "modal-x";
    x.dataset.i18nTitle = "common.close";
    x.title = t("common.close");
    x.textContent = "×";
    x.addEventListener("click", () => dlg.close("cancel"));
    dlg.append(x);
  }
}

function initHelp() {
  addCloseButtons();
  $("#btnHelp").addEventListener("click", () => openHelp(false));
  $("#btnAi").addEventListener("click", () => openHelp(true));
  for (const id of ["#aiTarget", "#aiFrom", "#aiTo", "#aiOnlyTodo", "#aiContext", "#aiGlossary", "#aiPartSize"]) {
    $(id).addEventListener("input", refreshAiPrompt);
  }
  $("#aiParts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-part]");
    if (b) copyAiPart(Number(b.dataset.part));
  });
  $("#aiCopyPrompt").addEventListener("click", () => copyText(`${aiPromptText()}\n\n${t("ai.pasteHere")}`, t("msg.promptCopied")));

}

initHelp();
