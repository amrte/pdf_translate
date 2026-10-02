// ======================================================================
// Offline use. The app loads two libraries from the internet: MuPDF (the document engine, at
// every start) and Tesseract (text recognition, on first use). Both can be stored in the
// browser (IndexedDB); stored copies are used instead of the network from then on. MuPDF's
// files refer to each other by relative path, so the stored texts are rewritten to point at
// the stored copies before they are loaded from blob: URLs.
// ======================================================================

// (a change of library version makes a stored set outdated: it is then ignored)
const OFFLINE_VERSION = `${MUPDF_URL} ${OCR_LIB}`;
const OFFLINE_FILES = [
  ["mupdf.js", MUPDF_URL],
  ["mupdf-wasm.js", MUPDF_URL.replace(/mupdf\.js$/, "mupdf-wasm.js")],
  ["mupdf-wasm.wasm", MUPDF_URL.replace(/mupdf\.js$/, "mupdf-wasm.wasm")],
  ["tesseract.esm.min.js", OCR_LIB],
  ["worker.min.js", OCR_WORKER],
  ["tesseract-core.wasm.js", null], // the build that fits this browser is chosen when downloading
];
const libKey = (name) => `lib:${name}`;
// Does the browser run WebAssembly SIMD? (the same probe Tesseract uses to choose its build)
const WASM_SIMD = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
const OCR_CORE_FILE = `tesseract-core${WASM_SIMD ? "-simd" : ""}-lstm.wasm.js`;

let offlineLibsPromise = null;

/** {mupdfUrl, ocr: {lib, worker, core} | null, manifest} from the stored copies, or null. */
function offlineLibs() {
  if (!offlineLibsPromise) offlineLibsPromise = loadOfflineLibs().catch((err) => { console.warn("Stored libraries not usable:", err); return null; });
  return offlineLibsPromise;
}

