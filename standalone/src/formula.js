/* ------------------------------------------------ Formulas: found on scanned pages, read as LaTeX */
// Two models run with ONNX Runtime Web (the runtime of PaddleOCR) in a worker of their own:
// - a layout model (PP-PicoDet trained on CDLA, from RapidLayout, Apache-2.0) finds displayed
//   formulas on a page picture ("equation" boxes); the OCR keeps them as pictures, one segment each;
// - pix2tex (LaTeX-OCR, MIT; its ONNX export from RapidLaTeXOCR) reads a formula's picture into
//   LaTeX: a vision transformer encodes the picture, a decoder writes the LaTeX token by token
//   (the decoder's weights reduced to 8 bits: 13 instead of 51 MB, the same readings in tests).
// The files are fetched once and kept in the browser (IndexedDB, "paddle:<name>", as PaddleOCR's);
// "Offline use" can store them too, and files downloaded by hand can be chosen there.
// (raw.githubusercontent.com lets a page fetch the repository's files; the models/ folder holds
// them with their licences – main first, then the branch they came with)
const FORMULA_SOURCES = ["https://raw.githubusercontent.com/amrte/pdf_translate/main/models/", "https://raw.githubusercontent.com/amrte/pdf_translate/refs/heads/claude/compassionate-ramanujan-oeol0q/models/"];
/** The formula models' files: stored name → the addresses to try. */
const FORMULA_FILES = {
  "layout_cdla.onnx": FORMULA_SOURCES.map((b) => b + "layout_cdla.onnx"),
  "encoder.onnx": FORMULA_SOURCES.map((b) => b + "encoder.onnx"),
  "decoder.onnx": FORMULA_SOURCES.map((b) => b + "decoder.onnx"),
  "tokenizer.json": FORMULA_SOURCES.map((b) => b + "tokenizer.json"),
};
const FORMULA_FIND = ["layout_cdla.onnx"];
const FORMULA_READ = ["encoder.onnx", "decoder.onnx", "tokenizer.json"];
/** Download sizes in MB (the ONNX runtime, shared with PaddleOCR, adds 14 MB once). */
const FORMULA_MB = { find: 7, read: 102 };
// Where the files come from, for downloading them by hand (help → offline use).
const FORMULA_ORIGIN = {
  "layout_cdla.onnx": "https://github.com/RapidAI/RapidLayout/releases/download/v0.0.0/layout_cdla.onnx",
  "encoder.onnx": "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0/encoder.onnx",
  "decoder.onnx": "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0/decoder.onnx",
  "tokenizer.json": "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0/tokenizer.json",
};
// pix2tex reads best when the formula's letters are about this tall (em, in pixels): its pictures
// were set at roughly 10 pt and 130–150 dpi (larger pictures were read clearly worse).
const FORMULA_EM_PX = 19;
// A reading is kept when the decoder was at least this sure on average (good readings came out
// above 0.97, garbled ones – prose, a picture – below 0.9).
const FORMULA_SURE = 0.93;

/** Whether the files for finding (`find`) or reading (`read`) formulas are stored already. */
async function formulaReady(part) {
  for (const name of part === "read" ? FORMULA_READ : FORMULA_FIND) if (!(await idbGet(`paddle:${name}`))) return false;
  return true;
}

