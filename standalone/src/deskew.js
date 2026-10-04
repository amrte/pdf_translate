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
 * then stretched to a rectangle; `tracks` (text lines traced on the straightened picture, as
 * fractions) are bent straight before that. Returns {data, width, height}.
 */
function warpPixels(src, sw, sh, n, { turn = 0, angle = 0, quad = null, tracks = null, bg = 255 } = {}) {
  const tr = ((turn % 360) + 360) % 360, dw = tr % 180 ? sh : sw, dh = tr % 180 ? sw : sh;
  // curved lines bent straight (tracks: fractions of the straightened picture, see dewarpMap)
  const bend = tracks && tracks.length ? dewarpMap(tracks.map((t) => t.map(([x, y]) => [x * dw, y * dh])), dw, dh) : null;
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
      if (bend) Y = bend(X, Y);
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
      res = warpPixels(pix.getPixels(), pix.getWidth(), pix.getHeight(), pix.getNumberOfComponents(), { turn: it.rot || 0, angle: -(Number(it.skew) || 0), quad: it.quad || null, tracks: it.tracks || null });
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

/* ---- curved text lines (a book page photographed open): found, then bent straight */

/** Dark strokes of a grey picture: 1 where a pixel is clearly darker than its surroundings. */
function inkMask(px, w, h) {
  const r = Math.max(6, Math.round(Math.max(w, h) / 70));
  const W1 = w + 1, sum = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += px[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      const g = px[y * w + x];
      if (g < mean * 0.82 && mean - g > 18) ink[y * w + x] = 1;
    }
  }
  return ink;
}

/**
 * The text lines of a grey picture as tracks: each a list of [x, y] points (pixels) along the
 * middle of one line, from left to right. The picture is cut into narrow vertical strips; in each
 * the rows with ink form peaks (the lines); peaks of neighbouring strips at about the same height
 * are joined. Only the main text block is kept (not a neighbouring page at the edge). `region`
 * ([x0, y0, x1, y1] in pixels) limits the search.
 */
