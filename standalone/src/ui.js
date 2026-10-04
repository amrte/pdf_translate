// ======================================================================
// User interface. The PDF engine runs in a pool of Web Workers so the page stays responsive;
// the segment list is virtualised so documents with thousands of segments stay fast.
// ======================================================================
const ENGINE_SRC = document.getElementById("engine-src").textContent;
const { Engine, createHandler, LEGACY_KINDS, LEGACY_TO_MODERN, MUPDF_URL, zipEntries, zipRead, zipWrite } = await import(URL.createObjectURL(new Blob(
  [ENGINE_SRC, "\nexport { Engine, createHandler, LEGACY_KINDS, LEGACY_TO_MODERN, MUPDF_URL, zipEntries, zipRead, zipWrite };\n"], { type: "text/javascript" })));
// Workers are classic scripts (module workers are refused on file:// pages); the engine
// loads MuPDF with a dynamic import(), which classic workers support.
const WORKER_URL = URL.createObjectURL(new Blob([ENGINE_SRC], { type: "text/javascript" }));

const $ = (sel) => document.querySelector(sel);
const LS_RECENT = "pdftr:recent"; // the documents kept for reopening: [{id, name, at, size}]
const SS_DOC = "pdftr:tab-doc"; // the document open in this tab (sessionStorage: every tab has its own)
const RECENT_MAX = 8, RECENT_BYTES = 300 * 1048576;
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
const FORMAT_LABEL = { pdf: "PDF", epub: "EPUB", fb2: "FB2", docx: "DOCX", pptx: "PPTX", xlsx: "XLSX", srt: "SRT", vtt: "VTT", md: "Markdown", txt: "TXT" };
const isOffice = () => Boolean(state.doc && ["docx", "pptx", "xlsx"].includes(state.doc.kind));
const MIME = {
  pdf: "application/pdf", epub: "application/epub+zip", fb2: "application/x-fictionbook+xml",
  srt: "application/x-subrip", vtt: "text/vtt", md: "text/markdown", txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
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
      const err = new Error(e.message || t("msg.workerStopped"));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.load = 0;
      this.dead = true;
      pool.onDead(this);
    };
  }
  call(cmd, args = {}, transfer = [], onProgress = null) {
    if (this.dead) return Promise.reject(new Error(t("msg.workerStopped")));
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
    w.ready = w.call("init", { mupdfUrl: (this.libs && this.libs.mupdfUrl) || null }); // (stored copy of MuPDF, if any)
    this.workers.push(w);
    return w;
  },
  /** Start the first worker; fall back to the page itself if module workers fail. */
  start() {
    if (!this.ready) {
      this.ready = (async () => {
        this.libs = await offlineLibs(); // the libraries stored for offline use, when the user saved them
        const first = this.spawn();
        try {
          await first.ready;
        } catch (err) {
          if (this.local) throw err;
          console.warn("Worker failed, running the engine in the page instead:", err);
          first.terminate && first.terminate();
          this.workers = [];
          this.local = true;
          this.maxSize = 1;
          const w = this.spawn();
          await w.ready;
        }
      })().catch((err) => {
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
    if (!this.workers.length) throw new Error(t("msg.engineFailed"));
  },
  /** A crashed worker is replaced, and the open document is loaded into the replacement. */
  async onDead(w) {
    const i = this.workers.indexOf(w);
    if (i < 0 || !this.ready) return;
    this.workers.splice(i, 1);
    w.terminate && w.terminate();
    const first = i === 0; // worker 0 held the editable translated document, which is lost
    try {
      const fresh = this.spawn();
      await fresh.ready;
      if (first) { this.workers.pop(); this.workers.unshift(fresh); }
      if (state.doc && state.srcBytes) await fresh.call("open", { bytes: state.srcBytes, kind: state.doc.kind });
    } catch (_) { /* no replacement: the remaining workers carry on */ }
    if (first && state.doc) {
      disposeOutput();
      setBuilt(false);
      if (state.variant === "translated") setVariant("original");
    }
    busy("");
    toast(t("msg.workerCrashed"), "error");
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
/** Open a pop-up window; the result of its previous use is forgotten first. */
function openModal(dlg) {
  dlg.returnValue = "";
  dlg.showModal();
}

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

// Known engine messages in the interface language; anything else (MuPDF's own messages) as it is.
const ERROR_KEYS = [
  [/DRM-protected/i, "err.drm"], [/not a valid (zip|\.docx)/i, "err.zip"], [/ZIP64/i, "err.zip64"],
  [/No \.fb2 file/i, "err.noFb2"], [/no package file/i, "err.noOpf"], [/XLIFF file is not valid/i, "err.xliff"],
  [/No document is open/i, "err.noDoc"], [/is encrypted and cannot be opened/i, "err.encrypted"], [/is too old/i, "err.tooOld"], [/picture format is not supported|unknown image file format/i, "err.image"], [/RAW photo without a preview/i, "err.rawPhoto"], [/OCR language data could not be loaded/i, "err.ocrLang"], [/engine worker|worker stopped/i, "msg.workerStopped"],
];
function userError(err) {
  const msg = String((err && err.message) || err || "");
  const hit = ERROR_KEYS.find(([re]) => re.test(msg));
  return hit ? t(hit[1]) : msg;
}

const stem = () => (state.doc.name || "document.pdf").replace(/\.(pdf|epub|fb2|fbz|fb2\.zip|zip|docx|pptx|xlsx|doc|xls|ppt|srt|vtt|md|markdown|txt|text|png|jpe?g|jfif|gif|bmp|tiff?|dng|webp|avif|heic|heif|hif)$/i, "") || "document";
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let saveTimer = null, storageWarned = false, persistedJson = ""; // (persistedJson: what this tab last read or wrote)
function storeTranslations() {
  if (!state.doc) return;
  try {
    const json = JSON.stringify(state.translations);
    localStorage.setItem(lsKey(state.doc.id), json);
    persistedJson = json;
  } catch (_) { // quota exceeded or private mode: say so once per document
    if (!storageWarned) { storageWarned = true; toast(t("msg.storageFull"), "error"); }
  }
}
function persist() {
  repSync(); // (header/footer members follow their lead)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; storeTranslations(); }, 400);
}
/** Write pending translation changes now (before the document changes). */
function flushPersist() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  storeTranslations();
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

async function idbPut(value, key = "last") {
  try {
    const db = await idb();
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(value, key);
    await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
  } catch (_) { /* storage unavailable: the session simply won't be restored */ }
}

async function idbDel(key) {
  try {
    const db = await idb();
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").delete(key);
    await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
  } catch (_) { /* nothing stored */ }
}

async function idbGet(key = "last") {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction("files").objectStore("files").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}

/* ------------------------------------------------------------- loading */

const isPictureFile = (f) => /\.(png|jpe?g|jfif|gif|bmp|tiff?|dng|webp|avif|heic|heif|hif)$/i.test(f.name) || /^image\//i.test(f.type);

/**
 * Several pictures (photos of a book's pages, say) opened as one PDF, a page for each, in the
 * order of their names (phones number their photos); its text is then read with OCR.
 */
async function openPictures(files) {
  if (building) { toast(t("msg.waitBuild"), "error"); return; }
  const sorted = files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  setLoading(t("msg.picturesToPdf", { n: sorted.length }));
  try {
    await pool.start();
    const list = [];
    for (const [k, f] of sorted.entries()) {
      setLoading(t("msg.picturesReading", { i: k + 1, n: sorted.length }));
      const bytes = new Uint8Array(await f.arrayBuffer()), fmt = Engine.imageKindOf(bytes);
      if (!fmt) throw new Error("This picture format is not supported.");
      list.push(ENGINE_IMAGES.includes(fmt) ? bytes : await transcodeImage(bytes));
    }
    setLoading(t("msg.picturesToPdf", { n: sorted.length }));
    const r = await pool.workers[0].call("imagesToPdf", { list });
    const name = `${sorted[0].name.replace(/\.[^.]+$/, "")}${sorted.length > 1 ? ` (+${sorted.length - 1})` : ""}.pdf`;
    if (state.doc) closeFind();
    await loadBytes(new Uint8Array(r.bytes), name, true);
    if (state.doc && state.doc.name === name) { toast(t("msg.picturesOpened", { n: sorted.length })); openOcrDialog(); }
  } catch (err) {
    setLoading("");
    toast(t("msg.openFailed", { err: userError(err) }), "error");
  } finally {
    $("#fileInput").value = "";
  }
}

async function openPdf(file, files = null) {
  if (!file) return;
  if (files && files.length > 1) {
    // several pictures: one document, a page for each; other files: the batch
    if ([...files].every(isPictureFile)) openPictures([...files]); else batchAdd(files);
    return;
  }
  if (!/\.(pdf|epub|fb2|fbz|zip|docx|pptx|xlsx|doc|xls|ppt|srt|vtt|md|markdown|txt|text|png|jpe?g|jfif|gif|bmp|tiff?|dng|webp|avif|heic|heif|hif)$/i.test(file.name) && !/pdf|epub|fictionbook|officedocument|msword|ms-excel|ms-powerpoint|^text\/|^image\//i.test(file.type)) {
    toast(t("msg.chooseFile"), "error");
    return;
  }
  if (building) { toast(t("msg.waitBuild"), "error"); return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (state.doc) closeFind(); // (another file replaces the open one)
    await loadBytes(bytes, file.name, true);
  } catch (err) {
    toast(t("msg.openFailed", { err: userError(err) }), "error");
  } finally {
    $("#fileInput").value = "";
  }
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

// Only the most recently started load may finish: a file dropped while the last session is being
// restored (or while another file loads) replaces that load instead of mixing with it.
let loadSeq = 0;

async function loadBytes(bytes, name, remember, knownId = null) {
  const seq = ++loadSeq;
  const stale = () => seq !== loadSeq;
  setLoading(t("msg.loadingEngine"));
  try {
    await pool.start();
    if (stale()) return;
    // (an unlocked PDF keeps the id of the protected file, so its translations are found again)
    const id = knownId || await sha256(bytes);
    let kind = Engine.detectKind(bytes, name), converted = null, image = null;
    const original = bytes;
    if (kind === "image") { // a picture becomes a one-page PDF; its text is read with OCR
      const fmt = Engine.imageKindOf(bytes);
      setLoading(t("msg.imageToPage"));
      const src = ENGINE_IMAGES.includes(fmt) ? bytes : await transcodeImage(bytes);
      if (stale()) return;
      const r = await pool.workers[0].call("imageToPdf", { bytes: src });
      if (stale()) return;
      bytes = r.bytes; kind = "pdf";
      // (a RAW photo is shown, and saved, as its JPEG preview; a HEIC or AVIF photo as JPEG too)
      const jpeg = fmt === "jpeg" || fmt === "dng" || Engine.imageKindOf(src) === "jpeg";
      image = { format: jpeg ? "jpeg" : "png", label: jpeg ? "JPG" : "PNG", width: r.width, height: r.height, source: original };
    }
    if (LEGACY_KINDS.has(kind)) { // Word/Excel/PowerPoint 97–2003: converted to the modern format first
      converted = { from: kind.toUpperCase(), to: LEGACY_TO_MODERN[kind].toUpperCase() };
      setLoading(t("msg.converting", converted));
      const c = await pool.workers[0].call("convert", { bytes, kind });
      if (stale()) return;
      bytes = c.bytes; kind = c.kind;
    }
    if (kind === "pdf") {
      // Password protection is removed: restrictions at once, an open password after asking.
      let password = "";
      for (;;) {
        const u = await pool.workers[0].call("unlock", { bytes, password });
        if (stale()) return;
        if (u.status === "plain") break;
        if (u.status === "unlocked") { bytes = u.bytes; toast(t("msg.unlocked"), "ok"); break; }
        setLoading("");
        password = await askPassword(name, u.status === "wrong");
        if (password === null || stale()) return;
        setLoading(t("msg.opening"));
      }
    }
    // More workers for bigger documents, fewer for huge files (each worker holds a copy).
    // An e-book is read in one worker; the others only draw its pages.
    const mb = bytes.length / 1048576;
    await pool.ensure(kind !== "pdf" ? 2 : mb > 150 ? 1 : mb > 60 ? 2 : pool.maxSize);
    if (stale()) return;
    setLoading(t("msg.opening"));
    const counts = await pool.all("open", () => ({ bytes, kind }));
    if (stale()) return;
    const pageCount = counts[0];
    const started = performance.now();
    const { pages, segments } = kind === "pdf"
      ? await extractAll(pageCount, (i, n) => { if (!stale()) setLoading(t("msg.extracting", { i, n })); })
      : (setLoading(t("msg.readingBook")), await pool.workers[0].call("extractBook"));
    if (stale()) return;
    console.info(`Extracted ${segments.length} segments from ${pageCount} pages in ${Math.round(performance.now() - started)} ms using ${pool.workers.length} worker(s)`);
    if (remember) rememberDocument(name, image ? original : bytes, id); else touchRecent(id); // (a picture is stored as it was)
    const restored = kind === "pdf" ? await restoreOcr(id, segments, pages) : { segments, ocr: null };
    if (stale()) return;
    if (kind === "pdf" && !image) restored.segments = await replaySegEdits(id, restored.segments); // splits and joins from earlier sessions
    if (stale()) return;
    openDocument({ id, name, kind, pages, segments: restored.segments, ocr: restored.ocr, image }, bytes);
    state.segEdits = kind === "pdf" ? loadSegEdits(id) : [];
    if (converted) toast(t("msg.converted", converted));
    if (image && !restored.ocr) { toast(t("msg.imageOpened", { fmt: image.label })); openOcrDialog(); } else suggestOcr();
  } catch (err) {
    if (stale()) return;
    console.error(err);
    toast(t("msg.openFailed", { err: userError(err) }), "error");
  } finally {
    if (!stale()) setLoading("");
  }
}

/** Pictures the engine reads itself (orientation, RAW preview included); others are decoded by the browser. */
const ENGINE_IMAGES = ["jpeg", "png", "gif", "bmp", "tiff", "dng"];

/** HEIC/HEIF decoder for browsers that cannot show these photos (all but Safari), loaded on first use. */
const HEIF_LIB = "https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.mjs";
let heifLib = null;

/** An iPhone photo (HEIC) decoded with libheif: an ImageBitmap of its first (main) picture. */
async function decodeHeif(bytes) {
  if (!heifLib) {
    setLoading(t("msg.heicLoading"));
    const mod = await import(HEIF_LIB);
    const lib = (mod.default || mod)();
    if (!lib.HeifDecoder && lib.ready) await lib.ready;
    heifLib = lib;
  }
  const images = new heifLib.HeifDecoder().decode(bytes);
  if (!images || !images.length) throw new Error("This picture format is not supported.");
  const img = images[0], w = img.get_width(), h = img.get_height();
  const data = new ImageData(w, h);
  await new Promise((resolve, reject) => img.display(data, (out) => (out ? resolve() : reject(new Error("HEIF processing error")))));
  for (const x of images) x.free && x.free();
  return createImageBitmap(data);
}

/** Decode a picture the engine cannot read (WebP, AVIF, HEIC) in the browser and return it as PNG. */
async function transcodeImage(bytes) {
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes])); } catch (_) {
    if (Engine.imageKindOf(bytes) !== "heic") throw new Error("This picture format is not supported.");
    try { bmp = await decodeHeif(bytes); } catch (err) { console.warn("heic", err); throw new Error("This picture format is not supported."); }
  }
  try {
    // A photo (HEIC, AVIF, a lossy WebP) becomes a JPEG – as PNG a phone photo would take ten
    // times the space, in the page and in every PDF made from it; other pictures a PNG.
    const photo = isPhotoFormat(bytes);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height), ctx = canvas.getContext("2d");
    if (photo) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, bmp.width, bmp.height); }
    ctx.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob(photo ? { type: "image/jpeg", quality: 0.92 } : { type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bmp.close && bmp.close();
  }
}

