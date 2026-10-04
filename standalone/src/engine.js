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

async function initEngine(module, url = null) {
  if (!M) M = module || await import(url || MUPDF_URL); // (url: a stored copy of the library, see offline.js)
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

/**
 * Bold and italic from the style bits inside embedded TrueType/OpenType fonts (head.macStyle,
 * OS/2 weight and fsSelection), by font name. Some producers name the bold cut just like the
 * regular one ("TimesNewRoman" twice) and set no flags; only the font file itself tells them apart.
 */
const fontStyleHints = new Map();
const fontStyleSeen = new Set();

function sfntStyle(data) {
  if (!data || data.length < 12) return null;
  const u16 = (o) => (data[o] << 8) | data[o + 1];
  const u32 = (o) => ((data[o] << 24) >>> 0) + (data[o + 1] << 16) + (data[o + 2] << 8) + data[o + 3];
  const count = u16(4);
  let bold = false, italic = false, found = false;
  for (let k = 0; k < count && 12 + 16 * k + 16 <= data.length; k++) {
    const rec = 12 + 16 * k, tag = String.fromCharCode(data[rec], data[rec + 1], data[rec + 2], data[rec + 3]);
    const at = u32(rec + 8);
    if (tag === "head" && at + 46 <= data.length) {
      const mac = u16(at + 44);
      bold = bold || (mac & 1) !== 0; italic = italic || (mac & 2) !== 0; found = true;
    } else if (tag === "OS/2" && at + 64 <= data.length) {
      const weight = u16(at + 4), sel = u16(at + 62);
      bold = bold || weight >= 600 || (sel & 0x20) !== 0; italic = italic || (sel & 1) !== 0; found = true;
    }
  }
  return found ? { bold, italic } : null;
}

/** Reads the style hints of the fonts a page uses (its own and those of its forms). */
function collectFontStyles(pobj) {
  const visit = (res, depth) => {
    if (depth > 4 || !res || res.isNull()) return;
    const fonts = res.get("Font");
    if (fonts.isDictionary()) fonts.forEach((f) => {
      const key = f.isIndirect() ? f.asIndirect() : null;
      if (key !== null) { if (fontStyleSeen.has(key)) return; fontStyleSeen.add(key); }
      let desc = f.get("FontDescriptor");
      const kids = f.get("DescendantFonts");
      if (desc.isNull() && kids.isArray() && kids.length) desc = kids.get(0).get("FontDescriptor");
      if (desc.isNull()) return;
      let file = desc.get("FontFile2");
      if (!file.isStream()) {
        file = desc.get("FontFile3");
        if (!file.isStream() || file.get("Subtype").toString() !== "/OpenType") return;
      }
      let style = null;
      try { const b = file.readStream(); style = sfntStyle(b.asUint8Array()); free(b); } catch (_) { /* damaged font file */ }
      if (!style) return;
      for (const name of [f.get("BaseFont"), desc.get("FontName")]) if (name.isName()) fontStyleHints.set(name.asName(), style);
    });
    const xo = res.get("XObject");
    if (xo.isDictionary()) xo.forEach((v) => {
      if (!v.isStream() || v.get("Subtype").toString() !== "/Form") return;
      const key = v.isIndirect() ? v.asIndirect() : null;
      if (key !== null) { if (fontStyleSeen.has(`x${key}`)) return; fontStyleSeen.add(`x${key}`); }
      visit(v.get("Resources"), depth + 1);
    });
  };
  try { visit(pobj.getInheritable("Resources"), 0); } catch (_) { /* hints are optional */ }
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
    // A style word after "-" or "," is taken at its word; a plain name ("TimesNewRoman") lets the
    // embedded font file speak.
    const hint = style !== low && named ? null : fontStyleHints.get(raw);
    info = {
      name,
      bold: nameBold || (hint ? hint.bold : !named && font.isBold()),
      italic: nameItalic || (hint ? hint.italic : !named && font.isItalic()),
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

/**
 * Does the page's content use /ActualText (replacement text in marked content)? Some PDF writers
 * put a whole paragraph's text there: MuPDF then reports the paragraph as one line with wrong
 * boxes, which breaks the layout of the translation.
 */
function usesActualText(page) {
  try {
    const obj = page.getObject();
    const seen = new Set();
    const streamHas = (s) => { try { return s && s.isStream() && s.readStream().asString().includes("ActualText"); } catch (_) { return false; } };
    const resHas = (res, depth) => {
      if (!res || !res.isDictionary() || depth > 2) return false;
      let found = false;
      const props = res.get("Properties");
      if (props.isDictionary()) props.forEach((v) => { if (!found && v.isDictionary() && !v.get("ActualText").isNull()) found = true; });
      const xo = res.get("XObject");
      if (!found && xo.isDictionary()) {
        xo.forEach((v) => {
          if (found || seen.has(v.toString())) return;
          seen.add(v.toString());
          if (v.isStream() && v.get("Subtype").toString() === "/Form" && (streamHas(v) || resHas(v.get("Resources"), depth + 1))) found = true;
        });
      }
      return found;
    };
    const contents = obj.get("Contents");
    if (contents.isArray()) { for (let i = 0; i < contents.length; i++) if (streamHas(contents.get(i))) return true; } else if (streamHas(contents)) return true;
    return resHas(obj.getInheritable("Resources"), 0);
  } catch (_) {
    return false;
  }
}

const unknownChars = (blocks) => {
  let n = 0;
  for (const b of blocks) for (const l of b.lines) for (const sp of l.spans) n += (sp.text.match(/\ufffd/g) || []).length;
  return n;
};

/**
 * Text blocks of a page. On pages with /ActualText the replacement text is ignored (the glyphs as
 * drawn are read), unless that loses characters that only the replacement text provides.
 */
function pageBlocks(page, bounds, seps) {
  const blocks = readBlocks(page, bounds, seps, "preserve-whitespace");
  if (!usesActualText(page)) return blocks;
  const drawn = readBlocks(page, bounds, seps, "preserve-whitespace,ignore-actualtext");
  return unknownChars(drawn) <= unknownChars(blocks) ? drawn : blocks;
}

// Ligature glyphs without a Unicode mapping arrive as U+FFFD ("Ac\ufffdvity" in PDFs printed with
// Calibri and similar fonts). Inside a word such a glyph is replaced by the letter pair whose
// combined advance (from the font itself where the subset has the letters) comes closest to the
// drawn width. Symbol fonts and lone glyphs are left alone.
const LIGATURE_FIXES = ["ti", "fi", "fl", "ff", "tt", "ffi", "ffl", "st", "Th"];
const GENERIC_ADV = { t: 0.33, i: 0.25, f: 0.3, l: 0.25, s: 0.38, T: 0.55, h: 0.55 };
function ligatureGuess(font, info, w) {
  if (!(w > 0.4) || /symbol|wingding|dingbat|webding/i.test(info.name)) return null;
  if (!info.adv) info.adv = new Map();
  const adv = (ch) => {
    if (!info.adv.has(ch)) {
      let a = null;
      try { const g = font.encodeCharacter(ch.codePointAt(0)); a = g > 0 ? font.advanceGlyph(g, 0) : null; } catch (_) { a = null; }
      info.adv.set(ch, a);
    }
    return info.adv.get(ch);
  };
  let best = null;
  for (const lig of LIGATURE_FIXES) {
    let sum = 0, generic = false;
    for (const ch of lig) { const a = adv(ch); if (a == null) { generic = true; sum += GENERIC_ADV[ch]; } else sum += a; }
    // Estimated widths count for less; "ti" is by far the most frequent of these pairs.
    const d = Math.abs(sum - w) / w + (generic ? 0.03 : 0) - (lig === "ti" ? 0.03 : 0);
    if (d < 0.12 && (!best || d < best.d)) best = { lig, d };
  }
  return best && best.lig;
}
const LETTER = /\p{L}/u;
function applyLigatureFixes(span) {
  for (let i = span.fixes.length - 1; i >= 0; i--) {
    const { at, lig } = span.fixes[i], prev = span.text[at - 1], next = span.text[at + 1];
    const edge = (ch) => ch === undefined || ch === " " || LETTER.test(ch);
    if ((LETTER.test(prev || "") || LETTER.test(next || "")) && edge(prev) && edge(next)) span.text = span.text.slice(0, at) + lig + span.text.slice(at + 1);
  }
  delete span.fixes;
}

function readBlocks(page, bounds, seps, options) {
  // Font pointers are only unique while this structured-text page keeps its fonts alive;
  // MuPDF reuses the addresses later, so the pointer cache must not outlive the page.
  fontPtrCache.clear();
  const st = page.toStructuredText(options);
  const blocks = [];
  let block = null, line = null, span = null, lastInk = null, sawSpace = false;
  let idx = -1; // every glyph of the page in order, so that a second pass can be aligned with this one
  const unknown = []; // glyphs without a Unicode value: {span, at, idx, lig}
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
      idx++;
      if (!line) { free(font); return; }
      const qb = [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]),
        Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
      if (qb[2] < bounds[0] || qb[0] > bounds[2] || qb[3] < bounds[1] || qb[1] > bounds[3]) return; // off-page
      const info = fontInfo(font);
      // A Symbol font with its own encoding gives private-use codes: the characters they stand for (α, ⊥, ≤ …)
      if (c.length === 1) { const cp = c.charCodeAt(0); if (cp >= 0xf020 && cp <= 0xf0ff && /symbol/i.test(info.name)) c = symbolChar(cp) || c; }
      const blank = c === " " || !c.trim();
      const lig = c === "\ufffd" && Math.abs(line.dir[0]) > 0.99 ? ligatureGuess(font, info, (qb[2] - qb[0]) / size) : null;
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
      if (lig) (span.fixes = span.fixes || []).push({ at: span.text.length, lig });
      if (c === "\ufffd") unknown.push({ span, line, at: span.text.length, idx, lig, qb, origin: [origin[0], origin[1]], size, symbolFont: /symbol/i.test(info.name) });
      span.text += c;
      if (blank) { sawSpace = true; return; }
      span.bbox = union(span.bbox, qb);
      if (span.text.trim().length === 1) span.origin = [origin[0], origin[1]];
      lastInk = qb; sawSpace = false;
    },
  });
  free(st);
  if (unknown.length) recoverUnknownChars(page, options, unknown, idx + 1);
  for (const b of blocks) for (const l of b.lines) {
    l.spans = l.spans.filter((sp) => sp.bbox);
    for (const sp of l.spans) if (sp.fixes) applyLigatureFixes(sp);
  }
  return blocks;
}

/* ---- unknown glyphs recognised by their drawn shape
 * A glyph that MuPDF cannot name is compared, as drawn on the page, with reference glyphs of
 * the characters such fonts usually hold (Greek letters, the degree sign, primes, operators),
 * rendered from the built-in Symbol font upright and slanted. The shape (a coarse coverage
 * grid), its height, its position above the baseline and its proportions decide.
 */
const GLYPH_SET = [..."αβγδεζηθικλμνξπρστυφχψωϕϑΓΔΘΛΞΠΣΦΨΩ°′″≤≥≠≈±×÷∞→←↔∑∫∂√∝∅∈∩∪∧∨¬∇⋅+−=()[]{}|/⎛⎜⎝⎞⎟⎠"];
const GRID = 12;
let glyphTemplates = null;

/** Coverage grid and metrics of the ink in a grey pixmap: {cov, height, bottomAbove, aspect} or null. */
function inkFeatures(px, w, h, baselineY, em, margin = 0, centre = null) {
  // Columns with ink; of several ink runs (a neighbour's edge inside the box) the one at the centre counts.
  const cols = new Uint8Array(w);
  for (let y = 0; y < h; y++) { const row = y * w; for (let x = margin; x < w - margin; x++) if (px[row + x] < 128) cols[x] = 1; }
  const runs = [];
  for (let x = 0; x < w; x++) { if (!cols[x]) continue; let e = x; while (e + 1 < w && (cols[e + 1] || (e + 2 < w && cols[e + 2]))) e++; runs.push([x, e]); x = e; }
  if (!runs.length) return null;
  const cx = centre === null ? w / 2 : centre;
  const run = runs.reduce((a, b) => (Math.abs((b[0] + b[1]) / 2 - cx) < Math.abs((a[0] + a[1]) / 2 - cx) ? b : a));
  const [left, right] = run;
  let top = -1, bottom = -1;
  for (let y = 0; y < h; y++) { const row = y * w; for (let x = left; x <= right; x++) if (px[row + x] < 128) { if (top < 0) top = y; bottom = y; break; } }
  if (top < 0) return null;
  const bw = right - left + 1, bh = bottom - top + 1;
  const cov = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const x0 = left + Math.floor(gx * bw / GRID), x1 = Math.max(x0 + 1, left + Math.floor((gx + 1) * bw / GRID));
    const y0 = top + Math.floor(gy * bh / GRID), y1 = Math.max(y0 + 1, top + Math.floor((gy + 1) * bh / GRID));
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += 255 - px[y * w + x]; n++; }
    cov[gy * GRID + gx] = sum / n / 255;
  }
  return { cov, height: bh / em, bottomAbove: (baselineY - (bottom + 1)) / em, aspect: bw / bh };
}