function findTextLines(px, w, h, region = null) {
  const [rx0, ry0, rx1, ry1] = region ? region.map(Math.round) : [0, 0, w, h];
  const ink = inkMask(px, w, h);
  // The line pitch: the strongest repeat of the rows' ink in the middle of the region.
  const mid0 = Math.round(rx0 + (rx1 - rx0) * 0.3), mid1 = Math.round(rx0 + (rx1 - rx0) * 0.7);
  const prof = new Float64Array(h);
  for (let y = ry0; y < ry1; y++) { let n = 0; for (let x = mid0; x < mid1; x++) n += ink[y * w + x]; prof[y] = n; }
  // (neighbouring rows always look alike: the pitch is the first clear repeat after that
  // likeness has faded, not the overall maximum)
  const mean = prof.reduce((a, b) => a + b, 0) / Math.max(1, ry1 - ry0);
  const corr = (d) => {
    let c = 0;
    for (let y = ry0; y + d < ry1; y++) c += (prof[y] - mean) * (prof[y + d] - mean);
    return c / Math.max(1, ry1 - ry0 - d);
  };
  const dMax = Math.min(Math.floor((ry1 - ry0) / 3), 300), c0 = corr(0);
  let pitch = 0;
  if (c0 > 0) {
    let d1 = 1;
    while (d1 < dMax && corr(d1) > c0 * 0.25) d1++;
    let bestC = -Infinity;
    for (let d = d1; d <= Math.min(dMax, d1 * 6); d++) { const c = corr(d); if (c > bestC) { bestC = c; pitch = d; } }
    if (bestC < c0 * 0.1) pitch = 0; // no repeating lines
  }
  if (!pitch) return [];
  // Peaks per strip.
  const sw = Math.max(8, Math.round(pitch * 1.5)), strips = [];
  for (let x0 = rx0; x0 + sw <= rx1; x0 += Math.max(4, Math.round(sw / 2))) { // (overlapping, to follow a curl closely)
    const p = new Float64Array(h);
    for (let y = ry0; y < ry1; y++) { let n = 0; const o = y * w; for (let x = x0; x < x0 + sw; x++) n += ink[o + x]; p[y] = n; }
    // smoothed with a window of about a third of the pitch
    const k = Math.max(1, Math.round(pitch / 6)), sm = new Float64Array(h);
    let acc = 0;
    for (let y = ry0; y < ry1; y++) {
      acc += p[y]; if (y - 2 * k - 1 >= ry0) acc -= p[y - 2 * k - 1];
      if (y - k >= ry0) sm[y - k] = acc;
    }
    let top = 0; for (let y = ry0; y < ry1; y++) top = Math.max(top, sm[y]);
    const peaks = [];
    if (top > 0) {
      for (let y = ry0 + 1; y < ry1 - 1; y++) {
        if (sm[y] < top * 0.25 || sm[y] < sm[y - 1] || sm[y] < sm[y + 1]) continue;
        const last = peaks[peaks.length - 1];
        if (last && y - last.y < pitch * 0.55) { if (sm[y] > last.v) { last.y = y; last.v = sm[y]; } continue; }
        peaks.push({ y, v: sm[y] });
      }
    }
    strips.push({ x: x0 + sw / 2, peaks: peaks.map((q) => q.y) });
  }
  // Joining, from the strip with the most lines outwards (to the right, then to the left): each
  // track goes on to the peak nearest to where it was heading (its last few points give the
  // direction, so a line curling up near the spine is followed); a track may skip two strips (a
  // gap between words). Peaks no track reaches start tracks of their own.
  let seed = 0;
  strips.forEach((st, i) => { if (st.peaks.length > strips[seed].peaks.length || (st.peaks.length === strips[seed].peaks.length && Math.abs(i - strips.length / 2) < Math.abs(seed - strips.length / 2))) seed = i; });
  const follow = (dir, starts) => {
    const tracks = starts.map((y) => ({ pts: [[strips[seed].x, y]], last: seed, seeded: y }));
    for (let si = seed + dir; si >= 0 && si < strips.length; si += dir) {
      const strip = strips[si], free = new Set(strip.peaks.keys()), pairs = [];
      for (const t of tracks) {
        if (t.done || Math.abs(si - t.last) > 4) continue;
        const n = t.pts.length, [lx, ly] = t.pts[n - 1];
        const back = t.pts[Math.max(0, n - 4)];
        const slope = n > 1 ? (ly - back[1]) / ((lx - back[0]) || 1) : 0;
        const want = ly + slope * (strip.x - lx);
        strip.peaks.forEach((y, k) => {
          const d = Math.abs(y - want);
          // (a sudden turn is another line: the neighbouring page across the spine, a heading)
          const turn = Math.abs((y - ly) / ((strip.x - lx) || 1) - slope);
          if (d < pitch * 0.45 && turn < 0.3) pairs.push([d, t, k]);
        });
      }
      pairs.sort((a, b) => a[0] - b[0]);
      const used = new Set();
      for (const [, t, k] of pairs) {
        if (used.has(t) || !free.has(k)) continue;
        used.add(t); free.delete(k);
        t.pts.push([strip.x, strip.peaks[k]]); t.last = si;
      }
      for (const k of free) tracks.push({ pts: [[strip.x, strip.peaks[k]]], last: si, seeded: null });
    }
    return tracks;
  };
  const right = follow(1, strips[seed].peaks), left = follow(-1, strips[seed].peaks);
  const tracks = [];
  for (const r of right) {
    if (r.seeded === null) { tracks.push(r); continue; }
    const l = left.find((x) => x.seeded === r.seeded);
    tracks.push({ pts: l ? l.pts.slice(1).reverse().concat(r.pts) : r.pts });
  }
  for (const l of left) if (l.seeded === null) tracks.push({ pts: l.pts.slice().reverse() });
  // Long tracks only, and only those of the main text block (where most tracks overlap).
  const minLen = (rx1 - rx0) * 0.25;
  let long = tracks.filter((t) => t.pts.length >= 4 && t.pts[t.pts.length - 1][0] - t.pts[0][0] >= minLen);
  if (!long.length) return [];
  const cover = new Float64Array(strips.length);
  for (const t of long) for (const [x] of t.pts) cover[Math.min(strips.length - 1, Math.max(0, Math.round((x - rx0 - sw / 2) / sw)))]++;
  const cmax = Math.max(...cover);
  let a = cover.indexOf(cmax), b = a;
  while (a > 0 && cover[a - 1] >= cmax * 0.35) a--;
  while (b < cover.length - 1 && cover[b + 1] >= cmax * 0.35) b++;
  const bx0 = rx0 + a * sw, bx1 = rx0 + (b + 1) * sw;
  long = long.filter((t) => {
    const inside = t.pts.filter(([x]) => x >= bx0 && x <= bx1).length;
    return inside >= t.pts.length * 0.6;
  }).map((t) => t.pts.filter(([x]) => x >= bx0 - sw * 0.5 && x <= bx1 + sw * 0.5)).filter((pts) => pts.length >= 3);
  // Smoothed a little (a peak may sit on an ascender or descender).
  return long.map((pts) => pts.map(([x, y], i) => {
    const lo = Math.max(0, i - 1), hi = Math.min(pts.length - 1, i + 1);
    let s = 0; for (let j = lo; j <= hi; j++) s += pts[j][1];
    return [Math.round(x * 10) / 10, Math.round((s / (hi - lo + 1)) * 10) / 10];
  })).sort((p, q) => p[0][1] - q[0][1]);
}