/** Whether a picture the browser decodes is a photo, kept as JPEG (see transcodeImage): HEIC, AVIF, WebP without transparency or lossless data. */
function isPhotoFormat(bytes) {
  const fmt = Engine.imageKindOf(bytes);
  if (fmt === "heic" || fmt === "avif") return true;
  if (fmt !== "webp") return false;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 ") return true; // lossy
  if (chunk === "VP8X") return !(bytes[20] & 0x10) && !String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 4096))).includes("VP8L"); // (no alpha, not lossless)
  return false;
}

/** The translated picture: the finished page rendered at the picture's pixel size, as PNG or JPEG. */
async function imageBlob(pdfBytes) {
  const img = state.doc.image, page = state.doc.pages[0];
  const zoom = img.width / page.width;
  const png = await pool.workers[0].call("renderBytes", { bytes: pdfBytes.slice(), page: 0, zoom });
  const blob = new Blob([png], { type: "image/png" });
  if (img.format !== "jpeg") return { blob, ext: "png" };
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height), ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, bmp.width, bmp.height); // JPEG has no transparency
    ctx.drawImage(bmp, 0, 0);
    return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 }), ext: "jpg" };
  } finally {
    bmp.close && bmp.close();
  }
}

/** Start (or, after a failure, restart) the engine; without internet the start page offers the stored libraries. */
function startEngine() {
  const status = $("#engineStatus");
  status.hidden = false;
  status.classList.remove("error");
  status.innerHTML = `<div class="spinner"></div> <span>${escapeHtml(t("upload.engine"))}</span>`;
  $("#engineOffline").hidden = true;
  if (pool.ready === null) { for (const w of pool.workers) w.terminate && w.terminate(); pool.workers = []; }
  return pool.start().then(() => { status.hidden = true; }).catch((err) => {
    status.textContent = err.message;
    status.classList.add("error");
    $("#engineOffline").hidden = false;
  });
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
  flushPersist();
  disposeOutput();
  setCompare(false);
  resetToolsState();
  storageWarned = false;
  state.doc = doc;
  state.srcBytes = bytes;
  state.variant = "original";
  state.activeId = null;
  state.shrunk = new Set();
  segIndex.clear();
  for (const s of doc.segments) segIndex.set(s.id, s);
  try {
    persistedJson = localStorage.getItem(lsKey(doc.id)) || "{}";
    state.translations = JSON.parse(persistedJson);
  } catch (_) {
    state.translations = {};
    persistedJson = "";
  }
  try { sessionStorage.setItem(SS_DOC, doc.id); } catch (_) { /* no session storage: no restore on reload */ }
  rep.open.clear();
  repSetup();
  repSync();
  $("#uploadView").hidden = true;
  $("#workView").hidden = false;
  $("#btnNew").hidden = false;
  document.dispatchEvent(new CustomEvent("kameleon:document"));
  $("#btnClose").hidden = false;
  $("#docName").textContent = doc.name;
  $("#docName").title = doc.name;
  document.body.classList.toggle("is-book", isBook());
  document.body.classList.toggle("is-office", isOffice());
  document.body.classList.toggle("is-image", Boolean(doc.image));
  document.body.classList.toggle("has-pages", pagesSupported());
  document.body.classList.toggle("is-pptx", doc.kind === "pptx");
  picDocumentChanged();
  accentFromDocument(); // the chameleon takes the colour of the document
  setDocFormat(doc.image ? doc.image.label : FORMAT_LABEL[doc.kind || "pdf"]);
  document.title = `${doc.name} · Kameleon`;

  loadOverrides();
  loadKinds();
  loadRotations();
  kwLoad();
  fillPageFilter();
  $("#search").value = "";
  $("#filterStatus").value = "all";

  state.zoom = fitZoom();
  state.fitMode = doc.image ? "page" : true; // (a picture stays whole when the view is resized)
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
  setCompare(false);
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
  $("#btnFullscreen").title = t(document.body.classList.contains("viewer-only") ? "view.exitFullscreen" : "view.fullscreen");
  updateFindCount();
  if ($("#helpDialog").open) refreshAiPrompt();
}

