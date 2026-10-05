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
    // (the same one to four tokens over and over, anywhere: a decoder caught in a loop for a while –
    // what it wrote there is no formula, however sure each step was)
    const seq = ids.slice(1);
    let stuck = false;
    for (let k = 1; k <= 4 && !stuck; k++) {
      let run = 0;
      for (let i = k; i < seq.length && !stuck; i++) { run = seq[i] === seq[i - k] ? run + 1 : 0; if (run >= 12) stuck = true; }
    }
    const mean = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
    return { latex: tidy(raw), conf: stuck ? mean * 0.8 : mean };
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
 * The surest reading of a formula's picture (`box` in the page picture's pixels). The letter size
 * of `emPx` is a guess (a formula is often set larger or smaller than the page's text), so when the
 * reading is unsure the formula is read smaller and larger too, and the surest reading is kept. A
 * long line with gaps in it – two formulas with "bzw." between them – that does not read with
 * confidence as a whole is read in its parts (joined with \qquad; a short part the model cannot
 * read, a word between formulas, comes from the OCR's `texts` [{x0, x1, text}] as \text{…}).
 * `limit` {y0, y1}: the cut-out stays between the text lines above and below.
 */
async function readFormulaBest(reader, img, box, emPx, { limit = null, texts = [] } = {}) {
  const readScaled = async (b) => {
    let best = { latex: "", conf: 0 };
    for (const f of [1, 0.75, 1.35, 0.55]) {
      const r = await reader.read(formulaCrop(img, b, emPx / f, limit));
      if (r.conf > best.conf) best = r;
      if (best.conf >= FORMULA_SURE + 0.02) break;
    }
    return best;
  };
  // (parts first: shorter pictures read faster and surer – the decoder's work grows with the
  // square of the length)
  const parts = formulaParts(img, box, emPx);
  let split = null;
  if (parts.length >= 2) {
    const out = [];
    let conf = 1;
    for (const part of parts) {
      // (a short part that OCR read as a word – "bzw.", "und" – is that word)
      const words = texts.filter((w) => (w.x0 + w.x1) / 2 >= part.x0 && (w.x0 + w.x1) / 2 <= part.x1).map((w) => w.text).join(" ").trim();
      const short = part.x1 - part.x0 <= 5 * emPx, plain = /^\p{L}{2,}[.:,;]*$/u.test(words);
      if (short && plain) { out.push(`\\text{${words}}`); continue; }
      const r = await readScaled(part);
      if (r.latex && r.conf >= FORMULA_SURE) { out.push(r.latex); conf = Math.min(conf, r.conf); continue; }
      if (!short || !words || /[\\{}$^_%#&]/.test(words)) { conf = 0; break; }
      out.push(`\\text{${words}}`);
    }
    if (conf >= FORMULA_SURE) split = { latex: out.join("\\qquad "), conf };
    if (split && split.conf >= FORMULA_SURE + 0.02) return split;
  }
  const whole = await readScaled(box);
  return split && split.conf >= whole.conf ? split : whole;
}
/** A formula's box (pixels) cut at gaps without ink of two letters and more: its parts side by side. */
function formulaParts(img, box, emPx) {
  const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(img.width - 1, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(img.height - 1, Math.ceil(box.y1)), d = img.data;
  const inked = [];
  for (let x = x0; x <= x1; x++) {
    let ink = false;
    for (let y = y0; y <= y1 && !ink; y++) { const i = (y * img.width + x) * 4; ink = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140; }
    inked.push(ink);
  }
  const parts = [], least = 2 * emPx;
  let start = -1, gap = 0;
  inked.forEach((ink, k) => {
    if (ink) {
      if (start < 0) start = k;
      else if (gap >= least) { parts.push([start, k - gap - 1]); start = k; }
      gap = 0;
    } else if (start >= 0) gap++;
  });
  if (start >= 0) parts.push([start, inked.length - 1 - gap]);
  return parts.map(([a, b]) => ({ x0: x0 + a, x1: x0 + b + 1, y0: box.y0, y1: box.y1 }));
}

/**
 * Part of a page picture (ImageData) cut out around `box` (pixels) with a white margin, scaled so
 * that letters of `emPx` pixels come out FORMULA_EM_PX tall: what readFormula wants. `limit`
 * {y0, y1}: the margin does not reach past it (the text lines above and below).
 */
function formulaCrop(img, box, emPx, limit = null) {
  const s = FORMULA_EM_PX / Math.max(4, emPx), m = 0.25 * emPx;
  const top = limit ? Math.max(limit.y0, box.y0 - m) : box.y0 - m, bottom = limit ? Math.min(limit.y1, box.y1 + m) : box.y1 + m;
  const x0 = Math.max(0, Math.floor(box.x0 - m)), y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(img.width, Math.ceil(box.x1 + m)), y1 = Math.min(img.height, Math.ceil(bottom));
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
      if (list[i].frame || list[j].frame) continue; // (a frame drawn by hand is a formula of its own)
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
    + `<button type="button" class="mini" data-act="latexRead" title="${escapeHtml(t("fx.againTitle"))}">↻</button>${all}</div>`
    + `<div class="seg-tex" title="${escapeHtml(t("fx.previewTitle"))}" hidden></div>`;
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
      // (clear of the other text above and below; the pieces' own text for a word between formulas)
      const others = doc.segments.filter((o) => o.page === g.page && o.bbox && !g.ids.includes(o.id) && Math.min(o.bbox[2], x1) > Math.max(o.bbox[0], x0));
      const mid = (y0 + y1) / 2, above = others.filter((o) => o.bbox[3] <= mid).map((o) => o.bbox[3]), below = others.filter((o) => o.bbox[1] >= mid).map((o) => o.bbox[1]);
      const limit = { y0: ((above.length ? Math.max(...above) : -1e9) - page.y0) * zoom, y1: ((below.length ? Math.min(...below) : 1e9) - page.y0) * zoom };
      const pieces = g.ids.map((id) => segById(id)).filter(Boolean).flatMap((o) => (o.frame ? o.frame.removed || [] : [o])); // (a frame: the pieces it covers)
      const texts = pieces.map((o) => ({ x0: (o.bbox[0] - page.x0) * zoom, x1: (o.bbox[2] - page.x0) * zoom, text: o.text }));
      const r = await readFormulaBest(fxReader, img, box, FORMULA_EM_PX, { limit, texts });
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

/* ---- formula frames: formulas marked by hand, as pictures for an AI chat */
// A rectangle drawn around a formula (the ∑ tool beside the page) becomes a formula segment of
// its own: the segments inside it go (they come back when the frame is removed), and its area of
// the page is cut out as a picture. The pictures of all frames, each with its number, are put
// together on a few sheets for an AI chat; the answer – [[n]] and the formula as LaTeX, the words
// in it translated – is imported like a translation and kept as the frame's LaTeX. On a page with
// recognised text the frame lives in the stored OCR result, elsewhere among the remembered
// segment edits (repeated when the file opens again).

const FRAME_INSIDE = 0.6; // (a segment with this much of its area in the frame belongs to it)
const SHEET_W = 1400, SHEET_H = 1400, SHEET_PAD = 14, SHEET_ZOOM = 3; // (a sheet: at most this big, formulas at 3 px per point)

function insideFrame(s, box) {
  if (!s.bbox || s.extra) return false;
  const [x0, y0, x1, y1] = s.bbox, area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
  const w = Math.min(x1, box[2]) - Math.max(x0, box[0]), h = Math.min(y1, box[3]) - Math.max(y0, box[1]);
  return w > 0 && h > 0 && (w * h) / area >= FRAME_INSIDE;
}
/** A frame's segment: a formula kept as it is; its text is what the pieces inside it read (a hint). */
function frameSegment(page, box, removed) {
  const sizes = removed.map((s) => s.size).filter(Boolean).sort((a, b) => a - b);
  const size = sizes.length ? sizes[sizes.length >> 1] : 10;
  return {
    id: 0, page, text: removed.map((s) => s.text.trim()).filter(Boolean).join(" "), size, font: "", rotation: 0, lines: 1, line_pitch: size * 1.2,
    skip: true, formula: true, frame: { box: box.slice(), removed }, bbox: box.slice(), color: "#000000", bold: false, italic: false, family: "sans-serif", align: "left",
    origin: [box[0], box[3]], redact: [],
  };
}
/**
 * A segment list with a frame added ({op: "frame", page, box, ocr?}): the segments inside the box
 * taken out and kept with the frame, the frame put where the first of them was (else in reading
 * order), ids redone. {list, remap, sources, fresh: [frame]}, like applySegEdit.
 */
function applyFrameOp(segments, op) {
  const mine = (s) => s.page === op.page && !s.extra && s.bbox && Boolean(s.ocr) === Boolean(op.ocr);
  const removed = segments.filter((s) => mine(s) && insideFrame(s, op.box));
  const frame = frameSegment(op.page, op.box, removed);
  if (op.ocr) frame.ocr = true;
  const list = segments.filter((s) => !removed.includes(s));
  const cy = (op.box[1] + op.box[3]) / 2;
  const after = removed.length
    ? segments.slice(segments.indexOf(removed[0])).find((s) => !removed.includes(s))
    : list.find((s) => s.page > op.page || (mine(s) && (s.bbox[1] + s.bbox[3]) / 2 > cy));
  list.splice(after ? list.indexOf(after) : list.length, 0, frame);
  const oldId = new Map(segments.map((s) => [s, s.id])), remap = new Map();
  list.forEach((s, i) => { if (oldId.has(s)) remap.set(oldId.get(s), i + 1); s.id = i + 1; });
  return { list, remap, sources: removed, fresh: [frame] };
}

/** A frame drawn on a page: in the page's OCR result when it has one, else as a segment edit. */
async function addFormulaFrame(page, box) {
  const doc = state.doc;
  if (!doc || isBook()) return false;
  const r2 = (v) => Math.round(v * 100) / 100;
  box = box.map(r2);
  const rec = ocrRecord(page);
  if (!rec) return runSegEdit({ op: "frame", page, box });
  const r = applyFrameOp(rec.segs, { op: "frame", page, box, ocr: true });
  addOcrResults({ [page]: { segs: r.list, seps: rec.seps, raw: rec.raw, family: rec.family } });
  const frame = doc.ocr[page].segs.find((s) => s.frame && sameBox(s.bbox, box));
  if (frame) {
    setActive(frame.id, { scrollList: true, scrollViewer: true });
    toast(t("fx.frameAdded", { n: frame.id }), "ok", { label: t("seg.undo"), run: () => { if (state.doc === doc && segById(frame.id) === frame) removeFormulaFrame(frame.id, true); } });
  }
  return true;
}
/** The frame removed: the segments it covered come back in its place. */
function removeFormulaFrame(id, quiet = false) {
  const doc = state.doc, s = segById(id);
  if (!s || !s.frame) return;
  const back = s.frame.removed || [];
  if (s.ocr) {
    const rec = ocrRecord(s.page);
    if (!rec) return;
    const segs = rec.segs.slice();
    segs.splice(segs.indexOf(s), 1, ...back);
    addOcrResults({ [s.page]: { segs, seps: rec.seps, raw: rec.raw, family: rec.family } });
  } else {
    const list = doc.segments.slice();
    list.splice(list.indexOf(s), 1, ...back);
    const oldId = new Map(doc.segments.map((x) => [x, x.id])), remap = new Map();
    list.forEach((x, i) => { if (oldId.has(x)) remap.set(oldId.get(x), i + 1); x.id = i + 1; });
    state.segEdits = (state.segEdits || []).filter((op) => !(op.op === "frame" && op.page === s.page && sameBox(op.box, s.frame.box)));
    saveSegEdits();
    relistSegments(doc, { list, remap });
  }
  if (back.length) setActive(back[0].id, { scrollList: true });
  if (!quiet) toast(t("fx.frameRemoved"));
}
/** The LaTeX of a frame, typed or imported: kept with the document (an empty text drops it). */
function setFrameLatex(id, value) {
  const v = cleanLatex(value);
  if (v) state.latex[id] = v; else delete state.latex[id];
  saveLatex();
  markDone(id);
}
/** An AI's LaTeX without the wrapping it likes to add (a code block, $…$, \[…\]). */
function cleanLatex(text) {
  let v = String(text || "").trim();
  v = v.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```$/, "").trim();
  v = v.replace(/^\\\[\s*/, "").replace(/\s*\\\]$/, "").replace(/^\\\(\s*/, "").replace(/\s*\\\)$/, "");
  v = v.replace(/^\$\$?\s*/, "").replace(/\s*\$\$?$/, "");
  return v.replace(/^\\begin\{(equation|displaymath|align)\*?\}\s*/, "").replace(/\s*\\end\{(equation|displaymath|align)\*?\}$/, "").trim();
}
/** A frame counts as done once it has its LaTeX; any other segment once it has a translation. */
const segDone = (id) => { const s = segById(id); return s && s.frame ? Boolean(state.latex[id]) : hasTr(id); };
/** What a segment's card shows in its box: the translation, for a frame its LaTeX. */
const cardValue = (id) => { const s = segById(id); return (s && s.frame ? state.latex[id] : state.translations[id]) || ""; };

/* ---- LaTeX set as a formula (KaTeX, fetched once): the eye checks it against the picture */

const KATEX_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/";
let katexLoading = null;
/** KaTeX (script and stylesheet) from the CDN, once; rejects where it cannot be fetched (offline). */
function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (!katexLoading) {
    katexLoading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${KATEX_URL}katex.min.css`;
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = `${KATEX_URL}katex.min.js`;
      js.onload = () => (window.katex ? resolve(window.katex) : reject(new Error("KaTeX")));
      js.onerror = () => { katexLoading = null; js.remove(); css.remove(); reject(new Error("KaTeX")); };
      document.head.appendChild(js);
    });
  }
  return katexLoading;
}
/**
 * The LaTeX `tex` set as a formula in `el` (hidden when there is none): what the eye compares with
 * the picture of the formula. Mistakes KaTeX cannot set are shown in red; without KaTeX (offline)
 * the LaTeX stands there as text.
 */
function texPreview(el, tex) {
  if (!el) return;
  tex = (tex || "").trim();
  el.hidden = !tex;
  if (!tex) { el.replaceChildren(); return; }
  el.dataset.tex = tex;
  loadKatex().then((katex) => {
    if (el.dataset.tex !== tex) return; // (changed meanwhile)
    el.classList.remove("plain");
    katex.render(tex, el, { throwOnError: false, displayMode: true, errorColor: "#d32f2f", strict: "ignore", trust: false, output: "html" });
    vl.measure(el.closest(".seg"));
    document.fonts?.ready.then(() => vl.measure(el.closest(".seg"))); // (KaTeX's fonts arrive later still)
  }).catch(() => { el.classList.add("plain"); el.textContent = tex; vl.measure(el.closest(".seg")); });
}
const texPreviewTimers = new Map();
/** The preview of a card's formula, a moment after the LaTeX was typed. */
function texPreviewSoon(id) {
  clearTimeout(texPreviewTimers.get(id));
  texPreviewTimers.set(id, setTimeout(() => {
    texPreviewTimers.delete(id);
    const card = vl.rendered.get(id);
    if (card) texPreview(card.querySelector(".seg-tex"), latexOf(segById(id)));
  }, 350));
}

/* ---- the pictures: a frame's area of the page, and the sheets for the AI */

const frameCache = { doc: null, pages: new Map(), thumbs: new Map() };
function frameCacheClear() {
  for (const p of frameCache.thumbs.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  for (const p of frameCache.pages.values()) p.then((b) => b.close && b.close()).catch(() => {});
  frameCache.thumbs.clear();
  frameCache.pages.clear();
  frameCache.doc = state.doc;
}
/** A frame's area of the original page as a canvas, `zoom` pixels per point, turned as the page is shown. */
async function frameCanvas(s, zoom) {
  const doc = state.doc, page = doc.pages[s.page], key = `${s.page}@${zoom}`;
  if (frameCache.doc !== doc) frameCacheClear();
  if (!frameCache.pages.has(key)) {
    if (frameCache.pages.size >= 4) { const k = frameCache.pages.keys().next().value; frameCache.pages.get(k).then((b) => b.close && b.close()).catch(() => {}); frameCache.pages.delete(k); }
    frameCache.pages.set(key, pool.leastBusy(null).call("render", { page: s.page, zoom, variant: "original" }).then((buf) => createImageBitmap(new Blob([buf], { type: "image/png" }))));
  }
  const bmp = await frameCache.pages.get(key), [x0, y0, x1, y1] = s.bbox;
  const sx = Math.max(0, Math.round((x0 - page.x0) * zoom)), sy = Math.max(0, Math.round((y0 - page.y0) * zoom));
  const sw = Math.max(1, Math.min(bmp.width - sx, Math.round((x1 - x0) * zoom))), sh = Math.max(1, Math.min(bmp.height - sy, Math.round((y1 - y0) * zoom)));
  const rot = pageRotation(s.page), c = document.createElement("canvas");
  c.width = rot % 180 ? sh : sw;
  c.height = rot % 180 ? sw : sh;
  const cx = c.getContext("2d");
  cx.translate(c.width / 2, c.height / 2);
  cx.rotate((rot * Math.PI) / 180);
  cx.drawImage(bmp, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  return c;
}
/** The small picture of a frame in its card (drawn once per frame while the document is open). */
async function frameThumb(img, s) {
  if (!img) return;
  const key = `${s.page}:${s.bbox.join(",")}:${pageRotation(s.page)}`;
  if (frameCache.doc !== state.doc) frameCacheClear();
  if (!frameCache.thumbs.has(key)) {
    frameCache.thumbs.set(key, frameCanvas(s, 2).then((c) => new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), "image/png"))));
  }
  img.addEventListener("load", () => vl.measure(img.closest(".seg")), { once: true }); // (the card grew: the list places the next cards anew)
  try { img.src = await frameCache.thumbs.get(key); } catch (_) { /* the picture stays empty */ }
}
/**
 * The frames put together on sheets for the AI: each formula at 3 px per point (smaller when wide),
 * its number in blue at the left, as many under each other as fit a sheet. [{ids, canvas}]
 */
async function formulaSheets(frames, note = "") {
  const sheets = [];
  let cur = null;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = "bold 20px system-ui, sans-serif";
  const labelW = Math.ceil(Math.max(...frames.map((s) => probe.measureText(`[[${s.id}]]`).width), 40)) + 16;
  const maxW = SHEET_W - labelW - 2 * SHEET_PAD;
  // (the instruction for the AI on top of every sheet, so a picture pasted alone is understood too)
  const minW = note ? Math.min(SHEET_W, 900) : 0;
  const noteLines = note ? wrapText(probe, note, "17px system-ui, sans-serif", Math.max(minW, labelW + 2 * SHEET_PAD + 400) - 2 * SHEET_PAD) : [];
  const top = noteLines.length ? SHEET_PAD + noteLines.length * 23 + SHEET_PAD : 0;
  for (const s of frames) {
    const zoom = Math.max(1, Math.min(SHEET_ZOOM, maxW / Math.max(1, s.bbox[2] - s.bbox[0])));
    const c = await frameCanvas(s, zoom);
    const scale = Math.min(1, maxW / c.width, (SHEET_H - 2 * SHEET_PAD) / c.height);
    const w = Math.round(c.width * scale), h = Math.round(c.height * scale);
    if (!cur || (cur.rows.length && cur.h + h + SHEET_PAD > SHEET_H)) { cur = { ids: [], rows: [], h: top + SHEET_PAD }; sheets.push(cur); }
    cur.rows.push({ id: s.id, c, w, h, y: cur.h });
    cur.ids.push(s.id);
    cur.h += h + SHEET_PAD;
  }
  return sheets.map((sh) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(minW, labelW + 2 * SHEET_PAD + Math.max(...sh.rows.map((r) => r.w)));
    canvas.height = sh.h;
    const cx = canvas.getContext("2d");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, canvas.width, canvas.height);
    cx.textBaseline = "top";
    if (noteLines.length) {
      cx.font = "17px system-ui, sans-serif";
      cx.fillStyle = "#333";
      noteLines.forEach((l, i) => cx.fillText(l, SHEET_PAD, SHEET_PAD + i * 23));
      cx.fillStyle = "#1a56db";
      cx.fillRect(SHEET_PAD, top - 3, canvas.width - 2 * SHEET_PAD, 2);
    }
    cx.font = probe.font;
    sh.rows.forEach((r, i) => {
      if (i) { cx.fillStyle = "#d4d4d4"; cx.fillRect(SHEET_PAD, r.y - SHEET_PAD / 2 - 1, canvas.width - 2 * SHEET_PAD, 2); }
      cx.fillStyle = "#1a56db";
      cx.fillText(`[[${r.id}]]`, SHEET_PAD, r.y + 2);
      cx.drawImage(r.c, SHEET_PAD + labelW, r.y, r.w, r.h);
    });
    return { ids: sh.ids, canvas };
  });
}

