// ======================================================================
// Offline use. The app loads two libraries from the internet: MuPDF (the document engine, at
// every start) and Tesseract (text recognition, on first use, plus language data). For work
// without a connection the set of files can be saved as a ZIP on the computer and loaded from
// that ZIP or its unpacked folder (here or on the start page); optionally the browser keeps
// the loaded files (IndexedDB), so that the app starts offline on its own.
//
// A page opened from disk cannot load scripts from a folder next to it, so the files are read
// through the file picker and served from blob: URLs. MuPDF's files refer to each other by
// relative path and are rewritten to point at the stored copies. Tesseract reads language data
// from its own browser cache before the network, so language files are written into that cache.
// ======================================================================

const APP_VERSION = "{{VERSION}}";
// (a change of library version makes a stored set outdated: it is then ignored)
const OFFLINE_VERSION = `${MUPDF_URL} ${OCR_LIB}`;
const CORE_SIMD = "tesseract-core-simd-lstm.wasm.js", CORE_PLAIN = "tesseract-core-lstm.wasm.js";
const LIB_FILES = {
  "mupdf.js": MUPDF_URL,
  "mupdf-wasm.js": MUPDF_URL.replace(/mupdf\.js$/, "mupdf-wasm.js"),
  "mupdf-wasm.wasm": MUPDF_URL.replace(/mupdf\.js$/, "mupdf-wasm.wasm"),
  "tesseract.esm.min.js": OCR_LIB,
  "worker.min.js": OCR_WORKER,
  [CORE_SIMD]: `${OCR_CORE}/${CORE_SIMD}`,
  [CORE_PLAIN]: `${OCR_CORE}/${CORE_PLAIN}`,
  "libheif-bundle.mjs": HEIF_LIB, // (iPhone photos, HEIC: optional)
};
const LIB_REQUIRED = ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"];
const langUrl = (l) => (OCR_LANG_PATH ? `${OCR_LANG_PATH}/${l}.traineddata.gz` : `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`);
const libKey = (name) => `lib:${name}`;
// Does the browser run WebAssembly SIMD? (the same probe Tesseract uses to choose its build)
const WASM_SIMD = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
const OCR_CORE_FILE = WASM_SIMD ? CORE_SIMD : CORE_PLAIN;
const mbOf = (bytes) => (bytes / 1048576).toFixed(1);

let offlineLibsPromise = null;
let offlineSource = null; // {kind: "folder", langs} when the libraries came from a folder or ZIP in this session

/** {mupdfUrl, ocr: {lib, worker, core} | null} from the stored copies, or null. */
function offlineLibs() {
  if (!offlineLibsPromise) offlineLibsPromise = loadStoredLibs().catch((err) => { console.warn("Stored libraries not usable:", err); return null; });
  return offlineLibsPromise;
}

async function loadStoredLibs() {
  const manifest = await idbGet(libKey("manifest"));
  if (!manifest || manifest.version !== OFFLINE_VERSION) return null;
  const data = {};
  for (const name of Object.keys(LIB_FILES)) { const v = await idbGet(libKey(name)); if (v) data[name] = v; }
  return buildLibs(data);
}