function closeDocument() {
  queueMicrotask(() => document.dispatchEvent(new CustomEvent("kameleon:document")));
  restoreStartAccent(); // back to the colour of this start
  flushPersist();
  closeFind();
  setCompare(false);
  resetToolsState();
  disposeOutput();
  loadSeq++; // (a load that is still running belongs to no document any more)
  state.doc = null;
  state.srcBytes = null;
  state.translations = {};
  state.activeId = null;
  state.shrunk = new Set();
  state.markups = [];
  state.overrides = {};
  state.kinds = {};
  state.segEdits = [];
  state.rotations = {};
  segIndex.clear();
  resetHistory();
  busy("");
  try { sessionStorage.removeItem(SS_DOC); } catch (_) { /* ignore */ }
  pool.all("close").catch(() => {});
  observer.disconnect();
  clearImageCache();
  $("#pages").innerHTML = "";
  vl.reset();
  $("#workView").hidden = true;
  $("#uploadView").hidden = false;
  $("#btnNew").hidden = true;
  $("#btnClose").hidden = true;
  $("#docName").textContent = "";
  document.title = "Kameleon";
  document.body.classList.remove("is-book", "is-office", "is-image", "has-pages", "is-pptx");
  picDocumentChanged();
  setDocFormat("PDF");
}

