// ---------------------------------------------------------------------------------------------
// Straightening scanned pages and photographed pictures. The tilt is measured on a small grey
// rendering: dark strokes (darker than their surroundings, so a dark table or background around a
// photographed page does not count) are projected onto the vertical axis at trial angles; at the
// right angle the text lines make sharp stripes. A PDF page is straightened without touching its
// image: its content is drawn turned about the middle of the page. Runs with the engine.
// ---------------------------------------------------------------------------------------------

const SKEW_MAX = 15;      // degrees searched either way
const SKEW_SIDE = 1600;   // pixels of the longer side measured

/**
 * The tilt of the text in a grey picture: degrees the lines are turned clockwise on screen, and
 * how clear the stripes were (0 = no text lines found; about 0.15 and more = reliable).
 */
function skewOfGray(px, w, h) {
  // Ink: clearly darker than the mean of its surroundings (an integral image gives the means).
  const r = Math.max(6, Math.round(Math.max(w, h) / 70));
  const W1 = w + 1, sum = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += px[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
  }
  const xs = [], ys = [];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      const g = px[y * w + x];
      if (g < mean * 0.82 && mean - g > 18) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 200) return { angle: 0, confidence: 0 };
  // At most about 80 000 points, spread evenly.
  const step = Math.max(1, Math.floor(xs.length / 80000));
  const n = Math.floor(xs.length / step), X = new Float32Array(n), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = xs[i * step] - w / 2; Y[i] = ys[i * step] - h / 2; }
  const span = Math.ceil(Math.hypot(w, h)) + 4, hist = new Float64Array(span);
  // Sharp stripes: the histogram of the turned heights changes a lot from row to row.
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[Math.round(Y[i] * c - X[i] * s + span / 2)]++;
    let e = 0;
    for (let i = 1; i < span; i++) { const d = hist[i] - hist[i - 1]; e += d * d; }
    return e;
  };
  const coarse = [];
  let best = 0, bestScore = -1;
  for (let d = -SKEW_MAX; d <= SKEW_MAX + 1e-9; d += 0.25) {
    const v = score(d);
    coarse.push(v);
    if (v > bestScore) { bestScore = v; best = d; }
  }
  for (const [range, inc] of [[0.25, 0.05], [0.05, 0.01]]) {
    const from = best;
    for (let d = from - range; d <= from + range + 1e-9; d += inc) {
      const v = score(d);
      if (v > bestScore) { bestScore = v; best = d; }
    }
  }
  coarse.sort((a, b) => a - b);
  const median = coarse[coarse.length >> 1] || 1;
  return { angle: Math.round(best * 100) / 100, confidence: Math.round((bestScore / median - 1) * 1000) / 1000 };
}

/** The tilt of page `pno` of `doc` (see skewOfGray). */
function detectSkew(doc, pno) {
  const page = doc.loadPage(pno);
  try {
    const b = page.getBounds();
    const zoom = Math.min(4, SKEW_SIDE / Math.max(1, b[2] - b[0], b[3] - b[1]));
    const pix = page.toPixmap(M.Matrix.scale(zoom, zoom), M.ColorSpace.DeviceGray, false);
    try {
      const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents();
      const raw = pix.getPixels();
      const px = n === 1 ? raw : (() => { const g = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) g[i] = raw[i * n]; return g; })();
      return skewOfGray(px, w, h);
    } finally {
      free(pix);
    }
  } finally {
    free(page);
  }
}

/**
 * Straighten a PDF page: its content is drawn turned by `tilt` degrees counter-clockwise (on
 * screen) about the middle of its crop box. The scan itself is not re-encoded.
 */
function deskewPdfPage(doc, pobj, tilt) {
  if (!tilt) return;
  const box = pobj.getInheritable("CropBox").isArray() ? pobj.getInheritable("CropBox") : pobj.getInheritable("MediaBox");
  const v = box.isArray() ? [0, 1, 2, 3].map((k) => box.get(k).asNumber()) : [0, 0, 612, 792];
  const cx = (v[0] + v[2]) / 2, cy = (v[1] + v[3]) / 2;
  // In PDF space (y up) a positive angle turns counter-clockwise, which on screen undoes a
  // clockwise tilt; a /Rotate of the page turns everything alike and does not change that.
  const a = (tilt * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const m = [c, s, -s, c, cx - (c * cx - s * cy), cy - (s * cx + c * cy)].map((x) => Math.round(x * 1e6) / 1e6);
  const contents = pobj.get("Contents");
  const arr = doc.newArray();
  arr.push(doc.addStream(`q ${m.join(" ")} cm\n`, {}));
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) arr.push(contents.get(i));
  else if (!contents.isNull()) arr.push(contents);
  arr.push(doc.addStream("\nQ\n", {}));
  pobj.put("Contents", arr);
}