/** The worker's program (run from a blob URL). */
function formulaWorkerMain() {
  let ort = null, find = null, enc = null, dec = null, vocab = null;
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };

  /** Displayed formulas on a page picture: [{x0, y0, x1, y1, score}] in its pixels. */
  async function findFormulas(img) {
    // The layout model takes the whole page squeezed to 608 × 800 (RGB, ImageNet mean and spread).
    const W = 608, H = 800, { width: w0, height: h0, data } = img, plane = W * H, t = new Float32Array(3 * plane);
    const sx = w0 / W, sy = h0 / H, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
    for (let y = 0; y < H; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < W; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { const i = (yy * w0 + xx) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        const p = y * W + x;
        t[p] = (r / n / 255 - MEAN[0]) / STD[0]; t[plane + p] = (g / n / 255 - MEAN[1]) / STD[1]; t[2 * plane + p] = (b / n / 255 - MEAN[2]) / STD[2];
      }
    }
    const out = await find.run({ [find.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, H, W]) });
    // Four levels (strides 8 … 64): class scores per cell, then the distances to the box's sides as
    // distributions over 8 bins (GFL). Class 9 is "equation".
    const names = find.outputNames, EQ = 9, found = [];
    [8, 16, 32, 64].forEach((stride, k) => {
      const sc = out[names[k]], bd = out[names[k + 4]], C = sc.dims[2], n = sc.dims[1], fw = Math.ceil(W / stride);
      for (let i = 0; i < n; i++) {
        let best = 0, bc = -1;
        for (let c = 0; c < C; c++) { const v = sc.data[i * C + c]; if (v > best) { best = v; bc = c; } }
        if (bc !== EQ || best < 0.3) continue;
        const cx = ((i % fw) + 0.5) * stride, cy = (Math.floor(i / fw) + 0.5) * stride, dist = [];
        for (let side = 0; side < 4; side++) {
          const o = i * 32 + side * 8;
          let m = -Infinity, sum = 0, ex = 0;
          for (let j = 0; j < 8; j++) m = Math.max(m, bd.data[o + j]);
          for (let j = 0; j < 8; j++) { const e = Math.exp(bd.data[o + j] - m); sum += e; ex += e * j; }
          dist.push((ex / sum) * stride);
        }
        found.push({ x0: (cx - dist[0]) * sx, y0: (cy - dist[1]) * sy, x1: (cx + dist[2]) * sx, y1: (cy + dist[3]) * sy, score: best });
      }
    });
    // (overlapping candidates: the surest stays)
    found.sort((a, b) => b.score - a.score);
    const iou = (a, b) => {
      const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)), i = ix * iy;
      return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i || 1);
    };
    const keep = [];
    for (const f of found) if (keep.every((k) => iou(k, f) < 0.5)) keep.push(f);
    return keep.map((f) => ({ x0: Math.max(0, f.x0), y0: Math.max(0, f.y0), x1: Math.min(w0, f.x1), y1: Math.min(h0, f.y1), score: Math.round(f.score * 100) / 100 }));
  }

  /**
   * The picture prepared as pix2tex wants it: grey, contrast stretched, cut to its ink, padded with
   * white to multiples of 32, at most 672 × 192; normalised with the training pictures' mean and
   * spread. (The picture comes at the scale that suits the model, see FORMULA_EM_PX.)
   */
  function prepare(img) {
    const { width: w, height: h, data } = img, g = new Float32Array(w * h);
    let lo = 255, hi = 0;
    for (let i = 0; i < w * h; i++) { const v = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]; g[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    let mean = 0;
    for (let i = 0; i < g.length; i++) { g[i] = ((g[i] - lo) / span) * 255; mean += g[i]; }
    mean /= g.length;
    if (mean <= 128) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i]; // (light ink on dark: turned round)
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    let cw = x1 - x0 + 1, ch = y1 - y0 + 1, src = (x, y) => g[(y0 + y) * w + x0 + x];
    // (too large: made smaller, bilinear)
    const ratio = Math.max(cw / 672, ch / 192);
    if (ratio > 1) {
      const nw = Math.max(1, Math.floor(cw / ratio)), nh = Math.max(1, Math.floor(ch / ratio)), small = new Float32Array(nw * nh), get = src;
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const fx = Math.min(cw - 1.001, (x + 0.5) * ratio - 0.5), fy = Math.min(ch - 1.001, (y + 0.5) * ratio - 0.5);
        const ax = Math.max(0, Math.floor(fx)), ay = Math.max(0, Math.floor(fy)), dx = Math.max(0, fx - ax), dy = Math.max(0, fy - ay);
        small[y * nw + x] = (get(ax, ay) * (1 - dx) + get(ax + 1, ay) * dx) * (1 - dy) + (get(ax, ay + 1) * (1 - dx) + get(ax + 1, ay + 1) * dx) * dy;
      }
      cw = nw; ch = nh; src = (x, y) => small[y * nw + x];
    }
    const W = Math.max(32, Math.ceil(cw / 32) * 32), H = Math.max(32, Math.ceil(ch / 32) * 32), t = new Float32Array(W * H);
    const M = 0.7931 * 255, S = 0.1738 * 255;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[y * W + x] = ((x < cw && y < ch ? src(x, y) : 255) - M) / S;
    return { t, W, H };
  }

  /** LaTeX of a formula picture: {latex, conf} (conf: the decoder's mean certainty, 0–1). */
  async function readFormula(img) {
    const p = prepare(img);
    if (!p) return { latex: "", conf: 0 };
    const ctx = (await enc.run({ [enc.inputNames[0]]: new ort.Tensor("float32", p.t, [1, 1, p.H, p.W]) }))[enc.outputNames[0]];
    // Greedy decoding: the likeliest token each step, until [EOS] (2). The decoder sees the whole
    // sequence each time (the export keeps no cache); formulas are short.
    // (a bound for the length – about one token per 4 pixels of width – and a stop for a decoder
    // caught in a loop: what such a run writes is no formula)
    const ids = [1], probs = [], most = Math.min(400, 40 + Math.round(p.W / 3));
    let looping = false;
    for (let step = 0; step < most; step++) {
      const x = new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
      const mask = new ort.Tensor("bool", new Uint8Array(ids.length).fill(1), [1, ids.length]);
      const o = (await dec.run({ x, mask, context: ctx }))[dec.outputNames[0]], V = o.dims[2], off = (ids.length - 1) * V;
      let best = 0, bv = -Infinity, sum = 0;
      for (let v = 0; v < V; v++) if (o.data[off + v] > bv) { bv = o.data[off + v]; best = v; }
      for (let v = 0; v < V; v++) sum += Math.exp(o.data[off + v] - bv);
      probs.push(1 / sum);
      if (best === 2) break;
      ids.push(best);
      if (ids.length > 40) {
        const tail = ids.slice(-24);
        if ([1, 2, 3, 4].some((k) => tail.every((v, i) => i < k || v === tail[i - k]))) { looping = true; break; }
      }
    }
    if (looping || ids.length >= most) return { latex: "", conf: 0 };
    const raw = ids.slice(1).map((i) => vocab[i] || "").join("").replace(/Ġ/g, " ").replace(/\[(?:EOS|BOS|PAD)\]/g, "").trim();
    return { latex: tidy(raw), conf: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0 };
  }

  /** pix2tex's own clean-up: spaces that LaTeX does not need go (between signs, and next to them). */
  function tidy(s) {
    const textReg = /(\\(operatorname|mathrm|text|mathbf)\s?\*? {.*?})/g;
    s = s.replace(textReg, (m) => m.replace(/ /g, ""));
    for (;;) {
      let n = s.replace(/(?!\\ )([\W_^\d])\s+?([\W_^\d])/g, "$1$2");
      n = n.replace(/(?!\\ )([\W_^\d])\s+?([a-zA-Z])/g, "$1$2");
      n = n.replace(/([a-zA-Z])\s+?([\W_^\d])/g, "$1$2");
      if (n === s) return s;
      s = n;
    }
  }

  self.onmessage = async (e) => {
    const { id, cmd, args } = e.data;
    try {
      if (cmd === "init") {
        const url = (name, type) => URL.createObjectURL(new Blob([args.files[name]], { type }));
        importScripts(url("ort.wasm.min.js", "text/javascript"));
        ort = self.ort;
        ort.env.wasm.numThreads = 1; // (threads need a cross-origin isolated page)
        ort.env.wasm.wasmPaths = { mjs: url("ort-wasm-simd-threaded.mjs", "text/javascript"), wasm: url("ort-wasm-simd-threaded.wasm", "application/wasm") };
        if (args.files["layout_cdla.onnx"]) find = await ort.InferenceSession.create(new Uint8Array(args.files["layout_cdla.onnx"]), opts);
        if (args.files["encoder.onnx"]) {
          enc = await ort.InferenceSession.create(new Uint8Array(args.files["encoder.onnx"]), opts);
          dec = await ort.InferenceSession.create(new Uint8Array(args.files["decoder.onnx"]), opts);
          const tok = JSON.parse(new TextDecoder().decode(args.files["tokenizer.json"]));
          vocab = [];
          for (const [k, v] of Object.entries(tok.model.vocab)) vocab[v] = k;
        }
        self.postMessage({ id, result: true });
      } else if (cmd === "find") {
        self.postMessage({ id, result: await findFormulas(args) });
      } else if (cmd === "read") {
        self.postMessage({ id, result: await readFormula(args) });
      }
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
  };
}