/* --------------------------------------------------------------- viewer */

/** Horizontal room the page view keeps beside a page (its 6 px padding on each side). */
const PAGE_SIDE = 12;

function fitZoom() {
  if (state.doc.image) return fitPictureZoom();
  const avail = $("#pages").clientWidth - PAGE_SIDE;
  const widest = Math.max(...state.doc.pages.map((p, i) => (state.rotations[i] % 180 ? p.height : p.width)));
  const z = Math.floor((avail / (widest * 1.25)) * 10) / 10;
  return Math.min(1.5, Math.max(0.4, z || 1));
}

/**
 * A picture is shown whole: as large as fits the viewer in width and height (small pictures are
 * enlarged up to twice their size, large ones reduced as far as needed).
 */
function fitPictureZoom() {
  const box = $("#pages"), p = state.doc.pages[0];
  const [w, h] = state.rotations[0] % 180 ? [p.height, p.width] : [p.width, p.height];
  const z = Math.min((box.clientWidth - PAGE_SIDE) / (w * 1.25), (box.clientHeight - 44) / (h * 1.25));
  return z > 0 ? Math.max(0.02, Math.min(2, Math.floor(z * 1000) / 1000)) : 1;
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
    `<div class="page" data-page="${i}"><span class="page-label">${t("page.n", { n: i + 1 })}</span><div class="page-body"><img alt="${t("page.n", { n: i + 1 })}"></div></div>`).join("");
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
  refreshCmp(true);
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
    const active = s.id === state.activeId, custom = fieldsEditable() && state.overrides[s.id] && state.overrides[s.id].bbox;
    const cls = "box" + (hasTr(s.id) ? " done" : "") + (s.skip ? " skip" : "") + (active ? " active" : "") + (custom ? " custom" : "");
    return `<div class="${cls}" data-id="${s.id}" title="#${s.id}" style="left:${((x0 - page.x0) / page.width) * 100}%;top:${((y0 - page.y0) / page.height) * 100}%;width:${((x1 - x0) / page.width) * 100}%;height:${((y1 - y0) / page.height) * 100}%">${active && fieldsEditable() ? HANDLES : ""}</div>`;
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
  refreshCmp();
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

/**
 * The smallest zoom: 25 %, or less when a page is so large (a photo at its own resolution, a
 * poster) that 25 % would still not show it whole – fit-to-width and fit-page must always be
 * reachable.
 */
function zoomMin() {
  if (!state.doc) return ZOOM_MIN;
  const box = $("#pages");
  let fit = ZOOM_MIN;
  viewPages().forEach((_, i) => {
    const [w, h] = shownSize(i);
    fit = Math.min(fit, (box.clientWidth - PAGE_SIDE) / (w * 1.25), (box.clientHeight - 44) / (h * 1.25));
  });
  return Math.max(0.02, Math.min(ZOOM_MIN, Math.floor(fit * 1000) / 1000));
}
let zoomRenderTimer = null;

/**
 * Change the zoom, keeping the point under `anchor` (viewer coordinates; default: the centre
 * of the viewer) in place. Page images are re-rendered once zooming pauses.
 */
function setZoom(z, anchor) {
  const box = $("#pages");
  state.fitMode = false;
  z = Math.min(ZOOM_MAX, Math.max(zoomMin(), Math.round(z * 1000) / 1000)); // (tenths of a percent: on a huge page a whole percent is dozens of pixels)
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
  if (cmp.on) { $("#pagesCmp").querySelectorAll(".cpage").forEach(sizeCmpPage); syncCmp("main"); }
  $("#zoomLabel").textContent = `${Math.round(z * 100)}%`;
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(refreshImages, 180);
}

function fitWidth() {
  const box = $("#pages");
  const widest = Math.max(...viewPages().map((p, i) => shownSize(i)[0]));
  setZoom((box.clientWidth - (cmp.on ? 10 : PAGE_SIDE)) / (widest * 1.25));
  state.fitMode = true; // (follows the width when the view is resized)
}

/* ------------------------------------------------- virtualised segment list */

const segIndex = new Map();
const segById = (id) => segIndex.get(Number(id));

/** Segments that need a translation (not numbers/dates only). */
const translatable = () => state.doc.segments.filter((s) => !s.skip && !repHidden(s.id)); // (a header/footer group once)