function buildGlyphTemplates() {
  const out = [];
  let font = null;
  try {
    font = new M.Font("Symbol");
    const Sz = 40, W = 160, H = 160, X = 32, Y = 96;
    for (const ch of GLYPH_SET) {
      const cp = ch.codePointAt(0), gid = font.encodeCharacter(cp);
      if (!(gid > 0)) continue;
      // Brackets and bars also stretched, as the tall delimiters of displayed formulas are.
      const variants = [[0, 1], [0.22, 1]];
      if ("()|".includes(ch)) variants.push([0, 1.4], [0, 1.8], [0, 2.3]); // (tall braces are rare and look like parentheses when coarse)
      for (const [shear, stretch] of variants) {
        let text = null, pix = null, dev = null;
        try {
          text = new M.Text();
          text.showGlyph(font, [Sz, 0, shear * Sz, -Sz * stretch, X, Y + Sz * 0.25 * (stretch - 1)], gid, cp, 0); // (y flipped: the pixmap's y grows downwards)
          pix = new M.Pixmap(M.ColorSpace.DeviceGray, [0, 0, W, H], false);
          pix.clear(255);
          dev = new M.DrawDevice(M.Matrix.identity, pix);
          dev.fillText(text, M.Matrix.identity, M.ColorSpace.DeviceGray, [0], 1);
          dev.close();
          const f = inkFeatures(pix.getPixels(), W, H, Y, Sz);
          if (f) out.push({ ch, ...f });
        } finally { if (dev) free(dev); if (pix) free(pix); if (text) free(text); }
      }
    }
  } catch (err) {
    console.warn("glyph templates unavailable", err);
  } finally { if (font) free(font); }
  return out;
}

const glyphDistance = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.cov.length; i++) d += Math.abs(a.cov[i] - b.cov[i]);
  return d / a.cov.length + 0.6 * Math.abs(a.height - b.height) + 0.8 * Math.abs(a.bottomAbove - b.bottomAbove) + 0.3 * Math.abs(Math.log(a.aspect / b.aspect));
};

/**
 * The ink of one glyph of the page, as features. The glyph is drawn alone: the page's text
 * objects are filtered down to the glyph at this origin without a Unicode value, and drawn in
 * black into a small pixmap around its box, so neighbours and colours do not interfere.
 */
function glyphInk(page, u) {
  const scale = 8, em = u.size * scale;
  const mx = 0.35 * u.size, my = 0.35 * u.size;
  const x0 = Math.floor((u.qb[0] - mx) * scale), y0 = Math.floor((u.qb[1] - my) * scale), x1 = Math.ceil((u.qb[2] + mx) * scale), y1 = Math.ceil((u.qb[3] + my) * scale);
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2 || w * h > 4e6) return null;
  let pix = null, draw = null, dev = null;
  try {
    pix = new M.Pixmap(M.ColorSpace.DeviceGray, [x0, y0, x1, y1], false);
    pix.clear(255);
    draw = new M.DrawDevice(M.Matrix.identity, pix);
    const toDevice = M.Matrix.scale(scale, scale);
    let found = 0;
    const drawOnly = (text, ctm) => {
      const picked = new M.Text();
      let any = false;
      try {
        text.walk({
          showGlyph(font, trm, gid, uni, wmode) {
            const x = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4], y = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
            if (Math.abs(x - u.origin[0]) < 0.6 && Math.abs(y - u.origin[1]) < 0.6) { picked.showGlyph(font, trm, gid, uni, wmode); any = true; found++; }
          },
        });
        if (any) draw.fillText(picked, M.Matrix.concat(ctm, toDevice), M.ColorSpace.DeviceGray, [0], 1);
      } finally { free(picked); }
    };
    dev = new M.Device({
      fillText(text, ctm) { drawOnly(text, ctm); },
      strokeText(text, stroke, ctm) { drawOnly(text, ctm); },
      clipText(text, ctm) { drawOnly(text, ctm); },
    });
    page.run(dev, M.Matrix.identity);
    try { dev.close(); } catch (_) { /* not needed */ }
    draw.close();
    if (!found) { // the glyph was not reachable alone (drawn in another way): its box, neighbours included
      free(draw); draw = null;
      pix.clear(255);
      draw = new M.DrawDevice(M.Matrix.identity, pix);
      page.run(draw, toDevice);
      draw.close();
    }
    return inkFeatures(pix.getPixels(), w, h, u.origin[1] * scale - y0, em, 0, ((u.qb[0] + u.qb[2]) / 2) * scale - x0);
  } catch (_) {
    return null;
  } finally {
    if (dev) free(dev);
    if (draw) free(draw);
    if (pix) free(pix);
  }
}

/** The character an unknown glyph most likely is, by its shape; `prior` (from the Symbol encoding) wins a close call. */
function recogniseGlyph(page, u, prior, maxDistance = 0.5, why = {}) {
  if (!glyphTemplates) glyphTemplates = buildGlyphTemplates();
  if (!glyphTemplates.length) { why.note = "no templates"; return null; }
  const f = glyphInk(page, u);
  if (!f) { why.note = "no ink"; return null; }
  why.h = +f.height.toFixed(2); why.above = +f.bottomAbove.toFixed(2);
  let best = null, second = null, priorD = Infinity;
  for (const tpl of glyphTemplates) {
    const d = glyphDistance(f, tpl);
    if (tpl.ch === prior) priorD = Math.min(priorD, d);
    if (!best || d < best.d) { if (best && best.ch !== tpl.ch) second = best; best = { ch: tpl.ch, d }; }
    else if (tpl.ch !== best.ch && (!second || d < second.d)) second = { ch: tpl.ch, d };
  }
  if (best) { why.best = best.ch; why.d = +best.d.toFixed(2); }
  if (!best || best.d > maxDistance) return null;
  if (prior && priorD <= best.d + 0.08) return prior;
  return best.ch;
}

/**
 * Glyphs without a Unicode value (U+FFFD) come from fonts without a ToUnicode table and with
 * glyph names MuPDF does not know – mostly symbol and maths fonts (Ω, ≤, Δ in a text line). A
 * second extraction pass asks MuPDF for the raw character codes of such glyphs; read through
 * the Symbol encoding they give the characters meant. A glyph that the ligature guess already
 * explains (fi, fl … in a text font) is left to that guess.
 */
function recoverUnknownChars(page, options, unknown, total) {
  let st2 = null;
  try {
    st2 = page.toStructuredText(`${options},use-cid-for-unknown-unicode`);
    // The passes are aligned by glyph position (rounded to a quarter point); by order when
    // the position is not found and both passes hold the same number of glyphs.
    const posKey = (o) => `${Math.round(o[0] * 4)}|${Math.round(o[1] * 4)}`;
    const byPos = new Map(), byIdx = [];
    st2.walk({ onChar(c, origin, font) { free(font); const code = c.codePointAt(0); byIdx.push(code); if (c !== "\ufffd") byPos.set(posKey(origin), code); } });
    for (const u of unknown) {
      const code = byPos.get(posKey(u.origin));
      if (code !== undefined) u.code = code;
      else if (byIdx.length === total && byIdx[u.idx] !== undefined && byIdx[u.idx] !== 0xfffd) u.code = byIdx[u.idx];
    }
    const diag = { unknown: unknown.length, recovered: 0, samples: [] };
    const bySpan = new Map();
    for (const u of unknown) { if (!bySpan.has(u.span)) bySpan.set(u.span, []); bySpan.get(u.span).push(u); }
    for (const [span, list] of bySpan) {
      for (const u of list.sort((a, b) => b.at - a.at)) {
        if (u.code === undefined) { if (diag.samples.length < 4) diag.samples.push({ font: span.font.name, code: null, note: "no code" }); continue; }
        const spans = u.line.spans, k = spans.indexOf(span);
        const before = spans.slice(0, k).map((sp) => sp.text).join("") + span.text.slice(0, u.at);
        const after = span.text.slice(u.at + 1) + spans.slice(k + 1).map((sp) => sp.text).join("");
        // A glyph the ligature guess explains, sitting between letters of a word ("Ac?vity"), is a
        // ligature unless its shape is unmistakably one of the symbols.
        const inWord = u.lig && LETTER.test(before.slice(-1)) && LETTER.test(after.charAt(0));
        const prior = symbolChar(u.code); // what the code means in the Symbol encoding
        // Every font is read by the drawn shape: subset fonts are re-encoded by many PDF
        // producers, so even a font called "Symbol" need not follow the Symbol encoding. The
        // encoding is the tiebreaker, and for a Symbol font the fallback when the shape says nothing.
        const why = {};
        let mapped = recogniseGlyph(page, u, prior && prior.length === 1 ? prior : null, inWord ? 0.2 : 0.5, why);
        if (!mapped && u.symbolFont && prior && prior.length === 1 && why.note !== "no ink" && !/[♣♦♥♠ℵℑℜ℘⌠⌡⎮€]/.test(prior)) mapped = prior;
        if (!mapped || mapped.length !== 1 || mapped === "\ufffd") { if (diag.samples.length < 4) diag.samples.push({ font: span.font.name, code: u.code, ...why }); continue; }
        diag.recovered++;
        if (mapped === "′" || mapped === "°") { // a small raised ring or stroke: degree before C/F/K or after a number, prime otherwise
          const prev = before.trimEnd().slice(-1), next = after.trimStart().charAt(0);
          mapped = /[CFK]/.test(next) || /\d/.test(prev) ? "°" : "′";
        }
        span.text = span.text.slice(0, u.at) + mapped + span.text.slice(u.at + 1);
        if (u.lig && span.fixes) span.fixes = span.fixes.filter((f) => f.at !== u.at); // (recognised: no ligature guess for it)
      }
    }
    if (diag.recovered < diag.unknown) console.warn("unknown glyphs", JSON.stringify(diag)); // (what stayed unknown and why, for bug reports)
  } catch (err) { console.warn("unknown glyphs: recovery failed", err); } finally {
    if (st2) free(st2);
  }
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
  // Table-of-contents entries: a line ending in leader dots and a page number is complete, and
  // two lines that both start with a section number ("2.1.3 …", "2.1.3.1 …") are two entries.
  if (LEADER_RE.test(pt)) return false; // (an entry whose title wraps joins its second line, which carries the leader)
  if (NUMBERED_RE.test(nt) && (NUMBERED_RE.test(pt) || LEADER_RE.test(nt))) return false;
  if (!/\p{L}{2}/u.test(pt) && !/\p{L}{2}/u.test(nt)) return false; // rows of numbers, dates, amounts ("4.2 M")
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
const LEADER_RE = /(?:[.·⋅…]\s?){4,}\s*\d{1,4}\s*$/; // "Safety tasks ........ 7"
const NUMBERED_RE = /^\d{1,3}(?:\.\d{1,3})+\.?\s+\S/; // "2.1.3.1 Separation"
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
  if (headingBreak(prev, line)) return false;
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
  line.style = { color: top(color, total), family: latin >= 3 ? top(family, latin) : null, bg: line.spans[0].bg || null };
  return line.style;
}

/** A heading in one colour or typeface followed by a line in another is not one paragraph. */
function styleBreak(prev, line) {
  const a = lineStyle(prev), b = lineStyle(line);
  return (a.color && b.color && a.color !== b.color) || (a.family && b.family && a.family !== b.family)
    || (a.bg && b.bg && a.bg !== b.bg); // scanned text on another background (a grey table head)
}

/**
 * A heading over its text: a line wholly in bold in a larger size than the line below
 * ("Innehållsförteckning" over the first entry of a table of contents, "5.2.1 Befintliga
 * material …" over the smaller "Kabelstegar"). A wrapped heading keeps its size.
 */
function headingBreak(prev, line) {
  const a = prev.spans.filter((s) => s.text.trim());
  return a.length > 0 && a.every((s) => s.font.bold) && prev.size > 1.08 * line.size;
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
    if (t === cur.text && !cur.ocr && !text.endsWith(" ") && !cur.text.startsWith(" ") && gapOf(prev, cur, rot) > 0.15 * Math.min(prev.size, cur.size)) text += " ";
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
  // Weighed by letters and digits; leader dots and other punctuation count little, so a bold
  // title keeps its weight against the run of dots after it.
  const w = new Map();
  for (const s of spans) {
    const k = key(s), text = s.text.trim();
    const strong = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    w.set(k, (w.get(k) || 0) + strong + 0.1 * (text.length - strong) + 0.01);
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
  // Text recognised by OCR is part of a picture: the translation is drawn on a patch of the
  // paper colour over each original line instead of removing text.
  const ocr = spans[0].ocr ? {
    ocr: true, bg: dominant(spans, (s) => s.bg),
    // (little padding at the sides, so that table borders next to the text are not painted over)
    cover: lines.map((l) => { const b = l.bbox, h = b[3] - b[1]; return [b[0] - 0.04 * h, b[1] - 0.12 * h, b[2] + 0.04 * h, b[3] + 0.12 * h].map(round2); }),
  } : null;
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
    redact: ocr ? [] : spans.filter((s) => s.text.trim()).map((s) => redactRect(s, rotation).map(round2)),
    ...(ocr || {}),
  };
}

