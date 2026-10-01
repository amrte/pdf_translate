// ======================================================================
// PDF engine: extraction, exchange formats and rebuild (runs on MuPDF WASM)
// ======================================================================
const MUPDF_URL = "https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js";
let M = null;

const BULLET_RE = /^\s*(?:[•◦▪▫●○■□►▶➢➤✓✔·‣⁃]|\(?\d{1,3}[.)]\s|\(?[a-zA-Z][.)]\s)/;
// ("Roman" and "Book" are weights, not families: Univers-Roman and Gotham-Book are sans-serif.)
const SERIF_HINTS = ["times", "serif", "georgia", "garamond", "cambria", "minion", "charis",
  "palatino", "bookman", "baskerville", "caslon", "charter", "didot", "bodoni", "libertin",
  "merriweather", "lora", "constantia", "century", "tinos", "nimbusrom", "utopia", "termes", "pagella",
  "bonum", "schola", "sabon", "bembo", "plantin", "perpetua", "goudy", "hoefler", "crimson", "spectral",
  "antiqua", "kepler", "joanna", "rockwell", "clarendon", "cheltenham", "warnock", "chaparral", "stix"];
const MONO_HINTS = ["courier", "mono", "consol", "menlo", "inconsolata", "code", "typewriter"];
const SANS_HINTS = ["sans", "arial", "helvet", "verdana", "tahoma", "calibri", "segoe", "heros", "sanl", "nimbussan",
  "myriad", "frutiger", "univers", "futura", "gill", "roboto", "lato", "montserrat", "raleway", "ubuntu", "fira",
  "trebuchet", "avenir", "optima", "franklin", "gothic", "grotesk", "grotesque", "akzidenz", "corbel", "candara",
  "eurostile", "dinpro", "dinot", "din-", "cmss", "lmss", "gotham", "proxima", "nunito", "barlow", "oswald"];
/** TeX fonts are named by short codes (cmr10, cmbx12, cmti10: Computer Modern, a serif). */
const TEX_SERIF_RE = /^(?:cm(?:r|bx|ti|sl|csc|mi|b|dunh|fib|u)\d|lmr|lmroman|ec(?:rm|bx|ti|sl)\d|t1-?lmr)/;
const BASE_FONTS = {
  "sans-serif": ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  "serif": ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  "monospace": ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const round2 = (v) => Math.round(v * 100) / 100;
const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice());
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const boxOf = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const quadBox = (q) => boxOf([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]);
const free = (o) => { try { o && o.destroy && o.destroy(); } catch (_) { /* already freed */ } };

async function initEngine(module) {
  if (!M) M = module || await import(MUPDF_URL);
  return M;
}

function rotationOf(dir) {
  const [dx, dy] = dir;
  if (Math.abs(dx) > 0.99) return dx > 0 ? 0 : 180;
  if (Math.abs(dy) > 0.99) return dy < 0 ? 90 : 270;
  return null; // skewed text is left untouched
}

const DIRS = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] };

/** A box in the text's own frame: a = along the reading direction, b = across (line progression). */
function localBox(r, rotation) {
  const d = DIRS[rotation], n = [-d[1], d[0]];
  const pts = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]];
  const a = pts.map(([x, y]) => x * d[0] + y * d[1]), b = pts.map(([x, y]) => x * n[0] + y * n[1]);
  return [Math.min(...a), Math.min(...b), Math.max(...a), Math.max(...b)];
}