function segMeta(s) {
  const page = t("meta.page", { n: s.page + 1 });
  if (s.skip) return `${page} · ${t(s.formula ? "meta.formula" : "meta.numbers")}${s.edited ? " · " + t("meta.corrected") : ""}`;
  if (isBook()) return s.hidden ? `${t("meta.notShown")} · ${s.tag}` : `${page} · ${s.notes ? t("meta.notes") : s.tag}`;
  if (s.ocr) {
    const unsure = unsureWords(s).length;
    return `${page} · OCR · ${Math.round(s.size * 10) / 10}pt${s.bold ? " " + t("meta.bold") : ""}${s.edited ? " · " + t("meta.corrected") : ""}${unsure ? " · " + t("meta.unsure", { n: unsure }) : ""}`;
  }
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
      ${!fieldsEditable() ? "" : `<button type="button" class="mini${state.overrides[id] ? " on" : ""}" data-act="style" title="${escapeHtml(t("card.styleTitle"))}">Aa</button>`}
      ${!kindsEditable() ? "" : `<button type="button" class="mini kind${state.kinds[id] ? " on" : ""}" data-act="kind" title="${escapeHtml(t(s.skip ? "card.asTextTitle" : "card.asFormulaTitle"))}">${t(s.skip ? "card.asText" : "card.asFormula")}</button>`}
      ${!repSupported() || s.skip || repGroup(id) ? "" : `<button type="button" class="mini" data-act="repMake" title="${escapeHtml(t("rep.makeTitle"))}">⧉</button>`}
      ${!s.ocr || isBook() ? "" : `<button type="button" class="mini" data-act="editSrc" title="${escapeHtml(t("card.editSrcTitle"))}">✎</button>`}
      ${!segEditable(s) ? "" : `${s.lines > 1 ? `<button type="button" class="mini" data-act="split" title="${escapeHtml(t("card.splitTitle"))}">✂</button>` : ""}<button type="button" class="mini" data-act="join" title="${escapeHtml(t("card.joinTitle"))}">⤵</button>`}
      <button type="button" class="mini apply" data-act="apply" title="${escapeHtml(t("card.applyTitle"))}">${t("card.apply")}</button>
    </div>
    ${repCardHtml(id)}
    ${styleOpen.has(id) && !isBook() ? stylePanelHtml(s) : ""}
    <div class="seg-src">${srcHtml(s)}</div>
    <textarea rows="1" spellcheck="true" placeholder="${escapeHtml(t(repLocked(id) ? (repGroup(id).mode === "keep" ? "rep.keepPlaceholder" : "rep.oncePlaceholder") : "card.placeholder", { n: repGroup(id)?.lead }))}" aria-label="${escapeHtml(t("card.aria", { n: id }))}"${repLocked(id) ? " readonly" : ""}></textarea>`;
  if (repGroup(id)) el.classList.add(repLocked(id) ? "rep-locked" : "rep-lead");
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
  if (state.doc) for (const s of state.doc.segments) if (!s.skip && !repHidden(s.id)) { total++; if (hasTr(s.id)) done++; }
  $("#progressText").textContent = t("progress", { done, total });
  $("#progressBar").style.width = total ? `${(done / total) * 100}%` : "0";
}


function applyFilter() {
  if (!state.doc) return;
  // (the search field: the same text and options as the highlighted matches)
  const re = findRegex(), scope = $("#findScope").value;
  const hit = (text) => { re.lastIndex = 0; return re.test(text); };
  const status = $("#filterStatus").value;
  const page = $("#filterPage").value === "all" ? null : Number($("#filterPage").value);
  const ids = [];
  for (const s of state.doc.segments) {
    if (page !== null && s.page !== page) continue;
    if (status === "numbers" ? !s.skip : s.skip) continue; // numbers-only segments have their own filter
    if (status !== "numbers" && repHidden(s.id) && repGroup(s.id).lead !== s.id) continue; // (an open group shows them after its lead)
    if (status === "repeats" && !repGroup(s.id)) continue;
    if (status === "unsure" && !unsureWords(s).length) continue;
    if ((status === "todo" || status === "done") && (status === "done") !== hasTr(s.id)) continue;
    if (re && !((scope !== "tr" && hit(s.text)) || (scope !== "src" && hit(state.translations[s.id] || "")))) continue;
    ids.push(s.id);
  }
  const listed = status === "numbers" ? ids : repListIds(ids);
  $('#filterStatus option[value="repeats"]').hidden = !rep.groups.length;
  $('#filterStatus option[value="unsure"]').hidden = !state.doc.ocr;
  $("#segments").classList.toggle("is-empty", !listed.length);
  $("#segments").dataset.empty = state.doc.segments.length ? t("filter.empty") : t("filter.noText");
  vl.setIds(listed);
}

function setActive(id, { scrollList = false, scrollViewer = false, focus = false } = {}) {
  if (state.activeId !== null) {
    vl.rendered.get(state.activeId)?.classList.remove("active");
    document.querySelectorAll(`.box[data-id="${state.activeId}"]`).forEach((b) => b.classList.remove("active"));
  }
  state.activeId = id;
  if (scrollList || focus) {
    if (!vl.pos.has(id) && repReveal(id)) applyFilter(); // (a header/footer page: its group opens)
    if (!vl.pos.has(id)) {
      $("#search").value = ""; $("#filterStatus").value = segById(id).skip ? "numbers" : "all"; $("#filterPage").value = "all";
      applyFilter();
      refreshFind(); // (the search no longer applies)
    }
    if (scrollList) vl.scrollTo(id);
  }
  vl.rendered.get(id)?.classList.add("active");
  const s = segById(id);
  ensureBoxes(boxPage(s));
  const box = document.querySelector(`.box[data-id="${id}"]`);
  document.querySelectorAll(`.box[data-id="${id}"]`).forEach((b) => b.classList.add("active"));
  cmpMarkActive(id);
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
  cmpMarkActive(null);
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
    $("#pasteArea").dataset.fallback = "1"; // (cleared again unless the user imports on purpose)
    openModal($("#importDialog"));
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
    toast(t("msg.exportFailed", { err: userError(err) }), "error");
  }
}

function mergeImported(parsed, overwrite = $("#importOverwrite").checked) {
  const ids = Object.keys(parsed).map(Number);
  const matched = ids.filter((id) => segIndex.has(id));
  const unknown = ids.length - matched.length;
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
  if ($("#helpDialog").open) { aiImportNote(msg); refreshAiPrompt(); } // the AI window shows the result beside its paste field
  return applied;
}

async function importFile(file, overwrite) {
  if (!file) return;
  $("#importDialog").close();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.txt$/i.test(file.name)) mergeImported(Engine.parseMarkedText(kwExtract(new TextDecoder().decode(bytes))), overwrite); // (a keyword list may be in it)
    else mergeImported(await Engine.parseImport(file.name, bytes), overwrite);
  } catch (err) {
    toast(t("msg.readFailed", { file: file.name, err: err.message }), "error");
  } finally {
    $("#importFile").value = "";
    $("#aiFile").value = "";
  }
}

function importPasted(area = $("#pasteArea"), overwrite) {
  const text = area.value;
  if (!text.trim()) { toast(t("msg.pasteFirst"), "error"); return; }
  mergeImported(Engine.parseMarkedText(kwExtract(text)), overwrite);
  area.value = "";
}

/** The AI window: the result of the last import, shown next to the paste field. */
function aiImportNote(msg) {
  const el = $("#aiImportStatus");
  if (el) el.textContent = msg;
}

/* ---------------------------------------------------------------- build */

function setBuilt(built) {
  $("#viewTranslated").disabled = !built;
  $("#viewCompare").disabled = !built;
  updateDownloadButton();
  updateProgress();
}

async function downloadOutput() {
  try {
    // (the copy saved by the build has no markups and no turned pages: those are added on saving)
    // (a recognised scan also gets its text layer on saving)
    const extras = (state.markups && state.markups.length) || (!isBook() && Object.keys(state.rotations).length) || (state.doc.ocr && !isBook());
    if (!state.outBytes || state.outDirty || extras) {
      busy(t("msg.saving"));
      state.outBytes = await pool.workers[0].call("save", { markups: state.markups, rotations: isBook() ? {} : state.rotations, layer: ocrTextLayer(true) });
      state.outDirty = false;
    }
    if (state.doc.image) { // a picture goes out as a picture again
      const { blob, ext } = await imageBlob(state.outBytes);
      saveBlob(blob, `${stem()}.translated.${ext}`);
      return;
    }
    const kind = state.doc.kind || "pdf";
    const type = MIME[kind];
    saveBlob(new Blob([state.outBytes], { type }), `${stem()}.translated.${kind}`);
  } catch (err) {
    toast(t("msg.saveFailed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

/**
 * An opened picture, or a recognised scan, saved as a PDF: the version shown – the translation
 * (in the translated or comparison view, once built) or the original – with markups and turns,
 * and searchable: the recognised text lies invisibly under the picture (untranslated text only,
 * in the translation).
 */
async function downloadPicturePdf(compact = false) {
  if (!state.doc || !(state.doc.image || state.doc.ocr) || isBook()) return;
  const translated = state.hasOutput && (state.variant === "translated" || (typeof cmp !== "undefined" && cmp.on));
  try {
    busy(t("msg.saving"));
    const bytes = await pool.workers[0].call("save", { markups: state.markups, rotations: state.rotations, original: !translated, layer: ocrTextLayer(translated), compact });
    saveBlob(new Blob([bytes], { type: "application/pdf" }), `${stem()}${translated ? ".translated" : ""}.pdf`);
  } catch (err) {
    toast(t("msg.saveFailed", { err: userError(err) }), "error");
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
  openModal($("#biDialog"));
}

async function downloadBilingual(layout = "pages") {
  try {
    busy(t("msg.saving"));
    const kind = state.doc.kind || "pdf";
    const bytes = kind === "pdf"
      ? await pool.workers[0].call("saveBilingual", { markups: state.markups, rotations: state.rotations, layout })
      : await pool.workers[0].call("saveBilingual", { segments: state.doc.segments, translations: state.applied, opts: buildOptions() });
    const type = MIME[kind];
    saveBlob(new Blob([bytes], { type }), `${stem()}.bilingual.${kind}`);
  } catch (err) {
    toast(t("msg.saveFailed", { err: userError(err) }), "error");
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
      if (cmp.on) { cmp.places.cmp = cmpPlaces("cmp"); cmpQueue(s.page); } else if (state.variant !== "translated") setVariant("translated"); else queueRender(s.page);
      ensureBoxes(s.page);
      document.querySelector(`.box[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (stats.missing) toast(t("msg.fontMissing", { n: stats.missing, chars: stats.missingChars }), "error");
    } catch (err) {
      toast(t("msg.updateFailed", { err: userError(err) }), "error");
    }
  });
  return applyChain;
}