const MATH_FONT_RE = /^(?:cm(?:mi|sy|ex|bsy|mib)\d|msam|msbm|eufm|eusm|rsfs|stmary|wasy|lmmath|latinmodern-?math|cambria-?math|stix\w*math|xits|asana|tx(?:mi|sy|ex)|px(?:mi|sy|ex)|mtmi|mtsy|mathematicalpi|mt-?extra|euler|esint|symbol)|math/i;
const MATH_SIGN_RE = /[=≈≠≤≥±∓×÷·⋅√∑∏∫∂∞∝→⇒⇔∇∆ΔͰ-Ͽ]/;
const MATH_SIGN_RE_G = /[=≈≠≤≥±∓×÷·⋅√∑∏∫∂∞∝→⇒⇔∇∆Δ^\u0370-\u03ff]|\p{L}(?=[₀-₉⁰-⁹])|(?<=[\p{L}\p{N})\]])\s*\+\s*(?=[\p{L}\p{N}(\[√∑∫])/gu;
const MATH_SIGNS_G = /[=≈≠≤≥±∓×÷·⋅√∑∏∫∂∞∝→⇒⇔∇∆Δ^Ͱ-Ͽ]|(?<=[\p{L}\p{N})\]])\s*[+−-]\s*(?=[\p{L}\p{N}(\[√∑∫])|(?<=[\p{L}\p{N})])\s*\/\s*(?=[\p{L}\p{N}(])/gu;
/** Words that occur in formulas without making them prose. */
const MATH_FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "arg", "mod", "sgn", "tr", "diag", "grad", "div", "rot"]);
const MATH_FUNC_RE = /(?<!\p{L})(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|lg|exp|lim|max|min|sup|inf|det|arg|mod|sgn|tr|diag|grad|div|rot)(?!\p{L})/u;
const MATH_FUNC_RE_G = new RegExp(MATH_FUNC_RE.source, "gu");
const SHORT_VAR_RE = /^\p{L}\s?\p{L}$/u;
const SHORT_WORDS = new Set(["ab", "am", "an", "as", "at", "be", "by", "da", "de", "do", "du", "el", "en", "er", "es", "et", "go", "he", "if", "il", "im", "in", "is", "it", "ja", "je", "la", "le", "lo", "me", "my", "no", "ob", "of", "oh", "ok", "on", "or", "os", "se", "si", "so", "te", "to", "tu", "um", "un", "up", "us", "we", "wo", "zu", "и", "в", "на", "не", "то", "но", "он", "мы", "вы", "из", "за", "по", "от", "до", "ты", "я", "о", "у", "с", "к"]);
const MATH_WORDS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min", "sup", "inf", "det", "arg", "mod", "div", "rot", "grad", "const", "dim", "ker", "rank", "sgn", "tr", "diag", "where", "with", "für", "mit", "wenn", "if", "and", "und", "or", "oder"]);

/**
 * A formula (E = m·v², I = I₀ + Σ√2·I_k·cos(kω₁t + φ_ik), fraction parts, unit expressions such
 * as kg·m²/s³): set in math fonts, or math signs, Greek letters, sub- and superscripts and
 * single-letter variables with hardly a real word among them. It stays as it is.
 */
function isFormula(text, spans) {
  let math = 0, all = 0, sizeMin = Infinity, sizeMax = 0, italicLetters = 0;
  for (const s of spans) {
    const n = s.text.replace(/\s/g, "").length;
    if (!n) continue;
    all += n;
    if (MATH_FONT_RE.test(s.font.name)) math += n;
    sizeMin = Math.min(sizeMin, s.size); sizeMax = Math.max(sizeMax, s.size);
    if (s.font.italic) italicLetters += (s.text.match(/\p{L}/gu) || []).length;
  }
  const words = (text.match(/\p{L}{3,}/gu) || []).filter((w) => !MATH_WORDS.has(w.toLowerCase()) && !/[Ͱ-Ͽ]/.test(w)).length; // tokens mixing Latin and Greek (ejωt) are never prose
  const longWords = (text.match(/\p{L}{5,}/gu) || []).filter((w) => !MATH_WORDS.has(w.toLowerCase()) && !/[Ͱ-Ͽ]/.test(w)).length;
  if (all && math >= 0.6 * all && !longWords) return true;
  const strong = (text.match(MATH_SIGN_RE_G) || []).length; // =, ≤, √, ∑, Greek …
  const ops = (text.match(MATH_SIGNS_G) || []).length; // those, and + − / between letters or digits
  const unknown = (text.match(/[�\ue000-\uf8ff]/g) || []).length; // glyphs without Unicode, or in a font's private range
  const vars = (text.match(/(?<![\p{L}\p{N}])\p{L}(?![\p{L}])/gu) || []).length; // single letters: variables
  const scripts = sizeMin < Infinity && sizeMax >= 1.25 * sizeMin; // sub- or superscripts
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (strong && !words) return true; // "E = m·v²", "k = 1", "α ≤ π"
  const funcLetters = (text.match(MATH_FUNC_RE_G) || []).join("").length; // letters of sin, ln, arctan … are no variables
  if (!words && letters - funcLetters <= 6 && (math || unknown)) return true; // a sign from a math font (Mathematical Pi, MT Extra …) or an unreadable glyph among a few letters: "u =", "L = La + Li ="
  if (!words && !/\p{N}/u.test(text) && SHORT_VAR_RE.test(text.trim()) && !SHORT_WORDS.has(text.trim().toLowerCase())) return true; // "dt", "dI", "rL": two letters that are no word
  if (!words && vars >= 2 && ops && letters <= 4) return true; // "t1 − t0", "a + b"
  if (!words && letters && /^[\p{N}\s().,;:^_]*$/u.test(text.replace(/\p{L}+/gu, "")) && MATH_FUNC_RE.test(text) && [...text.matchAll(/\p{L}+/gu)].every((m) => m[0].length === 1 || MATH_FUNCS.has(m[0]))) return true; // "ln r a", "sin x"
  if (letters === 1 && !/\p{N}/u.test(text) && text.replace(/[\s().,;:=+−-]/gu, "").length === 1) return true; // a lone symbol: Φ, L, x (not "4.2 M": a number with its unit)
  if (ops >= 2 && !words && letters >= 1 && letters <= 6) return true; // "a−b/c" (a product code with more letters is text; plain numbers are "numbers")
  if (words > 2) return false; // a sentence, even with an equation in it
  if (unknown >= 2 && words <= 1) return true; // symbol glyphs without Unicode
  if (strong >= 2 && words <= 1 && (vars >= 2 || unknown || scripts)) return true;
  if (scripts && strong && words <= 1) return true;
  if (vars >= 3 && strong && letters <= 2 * vars + 4) return true;
  return italicLetters && letters <= 2 && !words && /^[\p{L}\p{N}\s]+$/u.test(text); // a lone variable "n" set in italics
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
    try {
      const bounds = page.getBounds();
      const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
      const graphics = pageGraphics(page);
      const { seps } = graphics;
      if (page.getObject) collectFontStyles(page.getObject());
      const protect = []; // text we never extract (skewed lines) must survive merged redactions
      segments.push(...segmentPage(pageBlocks(page, bounds, seps), p, bounds, seps, protect));
      pages[p] = { width, height, x0: bounds[0], y0: bounds[1], protect: protect.map((r) => r.map(round2)), graphics };
    } finally {
      free(page);
    }
    done++;
    if (onProgress) onProgress(done, pageList.length);
    if (done % 4 === 0) await tick();
  }
  return { pages, segments };
}

