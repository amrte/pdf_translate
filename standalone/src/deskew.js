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
  const fwd = (s, t) => { const w = g * s + h * t + 1; return [(a * s + b * t + c) / w, (d * s + e * t + f) / w]; };
  // the way back, (x, y) → (s, t): the inverse of the matrix [[a b c] [d e f] [g h 1]]
  const A = e - f * h, B = c * h - b, C = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  fwd.inverse = (x, y) => { const w = G * x + Hh * y + I || 1e-12; return [(A * x + B * y + C) / w, (D * x + E * y + F) / w]; };
  return fwd;
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
 * fractions) are bent straight in that rectangle. Returns {data, width, height}.
 */
function warpPixels(src, sw, sh, n, { turn = 0, angle = 0, quad = null, tracks = null, bg = 255 } = {}) {
  const tr = ((turn % 360) + 360) % 360, dw = tr % 180 ? sh : sw, dh = tr % 180 ? sw : sh;
  let W = dw, H = dh, map = null, back = (x, y) => [x, y];
  if (quad) {
    const q = quad.map(([x, y]) => [x * dw, y * dh]);
    [W, H] = quadSize(q);
    const m = quadMap(q);
    map = (u, v) => m((u + 0.5) / W, (v + 0.5) / H);
    back = (x, y) => { const [s2, t2] = m.inverse(x, y); return [s2 * W - 0.5, t2 * H - 0.5]; };
  }
  // Curved lines bent straight (tracks: fractions of the straightened picture, see dewarpMap).
  // The bend is worked out where the page is already flat (after the corners), so the lines end
  // up level there, not level in the photo and then tilted again by the corners.
  // The text block's leaning edges are then stood upright (see marginMap).
  const flat = tracks && tracks.length
    ? tracks.map((t) => t.map(([x, y]) => back(x * dw, y * dh))).map((t) => t.filter(([x, y]) => x > -W && x < 2 * W && y > -H && y < 2 * H))
    : null;
  const bend = flat ? dewarpMap(flat, W, H) : null;
  const upright = flat ? marginMap(flat, W, H) : null;
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = dw / 2, cy = dh / 2;
  const out = new Uint8ClampedArray(W * H * n);
  if (n === 4) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let X, Y, px = u + 0.5, py = v + 0.5;
      if (upright) px = upright(px, py);
      if (bend) py = bend(px, py);
      if (map) [X, Y] = map(px - 0.5, py - 0.5); else { X = px; Y = py; }
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
  const smooth = long.map((pts) => pts.map(([x, y], i) => {
    const lo = Math.max(0, i - 1), hi = Math.min(pts.length - 1, i + 1);
    let s = 0; for (let j = lo; j <= hi; j++) s += pts[j][1];
    return [Math.round(x * 10) / 10, Math.round((s / (hi - lo + 1)) * 10) / 10];
  }));
  // Each line taken out to its first and last letter: a track ends in the middle of a strip,
  // the ink along the line says where the text really starts and ends (the margins are measured
  // on these ends, see textMargins).
  const band = Math.max(2, Math.round(pitch * 0.22)), maxGap = Math.max(4, Math.round(pitch * 0.8));
  const inkAt = (x, y) => { let n = 0; for (let yy = Math.max(0, y - band); yy <= Math.min(h - 1, y + band); yy++) n += ink[yy * w + x]; return n >= 2; };
  const reach = (x, y, dir, limit) => {
    let last = null, gap = 0;
    for (let xx = x; dir < 0 ? xx >= limit : xx <= limit; xx += dir) {
      if (inkAt(xx, y)) { last = xx; gap = 0; } else if (last !== null && ++gap > maxGap) break; else if (last === null && Math.abs(xx - x) > sw) break;
    }
    return last;
  };
  for (const pts of smooth) {
    const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
    const y0 = Math.round(sy), y1 = Math.round(ey);
    const lim0 = Math.max(0, Math.round(bx0 - sw)), lim1 = Math.min(w - 1, Math.round(bx1 + sw));
    // (from the middle of the first strip out; when that is still margin, in to the first letter)
    let a = reach(Math.round(sx), y0, -1, lim0);
    if (a === null) a = reach(Math.round(sx), y0, 1, Math.min(lim1, Math.round(sx + sw)));
    let b = reach(Math.round(ex), y1, 1, lim1);
    if (b === null) b = reach(Math.round(ex), y1, -1, Math.max(lim0, Math.round(ex - sw)));
    if (a !== null && a < sx - 0.5) pts.unshift([a, sy]); else if (a !== null && a > sx + 0.5) pts[0] = [a, sy];
    if (b !== null && b > ex + 0.5) pts.push([b, ey]); else if (b !== null && b < ex - 0.5) pts[pts.length - 1] = [b, ey];
  }
  return smooth.sort((p, q) => p[0][1] - q[0][1]);
}