/**
 * A formula worker: `find` (the layout model) and/or `read` (pix2tex) as asked. Its files are
 * fetched first when they are not stored yet (`onProgress(name, got, total, whole)` as paddleFiles).
 */
async function makeFormulaWorker({ find = false, read = false } = {}, onProgress) {
  const names = Object.keys(PADDLE_RUNTIME).concat(find ? FORMULA_FIND : [], read ? FORMULA_READ : []);
  const files = await modelFiles(names, onProgress);
  const src = `(${formulaWorkerMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.result); };
  worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || "Formula worker failed")); waiting.clear(); };
  const call = (cmd, args, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, cmd, args }, transfer); });
  await call("init", { files }, Object.values(files));
  // (one picture at a time: the pages read at once take turns)
  let turn = Promise.resolve();
  const queued = (cmd, args) => { const run = turn.then(() => call(cmd, args)); turn = run.catch(() => {}); return run; };
  const plain = (img) => ({ width: img.width, height: img.height, data: img.data });
  return {
    /** Displayed formulas on a page picture (ImageData): boxes in its pixels. */
    find: (img) => queued("find", plain(img)),
    /** A formula's picture (ImageData, letters about FORMULA_EM_PX tall) read: {latex, conf}. */
    read: (img) => queued("read", plain(img)),
    terminate() { worker.terminate(); URL.revokeObjectURL(url); for (const w of waiting.values()) w.reject(new Error("cancelled")); waiting.clear(); },
  };
}

/**
 * Part of a page picture (ImageData) cut out around `box` (pixels) with a white margin, scaled so
 * that letters of `emPx` pixels come out FORMULA_EM_PX tall: what readFormula wants.
 */
function formulaCrop(img, box, emPx) {
  const s = FORMULA_EM_PX / Math.max(4, emPx), m = 0.25 * emPx;
  const x0 = Math.max(0, Math.floor(box.x0 - m)), y0 = Math.max(0, Math.floor(box.y0 - m));
  const x1 = Math.min(img.width, Math.ceil(box.x1 + m)), y1 = Math.min(img.height, Math.ceil(box.y1 + m));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const src = new OffscreenCanvas(w, h);
  src.getContext("2d").putImageData(img, -x0, -y0, x0, y0, w, h);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s)), dst = new OffscreenCanvas(W, H), cx = dst.getContext("2d", { willReadFrequently: true });
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, W, H);
  cx.imageSmoothingQuality = "high";
  cx.drawImage(src, 0, 0, W, H);
  return cx.getImageData(0, 0, W, H);
}

/* ---- LaTeX of formula segments: read on demand (any formula: recognised or in a PDF's text) */
const latexKey = (id) => `pdftr:latex:${id}`;
function loadLatex() {
  try { state.latex = state.doc ? JSON.parse(localStorage.getItem(latexKey(state.doc.id)) || "{}") : {}; } catch (_) { state.latex = {}; }
}
function saveLatex() {
  try { localStorage.setItem(latexKey(state.doc.id), JSON.stringify(state.latex)); } catch (_) { /* storage blocked */ }
}

/**
 * The formulas of the document: a PDF sets one formula in many pieces ("ΔU =", "L", "S", "cos φ",
 * the brackets …), each a formula segment of its own. Pieces next to each other – formula
 * segments, and the numbers among them – are one formula: [{lead, ids, page, bbox}] (`lead`: its
 * first segment, which shows the LaTeX). A recognised formula is one segment already.
 */
// (worked out once per list of segments: built anew when segments are added, split or joined –
// a new list – and dropped when a segment is made a formula or text, see applyKinds)
let fxGroupCache = null;
function formulaGroups() {
  const segs = state.doc ? state.doc.segments : [];
  if (fxGroupCache && fxGroupCache.segs === segs && fxGroupCache.n === segs.length) return fxGroupCache;
  const groups = [], byId = new Map(), segOf = new Map();
  const byPage = new Map();
  for (const s of segs) {
    segOf.set(s.id, s);
    if (s.skip && s.bbox && !s.extra) (byPage.get(s.page) || byPage.set(s.page, []).get(s.page)).push(s);
  }
  for (const list of byPage.values()) {
    const parent = new Map(list.map((s) => [s.id, s.id]));
    const root = (id) => { while (parent.get(id) !== id) { const up = parent.get(parent.get(id)); parent.set(id, up); id = up; } return id; };
    const near = (a, b) => {
      const h = Math.max(a.size || 10, b.size || 10), A = a.bbox, B = b.bbox;
      const gx = Math.max(B[0] - A[2], A[0] - B[2]), gy = Math.max(B[1] - A[3], A[1] - B[3]);
      return gx < 0.8 * h && gy < 0.5 * h;
    };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (!(list[i].formula || list[j].formula) || !near(list[i], list[j])) continue;
      const a = root(list[i].id), c = root(list[j].id);
      if (a !== c) parent.set(a, c);
    }
    const sets = new Map();
    for (const s of list) { const r = root(s.id); (sets.get(r) || sets.set(r, []).get(r)).push(s); }
    for (const members of sets.values()) {
      if (!members.some((s) => s.formula)) continue; // (numbers on their own stay numbers)
      const ids = members.map((s) => s.id).sort((a, b) => a - b);
      let bbox = null;
      for (const s of members) bbox = bbox ? [Math.min(bbox[0], s.bbox[0]), Math.min(bbox[1], s.bbox[1]), Math.max(bbox[2], s.bbox[2]), Math.max(bbox[3], s.bbox[3])] : s.bbox.slice();
      const g = { lead: members.filter((s) => s.formula).map((s) => s.id).sort((a, b) => a - b)[0], ids, page: members[0].page, bbox };
      groups.push(g);
      for (const id of ids) byId.set(id, g);
    }
  }
  groups.sort((a, b) => a.lead - b.lead);
  fxGroupCache = { segs, n: segs.length, groups, byId, segOf };
  return fxGroupCache;
}
/** The LaTeX of the formula a segment belongs to: read later (kept per document), or while it was recognised. */
function latexOf(s) {
  if (!s) return "";
  const fg = formulaGroups(), g = fg.byId.get(s.id), lead = g ? g.lead : s.id, ls = g ? fg.segOf.get(lead) : s;
  return state.latex[lead] || (ls && ls.latex) || "";
}
/** The formulas (their leading segments) still without LaTeX. */
function formulasToRead() {
  const fg = formulaGroups();
  return fg.groups.filter((g) => !(state.latex[g.lead] || (fg.segOf.get(g.lead) || {}).latex)).map((g) => g.lead);
}
/** The formula row of a segment's card: its LaTeX (copy, read again), or a button to read it. */
function latexRowHtml(s) {
  if (!s || !s.skip || isBook()) return "";
  const g = formulaGroups().byId.get(s.id);
  if (!g) return "";
  if (g.lead !== s.id) return `<div class="seg-latex part muted small">${escapeHtml(t("fx.partOf", { n: g.lead }))}</div>`;
  const tex = latexOf(s), rest = formulasToRead().length;
  const all = rest > 1 ? `<button type="button" class="mini" data-act="latexAll" title="${escapeHtml(t("fx.allTitle"))}">${escapeHtml(t("fx.all", { n: rest }))}</button>` : "";
  if (!tex) return `<div class="seg-latex none"><button type="button" class="mini" data-act="latexRead" title="${escapeHtml(t("fx.readTitle"))}">${escapeHtml(t("fx.read"))}</button>${all}</div>`;
  return `<div class="seg-latex"><code class="seg-latex-code" title="LaTeX">${escapeHtml(tex)}</code>`
    + `<button type="button" class="mini" data-act="latexCopy" title="${escapeHtml(t("fx.copyTitle"))}">${escapeHtml(t("fx.copy"))}</button>`
    + `<button type="button" class="mini" data-act="latexRead" title="${escapeHtml(t("fx.againTitle"))}">↻</button>${all}</div>`;
}

let fxReader = null, fxIdle = 0; // (the reading model stays loaded a minute after use)
/**
 * The formulas of the segments `ids` read as LaTeX: each formula's area of the original page drawn
 * at the scale pix2tex reads best (from the page's usual text size) and given to the model; kept
 * when the model was sure. The model's files are fetched the first time.
 */
async function readLatexFor(ids) {
  const doc = state.doc, { byId } = formulaGroups();
  const todo = [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))];
  if (!todo.length) return;
  let cancelled = false;
  const cancel = () => { cancelled = true; if (fxReader) { fxReader.terminate(); fxReader = null; } };
  let read = 0, unsure = 0;
  try {
    busy(t("fx.loading"), cancel);
    clearTimeout(fxIdle);
    if (!fxReader) {
      fxReader = await makeFormulaWorker({ read: true }, (name, got, total, whole) => { if (!whole) busy(t("ocr.fxFetching", { name, mb: mbOf(got), total: mbOf(total) }), cancel); });
    }
    const pages = new Map(), bodyOf = new Map();
    for (const [i, g] of todo.entries()) {
      if (cancelled || state.doc !== doc) break;
      busy(t("fx.reading", { i: i + 1, n: todo.length }), cancel);
      // (the page at the scale where its usual letters come out as pix2tex wants them)
      if (!bodyOf.has(g.page)) {
        const sizes = doc.segments.filter((o) => o.page === g.page && !o.skip && o.size).map((o) => o.size).sort((a, b) => a - b);
        bodyOf.set(g.page, sizes.length ? sizes[sizes.length >> 1] : (segById(g.lead).size || 10));
      }
      const zoom = Math.min(4, FORMULA_EM_PX / Math.max(4, bodyOf.get(g.page)));
      if (!pages.has(g.page)) {
        const buf = await pool.leastBusy(null).call("render", { page: g.page, zoom, variant: "original" });
        pages.set(g.page, await imageDataOf(new Blob([buf], { type: "image/png" })));
      }
      const page = doc.pages[g.page], img = pages.get(g.page), [x0, y0, x1, y1] = g.bbox;
      const box = { x0: (x0 - page.x0) * zoom, y0: (y0 - page.y0) * zoom, x1: (x1 - page.x0) * zoom, y1: (y1 - page.y0) * zoom };
      const r = await fxReader.read(formulaCrop(img, box, FORMULA_EM_PX));
      if (r.latex && r.conf >= FORMULA_SURE) { state.latex[g.lead] = r.latex; read++; } else unsure++;
    }
  } catch (err) {
    if (!cancelled) { console.error(err); toast(t("fx.failed", { err: userError(err) }), "error"); }
    return;
  } finally {
    busy("");
    if (fxReader) fxIdle = setTimeout(() => { if (fxReader) { fxReader.terminate(); fxReader = null; } }, 60000);
  }
  if (state.doc !== doc) return;
  saveLatex();
  refreshCards();
  toast(unsure ? t("fx.doneUnsure", { n: read, u: unsure }) : t("fx.done", { n: read }), read ? "ok" : "");
}