/** The lines of a page as the segmenter sees them: blocks of lines, the text margins per rotation, all lines. */
function pageLineSet(rawBlocks, seps, protect) {
  {
    const rowBlocks = [];
    for (const block of rawBlocks) {
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
    return { blocks, marginsByRot, pageLines };
  }
}

/** Segments of one page from its text blocks (MuPDF's, or lines recognised by OCR). */
function segmentPage(rawBlocks, p, bounds, seps, protect) {
  const segments = [];
  {
    const { blocks, marginsByRot, pageLines } = pageLineSet(rawBlocks, seps, protect);
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
  }
  return segments;
}

/** The lines of a page for the segment editor: [{i, text, bbox, rotation}], and what re-segmenting needs. */
function pageLinesFor(doc, p) {
  const page = doc.loadPage(p);
  try {
    const bounds = page.getBounds();
    const { seps } = pageGraphics(page);
    const { marginsByRot, pageLines } = pageLineSet(pageBlocks(page, bounds, seps), seps, []);
    const lines = pageLines.map((l, i) => ({ i, text: l.text, bbox: l.bbox.map(round2), rotation: l.rotation }));
    return { bounds, marginsByRot, pageLines, lines };
  } finally {
    free(page);
  }
}

/** Segments built from chosen groups of a page's lines (by index): the user's split or join. */
function resegmentPage(doc, p, groups) {
  const { bounds, marginsByRot, pageLines } = pageLinesFor(doc, p);
  const out = [];
  for (const g of groups) {
    const lines = g.map((i) => pageLines[i]).filter(Boolean);
    if (!lines.length) continue;
    const seg = buildSegment(lines, p, bounds, 0, marginsByRot, pageLines, false);
    if (seg) out.push(seg);
  }
  return out;
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

/** A [[n]] marker; chat apps sometimes drop one bracket or wrap it in **bold**. */
const MARKER_RE = /(?:\*\*)?([\[［【〔(（<«]{1,2})\s*#?\s*(\p{Nd}+)\s*([\]］】〕)）>»]{1,2})(?:\*\*)?/gu;
// A marker's brackets are one kind, repeated, and they match: "[[12]]" or "((12))". A mixed run
// such as the «<1> at the start of a translation that opens with a quote and an inline tag is
// not a marker (it used to swallow the whole paragraph into a phantom segment 1).
const BRACKET_PAIRS = { "[": "]", "［": "］", "【": "】", "〔": "〕", "(": ")", "（": "）", "<": ">", "«": "»" };
const isMarkerBrackets = (open, close) => open.length + close.length >= 3 && /^(.)\1*$/u.test(open) && /^(.)\1*$/u.test(close) && BRACKET_PAIRS[open[0]] === close[0];
/** Markdown escapes as chat apps copy them: "\[\[12]] 2\. Title". */
const MD_ESCAPE_RE = /\\([\\`*_{}\[\]()#+\-.!|~<>])/g;
const MD_MARKER_RE = /\\\[\s*(?:\\\[)?\s*\p{Nd}+\s*\\?\]/u;
const digitsToInt = (s) => parseInt(s.replace(/\p{Nd}/gu, (d) => {
  const code = d.codePointAt(0);
  for (const zero of [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10]) if (code >= zero && code <= zero + 9) return String(code - zero);
  return d;
}), 10);

function exportTxt(segments, tr = {}) {
  return segments.map((s) => `[[${s.id}]]\n${tr[s.id] || s.text}\n`).join("\n");
}

function parseMarkedText(text) {
  text = text.replace(/\r\n?/g, "\n");
  if (MD_MARKER_RE.test(text)) text = text.replace(MD_ESCAPE_RE, "$1");
  const result = {};
  let current = null, from = 0;
  const flush = (end) => {
    if (current === null) return;
    const v = text.slice(from, end).trim();
    if (v) result[current] = v;
  };
  for (const m of text.matchAll(MARKER_RE)) {
    if (!isMarkerBrackets(m[1], m[3])) continue; // "[1]" is a citation, "«<1>" an inline tag after a quote
    const id = digitsToInt(m[2]);
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const atLineStart = !text.slice(lineStart, m.index).trim();
    // Markers inside a line come from answers pasted as one line; they must keep counting
    // up, so a number in brackets inside the text is not taken for a marker.
    if (!atLineStart && current !== null && id <= current) continue;
    flush(m.index);
    current = id;
    from = m.index + m[0].length;
  }
  flush(text.length);
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
    } else if (c === '"' && !cell) q = true; // (a quote inside an unquoted cell is literal: 5" pipe)
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
      if (!it || typeof it !== "object") continue;
      const id = parseInt(it.id, 10);
      const v = String(it.target || it.translation || "").trim();
      if (v && Number.isFinite(id)) out[id] = v;
    }
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) if (/^\s*\d+\s*$/.test(k) && typeof v === "string" && v.trim()) out[parseInt(k, 10)] = v.trim();
  }
  return out;
}

// Characters XML 1.0 cannot carry (control characters, U+FFFE/FFFF, lone surrogates) are dropped;
// a surrogate pair is matched first and kept.
const XML_ILLEGAL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
const xmlEsc = (s) => String(s).replace(XML_ILLEGAL_RE, (m) => (m.length === 2 ? m : ""))
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const bad = () => new Error("Not a valid .docx (zip) file.");
  const need = (off, len) => { if (!(off >= 0 && len >= 0 && off + len <= bytes.length)) throw bad(); };
  if (bytes.length < 22) throw bad();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad();
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    need(p, 46);
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    need(p + 46, nlen + xlen + clen);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      need(loc, 30);
      const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
      need(start, csize);
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
    // seg.font_choice: a font chosen for this field ("sans-serif", "serif", "monospace", "custom")
    const choice = seg.font_choice;
    const family = choice && choice !== "custom" ? choice
      : this.opts.fontMode === "auto" || this.opts.fontMode === "custom" ? seg.family : this.opts.fontMode;
    const v = (seg.bold ? 1 : 0) + (seg.italic ? 2 : 0);
    const chain = [];
    if ((choice === "custom" || (!choice && this.opts.fontMode === "custom")) && this.opts.customFont) chain.push("custom");
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
  /** Free the font handles (the fonts already added to the document stay in it). */
  dispose() {
    for (const e of this.entries.values()) free(e.font);
    this.entries.clear();
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
          const adv = g.adv * (g.scale || 1);
          if (piece.glyphs.length && piece.w + adv > avail()) { line.tokens.push(piece); line.w = piece.w; push(); piece = { sp: false, glyphs: [], w: 0 }; }
          piece.glyphs.push(g); piece.w += adv;
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
  // grown: segment bbox -> [a0, a1, rotation], the extent of its translation once laid out
  return { edges, containers, grown: new Map() };
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
    let o = localBox(e, rot);
    // A neighbour laid out already may have grown into the gap: its translation is in the way too.
    const g = obs.grown && obs.grown.get(e);
    if (g && g[2] === rot) o = [Math.min(o[0], g[0]), o[1], Math.max(o[2], g[1]), o[3]];
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
  if (obs && seg.lines === 1 && !seg.fixed) [a0, a1] = expandedSpan(seg, bounds, obs); // a box the user drew is kept
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
  // A size the user chose for this field is kept as it is: the text is wrapped at the box width
  // and may run on below the box instead of being made smaller.
  let { k, lines } = seg.exact_size ? { k: 1, lines: wrap(tok, widths(W, 1), indent / s0) } : fitWidth(W);
  if (k < 1 && obs && seg.lines > 1 && !seg.fixed) {
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
    const lineStart = a;
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
    if (lineEnds) lineEnds.push([a, b, lineStart]); // [end, baseline, start] along/across the reading direction
  });
  ops.push("ET");
  return ops.join("\n");
}

/**
 * `parent[key]` as a dictionary this page may change: a dictionary other pages share (an
 * indirect object, or one taken over from a shared or inherited dictionary) is copied first.
 */
function ownDict(doc, parent, key, shared) {
  const cur = parent.get(key);
  if (cur.isDictionary() && !cur.isIndirect() && !shared) return cur;
  const copy = doc.newDictionary();
  if (cur.isDictionary()) cur.forEach((v, k) => copy.put(k, v));
  parent.put(key, copy);
  return copy;
}

function appendContent(doc, page, content, used, xobjects = new Map()) {
  const pobj = page.getObject();
  // Resources shared by several pages (inherited, or one indirect dictionary) get copied before
  // this page's fonts and forms are added, so no other page sees them.
  let res = pobj.get("Resources"), shared = false;
  if (res.isNull()) {
    const inherited = pobj.getInheritable("Resources");
    res = doc.newDictionary();
    if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v));
    pobj.put("Resources", res);
    shared = true;
  } else if (res.isIndirect()) {
    res = ownDict(doc, pobj, "Resources", true);
    shared = true;
  }
  const fonts = ownDict(doc, res, "Font", shared);
  for (const e of used) fonts.put(e.res, e.ref);
  if (xobjects.size) {
    const xo = ownDict(doc, res, "XObject", shared);
    for (const [name, ref] of xobjects) xo.put(name, ref);
  }
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

const rg = (hex) => `${hex.slice(1).match(/../g).map((h) => fmt(parseInt(h, 16) / 255)).join(" ")} rg`;

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
  const todo = [], scaled = [], keep = [...((pageInfo && pageInfo.protect) || [])];
  // An untranslated field with its own size, place or style (numbers, kept text) is set again
  // from its original text; a formula is drawn again from the original page, scaled and moved,
  // so its layout (fractions, exponents) stays exact.
  const textOf = (s) => ((translations[s.id] || "").trim() ? translations[s.id] : s.styled && !s.formula ? s.text : "");
  for (const s of segs) {
    if (textOf(s).trim()) todo.push(s);
    else if (s.styled && s.formula) scaled.push(s);
    else keep.push(s.orig_bbox || s.bbox); // (a moved box still protects the text where it is)
  }
  stats.untranslated += segs.length - todo.length - scaled.length;
  if (!todo.length && !scaled.length) return;
  const page = doc.loadPage(index);
  try {
    const bounds = page.getBounds();
    let obs = null;
    if (opts.expand) obs = obstaclesFor((pageInfo && pageInfo.graphics) || pageGraphics(page), segs);
    const xobjects = new Map(), copies = [];
    unquotePage(doc, page.getObject());
    if (scaled.length) {
      // The page as it is now, drawn again (clipped and scaled) for each formula. The form's name
      // is unique to the page: pages may share one resource dictionary.
      const formName = `PTorig${index}`;
      xobjects.set(formName, pageForm(doc, page));
      for (const s of scaled) {
        const from = s.orig_bbox || s.bbox, to = s.bbox;
        let k = 1;
        if (s.exact_size && s.orig_size) k = s.size / s.orig_size;
        else if (s.fixed) k = Math.min((to[2] - to[0]) / Math.max(1, from[2] - from[0]), (to[3] - to[1]) / Math.max(1, from[3] - from[1]));
        const m = [k, 0, 0, k, to[0] - k * from[0], to[1] - k * from[1]];
        const pad = 0.15 * (s.orig_size || s.size);
        const clip = [from[0] - pad, from[1] - pad, from[2] - from[0] + 2 * pad, from[3] - from[1] + 2 * pad];
        copies.push(`q ${m.map(fmt).join(" ")} cm ${clip.map(fmt).join(" ")} re W n ${page.getTransform().map(fmt).join(" ")} cm /${formName} Do Q`);
      }
      // The formula's glyphs and the lines inside its box (fraction bars) go; nothing else does.
      for (const s of scaled) {
        const b = s.orig_bbox || s.bbox, pad = 0.15 * (s.orig_size || s.size);
        page.createAnnotation("Redact").setRect([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
      }
      page.applyRedactions(false, 0, 1, 0); // keep images, remove line art inside, remove text
    }
    for (const r of redactionRects(todo, keep)) page.createAnnotation("Redact").setRect(r);
    if (todo.length) page.applyRedactions(false, 0, 0, 0); // keep images, keep line art, remove text
    const used = new Set();
    const laid = []; // where the lines of translations laid out so far end, for lead-ins
    // Patches of paper colour over scanned (OCR) text come first, under all translations.
    const covers = todo.filter((seg) => seg.cover).map((seg) =>
      `q ${rg(seg.bg || "#ffffff")} ${seg.cover.map(([x0, y0, x1, y1]) => `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re`).join(" ")} f Q`);
    const content = covers.concat(copies, todo.map((seg) => {
      const ends = [];
      const ops = layoutSegment(seg, textOf(seg), fk, bounds, obs, opts, used, stats, seg.fixed ? null : leadInEnd(seg, laid), ends);
      const right = localBox(seg.bbox, seg.rotation)[2];
      for (const [a, b] of ends) laid.push({ rot: seg.rotation, end: a, base: b, right });
      // Where the translation now reaches: a neighbour laid out later must not grow into it.
      if (obs && ends.length) obs.grown.set(seg.bbox, [Math.min(...ends.map((e) => e[2])), Math.max(...ends.map((e) => e[0])), seg.rotation]);
      return ops;
    })).join("\n");
    appendContent(doc, page, content, used, xobjects);
    stats.replaced += todo.length + scaled.length;
  } finally {
    free(page);
  }
}

/** The page's content streams as one byte array. */
function contentOf(pobj) {
  const contents = pobj.get("Contents"), parts = [];
  const read = (o) => { if (o.isStream()) { const b = o.readStream(); parts.push(b.asUint8Array().slice(), new Uint8Array([10])); free(b); } };
  if (contents.isArray()) for (let k = 0; k < contents.length; k++) read(contents.get(k)); else if (!contents.isNull()) read(contents);
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
  return data;
}

/**
 * A content stream with the ' and " operators written out as T* and Tj (" also as Tw and Tc), or
 * null when it has none. MuPDF's redaction filter moves the text after a removed ' line by a
 * wrong leading: whole blocks (the rest of a table of contents) ended up at the top of the page,
 * still in the original language. With T* the filter keeps every line in place.
 */
function unquoteContent(data) {
  const n = data.length;
  const ws = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const delim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const parts = [];
  let copied = 0, changed = false;
  let operands = []; // [start, end, kind] of the tokens since the last operator
  const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const slice = (a, b) => data.subarray(a, b);
  let i = 0;
  while (i < n) {
    const c = data[i];
    if (ws(c)) { i++; continue; }
    if (c === 37) { while (i < n && data[i] !== 10 && data[i] !== 13) i++; continue; } // comment
    const start = i;
    if (c === 40) { // (string)
      let depth = 0;
      for (; i < n; i++) {
        const d = data[i];
        if (d === 92) { i++; continue; }
        if (d === 40) depth++;
        else if (d === 41 && --depth === 0) { i++; break; }
      }
      operands.push([start, i, "s"]);
      continue;
    }
    if (c === 60 && data[i + 1] !== 60) { // <hex string>
      while (i < n && data[i] !== 62) i++;
      i++;
      operands.push([start, i, "s"]);
      continue;
    }
    if (c === 60 || c === 62) { i += 2; operands.push([start, i, "d"]); continue; } // << >>
    if (delim(c) && c !== 47) { i++; operands.push([start, i, "d"]); continue; } // [ ] { }
    i++;
    while (i < n && !ws(data[i]) && !delim(data[i])) i++;
    const tok = String.fromCharCode(...data.subarray(start, Math.min(i, start + 3)));
    if (c === 47 || /^[-+.\d]/.test(tok) || tok === "tru" || tok === "fal" || tok === "nul") { operands.push([start, i, "n"]); continue; }
    if (i - start === 2 && tok === "BI") { // inline image: skip its data up to EI
      const at = i;
      for (i = at; i < n - 1; i++) {
        if (data[i] === 73 && data[i + 1] === 68 && ws(data[i - 1] ?? 32) && ws(data[i + 2] ?? 32)) break; // ID
      }
      for (i += 3; i < n - 1; i++) {
        if (data[i] === 69 && data[i + 1] === 73 && ws(data[i - 1]) && (i + 2 >= n || ws(data[i + 2]) || delim(data[i + 2]))) { i += 2; break; }
      }
      operands = [];
      continue;
    }
    const op = i - start === 1 ? data[start] : 0;
    const k = operands.length;
    if (op === 39 && k >= 1 && operands[k - 1][2] === "s") { // (string) '
      const s = operands[k - 1];
      parts.push(slice(copied, s[0]), ascii("T* "), slice(s[0], s[1]), ascii(" Tj"));
      copied = i; changed = true;
    } else if (op === 34 && k >= 3 && operands[k - 1][2] === "s" && operands[k - 2][2] === "n" && operands[k - 3][2] === "n") { // aw ac (string) "
      const [aw, ac, s] = operands.slice(k - 3);
      parts.push(slice(copied, aw[0]), slice(aw[0], aw[1]), ascii(" Tw "), slice(ac[0], ac[1]), ascii(" Tc T* "), slice(s[0], s[1]), ascii(" Tj"));
      copied = i; changed = true;
    }
    operands = [];
  }
  if (!changed) return null;
  parts.push(slice(copied, n));
  const out = new Uint8Array(parts.reduce((m, p) => m + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/** The page's content and its forms without ' and " (see unquoteContent), before a redaction. */
function unquotePage(doc, pobj) {
  const data = unquoteContent(contentOf(pobj));
  if (data) pobj.put("Contents", doc.addStream(data, {}));
  const seen = new Set();
  const forms = (res, depth) => {
    if (depth > 4 || !res || res.isNull()) return;
    const xo = res.get("XObject");
    if (xo.isNull()) return;
    xo.forEach((v) => {
      if (!v.isStream() || v.get("Subtype").toString() !== "/Form") return;
      const key = v.isIndirect() ? v.asIndirect() : null;
      if (key !== null) { if (seen.has(key)) return; seen.add(key); }
      const b = v.readStream(), fixed = unquoteContent(b.asUint8Array());
      free(b);
      if (fixed) v.writeStream(fixed);
      forms(v.get("Resources"), depth + 1);
    });
  };
  forms(pobj.getInheritable("Resources"), 0);
}

/** The page's current content as a form XObject (in PDF user space, with the page's resources). */
function pageForm(doc, page) {
  const pobj = page.getObject();
  const data = contentOf(pobj);
  const box = pobj.getInheritable("MediaBox");
  const mb = box.isArray() ? [0, 1, 2, 3].map((k) => box.get(k).asNumber()) : [0, 0, 612, 792];
  // (a copy of the resources: the page's own get the form added to them afterwards)
  const res = pobj.getInheritable("Resources"), copy = doc.newDictionary();
  if (!res.isNull()) res.forEach((v, k) => copy.put(k, v));
  const xo = copy.get("XObject");
  if (!xo.isNull()) { const x = doc.newDictionary(); xo.forEach((v, k) => x.put(k, v)); copy.put("XObject", x); }
  return doc.addStream(data, { Type: "XObject", Subtype: "Form", BBox: mb, Resources: copy });
}

/**
 * Re-translate a single page of an edited output document: the page is copied fresh from the
 * original into `out` and translated there. `map` is out's graft map from the original, so the
 * fonts, images and forms the pages share are copied once, however often pages are updated;
 * `fk` is out's font kit, whose translation fonts all updated pages share (they are subsetted
 * when the document is saved, see savePdf).
 */
function updatePage(out, src, pno, segs, translations, pageInfo, opts, map, fk) {
  map.graftPage(pno, src, pno);
  out.deletePage(pno + 1);
  // The copy shares its content streams with the original's later copies: redaction works on
  // the page's own stream.
  const pobj = out.findPage(pno);
  pobj.put("Contents", out.addStream(contentOf(pobj), {}));
  fk.opts = opts; fk.missing = 0; fk.missingChars.clear();
  const stats = { replaced: 0, untranslated: 0, shrunk: [], missing: 0 };
  translatePage(out, pno, fk, segs, translations, pageInfo, opts, stats);
  stats.missing = fk.missing;
  stats.missingChars = [...fk.missingChars].join("");
  return stats;
}

/** The same bytes (the interface sends a fresh copy of the custom font with every request). */
function sameBytes(a, b) {
  if (!a || !b) return !a && !b;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a), y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
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
  try {
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
    return { bytes: out, stats };
  } finally {
    fk.dispose();
    free(doc);
  }
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
      a.setDefaultAppearance({ serif: "TiRo", monospace: "Cour" }[m.font] || "Helv", m.size, rgb); a.setBorderWidth(0);
      a.setAuthor("Kameleon");
      a.update();
      // MuPDF's own appearance uses plain Helvetica, which lacks signs such as ≥ or ✓; draw it
      // with the same font fallback as the translations instead. The text stays editable.
      fk = fk || new FontKit(doc, { fontMode: "auto" });
      const { ops, res } = textAppearance(doc, fk, m, rgb);
      a.setAppearance(null, null, M.Matrix.identity, [0, 0, m.w, m.h], res, ops);
      free(a);
      continue;
    }
    if (a) { a.setAuthor("Kameleon"); a.update(); free(a); }
  }
  for (const p of pages.values()) free(p);
}

/**
 * Recognised text laid invisibly over the page pictures it was read from, so that a scan or photo
 * saved as PDF can be searched, selected and copied. `layer`: [{page, lines: [{base, size,
 * words: [{text, bbox}]}]}] in page coordinates; each word is stretched to the width it has in the
 * picture (text render mode 3: neither filled nor stroked).
 */
function addTextLayer(doc, layer) {
  const fk = new FontKit(doc, { fontMode: "auto" });
  for (const { page: p, lines } of layer) {
    if (p < 0 || p >= doc.countPages() || !lines.length) continue;
    const page = doc.loadPage(p);
    try {
      const used = new Set(), ops = ["BT 3 Tr"];
      for (const l of lines) {
        const size = Math.max(1, l.size);
        for (const w of l.words) {
          const text = w.text.trim();
          if (!text) continue;
          const chain = fk.chain({ family: "sans-serif" }, text);
          const glyphs = [...text].map((ch) => fk.glyph(chain, ch.codePointAt(0)));
          const natural = glyphs.reduce((a, g) => a + g.adv, 0) * size;
          const k = natural > 0 ? Math.max(0.05, (w.bbox[2] - w.bbox[0]) / natural) : 1;
          let x = w.bbox[0], run = null;
          const flush = () => { if (run) ops.push(`/${run.e.res} 1 Tf ${fmt(size * k)} 0 0 ${fmt(-size)} ${fmt(run.x)} ${fmt(l.base)} Tm <${run.hex}> Tj`); run = null; };
          for (const g of glyphs) {
            fk.ref(g.e); used.add(g.e);
            if (!run || run.e !== g.e) { flush(); run = { e: g.e, x, hex: "" }; }
            run.hex += g.gid.toString(16).padStart(4, "0");
            x += g.adv * size * k;
          }
          flush();
        }
      }
      ops.push("ET");
      if (used.size) appendContent(doc, page, ops.join("\n"), used);
    } finally {
      free(page);
    }
  }
}

/**
 * Appearance stream (operators + resources) for a text note, in its own box coordinates: the
 * background and frame (when set), the text in the note's font, all at the note's opacity.
 */
function textAppearance(doc, fk, m, rgb) {
  const chain = fk.chain({ family: m.font || "sans-serif", bold: Boolean(m.bold), italic: Boolean(m.italic) }, m.text);
  const used = new Set();
  const pad = m.pad != null ? m.pad : 2, op = m.opacity != null ? m.opacity : 1;
  const res = doc.newDictionary(), fonts = doc.newDictionary();
  const ops = [];
  if (op < 1) {
    const gs = doc.newDictionary(), ext = doc.newDictionary();
    gs.put("Type", doc.newName("ExtGState")); gs.put("ca", op); gs.put("CA", op);
    ext.put("GSo", doc.addObject(gs));
    res.put("ExtGState", ext);
    ops.push("/GSo gs");
  }
  // (rounded corners as in the app: the radius follows the font size)
  const radius = m.round ? Math.min(m.w / 2, m.h / 2, Math.max(3, m.size * 0.45)) : 0;
  const box = (x, y, w, h, r) => {
    if (r <= 0) return `${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re`;
    r = Math.min(r, w / 2, h / 2);
    const k = r * 0.5523, x1 = x + w, y1 = y + h;
    return [`${fmt(x + r)} ${fmt(y)} m`, `${fmt(x1 - r)} ${fmt(y)} l`, `${fmt(x1 - r + k)} ${fmt(y)} ${fmt(x1)} ${fmt(y + r - k)} ${fmt(x1)} ${fmt(y + r)} c`,
      `${fmt(x1)} ${fmt(y1 - r)} l`, `${fmt(x1)} ${fmt(y1 - r + k)} ${fmt(x1 - r + k)} ${fmt(y1)} ${fmt(x1 - r)} ${fmt(y1)} c`,
      `${fmt(x + r)} ${fmt(y1)} l`, `${fmt(x + r - k)} ${fmt(y1)} ${fmt(x)} ${fmt(y1 - r + k)} ${fmt(x)} ${fmt(y1 - r)} c`,
      `${fmt(x)} ${fmt(y + r)} l`, `${fmt(x)} ${fmt(y + r - k)} ${fmt(x + r - k)} ${fmt(y)} ${fmt(x + r)} ${fmt(y)} c h`].join(" ");
  };
  if (m.bg) ops.push(`${hexRgb(m.bg).map(fmt).join(" ")} rg ${box(0, 0, m.w, m.h, radius)} f`);
  if (m.border) {
    const bw = m.bw || 1;
    ops.push(`${hexRgb(m.border).map(fmt).join(" ")} RG ${fmt(bw)} w ${box(bw / 2, bw / 2, m.w - bw, m.h - bw, radius - bw / 2)} S`);
  }
  ops.push(`BT ${rgb.map(fmt).join(" ")} rg`);
  let cur = null;
  m.text.split("\n").forEach((line, i) => {
    let x = pad;
    const y = m.h - pad - m.size * 0.88 - i * m.size * 1.2;
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

/**
 * A picture as a one-page PDF: the page has the picture's size at its own resolution (96 dpi
 * when the file does not say), so OCR and the translated output keep the pixel dimensions.
 */
function imageToPdf(bytes) {
  const doc = new M.PDFDocument();
  try {
    const { width, height } = addImagePage(doc, bytes);
    return { bytes: doc.saveToBuffer("compress").asUint8Array().slice(), width, height };
  } finally {
    free(doc);
  }
}

/** Several pictures as one PDF, a page for each (see addImagePage), in the order given. */
function imagesToPdf(list) {
  const doc = new M.PDFDocument();
  try {
    for (const bytes of list) addImagePage(doc, bytes);
    return { bytes: doc.saveToBuffer("compress").asUint8Array().slice(), pages: list.length };
  } finally {
    free(doc);
  }
}

/** A picture added to `doc` as a page of its own size; returns its size in pixels as shown. */
function addImagePage(doc, bytes) {
  // A RAW photo shows its JPEG preview; a photo stored on its side (most phone photos taken
  // upright) is set upright on the page by the drawing matrix, the picture itself unchanged.
  let orient = exifOrientation(bytes);
  if (imageKindOf(bytes) === "dng") {
    const p = dngPreview(bytes);
    if (!p) throw new Error("RAW photo without a preview");
    bytes = p.bytes; orient = p.orientation;
  }
  let img = new M.Image(bytes);
  try {
    const w = img.getWidth(), h = img.getHeight();
    // A large photo stored losslessly (a PNG, TIFF or BMP from a camera or a scanner app) is put into
    // the page as a JPEG: lossless, a phone photo takes 10–20 MB per page. Pictures that PNG packs
    // well (screenshots, drawings, text) stay as they are, and so does anything with transparency.
    const ok = (r) => (r >= 50 && r <= 1200 ? r : 0);
    const dpiX = ok(img.getXResolution()) || 96, dpiY = ok(img.getYResolution()) || dpiX; // (before a JPEG takes its place)
    const kind = imageKindOf(bytes);
    // (a JPEG only when saved at a wastefully high quality: a phone's takes about 0.25 bytes a pixel, quality 100 twice that)
    const heavy = kind === "jpeg" || kind === "dng" ? bytes.length > w * h * 0.45 : bytes.length > w * h * 0.6;
    if (w * h >= 300000 && heavy) {
      const pix = img.toPixmap();
      try {
        if (!pix.getAlpha()) {
          const jpeg = pix.asJPEG(90);
          if (jpeg.length < bytes.length * 0.7) { free(img); img = new M.Image(jpeg); }
        }
      } finally {
        free(pix);
      }
    }
    const iw = (w * 72) / dpiX, ih = (h * 72) / dpiY, side = orient >= 5;
    const pw = side ? ih : iw, ph = side ? iw : ih;
    // where a point (u, v) of the stored picture (fractions, v downwards) is shown (y downwards)
    const shown = {
      1: (u, v) => [u * iw, v * ih], 2: (u, v) => [(1 - u) * iw, v * ih], 3: (u, v) => [(1 - u) * iw, (1 - v) * ih], 4: (u, v) => [u * iw, (1 - v) * ih],
      5: (u, v) => [v * ih, u * iw], 6: (u, v) => [(1 - v) * ih, u * iw], 7: (u, v) => [(1 - v) * ih, (1 - u) * iw], 8: (u, v) => [v * ih, (1 - u) * iw],
    }[orient];
    // the image's unit square (s, t upwards; its top row at t = 1) on the page (y upwards)
    const at = (s2, t2) => { const [x, y] = shown(s2, 1 - t2); return [x, ph - y]; };
    const [e, f] = at(0, 0), [a1, b1] = at(1, 0), [c1, d1] = at(0, 1);
    const cm = [a1 - e, b1 - f, c1 - e, d1 - f, e, f].map((x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(4)).join(" ");
    const ref = doc.addImage(img);
    const res = doc.newDictionary(), xo = doc.newDictionary();
    xo.put("Im0", ref);
    res.put("XObject", xo);
    const page = doc.addPage([0, 0, pw, ph], 0, res, `q ${cm} cm /Im0 Do Q`);
    doc.insertPage(-1, page);
    free(page);
    return { width: side ? h : w, height: side ? w : h };
  } finally {
    free(img);
  }
}

/**
 * A PDF with keywords and their translations: title, subtitle and a two-column table on A4
 * pages. `args`: {title, subtitle, headers: [a, b], rows: [{term, translation}]}.
 */
function keywordsPdf(args) {
  const W = 595.28, H = 841.89, MARGIN = 56, GAP = 14;
  const doc = new M.PDFDocument();
  const fk = new FontKit(doc, { fontMode: "auto" });
  try {
    const colW = [(W - 2 * MARGIN) * 0.42 - GAP / 2, (W - 2 * MARGIN) * 0.58 - GAP / 2];
    const pages = [];
    let ops = [], used = new Set(), y = MARGIN;
    const layout = (text, size, bold, width) => {
      const chain = fk.chain({ family: "sans-serif", bold, italic: false }, text || " ");
      const tok = tokenize(text || " ", fk, chain);
      return { tok, lines: wrap(tok, width / size) };
    };
    /** Draw laid-out lines at (x, top); returns the height used. */
    const draw = (laid, x, top, size, color) => {
      const L = 1.3 * size;
      let base = top + 0.85 * size;
      for (const line of laid.lines) {
        let cx = x, run = null;
        const flush = () => { if (run) ops.push(`BT /${run.e.res} 1 Tf ${rg(color)} ${fmt(size)} 0 0 ${fmt(-size)} ${fmt(run.x)} ${fmt(base)} Tm <${run.hex}> Tj ET`); run = null; };
        line.tokens.forEach((tk, j) => {
          if (j && tk.sp) { flush(); cx += laid.tok.spaceAdv * size; } // (a new run after the space: the pen moves)
          for (const g of tk.glyphs) {
            if (g.own !== undefined) flush();
            if (!run || run.e !== g.e) { flush(); run = { e: g.e, x: cx - (g.own || 0) * size, hex: "" }; fk.ref(g.e); used.add(g.e); }
            run.hex += g.gid.toString(16).padStart(4, "0");
            cx += g.adv * size;
            if (g.own !== undefined) flush();
          }
        });
        flush();
        base += L;
      }
      return laid.lines.length * L;
    };
    const rule = (yy, grey, w) => ops.push(`q ${grey} ${grey} ${grey} RG ${w} w ${fmt(MARGIN)} ${fmt(yy)} m ${fmt(W - MARGIN)} ${fmt(yy)} l S Q`);
    const newPage = () => { pages.push({ ops, used }); ops = []; used = new Set(); y = MARGIN; };
    const header = () => {
      const h = Math.max(draw(layout(args.headers[0], 10.5, true, colW[0]), MARGIN, y, 10.5, "#333333"), draw(layout(args.headers[1], 10.5, true, colW[1]), MARGIN + colW[0] + GAP, y, 10.5, "#333333"));
      y += h + 3; rule(y, 0.3, 0.8); y += 7;
    };
    y += draw(layout(args.title, 18, true, W - 2 * MARGIN), MARGIN, y, 18, "#111111") + 4;
    y += draw(layout(args.subtitle, 10, false, W - 2 * MARGIN), MARGIN, y, 10, "#666666") + 16;
    header();
    for (const row of args.rows) {
      const a = layout(row.term, 11, true, colW[0]), b = layout(row.translation, 11, false, colW[1]);
      const ex = row.example ? layout(row.example, 9.5, false, colW[0]) : null, exT = row.exampleTr ? layout(row.exampleTr, 9.5, false, colW[1]) : null;
      const main = Math.max(a.lines.length, b.lines.length) * 1.3 * 11, extra = ex || exT ? Math.max(ex ? ex.lines.length : 0, exT ? exT.lines.length : 0) * 1.3 * 9.5 + 3 : 0;
      const h = main + extra + 9;
      if (y + h > H - MARGIN) { newPage(); header(); }
      draw(a, MARGIN, y + 2, 11, "#111111");
      draw(b, MARGIN + colW[0] + GAP, y + 2, 11, "#111111");
      if (ex) draw(ex, MARGIN, y + 2 + main + 3, 9.5, "#666666");
      if (exT) draw(exT, MARGIN + colW[0] + GAP, y + 2 + main + 3, 9.5, "#666666");
      y += h; rule(y - 3, 0.85, 0.5);
    }
    newPage();
    pages.forEach((p, i) => {
      // page number at the foot
      ops = p.ops; used = p.used;
      draw(layout(`${i + 1} / ${pages.length}`, 9, false, 100), W - MARGIN - 100 + 100 - 30, H - MARGIN + 14, 9, "#888888");
      const res = doc.newDictionary();
      if (used.size) { const fonts = doc.newDictionary(); for (const e of used) fonts.put(e.res, fk.ref(e)); res.put("Font", fonts); }
      const pg = doc.addPage([0, 0, W, H], 0, res, `q 1 0 0 -1 0 ${fmt(H)} cm\n${ops.join("\n")}\nQ`);
      doc.insertPage(-1, pg);
      free(pg);
    });
    doc.subsetFonts();
    const buf = doc.saveToBuffer("compress");
    const out = buf.asUint8Array().slice();
    free(buf);
    return out;
  } finally {
    fk.dispose();
    free(doc);
  }
}

/**
 * Printable flashcards: A4 sheets with 2 x 4 cards, the fronts (term, example) on one page and
 * the backs (translation, translated example) on the next, mirrored column-wise so that a
 * duplex print flipped on the long edge puts each back behind its front. Dashed cut lines.
 * `args`: {rows: [{term, translation, example, exampleTr}], frontLabel, backLabel}.
 */
function cardsPdf(args) {
  const W = 595.28, H = 841.89, MARGIN = 28, COLS = 2, ROWS = 4, PAD = 16;
  const cw = (W - 2 * MARGIN) / COLS, ch = (H - 2 * MARGIN) / ROWS;
  const doc = new M.PDFDocument();
  const fk = new FontKit(doc, { fontMode: "auto" });
  try {
    const pages = [];
    let ops = [], used = new Set();
    const layout = (text, size, bold, width) => {
      const chain = fk.chain({ family: "sans-serif", bold, italic: false }, text || " ");
      const tok = tokenize(text || " ", fk, chain);
      return { tok, lines: wrap(tok, width / size) };
    };
    const draw = (laid, x, top, size, color, center = 0) => {
      const L = 1.3 * size;
      let base = top + 0.85 * size;
      for (const line of laid.lines) {
        let lineW = 0;
        line.tokens.forEach((tk, j) => { if (j && tk.sp) lineW += laid.tok.spaceAdv * size; for (const g of tk.glyphs) lineW += g.adv * size; });
        let cx = center ? x + (center - lineW) / 2 : x, run = null;
        const flush = () => { if (run) ops.push(`BT /${run.e.res} 1 Tf ${rg(color)} ${fmt(size)} 0 0 ${fmt(-size)} ${fmt(run.x)} ${fmt(base)} Tm <${run.hex}> Tj ET`); run = null; };
        line.tokens.forEach((tk, j) => {
          if (j && tk.sp) { flush(); cx += laid.tok.spaceAdv * size; }
          for (const g of tk.glyphs) {
            if (g.own !== undefined) flush();
            if (!run || run.e !== g.e) { flush(); run = { e: g.e, x: cx - (g.own || 0) * size, hex: "" }; fk.ref(g.e); used.add(g.e); }
            run.hex += g.gid.toString(16).padStart(4, "0");
            cx += g.adv * size;
            if (g.own !== undefined) flush();
          }
        });
        flush();
        base += L;
      }
      return laid.lines.length * L;
    };
    const cutLines = () => {
      ops.push("q 0.75 0.75 0.75 RG 0.5 w [4 4] 0 d");
      for (let c = 0; c <= COLS; c++) ops.push(`${fmt(MARGIN + c * cw)} ${fmt(MARGIN)} m ${fmt(MARGIN + c * cw)} ${fmt(H - MARGIN)} l S`);
      for (let r = 0; r <= ROWS; r++) ops.push(`${fmt(MARGIN)} ${fmt(MARGIN + r * ch)} m ${fmt(W - MARGIN)} ${fmt(MARGIN + r * ch)} l S`);
      ops.push("Q");
    };
    const card = (col, row, word, sentence, label) => {
      const x = MARGIN + col * cw, y = MARGIN + row * ch, inner = cw - 2 * PAD;
      let size = 16, laid = layout(word, size, true, inner);
      while (laid.lines.length > 3 && size > 9) { size -= 1.5; laid = layout(word, size, true, inner); }
      const ex = sentence ? layout(sentence, 9.5, false, inner) : null;
      const exH = ex ? Math.min(ex.lines.length, 4) * 1.3 * 9.5 : 0;
      if (ex) ex.lines = ex.lines.slice(0, 4);
      const total = laid.lines.length * 1.3 * size + (ex ? 8 + exH : 0);
      let top = y + (ch - total) / 2;
      draw(laid, x + PAD, top, size, "#111111", inner);
      if (ex) draw(ex, x + PAD, top + laid.lines.length * 1.3 * size + 8, 9.5, "#666666", inner);
      if (label) draw(layout(label, 7, false, inner), x + PAD, y + 7, 7, "#aaaaaa");
    };
    const rows = args.rows;
    const per = COLS * ROWS;
    for (let i = 0; i < rows.length; i += per) {
      const sheet = rows.slice(i, i + per);
      // fronts
      ops = []; used = new Set(); cutLines();
      sheet.forEach((r, k) => card(k % COLS, Math.floor(k / COLS), r.term, r.example, args.frontLabel));
      pages.push({ ops, used });
      // backs, mirrored column-wise
      ops = []; used = new Set(); cutLines();
      sheet.forEach((r, k) => card(COLS - 1 - (k % COLS), Math.floor(k / COLS), r.translation, r.exampleTr, args.backLabel));
      pages.push({ ops, used });
    }
    for (const p of pages) {
      const res = doc.newDictionary();
      if (p.used.size) { const fonts = doc.newDictionary(); for (const e of p.used) fonts.put(e.res, fk.ref(e)); res.put("Font", fonts); }
      const pg = doc.addPage([0, 0, W, H], 0, res, `q 1 0 0 -1 0 ${fmt(H)} cm\n${p.ops.join("\n")}\nQ`);
      doc.insertPage(-1, pg);
      free(pg);
    }
    doc.subsetFonts();
    const buf = doc.saveToBuffer("compress");
    const out = buf.asUint8Array().slice();
    free(buf);
    return out;
  } finally {
    fk.dispose();
    free(doc);
  }
}

const Engine = {
  init: initEngine, extract: extractDocument, extractPages, build: buildTranslated, renderPNG,
  detectKind, imageKindOf, imageToPdf, warpPixels, quadMap, detectOrientation, cleanPixels, needsCleaning, findTextLines, findPaper, autoPrepare, keywordsPdf, cardsPdf, openBook, saveBook, extractBook, openLaidOut, mapTranslated, openOffice, officePreviewHtml, ocrToBlocks, sampleColors, refineOcr,
  open: (bytes) => M.Document.openDocument(bytes, "application/pdf"),
  exportTxt, exportCsv, exportJson, exportXliff, exportDocx, parseImport, parseMarkedText,
};

/**
 * Password protection: a PDF that only restricts editing or copying (an owner password) opens
 * without a password; one that needs a password to open is unlocked with the user's password.
 * Either way an unencrypted copy is returned, so the translation has no protection either.
 * {status: "plain" | "unlocked" | "password" | "wrong", bytes}
 */
function unlockPdf(bytes, password) {
  const doc = M.Document.openDocument(bytes.slice(), "application/pdf");
  try {
    if (doc.needsPassword()) {
      if (!password) return { status: "password" };
      if (!doc.authenticatePassword(password)) return { status: "wrong" };
    }
    const pdf = doc.asPDF ? doc.asPDF() : doc;
    if (!pdf.getTrailer || pdf.getTrailer().get("Encrypt").isNull()) return { status: "plain" };
    const buf = pdf.saveToBuffer("encrypt=none");
    const out = buf.asUint8Array().slice();
    free(buf);
    return { status: "unlocked", bytes: out };
  } finally {
    free(doc);
  }
}

/**
 * Lines recognised by OCR, as text blocks like MuPDF's: [{lines: [{words: [{text, bbox, size,
 * base}], color, bg}]}] (page coordinates) -> blocks of lines of word spans.
 */
function ocrBlocks(blocks, family = "serif") {
  const fonts = [false, true].map((bold) => ({ name: bold ? "OCR-Bold" : "OCR", bold, italic: false, family, hinted: true, ws: 0, wn: 0 }));
  return blocks.map((b) => ({
    lines: b.lines.map((l) => {
      const font = fonts[l.bold ? 1 : 0];
      const gaps = [];
      const spans = l.words.map((w, i) => {
        const prev = l.words[i - 1];
        const gap = prev ? w.bbox[0] - prev.bbox[2] : 0;
        if (prev) gaps.push(gap / l.size);
        // (no spaces between Chinese / Japanese characters, which Tesseract returns one by one)
        const space = i && !(CJK_RE.test(prev.text.slice(-1)) && CJK_RE.test(w.text[0]));
        return { key: font.name, text: (space ? " " : "") + w.text, bbox: w.bbox, origin: [w.bbox[0], l.base], size: l.size, font,
          color: l.color, bg: l.bg, ocr: true, gapBefore: gap > 0.4 * l.size ? gap : 0 };
      });
      return { dir: [1, 0], spans, gaps };
    }),
  }));
}

/**
 * Ink and paper colour of a box of a page image ({width, height, data: RGBA}): the mean of the
 * darkest tenth and of the lightest half of its pixels; and how much of the box is ink.
 */
function sampleColors(img, box) {
  const [x0, y0, x1, y1] = box.map(Math.round);
  const px = [];
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += step) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x += step) {
      const i = (y * img.width + x) * 4, d = img.data;
      px.push([0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], d[i], d[i + 1], d[i + 2]]);
    }
  }
  if (!px.length) return { fg: "#000000", bg: "#ffffff", ink: 0 };
  px.sort((a, b) => a[0] - b[0]);
  const lo = px[Math.floor(px.length * 0.05)][0], hi = px[Math.floor(px.length * 0.75)][0], mid = (lo + hi) / 2;
  let dark = 0;
  for (const p of px) if (p[0] < mid) dark++;
  const mean = (list) => {
    const m = [0, 0, 0];
    for (const p of list) { m[0] += p[1]; m[1] += p[2]; m[2] += p[3]; }
    return "#" + m.map((v) => Math.round(v / list.length).toString(16).padStart(2, "0")).join("");
  };
  // ink: share of dark pixels, about 1.5 times higher for bold text than for regular text
  return { fg: mean(px.slice(0, Math.max(1, Math.ceil(px.length * 0.1)))), bg: mean(px.slice(Math.floor(px.length * 0.5))), ink: dark / px.length };
}

/**
 * Sparse-text mode finds text everywhere (table cells too) but sometimes breaks a line into
 * garbled pieces ("5] ) 加 /NJZE 几 ?" for "1) 三加六是几？"). Rows of text Tesseract is unsure of
 * are read again as single lines with `readLine(rectangle)`, and kept if that reading is better.
 * Returns Tesseract-like data: {blocks: [{paragraphs: [{lines}]}]}.
 */
async function refineOcr(data, readLine, maxRows = 40) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
  const conf = (ls) => {
    let sum = 0, n = 0;
    for (const l of ls) for (const w of l.words || []) { const k = w.text.trim().length; sum += w.confidence * k; n += k; }
    return n ? sum / n : 0;
  };
  const vOverlap = (a, b) => (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
  const hGap = (a, b) => Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
  const grow = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const rows = [];
  for (const l of lines) {
    if (conf([l]) >= 70) continue;
    const h = l.bbox.y1 - l.bbox.y0;
    const row = rows.find((r) => vOverlap(r.box, l.bbox) > 0.5 && hGap(r.box, l.bbox) < 3 * h);
    if (row) { row.lines.push(l); row.box = grow(row.box, l.bbox); } else rows.push({ lines: [l], box: { ...l.bbox } });
  }
  // Good pieces of the same text line belong to the row as well.
  for (const r of rows) {
    for (const l of lines) {
      const h = r.box.y1 - r.box.y0;
      if (!r.lines.includes(l) && vOverlap(r.box, l.bbox) > 0.5 && hGap(r.box, l.bbox) < 1.5 * h) { r.lines.push(l); r.box = grow(r.box, l.bbox); }
    }
  }
  const replace = new Map(); // first line of a row -> its new lines; other lines of the row -> []
  for (const r of rows.slice(0, maxRows)) {
    const h = r.box.y1 - r.box.y0, pad = Math.round(0.35 * h);
    const rect = { left: Math.max(0, r.box.x0 - pad), top: Math.max(0, r.box.y0 - pad), width: r.box.x1 - r.box.x0 + 2 * pad, height: h + 2 * pad };
    let fresh = [];
    try {
      const res = await readLine(rect);
      for (const b of res.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) if ((l.words || []).length) fresh.push(l);
    } catch (_) { fresh = []; }
    if (!fresh.length || conf(fresh) <= conf(r.lines) + 5) continue;
    const order = r.lines.slice().sort((a, b) => lines.indexOf(a) - lines.indexOf(b));
    if (order.some((l) => replace.has(l))) continue;
    replace.set(order[0], fresh);
    for (const l of order.slice(1)) replace.set(l, []);
  }
  const out = [];
  for (const l of lines) out.push(...(replace.has(l) ? replace.get(l) : [l]));
  return { blocks: [{ paragraphs: [{ lines: out }] }] };
}

/**
 * Tesseract's result for a page image rendered at `zoom` (sparse-text mode: every piece of text,
 * table cells too) -> {blocks: one block of lines for ocrBlocks, seps: table borders}, in page
 * coordinates. The engine groups
 * the lines into paragraphs, cells and labels as it does for PDF text. `colors(box)` gives the
 * ink and paper colour of a box of the image.
 */
function ocrToBlocks(data, zoom, origin, colors) {
  const lines = [];
  const pt = (v, o) => round2(v / zoom + o);
  // Colours measured line by line vary a little; near ones are made equal, so that the lines of
  // one paragraph keep one colour (a colour change starts a new segment).
  const palette = [];
  const snap = (hex, tol) => { // (paper colours must stay close: a patch shows on grey table heads)
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (const p of palette) if (p.tol === tol && Math.hypot(p.c[0] - c[0], p.c[1] - c[1], p.c[2] - c[2]) < tol) return p.hex;
    palette.push({ c, hex, tol });
    return hex;
  };
  const seps = []; // table borders that Tesseract read as | [ ] (column separators)
  const border = (bb) => { const x = (bb.x0 + bb.x1) / 2; seps.push([pt(x, origin[0]) - 0.25, pt(bb.y0, origin[1]), pt(x, origin[0]) + 0.25, pt(bb.y1, origin[1])]); };
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const b = line.bbox, h = b.y1 - b.y0;
        // Border marks read as part of a word ("[3.1", "|Strong") are cut off, box included.
        let words = (line.words || []).map((w) => {
          const sym = (w.symbols || []).filter((c) => c.text.trim());
          let a = 0, z = sym.length;
          while (a < z - 1 && /^[|[\]{}]$/.test(sym[a].text)) border(sym[a++].bbox);
          while (z > a + 1 && /^[|[\]{}]$/.test(sym[z - 1].text)) border(sym[--z].bbox);
          if (!sym.length || (a === 0 && z === sym.length)) return { ...w, text: w.text.trim() };
          const keep = sym.slice(a, z);
          return { ...w, text: keep.map((c) => c.text).join(""),
            bbox: { x0: Math.min(...keep.map((c) => c.bbox.x0)), y0: Math.min(...keep.map((c) => c.bbox.y0)), x1: Math.max(...keep.map((c) => c.bbox.x1)), y1: Math.max(...keep.map((c) => c.bbox.y1)) } };
        });
        // A small sign at the start of a line followed by text is a bullet (often read as + * e o).
        if (words.length > 1 && /^[+*•·°oe»>◦▪■□●○-]$/.test(words[0].text) && words[0].bbox.y1 - words[0].bbox.y0 < 0.7 * h) {
          words[0] = { ...words[0], text: "•", confidence: 99 };
        }
        // Table borders and specks read as | [ ] _ - … are dropped unless Tesseract is sure.
        for (const w of words) if (/^[|[\]{}]+$/.test(w.text)) border(w.bbox);
        words = words.filter((w) => w.text && !/^[|[\]{}]+$/.test(w.text) && (!/^[_\-–—=~.,:;'"`^°*+]+$/.test(w.text) || w.confidence >= 80));
        const good = words.filter((w) => w.confidence >= 60).length;
        words = words.filter((w) => w.confidence >= 30 || (good && /\p{L}/u.test(w.text)));
        if (!words.some((w) => /[\p{L}\p{N}]/u.test(w.text))) continue;
        let rowH = line.rowAttributes && line.rowAttributes.row_height > 0 ? line.rowAttributes.row_height : h;
        const bl = line.baseline && line.baseline.has_baseline !== false ? (line.baseline.y0 + line.baseline.y1) / 2 : b.y1 - 0.2 * h;
        // Table borders read as part of a line make its row height far too big: then the size
        // comes from the height of capitals, digits and ascenders above the baseline (~0.72 em).
        const tall = words.filter((w) => /[\p{Lu}\p{N}bdfhklt]/u.test(w.text) && !/^[|[\]{}]/.test(w.text));
        if (tall.length) {
          const tops = tall.map((w) => w.bbox.y0).sort((x, y) => x - y);
          const cap = (bl - tops[tops.length >> 1]) / 0.7; // (median: one bad word must not decide)
          if (cap > 0 && (rowH > 1.25 * cap || rowH < 0.8 * cap)) rowH = cap;
        }
        const { fg, bg } = colors([b.x0, b.y0, b.x1, b.y1]);
        // Ink is measured in the band from cap height to the baseline of each word, so that lines
        // with and without descenders compare fairly.
        let ink = 0, wsum = 0;
        for (const w of words) {
          const wd = w.bbox.x1 - w.bbox.x0;
          ink += colors([w.bbox.x0, bl - 0.62 * rowH, w.bbox.x1, bl]).ink * wd;
          wsum += wd;
        }
        ink /= wsum || 1;
        lines.push({
          size: round2(Math.max(4, Math.min(rowH, 1.6 * h)) / zoom), base: pt(bl, origin[1]), color: snap(fg, 48), bg: snap(bg, 18), ink,
          // (conf: how sure Tesseract was of the word, 0–100; unsure words are marked for checking)
          words: words.map((w) => ({ text: w.text, conf: Math.round(w.confidence != null ? w.confidence : 99), bbox: [pt(w.bbox.x0, origin[0]), pt(w.bbox.y0, origin[1]), pt(w.bbox.x1, origin[0]), pt(w.bbox.y1, origin[1])] })),
        });
      }
    }
  }
  // Sizes measured line by line vary too: lines on one baseline get their median size, and
  // sizes within 12 % of each other the same value.
  for (const l of lines) {
    const row = lines.filter((o) => Math.abs(o.base - l.base) < 0.3 * Math.min(o.size, l.size)).map((o) => o.size).sort((a, b) => a - b);
    l.rowSize = row[(row.length - 1) >> 1];
  }
  const sizes = [];
  for (const l of lines) {
    const near = sizes.find((v) => Math.abs(v - l.rowSize) <= 0.12 * v);
    l.size = near || l.rowSize;
    if (!near) sizes.push(l.rowSize);
    delete l.rowSize;
  }
  // Specks read as text come out tiny next to the page's text.
  const sorted = lines.map((l) => l.size).sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].size < 0.45 * median) lines.splice(i, 1);
  // Bold lines have clearly more ink (in the cap-height band) than the page's usual text.
  const inks = lines.filter((l) => l.words.length > 1).map((l) => l.ink).sort((a, b) => a - b);
  const usual = inks.length ? inks[inks.length >> 1] : 0;
  for (const l of lines) { l.bold = usual > 0 && l.ink > 1.2 * usual; delete l.ink; }
  return { blocks: lines.length ? [{ lines }] : [], seps };
}