/** Blob URLs for the library files, with MuPDF's internal references rewritten; null if a file is missing or unexpected. */
function buildLibs(data) {
  if (LIB_REQUIRED.some((n) => !data[n])) return null;
  const dec = new TextDecoder();
  const blobUrl = (content, type) => URL.createObjectURL(new Blob([content], { type }));
  const wasmUrl = blobUrl(data["mupdf-wasm.wasm"], "application/wasm");
  const glue = dec.decode(data["mupdf-wasm.js"]).replace('new URL("mupdf-wasm.wasm",import.meta.url).href', JSON.stringify(wasmUrl));
  if (!glue.includes(wasmUrl)) return null; // not the expected build of the library
  const glueUrl = blobUrl(glue, "text/javascript");
  const main = dec.decode(data["mupdf.js"]).replace(/from\s+"\.\/mupdf-wasm\.js"/, `from ${JSON.stringify(glueUrl)}`);
  if (!main.includes(glueUrl)) return null;
  const libs = { mupdfUrl: blobUrl(main, "text/javascript"), ocr: null };
  const core = data[OCR_CORE_FILE] || data[CORE_SIMD] || data[CORE_PLAIN];
  if (data["tesseract.esm.min.js"] && data["worker.min.js"] && core) {
    // The worker script loads its core with importScripts(corePath), which a worker cannot do from a
    // blob: URL on a file: page. The core defines the global TesseractCore, and the worker skips the
    // loading when that global exists, so core and worker become one script.
    const worker = dec.decode(core) + "\n;\n" + dec.decode(data["worker.min.js"]);
    libs.ocr = { lib: blobUrl(data["tesseract.esm.min.js"], "text/javascript"), worker: blobUrl(worker, "text/javascript"), core: OCR_CORE };
  }
  if (data["libheif-bundle.mjs"]) libs.heif = blobUrl(data["libheif-bundle.mjs"], "text/javascript");
  return libs;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

/** Fetch the library files (both Tesseract builds when `allCores`) and the language data. */
async function fetchLibrarySet(langs, allCores, paddle = false) {
  const names = Object.keys(LIB_FILES).filter((n) => allCores || (n !== CORE_SIMD && n !== CORE_PLAIN) || n === OCR_CORE_FILE);
  const items = names.map((n) => [n, LIB_FILES[n]]).concat(langs.map((l) => [`${l}.traineddata.gz`, langUrl(l)]))
    .concat(paddle ? Object.entries(PADDLE_FILES) : []); // (PaddleOCR, when ticked: about 35 MB)
  const data = {}, langData = {}, paddleData = {};
  let total = 0;
  for (const [i, [name, url]] of items.entries()) {
    const show = (got) => busy(t("offline.fetching", { i: i + 1, n: items.length, name, mb: mbOf(got) }));
    show(0);
    const buf = await fetchWithProgress(url, show);
    total += buf.byteLength;
    const m = /^([a-z_]+)\.traineddata\.gz$/.exec(name);
    if (m) langData[m[1]] = buf; else if (PADDLE_FILES[name]) paddleData[name] = buf; else data[name] = buf;
  }
  return { data, langData, paddleData, total };
}

/* ------------------------------------------------ Tesseract's language cache */

// Tesseract 6 keeps language data in IndexedDB "keyval-store" / "keyval" under "./<lang>.traineddata"
// (unpacked), and reads it before fetching. Language files from a ZIP or folder are put there.
function tessCache(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("keyval-store", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keyval");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction("keyval", mode), r = fn(tx.objectStore("keyval"));
      tx.oncomplete = () => { db.close(); resolve(r && r.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function gunzip(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x1f || u[1] !== 0x8b || typeof DecompressionStream === "undefined") return u;
  return new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

async function storeLangData(langData) {
  for (const [code, buf] of Object.entries(langData)) {
    const data = await gunzip(buf);
    await tessCache("readwrite", (store) => store.put(data, `./${code}.traineddata`));
  }
}

/* ------------------------------------------------------------- the actions */

/** Use a set of library files now; `remember` also stores them in the browser. */
async function activateLibs(data, langData, remember, source) {
  const libs = buildLibs(data);
  if (!libs) throw new Error("The library files could not be used.");
  await storeLangData(langData);
  offlineLibsPromise = Promise.resolve(libs);
  const langs = Object.keys(langData);
  offlineSource = source === "folder" ? { kind: "folder", langs } : null;
  if (remember) {
    for (const name of Object.keys(LIB_FILES)) await idbDel(libKey(name));
    let bytes = 0;
    for (const [name, buf] of Object.entries(data)) { await idbPut(buf, libKey(name)); bytes += buf.byteLength; }
    await idbPut({ version: OFFLINE_VERSION, date: Date.now(), bytes, langs }, libKey("manifest"));
  }
  if (pool.ready === null) await startEngine(); // the engine could not come from the internet: start it from the files
}

/** Download the whole set as a ZIP on the computer. */
/** PaddleOCR files kept where the engine looks for them (see paddleFiles). */
async function storePaddleFiles(paddleData) {
  for (const [name, buf] of Object.entries(paddleData || {})) await idbPut(buf, `paddle:${name}`, true);
}
async function downloadOfflineZip(langs, paddle = false) {
  try {
    const { data, langData, paddleData, total } = await fetchLibrarySet(langs, true, paddle);
    busy(t("offline.zipping"));
    const entries = Object.entries(data).map(([name, buf]) => ({ name, data: new Uint8Array(buf) }))
      .concat(Object.entries(langData).map(([code, buf]) => ({ name: `${code}.traineddata.gz`, data: new Uint8Array(buf), store: true })))
      .concat(Object.entries(paddleData).map(([name, buf]) => ({ name, data: new Uint8Array(buf) })));
    entries.push({ name: "README.txt", data: new TextEncoder().encode(OFFLINE_README) });
    const zip = await zipWrite(entries);
    const name = `Kameleon-offline-${APP_VERSION}.zip`;
    saveBlob(new Blob([zip], { type: "application/zip" }), name);
    toast(t("offline.zipDone", { name, mb: mbOf(zip.length), src: mbOf(total) }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("offline.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

const OFFLINE_README = `Kameleon ${APP_VERSION} – Bibliotheken für die Offline-Nutzung / libraries for offline use

DE: Diese ZIP enthält die Dokument-Engine (MuPDF), die Texterkennung (Tesseract), Sprachdaten und den
Leser für iPhone-Fotos (libheif). Ohne Internet: Kameleon öffnen, dann auf der Startseite oder unter
Hilfe → „Offline arbeiten“ diese ZIP-Datei (oder den entpackten Ordner) wählen. Die Dateien bleiben
auf Ihrem Computer; die Dateinamen bitte nicht ändern.

  mupdf.js                           Dokument-Engine MuPDF, Programmteil (immer nötig)
  mupdf-wasm.js                      verbindet ihn mit dem WebAssembly-Kern (immer nötig)
  mupdf-wasm.wasm                    Kern der Engine: Dokumente lesen, zeichnen, schreiben (immer nötig)
  tesseract.esm.min.js               Texterkennung Tesseract.js, Steuerteil
  worker.min.js                      Texterkennung, Teil im Hintergrund
  tesseract-core-simd-lstm.wasm.js   Erkennungs-Engine für Browser mit SIMD (alle aktuellen)
  tesseract-core-lstm.wasm.js        dieselbe für ältere Browser ohne SIMD
  <sprache>.traineddata.gz           Sprachdaten der Texterkennung, eine je Sprache (deu, eng, fra …)
  libheif-bundle.mjs                 liest iPhone-Fotos (HEIC/HEIF)
  ort.wasm.min.js, ort-wasm-simd-threaded.mjs/.wasm   ONNX Runtime für PaddleOCR (wenn gewählt)
  PP-OCRv5_mobile_det_infer.ort      PaddleOCR: findet die Textzeilen
  PP-OCRv5_mobile_rec_infer.onnx     PaddleOCR: liest die Zeilen
  ppocrv5_dict.txt                   PaddleOCR: die Zeichen, die es kennt

EN: This ZIP holds the document engine (MuPDF), text recognition (Tesseract), language data and the
reader for iPhone photos (libheif). Without internet: open Kameleon, then choose this ZIP file (or
the unpacked folder) on the start page or under Help → "Working offline". The files stay on your
computer; please do not rename them.

  mupdf.js                           document engine MuPDF, program part (always needed)
  mupdf-wasm.js                      connects it with the WebAssembly core (always needed)
  mupdf-wasm.wasm                    core of the engine: reads, draws and writes documents (always needed)
  tesseract.esm.min.js               text recognition Tesseract.js, controlling part
  worker.min.js                      text recognition, the part working in the background
  tesseract-core-simd-lstm.wasm.js   recognition engine for browsers with SIMD (all current ones)
  tesseract-core-lstm.wasm.js        the same for older browsers without SIMD
  <language>.traineddata.gz          language data for text recognition, one per language (deu, eng, fra …)
  libheif-bundle.mjs                 reads iPhone photos (HEIC/HEIF)
  ort.wasm.min.js, ort-wasm-simd-threaded.mjs/.wasm   ONNX Runtime for PaddleOCR (when chosen)
  PP-OCRv5_mobile_det_infer.ort      PaddleOCR: finds the text lines
  PP-OCRv5_mobile_rec_infer.onnx     PaddleOCR: reads the lines
  ppocrv5_dict.txt                   PaddleOCR: the characters it knows
`;

/** Store the set in the browser directly (fetched from the internet). */
async function storeOfflineLibs(langs, paddle = false) {
  try {
    const { data, langData, paddleData } = await fetchLibrarySet(langs, false, paddle);
    busy(t("offline.storing"));
    await activateLibs(data, langData, true, "browser");
    await storePaddleFiles(paddleData);
    toast(t("offline.done"), "ok");
  } catch (err) {
    console.error(err);
    toast(t("offline.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
    refreshOfflineStatus();
  }
}

/** Library files chosen by the user: loose files, a folder, or one or more ZIPs. */
async function useLibraryFiles(files, remember) {
  const data = {}, langData = {}, paddleData = {};
  const take = (name, bytes) => {
    // (an entry read from a ZIP may be a view into the archive: copy just its own bytes)
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
    const base = name.split(/[\\/]/).pop().toLowerCase();
    if (LIB_FILES[base]) data[base] = buf;
    const pk = Object.keys(PADDLE_FILES).find((k) => k.toLowerCase() === base); // (PaddleOCR, if the set has it)
    if (pk) paddleData[pk] = buf;
    const m = /^([a-z_]+)\.traineddata(\.gz)?$/.exec(base);
    if (m) langData[m[1]] = buf;
  };
  try {
    busy(t("offline.reading"));
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        for (const e of zipEntries(bytes)) take(e.name, await zipRead(e));
      } else {
        take(f.name, await f.arrayBuffer());
      }
    }
    const missing = LIB_REQUIRED.filter((n) => !data[n]);
    if (missing.length) { toast(t("offline.missing", { names: missing.join(", ") }), "error"); return; }
    await activateLibs(data, langData, remember, "folder");
    await storePaddleFiles(paddleData);
    toast(t("offline.loaded", { n: Object.keys(data).length + Object.keys(langData).length + Object.keys(paddleData).length }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("offline.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
    refreshOfflineStatus();
  }
}

async function removeOfflineLibs() {
  for (const name of Object.keys(LIB_FILES)) await idbDel(libKey(name));
  for (const name of Object.keys(PADDLE_FILES)) await idbDel(`paddle:${name}`);
  await idbDel(libKey("manifest"));
  if (!offlineSource) offlineLibsPromise = null;
  toast(t("offline.removed"), "ok");
  refreshOfflineStatus();
}

/* ------------------------------------------------------------------ the UI */

const langNames = (codes) => (codes && codes.length ? codes.map((l) => t("ocrlang." + l)).join(", ") : t("offline.noLangs"));

async function refreshOfflineStatus() {
  const el = $("#offlineStatus");
  if (!el) return;
  const m = await idbGet(libKey("manifest"));
  const parts = [];
  if (offlineSource) parts.push(t("offline.folder", { langs: langNames(offlineSource.langs) }));
  if (!m) parts.push(t("offline.none"));
  else if (m.version !== OFFLINE_VERSION) parts.push(t("offline.outdated"));
  else parts.push(t("offline.stored", { date: new Date(m.date).toLocaleDateString(LANG === "de" ? "de-DE" : "en-GB"), mb: mbOf(m.bytes), langs: langNames(m.langs) }));
  el.textContent = parts.join(" ");
  $("#offlineRemove").hidden = !m;
}

function renderOfflineLangs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_OCR) || "{}"); } catch (_) { /* default */ }
  const fallback = new Set((saved.langs && saved.langs.length) ? saved.langs : (LANG === "de" ? ["deu", "eng"] : ["eng"]));
  const current = new Set([...document.querySelectorAll("#offlineLangs input:checked")].map((i) => i.value));
  const on = current.size ? current : fallback;
  $("#offlineLangs").innerHTML = sortedOcrLangs().map((l) =>
    `<label class="check"><input type="checkbox" value="${l}"${on.has(l) ? " checked" : ""}> ${escapeHtml(t("ocrlang." + l))}</label>`).join("");
}

const chosenOfflineLangs = () => [...document.querySelectorAll("#offlineLangs input:checked")].map((i) => i.value);

function initOffline() {
  renderOfflineLangs();
  document.addEventListener("languagechange", () => { renderOfflineLangs(); if ($("#helpDialog").open) refreshOfflineStatus(); });
  const closeHelp = () => { if ($("#helpDialog").open) $("#helpDialog").close("cancel"); }; // (the progress box would be hidden behind it)
  $("#offlineZipBtn").addEventListener("click", () => { const langs = chosenOfflineLangs(), paddle = $("#offlinePaddle").checked; closeHelp(); downloadOfflineZip(langs, paddle); });
  $("#offlineDownload").addEventListener("click", () => { const langs = chosenOfflineLangs(), paddle = $("#offlinePaddle").checked; closeHelp(); storeOfflineLibs(langs, paddle); });
  $("#offlineRemove").addEventListener("click", () => removeOfflineLibs());
  const pick = (input) => (e) => { e.preventDefault(); e.stopPropagation(); input.value = ""; input.click(); };
  $("#offlineLoadZip").addEventListener("click", pick($("#offlineZip")));
  $("#offlineLoadFolder").addEventListener("click", pick($("#offlineFolder")));
  $("#engineLoadZip").addEventListener("click", pick($("#offlineZip")));
  $("#engineLoadFolder").addEventListener("click", pick($("#offlineFolder")));
  for (const input of [$("#offlineZip"), $("#offlineFolder")]) {
    input.addEventListener("change", () => {
      const files = [...input.files];
      if (!files.length) return;
      closeHelp();
      useLibraryFiles(files, $("#offlineRemember").checked);
    });
  }
}