async function loadOfflineLibs() {
  const manifest = await idbGet(libKey("manifest"));
  if (!manifest || manifest.version !== OFFLINE_VERSION) return null;
  const data = {};
  for (const [name] of OFFLINE_FILES) data[name] = await idbGet(libKey(name));
  if (!data["mupdf.js"] || !data["mupdf-wasm.js"] || !data["mupdf-wasm.wasm"]) return null;
  const dec = new TextDecoder();
  const blobUrl = (content, type) => URL.createObjectURL(new Blob([content], { type }));
  const wasmUrl = blobUrl(data["mupdf-wasm.wasm"], "application/wasm");
  const glue = dec.decode(data["mupdf-wasm.js"]).replace('new URL("mupdf-wasm.wasm",import.meta.url).href', JSON.stringify(wasmUrl));
  if (!glue.includes(wasmUrl)) return null; // not the expected build of the library: use the network
  const glueUrl = blobUrl(glue, "text/javascript");
  const main = dec.decode(data["mupdf.js"]).replace(/from\s+"\.\/mupdf-wasm\.js"/, `from ${JSON.stringify(glueUrl)}`);
  if (!main.includes(glueUrl)) return null;
  const libs = { mupdfUrl: blobUrl(main, "text/javascript"), ocr: null, manifest };
  if (data["tesseract.esm.min.js"] && data["worker.min.js"] && data["tesseract-core.wasm.js"]) {
    // The worker script loads its core with importScripts(corePath), which a worker cannot do from a
    // blob: URL on a file: page. The core defines the global TesseractCore, and the worker skips the
    // loading when that global exists, so core and worker are stored as one script instead.
    const worker = dec.decode(data["tesseract-core.wasm.js"]) + "\n;\n" + dec.decode(data["worker.min.js"]);
    libs.ocr = { lib: blobUrl(data["tesseract.esm.min.js"], "text/javascript"), worker: blobUrl(worker, "text/javascript"), core: OCR_CORE };
  }
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

const mbOf = (bytes) => (bytes / 1048576).toFixed(1);

/** Download the libraries into the browser; `langs` are OCR languages to fetch into Tesseract's cache. */
async function downloadOfflineLibs(langs) {
  const files = OFFLINE_FILES.map(([name, url]) => [name, url || `${OCR_CORE}/${OCR_CORE_FILE}`]);
  let total = 0;
  try {
    for (const [i, [name, url]] of files.entries()) {
      busy(t("offline.fetching", { i: i + 1, n: files.length, name, mb: "0.0" }));
      const buf = await fetchWithProgress(url, (got) => busy(t("offline.fetching", { i: i + 1, n: files.length, name, mb: mbOf(got) })));
      total += buf.byteLength;
      await idbPut(buf, libKey(name));
    }
    const manifest = { version: OFFLINE_VERSION, date: Date.now(), bytes: total, langs: [] };
    await idbPut(manifest, libKey("manifest"));
    offlineLibsPromise = null;
    const libs = await offlineLibs();
    if (!libs) throw new Error("The stored libraries could not be read back.");
    if (langs.length && libs.ocr) {
      // Tesseract keeps language data in its own browser cache: loading the languages once stores them.
      busy(t("offline.langs", { langs: langs.map((l) => t("ocrlang." + l)).join(", ") }));
      const T = await import(libs.ocr.lib);
      const createWorker = T.createWorker || (T.default && T.default.createWorker);
      const w = await createWorker(langs.join("+"), 1, ocrWorkerOptions(libs.ocr));
      await w.terminate();
      manifest.langs = langs;
      await idbPut(manifest, libKey("manifest"));
    }
    toast(t("offline.done", { mb: mbOf(total) }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("offline.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
    refreshOfflineStatus();
  }
}

async function removeOfflineLibs() {
  for (const [name] of OFFLINE_FILES) await idbDel(libKey(name));
  await idbDel(libKey("manifest"));
  offlineLibsPromise = null;
  toast(t("offline.removed"), "ok");
  refreshOfflineStatus();
}

/** The "Working offline" part of the Help dialog: what is stored, and the language choice. */
async function refreshOfflineStatus() {
  const el = $("#offlineStatus");
  if (!el) return;
  const m = await idbGet(libKey("manifest"));
  if (!m) el.textContent = t("offline.none");
  else if (m.version !== OFFLINE_VERSION) el.textContent = t("offline.outdated");
  else {
    const langs = (m.langs || []).map((l) => t("ocrlang." + l)).join(", ");
    el.textContent = t("offline.stored", { date: new Date(m.date).toLocaleDateString(LANG === "de" ? "de-DE" : "en-GB"), mb: mbOf(m.bytes), langs: langs || t("offline.noLangs") });
  }
  $("#offlineRemove").hidden = !m;
  $("#offlineDownload").textContent = t(m ? "offline.again" : "offline.download");
}

function renderOfflineLangs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_OCR) || "{}"); } catch (_) { /* default */ }
  const checked = new Set((saved.langs && saved.langs.length) ? saved.langs : (LANG === "de" ? ["deu", "eng"] : ["eng"]));
  const current = new Set([...document.querySelectorAll("#offlineLangs input:checked")].map((i) => i.value));
  const on = current.size ? current : checked;
  $("#offlineLangs").innerHTML = OCR_LANGS.map((l) =>
    `<label class="check"><input type="checkbox" value="${l}"${on.has(l) ? " checked" : ""}> ${escapeHtml(t("ocrlang." + l))}</label>`).join("");
}

function initOffline() {
  renderOfflineLangs();
  document.addEventListener("languagechange", () => { renderOfflineLangs(); if ($("#helpDialog").open) refreshOfflineStatus(); });
  $("#offlineDownload").addEventListener("click", () => {
    const langs = [...document.querySelectorAll("#offlineLangs input:checked")].map((i) => i.value);
    $("#helpDialog").close("cancel"); // (the progress box would be hidden behind the dialog)
    downloadOfflineLibs(langs);
  });
  $("#offlineRemove").addEventListener("click", () => removeOfflineLibs());
}