/** E-books are rebuilt as a whole (in well under a second) with the applied translations. */
async function applyBook(id) {
  try {
    busy(t("msg.updating"));
    const { bytes, view } = await pool.workers[0].call("build", { segments: state.doc.segments.map(effSeg), translations: state.applied, opts: buildOptions() });
    state.outBytes = bytes;
    state.outView = view;
    state.hasOutput = true;
    state.outDirty = false;
    state.buildNo++;
    for (const [x, el] of vl.rendered) el.classList.toggle("pending", isPending(x));
    setBuilt(true);
    if (cmp.on) refreshCmp(true); else if (state.variant !== "translated") setVariant("translated"); else renderPages();
    const page = boxPage(segById(id));
    ensureBoxes(page);
    const box = document.querySelector(`.box[data-id="${id}"]`);
    if (box) box.scrollIntoView({ block: "center", behavior: "smooth" }); else goToPage(page);
  } catch (err) {
    toast(t("msg.updateFailed", { err: userError(err) }), "error");
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
    for (const [id, text] of Object.entries(state.translations)) if (segIndex.has(Number(id)) && text.trim()) translations[id] = text;
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
    if (cmp.on) refreshCmp(true);
    else {
      if (isBook() && state.variant === "translated") { state.variant = "original"; } // force the page list to be rebuilt
      setVariant("translated");
    }
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    let msg = t("msg.built", { n: stats.replaced, secs, mb: (bytes.length / 1048576).toFixed(1) });
    if (stats.shrunk.length) msg += t("msg.shrunk", { n: stats.shrunk.length });
    toast(msg, "ok");
    if (stats.fontsDropped) toast(t("msg.fontsDropped", { n: stats.fontsDropped }));
    if (stats.missing) {
      toast(t("msg.fontMissing", { n: stats.missing, chars: stats.missingChars }), "error");
    }
  } catch (err) {
    console.error(err);
    toast(t("msg.buildFailed", { err: userError(err) }), "error");
  } finally {
    building = false;
    busy("");
    pump();
  }
}

async function chooseFont(file) {
  if (!file) return;
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (err) { toast(t("msg.openFailed", { err: userError(err) }), "error"); return; }
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
  zone.addEventListener("drop", (e) => {
    e.stopPropagation();
    zone.classList.add("bite"); // the chameleon snaps at the dropped file
    setTimeout(() => zone.classList.remove("bite"), 700);
    onFile(e.dataTransfer.files[0], e.dataTransfer.files);
  });
}

// The workflow on the start page can be folded. The first start shows it; from the second start
// on it is folded, unless the user unfolded it the last time (the choice is remembered).
const LS_WF = "pdftr:wf-folded";
function initWorkflowFold() {
  let folded = false;
  try {
    const v = localStorage.getItem(LS_WF);
    if (v === null) localStorage.setItem(LS_WF, "1"); // first start: open now, folded next time
    else folded = v === "1";
  } catch (_) { /* storage blocked: always open */ }
  const apply = () => {
    $("#wfStart").classList.toggle("folded", folded);
    $("#wfFold").setAttribute("aria-expanded", String(!folded));
  };
  apply();
  $("#wfFold").addEventListener("click", () => {
    folded = !folded;
    apply();
    try { localStorage.setItem(LS_WF, folded ? "1" : "0"); } catch (_) { /* storage blocked */ }
  });
}

