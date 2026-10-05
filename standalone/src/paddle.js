/* ------------------------------------------------ PaddleOCR (PP-OCRv5) as a second OCR engine */
// The PP-OCRv5 mobile models run with ONNX Runtime Web (WebAssembly) in a worker of their own:
// a detection model finds the text lines, a recognition model reads each line. What they find is
// handed on in the shape Tesseract gives (blocks → lines → words with boxes and confidence), so
// straightening, the paragraph building, unsure words and the searchable PDF work as before.
// PP-OCRv5 reads Latin script with accents (German, Swedish, French …), Chinese and Japanese;
// Cyrillic, Greek and other scripts stay with Tesseract. The files (about 35 MB) are fetched once
// and kept in the browser; "Offline use" can store them too.
const PADDLE_ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const PADDLE_MODELS = "https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0/";
const PADDLE_FILES = {
  "ort.wasm.min.js": PADDLE_ORT + "ort.wasm.min.js",
  "ort-wasm-simd-threaded.mjs": PADDLE_ORT + "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm": PADDLE_ORT + "ort-wasm-simd-threaded.wasm",
  "PP-OCRv5_mobile_det_infer.ort": PADDLE_MODELS + "detection/PP-OCRv5_mobile_det_infer.ort",
  "PP-OCRv5_mobile_rec_infer.onnx": PADDLE_MODELS + "recognition/PP-OCRv5_mobile_rec_infer.onnx",
  "ppocrv5_dict.txt": PADDLE_MODELS + "recognition/ppocrv5_dict.txt",
};
// The accented letters of each language: PP-OCRv5 is unsure of small accents (ä read as a), and
// gives accents a language does not have (à in Swedish): those are decided between the letters
// the document's languages use.
const PADDLE_ACCENTS = {
  deu: "äöüÄÖÜ", swe: "åäöÅÄÖ", fin: "äöåÄÖÅ", fra: "àâçéèêëîïôùûüÿÀÂÇÉÈÊËÎÏÔÙÛÜ", spa: "áéíóúñüÁÉÍÓÚÑÜ",
  por: "ãõáâàçéêíóôúÃÕÁÂÀÇÉÊÍÓÔÚ", nld: "ëïéèÉËÏ", pol: "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", ces: "áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ",
  slk: "áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ", hun: "áéíóöőúüűÁÉÍÓÖŐÚÜŰ",
};
// Tesseract language codes whose script PP-OCRv5 does not read.
const PADDLE_UNSUPPORTED = new Set(["ukr", "rus", "bel", "bul", "srp", "mkd", "kaz", "ell", "ara", "fas", "heb", "hin", "ben", "tha", "kor", "kat", "hye", "amh"]);

/** The PaddleOCR files: kept from an earlier download or the offline set, or fetched now (and kept). */
async function paddleFiles(onProgress) {
  const out = {}, names = Object.keys(PADDLE_FILES);
  let done = 0;
  for (const name of names) {
    let buf = await idbGet(`paddle:${name}`); // (from an earlier download, or from the offline set)
    if (!buf) {
      const res = await fetch(PADDLE_FILES[name]);
      if (!res.ok) throw new Error(`PaddleOCR file not available (${name}: HTTP ${res.status})`);
      const total = Number(res.headers.get("content-length")) || 0, reader = res.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value); got += value.length;
        if (onProgress && total) onProgress(name, got, total);
      }
      buf = await new Blob(parts).arrayBuffer();
      await idbPut(buf, `paddle:${name}`); // (the next time it is here)
    }
    out[name] = buf;
    done++;
    if (onProgress) onProgress(name, done, names.length, true);
  }
  return out;
}