/** Turn pages by a multiple of 90° (added to the rotation they already have): {page: degrees}. */
function rotatePages(doc, rotations) {
  for (const [p, deg] of Object.entries(rotations || {})) {
    if (!deg || Number(p) >= doc.countPages()) continue;
    const obj = doc.findPage(Number(p));
    const old = obj.getInheritable("Rotate");
    const cur = old.isNull() ? 0 : old.asNumber();
    obj.put("Rotate", (((cur + deg) % 360) + 360) % 360);
  }
}

/**
 * The translated PDF (or the original when nothing is translated) with markups and turned
 * pages. Those go into a copy, so the editable document never accumulates them.
 */
function savePdf(W, markups, rotations, original = false, layer = null) {
  const turned = Object.values(rotations).some(Boolean), searchable = Boolean(layer && layer.length);
  // (`original`: the document as opened, not the translation – e.g. a picture saved as PDF;
  // `layer`: recognised text put under the pictures invisibly, see addTextLayer)
  if (original && !markups.length && !turned && !searchable) return W.bytes.slice();
  if (!original && !W.edit && !markups.length && !turned && !searchable) throw new Error("Nothing to save yet.");
  let doc = original ? null : W.edit, temp = null;
  // Fonts added by page updates (shared by all updated pages, see updatePage) and by text notes
  // are embedded whole; the saved copy gets them subsetted.
  const subset = Boolean(W.editFk) || markups.some((m) => m.type === "text") || searchable;
  if (markups.length || turned || !doc || subset) {
    let src = W.bytes;
    if (doc) { const b = W.edit.saveToBuffer(""); src = b.asUint8Array().slice(); free(b); }
    temp = doc = M.Document.openDocument(src.slice(), "application/pdf");
    if (searchable) addTextLayer(doc, layer);
    addMarkups(doc, markups);
    if (subset) doc.subsetFonts();
    rotatePages(doc, rotations);
  }
  const buf = doc.saveToBuffer("garbage,compress");
  const bytes = buf.asUint8Array().slice();
  free(buf);
  free(temp);
  return bytes;
}