function init() {
  setupDropzone($("#dropzone"), openPdf);
  $("#fileInput").addEventListener("change", (e) => openPdf(e.target.files[0], e.target.files));
  // "Open another file" picks the new file at once (cancelling keeps the open one); ✕ closes it.
  $("#btnNew").addEventListener("click", () => $("#fileInput").click());
  $("#btnClose").addEventListener("click", closeDocument);
  // The workflow overview of the start page is shown in Help too.
  $("#wfHelp").innerHTML = $("#wfStart").innerHTML.replace(' id="wfTitle"', "").replace(' id="wfFold"', "").replace(' id="wfFlow"', "");
  applyI18n($("#wfHelp"));
  initWorkflowFold();

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && !document.querySelector("dialog[open]")) openPdf(file); // (every supported format)
  });

  $("#viewOriginal").addEventListener("click", () => { setCompare(false); setVariant("original"); });
  $("#viewTranslated").addEventListener("click", () => { setCompare(false); setVariant("translated"); });
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
    if (e.target.matches("select[data-rep-mode]")) { repSetMode(Number(e.target.closest(".seg").dataset.id), e.target.value); return; }
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
      navigator.clipboard?.writeText(segById(id).text).then(() => toast(t("msg.sourceCopied"))).catch(() => toast(t("msg.noClipboard"), "error"));
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
      repApplyMembers(id);
    } else if (act === "repOpen") {
      repToggleOpen(id);
    } else if (act === "repAll") {
      repSetAll(id);
    } else if (act === "repDrop") {
      repDrop(id);
    } else if (act === "repMake") {
      repMakeGroup(id);
    } else if (act === "style") {
      if (styleOpen.has(id)) styleOpen.delete(id); else styleOpen.add(id);
      refreshStylePanel(id);
    } else if (act === "kind") {
      toggleKind(id);
    } else if (act === "split") {
      openSplitDialog(id);
    } else if (act === "join") {
      joinWithNext(id);
    } else if (act === "editSrc") {
      openSrcDialog(id);
    } else if (e.target.closest(".seg-src")) { // (also on a highlighted search match)
      setActive(id, { scrollViewer: true, focus: true });
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { // update this field in the PDF
      e.preventDefault();
      applyField(Number(e.target.closest(".seg").dataset.id));
      repApplyMembers(Number(e.target.closest(".seg").dataset.id));
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
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchChanged, 150); });
  $("#filterStatus").addEventListener("change", applyFilter);
  $("#filterPage").addEventListener("change", (e) => {
    applyFilter();
    if (e.target.value !== "all") document.querySelector(`.page[data-page="${e.target.value}"]`)?.scrollIntoView({ behavior: "smooth" });
  });

  // Cancel buttons are plain buttons, so Enter in a text field submits the dialog with OK.
  document.querySelectorAll('dialog.modal button[type="button"][value="cancel"]').forEach((b) =>
    b.addEventListener("click", () => b.closest("dialog").close("cancel")));
  $("#btnExport").addEventListener("click", () => openModal($("#exportDialog")));
  $("#exportDialog").addEventListener("close", () => { if ($("#exportDialog").returnValue === "ok") doExport(); });
  $("#btnCopy").addEventListener("click", copyAll);
  $("#btnClear").addEventListener("click", clearAllTranslations);
  for (const sel of ["#tgtLang", "#aiTarget"]) {
    $(sel).addEventListener("input", (e) => { e.target.dataset.userSet = e.target.value.trim() ? "1" : ""; });
  }
  applyLanguageDefaults();

  $("#btnImport").addEventListener("click", () => openModal($("#importDialog")));
  setupDropzone($("#importDrop"), importFile);
  $("#importFile").addEventListener("change", (e) => importFile(e.target.files[0]));
  $("#importDialog").addEventListener("close", () => {
    const fallback = $("#pasteArea").dataset.fallback;
    delete $("#pasteArea").dataset.fallback;
    if ($("#importDialog").returnValue === "ok") importPasted();
    else if (fallback) $("#pasteArea").value = ""; // the copied source text is not an import
  });

  $("#btnDownload").addEventListener("click", (e) => { e.preventDefault(); downloadOutput(); });
  // The PDF of a picture or scan: in full quality or compact (the pictures smaller, see compactImages).
  $("#btnPicPdf").addEventListener("click", (e) => {
    e.preventDefault();
    const translated = state.hasOutput && (state.variant === "translated" || (typeof cmp !== "undefined" && cmp.on));
    $("#pdfText").textContent = t(translated ? "pdf.textTranslated" : "pdf.text");
    let last = "full";
    try { last = localStorage.getItem("pdftr:pdf-size") || "full"; } catch (_) { /* storage blocked */ }
    openModal($("#pdfDialog"));
    $(`#pdfDialog button[value="${last}"]`).focus();
  });
  $("#pdfDialog").addEventListener("close", () => {
    const v = $("#pdfDialog").returnValue;
    if (v !== "full" && v !== "compact") return;
    try { localStorage.setItem("pdftr:pdf-size", v); } catch (_) { /* storage blocked */ }
    downloadPicturePdf(v === "compact");
  });
  $("#btnBuild").addEventListener("click", () => {
    $("#fontUploadRow").hidden = $("#fontMode").value !== "custom";
    openModal($("#buildDialog"));
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

  // Start the engine right away. A reloaded tab gets its own document back; a new tab shows the
  // start page with the recently opened documents, so several files can be open side by side.
  startEngine();
  $("#recentList").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("recent-x")) forgetDocument(b.dataset.id); else openRecent(b.dataset.id);
  });
  window.addEventListener("storage", onStorageFromOtherTab);
  migrateLastDocument().then(() => {
    renderRecent();
    let tabDoc = null;
    try { tabDoc = sessionStorage.getItem(SS_DOC); } catch (_) { /* ignore */ }
    if (!tabDoc) return;
    idbGet(`doc:${tabDoc}`).then((saved) => { // (unless the user has opened a file in the meantime)
      if (saved && saved.bytes && !loadSeq && !state.doc) loadBytes(saved.bytes, saved.name, false, saved.id);
    });
  });
}

/* ---------------------------------------------------------- recent documents */

function readRecent() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch (_) { return []; }
}
function writeRecent(list) {
  try { localStorage.setItem(LS_RECENT, JSON.stringify(list)); } catch (_) { /* storage blocked */ }
}

/** Keep a document for reopening (IndexedDB), newest first; the oldest go when the list is full. */
async function rememberDocument(name, bytes, id) {
  await idbPut({ name, bytes, id }, `doc:${id}`);
  const list = readRecent().filter((r) => r.id !== id);
  list.unshift({ id, name, at: Date.now(), size: bytes.length });
  const keep = [], drop = [];
  let total = 0;
  for (const r of list) { total += r.size || 0; (keep.length < RECENT_MAX && total <= RECENT_BYTES ? keep : drop).push(r); }
  writeRecent(keep);
  for (const r of drop) idbDel(`doc:${r.id}`);
  renderRecent();
}

function touchRecent(id) {
  const list = readRecent(), i = list.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [r] = list.splice(i, 1);
  list.unshift({ ...r, at: Date.now() });
  writeRecent(list);
  renderRecent();
}

async function forgetDocument(id) {
  writeRecent(readRecent().filter((r) => r.id !== id));
  await idbDel(`doc:${id}`);
  renderRecent();
}

async function openRecent(id) {
  const saved = await idbGet(`doc:${id}`);
  if (!saved || !saved.bytes) { toast(t("recent.gone"), "error"); forgetDocument(id); return; }
  loadBytes(saved.bytes, saved.name, false, saved.id);
}