/**
 * The bending that makes the given tracks (each [[x, y], …], pixels) straight: a function
 * (x, Y) → y that tells, for a point of the straightened picture, where to take it from. Each
 * track becomes level at its height in the middle of the text. The bend is one smooth surface
 * fitted to all tracks (a polynomial in x and height, least squares), so a slightly wrong track or
 * one that covers only part of a line does not dent the page; beyond the tracks it is held.
 */
function dewarpMap(tracks, w, h) {
  const good = tracks.filter((t) => t.length >= 2).map((t) => t.slice().sort((a, b) => a[0] - b[0]));
  if (!good.length) return null;
  const all = good.flat(), xs = all.map((p) => p[0]).sort((a, b) => a - b);
  const xRef = xs[xs.length >> 1], H = h || Math.max(...all.map((p) => p[1])) + 1;
  // Each track's height at xRef: from a straight line fitted to it (refined below).
  const lineAt = (t, x) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [px, py] of t) { sx += px; sy += py; sxx += px * px; sxy += px * py; }
    const n = t.length, den = n * sxx - sx * sx;
    const b = den ? (n * sxy - sx * sy) / den : 0, a = (sy - b * sx) / n;
    return a + b * x;
  };
  let targets = good.map((t) => lineAt(t, xRef));
  const nx = Math.min(4, Math.max(1, Math.floor(all.length / Math.max(1, good.length) / 2))); // degree in x
  const ny = Math.min(3, good.length - 1); // degree in height
  const X = (x) => (x - xRef) / w, Y = (y) => (y - H / 2) / H;
  const terms = [];
  for (let i = 1; i <= nx; i++) for (let j = 0; j <= ny; j++) terms.push([i, j]); // (no x⁰ terms: the height at xRef stays)
  const basis = (x, y) => { const a = X(x), b = Y(y); return terms.map(([i, j]) => a ** i * b ** j); };
  let coef = new Float64Array(terms.length);
  const solve = () => {
    const m = terms.length, A = Array.from({ length: m }, () => new Float64Array(m + 1));
    good.forEach((t, k) => {
      for (const [x, y] of t) {
        const f = basis(x, targets[k]), o = (y - targets[k]) / H;
        for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += f[r] * f[c]; A[r][m] += f[r] * o; }
      }
    });
    for (let r = 0; r < m; r++) A[r][r] += 1e-9;
    for (let c = 0; c < m; c++) { // Gaussian elimination with pivoting
      let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c] || 1e-12;
      for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / d; if (f) for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
    }
    coef = Float64Array.from(A.map((row, r) => row[m] / (row[r] || 1e-12)));
  };
  const offset = (x, y) => { const f = basis(x, y); let o = 0; for (let k = 0; k < f.length; k++) o += coef[k] * f[k]; return o * H; };
  // Fitted twice: the heights of the tracks follow the first fit.
  for (let round = 0; round < 2; round++) {
    solve();
    targets = good.map((t, k) => t.reduce((sum, [x, y]) => sum + y - offset(x, targets[k]), 0) / t.length);
  }
  solve();
  // What the surface misses (a sharp curl at the start of the lines near the spine) is added
  // from the tracks themselves: their remaining distance to it, smoothed along the line (median,
  // then mean), blended between neighbouring tracks and fading out beyond their ends.
  const step = 4, cols = Math.ceil(w / step) + 2, rows = Math.ceil(H / step) + 2;
  const order = targets.map((t, k) => k).sort((a, b) => targets[a] - targets[b]);
  const rest = order.map((k) => {
    const t = good[k], res = t.map(([x, y]) => y - targets[k] - offset(x, targets[k]));
    const med = res.map((v, i) => { const a = res.slice(Math.max(0, i - 1), i + 2).sort((p, q) => p - q); return a[a.length >> 1]; });
    const sm = med.map((v, i) => { const a = med.slice(Math.max(0, i - 1), i + 2); return a.reduce((p, q) => p + q, 0) / a.length; });
    const fade = Math.max(8, (t[t.length - 1][0] - t[0][0]) * 0.08);
    const tab = new Float32Array(cols);
    let j = 0;
    for (let c = 0; c < cols; c++) {
      const x = c * step;
      if (x <= t[0][0]) tab[c] = sm[0] * Math.max(0, 1 - (t[0][0] - x) / fade);
      else if (x >= t[t.length - 1][0]) tab[c] = sm[sm.length - 1] * Math.max(0, 1 - (x - t[t.length - 1][0]) / fade);
      else {
        while (j < t.length - 2 && t[j + 1][0] < x) j++;
        const f = (x - t[j][0]) / Math.max(1e-6, t[j + 1][0] - t[j][0]);
        tab[c] = sm[j] + f * (sm[j + 1] - sm[j]);
      }
    }
    return { t: targets[k], tab };
  });
  const gap = rest.length > 1 ? (rest[rest.length - 1].t - rest[0].t) / (rest.length - 1) : 40;
  const restAt = (c, y) => {
    if (y <= rest[0].t) return rest[0].tab[c] * Math.max(0, 1 - (rest[0].t - y) / gap);
    const last = rest[rest.length - 1];
    if (y >= last.t) return last.tab[c] * Math.max(0, 1 - (y - last.t) / gap);
    let lo = 0, hi = rest.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rest[m].t <= y) lo = m; else hi = m; }
    const f = (y - rest[lo].t) / Math.max(1e-6, rest[hi].t - rest[lo].t);
    return rest[lo].tab[c] * (1 - f) + rest[hi].tab[c] * f;
  };
  // Beyond the tracks the surface is held as it is at their edge.
  const x0 = xs[0], x1 = xs[xs.length - 1], t0 = Math.min(...targets), t1 = Math.max(...targets);
  const grid = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = Math.min(t1, Math.max(t0, r * step));
    for (let c = 0; c < cols; c++) grid[r * cols + c] = offset(Math.min(x1, Math.max(x0, c * step)), y) + restAt(c, r * step);
  }
  return (x, y) => {
    const fx = Math.max(0, Math.min(cols - 1.001, x / step)), fy = Math.max(0, Math.min(rows - 1.001, y / step));
    const c = Math.floor(fx), r = Math.floor(fy), ax = fx - c, ay = fy - r;
    const g00 = grid[r * cols + c], g01 = grid[r * cols + c + 1], g10 = grid[(r + 1) * cols + c], g11 = grid[(r + 1) * cols + c + 1];
    return y + (g00 * (1 - ax) + g01 * ax) * (1 - ay) + (g10 * (1 - ax) + g11 * ax) * ay;
  };
}