/**
 * A bilingual PDF: the odd pages are the original, the even pages its translation (page 1
 * original, page 2 translated page 1, page 3 original page 2, …). Fonts and images shared by
 * pages of one document are copied once.
 */
function bilingualPdf(W, markups, rotations) {
  const translated = M.Document.openDocument(savePdf(W, markups, rotations), "application/pdf");
  const original = M.Document.openDocument(W.bytes.slice(), "application/pdf");
  rotatePages(original, rotations);
  const out = new M.PDFDocument();
  try {
    const fromOriginal = out.newGraftMap(), fromTranslated = out.newGraftMap();
    const n = original.countPages();
    // Grafting copies a page without its annotations (links, markups): they are copied as well.
    const graft = (map, src, i) => {
      const at = out.countPages();
      map.graftPage(at, src, i);
      const annots = src.findPage(i).get("Annots");
      if (!annots.isArray() || !annots.length) return;
      const page = out.findPage(at), copy = map.graftObject(annots);
      for (let k = 0; k < copy.length; k++) { const a = copy.get(k); if (a.isDictionary()) a.put("P", page); }
      page.put("Annots", copy);
    };
    for (let i = 0; i < n; i++) {
      graft(fromOriginal, original, i);
      graft(fromTranslated, translated, i);
    }
    const buf = out.saveToBuffer("garbage,compress");
    const bytes = buf.asUint8Array().slice();
    free(buf);
    return bytes;
  } finally {
    free(out); free(original); free(translated);
  }
}

