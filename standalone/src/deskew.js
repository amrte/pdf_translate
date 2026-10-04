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

/**
 * The square (0,0)–(1,1) mapped onto the quadrilateral q = [top left, top right, bottom right,
 * bottom left] (each [x, y]): a function (s, t) → [x, y]. A perspective (projective) mapping.
 */
function quadMap(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (s, t) => { const w = g * s + h * t + 1; return [(a * s + b * t + c) / w, (d * s + e * t + f) / w]; };
}

/** Width and height of the rectangle a page outlined by `q` (pixels) becomes: its longer edges. */
function quadSize(q) {
  const len = (p, r) => Math.hypot(r[0] - p[0], r[1] - p[1]);
  return [Math.max(1, Math.round(Math.max(len(q[0], q[1]), len(q[3], q[2])))), Math.max(1, Math.round(Math.max(len(q[0], q[3]), len(q[1], q[2]))))];
}

/**
 * A picture turned, straightened and flattened in one pass. `src` has `n` bytes per pixel (3 or
 * 4) and is `sw`×`sh`. As shown it is first turned by `turn` (0/90/180/270, clockwise), then by
 * `angle` degrees clockwise about its middle (same size, corners filled with `bg`); `quad`
 * (fractions of that straightened picture: top left, top right, bottom right, bottom left) is
 * then stretched to a rectangle. Returns {data, width, height}.
 */
function warpPixels(src, sw, sh, n, { turn = 0, angle = 0, quad = null, bg = 255 } = {}) {
  const tr = ((turn % 360) + 360) % 360, dw = tr % 180 ? sh : sw, dh = tr % 180 ? sw : sh;
  let W = dw, H = dh, map = null;
  if (quad) {
    const q = quad.map(([x, y]) => [x * dw, y * dh]);
    [W, H] = quadSize(q);
    const m = quadMap(q);
    map = (u, v) => m((u + 0.5) / W, (v + 0.5) / H);
  }
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = dw / 2, cy = dh / 2;
  const out = new Uint8ClampedArray(W * H * n);
  if (n === 4) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let X, Y;
      if (map) [X, Y] = map(u, v); else { X = u + 0.5; Y = v + 0.5; }
      // undo the straightening turn, then the quarter turns
      const dx = X - cx, dy = Y - cy;
      const Xs = cx + c * dx + s * dy, Ys = cy - s * dx + c * dy;
      let xs, ys;
      if (tr === 0) { xs = Xs; ys = Ys; } else if (tr === 90) { xs = Ys; ys = sh - Xs; } else if (tr === 180) { xs = sw - Xs; ys = sh - Ys; } else { xs = sw - Ys; ys = Xs; }
      xs -= 0.5; ys -= 0.5;
      const o = (v * W + u) * n;
      const x0 = Math.floor(xs), y0 = Math.floor(ys);
      if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) { for (let k = 0; k < Math.min(3, n); k++) out[o + k] = bg; continue; }
      const fx = xs - x0, fy = ys - y0;
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), xa = Math.max(0, x0), ya = Math.max(0, y0);
      const p00 = (ya * sw + xa) * n, p10 = (ya * sw + x1) * n, p01 = (y1 * sw + xa) * n, p11 = (y1 * sw + x1) * n;
      for (let k = 0; k < Math.min(3, n); k++) {
        out[o + k] = (src[p00 + k] * (1 - fx) + src[p10 + k] * fx) * (1 - fy) + (src[p01 + k] * (1 - fx) + src[p11 + k] * fx) * fy;
      }
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * A page drawn anew as a picture: turned, straightened and flattened (see warpPixels) at about
 * the resolution of a scan. Its text layer is gone; the picture can be recognised (OCR) again.
 * Adds the page to the end of `out`.
 */
function warpedPdfPage(out, doc, pno, it) {
  const page = doc.loadPage(pno);
  try {
    const b = page.getBounds();
    const zoom = Math.min(4, 3000 / Math.max(1, b[2] - b[0], b[3] - b[1]));
    const pix = page.toPixmap(M.Matrix.scale(zoom, zoom), M.ColorSpace.DeviceRGB, false);
    let res;
    try {
      res = warpPixels(pix.getPixels(), pix.getWidth(), pix.getHeight(), pix.getNumberOfComponents(), { turn: it.rot || 0, angle: -(Number(it.skew) || 0), quad: it.quad || null });
    } finally {
      free(pix);
    }
    const img = new M.Pixmap(M.ColorSpace.DeviceRGB, [0, 0, res.width, res.height], false);
    img.getPixels().set(res.data);
    const jpeg = img.asJPEG(88);
    free(img);
    const image = new M.Image(jpeg);
    const ref = out.addImage(image);
    free(image);
    const pw = res.width / zoom, ph = res.height / zoom;
    const resources = out.newDictionary(), xo = out.newDictionary();
    xo.put("Im0", ref);
    resources.put("XObject", xo);
    const fmt2 = (x) => Math.round(x * 1000) / 1000;
    const p = out.addPage([0, 0, fmt2(pw), fmt2(ph)], 0, resources, `q ${fmt2(pw)} 0 0 ${fmt2(ph)} 0 0 cm /Im0 Do Q`);
    out.insertPage(-1, p);
    free(p);
  } finally {
    free(page);
  }
}