/** A text broken into lines that fit `width` in `font`. */
function wrapText(cx, text, font, width) {
  cx.font = font;
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (cx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/* ---- the AI window: the formula prompt, the sheets to copy or save, the answer */

const aiFx = { key: "", sheets: [], copied: new Set(), promptCopied: false, gen: 0 };
/** The frames the AI window offers: in its page range (and, if so chosen, without LaTeX yet). */
function aiFrames() {
  if (!state.doc || isBook()) return [];
  const n = state.doc.pages.length;
  const from = Math.min(n, Math.max(1, Number($("#aiFrom").value) || 1)) - 1;
  const to = Math.min(n, Math.max(from + 1, Number($("#aiTo").value) || n)) - 1;
  return state.doc.segments.filter((s) => s.frame && s.page >= from && s.page <= to && (!$("#aiOnlyTodo").checked || !state.latex[s.id]));
}
function fxPromptText(frames, sheets) {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#aiTarget").value.trim() || P.target;
  return [...P.formulas(target, frames.length, Math.max(1, sheets)), "", `${P.formulaList} ${frames.map((s) => `[[${s.id}]]`).join(" ")}`].join("\n");
}
/** The short form of the prompt written on top of every sheet. */
function fxSheetNote() {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  return P.formulaSheet($("#aiTarget").value.trim() || P.target);
}
/** The formula part of the AI window: shown when the document has frames; the sheets are made once per selection. */
function refreshAiFormulas() {
  const box = $("#aiFx");
  if (!box) return;
  const frames = aiFrames();
  box.hidden = !frames.length;
  if (!frames.length) { aiFx.key = ""; aiFx.sheets = []; aiFx.gen++; return; }
  const key = JSON.stringify([state.doc.id, LANG, $("#aiTarget").value.trim(), frames.map((s) => [s.id, s.bbox, pageRotation(s.page)])]);
  if (key === aiFx.key) { aiFxButtons(frames); return; }
  aiFx.key = key;
  aiFx.sheets = [];
  aiFx.copied.clear();
  aiFx.promptCopied = false;
  const gen = ++aiFx.gen;
  $("#aiFxHint").textContent = t("ai.fxPreparing", { n: frames.length });
  $("#aiFxSheets").innerHTML = "";
  formulaSheets(frames, fxSheetNote()).then((sheets) => { if (gen !== aiFx.gen) return; aiFx.sheets = sheets; aiFxButtons(frames); })
    .catch((err) => { console.error(err); if (gen === aiFx.gen) $("#aiFxHint").textContent = userError(err); });
}
function aiFxButtons(frames) {
  const total = aiFx.sheets.length;
  $("#aiFxHint").textContent = t("ai.fxHint", { n: frames.length, k: total });
  $("#aiFxPrompt").classList.toggle("primary", !aiFx.promptCopied);
  $("#aiFxSheets").innerHTML = aiFx.sheets.map((sh, i) => {
    const done = sh.ids.every((id) => state.latex[id]);
    const cls = done ? " done" : aiFx.copied.has(i) ? " copied" : "";
    return `<button type="button" class="btn${cls}" data-sheet="${i}" title="${escapeHtml(t("ai.fxSheetTitle"))}">${done || aiFx.copied.has(i) ? "✓ " : ""}${escapeHtml(t("ai.fxSheet", { k: i + 1, total, a: sh.ids[0], b: sh.ids[sh.ids.length - 1], n: sh.ids.length }))}</button>`;
  }).join("");
}
const sheetBlob = (sh) => new Promise((res) => sh.canvas.toBlob(res, "image/png"));
/**
 * A sheet to the clipboard as a picture – together with the formula prompt as text, so a chat that
 * takes both from one paste gets the instructions too (saved as a file where the browser cannot
 * put pictures on the clipboard).
 */
async function copySheet(i) {
  const sh = aiFx.sheets[i];
  if (!sh) return;
  const blob = await sheetBlob(sh);
  try {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === "undefined") throw new Error("no picture clipboard");
    const text = new Blob([fxPromptText(aiFrames(), aiFx.sheets.length)], { type: "text/plain" });
    try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": text, "image/png": blob })]); }
    catch (_) { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); }
    toast(t("ai.fxCopied", { k: i + 1, total: aiFx.sheets.length }), "ok");
  } catch (_) {
    saveBlob(blob, `Kameleon-${t("ai.fxFile")}-${i + 1}.png`);
    toast(t("ai.fxSavedInstead"));
  }
  aiFx.copied.add(i);
  aiFxButtons(aiFrames());
  const b = $(`#aiFxSheets [data-sheet="${i}"]`);
  if (b) { b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash"); }
}
async function saveSheets() {
  if (!aiFx.sheets.length) return;
  for (const [i, sh] of aiFx.sheets.entries()) {
    saveBlob(await sheetBlob(sh), `Kameleon-${t("ai.fxFile")}-${i + 1}.png`);
    if (i < aiFx.sheets.length - 1) await new Promise((res) => setTimeout(res, 400)); // (the browser takes several downloads one after the other)
  }
  toast(t("ai.fxSaved", { n: aiFx.sheets.length }), "ok");
}
(function initFormulaFrames() {
  const sheets = $("#aiFxSheets");
  if (!sheets) return;
  sheets.addEventListener("click", (e) => { const b = e.target.closest("[data-sheet]"); if (b) copySheet(Number(b.dataset.sheet)); });
  $("#aiFxPrompt").addEventListener("click", () => {
    const frames = aiFrames();
    if (!frames.length) { toast(t("msg.noSelection"), "error"); return; }
    copyText(fxPromptText(frames, aiFx.sheets.length), t("ai.fxPromptCopied"));
    aiFx.promptCopied = true;
    aiFxButtons(frames);
  });
  $("#aiFxSave").addEventListener("click", saveSheets);
})();