/**
 * Original and translation on one sheet, as many pages as the original: portrait pages side by
 * side (original left), landscape pages one above the other (original on top). Markups and other
 * annotations are drawn into the pages; links are not kept.
 */
function sideBySidePdf(W, markups, rotations) {
  const translated = M.Document.openDocument(savePdf(W, markups, rotations), "application/pdf");
  const original = M.Document.openDocument(W.bytes.slice(), "application/pdf");
  rotatePages(original, rotations);
  const out = new M.PDFDocument();
  try {
    original.bake(); translated.bake();
    const fromOriginal = out.newGraftMap(), fromTranslated = out.newGraftMap();
    // A page as a form XObject, turned upright with its lower left corner at 0,0.
    const asForm = (map, src, i) => {
      const page = src.findPage(i);
      const box = page.getInheritable("CropBox").isArray() ? page.getInheritable("CropBox") : page.getInheritable("MediaBox");
      const r = box.isArray() ? [0, 1, 2, 3].map((k) => box.get(k).asNumber()) : [0, 0, 612, 792];
      const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      const rot = page.getInheritable("Rotate");
      const deg = ((((rot.isNull() ? 0 : rot.asNumber()) % 360) + 360) % 360);
      const matrix = { 0: [1, 0, 0, 1, -x0, -y0], 90: [0, -1, 1, 0, -y0, x1], 180: [-1, 0, 0, -1, x1, y1], 270: [0, 1, -1, 0, y1, -x0] }[deg] || [1, 0, 0, 1, -x0, -y0];
      const turned = deg === 90 || deg === 270;
      const w = turned ? y1 - y0 : x1 - x0, h = turned ? x1 - x0 : y1 - y0;
      const contents = page.get("Contents"), parts = [];
      const read = (o) => { if (o.isStream()) { const b = o.readStream(); parts.push(b.asUint8Array().slice(), new Uint8Array([10])); free(b); } };
      if (contents.isArray()) for (let k = 0; k < contents.length; k++) read(contents.get(k)); else read(contents);
      const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
      const res = page.getInheritable("Resources");
      const form = out.addStream(data, {
        Type: "XObject", Subtype: "Form", BBox: [x0, y0, x1, y1], Matrix: matrix,
        Resources: res.isNull() ? {} : map.graftObject(res),
      });
      return { form, w, h };
    };
    const num = (v) => String(Math.round(v * 1000) / 1000);
    for (let i = 0; i < original.countPages(); i++) {
      const a = asForm(fromOriginal, original, i);
      const b = i < translated.countPages() ? asForm(fromTranslated, translated, i) : a;
      const portrait = a.w <= a.h;
      const W2 = portrait ? a.w + b.w : Math.max(a.w, b.w), H2 = portrait ? Math.max(a.h, b.h) : a.h + b.h;
      // Original: left (top aligned) or on top; translation: right or below.
      const pa = portrait ? [0, H2 - a.h] : [0, b.h], pb = portrait ? [a.w, H2 - b.h] : [0, 0];
      const content = `q 1 0 0 1 ${num(pa[0])} ${num(pa[1])} cm /Orig Do Q\nq 1 0 0 1 ${num(pb[0])} ${num(pb[1])} cm /Tran Do Q\n`;
      const page = out.addPage([0, 0, W2, H2], 0, { XObject: { Orig: a.form, Tran: b.form } }, content);
      out.insertPage(-1, page);
    }
    const buf = out.saveToBuffer("garbage,compress");
    const bytes = buf.asUint8Array().slice();
    free(buf);
    return bytes;
  } finally {
    free(out); free(original); free(translated);
  }
}