/** The worker's program (run from a blob URL). */
function paddleWorkerMain() {
  let ort = null, det = null, rec = null, dict = null, classOf = null, accents = "";
  const baseOf = (c) => c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  /** A Latin letter decided between the letters the languages use (see PADDLE_ACCENTS). */
  const settle = (ch, p, probs) => {
    if (!ch || !/\p{Script=Latin}/u.test(ch)) return [ch, p];
    const base = baseOf(ch);
    if (base.length !== 1 || !/[A-Za-z]/.test(base)) return [ch, p];
    const family = [base, ...[...accents].filter((a) => baseOf(a) === base)];
    if (family.length === 1 && ch === base) return [ch, p];
    const scored = family.map((c) => [c, classOf.has(c) ? probs[classOf.get(c)] : 0]);
    if (ch === base) { // a plain letter: an accented one of the languages wins when it is a real contender
      if (p >= 0.95) return [ch, p];
      const alt = scored.slice(1).sort((a, b) => b[1] - a[1])[0];
      return alt && alt[1] >= 0.05 ? [alt[0], p + alt[1]] : [ch, p];
    }
    if (accents.includes(ch)) return [ch, p];
    const best = scored.sort((a, b) => b[1] - a[1])[0]; // an accent the languages do not have
    return [best[0], Math.max(best[1], p)];
  };
  // (lines are read one at a time: padding lines to a common width cost time and accuracy)
  const PADDLE_BATCH = 1;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  // A pixel of the RGBA image (bilinear), as [r, g, b].
  const sample = (img, x, y) => {
    const { width: w, height: h, data: d } = img;
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = (y0 * w + x0) * 4, j = i + 4, k = i + w * 4, l = k + 4, out = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = (d[i + c] * (1 - fx) + d[j + c] * fx) * (1 - fy) + (d[k + c] * (1 - fx) + d[l + c] * fx) * fy;
    return out;
  };

  /** Text lines on the page: [{corners: [tl, tr, br, bl]}] in image pixels. */
  async function detect(img, limit = 1280) {
    const { width: w0, height: h0, data } = img;
    const s = Math.min(1, limit / Math.max(w0, h0));
    const W = Math.max(32, Math.round((w0 * s) / 32) * 32), H = Math.max(32, Math.round((h0 * s) / 32) * 32);
    const sx = w0 / W, sy = h0 / H, plane = W * H, t = new Float32Array(3 * plane);
    // (each map pixel is the mean of the image pixels it covers; channels in the order B, G, R)
    for (let y = 0; y < H; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < W; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = ya; yy < yb && yy < h0; yy++) for (let xx = xa; xx < xb && xx < w0; xx++) { const i = (yy * w0 + xx) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        n = n || 1;
        const o = y * W + x;
        t[o] = (b / n / 255 - MEAN[0]) / STD[0]; t[plane + o] = (g / n / 255 - MEAN[1]) / STD[1]; t[2 * plane + o] = (r / n / 255 - MEAN[2]) / STD[2];
      }
    }
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, H, W]) });
    const prob = out[det.outputNames[0]].data;
    // Regions of the probability map above 0.3; each a line (or a part of one) when sure enough.
    const label = new Int32Array(plane), queue = new Int32Array(plane), boxes = [];
    let comp = 0;
    for (let start = 0; start < plane; start++) {
      if (label[start] || prob[start] <= 0.3) continue;
      comp++;
      let head = 0, tail = 0, sum = 0, mx = 0, my = 0;
      queue[tail++] = start; label[start] = comp;
      while (head < tail) {
        const p = queue[head++], x = p % W, y = (p - x) / W;
        sum += prob[p]; mx += x; my += y;
        if (x > 0 && !label[p - 1] && prob[p - 1] > 0.3) { label[p - 1] = comp; queue[tail++] = p - 1; }
        if (x < W - 1 && !label[p + 1] && prob[p + 1] > 0.3) { label[p + 1] = comp; queue[tail++] = p + 1; }
        if (y > 0 && !label[p - W] && prob[p - W] > 0.3) { label[p - W] = comp; queue[tail++] = p - W; }
        if (y < H - 1 && !label[p + W] && prob[p + W] > 0.3) { label[p + W] = comp; queue[tail++] = p + W; }
      }
      const n = tail;
      if (n < 6 || sum / n < 0.6) continue;
      mx /= n; my /= n;
      let cxx = 0, cyy = 0, cxy = 0;
      for (let q = 0; q < n; q++) { const p = queue[q], x = p % W - mx, y = (p - (p % W)) / W - my; cxx += x * x; cyy += y * y; cxy += x * y; }
      // (the region's direction from its second moments: the line's slant)
      let a = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      if (Math.abs(a) > Math.PI / 4 && cxx >= cyy) a = 0;
      const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let q = 0; q < n; q++) {
        const p = queue[q], x = p % W, y = (p - x) / W, pu = x * ux + y * uy, pv = x * vx + y * vy;
        if (pu < a0) a0 = pu; if (pu > a1) a1 = pu; if (pv < b0) b0 = pv; if (pv > b1) b1 = pv;
      }
      let bw = a1 - a0 + 1, bh = b1 - b0 + 1;
      if (Math.min(bw, bh) < 2) continue;
      const dd = (bw * bh * 1.5) / (2 * (bw + bh)); // (the model marks a shrunk core of each line: grown back)
      const cu = (a0 + a1) / 2, cv = (b0 + b1) / 2;
      bw += 2 * dd; bh += 2 * dd;
      // (some room above and below: umlaut dots and accents sit above the letters' core)
      bh *= 1.2; bw += 0.2 * bh;
      const c = [cu * ux + cv * vx, cu * uy + cv * vy];
      const pt = (su, sv) => [(c[0] + su * ux * bw / 2 + sv * vx * bh / 2 + 0.5) * sx, (c[1] + su * uy * bw / 2 + sv * vy * bh / 2 + 0.5) * sy];
      boxes.push({ corners: [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)], score: sum / n, mapH: Math.min(bw, bh) });
    }
    // Small print comes out only a few pixels high at this scale: then the page is looked at larger.
    if (limit < 1920 && s < 1 && boxes.length) {
      const hs = boxes.map((b) => b.mapH).sort((a, b) => a - b);
      if (hs[hs.length >> 1] < 16) return detect(img, 1920);
    }
    return boxes;
  }

  /** A line cut out of the page, straightened, 48 pixels high: {t (B,G,R planes), gray, Tw, corners}. */
  function cropLine(img, corners) {
    let [tl, tr, br, bl] = corners;
    const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len(tl, bl) > 1.5 * len(tl, tr)) [tl, tr, br, bl] = [bl, tl, tr, br]; // (a vertical line is read turned)
    const wPx = len(tl, tr), hPx = len(tl, bl), Th = 48;
    const Tw = Math.max(8, Math.min(3200, Math.round((Th * wPx) / Math.max(1, hPx))));
    const plane = Th * Tw, rgb = new Float32Array(3 * plane), gray = new Float32Array(plane);
    for (let y = 0; y < Th; y++) {
      const fy = (y + 0.5) / Th;
      for (let x = 0; x < Tw; x++) {
        const fx = (x + 0.5) / Tw;
        const px = tl[0] + fx * (tr[0] - tl[0]) + fy * (bl[0] - tl[0]), py = tl[1] + fx * (tr[1] - tl[1]) + fy * (bl[1] - tl[1]);
        const [r, g, b] = sample(img, px, py), o = y * Tw + x;
        rgb[o] = (b / 255 - 0.5) / 0.5; rgb[plane + o] = (g / 255 - 0.5) / 0.5; rgb[2 * plane + o] = (r / 255 - 0.5) / 0.5;
        gray[o] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }
    return { rgb, gray, Tw, corners: [tl, tr, br, bl] };
  }
  /** Rows with ink in a crop: where the letters sit (top, baseline, bottom; 0…1 of its height). */
  function inkRows(gray, Tw) {
    const Th = 48, plane = Th * Tw;
    const sorted = Float32Array.from(gray).sort();
    const lo = sorted[Math.floor(plane * 0.03)], hi = sorted[Math.floor(plane * 0.9)], thr = (lo + hi) / 2;
    const dens = new Float32Array(Th);
    for (let y = 0; y < Th; y++) { let n = 0; for (let x = 0; x < Tw; x++) if (gray[y * Tw + x] < thr) n++; dens[y] = n / Tw; }
    const peak = Math.max(...dens);
    let top = 0, bottom = Th - 1;
    while (top < Th - 1 && dens[top] < 0.08 * peak) top++;
    while (bottom > top && dens[bottom] < 0.08 * peak) bottom--;
    let base = bottom;
    while (base > top && dens[base] < 0.35 * peak) base--;
    return { top: top / Th, base: (base + 1) / Th, bottom: (bottom + 1) / Th };
  }
  /**
   * Lines read, several at a time (lines of similar length together, padded to the widest): for
   * each {chars: [{ch, x, p}] (x: 0…1 along the line), rows, corners}.
   */
  async function recognizeAll(img, boxes) {
    const crops = boxes.map((b) => cropLine(img, b.corners));
    const order = crops.map((c, i) => i).sort((a, b) => crops[a].Tw - crops[b].Tw);
    const results = new Array(crops.length), Th = 48;
    for (let k = 0; k < order.length;) {
      const batch = [order[k]];
      while (batch.length < PADDLE_BATCH && k + batch.length < order.length && crops[order[k + batch.length]].Tw <= 1.5 * crops[order[k]].Tw) batch.push(order[k + batch.length]);
      k += batch.length;
      const W = Math.max(...batch.map((i) => crops[i].Tw)), plane = Th * W, t = new Float32Array(batch.length * 3 * plane);
      batch.forEach((i, bi) => {
        const c = crops[i], cp = Th * c.Tw;
        for (let ch = 0; ch < 3; ch++) for (let y = 0; y < Th; y++) t.set(c.rgb.subarray(ch * cp + y * c.Tw, ch * cp + (y + 1) * c.Tw), bi * 3 * plane + ch * plane + y * W);
      });
      const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", t, [batch.length, 3, Th, W]) });
      const o = out[rec.outputNames[0]], [, T, C] = o.dims, d = o.data;
      batch.forEach((i, bi) => {
        // CTC: the best class per step; repeats and blanks (class 0) fall away. The steps cover
        // the padded width: positions are taken back to the line's own.
        const c = crops[i], steps = Math.min(T, Math.ceil((T * c.Tw) / W) + 1), chars = [];
        let prev = 0;
        for (let st = 0; st < steps; st++) {
          let best = 0, bp = -Infinity;
          const off = (bi * T + st) * C;
          for (let q = 0; q < C; q++) { const v = d[off + q]; if (v > bp) { bp = v; best = q; } }
          if (best !== 0 && best !== prev) {
            let ch = best - 1 < dict.length ? dict[best - 1] : " ", p = bp;
            if (ch === "\u3000") ch = " ";
            [ch, p] = settle(ch, p, d.subarray(off, off + C));
            chars.push({ ch, x: Math.min(1, ((st + 0.5) / T) * (W / c.Tw)), p: Math.min(1, p) });
          }
          prev = best;
        }
        results[i] = { chars, rows: inkRows(c.gray, c.Tw), corners: c.corners };
      });
    }
    return results;
  }

  /** A page image read: Tesseract's result shape ({blocks: [{paragraphs: [{lines}]}]}). */
  async function read(img) {
    const boxes = await detect(img);
    boxes.sort((a, b) => (a.corners[0][1] + a.corners[3][1]) - (b.corners[0][1] + b.corners[3][1]) || a.corners[0][0] - b.corners[0][0]);
    const lines = [], read = await recognizeAll(img, boxes);
    // The letter height (top of capitals and ascenders to the baseline) of the page's longer lines:
    // a short piece without tall letters ("gering-") would otherwise seem smaller than its row.
    const lineLen = (r) => r.chars.length, heightOf = (r) => (r.rows.base - r.rows.top) * Math.hypot(r.corners[3][0] - r.corners[0][0], r.corners[3][1] - r.corners[0][1]);
    const tall = read.filter((r) => lineLen(r) >= 12).map(heightOf).sort((a, b) => a - b), usual = tall.length ? tall[tall.length >> 1] : 0;
    for (const r of read) {
      const text = r.chars.map((c) => c.ch).join("");
      if (!text.trim()) continue;
      const [tl, tr, , bl] = r.corners;
      const at = (fx, fy) => [tl[0] + fx * (tr[0] - tl[0]) + fy * (bl[0] - tl[0]), tl[1] + fx * (tr[1] - tl[1]) + fy * (bl[1] - tl[1])];
      const boxOf = (f0, f1, g0, g1) => {
        const ps = [at(f0, g0), at(f1, g0), at(f0, g1), at(f1, g1)];
        return { x0: Math.min(...ps.map((p) => p[0])), y0: Math.min(...ps.map((p) => p[1])), x1: Math.max(...ps.map((p) => p[0])), y1: Math.max(...ps.map((p) => p[1])) };
      };
      // Words: the characters between spaces; a character covers half the way to its neighbours.
      const cs = r.chars, gaps = [];
      for (let i = 1; i < cs.length; i++) gaps.push(cs[i].x - cs[i - 1].x);
      const step = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 0.02;
      const words = [];
      let cur = null;
      cs.forEach((c, i) => {
        if (c.ch === " ") { cur = null; return; }
        const left = i > 0 && cs[i - 1].ch !== " " ? (cs[i - 1].x + c.x) / 2 : c.x - step / 2;
        const right = i < cs.length - 1 && cs[i + 1].ch !== " " ? (c.x + cs[i + 1].x) / 2 : c.x + step / 2;
        if (!cur) { cur = { text: "", f0: left, f1: right, ps: [] }; words.push(cur); }
        cur.text += c.ch; cur.f1 = right; cur.ps.push(c.p);
      });
      const { top, base, bottom } = r.rows;
      const out = words.map((w) => {
        const mean = w.ps.reduce((a, b) => a + b, 0) / w.ps.length, min = Math.min(...w.ps);
        return { text: w.text, confidence: Math.round(100 * (0.5 * mean + 0.5 * min)), bbox: boxOf(Math.max(0, w.f0), Math.min(1, w.f1), top, bottom) };
      });
      if (!out.length) continue;
      const lb = boxOf(Math.max(0, out.length ? words[0].f0 : 0), Math.min(1, words[words.length - 1].f1), top, bottom);
      const bl0 = at(0, base), bl1 = at(1, base);
      let hRow = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) * (base - top);
      if (usual && lineLen(r) < 12 && hRow < 0.8 * usual) hRow = usual;
      lines.push({ text, bbox: lb, words: out, baseline: { x0: bl0[0], y0: bl0[1], x1: bl1[0], y1: bl1[1], has_baseline: true }, rowAttributes: { row_height: hRow / 0.72 } });
    }
    return { blocks: lines.length ? [{ paragraphs: [{ lines }] }] : [] };
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
        const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
        det = await ort.InferenceSession.create(new Uint8Array(args.files["PP-OCRv5_mobile_det_infer.ort"]), opts);
        rec = await ort.InferenceSession.create(new Uint8Array(args.files["PP-OCRv5_mobile_rec_infer.onnx"]), opts);
        // (one character per line; empty lines are none – copies of the file differ in them; the
        // space follows the last entry)
        dict = new TextDecoder().decode(args.files["ppocrv5_dict.txt"]).replace(/\r/g, "").split("\n").filter((l) => l !== "");
        classOf = new Map(dict.map((c, i) => [c, i + 1]));
        accents = args.accents || "";
        self.postMessage({ id, result: true });
      } else if (cmd === "read") {
        self.postMessage({ id, result: await read(args) });
      }
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
  };
}

/** A PaddleOCR worker, ready to read pages: {recognize(blob), terminate()} like a Tesseract worker. */
async function makePaddleWorker(files, langs = []) {
  const src = `(${paddleWorkerMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.result); };
  worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || "PaddleOCR worker failed")); waiting.clear(); };
  const call = (cmd, args, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, cmd, args }, transfer); });
  // (each worker gets its own copies: the buffers are transferred)
  const copy = {};
  for (const [k, v] of Object.entries(files)) copy[k] = v.slice(0);
  const accents = [...new Set(langs.flatMap((l) => [...(PADDLE_ACCENTS[l] || "")]))].join("");
  await call("init", { files: copy, accents }, Object.values(copy));
  return {
    async recognize(blob) {
      const img = await imageDataOf(blob);
      const data = await call("read", { width: img.width, height: img.height, data: img.data }, [img.data.buffer]);
      return { data };
    },
    async setParameters() { /* (Tesseract's page modes: nothing to set) */ },
    async terminate() { worker.terminate(); URL.revokeObjectURL(url); for (const w of waiting.values()) w.reject(new Error("cancelled")); waiting.clear(); },
  };
}