function colorHex(c) {
  let r = 0, g = 0, b = 0;
  if (c && c.length === 1) r = g = b = c[0];
  else if (c && c.length === 3) [r, g, b] = c;
  else if (c && c.length === 4) {
    const [C, Mg, Y, K] = c;
    r = (1 - C) * (1 - K); g = (1 - Mg) * (1 - K); b = (1 - Y) * (1 - K);
  }
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** The font family its name tells, or null. */
function familyHint(low) {
  if (MONO_HINTS.some((h) => low.includes(h))) return "monospace";
  if (SANS_HINTS.some((h) => low.includes(h))) return "sans-serif";
  if (SERIF_HINTS.some((h) => low.includes(h)) || TEX_SERIF_RE.test(low)) return "serif";
  return null;
}

function familyOf(low, serif, mono) {
  return familyHint(low) || (mono ? "monospace" : serif ? "serif" : "sans-serif");
}

// Letters whose widths tell a typical sans-serif (Helvetica/Arial: about 0.55 em) from a serif
// (Times: about 0.45 em), for fonts whose name says nothing; the font flags are often wrong.
const WIDTH_SAMPLE = new Set([..."aenosаеносрн"]);

/** A font's family: from its name, else from its measured letter widths, else from its flags. */
function familyFor(info) {
  if (info.hinted || info.wn < 12) return info.family;
  const avg = info.ws / info.wn;
  if (info.family !== "monospace" && avg < 0.49) return "serif";
  if (info.family !== "monospace" && avg > 0.515) return "sans-serif";
  return info.family;
}

const fontInfoCache = new Map();
const fontPtrCache = new Map();
function fontInfo(font) {
  const cached = fontPtrCache.get(font.pointer);
  if (cached) return cached;
  const raw = font.getName();
  let info = fontInfoCache.get(raw);
  if (!info) {
    const name = raw.replace(/^[A-Z]{6}\+/, "");
    const low = name.toLowerCase();
    // Style words in the font name are more reliable than the font's own flags, which some
    // PDF producers set wrongly; the flags are only used when the name says nothing.
    const style = low.includes("-") || low.includes(",") ? low.slice(Math.max(low.lastIndexOf("-"), low.lastIndexOf(",")) + 1) : low;
    const nameItalic = /italic|oblique|kursiv|^it$|^bdit$|^boldit|^bi$|^lightit|^mediumit/.test(style) || /italic|oblique/.test(low);
    const nameBold = /bold|black|heavy|semibold|demi|^bd|^bdit$|^bi$/.test(style) || /bold|black|heavy/.test(low);
    const namePlain = /regular|roman|book|normal|medium|light|^mt$|^psmt$|^ps$/.test(style);
    const named = nameItalic || nameBold || namePlain;
    info = {
      name,
      bold: nameBold || (!named && font.isBold()),
      italic: nameItalic || (!named && font.isItalic()),
      family: familyOf(low, font.isSerif(), font.isMono()),
      hinted: Boolean(familyHint(low)),
      ws: 0, wn: 0, // letter widths (em), see familyFor
    };
    fontInfoCache.set(raw, info);
  }
  fontPtrCache.set(font.pointer, info);
  return info;
}

// ---------------------------------------------------------------- graphics

/** Table borders / rules (thin boxes) and the boxes of shapes and images on a page. */
function pageGraphics(page) {
  const seps = [], containers = [];
  const addRect = (r) => {
    const w = r[2] - r[0], h = r[3] - r[1];
    if (w < 3 || h < 3) { seps.push(r); return; }
    seps.push([r[0], r[1], r[0], r[3]], [r[2], r[1], r[2], r[3]], [r[0], r[1], r[2], r[1]], [r[0], r[3], r[2], r[3]]);
    containers.push(r);
  };
  const onPath = (path, ctm) => {
    const subs = [];
    let cur = null;
    path.walk({
      moveTo(x, y) { cur = { pts: [applyM(ctm, x, y)], curved: false }; subs.push(cur); },
      lineTo(x, y) { if (cur) cur.pts.push(applyM(ctm, x, y)); },
      curveTo(x1, y1, x2, y2, x3, y3) { if (cur) { cur.pts.push(applyM(ctm, x3, y3)); cur.curved = true; } },
    });
    for (const s of subs) {
      const bb = boxOf(s.pts);
      const big = bb[2] - bb[0] > 3 && bb[3] - bb[1] > 3;
      if (s.curved) { if (big) containers.push(bb); continue; }
      const axial = s.pts.every((p, i) => i === 0 || Math.abs(p[0] - s.pts[i - 1][0]) < 0.5 || Math.abs(p[1] - s.pts[i - 1][1]) < 0.5);
      if (!axial) { if (big) containers.push(bb); continue; }
      if (s.pts.length <= 2) { if (s.pts.length === 2) seps.push(bb); continue; }
      if (s.pts.length <= 5) { addRect(bb); continue; }
      for (let i = 1; i < s.pts.length; i++) seps.push(boxOf([s.pts[i - 1], s.pts[i]]));
    }
  };
  const dev = new M.Device({
    fillPath(path, evenOdd, ctm) { onPath(path, ctm); },
    strokePath(path, stroke, ctm) { onPath(path, ctm); },
    fillImage(image, ctm) { containers.push(boxOf([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyM(ctm, x, y)))); },
  });
  try { page.run(dev, M.Matrix.identity); } catch (e) { console.warn("Could not analyse page graphics", e); }
  try { dev.close(); } catch (_) { /* not needed */ }
  free(dev);
  return { seps, containers };
}

function divided(a, b, seps, horizontal = true) {
  if (!seps.length || !horizontal) return false;
  if (a[2] <= b[0] + 1 || b[2] <= a[0] + 1) { // side by side: vertical line in between?
    let [lo, hi] = a[2] <= b[0] + 1 ? [a[2], b[0]] : [b[2], a[0]];
    if (lo > hi) [lo, hi] = [hi, lo];
    const mid = (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2;
    return seps.some(([x0, y0, x1, y1]) => x1 - x0 < 3 && lo - 0.5 <= (x0 + x1) / 2 && (x0 + x1) / 2 <= hi + 0.5 && y0 <= mid && mid <= y1);
  }
  const [up, low] = a[1] <= b[1] ? [a, b] : [b, a];
  const lo = up[3] - 0.2 * (up[3] - up[1]), hi = low[1] + 0.2 * (low[3] - low[1]);
  const left = Math.max(a[0], b[0]), right = Math.min(a[2], b[2]);
  if (right <= left) return false;
  return seps.some(([x0, y0, x1, y1]) => y1 - y0 < 3 && lo <= (y0 + y1) / 2 && (y0 + y1) / 2 <= hi && x0 < right - 1 && x1 > left + 1);
}

// --------------------------------------------------------------- extraction

const colorCache = new Map();

function pageBlocks(page, bounds, seps) {
  // Font pointers are only unique while this structured-text page keeps its fonts alive;
  // MuPDF reuses the addresses later, so the pointer cache must not outlive the page.
  fontPtrCache.clear();
  const st = page.toStructuredText("preserve-whitespace");
  const blocks = [];
  let block = null, line = null, span = null, lastInk = null, sawSpace = false;
  st.walk({
    beginTextBlock() { block = { lines: [] }; blocks.push(block); },
    endTextBlock() { block = null; },
    beginLine(bbox, wmode, dir) {
      if (!block) { block = { lines: [] }; blocks.push(block); }
      line = { dir: [dir[0], dir[1]], spans: [], gaps: [] };
      block.lines.push(line);
      span = null; lastInk = null; sawSpace = false;
    },
    onChar(c, origin, font, size, quad, color) {
      if (!line) { free(font); return; }
      const qb = [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]),
        Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
      if (qb[2] < bounds[0] || qb[0] > bounds[2] || qb[3] < bounds[1] || qb[1] > bounds[3]) return; // off-page
      const blank = c === " " || !c.trim();
      const info = fontInfo(font);
      free(font); // release the per-character wrapper right away instead of waiting for GC
      const ck = color.length === 3 ? ((color[0] * 255) << 16) + ((color[1] * 255) << 8) + (color[2] * 255 | 0) : color.join(",");
      let col = colorCache.get(ck);
      if (!col) { col = colorHex(color); colorCache.set(ck, col); }
      const key = `${info.name}|${Math.round(size * 100)}|${col}`;
      // Start a new span on a style change, and where a table border or a wide gap separates
      // this glyph from the previous one (MuPDF fills such gaps with synthetic spaces).
      let split = !span || span.key !== key, gapBefore = 0;
      if (!blank && lastInk) {
        const horizontal = Math.abs(line.dir[0]) > 0.99;
        const gap = horizontal ? Math.abs(qb[0] - lastInk[2]) : Math.abs(qb[1] - lastInk[3]);
        if (sawSpace || gap > 0.15 * size) {
          line.gaps.push(gap / size); // word gaps in em, to tell column gaps from word spaces
          // (moderate gaps only after a real space: complex scripts have gaps inside words)
          if (gap > 0.8 * size || (sawSpace && gap > 0.4 * size)) { split = true; gapBefore = gap; }
          else if (!split) split = divided(lastInk, qb, seps, horizontal);
        }
      }
      if (!info.hinted && WIDTH_SAMPLE.has(c) && info.wn < 400) {
        info.ws += (Math.abs(line.dir[0]) > 0.99 ? qb[2] - qb[0] : qb[3] - qb[1]) / size;
        info.wn++;
      }
      if (split) {
        span = { key, text: "", bbox: null, origin: [origin[0], origin[1]], size, font: info, color: col, gapBefore };
        line.spans.push(span);
      }
      span.text += c;
      if (blank) { sawSpace = true; return; }
      span.bbox = union(span.bbox, qb);
      if (span.text.trim().length === 1) span.origin = [origin[0], origin[1]];
      lastInk = qb; sawSpace = false;
    },
  });
  free(st);
  for (const b of blocks) for (const l of b.lines) l.spans = l.spans.filter((sp) => sp.bbox);
  return blocks;
}

/**
 * Is `next` the continuation of the paragraph that `prev` belongs to? Lines in different
 * columns never are, and neither is a line whose first word would still have fitted at the
 * end of `prev`: then the break was intentional (label/value columns, lists, addresses).
 */
function continuesParagraph(prev, next, pageLines, seps, marginsByRot, blockLines, nested = false) {
  const rot = prev.rotation;
  const a = localBox(prev.bbox, rot), b = localBox(next.bbox, rot);
  const size = Math.max(prev.size, next.size);
  if (b[0] >= a[2] - 0.5 * size || a[0] >= b[2] - 0.5 * size) return false; // no horizontal overlap
  const pt = prev.text.trim(), nt = next.text.trim();
  if (/[-\u00ad\u2010\u2011]$/.test(pt)) return true; // hyphenated word
  if (/^[-/]\S/.test(nt) && /[\p{L}\p{N}]$/u.test(pt)) return true; // "…versicherung" + "-bund.de"
  if (/:\s*$/.test(prev.text)) return false; // a form label ("Prüfer:") is complete
  if (LABEL_START_RE.test(nt)) return false; // next starts with its own label ("Postanschrift: …")
  if (URLISH_RE.test(nt) || URLISH_RE.test(pt)) return false; // web / e-mail addresses stand alone
  if (!/\p{L}/u.test(pt) && !/\p{L}/u.test(nt)) return false; // rows of numbers, dates, amounts
  // Table/form rows: when both lines have text right before them on their own baseline,
  // they belong together only if those left neighbours do too (the left column of a
  // two-column page continues; a column of row labels does not).
  const leftOf = (l) => {
    const lb = localBox(l.bbox, rot);
    const m0 = lb[1] + 0.25 * (lb[3] - lb[1]), m1 = lb[3] - 0.25 * (lb[3] - lb[1]);
    let best = null, bestX = -Infinity;
    for (const o of pageLines) {
      if (o === l || o.rotation !== rot) continue;
      const ob = localBox(o.bbox, rot);
      if (ob[2] <= lb[0] + 0.5 && ob[1] < m1 && ob[3] > m0 && ob[2] > bestX) { best = o; bestX = ob[2]; }
    }
    return best;
  };
  // (Neighbours are only compared one level deep, so the check cannot go back and forth.)
  const lp = nested ? null : leftOf(prev), ln = nested ? null : leftOf(next);
  if (lp && ln && lp !== ln && !continuesParagraph(lp, ln, pageLines, seps, marginsByRot, pageLines, true)) return false;
  // The same from the other side: rows with a value to the right ("Telefon   030/ 865-0").
  const rightOf = (l) => {
    const lb = localBox(l.bbox, rot);
    const m0 = lb[1] + 0.25 * (lb[3] - lb[1]), m1 = lb[3] - 0.25 * (lb[3] - lb[1]);
    let best = null, bestX = Infinity;
    for (const o of pageLines) {
      if (o === l || o.rotation !== rot) continue;
      const ob = localBox(o.bbox, rot);
      if (ob[0] >= lb[2] - 0.5 && ob[1] < m1 && ob[3] > m0 && ob[0] < bestX) { best = o; bestX = ob[0]; }
    }
    return best;
  };
  const rp = nested ? null : rightOf(prev), rn = nested ? null : rightOf(next);
  if (rp && rn && rp !== rn && !continuesParagraph(rp, rn, pageLines, seps, marginsByRot, pageLines, true)) return false;
  // A short line with a value to its right after a line without one starts a new row.
  if (rn && !rp && b[2] - b[0] < 0.5 * (a[2] - a[0])) return false;
  if (b[0] > a[0] + 0.6 * size) return true; // indented continuation (or centred): no test
  // How far could `prev` have run on? Up to the next text or vertical rule on its line, or the
  // right margin of the page's text.
  let limit = (marginsByRot[rot] || [0, a[2]])[1];
  const mid0 = a[1] + 0.25 * (a[3] - a[1]), mid1 = a[3] - 0.25 * (a[3] - a[1]);
  for (const l of pageLines) {
    if (l === prev || l === next || l.rotation !== rot) continue;
    const o = localBox(l.bbox, rot);
    if (o[0] >= a[2] - 0.5 && o[1] < mid1 && o[3] > mid0) limit = Math.min(limit, o[0]);
  }
  if (rot === 0) {
    for (const [x0, y0, x1, y1] of seps) {
      if (x1 - x0 < 3 && x0 >= a[2] - 0.5 && y0 < prev.bbox[3] && y1 > prev.bbox[1]) limit = Math.min(limit, x0);
    }
  }
  // ...and no further than the right edge of its own column (the widest line of the block
  // that lies in the same column), since wrapped text never runs past it.
  let colRight = Math.max(a[2], b[2]);
  for (const l of blockLines || []) {
    if (l.rotation !== rot) continue;
    const o = localBox(l.bbox, rot);
    if (o[0] < a[2] && a[0] < o[2]) colRight = Math.max(colRight, o[2]);
  }
  limit = Math.min(limit, colRight);
  const words = next.text.trim().split(/\s+/);
  const chars = Math.max(1, next.text.trim().length);
  const firstWord = (words[0].length / chars) * (b[2] - b[0]);
  // The word width is estimated from the line's average character width, so only call the
  // break intentional when there was clearly room left for that word.
  return a[2] + 0.3 * size + 1.15 * firstWord > limit - 1.2 * size;
}

const LABEL_START_RE = /^[^\s:]{1,30}(?:\s[^\s:]{1,20}){0,2}:(?:\s|$)/u;
const URLISH_RE = /^(?:(?:https?:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/i;

/**
 * A paragraph's box must not cover other text: its translation is reflowed inside that box and
 * would be drawn over it. A lead-in on the first line ("Hinweis:" in bold) is allowed; the
 * layout then starts the first line after it.
 */
function groupBoxIsFree(group, line, pageLines) {
  let u = line.bbox;
  for (const l of group) u = union(u, l.bbox);
  for (const o of pageLines) {
    if (o === line || o.rotation !== line.rotation || group.includes(o)) continue;
    const h = o.bbox[3] - o.bbox[1];
    const core = [o.bbox[0] + 1, o.bbox[1] + 0.3 * h, o.bbox[2] - 1, o.bbox[3] - 0.3 * h];
    if (core[0] >= u[2] || core[2] <= u[0] || core[1] >= u[3] || core[3] <= u[1]) continue;
    if (sameBaseline(o, group[0]) && o.bbox[2] <= group[0].bbox[0] + 0.3 * o.size) continue; // lead-in (italics may overhang)
    return false;
  }
  return true;
}

/**
 * Like groupBoxIsFree, but for the paragraph's real shape: each line reaches from its own start
 * to the paragraph's right edge. Text that flows around a heading or picture ("Einen Abakus
 * verwenden" with the paragraph starting to its right) is one paragraph, and its translation is
 * laid out in the same shape (see `rows` in buildSegment).
 */
function groupShapeIsFree(group, line, pageLines) {
  const rot = line.rotation;
  const rows = group.concat([line]).map((l) => localBox(l.bbox, rot)).sort((a, b) => a[1] - b[1]);
  const right = Math.max(...rows.map((r) => r[2]));
  const rects = [];
  rows.forEach((r, i) => {
    rects.push([r[0], r[1], right, r[3]]);
    const nx = rows[i + 1];
    if (nx && nx[1] > r[3]) rects.push([Math.max(r[0], nx[0]), r[3], right, nx[1]]);
  });
  for (const o of pageLines) {
    if (o === line || o.rotation !== rot || group.includes(o)) continue;
    const ob = localBox(o.bbox, rot), h = ob[3] - ob[1];
    const core = [ob[0] + 1, ob[1] + 0.3 * h, ob[2] - 1, ob[3] - 0.3 * h];
    if (!rects.some((r) => core[0] < r[2] && core[2] > r[0] && core[1] < r[3] && core[3] > r[1])) continue;
    if (sameBaseline(o, group[0]) && localBox(o.bbox, rot)[2] <= localBox(group[0].bbox, rot)[0] + 0.3 * o.size) continue; // lead-in
    return false;
  }
  return true;
}

/** Can `line` be appended to a group whose last line is `prev`? */
function joins(prev, line, pageLines, seps, marginsByRot, blockLines) {
  if (line.rotation !== prev.rotation) return false;
  const axis = prev.rotation === 0 || prev.rotation === 180 ? 1 : 0;
  if (sameBaseline(line, prev)) {
    if (line.standalone || prev.standalone) return false;
    if (isLabelBoundary(prev.spans[prev.spans.length - 1], line.spans[0])) return false;
    // The piece on the right starts a column (a cell that lines up with cells above or below).
    const right = localBox(line.bbox, line.rotation)[0] >= localBox(prev.bbox, prev.rotation)[0] ? line : prev;
    if (right.column) return false;
    const a = prev.bbox, b = line.bbox;
    const gap = axis === 1 ? Math.max(b[0] - a[2], a[0] - b[2]) : Math.max(b[1] - a[3], a[1] - b[3]);
    return gap <= 2 * Math.max(line.size, prev.size) && !divided(a, b, seps, axis === 1);
  }
  // `line` must come after `prev` in the direction lines advance
  const n = DIRS[prev.rotation];
  const adv = (line.origin[0] - prev.origin[0]) * -n[1] + (line.origin[1] - prev.origin[1]) * n[0];
  const size = Math.max(line.size, prev.size);
  if (adv <= 0.3 * size || adv > 2 * size) return false;
  if (size / Math.max(0.1, Math.min(line.size, prev.size)) > 1.25) return false;
  if (BULLET_RE.test(line.text) || divided(prev.bbox, line.bbox, seps, axis === 1)) return false;
  if (styleBreak(prev, line)) return false;
  return continuesParagraph(prev, line, pageLines, seps, marginsByRot, blockLines);
}

/** The colour and font family that clearly dominate a line (CJK and symbols aside), or null. */
function lineStyle(line) {
  if (line.style !== undefined) return line.style;
  const color = new Map(), family = new Map();
  let total = 0, latin = 0;
  for (const s of line.spans) {
    const n = s.text.replace(/\s/g, "").length;
    if (!n) continue;
    total += n;
    color.set(s.color, (color.get(s.color) || 0) + n);
    const letters = (s.text.match(/\p{L}/gu) || []).filter((c) => !CJK_RE.test(c)).length;
    if (letters) { latin += letters; family.set(s.font.family, (family.get(s.font.family) || 0) + letters); }
  }
  const top = (m, sum) => {
    let best = null, bw = 0;
    for (const [k, v] of m) if (v > bw) { best = k; bw = v; }
    return sum && bw >= 0.75 * sum ? best : null;
  };
  line.style = { color: top(color, total), family: latin >= 3 ? top(family, latin) : null };
  return line.style;
}

/** A heading in one colour or typeface followed by a line in another is not one paragraph. */
function styleBreak(prev, line) {
  const a = lineStyle(prev), b = lineStyle(line);
  return (a.color && b.color && a.color !== b.color) || (a.family && b.family && a.family !== b.family);
}

/** Form labels ("Prüfer:" in bold, then the value in regular) become their own segments. */
function isLabelBoundary(prev, cur) {
  const styleChange = prev.font.bold !== cur.font.bold || prev.font.italic !== cur.font.italic;
  // A label is short; "…von links nach rechts, sind:" followed by a bold word is running text.
  const isLabel = (t) => t.length <= 40 && t.split(/\s+/).length <= 5;
  return styleChange && ((/:\s*$/.test(prev.text) && isLabel(prev.text.trim())) || /^\s*\S[^:]{0,40}:\s*$/.test(cur.text));
}

function gapOf(prev, cur, rot) {
  if (rot === 0) return cur.bbox[0] - prev.bbox[2];
  if (rot === 180) return prev.bbox[0] - cur.bbox[2];
  if (rot === 90) return prev.bbox[1] - cur.bbox[3];
  return cur.bbox[1] - prev.bbox[3];
}

/** This line's ordinary word space in em (justified text has wide but uniform spaces). */
function typicalGap(line) {
  const normal = (line.gaps || []).filter((g) => g < 0.8).sort((a, b) => a - b);
  return normal.length ? normal[normal.length >> 1] : 0.3;
}

const BLANK_RE = /^\s*[_…]{3,}\s*$|^\s*\.{4,}\s*$/; // fill-in blanks and dot leaders

function chunksOf(line, rot, seps) {
  const spans = line.spans.filter((s) => s.text.trim());
  if (!spans.length) return [];
  // A column gap is much wider than this line's ordinary word spaces.
  const columnGap = Math.max(1.0, 3 * typicalGap(line));
  const out = [[spans[0]]];
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1], cur = spans[i];
    const gap = gapOf(prev, cur, rot);
    const size = Math.max(prev.size, cur.size);
    if (gap > 2 * size || (cur.gapBefore && gap > columnGap * size) || isLabelBoundary(prev, cur)
      || (gap > 0.2 * size && (BLANK_RE.test(cur.text) || BLANK_RE.test(prev.text)))
      || (gap > 0 && divided(prev.bbox, cur.bbox, seps, rot === 0 || rot === 180))) out.push([cur]);
    else out[out.length - 1].push(cur);
  }
  return out;
}

/** A list marker alone ("•", "1.", "a)"): the gap after it is not a column gap. */
const MARKER_ONLY_RE = /^\s*(?:[•◦▪▫●○■□►▶➢➤✓✔·‣⁃–-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s*$/;
const chunkBox = (chunk) => { let b = null; for (const s of chunk) b = union(b, s.bbox); return b; };
const baselineOf = (origin, rot) => { const d = DIRS[rot]; return origin[0] * -d[1] + origin[1] * d[0]; };

/**
 * Pieces of text on one baseline, each with its box in the text's own frame and whether some
 * other piece lies before it on the same baseline (then it starts a column or cell).
 */
function rowItems(rows) {
  const items = [];
  for (const row of rows) {
    for (const chunk of row.chunks) {
      items.push({ row, chunk, rot: row.rot, lb: localBox(chunkBox(chunk), row.rot), base: baselineOf(chunk[0].origin, row.rot),
        size: Math.max(...chunk.map((s) => s.size)), hasLeft: false });
    }
  }
  const sorted = items.slice().sort((a, b) => a.rot - b.rot || a.base - b.base);
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const o = sorted[j];
      if (o.rot !== it.rot || o.base - it.base >= 0.3 * Math.min(it.size, o.size)) break;
      if (o.lb[2] <= it.lb[0] + 0.5) it.hasLeft = true;
      if (it.lb[2] <= o.lb[0] + 0.5) o.hasLeft = true;
    }
  }
  return items;
}

/** Index of points by rounded x, to find aligned column starts quickly. */
function xIndex(points) {
  const m = new Map();
  for (const p of points) {
    const k = `${p.rot}|${Math.round(p.x)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return (x, base, size, rot, self) => {
    for (let dx = -2; dx <= 2; dx++) {
      for (const p of m.get(`${rot}|${Math.round(x) + dx}`) || []) {
        const dy = Math.abs(p.base - base);
        if (p.chunk !== self && Math.abs(p.x - x) <= 1.5 && dy > 0.5 * size && dy <= 3.5 * size) return true;
      }
    }
    return false;
  };
}

/**
 * Columns of tables and exercises are sometimes only half an em apart ("Èr jiā èr shì jǐ?" and
 * "zwei?"). Such a gap separates two cells when the text after it starts exactly where a cell
 * starts in a row just above or below. Splits those chunks and marks the pieces of text that
 * start a column, so that pieces on one baseline are not joined across columns.
 */
function splitColumns(rows) {
  let items = rowItems(rows);
  const anchors = items.filter((it) => it.hasLeft).map((it) => ({ x: it.lb[0], base: it.base, rot: it.rot, chunk: it.chunk }));
  const cands = [];
  for (const it of items) {
    const typical = it.row.typical;
    for (let k = 1; k < it.chunk.length; k++) {
      const prev = it.chunk[k - 1], cur = it.chunk[k];
      const size = Math.max(prev.size, cur.size), gap = gapOf(prev, cur, it.rot);
      if (cur.gapBefore && gap >= 0.4 * size && gap >= 1.6 * typical * size && !MARKER_ONLY_RE.test(spansText(it.chunk.slice(0, k), it.rot))) {
        cands.push({ x: localBox(cur.bbox, it.rot)[0], base: it.base, rot: it.rot, chunk: it.chunk, k, size, row: it.row });
      }
    }
  }
  if (cands.length) {
    const atAnchor = xIndex(anchors), atCand = xIndex(cands);
    const cuts = new Map();
    for (const c of cands) {
      if (!atAnchor(c.x, c.base, c.size, c.rot, c.chunk) && !atCand(c.x, c.base, c.size, c.rot, c.chunk)) continue;
      if (!cuts.has(c.chunk)) cuts.set(c.chunk, { row: c.row, ks: [] });
      cuts.get(c.chunk).ks.push(c.k);
    }
    for (const [chunk, { row, ks }] of cuts) {
      const parts = [];
      let from = 0;
      for (const k of ks.sort((a, b) => a - b)) { parts.push(chunk.slice(from, k)); from = k; }
      parts.push(chunk.slice(from));
      row.chunks.splice(row.chunks.indexOf(chunk), 1, ...parts);
    }
    if (cuts.size) items = rowItems(rows);
  }
  const starts = items.filter((it) => it.hasLeft).map((it) => ({ x: it.lb[0], base: it.base, rot: it.rot, chunk: it.chunk }));
  const atStart = xIndex(starts);
  const column = new Set();
  for (const it of items) if (it.hasLeft && atStart(it.lb[0], it.base, it.size, it.rot, it.chunk)) column.add(it.chunk);
  return column;
}

const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUBSCRIPT = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎" };

/**
 * Small raised or lowered text (m³, 10¹⁰, CO₂) as Unicode superscripts / subscripts, so that it
 * stays a superscript through translation and rebuild. Text that has no such characters is kept.
 */
function scriptText(span, ref, rot) {
  if (span === ref || span.size > 0.85 * ref.size) return span.text;
  const shift = baselineOf(ref.origin, rot) - baselineOf(span.origin, rot); // > 0: raised
  const map = shift > 0.15 * ref.size ? SUPERSCRIPT : shift < -0.08 * ref.size ? SUBSCRIPT : null;
  if (!map || ![...span.text.trim()].every((c) => map[c])) return span.text;
  return span.text.replace(/\S/g, (c) => map[c]);
}

function spansText(spans, rot) {
  let ref = spans[0];
  for (const s of spans) if (s.size > ref.size && /[\p{L}\p{N}]/u.test(s.text)) ref = s;
  let text = scriptText(spans[0], ref, rot);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1], cur = spans[i];
    const t = scriptText(cur, ref, rot);
    if (t === cur.text && !text.endsWith(" ") && !cur.text.startsWith(" ") && gapOf(prev, cur, rot) > 0.15 * Math.min(prev.size, cur.size)) text += " ";
    text += t;
  }
  return text;
}

function joinLines(parts) {
  let text = "";
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (!text) text = part;
    else if (text.endsWith("-") && text.length > 1 && /\p{L}/u.test(text[text.length - 2]) && /^\p{Ll}/u.test(part)) text = text.slice(0, -1) + part;
    else if (text.endsWith("-") && /^[/\-]/.test(part)) text += part; // "Serien-" + "/Modellnummer:"
    else if (/^[-/]\S/.test(part) && /[\p{L}\p{N}]$/u.test(text)) text += part; // URL broken before "-bund.de"
    else text += " " + part;
  }
  return text;
}

function sameBaseline(a, b) {
  const axis = a.rotation === 0 || a.rotation === 180 ? 1 : 0;
  return Math.abs(a.origin[axis] - b.origin[axis]) < 0.3 * Math.min(a.size, b.size);
}

function mergeVisualLines(lines) {
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && sameBaseline(prev, l)) {
      out[out.length - 1] = { ...prev, spans: prev.spans.concat(l.spans), text: prev.text + " " + l.text, bbox: union(prev.bbox, l.bbox), size: Math.max(prev.size, l.size) };
    } else out.push(l);
  }
  return out;
}

function dominant(spans, key) {
  const w = new Map();
  for (const s of spans) {
    const k = key(s);
    w.set(k, (w.get(k) || 0) + s.text.trim().length + 0.01);
  }
  let best = null, bw = -1;
  for (const [k, v] of w) if (v > bw) { best = k; bw = v; }
  return best;
}

function guessAlign(lines, rotation, bounds, margins, pageLines) {
  const pb = localBox(bounds, rotation);
  const pageWidth = pb[2] - pb[0];
  const size = Math.max(...lines.map((l) => l.size));
  const tol = 0.6 * size;
  const boxes = lines.map((l) => localBox(l.bbox, rotation));
  const lefts = boxes.map((b) => b[0]), rights = boxes.map((b) => b[2]);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  if (lines.length === 1) {
    const [x0, x1] = [lefts[0], rights[0]];
    const [lm, rm] = margins || [pb[0], pb[2]];
    if (x0 - lm < 2 * size) return "left";
    // Part of a left-aligned column (another line starts at the same x): left-aligned.
    if ((pageLines || []).some((l) => l !== lines[0] && l.rotation === rotation && Math.abs(localBox(l.bbox, rotation)[0] - x0) < 1)) return "left";
    const c = (x0 + x1) / 2;
    if ((Math.abs(c - (pb[0] + pb[2]) / 2) < 0.02 * pageWidth || Math.abs(c - (lm + rm) / 2) < 0.02 * pageWidth) && x1 - x0 < 0.8 * pageWidth) return "center";
    if (Math.abs(x1 - rm) < tol && x0 - lm > 0.3 * pageWidth) return "right";
    return "left";
  }
  const leftOk = spread(lefts) < tol;
  if (leftOk && lines.length >= 3) {
    const body = rights.slice(0, -1);
    if (spread(body) < tol && rights[rights.length - 1] < Math.max(...body) - tol) return "justify";
  }
  if (leftOk) return "left";
  // Right-aligned and centred lines line up exactly; ragged lines with a hanging indent
  // ("1) 三加六是几？" over "Sān jiā liù shì jǐ?") only come close.
  const tight = Math.min(tol, 0.2 * size + 1);
  if (spread(rights) < tight) return "right";
  if (spread(lefts.map((l, i) => (l + rights[i]) / 2)) < tight) return "center";
  return "left";
}

function redactRect(span, rotation) {
  const [x0, y0, x1, y1] = span.bbox;
  const [ox, oy] = span.origin;
  const perp = rotation === 0 || rotation === 180 ? y1 - y0 : x1 - x0;
  const size = perp > 0 ? Math.min(span.size, perp) : span.size;
  const lo = 0.25 * size, hi = 0.5 * size;
  if (rotation === 0) return [x0, oy - hi, x1, oy - lo];
  if (rotation === 180) return [x0, oy + lo, x1, oy + hi];
  if (rotation === 90) return [ox - hi, y0, ox - lo, y1];
  return [ox + lo, y0, ox + hi, y1];
}

function buildSegment(group, pageNo, bounds, id, marginsByRot, pageLines, shaped = false) {
  const lines = mergeVisualLines(group);
  const spans = lines.flatMap((l) => l.spans);
  const text = joinLines(lines.map((l) => l.text));
  if (!text.trim()) return null;
  const rotation = lines[0].rotation;
  let bbox = null;
  for (const s of spans) bbox = union(bbox, s.bbox);
  const size = Number(dominant(spans, (s) => round2(s.size).toFixed(1)));
  const font = dominant(spans, (s) => s.font.name);
  const info = spans.find((s) => s.font.name === font).font;
  let pitch = null;
  if (lines.length > 1) {
    const axis = rotation === 0 || rotation === 180 ? 1 : 0;
    const diffs = [];
    for (let i = 1; i < lines.length; i++) {
      const d = Math.abs(lines[i].origin[axis] - lines[i - 1].origin[axis]);
      if (d > 0.3 * size) diffs.push(d);
    }
    if (diffs.length) {
      diffs.sort((a, b) => a - b);
      const m = diffs.length >> 1;
      pitch = round2(diffs.length % 2 ? diffs[m] : (diffs[m - 1] + diffs[m]) / 2);
    }
  }
  const align = guessAlign(lines, rotation, bounds, marginsByRot[rotation], pageLines);
  const color = dominant(spans, (s) => s.color);
  const formula = isFormula(text, spans);
  const marks = inlineMarks(spans, info, color, size);
  const prefix = stylePrefix(spans, info, color);
  // Where each line starts, when that is not simply the paragraph's left edge (text flowing
  // around a heading or picture, hanging indents): [start along the line, baseline], in the
  // text's own frame. The translation is laid out in the same shape.
  let rows;
  if (lines.length > 1 && (shaped || align === "left" || align === "justify")) {
    const d = DIRS[rotation], n = [-d[1], d[0]];
    const r = lines.map((l) => [round2(localBox(l.bbox, rotation)[0]), round2(l.origin[0] * n[0] + l.origin[1] * n[1])]).sort((a, b) => a[1] - b[1]);
    const left = Math.min(...r.map((x) => x[0]));
    if (r.some((x, i) => i > 0 && x[0] > left + 0.5 * size)) rows = r;
  }
  return {
    id, page: pageNo, text, size, font, rotation, lines: lines.length, line_pitch: pitch, ...(rows ? { rows } : {}), ...(marks.length ? { marks } : {}), ...(prefix ? { prefix } : {}),
    // Numbers, dates, times, amounts and codes without any letter need no translation; nor do
    // formulas, whose layout (fractions, exponents) a reflowed line would destroy.
    skip: !/\p{L}/u.test(text) || formula,
    ...(formula ? { formula: true } : {}),
    bbox: bbox.map(round2),
    color,
    bold: info.bold, italic: info.italic, family: familyFor(info),
    align,
    origin: lines[0].origin.map(round2),
    redact: spans.filter((s) => s.text.trim()).map((s) => redactRect(s, rotation).map(round2)),
  };
}

const MATH_FONT_RE = /^(?:cm(?:mi|sy|ex|bsy|mib)\d|msam|msbm|eufm|eusm|rsfs|stmary|wasy|lmmath|latinmodern-?math|cambria-?math|stix\w*math|xits|asana|tx(?:mi|sy|ex)|px(?:mi|sy|ex)|mtmi|mtsy|mathematicalpi|mt-?extra|euler|esint|symbol)|math/i;
const MATH_SIGN_RE = /[=≈≠≤≥±∓×÷·⋅√∑∏∫∂∞∝→⇒⇔∇∆Δ\u0370-\u03ff]/;

/**
 * A formula (E = m·v², fraction parts, unit expressions such as kg·m²/s³): mostly set in math
 * fonts, or math signs without a single word. It stays as it is.
 */
function isFormula(text, spans) {
  let math = 0, all = 0;
  for (const s of spans) {
    const n = s.text.replace(/\s/g, "").length;
    all += n;
    if (MATH_FONT_RE.test(s.font.name)) math += n;
  }
  if (all && math >= 0.6 * all && !/\p{L}{5,}/u.test(text)) return true;
  return MATH_SIGN_RE.test(text) && !/\p{L}{4,}/u.test(text);
}

/**
 * Extract translatable segments from the given pages of an open document.
 * Returns page info (size, protected text boxes, vector graphics for the rebuild) and
 * segments with page-local ids; the caller numbers them across the whole document.
 */
async function extractPages(doc, pageList, onProgress) {
  const pages = {}, segments = [];
  let done = 0;
  for (const p of pageList) {
    const page = doc.loadPage(p);
    const bounds = page.getBounds();
    const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
    const graphics = pageGraphics(page);
    const { seps } = graphics;
    const protect = []; // text we never extract (skewed lines) must survive merged redactions
    const rowBlocks = [];
    for (const block of pageBlocks(page, bounds, seps)) {
      const rows = [];
      for (const line of block.lines) {
        const rot = rotationOf(line.dir);
        if (rot === null) {
          for (const sp of line.spans) protect.push(sp.bbox);
          continue;
        }
        const chunks = chunksOf(line, rot, seps);
        if (chunks.length) rows.push({ rot, typical: typicalGap(line), chunks });
      }
      rowBlocks.push(rows);
    }
    const column = splitColumns(rowBlocks.flat());
    const blocks = [];
    for (const rows of rowBlocks) {
      const lines = [];
      for (const { rot, chunks } of rows) {
        for (const chunk of chunks) {
          const text = spansText(chunk, rot);
          if (!text.trim()) continue;
          lines.push({ spans: chunk, text, bbox: chunkBox(chunk), origin: chunk[0].origin, size: Math.max(...chunk.map((s) => s.size)),
            rotation: rot, standalone: chunks.length > 1, column: column.has(chunk) });
        }
      }
      if (lines.length) blocks.push(lines);
    }
    const marginsByRot = {};
    for (const rot of [0, 90, 180, 270]) {
      const boxes = blocks.flat().filter((l) => l.rotation === rot).map((l) => localBox(l.bbox, rot));
      if (boxes.length) marginsByRot[rot] = [Math.min(...boxes.map((b) => b[0])), Math.max(...boxes.map((b) => b[2]))];
    }
    const pageLines = blocks.flat();
    let local = 0;
    for (const lines of blocks) {
      // A line joins the paragraph it continues. That is usually the previous line, but in
      // tables and forms the cells of one row come first, so look back over recent groups.
      const groups = [];
      for (const line of lines) {
        let target = null;
        for (let gi = groups.length - 1; gi >= Math.max(0, groups.length - 16) && !target; gi--) {
          const g = groups[gi];
          if (!joins(g[g.length - 1], line, pageLines, seps, marginsByRot, lines)) continue;
          if (groupBoxIsFree(g, line, pageLines)) target = g;
          else if (groupShapeIsFree(g, line, pageLines)) { target = g; g.shaped = true; }
        }
        if (target) target.push(line); else groups.push([line]);
      }
      for (const g of groups) {
        const seg = buildSegment(g, p, bounds, ++local, marginsByRot, pageLines, g.shaped);
        if (seg) segments.push(seg);
      }
    }
    pages[p] = { width, height, x0: bounds[0], y0: bounds[1], protect: protect.map((r) => r.map(round2)), graphics };
    free(page);
    done++;
    if (onProgress) onProgress(done, pageList.length);
    if (done % 4 === 0) await tick();
  }
  return { pages, segments };
}

/** Extract every page of a PDF (single-threaded; the UI uses a worker pool instead). */
async function extractDocument(bytes, onProgress) {
  const doc = M.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword && doc.needsPassword()) throw new Error("Password-protected PDFs are not supported.");
    const n = doc.countPages();
    const { pages, segments } = await extractPages(doc, [...Array(n).keys()], onProgress);
    segments.forEach((s, i) => { s.id = i + 1; });
    return { pages: [...Array(n).keys()].map((i) => pages[i]), segments };
  } finally {
    free(doc);
  }
}

// --------------------------------------------------------- exchange formats

const MARKER_LINE_RE = /^\s*[\[［【〔(（<«]{2}\s*#?\s*(\p{Nd}+)\s*[\]］】〕)）>»]{2}\s*(.*)$/u;
const digitsToInt = (s) => parseInt(s.replace(/\p{Nd}/gu, (d) => {
  const code = d.codePointAt(0);
  for (const zero of [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10]) if (code >= zero && code <= zero + 9) return String(code - zero);
  return d;
}), 10);

function exportTxt(segments, tr = {}) {
  return segments.map((s) => `[[${s.id}]]\n${tr[s.id] || s.text}\n`).join("\n");
}

function parseMarkedText(text) {
  const result = {};
  let current = null, buf = [];
  const flush = () => {
    if (current !== null) {
      const v = buf.join("\n").trim();
      if (v) result[current] = v;
    }
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = raw.match(MARKER_LINE_RE);
    if (m) {
      flush();
      current = digitsToInt(m[1]);
      buf = m[2].trim() ? [m[2]] : [];
    } else if (current !== null) buf.push(raw);
  }
  flush();
  return result;
}

function csvCell(v) {
  v = String(v ?? "");
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function exportCsv(segments, tr = {}) {
  const rows = [["id", "page", "source", "target"], ...segments.map((s) => [s.id, s.page + 1, s.text, tr[s.id] || ""])];
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function parseCsvRows(text, delim) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const head = text.slice(0, 4096).split(/\r?\n/)[0];
  const delim = [",", ";", "\t"].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = parseCsvRows(text, delim);
  if (!rows.length) return {};
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let idCol = 0, tgtCol = rows[0].length - 1, body = rows;
  if (header.includes("id")) {
    idCol = header.indexOf("id");
    body = rows.slice(1);
    for (const name of ["target", "translation", "translated"]) if (header.includes(name)) { tgtCol = header.indexOf(name); break; }
  }
  const out = {};
  for (const r of body) {
    if (r.length <= Math.max(idCol, tgtCol)) continue;
    const id = parseInt(r[idCol].trim(), 10);
    const v = r[tgtCol].trim();
    if (Number.isFinite(id) && String(id) === r[idCol].trim() && v) out[id] = v;
  }
  return out;
}

function exportJson(segments, tr = {}, name = "") {
  return JSON.stringify({ document: name, segments: segments.map((s) => ({ id: s.id, page: s.page + 1, source: s.text, target: tr[s.id] || "" })) }, null, 2);
}

function parseJson(data) {
  const out = {};
  const items = Array.isArray(data) ? data : data && Array.isArray(data.segments) ? data.segments : null;
  if (items) {
    for (const it of items) {
      const v = String(it.target || it.translation || "").trim();
      if (v && it.id != null) out[parseInt(it.id, 10)] = v;
    }
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) if (/^\s*\d+\s*$/.test(k) && typeof v === "string" && v.trim()) out[parseInt(k, 10)] = v.trim();
  }
  return out;
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrEsc = (s) => xmlEsc(s).replace(/"/g, "&quot;");

function exportXliff(segments, tr = {}, name = "", src = "en", tgt = "") {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
    `  <file original="${attrEsc(name)}" source-language="${attrEsc(src || "und")}"${tgt ? ` target-language="${attrEsc(tgt)}"` : ""} datatype="plaintext">`,
    "    <body>",
  ];
  for (const s of segments) {
    out.push(`      <trans-unit id="${s.id}">`, `        <source>${xmlEsc(s.text)}</source>`);
    if (tr[s.id]) out.push(`        <target state="translated">${xmlEsc(tr[s.id])}</target>`);
    out.push(`        <note>page ${s.page + 1}</note>`, "      </trans-unit>");
  }
  out.push("    </body>", "  </file>", "</xliff>", "");
  return out.join("\n");
}

function parseXliff(text) {
  const dom = new DOMParser().parseFromString(text, "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("The XLIFF file is not valid XML.");
  const out = {};
  for (const el of dom.getElementsByTagName("*")) {
    if (el.localName !== "trans-unit" && el.localName !== "unit") continue;
    const id = parseInt((el.getAttribute("id") || "").trim(), 10);
    if (!Number.isFinite(id)) continue;
    const v = [...el.getElementsByTagName("*")].filter((t) => t.localName === "target").map((t) => t.textContent).join("").trim();
    if (v) out[id] = v;
  }
  return out;
}

// ---- minimal ZIP (store) writer and reader, enough for .docx
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

async function unzipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a valid .docx (zip) file.");
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
      const raw = bytes.subarray(start, start + csize);
      if (method === 0) return raw;
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${wanted} not found in the .docx file.`);
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function exportDocx(segments, tr = {}) {
  const para = (text, marker) => {
    const props = marker ? '<w:rPr><w:color w:val="999999"/><w:sz w:val="16"/></w:rPr>' : "";
    const runs = text.split("\n").map((l, i) => (i ? "<w:br/>" : "") + `<w:t xml:space="preserve">${xmlEsc(l)}</w:t>`).join("");
    return `<w:p><w:r>${props}${runs}</w:r></w:p>`;
  };
  const body = segments.map((s) => para(`[[${s.id}]]`, true) + para(tr[s.id] || s.text, false)).join("");
  return zipStore([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>` },
  ]);
}

// Word's Symbol and Wingdings characters (stored as private-use codes) -> Unicode.
const SYMBOL_FONT = {
  0x22: "∀", 0x24: "∃", 0x27: "∋", 0x2d: "−", 0x40: "≅", 0x41: "Α", 0x42: "Β", 0x44: "Δ", 0x46: "Φ", 0x47: "Γ",
  0x4c: "Λ", 0x50: "Π", 0x51: "Θ", 0x53: "Σ", 0x57: "Ω", 0x61: "α", 0x62: "β", 0x63: "χ", 0x64: "δ", 0x65: "ε",
  0x66: "φ", 0x67: "γ", 0x68: "η", 0x6a: "ϕ", 0x6b: "κ", 0x6c: "λ", 0x6d: "μ", 0x6e: "ν", 0x70: "π", 0x71: "θ",
  0x72: "ρ", 0x73: "σ", 0x74: "τ", 0x77: "ω", 0x78: "ξ", 0x79: "ψ", 0x7a: "ζ", 0x7e: "∼", 0xa3: "≤", 0xa5: "∞",
  0xab: "↔", 0xac: "←", 0xad: "↑", 0xae: "→", 0xaf: "↓", 0xb0: "°", 0xb1: "±", 0xb3: "≥", 0xb4: "×", 0xb5: "∝",
  0xb6: "∂", 0xb7: "•", 0xb8: "÷", 0xb9: "≠", 0xba: "≡", 0xbb: "≈", 0xbc: "…", 0xc6: "∅", 0xd0: "∇", 0xd5: "∏",
  0xd6: "√", 0xd7: "⋅", 0xdb: "⇔", 0xdc: "⇐", 0xde: "⇒", 0xe5: "∑", 0xf2: "∫",
};
const WINGDINGS = { 0x6c: "●", 0x6e: "■", 0x6f: "□", 0x71: "❖", 0x75: "◆", 0x9f: "•", 0xa8: "☐", 0xab: "★", 0xd8: "➢", 0xe0: "→", 0xe8: "➔", 0xef: "⇦", 0xf0: "⇨", 0xfb: "✗", 0xfc: "✓", 0xfd: "☒", 0xfe: "☑" };

function wordSymbol(font, code) {
  const c = parseInt(code || "", 16);
  if (!Number.isFinite(c)) return "";
  const low = c >= 0xf000 ? c - 0xf000 : c;
  const table = /symbol/i.test(font || "") ? SYMBOL_FONT : /wingdings/i.test(font || "") ? WINGDINGS : null;
  return (table && table[low]) || (c >= 0xf000 ? "" : String.fromCodePoint(c));
}

async function parseDocx(bytes) {
  const xml = new TextDecoder().decode(await unzipEntry(bytes, "word/document.xml"));
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const paras = [...dom.getElementsByTagNameNS(W_NS, "p")].map((p) => {
    let s = "";
    for (const el of p.getElementsByTagNameNS(W_NS, "*")) {
      if (el.localName === "t") s += el.textContent;
      else if (el.localName === "br" || el.localName === "cr") s += "\n";
      else if (el.localName === "tab") s += "\t";
      else if (el.localName === "sym") s += wordSymbol(el.getAttributeNS(W_NS, "font"), el.getAttributeNS(W_NS, "char"));
    }
    return s;
  });
  return parseMarkedText(paras.join("\n"));
}

/**
 * Decode an imported text file. Excel's default "CSV" and older Notepad versions save in the
 * Windows code page rather than UTF-8; reading those as UTF-8 would turn umlauts and signs
 * into "?" replacement characters.
 */
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\ufeff/, "");
  } catch (_) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Detect the format of a translated file and parse it into {id: text}. */
async function parseImport(name, bytes) {
  name = (name || "").toLowerCase();
  if (name.endsWith(".docx") || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return parseDocx(bytes);
  const text = decodeText(bytes);
  const head = text.trimStart();
  if (/\.(xlf|xliff)$/.test(name) || (head.startsWith("<") && head.slice(0, 500).includes("xliff"))) return parseXliff(text);
  if (name.endsWith(".json") || head.startsWith("{") || head.startsWith("[")) {
    try { return parseJson(JSON.parse(text)); } catch (_) { /* not JSON after all */ }
  }
  if (/\.(csv|tsv)$/.test(name)) return parseCsv(text);
  return parseMarkedText(text);
}

// ------------------------------------------------------------------ rebuild

const CJK_RE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿＀-￯]|[\u{20000}-\u{3134f}]/u;
const NO_LINE_START = new Set([..."、。，．！？：；）」』】》〉,.!?;:)]}%"]);

/** Look-alikes for signs that none of the built-in fonts contain. */
const GLYPH_SUBST = {
  0x2300: 0xd8,   // ⌀ diameter -> Ø
  0x25ba: 0x25b6, // ► -> ▶
  0x25c4: 0x25c0, // ◄ -> ◀
  0x25b8: 0x25b6, // ▸ -> ▶
  0x25c2: 0x25c0, // ◂ -> ◀
  0x2610: 0x25a1, // ☐ -> □
  0x223f: 0x223d, // ∿ -> ∽
  0x2259: 0x3d,   // ≙ -> =
  0x2011: 0x2d,   // non-breaking hyphen -> -
  0x2212: 0x2d,   // minus sign -> - (if missing)
  0x202f: 0x20,   // narrow no-break space
  0x2009: 0x20,   // thin space
  0x200b: 0x20,   // zero-width space
};

/**
 * The built-in oblique sans fonts draw Cyrillic "т" upright but give it the width of the wide
 * italic form, which leaves gaps around it ("Час т ина"); the upright font's width is used, and
 * the text after it is positioned anew (`own`), since a viewer advances by the font's width.
 */
const ADVANCE_FROM = { "Helvetica-Oblique": { 0x442: "Helvetica" }, "Helvetica-BoldOblique": { 0x442: "Helvetica-Bold" } };

class FontKit {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts;
    this.entries = new Map();
    this.missing = 0;
    this.missingChars = new Set();
  }
  entry(name) {
    let e = this.entries.get(name);
    if (!e) {
      const font = name === "custom" ? new M.Font("UserFont", this.opts.customFont) : new M.Font(name);
      e = { name, font, ref: null, res: `FTr${this.entries.size}`, adv: new Map(), gid: new Map() };
      this.entries.set(name, e);
    }
    return e;
  }
  chain(seg, text) {
    const family = this.opts.fontMode === "auto" || this.opts.fontMode === "custom" ? seg.family : this.opts.fontMode;
    const v = (seg.bold ? 1 : 0) + (seg.italic ? 2 : 0);
    const chain = [];
    if (this.opts.fontMode === "custom" && this.opts.customFont) chain.push("custom");
    chain.push(BASE_FONTS[family][v], "Symbol", "ZapfDingbats");
    let cjk = this.opts.cjk || "zh-Hans";
    if (/[぀-ヿ]/.test(text)) cjk = "ja";
    else if (/[가-힯ᄀ-ᇿ]/.test(text)) cjk = "ko";
    chain.push(cjk);
    return chain;
  }
  glyph(chain, cp) {
    const found = this.lookup(chain, cp) || (GLYPH_SUBST[cp] && this.lookup(chain, GLYPH_SUBST[cp]));
    if (found) return found;
    if (cp > 32) { this.missing++; this.missingChars.add(String.fromCodePoint(cp)); }
    const e = this.entry(chain[0]);
    return { e, gid: 0, adv: this.advance(e, 0) };
  }
  lookup(chain, cp) {
    // U+FFFD is "unknown character": the fallback font draws it as a "?" in a diamond, which
    // looks like a wrong translation. It is reported as missing instead of being drawn.
    if (cp === 0xfffd) return null;
    for (const name of chain) {
      const e = this.entry(name);
      let gid = e.gid.get(cp);
      if (gid === undefined) { gid = e.font.encodeCharacter(cp); e.gid.set(cp, gid); }
      if (gid > 0) {
        const from = ADVANCE_FROM[name] && ADVANCE_FROM[name][cp];
        if (from) {
          const u = this.lookup([from], cp);
          if (u) return { e, gid, adv: u.adv, own: (this.advance(e, gid) - u.adv) / 2 }; // the glyph sits centred in its wide box
        }
        return { e, gid, adv: this.advance(e, gid) };
      }
    }
    return null;
  }
  advance(e, gid) {
    let a = e.adv.get(gid);
    if (a === undefined) { a = e.font.advanceGlyph(gid, 0); e.adv.set(gid, a); }
    return a;
  }
  ref(e) {
    if (!e.ref) e.ref = this.doc.addFont(e.font);
    return e.ref;
  }
}

const WORD_EDGE_RE = /^[("'„“«‚‘\[{]+|[)"'”»’\]},.;:!?]+$/gu;
const wordCore = (w) => w.replace(WORD_EDGE_RE, "");

/**
 * Words of a segment printed in another style than the rest (bold pinyin, a blue ■, an
 * italic term): [word, bold, italic, colour or "", count]. Only words that never appear in the
 * main style are kept; they are styled again where they appear in the translation (names,
 * romanisations, symbols and codes are usually kept by translators).
 */
function inlineMarks(spans, info, color, size) {
  const plain = new Set(), marked = new Map();
  for (const sp of spans) {
    const differs = sp.font.bold !== info.bold || sp.font.italic !== info.italic || sp.color !== color;
    for (const raw of sp.text.split(/\s+/)) {
      const w = wordCore(raw);
      if (!w) continue;
      if (!differs) { plain.add(w); continue; }
      if ([...w].length < 2 && /\p{L}/u.test(w)) continue; // single letters are too ambiguous
      const scale = Math.abs(sp.size / size - 1) > 0.08 ? round2(sp.size / size) : 1;
      const key = `${w}\u0000${sp.font.bold ? 1 : 0}${sp.font.italic ? 1 : 0}${sp.color}|${scale}`;
      const m = marked.get(key);
      if (m) m[4]++;
      else marked.set(key, [w, sp.font.bold ? 1 : 0, sp.font.italic ? 1 : 0, sp.color === color ? "" : sp.color, 1, scale]);
    }
  }
  const seen = new Set();
  const out = [];
  for (const m of marked.values()) {
    if (m.prefix) continue;
    if (plain.has(m[0]) || seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m);
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * A styled beginning such as "**Tabelle 2.3** Heizwerte …" or "**Abb. 4:** …": [last word, bold,
 * italic, colour or ""]. The translation is styled from its start up to that word ("Таблиця 2.3").
 */
function stylePrefix(spans, info, color) {
  const lead = [];
  for (const s of spans) {
    if (!s.text.trim()) continue;
    if (s.font.bold !== info.bold || s.font.italic !== info.italic || s.color !== color) lead.push(s); else break;
  }
  if (!lead.length || lead.length === spans.filter((s) => s.text.trim()).length) return null;
  const words = lead.map((s) => s.text).join(" ").trim().split(/\s+/);
  const last = wordCore(words[words.length - 1]);
  if (words.length > 4 || !last || !/\d|[:.]$/.test(words[words.length - 1])) return null;
  const f = lead[0].font;
  return [last, f.bold ? 1 : 0, f.italic ? 1 : 0, lead[0].color === color ? "" : lead[0].color];
}

/**
 * Split text into paragraphs of breakable tokens: {sp: space before, glyphs, w (em)}.
 * `styleOf(word)` may return {chain, color} for words to print in another style.
 */
function tokenize(text, fk, chain, styleOf = null, prefix = null) {
  const spaceAdv = fk.glyph(chain, 32).adv;
  const paras = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    const tokens = [];
    let cur = null, pendingSpace = false;
    for (const ch of para) {
      if (/\s/.test(ch)) { pendingSpace = true; cur = null; continue; }
      if (cur && !pendingSpace && NO_LINE_START.has(ch)) { cur.text += ch; continue; }
      if (CJK_RE.test(ch) || !cur || pendingSpace || CJK_RE.test(cur.last)) {
        cur = { sp: pendingSpace && tokens.length > 0, text: ch, last: ch };
        tokens.push(cur);
      } else {
        cur.text += ch; cur.last = ch;
      }
      pendingSpace = false;
    }
    // The styled beginning ends with the first token that is its last word (within the first few).
    const prefixEnd = prefix && !paras.length ? tokens.slice(0, 8).findIndex((t) => wordCore(t.text) === prefix.last) : -1;
    for (const [ti, t] of tokens.entries()) {
      t.glyphs = []; t.w = 0;
      const core = styleOf ? wordCore(t.text) : "";
      let st = core ? styleOf(core) : null, from = st ? t.text.indexOf(core) : -1, to = from + core.length;
      if (!st && ti <= prefixEnd) { st = prefix; from = 0; to = t.text.length; }
      let i = 0;
      for (const ch of t.text) {
        const inCore = st && i >= from && i < to;
        let g = fk.glyph(inCore ? st.chain : chain, ch.codePointAt(0));
        if (inCore && (st.color || st.scale !== 1)) g = { ...g, color: st.color, scale: st.scale };
        t.glyphs.push(g); t.w += g.adv * (g.scale || 1);
        i += ch.length;
      }
    }
    paras.push(tokens);
  }
  return { paras, spaceAdv };
}

/**
 * Greedy line breaking; widths are in em (font size 1). `width` is a number, or a function
 * giving the width of line i (paragraphs that flow around a heading or picture).
 */
function wrap(tok, width, indent = 0) {
  const lines = [];
  const widthOf = typeof width === "function" ? width : (i) => (i ? width : width - indent); // the first line may be indented
  const avail = () => widthOf(lines.length);
  for (const tokens of tok.paras) {
    let line = { tokens: [], w: 0, last: false };
    const push = () => { lines.push(line); line = { tokens: [], w: 0, last: false }; };
    for (let t of tokens) {
      const sw = line.tokens.length && t.sp ? tok.spaceAdv : 0;
      if (line.tokens.length && line.w + sw + t.w > avail()) push();
      if (!line.tokens.length && t.w > avail()) { // break an over-long word by characters
        let piece = { sp: false, glyphs: [], w: 0 };
        for (const g of t.glyphs) {
          if (piece.glyphs.length && piece.w + g.adv > avail()) { line.tokens.push(piece); line.w = piece.w; push(); piece = { sp: false, glyphs: [], w: 0 }; }
          piece.glyphs.push(g); piece.w += g.adv;
        }
        t = piece;
      }
      line.w += (line.tokens.length && t.sp ? tok.spaceAdv : 0) + t.w;
      line.tokens.push(t);
    }
    line.last = true;
    push();
  }
  return lines;
}

function lineHeight(seg) {
  return Math.max(seg.line_pitch || 1.15 * seg.size, seg.size);
}

function obstaclesFor(graphics, segs) {
  const { seps, containers } = graphics;
  const edges = segs.map((s) => s.bbox).concat(seps);
  for (const c of containers) edges.push([c[0], c[1], c[0], c[3]], [c[2], c[1], c[2], c[3]], [c[0], c[1], c[2], c[1]], [c[0], c[3], c[2], c[3]]);
  return { edges, containers };
}

/** How far a single-line segment may grow along its reading direction: [a0, a1] in the local frame. */
function expandedSpan(seg, bounds, obs, gap = 0.4 * seg.size) {
  const rot = seg.rotation;
  const r = localBox(seg.bbox, rot), pb = localBox(bounds, rot);
  const margin = Math.min(0.04 * (pb[2] - pb[0]), 24);
  let right = pb[2] - margin, left = pb[0] + margin;
  const pageArea = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
  const sb = seg.bbox;
  for (const c of obs.containers) {
    const inside = c[0] - 1 <= sb[0] && sb[2] <= c[2] + 1 && c[1] - 1 <= sb[1] && sb[3] <= c[3] + 1;
    if (inside && (c[2] - c[0]) * (c[3] - c[1]) < 0.9 * pageArea) {
      const lc = localBox(c, rot);
      right = Math.min(right, lc[2] - gap);
      left = Math.max(left, lc[0] + gap);
    }
  }
  const h = r[3] - r[1], by0 = r[1] + 0.2 * h, by1 = r[3] - 0.2 * h;
  for (const e of obs.edges) {
    if (e === sb) continue;
    const o = localBox(e, rot);
    if (o[3] < by0 || o[1] > by1) continue;
    if (o[0] >= r[2] - 0.5) right = Math.min(right, o[0] - gap);
    if (o[2] <= r[0] + 0.5) left = Math.max(left, o[2] + gap);
  }
  right = Math.max(right, r[2]);
  left = Math.min(left, r[0]);
  if (seg.align === "left" || seg.align === "justify") return [r[0], right];
  if (seg.align === "right") return [left, r[2]];
  const grow = Math.min(r[0] - left, right - r[2]);
  return [r[0] - grow, r[2] + grow];
}

const fmt = (v) => (Math.abs(v) < 1e-6 ? "0" : String(Math.round(v * 1000) / 1000));

/** Lay out one translation and return PDF content-stream operators (in page space). */
function layoutSegment(seg, text, fk, bounds, obs, opts, used, stats, leadEnd = null, lineEnds = null) {
  const d = DIRS[seg.rotation], n = [-d[1], d[0]], u = [d[1], -d[0]];
  const corners = [[seg.bbox[0], seg.bbox[1]], [seg.bbox[2], seg.bbox[1]], [seg.bbox[0], seg.bbox[3]], [seg.bbox[2], seg.bbox[3]]];
  const along = corners.map(([x, y]) => x * d[0] + y * d[1]), across = corners.map(([x, y]) => x * n[0] + y * n[1]);
  let a0 = Math.min(...along), a1 = Math.max(...along);
  const b1 = Math.max(...across);
  if (obs && seg.lines === 1) [a0, a1] = expandedSpan(seg, bounds, obs);
  const ob = seg.origin[0] * n[0] + seg.origin[1] * n[1];
  // First-line indent (paragraph indent, or a lead-in such as "Hinweis:" before the text).
  const oa = seg.origin[0] * d[0] + seg.origin[1] * d[1];
  let rows = seg.rows && seg.rows.length > 1 ? seg.rows : null;
  let indent = !rows && seg.lines > 1 && (seg.align === "left" || seg.align === "justify") && oa - a0 > 0.5 ? oa - a0 : 0;
  // A translated lead-in ("Граматика:" for "Grammatik:") may be longer than the original:
  // the first line then starts after it.
  if (leadEnd !== null && (seg.align === "left" || seg.align === "justify")) {
    if (rows) rows = [[Math.max(rows[0][0], leadEnd), rows[0][1]], ...rows.slice(1)];
    else if (seg.lines === 1) a0 = Math.min(Math.max(a0, leadEnd), a1 - seg.size);
    else indent = Math.max(indent, leadEnd - a0);
  }
  const s0 = seg.size, L0 = lineHeight(seg);
  const top = ob - 0.85 * s0;
  const H = Math.max(b1, ob + 0.2 * s0) + 0.15 * s0 - top;
  // Paragraph with its own shape: a line starts where the original line nearest to its
  // baseline started.
  const startAt = (b) => {
    if (!rows) return null;
    let best = rows[0];
    for (const r of rows) if (Math.abs(r[1] - b) < Math.abs(best[1] - b)) best = r;
    return best[0];
  };
  /** Width (em) of each line at scale k, for wrap(). */
  const widths = (W, k) => {
    if (!rows) return W / (s0 * k);
    const base = top + 0.85 * s0 * k, L = L0 * k;
    return (i) => (a0 + W - Math.max(a0, startAt(base + i * L))) / (s0 * k);
  };

  const chain = fk.chain(seg, text);
  // Inline styles of the original (bold pinyin, coloured symbols) where those words reappear,
  // unless a word turns up far more often than in the original (then it is ordinary text).
  let styleOf = null;
  if (seg.marks && seg.marks.length) {
    const counts = new Map();
    for (const w of text.split(/\s+/)) { const c = wordCore(w); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    const styles = new Map();
    for (const [w, bold, italic, color, n, scale] of seg.marks) {
      if (!counts.has(w) || counts.get(w) > 2 * n + 1) continue;
      styles.set(w, { chain: fk.chain({ ...seg, bold: !!bold, italic: !!italic }, text), color: color || null, scale: scale || 1 });
    }
    if (styles.size) styleOf = (w) => styles.get(w) || null;
  }
  let prefix = null;
  if (seg.prefix) {
    const [last, bold, italic, color] = seg.prefix;
    prefix = { last, chain: fk.chain({ ...seg, bold: !!bold, italic: !!italic }, text), color: color || null, scale: 1 };
  }
  const tok = tokenize(text.trim(), fk, chain, styleOf, prefix);
  /** Largest scale (<= 1) at which the text fits a box of width W, and its lines. */
  const fitWidth = (W) => {
    const fits = (k) => {
      const lines = wrap(tok, widths(W, k), indent / (s0 * k));
      return (lines.length - 1) * L0 * k + 1.05 * s0 * k <= H + 0.01 ? lines : null;
    };
    const lines = fits(1);
    if (lines) return { k: 1, lines };
    const search = (lo) => {
      let hi = 1, best = null, bestK = lo;
      if (!fits(lo)) return null;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const ok = fits(mid);
        if (ok) { best = ok; bestK = mid; lo = mid; } else hi = mid;
      }
      return { k: bestK, lines: best || fits(lo) };
    };
    return search(Math.max(opts.minScale || 0, 0.02)) || search(0.02) || { k: 0.02, lines: wrap(tok, widths(W, 0.02), indent / (s0 * 0.02)) };
  };
  let W = (a1 - a0) * 1.01;
  let { k, lines } = fitWidth(W);
  if (k < 1 && obs && seg.lines > 1) {
    // A wrapped paragraph or table cell may widen a little into free space before shrinking.
    const [e0, e1] = expandedSpan(seg, bounds, obs, 1.0 * seg.size);
    const grow = Math.min(e1 - e0, (a1 - a0) * 1.3) - (a1 - a0);
    if (grow > 0.5) {
      const n0 = seg.align === "right" ? a0 - grow : seg.align === "center" ? a0 - grow / 2 : a0;
      const wide = fitWidth((a1 - a0 + grow) * 1.01);
      if (wide.k > k) { ({ k, lines } = wide); a0 = n0; a1 = n0 + (a1 - a0) + grow; W = (a1 - a0) * 1.01; }
    }
  }
  if (k < 1) stats.shrunk.push({ id: seg.id, scale: Math.round(k * 100) / 100 });
  const s = s0 * k, L = L0 * k;
  const base1 = seg.lines === 1 && lines.length === 1 ? ob - (s0 - s) * 0.3 : top + 0.85 * s;
  const rg = (hex) => `${hex.slice(1).match(/../g).map((h) => fmt(parseInt(h, 16) / 255)).join(" ")} rg`;
  const ops = [`BT ${rg(seg.color)}`];
  let curFont = null, curColor = seg.color;
  lines.forEach((line, i) => {
    const b = base1 + i * L;
    const ind = rows ? Math.max(0, startAt(b) - a0) : i === 0 ? indent : 0;
    const lw = line.w * s, spare = W - ind - lw;
    let a = a0 + ind, extra = 0;
    if (seg.align === "right") a = a0 + ind + spare;
    else if (seg.align === "center") a = a0 + ind + spare / 2;
    else if (seg.align === "justify" && !line.last) {
      const gaps = line.tokens.filter((t, j) => j > 0 && t.sp).length;
      if (gaps) extra = Math.max(0, spare) / gaps;
    }
    line.tokens.forEach((t, j) => {
      if (j > 0 && t.sp) a += tok.spaceAdv * s + extra;
      let run = null;
      const flush = () => {
        if (!run) return;
        if (curFont !== run.e) { ops.push(`/${run.e.res} 1 Tf`); curFont = run.e; }
        if (curColor !== run.color) { ops.push(rg(run.color)); curColor = run.color; }
        const px = run.a * d[0] + b * n[0], py = run.a * d[1] + b * n[1], z = s * run.scale;
        ops.push(`${fmt(d[0] * z)} ${fmt(d[1] * z)} ${fmt(u[0] * z)} ${fmt(u[1] * z)} ${fmt(px)} ${fmt(py)} Tm <${run.hex}> Tj`);
        run = null;
      };
      for (const g of t.glyphs) {
        const color = g.color || seg.color, scale = g.scale || 1;
        if (g.own !== undefined) flush();
        if (!run || run.e !== g.e || run.color !== color || run.scale !== scale) { flush(); run = { e: g.e, color, scale, a: a - (g.own || 0) * s * scale, hex: "" }; fk.ref(g.e); used.add(g.e); }
        run.hex += g.gid.toString(16).padStart(4, "0");
        a += g.adv * s * scale;
        if (g.own !== undefined) flush();
      }
      flush();
    });
    if (lineEnds) lineEnds.push([a, b]);
  });
  ops.push("ET");
  return ops.join("\n");
}

function appendContent(doc, page, content, used) {
  const pobj = page.getObject();
  let res = pobj.get("Resources");
  if (res.isNull()) {
    const inherited = pobj.getInheritable("Resources");
    res = doc.newDictionary();
    if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v));
    pobj.put("Resources", res);
  }
  let fonts = res.get("Font");
  if (fonts.isNull()) { fonts = doc.newDictionary(); res.put("Font", fonts); }
  for (const e of used) fonts.put(e.res, e.ref);
  const inv = M.Matrix.invert(page.getTransform());
  const contents = pobj.get("Contents");
  const arr = doc.newArray();
  arr.push(doc.addStream("q\n", {}));
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) arr.push(contents.get(i));
  else if (!contents.isNull()) arr.push(contents);
  arr.push(doc.addStream("\nQ\n", {}));
  arr.push(doc.addStream(`q ${inv.map(fmt).join(" ")} cm\n${content}\nQ\n`, {}));
  pobj.put("Contents", arr);
}

const overlaps = (a, b, pad = 1) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;

/**
 * As few redaction rectangles as possible. MuPDF tests every character against every
 * redaction, so one rectangle per text run is slow on big pages. Segments being replaced are
 * merged into larger rectangles as long as no text we keep (untranslated segments, skewed
 * text) would be touched; otherwise the thin per-run bands are used.
 */
function redactionRects(todo, keep) {
  const rects = [], cores = [];
  for (const seg of todo) {
    let core = null;
    for (const r of seg.redact) core = union(core, r);
    if (!core) continue;
    if (keep.some((k) => overlaps(core, k))) rects.push(...seg.redact);
    else cores.push(core);
  }
  cores.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  let cur = null;
  for (const c of cores) {
    if (!cur) { cur = c.slice(); continue; }
    const u = union(cur, c);
    if (keep.some((k) => overlaps(u, k))) { rects.push(cur); cur = c.slice(); } else cur = u;
  }
  if (cur) rects.push(cur);
  return rects;
}

/**
 * The end of a translated lead-in just before `seg` on its first baseline ("Grammatik:" before
 * "Das Adverb …"), plus the original gap, when the translation reaches past seg's first line start.
 */
function leadInEnd(seg, laid) {
  const d = DIRS[seg.rotation], n = [-d[1], d[0]];
  const start = seg.rows ? seg.rows[0][0] : seg.origin[0] * d[0] + seg.origin[1] * d[1];
  const base = seg.origin[0] * n[0] + seg.origin[1] * n[1];
  let end = null;
  for (const l of laid) {
    if (l.rot !== seg.rotation || Math.abs(l.base - base) > 0.3 * seg.size) continue;
    // A lead-in is followed by a word space; a wider gap is a column (table cells, label/value).
    if (l.right > start + 0.3 * seg.size || l.right < start - 1.2 * seg.size) continue;
    const e = l.end + Math.max(0.25 * seg.size, start - l.right);
    if (e > start + 0.01 && (end === null || e > end)) end = e;
  }
  return end;
}

/** Replace the translated segments of one page (`index` in `doc`; `segs` are all its segments). */
function translatePage(doc, index, fk, segs, translations, pageInfo, opts, stats) {
  const todo = [], keep = [...((pageInfo && pageInfo.protect) || [])];
  for (const s of segs) {
    if ((translations[s.id] || "").trim()) todo.push(s);
    else keep.push(s.bbox);
  }
  stats.untranslated += segs.length - todo.length;
  if (!todo.length) return;
  const page = doc.loadPage(index);
  const bounds = page.getBounds();
  let obs = null;
  if (opts.expand) obs = obstaclesFor((pageInfo && pageInfo.graphics) || pageGraphics(page), segs);
  for (const r of redactionRects(todo, keep)) page.createAnnotation("Redact").setRect(r);
  page.applyRedactions(false, 0, 0, 0); // keep images, keep line art, remove text
  const used = new Set();
  const laid = []; // where the lines of translations laid out so far end, for lead-ins
  const content = todo.map((seg) => {
    const ends = [];
    const ops = layoutSegment(seg, translations[seg.id], fk, bounds, obs, opts, used, stats, leadInEnd(seg, laid), ends);
    const right = localBox(seg.bbox, seg.rotation)[2];
    for (const [a, b] of ends) laid.push({ rot: seg.rotation, end: a, base: b, right });
    return ops;
  }).join("\n");
  appendContent(doc, page, content, used);
  stats.replaced += todo.length;
  free(page);
}

/**
 * Re-translate a single page of an edited output document: the page is copied fresh from the
 * original, translated with the given translations, and swapped into `out`.
 */
function updatePage(out, src, pno, segs, translations, pageInfo, opts) {
  const tmp = new M.PDFDocument();
  try {
    tmp.graftPage(0, src, pno);
    const fk = new FontKit(tmp, opts);
    const stats = { replaced: 0, untranslated: 0, shrunk: [], missing: 0 };
    translatePage(tmp, 0, fk, segs, translations, pageInfo, opts, stats);
    stats.missing = fk.missing;
    stats.missingChars = [...fk.missingChars].join("");
    tmp.subsetFonts();
    out.deletePage(pno);
    out.graftPage(pno, tmp, 0);
    return stats;
  } finally {
    free(tmp);
  }
}

/**
 * Build the translated PDF. Only segments with a translation are touched: their glyphs are
 * removed with text-only redactions (images and vector art stay) and the translation is
 * typeset into the same box with the original size, colour, style, alignment and rotation.
 * `pages` is the page info from extraction (protected text and vector graphics per page).
 */
async function buildTranslated(bytes, segments, translations, pages, opts, onProgress) {
  const doc = M.Document.openDocument(bytes, "application/pdf");
  const fk = new FontKit(doc, opts);
  const stats = { replaced: 0, untranslated: 0, shrunk: [], missing: 0 };
  const byPage = new Map();
  for (const s of segments) {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page).push(s);
  }
  let done = 0;
  for (const [pno, segs] of byPage) {
    translatePage(doc, pno, fk, segs, translations, pages[pno], opts, stats);
    done++;
    if (onProgress) onProgress(done, byPage.size);
    if (done % 4 === 0) await tick();
  }
  stats.missing = fk.missing;
  stats.missingChars = [...fk.missingChars].join("");
  doc.subsetFonts();
  const buf = doc.saveToBuffer("garbage,compress");
  const out = buf.asUint8Array().slice();
  free(buf);
  free(doc);
  return { bytes: out, stats };
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * Write the user's markups into the document as standard PDF annotations, so they stay
 * editable in other PDF programs. Coordinates are in page space (as used for segments).
 */
function addMarkups(doc, markups) {
  const pages = new Map();
  let fk = null; // fonts for text notes, created when the first one is drawn
  for (const m of markups) {
    let page = pages.get(m.page);
    if (!page) { page = doc.loadPage(m.page); pages.set(m.page, page); }
    const rgb = hexRgb(m.color || "#e53935");
    const box = [Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.x0, m.x1), Math.max(m.y0, m.y1)];
    let a = null;
    if (m.type === "rect" || m.type === "ellipse") {
      a = page.createAnnotation(m.type === "rect" ? "Square" : "Circle");
      a.setRect(box); a.setColor(rgb); a.setBorderWidth(m.width);
    } else if (m.type === "whiteout") {
      a = page.createAnnotation("Square");
      a.setRect(box); a.setColor([1, 1, 1]); a.setInteriorColor([1, 1, 1]); a.setBorderWidth(0);
    } else if (m.type === "highlight") {
      a = page.createAnnotation("Highlight");
      a.setQuadPoints([[box[0], box[1], box[2], box[1], box[0], box[3], box[2], box[3]]]);
      a.setColor(rgb);
    } else if (m.type === "ink") {
      a = page.createAnnotation("Ink");
      a.setInkList([m.points.map((p) => [p[0], p[1]])]); a.setColor(rgb); a.setBorderWidth(m.width);
    } else if (m.type === "arrow") {
      a = page.createAnnotation("Line");
      a.setLine([m.x0, m.y0], [m.x1, m.y1]); a.setLineEndingStyles("None", "OpenArrow");
      a.setColor(rgb); a.setBorderWidth(m.width);
    } else if (m.type === "text") {
      a = page.createAnnotation("FreeText");
      a.setRect([m.x0, m.y0, m.x0 + m.w, m.y0 + m.h]); a.setContents(m.text);
      a.setDefaultAppearance("Helv", m.size, rgb); a.setBorderWidth(0);
      a.setAuthor("PDF Translate");
      a.update();
      // MuPDF's own appearance uses plain Helvetica, which lacks signs such as ≥ or ✓; draw it
      // with the same font fallback as the translations instead. The text stays editable.
      fk = fk || new FontKit(doc, { fontMode: "auto" });
      const { ops, res } = textAppearance(doc, fk, m, rgb);
      a.setAppearance(null, null, M.Matrix.identity, [0, 0, m.w, m.h], res, ops);
      free(a);
      continue;
    }
    if (a) { a.setAuthor("PDF Translate"); a.update(); free(a); }
  }
  for (const p of pages.values()) free(p);
}

/** Appearance stream (operators + resources) for a text note, in its own box coordinates. */
function textAppearance(doc, fk, m, rgb) {
  const chain = fk.chain({ family: "sans-serif", bold: false, italic: false }, m.text);
  const used = new Set();
  const ops = [`BT ${rgb.map(fmt).join(" ")} rg`];
  let cur = null;
  m.text.split("\n").forEach((line, i) => {
    let x = 2;
    const y = m.h - 2 - m.size * 0.88 - i * m.size * 1.2;
    for (const ch of line) {
      const g = fk.glyph(chain, ch.codePointAt(0));
      fk.ref(g.e);
      used.add(g.e);
      if (cur !== g.e) { ops.push(`/${g.e.res} 1 Tf`); cur = g.e; }
      ops.push(`${fmt(m.size)} 0 0 ${fmt(m.size)} ${fmt(x)} ${fmt(y)} Tm <${g.gid.toString(16).padStart(4, "0")}> Tj`);
      x += g.adv * m.size;
    }
  });
  ops.push("ET");
  const res = doc.newDictionary(), fonts = doc.newDictionary();
  for (const e of used) fonts.put(e.res, e.ref);
  res.put("Font", fonts);
  return { ops: ops.join("\n"), res };
}

/** Render a page to PNG bytes (a copy, safe to transfer). */
function renderPNG(doc, index, zoom) {
  const page = doc.loadPage(index);
  const pix = page.toPixmap(M.Matrix.scale(zoom, zoom), M.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG().slice();
  free(pix);
  free(page);
  return png;
}

const Engine = {
  init: initEngine, extract: extractDocument, extractPages, build: buildTranslated, renderPNG,
  detectKind, openBook, saveBook, extractBook, openLaidOut, mapTranslated,
  open: (bytes) => M.Document.openDocument(bytes, "application/pdf"),
  exportTxt, exportCsv, exportJson, exportXliff, exportDocx, parseImport, parseMarkedText,
};

// ---------------------------------------------------------- worker protocol
/**
 * Request handler shared by the Web Worker and the in-page fallback. It keeps an open copy of
 * the original PDF (for extraction and rendering) and of the latest translated PDF (preview).
 */
function createHandler() {
  // edit: the translated document (an editable PDF, or the laid-out translated e-book)
  const W = { doc: null, bytes: null, edit: null, kind: "pdf", book: null, outBytes: null };
  return async function handle(cmd, args = {}, progress = () => {}) {
    if (cmd === "init") {
      await initEngine();
      return { result: true };
    }
    if (cmd === "open") {
      free(W.doc); free(W.edit); W.edit = null;
      W.bytes = args.bytes;
      W.kind = args.kind || "pdf";
      W.book = null; W.outBytes = null;
      if (W.kind !== "pdf") {
        if (W.kind === "fb2") W.bytes = await unzipFb2(args.bytes); // .fb2.zip / .fbz
        W.doc = openLaidOut(W.bytes.slice(), W.kind);
        return { result: W.doc.countPages() };
      }
      W.doc = M.Document.openDocument(args.bytes.slice(), "application/pdf");
      if (W.doc.needsPassword && W.doc.needsPassword()) throw new Error("Password-protected PDFs are not supported.");
      return { result: W.doc.countPages() };
    }
    if (cmd === "extract") return { result: await extractPages(W.doc, args.pages, progress) };
    if (cmd === "extractBook") {
      const { book, pages, segments } = await extractBook(W.bytes, W.kind, W.doc);
      W.book = book;
      return { result: { pages, segments } };
    }
    if (cmd === "render") {
      const doc = args.variant === "translated" ? W.edit : W.doc;
      if (!doc) throw new Error("No document is open.");
      const png = renderPNG(doc, args.page, args.zoom);
      return { result: png.buffer, transfer: [png.buffer] };
    }
    if (cmd === "build" && W.kind !== "pdf") {
      // E-book: write the translations into the book's files, then lay it out for the preview.
      if (!W.book) W.book = (await openBook(W.bytes, W.kind)).book;
      const result = await saveBook(W.book, W.bytes, args.segments, args.translations, args.opts || {});
      W.outBytes = result.bytes.slice();
      free(W.edit);
      W.edit = openLaidOut(result.bytes.slice(), W.kind);
      result.view = mapTranslated(W.edit, args.segments, args.translations);
      return { result, transfer: [result.bytes.buffer] };
    }
    if (cmd === "build") {
      const result = await buildTranslated(W.bytes.slice(), args.segments, args.translations, args.pages, args.opts, progress);
      free(W.edit);
      W.edit = M.Document.openDocument(result.bytes.slice(), "application/pdf");
      return { result, transfer: [result.bytes.buffer] };
    }
    if (cmd === "updatePage") {
      if (!W.edit) W.edit = M.Document.openDocument(W.bytes.slice(), "application/pdf");
      return { result: updatePage(W.edit, W.doc, args.page, args.segments, args.translations, args.pageInfo, args.opts) };
    }
    if (cmd === "save" && W.kind !== "pdf") {
      if (!W.outBytes) throw new Error("Nothing to save yet.");
      const bytes = W.outBytes.slice();
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "save") {
      // The translated PDF (or the original if nothing was translated) plus markups. Markups
      // go into a copy, so the editable document never accumulates them.
      const markups = args.markups || [];
      if (!W.edit && !markups.length) throw new Error("Nothing to save yet.");
      let doc = W.edit, temp = null;
      if (markups.length) {
        let src = W.bytes;
        if (W.edit) { const b = W.edit.saveToBuffer(""); src = b.asUint8Array().slice(); free(b); }
        temp = doc = M.Document.openDocument(src.slice(), "application/pdf");
        addMarkups(doc, markups);
        if (markups.some((m) => m.type === "text")) doc.subsetFonts();
      }
      const buf = doc.saveToBuffer("garbage,compress");
      const bytes = buf.asUint8Array().slice();
      free(buf);
      free(temp);
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "resetOutput") {
      free(W.edit);
      W.edit = null; W.outBytes = null;
      return { result: true };
    }
    if (cmd === "close") {
      free(W.doc); free(W.edit);
      W.doc = W.edit = W.bytes = W.book = W.outBytes = null;
      return { result: true };
    }
    throw new Error(`Unknown command ${cmd}`);
  };
}

// Inside a Web Worker: serve {id, cmd, args} -> {id, result} | {id, error} | {id, progress}.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const handle = createHandler();
  self.onmessage = async (e) => {
    const { id, cmd, args } = e.data;
    try {
      const { result, transfer } = await handle(cmd, args, (done, total) => self.postMessage({ id, progress: [done, total] }));
      self.postMessage({ id, result }, transfer || []);
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
  };
}