/**
 * The text block's left and right edges, from traced lines (pixels; their first and last points):
 * each a straight line x = a + b·y through the most lines that agree within a few pixels, so that
 * indented first lines, short last lines and stray traces are left out. Null for an edge without
 * a clear majority (ragged text). Also the heights the lines span.
 */
function textMargins(tracks, w) {
  const rows = tracks.filter((t) => t.length >= 2).map((t) => {
    const ys = t.map((p) => p[1]).sort((a, b) => a - b);
    return { y: ys[ys.length >> 1], x0: Math.min(...t.map((p) => p[0])), x1: Math.max(...t.map((p) => p[0])) };
  });
  const tol = Math.max(3, w * 0.006);
  const fit = (pts) => {
    const n = pts.length;
    if (n < 6) return null;
    let best = null;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const [ya, xa] = pts[i], [yb, xb] = pts[j];
      if (Math.abs(yb - ya) < 1) continue;
      const b = (xb - xa) / (yb - ya), a = xa - b * ya;
      if (Math.abs(b) > 0.25) continue;
      let cnt = 0, err = 0;
      for (const [y, x] of pts) { const d = Math.abs(x - (a + b * y)); if (d <= tol) { cnt++; err += d; } }
      if (!best || cnt > best.cnt || (cnt === best.cnt && err < best.err)) best = { cnt, err, a, b };
    }
    // (at least half of the lines, spread over at least half of the text's height)
    if (!best || best.cnt < Math.max(6, n * 0.5)) return null;
    const inl = pts.filter(([y, x]) => Math.abs(x - (best.a + best.b * y)) <= tol);
    const span = Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]));
    if (Math.max(...inl.map((q) => q[0])) - Math.min(...inl.map((q) => q[0])) < span * 0.5) return null;
    // least squares on the lines that agree
    const my = inl.reduce((p, q) => p + q[0], 0) / inl.length, mx = inl.reduce((p, q) => p + q[1], 0) / inl.length;
    let sxy = 0, syy = 0;
    for (const [y, x] of inl) { sxy += (y - my) * (x - mx); syy += (y - my) ** 2; }
    const b = syy ? sxy / syy : 0;
    return { a: mx - b * my, b, n: inl.length };
  };
  const ys = rows.map((r) => r.y);
  return { rows: rows.length, left: fit(rows.map((r) => [r.y, r.x0])), right: fit(rows.map((r) => [r.y, r.x1])), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * Where a point of the finished picture comes from across, so that the text block's edges stand
 * upright (a page whose lines are level but whose margins lean, as a parallelogram): (x, y) →
 * x. Each row is stretched between the leaning edges (one edge alone: shifted along it). Null
 * when the edges are not clear or already upright.
 */
function marginMap(tracks, w, h) {
  const m = textMargins(tracks, w);
  const ym = (m.y0 + m.y1) / 2, at = (f, y) => f.a + f.b * y;
  const { left: L, right: R } = m;
  let map = null;
  if (L && R && at(R, ym) - at(L, ym) > w * 0.2) {
    const l0 = at(L, ym), r0 = at(R, ym);
    map = (x, y) => { const l = at(L, y), r = at(R, y); return l + ((x - l0) * (r - l)) / (r0 - l0); };
  } else if ((L || R) && (L || R).n >= m.rows * 0.6) { // (one edge alone: a clearer majority)
    const f = L || R, f0 = at(f, ym);
    map = (x, y) => x + at(f, y) - f0;
  }
  if (!map) return null;
  // (hardly leaning: left as it is)
  const most = Math.max(...[0, h].flatMap((y) => [0, w].map((x) => Math.abs(map(x, y) - x))));
  return most < 1.5 ? null : map;
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

/* ---- the paper in a photo: found for cropping */

/**
 * The sheet of paper in a photographed page: its four corners (fractions: top left, top right,
 * bottom right, bottom left), or null when the picture shows nothing but the page (a scan). The
 * paper is the largest bright area (brighter than Otsu's threshold). A book photographed open shows
 * two pages: they are parted at the spine, a darker valley between them, and the page with more
 * text lines (`lines`: tracks in pixels, see findTextLines) is kept.
 */
function findPaper(px, w, h, lines = null) {
  // a small copy (about 400 pixels across) is enough for the outline
  const k = Math.max(1, Math.round(Math.max(w, h) / 400)), sw = Math.floor(w / k), sh = Math.floor(h / k);
  const g = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += px[(y * k + j) * w + x * k + i];
    g[y * sw + x] = s / (k * k);
  }
  const hist = new Float64Array(256);
  for (const v of g) hist[v]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = i; }
  }
  // Text is dark too: the bright mask is closed over small dark spots (letters) first.
  const bright = new Uint8Array(sw * sh);
  for (let i = 0; i < g.length; i++) bright[i] = g[i] > thr ? 1 : 0;
  const r = Math.max(1, Math.round(Math.min(sw, sh) / 80));
  const dil = new Uint8Array(sw * sh), clo = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let on = 0;
    for (let j = -r; j <= r && !on; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < sw && yy < sh && bright[yy * sw + xx]) { on = 1; break; } }
    dil[y * sw + x] = on;
  }
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let all = 1;
    for (let j = -r; j <= r && all; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < sw && yy < sh && !dil[yy * sw + xx]) { all = 0; break; } }
    clo[y * sw + x] = all;
  }
  // the largest bright area
  const lab = new Int32Array(sw * sh).fill(-1), stack = [];
  let bestLab = -1, bestN = 0, n = 0;
  for (let i = 0; i < clo.length; i++) {
    if (!clo[i] || lab[i] >= 0) continue;
    let cnt = 0; stack.push(i); lab[i] = n;
    while (stack.length) {
      const p = stack.pop(); cnt++;
      const x = p % sw, y = (p - x) / sw;
      for (const q of [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1]) if (q >= 0 && clo[q] && lab[q] < 0) { lab[q] = n; stack.push(q); }
    }
    if (cnt > bestN) { bestN = cnt; bestLab = n; }
    n++;
  }
  if (bestLab < 0 || bestN < 0.2 * sw * sh) return null;
  let bx0 = sw, by0 = sh, bx1 = 0, by1 = 0;
  for (let i = 0; i < lab.length; i++) if (lab[i] === bestLab) { const x = i % sw, y = (i - x) / sw; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  // Only the page: nothing to cut away (a scan, a page already cropped).
  if (bx1 - bx0 >= 0.97 * sw && by1 - by0 >= 0.97 * sh && bestN >= 0.85 * sw * sh) return null;
  // A book photographed open: two pages, the spine a darker valley between them (a shadow). It
  // is looked for in eight bands from top to bottom; where it is clear in most, a line is fitted
  // through it, and the page with more text lines is kept.
  let keep = () => true;
  {
    const valleys = [], bands = 8, bh = (by1 - by0) / bands;
    for (let b = 0; b < bands; b++) {
      const y0 = Math.round(by0 + b * bh), y1 = Math.round(by0 + (b + 1) * bh);
      const prof = [];
      // (the paper's own brightness: a high percentile of the column, so text does not darken it)
      for (let x = bx0; x <= bx1; x++) {
        const vals = [];
        for (let y = y0; y < y1; y++) if (lab[y * sw + x] === bestLab) vals.push(g[y * sw + x]);
        if (vals.length > (y1 - y0) * 0.5) { vals.sort((p, q) => p - q); prof.push(vals[Math.floor(vals.length * 0.85)]); } else prof.push(NaN);
      }
      const sm = prof.map((v, i) => { const a = prof.slice(Math.max(0, i - 3), i + 4).filter((q) => !Number.isNaN(q)); return a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN; });
      const n2 = sm.length, edge = Math.round(n2 * 0.1), win = Math.round(n2 * 0.15);
      let best2 = null;
      for (let i = edge; i < n2 - edge; i++) {
        const v = sm[i];
        if (Number.isNaN(v)) continue;
        const left = Math.max(...sm.slice(Math.max(0, i - win), i).filter((q) => !Number.isNaN(q)), -1);
        const right = Math.max(...sm.slice(i + 1, i + 1 + win).filter((q) => !Number.isNaN(q)), -1);
        const depth = Math.min(left, right) / Math.max(1, v) - 1;
        if (depth > 0.07 && (!best2 || depth > best2.depth)) best2 = { x: bx0 + i, depth };
      }
      if (best2) valleys.push([best2.x, (y0 + y1) / 2]);
    }
    if (valleys.length >= bands / 2) {
      const n3 = valleys.length, my = valleys.reduce((p, q) => p + q[1], 0) / n3, mx = valleys.reduce((p, q) => p + q[0], 0) / n3;
      let sxy = 0, syy = 0;
      for (const [x, y] of valleys) { sxy += (y - my) * (x - mx); syy += (y - my) ** 2; }
      const bb = syy ? sxy / syy : 0, aa = mx - bb * my, spine = (y) => aa + bb * y;
      const off = Math.sqrt(valleys.reduce((p, [x, y]) => p + (x - spine(y)) ** 2, 0) / n3);
      if (off < sw * 0.04) {
        let leftInk = 0, rightInk = 0;
        for (const t of lines || []) for (const [x, y] of t) { if (x / k < spine(y / k)) leftInk++; else rightInk++; }
        if (!lines || !lines.length) {
          for (let i = 0; i < lab.length; i++) if (lab[i] === bestLab) { const x = i % sw, y = (i - x) / sw; if (x < spine(y)) leftInk++; else rightInk++; }
        }
        // The shadow beside the spine may lie over the first letters: the cut moves out until it
        // clears the lines that start (or end) near it, with a small margin.
        const right2 = rightInk >= leftInk, margin = sw * 0.02;
        // (the lines' usual start: a low quantile, as indented lines start further in and a line
        // traced on into the neighbouring page further out)
        const ds = [];
        for (const t of lines || []) {
          const [x, y] = right2 ? t[0] : t[t.length - 1], sx = x / k, sp = spine(y / k);
          const d = right2 ? sx - sp : sp - sx; // how far inside the kept page the line starts
          if (d > -sw * 0.06 && d < sw * 0.1) ds.push(d);
        }
        ds.sort((p, q) => p - q);
        const shift = ds.length ? Math.max(0, margin - ds[Math.floor(ds.length * 0.3)]) : 0;
        const cutAt = (y) => spine(y) + (right2 ? -shift : shift);
        keep = right2 ? (x, y) => x >= cutAt(y) : (x, y) => x <= cutAt(y);
      }
    }
  }
  // corners: the area's points furthest out in the four diagonal directions
  let tl = null, tr = null, br = null, bl = null;
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] !== bestLab) continue;
    const x = i % sw, y = (i - x) / sw;
    if (!keep(x, y)) continue;
    if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
    if (!br || x + y > br[0] + br[1]) br = [x, y];
    if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
    if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
  }
  if (!tl) return null;
  const quad = [tl, tr, br, bl].map(([x, y]) => [Math.min(1, Math.max(0, Math.round(((x + 0.5) / sw) * 1e4) / 1e4)), Math.min(1, Math.max(0, Math.round(((y + 0.5) / sh) * 1e4) / 1e4))]);
  // Nothing around the page (a scan, a cropped photo): no crop.
  const inner = quad.every(([x, y]) => x < 0.03 || x > 0.97 || y < 0.03 || y > 0.97);
  const area = Math.abs(quad.reduce((a, p, i) => { const q = quad[(i + 1) % 4]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  if (inner || area > 0.93) return null;
  return quad;
}

/** Whether traced lines are clearly curved (worth bending straight), not just straight lines. */
function linesAreCurved(tracks, h) {
  if (!tracks || tracks.length < 3) return false;
  let curved = 0;
  for (const t of tracks) {
    if (t.length < 4) continue;
    const n = t.length, mx = t.reduce((p, q) => p + q[0], 0) / n, my = t.reduce((p, q) => p + q[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of t) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    const dev = Math.max(...t.map(([x, y]) => Math.abs(y - (my + b * (x - mx)))));
    if (dev > h * 0.004) curved++;
  }
  return curved >= Math.max(2, tracks.length * 0.2);
}

/**
 * Everything automatic for one page as a grey picture (already turned straight): the paper's
 * corners (when there is background around it; `crop`) and the curved text lines to bend
 * straight (`dewarp`; only when they are clearly curved). Fractions, as used by warpPixels.
 */
function autoPrepare(gray, w, h, { crop = true, dewarp = true } = {}) {
  const lines = findTextLines(gray, w, h);
  const quad = crop ? findPaper(gray, w, h, lines) : null;
  let tracks = null;
  if (dewarp) {
    let region = null;
    if (quad) {
      const xs = quad.map((p) => p[0] * w), ys = quad.map((p) => p[1] * h);
      region = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(w, Math.max(...xs)), Math.min(h, Math.max(...ys))];
    }
    const found = region ? findTextLines(gray, w, h, region) : lines;
    // (lines that are straight are kept too when the text block leans once the page is pulled
    // straight from its corners: its edges are then stood upright, see marginMap)
    let keep = linesAreCurved(found, h);
    if (!keep && quad && found.length >= 5) {
      const q = quad.map(([x, y]) => [x * w, y * h]), [W, H] = quadSize(q), m = quadMap(q);
      const flat = found.map((t) => t.map(([x, y]) => { const [s2, t2] = m.inverse(x, y); return [s2 * W, t2 * H]; }));
      keep = Boolean(marginMap(flat, W, H));
    }
    if (keep) tracks = found.map((t) => t.map(([x, y]) => [Math.round((x / w) * 1e4) / 1e4, Math.round((y / h) * 1e4) / 1e4]));
  }
  return { quad, tracks };
}