/**
 * An EPUB whose text files are encrypted (Adobe, LCP or other DRM) cannot be translated. Only
 * obfuscated fonts (the IDPF and Adobe font mangling) are no DRM: the text stays readable.
 */
async function checkEpubDrm(bytes) {
  let entry;
  try { entry = zipEntries(bytes).find((e) => e.name === "META-INF/encryption.xml"); } catch (_) { return; } // (MuPDF reports a broken file)
  if (!entry) return;
  const xml = decodeXml(await zipRead(entry));
  const fontAlgorithm = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/;
  for (const [block] of xml.matchAll(/<(?:[\w.-]+:)?EncryptedData[\s>][\s\S]*?<\/(?:[\w.-]+:)?EncryptedData\s*>/g)) {
    const uri = (/CipherReference[^>]*\bURI\s*=\s*["']([^"']*)["']/.exec(block) || [])[1] || "";
    const algorithm = (/EncryptionMethod[^>]*\bAlgorithm\s*=\s*["']([^"']*)["']/.exec(block) || [])[1] || "";
    if (fontAlgorithm.test(algorithm) || /\.(?:ttf|otf|woff2?)$/i.test(uri.split(/[?#]/)[0])) continue;
    throw new Error("This EPUB is DRM-protected and cannot be translated.");
  }
}

// ---------------------------------------------------------- worker protocol
/**
 * Request handler shared by the Web Worker and the in-page fallback. It keeps an open copy of
 * the original PDF (for extraction and rendering) and of the latest translated PDF (preview).
 */
function createHandler() {
  // edit: the translated document (an editable PDF, or the laid-out translated e-book);
  // editMap/editFk: the graft map from the original and the font kit of an editable PDF
  // (see updatePage); opened: the parse of an Office file made for its preview on "open".
  const W = { doc: null, bytes: null, edit: null, editMap: null, editFk: null, kind: "pdf", book: null, opened: null, outBytes: null, extras: [] };
  const clearExtras = () => { for (const e of W.extras) free(e.doc); W.extras = []; }; // (files added in the page manager)
  const dropEdit = () => {
    if (W.editFk) W.editFk.dispose();
    free(W.editMap); free(W.edit);
    W.edit = W.editMap = W.editFk = null;
  };
  const setEdit = (doc) => { dropEdit(); W.edit = doc; W.editMap = doc.newGraftMap(); };
  const clearCaches = () => { fontInfoCache.clear(); fontPtrCache.clear(); colorCache.clear(); fontStyleHints.clear(); fontStyleSeen.clear(); };
  return async function handle(cmd, args = {}, progress = () => {}) {
    if (cmd === "init") {
      await initEngine(null, args.mupdfUrl || null);
      return { result: true };
    }
    if (cmd === "open") {
      dropEdit(); free(W.doc); clearExtras();
      W.doc = W.bytes = W.book = W.opened = W.outBytes = null;
      clearCaches(); // (fonts of another document with the same names are analysed afresh)
      const kind = args.kind || "pdf";
      let bytes = args.bytes, doc, book = null, opened = null;
      if (kind !== "pdf") {
        if (kind === "fb2") bytes = await unzipFb2(args.bytes); // .fb2.zip / .fbz
        if (kind === "epub") await checkEpubDrm(bytes);
        if (OFFICE_KINDS.has(kind)) {
          opened = await openOffice(bytes, kind);
          opened.segments.forEach((sg, i) => { sg.id = i + 1; });
          opened.bytes = bytes;
          book = opened.book;
          doc = openOfficePreview(book, opened.segments, {}, kind);
        } else doc = await openLaidOut(bytes.slice(), kind);
      } else {
        doc = M.Document.openDocument(bytes.slice(), "application/pdf");
        if (doc.needsPassword && doc.needsPassword()) { free(doc); throw new Error("Password-protected PDFs are not supported."); }
      }
      // (only now: a failed open leaves no document in use)
      W.doc = doc; W.bytes = bytes; W.kind = kind; W.book = book; W.opened = opened;
      return { result: doc.countPages() };
    }
    if (cmd === "extract") return { result: await extractPages(W.doc, args.pages, progress) };
    if (cmd === "pageLines") return { result: pageLinesFor(W.doc, args.page).lines };
    if (cmd === "resegment") return { result: resegmentPage(W.doc, args.page, args.groups) };
    if (cmd === "unlock") return { result: unlockPdf(args.bytes, args.password) };
    if (cmd === "convert") return { result: await convertLegacy(args.bytes, args.kind) }; // .doc/.xls/.ppt → .docx/.xlsx/.pptx
    if (cmd === "imageToPdf") { const r = imageToPdf(args.bytes); return { result: r, transfer: [r.bytes.buffer] }; }
    if (cmd === "imagesToPdf") { const r = imagesToPdf(args.list); return { result: r, transfer: [r.bytes.buffer] }; }
    // --- the page manager: extra files held here for thumbnails, then the file put together anew
    if (cmd === "extraOpen") {
      let doc;
      if (args.kind === "pdf") {
        doc = M.Document.openDocument(args.bytes.slice(), "application/pdf");
        if (doc.needsPassword && doc.needsPassword()) { free(doc); throw new Error("The file is password-protected."); }
      } else {
        const opened = await openOffice(args.bytes, "pptx");
        opened.segments.forEach((sg, i) => { sg.id = i + 1; });
        doc = M.Document.openDocument(renderSlides(opened.book, opened.segments, {}, { notes: false }), "application/pdf");
      }
      const pages = [];
      for (let i = 0; i < doc.countPages(); i++) { const pg = doc.loadPage(i); const b = pg.getBounds(); pages.push({ width: b[2] - b[0], height: b[3] - b[1] }); free(pg); }
      W.extras.push({ bytes: args.bytes, kind: args.kind, doc });
      return { result: { index: W.extras.length, pages } };
    }
    if (cmd === "extraRender") {
      const e = W.extras[args.index - 1];
      if (!e) throw new Error("No such file.");
      const png = renderPNG(e.doc, args.page, args.zoom);
      return { result: png.buffer, transfer: [png.buffer] };
    }
    if (cmd === "extraClear") { clearExtras(); return { result: true }; }
    if (cmd === "skewDetect") { // the tilt of a page of the open file, or of an added one (index ≥ 1)
      const doc = args.index ? (W.extras[args.index - 1] || {}).doc : W.doc;
      if (!doc) throw new Error("No document is open.");
      return { result: detectSkew(doc, args.page) };
    }
    if (cmd === "splitPage") { // a page showing an open book, as its two pages (see splitPage)
      const doc = args.index ? (W.extras[args.index - 1] || {}).doc : W.doc;
      if (!doc) throw new Error("No document is open.");
      return { result: splitPage(doc, args.page, args.rot || 0, args.skew || 0) };
    }
    if (cmd === "orientDetect") { // which way up a page is (quarter turns) and its tilt then
      const doc = args.index ? (W.extras[args.index - 1] || {}).doc : W.doc;
      if (!doc) throw new Error("No document is open.");
      return { result: detectPageOrientation(doc, args.page) };
    }
    if (cmd === "pagesInfo") { const deck = W.book && W.book.deck; return { result: { slides: (deck && deck.slidePages) || null, hidden: deck ? deck.slides.map((sl) => Boolean(sl && sl.hidden)) : null, notes: deck ? deck.slides.map((sl) => Boolean(sl && sl.notesFi >= 0)) : null } }; }
    if (cmd === "rearrange") {
      if (!W.bytes) throw new Error("No document is open.");
      const bytes = await rearrangeDocument(W.kind, W.bytes, args.plan, W.extras.map((e) => e.bytes), { dropNotes: Boolean(args.dropNotes) });
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "keywordsPdf") { const b = keywordsPdf(args); return { result: b, transfer: [b.buffer] }; }
    if (cmd === "cardsPdf") { const b = cardsPdf(args); return { result: b, transfer: [b.buffer] }; }
    if (cmd === "pdfPageCount") { const doc = M.Document.openDocument(args.bytes, "application/pdf"); try { return { result: doc.countPages() }; } finally { free(doc); } }
    if (cmd === "renderBytes") { // a page of a finished PDF (the translated picture) as PNG
      const doc = M.Document.openDocument(args.bytes, "application/pdf");
      try { const png = renderPNG(doc, args.page || 0, args.zoom); return { result: png.buffer, transfer: [png.buffer] }; } finally { free(doc); }
    }
    if (cmd === "ocrPage") {
      const page = W.doc.loadPage(args.page);
      try {
        const bounds = page.getBounds();
        const seps = pageGraphics(page).seps.concat(args.seps || []);
        return { result: segmentPage(ocrBlocks(args.lines, args.family), args.page, bounds, seps, []) };
      } finally {
        free(page);
      }
    }
    // Splitting and joining recognised segments: the page's OCR lines (as for ocrPage) listed, and
    // segments built from groups of them.
    if (cmd === "ocrLines" || cmd === "ocrResegment") {
      const page = W.doc.loadPage(args.page);
      try {
        const bounds = page.getBounds();
        const seps = pageGraphics(page).seps.concat(args.seps || []);
        const { marginsByRot, pageLines } = pageLineSet(ocrBlocks([{ lines: args.raw }], args.family), seps, []);
        if (cmd === "ocrLines") return { result: pageLines.map((l, i) => ({ i, text: l.text, bbox: l.bbox.map(round2), rotation: l.rotation })) };
        const out = [];
        for (const g of args.groups) {
          const lines = g.map((i) => pageLines[i]).filter(Boolean);
          const seg = lines.length ? buildSegment(lines, args.page, bounds, 0, marginsByRot, pageLines, false) : null;
          if (seg) out.push(seg);
        }
        return { result: out };
      } finally {
        free(page);
      }
    }
    if (cmd === "extractBook") {
      // An Office file was parsed for its preview on "open" already: that parse is passed on,
      // so the file is not unzipped and parsed a second time.
      const opened = W.opened && W.opened.bytes === W.bytes ? W.opened : null;
      const { book, pages, segments } = await extractBook(W.bytes, W.kind, W.doc, opened);
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
      dropEdit();
      W.edit = OFFICE_KINDS.has(W.kind) ? openOfficePreview(W.book, args.segments, args.translations, W.kind) : await openLaidOut(result.bytes.slice(), W.kind);
      result.view = mapTranslated(W.edit, args.segments, args.translations);
      return { result, transfer: [result.bytes.buffer] };
    }
    if (cmd === "build") {
      const result = await buildTranslated(W.bytes.slice(), args.segments, args.translations, args.pages, args.opts, progress);
      setEdit(M.Document.openDocument(result.bytes.slice(), "application/pdf"));
      return { result, transfer: [result.bytes.buffer] };
    }
    if (cmd === "updatePage") {
      const opts = args.opts || {};
      if (!W.edit) setEdit(M.Document.openDocument(W.bytes.slice(), "application/pdf"));
      // One font kit per output document; a new custom font gets a new one.
      if (W.editFk && !sameBytes(W.editFk.opts.customFont, opts.customFont)) { W.editFk.dispose(); W.editFk = null; }
      if (!W.editFk) W.editFk = new FontKit(W.edit, opts);
      return { result: updatePage(W.edit, W.doc, args.page, args.segments, args.translations, args.pageInfo, opts, W.editMap, W.editFk) };
    }
    if (cmd === "save" && W.kind !== "pdf") {
      if (!W.outBytes) throw new Error("Nothing to save yet.");
      const bytes = W.outBytes.slice();
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "save") {
      const bytes = savePdf(W, args.markups || [], args.rotations || {}, Boolean(args.original), args.layer || null);
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "saveBilingual" && W.kind !== "pdf") {
      // E-book: each paragraph in the original, followed by its translation.
      if (!W.book) W.book = (await openBook(W.bytes, W.kind)).book;
      const { bytes } = await saveBook(W.book, W.bytes, args.segments, args.translations, { ...(args.opts || {}), bilingual: true });
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "saveBilingual") {
      const bytes = (args.layout === "side" ? sideBySidePdf : bilingualPdf)(W, args.markups || [], args.rotations || {});
      return { result: bytes, transfer: [bytes.buffer] };
    }
    if (cmd === "resetOutput") {
      dropEdit();
      W.outBytes = null;
      return { result: true };
    }
    if (cmd === "close") {
      dropEdit(); free(W.doc); clearExtras();
      W.doc = W.bytes = W.book = W.opened = W.outBytes = null;
      clearCaches();
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