function renderRecent() {
  const list = readRecent(), box = $("#recent");
  if (!box) return;
  box.hidden = !list.length;
  $("#recentList").innerHTML = list.map((r) => `<span class="recent-item"><button type="button" class="recent-open" data-id="${r.id}" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button><button type="button" class="recent-x" data-id="${r.id}" title="${escapeHtml(t("recent.remove"))}" aria-label="${escapeHtml(t("recent.remove"))}">×</button></span>`).join("");
}

/** Earlier versions kept one "last" document: it becomes the first entry of the list. */
async function migrateLastDocument() {
  const legacy = await idbGet("last");
  if (!legacy || !legacy.bytes || !legacy.id) return;
  await rememberDocument(legacy.name || "document.pdf", legacy.bytes, legacy.id);
  await idbDel("last");
  try { localStorage.removeItem("pdftr:last"); } catch (_) { /* ignore */ }
}

/**
 * The same document in two tabs: when the other tab saves its translations, the segments it
 * changed are taken over here (this tab's own unsaved edits stay and are saved as usual).
 */
function onStorageFromOtherTab(e) {
  if (!state.doc || e.key === null) { if (e.key === LS_RECENT) renderRecent(); return; }
  if (e.key === LS_RECENT) { renderRecent(); return; }
  if (e.key !== lsKey(state.doc.id) || e.newValue === null || e.newValue === persistedJson) return;
  let incoming, base;
  try { incoming = JSON.parse(e.newValue); base = JSON.parse(persistedJson || "{}"); } catch (_) { return; }
  let changed = 0;
  for (const id of new Set([...Object.keys(incoming), ...Object.keys(base)])) {
    if ((incoming[id] || "") === (base[id] || "")) continue; // not touched by the other tab
    if ((state.translations[id] || "") === (incoming[id] || "")) continue;
    if (incoming[id]) state.translations[id] = incoming[id]; else delete state.translations[id];
    changed++;
  }
  persistedJson = e.newValue;
  if (!changed) return;
  refreshCards();
  updateProgress();
  toast(t("msg.syncedTabs", { n: changed }));
}


/* ------------------------------------------------------------ AI prompt */

function aiSegments() {
  const n = state.doc.pages.length;
  const from = Math.min(n, Math.max(1, Number($("#aiFrom").value) || 1)) - 1;
  const to = Math.min(n, Math.max(from + 1, Number($("#aiTo").value) || n)) - 1;
  return state.doc.segments.filter((s) => !s.skip && !repHidden(s.id) && s.page >= from && s.page <= to && (!$("#aiOnlyTodo").checked || !hasTr(s.id)) && (!s.hiddenSlide || $("#aiHidden").checked) && (!s.notes || $("#aiNotes").checked));
}

/** The selected segments split into parts of "Fields per part" (numbers stay global). */
function aiParts() {
  const segs = aiSegments();
  const size = Math.max(20, Number($("#aiPartSize").value) || 1000);
  // Parts follow the marker numbers: with 500 per part, part 1 holds [[1]]–[[500]], part 2
  // [[501]]–[[1000]] … (skipped segments keep their numbers, so a part may hold fewer segments).
  const parts = [];
  let cur = null, bucket = -1;
  for (const s of segs) {
    const k = Math.floor((s.id - 1) / size);
    if (k !== bucket) { bucket = k; cur = []; parts.push(cur); }
    cur.push(s);
  }
  return parts;
}

function aiPromptText(part) {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#aiTarget").value.trim() || P.target;
  const context = $("#aiContext").value.trim();
  const glossary = $("#aiGlossary").value.trim();
  const lines = [P.intro(target), "", ...(isOffice() ? P.officeRules : isBook() ? P.bookRules : P.rules)];
  if (context) lines.push("", P.context(context.replace(/\.$/, "")));
  if (glossary) lines.push("", P.glossary, ...glossary.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`));
  if (part && part.total > 1) lines.push("", P.part(part.k, part.total, part.a, part.b));
  if ($("#aiKeywords").checked) lines.push("", ($("#aiExamples").checked ? P.keywordsEx : P.keywords)(Math.max(1, Math.min(100, Number($("#aiKeywordCount").value) || 10))));
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
  // A part is "done" once every one of its segments has a translation (its answer was imported).
  const dones = parts.map((p) => p.every((s) => hasTr(s.id)));
  const lastId = state.doc.segments.length ? state.doc.segments[state.doc.segments.length - 1].id : 0;
  $("#aiParts").innerHTML = parts.map((p, i) => {
    const done = dones[i];
    const cls = done ? " done" : aiCopied.has(i) ? " copied" : i === 0 || aiCopied.has(i - 1) || dones[i - 1] ? " primary" : "";
    const size = Math.max(20, Number($("#aiPartSize").value) || 1000), bucket = Math.floor((p[0].id - 1) / size);
    const a = bucket * size + 1, b = Math.min((bucket + 1) * size, lastId); // the part's marker range, whole
    return `<button type="button" class="btn${cls}" data-part="${i}" title="${escapeHtml(t("ai.partCount", { n: p.length }) + " " + (done ? t("ai.partDone") : t("ai.partTitle")))}">${done || aiCopied.has(i) ? "✓ " : ""}${escapeHtml(t("ai.partBtn", { k: i + 1, total: parts.length, a, b }))}</button>`;
  }).join("");
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
  const b = $(`#aiParts [data-part="${i}"]`); // the copied flash, every time the part is copied again
  if (b) { b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash"); }
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
  if (!focusAi) refreshOfflineStatus();
  openModal(dlg);
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
  for (const id of ["#aiTarget", "#aiFrom", "#aiTo", "#aiOnlyTodo", "#aiHidden", "#aiNotes", "#aiKeywords", "#aiKeywordCount", "#aiExamples", "#aiContext", "#aiGlossary", "#aiPartSize"]) {
    $(id).addEventListener("input", refreshAiPrompt);
  }
  $("#aiParts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-part]");
    if (b) copyAiPart(Number(b.dataset.part));
  });
  $("#aiCopyPrompt").addEventListener("click", () => copyText(`${aiPromptText()}\n\n${t("ai.pasteHere")}`, t("msg.promptCopied")));
  // The right column: the AI's answer is pasted or dropped here, like in the Import window.
  const aiOverwrite = () => $("#aiOverwrite").checked;
  setupDropzone($("#aiDrop"), (f) => importFile(f, aiOverwrite()));
  $("#aiFile").addEventListener("change", (e) => importFile(e.target.files[0], aiOverwrite()));
  $("#aiImportGo").addEventListener("click", () => {
    if (!state.doc) { toast(t("msg.openFirst"), "error"); return; }
    importPasted($("#aiPasteArea"), aiOverwrite());
  });
  $("#aiPasteArea").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#aiImportGo").click(); } });
  $("#helpDialog").addEventListener("close", () => aiImportNote(""));

}

initHelp();
