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
};

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

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
  setTimeout(() => el.remove(), kind === "error" ? 8000 : 4500);
}

function busy(text) {
  $("#busyText").textContent = text || "";
  $("#busy").hidden = !text;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stem = () => (state.doc.name || "document.pdf").replace(/\.pdf$/i, "") || "document";
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
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
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

async function loadBytes(bytes, name, remember) {
  setLoading(t("msg.loadingEngine"));
  try {
    await pool.start();
    const id = await sha256(bytes);
    // More workers for bigger documents, fewer for huge files (each worker holds a copy).
    const mb = bytes.length / 1048576;
    await pool.ensure(mb > 150 ? 1 : mb > 60 ? 2 : pool.maxSize);
    setLoading(t("msg.opening"));
    const counts = await pool.all("open", () => ({ bytes }));
    const pageCount = counts[0];
    const started = performance.now();
    const { pages, segments } = await extractAll(pageCount, (i, n) => setLoading(t("msg.extracting", { i, n })));
    console.info(`Extracted ${segments.length} segments from ${pageCount} pages in ${Math.round(performance.now() - started)} ms using ${pool.workers.length} worker(s)`);
    if (remember) idbPut({ name, bytes });
    openDocument({ id, name, pages, segments }, bytes);
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
  document.title = `${doc.name} · PDF Translate`;

  fillPageFilter();
  $("#search").value = "";
  $("#filterStatus").value = "all";

  state.zoom = fitZoom();
  renderPages();
  vl.reset();
  applyFilter();
  setBuilt(false);
  setVariant("original");
  updateProgress();
  if (!doc.segments.length) {
    toast(t("msg.noText"), "error");
  }
}

function fillPageFilter() {
  const sel = $("#filterPage"), cur = sel.value;
  sel.innerHTML = `<option value="all">${t("filter.allPages")}</option>` +
    state.doc.pages.map((_, i) => `<option value="${i}">${t("page.n", { n: i + 1 })}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
}

/** Re-render everything that was built from translated strings. */
function onLanguageChange() {
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
  updateSteps();
}

/* --------------------------------------------------------------- viewer */

function fitZoom() {
  const avail = $("#pages").clientWidth - 48;
  const widest = Math.max(...state.doc.pages.map((p) => p.width));
  const z = Math.floor((avail / (widest * 1.25)) * 10) / 10;
  return Math.min(1.5, Math.max(0.4, z || 1));
}

const pageCssWidth = (page) => Math.round(page.width * 1.25 * state.zoom);

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

const imgKey = (i) => `${state.variant}:${state.variant === "translated" ? `${state.buildNo}.${state.pageVersion.get(i) || 0}` : 0}:${i}:${renderZoom(state.doc.pages[i])}`;

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
    const page = state.doc.pages[i];
    const doc = state.doc;
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
  const html = state.doc.pages.map((page, i) =>
    `<div class="page" data-page="${i}" style="width:${pageCssWidth(page)}px;aspect-ratio:${page.width} / ${page.height}">` +
    `<span class="page-label">${t("page.n", { n: i + 1 })}</span><img alt=""></div>`).join("");
  wrap.innerHTML = html;
  segsByPage = new Map();
  for (const s of state.doc.segments) {
    if (!segsByPage.has(s.page)) segsByPage.set(s.page, []);
    segsByPage.get(s.page).push(s);
  }
  wrap.querySelectorAll(".page").forEach((el) => observer.observe(el));
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

let segsByPage = new Map();
/** Segment outlines are added to a page the first time it comes near the viewport. */
function ensureBoxes(i) {
  const el = document.querySelector(`.page[data-page="${i}"]`);
  if (!el || el.dataset.boxes) return el;
  el.dataset.boxes = "1";
  const page = state.doc.pages[i];
  const html = (segsByPage.get(i) || []).map((s) => {
    const [x0, y0, x1, y1] = s.bbox;
    const cls = "box" + (hasTr(s.id) ? " done" : "") + (s.skip ? " skip" : "") + (s.id === state.activeId ? " active" : "");
    return `<div class="${cls}" data-id="${s.id}" title="#${s.id}" style="left:${((x0 - page.x0) / page.width) * 100}%;top:${((y0 - page.y0) / page.height) * 100}%;width:${((x1 - x0) / page.width) * 100}%;height:${((y1 - y0) / page.height) * 100}%"></div>`;
  }).join("");
  el.insertAdjacentHTML("beforeend", html);
  return el;
}

function refreshImages() {
  if (!state.doc) return;
  document.querySelectorAll(".page").forEach((el) => {
    el.style.width = `${pageCssWidth(state.doc.pages[Number(el.dataset.page)])}px`;
  });
  renderQueue = [];
  for (const i of visiblePages) queueRender(i);
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setVariant(variant) {
  state.variant = variant;
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
  for (const p of pages) p.style.width = `${pageCssWidth(state.doc.pages[Number(p.dataset.page)])}px`;
  box.scrollLeft = el.offsetLeft + fx * el.offsetWidth - ax;
  box.scrollTop = el.offsetTop + fy * el.offsetHeight - ay;
  $("#zoomLabel").textContent = `${Math.round(z * 100)}%`;
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(refreshImages, 180);
}

function fitWidth() {
  const box = $("#pages");
  const widest = Math.max(...state.doc.pages.map((p) => p.width));
  setZoom((box.clientWidth - 48) / (widest * 1.25));
}

/* ------------------------------------------------- virtualised segment list */

const segIndex = new Map();
const segById = (id) => segIndex.get(Number(id));

/** Segments that need a translation (not numbers/dates only). */
const translatable = () => state.doc.segments.filter((s) => !s.skip);

function segMeta(s) {
  const page = t("meta.page", { n: s.page + 1 });
  if (s.skip) return `${page} · ${t("meta.numbers")}`;
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
      <button type="button" class="mini apply" data-act="apply" title="${escapeHtml(t("card.applyTitle"))}">${t("card.apply")}</button>
    </div>
    <div class="seg-src">${escapeHtml(s.text)}</div>
    <textarea rows="1" spellcheck="true" placeholder="${escapeHtml(t("card.placeholder"))}"></textarea>`;
  el.querySelector("textarea").value = state.translations[id] || "";
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
  document.querySelector(`.box[data-id="${id}"]`)?.classList.toggle("done", done);
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
    document.querySelector(`.box[data-id="${state.activeId}"]`)?.classList.remove("active");
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
  ensureBoxes(s.page);
  const box = document.querySelector(`.box[data-id="${id}"]`);
  box?.classList.add("active");
  if (scrollViewer && box) box.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  if (focus) vl.rendered.get(id)?.querySelector("textarea").focus({ preventScroll: true });
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
    else if (format === "xliff") saveBlob(new Blob([Engine.exportXliff(segs, tr, state.doc.name, $("#srcLang").value.trim(), $("#tgtLang").value.trim())], { type: "application/xliff+xml" }), `${name}.xlf`);
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
  for (const id of matched) {
    if (!overwrite && hasTr(id)) continue;
    state.translations[id] = parsed[id];
    vl.heights.delete(id);
    applied++;
  }
  persist();
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
  $("#btnDownload").hidden = !built;
  updateProgress();
}

async function downloadOutput() {
  try {
    if (!state.outBytes || state.outDirty) {
      busy(t("msg.saving"));
      state.outBytes = await pool.workers[0].call("save");
      state.outDirty = false;
    }
    saveBlob(new Blob([state.outBytes], { type: "application/pdf" }), `${stem()}.translated.pdf`);
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
    const segs = segsByPage.get(s.page) || [];
    const translations = {};
    for (const x of segs) if ((state.applied[x.id] || "").trim()) translations[x.id] = state.applied[x.id];
    try {
      const stats = await pool.workers[0].call("updatePage", {
        page: s.page, segments: segs, translations, pageInfo: state.doc.pages[s.page], opts: buildOptions(),
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
      if (stats.missing) toast(t("msg.fontMissing", { n: stats.missing }), "error");
    } catch (err) {
      toast(t("msg.updateFailed", { err: err.message || err }), "error");
    }
  });
  return applyChain;
}

let building = false;
async function doBuild() {
  const count = Object.keys(state.translations).filter((id) => segIndex.has(Number(id)) && hasTr(id)).length;
  if (!count) {
    toast(t("msg.noTranslations"), "error");
    return;
  }
  const fontMode = $("#fontMode").value;
  if (fontMode === "custom" && !state.customFont) {
    toast(t("msg.chooseFont"), "error");
    return;
  }
  busy(t("msg.building", { n: count }));
  building = true;
  try {
    const started = performance.now();
    const translations = {};
    for (const [id, t] of Object.entries(state.translations)) if (segIndex.has(Number(id)) && t.trim()) translations[id] = t;
    const { bytes, stats } = await pool.workers[0].call("build", {
      segments: state.doc.segments,
      translations,
      pages: state.doc.pages,
      opts: buildOptions(),
    }, [], (i, n) => busy(t("msg.buildingPage", { i, n })));
    disposeOutput();
    state.outBytes = bytes;
    state.hasOutput = true;
    state.applied = { ...translations };
    state.buildNo++;
    state.shrunk = new Set(stats.shrunk.map((x) => x.id));
    for (const [id, el] of vl.rendered) {
      el.classList.toggle("shrunk", state.shrunk.has(id));
      el.classList.toggle("pending", isPending(id));
    }
    setBuilt(true);
    setVariant("translated");
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    let msg = t("msg.built", { n: stats.replaced, secs, mb: (bytes.length / 1048576).toFixed(1) });
    if (stats.shrunk.length) msg += t("msg.shrunk", { n: stats.shrunk.length });
    toast(msg, "ok");
    if (stats.missing) {
      toast(t("msg.fontMissing", { n: stats.missing }), "error");
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
  list.addEventListener("focusin", (e) => {
    const card = e.target.closest(".seg");
    if (card && Number(card.dataset.id) !== state.activeId) setActive(Number(card.dataset.id), { scrollViewer: true });
  });
  list.addEventListener("click", (e) => {
    const card = e.target.closest(".seg");
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = e.target.dataset.act;
    if (act === "copy") {
      navigator.clipboard?.writeText(segById(id).text).then(() => toast(t("msg.sourceCopied")));
    } else if (act === "same") {
      const ta = card.querySelector("textarea");
      ta.value = segById(id).text;
      setTranslation(id, ta.value);
      autoGrow(ta);
    } else if (act === "apply") {
      applyField(id);
    } else if (e.target.classList.contains("seg-src")) {
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
      if (saved && saved.bytes) loadBytes(saved.bytes, saved.name, false);
    });
  }
}

document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
document.addEventListener("languagechange", onLanguageChange);
init();

/* ------------------------------------------------------------ AI prompt */

function aiSegments() {
  const n = state.doc.pages.length;
  const from = Math.min(n, Math.max(1, Number($("#aiFrom").value) || 1)) - 1;
  const to = Math.min(n, Math.max(from + 1, Number($("#aiTo").value) || n)) - 1;
  return state.doc.segments.filter((s) => !s.skip && s.page >= from && s.page <= to && (!$("#aiOnlyTodo").checked || !hasTr(s.id)));
}

function aiPromptText() {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#aiTarget").value.trim() || P.target;
  const source = $("#aiSource").value.trim();
  const context = $("#aiContext").value.trim();
  const glossary = $("#aiGlossary").value.trim();
  const lines = [P.intro(source, target), "", ...P.rules];
  if (context) lines.push("", P.context(context.replace(/\.$/, "")));
  if (glossary) lines.push("", P.glossary, ...glossary.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`));
  lines.push("", P.segments);
  return lines.join("\n");
}

function refreshAiPrompt() {
  if (!state.doc) return;
  const segs = aiSegments();
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  $("#aiPrompt").value = aiPromptText();
  let msg = t("ai.stats", { n: segs.length, chars: chars.toLocaleString(LANG) });
  if (chars > 20000) msg += t("ai.tooLong");
  $("#aiStats").textContent = msg;
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
    if (!$("#aiTarget").value && $("#tgtLang").value) $("#aiTarget").value = $("#tgtLang").value;
  }
  refreshAiPrompt();
  $("#helpDialog").showModal();
  if (focusAi) $("#aiTitle").scrollIntoView({ block: "start" });
}

function initHelp() {
  $("#btnHelp").addEventListener("click", () => openHelp(false));
  $("#btnAi").addEventListener("click", () => openHelp(true));
  for (const id of ["#aiTarget", "#aiSource", "#aiFrom", "#aiTo", "#aiOnlyTodo", "#aiContext", "#aiGlossary"]) {
    $(id).addEventListener("input", refreshAiPrompt);
  }
  $("#aiCopyPrompt").addEventListener("click", () => copyText(`${aiPromptText()}\n\n${t("ai.pasteHere")}`, t("msg.promptCopied")));
  $("#aiCopyAll").addEventListener("click", () => {
    if (!state.doc) { toast(t("msg.openFirst"), "error"); return; }
    const segs = aiSegments();
    if (!segs.length) { toast(t("msg.noSelection"), "error"); return; }
    copyText(`${aiPromptText()}\n\n${Engine.exportTxt(segs)}`, t("msg.promptAllCopied", { n: segs.length }));
  });
}

initHelp();
