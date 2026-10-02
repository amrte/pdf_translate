// ---------------------------------------------------------------------------------------------
// PowerPoint slides drawn as PDF pages: the preview of a .pptx. Each slide becomes a page of
// the slide's size with its background, the shapes and pictures of the master, the layout and
// the slide itself, its tables, and the text set into the real text boxes – with the
// translations for the "Translated" view. Runs with the engine (same module scope: MuPDF,
// FontKit, tokenize/wrap and the XML helpers of ebook.js and office.js).
// ---------------------------------------------------------------------------------------------

const EMU_PT = 1 / 12700; // EMU → points
const BEZ = 0.5523; // circle from four Béziers

const PRST_COLORS = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080", grey: "#808080",
  ltgray: "#d3d3d3", dkgray: "#a9a9a9", orange: "#ffa500", purple: "#800080", navy: "#000080", teal: "#008080", silver: "#c0c0c0", maroon: "#800000",
  lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff", magenta: "#ff00ff", olive: "#808000", gold: "#ffd700", brown: "#a52a2a",
};
const TABLE_STYLE_ACCENT = { // the common "Medium Style 2": a filled header row, banded rows
  "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": "accent1", "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}": "accent2", "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": "accent3",
  "{00A15C55-8517-42AA-B614-E9B94910E393}": "accent4", "{7DF18680-E054-41AD-8BC1-D1AEF772440D}": "accent5", "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": "accent6",
};

/* ---------------------------------------------------------------- small helpers */

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hexRgb255 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const pct = (v) => (v === null || v === undefined || v === "" ? null : Number(v) / 100000);
const num = (v, d = 0) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const RG = (hex) => `${hex.slice(1).match(/../g).map((h) => fmt(parseInt(h, 16) / 255)).join(" ")} RG`;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** 2×3 matrices [a b c d e f] (PDF order), applied as p' = M p. */
const mmul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const mtranslate = (x, y) => [1, 0, 0, 1, x, y];
const mscale = (x, y) => [x, 0, 0, y, 0, 0];
const mrotate = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
const mfmt = (m) => m.map(fmt).join(" ");

/* ---------------------------------------------------------------- the deck model */

/**
 * The parts a .pptx preview needs, gathered while the file is open (zip access is async):
 * slide size, each slide with its layout, master and theme, and the picture bytes.
 */
async function collectDeck(ctx) {
  const { text, relsOf, byName, slides, addFile, pres, presRoot } = ctx;
  const sldSz = findAll(presRoot, (k) => k.name === "sldsz")[0];
  const deck = {
    sldCx: (sldSz && num(xmlAttr(pres, sldSz, "cx"))) || 9144000, sldCy: (sldSz && num(xmlAttr(pres, sldSz, "cy"))) || 6858000,
    media: new Map(), slides: [], tableStyles: null,
  };
  const shared = new Map();
  const mediaOf = async (p) => {
    for (const r of Object.values(p.rels)) {
      if (!/\/image$/.test(r.type) || deck.media.has(r.target)) continue;
      const e = byName.get(r.target);
      if (!e || !/\.(png|jpe?g|gif|bmp|tiff?|jp2|jpx)$/i.test(r.target)) continue;
      try { deck.media.set(r.target, await zipRead(e)); } catch (_) { /* an unreadable picture is left out */ }
    }
  };
  const part = async (path) => {
    if (!path) return null;
    if (shared.has(path)) return shared.get(path);
    const src = await text(path);
    const p = src === null ? null : { path, src, root: parseXml(src), rels: await relsOf(path) };
    if (p) await mediaOf(p);
    shared.set(path, p);
    return p;
  };
  const relOf = (p, re) => p && Object.values(p.rels).find((r) => re.test(r.type));
  for (const path of slides) {
    const f = await addFile(path);
    if (!f) { deck.slides.push(null); continue; }
    const slide = { path, src: f.src, root: f.root, fi: f.fi, rels: await relsOf(path) };
    await mediaOf(slide);
    const layout = await part((relOf(slide, /\/slideLayout$/) || {}).target);
    const master = await part((relOf(layout, /\/slideMaster$/) || {}).target);
    const theme = await part((relOf(master, /\/theme$/) || {}).target);
    // SmartArt: PowerPoint stores a drawn copy of each diagram, which is what is shown
    const diagrams = {};
    for (const r of Object.values(slide.rels)) if (/\/diagramDrawing$/.test(r.type)) { const d = await part(r.target); if (d) diagrams[r.target] = d; }
    // The diagram's data (its text, translated like slide text) and the drawing it belongs to.
    const diagramData = {};
    for (const [rId, r] of Object.entries(slide.rels)) {
      if (!/\/diagramData$/.test(r.type)) continue;
      const f = await addFile(r.target);
      if (!f) continue;
      const ext = findAll(f.root, (k) => k.name === "datamodelext")[0];
      const drawRel = ext && slide.rels[xmlAttr(f.src, ext, "relId") || ""];
      const drawing = (drawRel && diagrams[drawRel.target]) || Object.values(diagrams).find((d) => d.path.replace(/\D/g, "") === r.target.replace(/\D/g, "")) || null;
      diagramData[rId] = { rId, fi: f.fi, src: f.src, root: f.root, path: r.target, drawing };
    }
    deck.slides.push({ ...slide, layout, master, theme, diagrams, diagramData, notesFi: -1 });
  }
  return deck;
}

/* ---------------------------------------------------------------- colours and fills */

/** The slide's colour scheme: scheme name (tx1, accent3 …) → "#rrggbb". */
function colorScheme(sl) {
  const theme = sl.theme, master = sl.master;
  const colors = {};
  if (theme) {
    const scheme = findAll(theme.root, (k) => k.name === "clrscheme")[0];
    for (const k of (scheme && scheme.kids) || []) {
      if (!k.kids) continue;
      const c = k.kids.find((x) => x.name === "srgbclr" || x.name === "sysclr");
      if (!c) continue;
      const v = c.name === "srgbclr" ? xmlAttr(theme.src, c, "val") : xmlAttr(theme.src, c, "lastClr") || "000000";
      if (v) colors[k.name] = `#${v.toLowerCase()}`;
    }
  }
  // bg1/tx1/bg2/tx2 are mapped onto lt1/dk1/lt2/dk2 by the master (or a slide override).
  const map = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  const clrMapEl = (p, name) => p && findAll(p.root, (k) => k.name === name)[0];
  const over = clrMapEl(sl, "overrideclrmapping"), mapEl = over ? { el: over, src: sl.src } : master ? { el: clrMapEl(master, "clrmap"), src: master.src } : null;
  if (mapEl && mapEl.el) for (const key of ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) {
    const v = xmlAttr(mapEl.src, mapEl.el, key);
    if (v) map[key] = v.toLowerCase();
  }
  return (name) => {
    const n = (name || "").toLowerCase();
    const t = map[n] || n;
    return colors[t] || colors[n] || (/^(lt|bg)/.test(n) ? "#ffffff" : "#000000");
  };
}

/**
 * The colour of a DrawingML colour element (srgbClr, schemeClr …) with its modifiers
 * (lumMod/lumOff, tint, shade, alpha – alpha is blended towards `ctx.paper`).
 */
function colorValue(src, el, ctx) {
  let hex = null;
  const val = (xmlAttr(src, el, "val") || "").toLowerCase();
  if (el.name === "srgbclr") hex = /^[0-9a-f]{6}$/.test(val) ? `#${val}` : null;
  else if (el.name === "schemeclr") hex = val === "phclr" ? ctx.phClr || "#808080" : ctx.scheme(val);
  else if (el.name === "sysclr") { const last = (xmlAttr(src, el, "lastClr") || "").toLowerCase(); hex = /^[0-9a-f]{6}$/.test(last) ? `#${last}` : val === "window" ? "#ffffff" : "#000000"; }
  else if (el.name === "prstclr") hex = PRST_COLORS[val] || "#808080";
  else if (el.name === "scrgbclr") hex = rgbHex(...["r", "g", "b"].map((a) => (num(xmlAttr(src, el, a)) / 100000) * 255));
  else if (el.name === "hslclr") hex = rgbHex(...hslToRgb(num(xmlAttr(src, el, "hue")) / 21600000, num(xmlAttr(src, el, "sat")) / 100000, num(xmlAttr(src, el, "lum")) / 100000));
  if (!hex) return null;
  let [r, g, b] = hexRgb255(hex);
  let alpha = 1;
  for (const m of el.kids || []) {
    if (!m.name) continue;
    const v = pct(xmlAttr(src, m, "val"));
    if (v === null) continue;
    if (m.name === "lummod" || m.name === "lumoff") {
      const [h, s, l] = rgbToHsl(r, g, b);
      const l2 = m.name === "lummod" ? l * v : l + v;
      [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, l2)));
    } else if (m.name === "tint") { r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; b = 255 - (255 - b) * v; }
    else if (m.name === "shade") { r *= v; g *= v; b *= v; }
    else if (m.name === "alpha") alpha = v;
    else if (m.name === "satmod") { const [h, s, l] = rgbToHsl(r, g, b); [r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, s * v)), l); }
  }
  if (alpha < 1) { const [pr, pg, pb] = hexRgb255(ctx.paper || "#ffffff"); r = pr + (r - pr) * alpha; g = pg + (g - pg) * alpha; b = pb + (b - pb) * alpha; }
  return rgbHex(r, g, b);
}

const COLOR_NAMES = new Set(["srgbclr", "schemeclr", "sysclr", "prstclr", "scrgbclr", "hslclr"]);
const firstColor = (src, el, ctx) => { const c = (el.kids || []).find((k) => COLOR_NAMES.has(k.name)); return c ? colorValue(src, c, ctx) : null; };

/**
 * The fill given by the children of `el` (spPr, bgPr, tcPr, a fill style …):
 * {color} | {image, crop} | null for noFill | undefined when none is specified.
 */
function fillOf(src, el, ctx) {
  for (const k of (el && el.kids) || []) {
    if (k.name === "nofill") return null;
    if (k.name === "solidfill") return { color: firstColor(src, k, ctx) || "#808080" };
    if (k.name === "gradfill") {
      const stops = findAll(k, (x) => x.name === "gs").map((g) => firstColor(src, g, ctx)).filter(Boolean);
      if (!stops.length) return { color: "#c0c0c0" };
      const rgb = stops.map(hexRgb255), avg = [0, 1, 2].map((i) => rgb.reduce((s, c) => s + c[i], 0) / rgb.length);
      return { color: rgbHex(...avg), stops };
    }
    if (k.name === "blipfill") {
      const blip = firstNamed(k, "blip"), rect = firstNamed(k, "srcrect");
      const rid = blip && xmlAttr(src, blip, "r:embed");
      const crop = rect ? ["l", "t", "r", "b"].map((a) => pct(xmlAttr(src, rect, a)) || 0) : [0, 0, 0, 0];
      return { image: rid, crop, tile: !!firstNamed(k, "tile") };
    }
    if (k.name === "pattfill") { const fg = firstNamed(k, "fgclr"); return { color: (fg && firstColor(src, fg, ctx)) || "#808080" }; }
  }
  return undefined;
}

/** The line given by `ln` (a:ln): {width (pt), color} | null for no line | undefined when unspecified. */
function strokeOf(src, ln, ctx) {
  if (!ln) return undefined;
  const fill = fillOf(src, ln, ctx);
  if (fill === null) return null;
  const w = num(xmlAttr(src, ln, "w"), 9525) * EMU_PT;
  if (fill === undefined) return { width: w, color: undefined }; // (width only: the colour comes from the style)
  return { width: w, color: fill.color || "#808080" };
}

/** The n-th element (1-based) of a theme style list (fillStyleLst, lnStyleLst, bgFillStyleLst). */
function themeStyle(sl, listName, idx) {
  if (!sl.theme || !idx) return null;
  const list = findAll(sl.theme.root, (k) => k.name === listName)[0];
  const items = ((list && list.kids) || []).filter((k) => k.kids || k.empty);
  return items[idx - 1] ? { el: items[idx - 1], src: sl.theme.src } : null;
}

/* ---------------------------------------------------------------- geometry */

function ellipsePath(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = rx * BEZ, ky = ry * BEZ;
  return [`${fmt(cx + rx)} ${fmt(cy)} m`,
    `${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    `${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)} c h`].join("\n");
}
function roundRectPath(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.01) return `0 0 ${fmt(w)} ${fmt(h)} re`;
  const k = r * BEZ;
  return [`${fmt(r)} 0 m`, `${fmt(w - r)} 0 l`, `${fmt(w - r + k)} 0 ${fmt(w)} ${fmt(r - k)} ${fmt(w)} ${fmt(r)} c`, `${fmt(w)} ${fmt(h - r)} l`,
    `${fmt(w)} ${fmt(h - r + k)} ${fmt(w - r + k)} ${fmt(h)} ${fmt(w - r)} ${fmt(h)} c`, `${fmt(r)} ${fmt(h)} l`, `${fmt(r - k)} ${fmt(h)} 0 ${fmt(h - r + k)} 0 ${fmt(h - r)} c`,
    `0 ${fmt(r)} l`, `0 ${fmt(r - k)} ${fmt(r - k)} 0 ${fmt(r)} 0 c h`].join("\n");
}
const polyPath = (pts) => pts.map(([x, y], i) => `${fmt(x)} ${fmt(y)} ${i ? "l" : "m"}`).join(" ") + " h";

/** Preset geometry → PDF path in the shape's local box (0..w, 0..h). `adj` are the adjust values. */
function presetPath(prst, w, h, adj) {
  const a = (name, d) => (adj[name] !== undefined ? adj[name] : d) / 100000;
  const m = Math.min(w, h);
  switch (prst) {
    case "ellipse": case "cloud": case "flowChartConnector": case "smileyFace": case "donut": case "blockArc": case "pie": case "chord": case "arc":
      return { d: ellipsePath(0, 0, w, h), open: prst === "arc" };
    case "roundRect": case "round1Rect": case "round2SameRect": case "round2DiagRect": case "snipRoundRect": case "flowChartAlternateProcess":
      return { d: roundRectPath(w, h, m * a("adj", 16667)) };
    case "line": case "straightConnector1": return { d: `0 0 m ${fmt(w)} ${fmt(h)} l`, open: true };
    case "bentConnector2": return { d: `0 0 m ${fmt(w)} 0 l ${fmt(w)} ${fmt(h)} l`, open: true };
    case "bentConnector3": return { d: `0 0 m ${fmt(w / 2)} 0 l ${fmt(w / 2)} ${fmt(h)} l ${fmt(w)} ${fmt(h)} l`, open: true };
    case "curvedConnector3": return { d: `0 0 m ${fmt(w / 2)} 0 ${fmt(w / 2)} ${fmt(h)} ${fmt(w)} ${fmt(h)} c`, open: true };
    case "triangle": case "flowChartExtract": return { d: polyPath([[w * a("adj", 50000), 0], [w, h], [0, h]]) };
    case "rtTriangle": return { d: polyPath([[0, 0], [w, h], [0, h]]) };
    case "diamond": case "flowChartDecision": return { d: polyPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
    case "parallelogram": case "flowChartInputOutput": { const x = m * a("adj", 25000); return { d: polyPath([[x, 0], [w, 0], [w - x, h], [0, h]]) }; }
    case "trapezoid": case "flowChartManualOperation": { const x = m * a("adj", 25000); return { d: polyPath([[x, 0], [w - x, 0], [w, h], [0, h]]) }; }
    case "pentagon": return { d: polyPath([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]) };
    case "hexagon": case "flowChartPreparation": { const x = m * a("adj", 25000); return { d: polyPath([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]) }; }
    case "octagon": { const x = m * a("adj", 29289); return { d: polyPath([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]) }; }
    case "homePlate": { const x = Math.min(w, h * a("adj", 50000)); return { d: polyPath([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]]) }; }
    case "chevron": { const x = Math.min(w, h * a("adj", 50000)); return { d: polyPath([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]) }; }
    case "rightArrow": case "notchedRightArrow": { const t = h * (1 - a("adj1", 50000)) / 2, x = Math.min(w, h * a("adj2", 50000)); return { d: polyPath([[0, t], [w - x, t], [w - x, 0], [w, h / 2], [w - x, h], [w - x, h - t], [0, h - t]]) }; }
    case "leftArrow": { const t = h * (1 - a("adj1", 50000)) / 2, x = Math.min(w, h * a("adj2", 50000)); return { d: polyPath([[w, t], [x, t], [x, 0], [0, h / 2], [x, h], [x, h - t], [w, h - t]]) }; }
    case "downArrow": { const t = w * (1 - a("adj1", 50000)) / 2, y = Math.min(h, w * a("adj2", 50000)); return { d: polyPath([[t, 0], [w - t, 0], [w - t, h - y], [w, h - y], [w / 2, h], [0, h - y], [t, h - y]]) }; }
    case "upArrow": { const t = w * (1 - a("adj1", 50000)) / 2, y = Math.min(h, w * a("adj2", 50000)); return { d: polyPath([[t, h], [w - t, h], [w - t, y], [w, y], [w / 2, 0], [0, y], [t, y]]) }; }
    case "plus": case "mathPlus": { const x = m * a("adj", 25000); return { d: polyPath([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]]) }; }
    case "star4": case "star5": case "star6": case "star8": case "star10": case "star12": case "star16": case "star24": case "star32": {
      const n = num(prst.slice(4), 5), pts = [], cx = w / 2, cy = h / 2, inner = a("adj", 38196) * 0.5 + 0.2;
      for (let i = 0; i < 2 * n; i++) { const r = i % 2 ? inner : 1, t = -Math.PI / 2 + (i * Math.PI) / n; pts.push([cx + Math.cos(t) * cx * r, cy + Math.sin(t) * cy * r]); }
      return { d: polyPath(pts) };
    }
    case "heart": return { d: `${fmt(w / 2)} ${fmt(h)} m 0 ${fmt(h * 0.45)} 0 0 ${fmt(w * 0.25)} 0 c ${fmt(w * 0.4)} 0 ${fmt(w / 2)} ${fmt(h * 0.15)} ${fmt(w / 2)} ${fmt(h * 0.25)} c ${fmt(w / 2)} ${fmt(h * 0.15)} ${fmt(w * 0.6)} 0 ${fmt(w * 0.75)} 0 c ${fmt(w)} 0 ${fmt(w)} ${fmt(h * 0.45)} ${fmt(w / 2)} ${fmt(h)} c h` };
    case "wedgeEllipseCallout": return { d: ellipsePath(0, 0, w, h * 0.85) };
    default: return { d: `0 0 ${fmt(w)} ${fmt(h)} re` }; // rect, callouts, flow-chart boxes, anything unknown
  }
}

/** Custom geometry (a:custGeom) → PDF path in the local box. */
function customPath(src, geom, w, h) {
  const out = [];
  let anyFill = false, anyStroke = false;
  for (const path of findAll(geom, (k) => k.name === "path")) {
    const pw = num(xmlAttr(src, path, "w"), 0) || w / EMU_PT, ph = num(xmlAttr(src, path, "h"), 0) || h / EMU_PT;
    const sx = w / pw, sy = h / ph;
    if (xmlAttr(src, path, "fill") !== "none") anyFill = true;
    if (xmlAttr(src, path, "stroke") !== "0" && xmlAttr(src, path, "stroke") !== "false") anyStroke = true;
    const pts = (el) => kidsNamed(el, "pt").map((p) => [num(xmlAttr(src, p, "x")) * sx, num(xmlAttr(src, p, "y")) * sy]);
    let cur = [0, 0];
    for (const c of path.kids || []) {
      if (c.name === "moveto") { const [p] = pts(c); if (p) { out.push(`${fmt(p[0])} ${fmt(p[1])} m`); cur = p; } }
      else if (c.name === "lnto") { const [p] = pts(c); if (p) { out.push(`${fmt(p[0])} ${fmt(p[1])} l`); cur = p; } }
      else if (c.name === "cubicbezto") { const p = pts(c); if (p.length === 3) { out.push(`${p.map((q) => `${fmt(q[0])} ${fmt(q[1])}`).join(" ")} c`); cur = p[2]; } }
      else if (c.name === "quadbezto") {
        const p = pts(c);
        if (p.length === 2) { const c1 = [cur[0] + (2 / 3) * (p[0][0] - cur[0]), cur[1] + (2 / 3) * (p[0][1] - cur[1])], c2 = [p[1][0] + (2 / 3) * (p[0][0] - p[1][0]), p[1][1] + (2 / 3) * (p[0][1] - p[1][1])]; out.push(`${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p[1][0])} ${fmt(p[1][1])} c`); cur = p[1]; }
      } else if (c.name === "arcto") {
        // an elliptical arc from the current point: approximated by a Bézier through its end point
        const wr = num(xmlAttr(src, c, "wR")) * sx, hr = num(xmlAttr(src, c, "hR")) * sy, st = num(xmlAttr(src, c, "stAng")) / 60000, sw = num(xmlAttr(src, c, "swAng")) / 60000;
        const a0 = (st * Math.PI) / 180, a1 = ((st + sw) * Math.PI) / 180;
        const cx = cur[0] - wr * Math.cos(a0), cy = cur[1] - hr * Math.sin(a0);
        const steps = Math.max(1, Math.ceil(Math.abs(sw) / 90));
        for (let i = 0; i < steps; i++) {
          const t0 = a0 + ((a1 - a0) * i) / steps, t1 = a0 + ((a1 - a0) * (i + 1)) / steps, k = (4 / 3) * Math.tan((t1 - t0) / 4);
          const p0 = [cx + wr * Math.cos(t0), cy + hr * Math.sin(t0)], p3 = [cx + wr * Math.cos(t1), cy + hr * Math.sin(t1)];
          const p1 = [p0[0] - k * wr * Math.sin(t0), p0[1] + k * hr * Math.cos(t0)], p2 = [p3[0] + k * wr * Math.sin(t1), p3[1] - k * hr * Math.cos(t1)];
          out.push(`${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p3[0])} ${fmt(p3[1])} c`);
          cur = p3;
        }
      } else if (c.name === "close") out.push("h");
    }
  }
  return { d: out.join("\n"), noFill: !anyFill, noStroke: !anyStroke };
}

/** The shape's geometry as a path, with its adjust values. */
function shapePath(src, spPr, w, h) {
  const prst = spPr && firstNamed(spPr, "prstgeom"), cust = spPr && firstNamed(spPr, "custgeom");
  if (cust) return customPath(src, cust, w, h);
  const adj = {};
  if (prst) for (const gd of findAll(prst, (k) => k.name === "gd")) {
    const m = /^val\s+(-?\d+)/.exec(xmlAttr(src, gd, "fmla") || "");
    if (m) adj[xmlAttr(src, gd, "name")] = Number(m[1]);
  }
  return presetPath(prst ? xmlAttr(src, prst, "prst") : "rect", w, h, adj);
}

/** Transform of an xfrm (a:xfrm / p:xfrm): local box (0..w, 0..h in pt) → parent space; plus w, h. */
function xfrmOf(src, xfrm) {
  if (!xfrm) return null;
  const off = firstNamed(xfrm, "off"), ext = firstNamed(xfrm, "ext");
  if (!off || !ext) return null;
  const x = num(xmlAttr(src, off, "x")) * EMU_PT, y = num(xmlAttr(src, off, "y")) * EMU_PT;
  const w = num(xmlAttr(src, ext, "cx")) * EMU_PT, h = num(xmlAttr(src, ext, "cy")) * EMU_PT;
  const rot = num(xmlAttr(src, xfrm, "rot")) / 60000, flipH = xmlAttr(src, xfrm, "flipH") === "1", flipV = xmlAttr(src, xfrm, "flipV") === "1";
  let m = mtranslate(x + w / 2, y + h / 2);
  if (rot) m = mmul(m, mrotate(rot));
  if (flipH || flipV) m = mmul(m, mscale(flipH ? -1 : 1, flipV ? -1 : 1));
  m = mmul(m, mtranslate(-w / 2, -h / 2));
  const chOff = firstNamed(xfrm, "choff"), chExt = firstNamed(xfrm, "chext");
  if (chOff && chExt) { // a group: its children's coordinates are scaled into the group's box
    const cw = num(xmlAttr(src, chExt, "cx")) * EMU_PT, ch = num(xmlAttr(src, chExt, "cy")) * EMU_PT;
    m = mmul(m, mscale(cw ? w / cw : 1, ch ? h / ch : 1));
    m = mmul(m, mtranslate(-num(xmlAttr(src, chOff, "x")) * EMU_PT, -num(xmlAttr(src, chOff, "y")) * EMU_PT));
  }
  return { m, w, h, rot, flipH, flipV };
}

/* ---------------------------------------------------------------- the renderer */

const FONT_FAMILY = (typeface) => (/times|georgia|cambria|garamond|antiqua|palatino|baskerville|bodoni|century|minion|serif/i.test(typeface || "") && !/sans/i.test(typeface || "") ? "serif" : /courier|consolas|mono|menlo/i.test(typeface || "") ? "monospace" : "sans-serif");

class SlideRenderer {
  constructor(doc, fk, images, deck, sl, segs, translations, segsByFile = new Map()) {
    this.doc = doc; this.fk = fk; this.images = images; this.deck = deck; this.sl = sl; this.translations = translations;
    this.segs = segs; // this slide's segments, in document order
    this.segsByFile = segsByFile;
    this.ops = []; this.used = new Set(); this.xobjs = new Map();
    this.scheme = colorScheme(sl);
    this.paper = "#ffffff";
    this.W = deck.sldCx * EMU_PT; this.H = deck.sldCy * EMU_PT;
    this.themeFonts = this.fontScheme();
  }
  ctx(phClr) { return { scheme: this.scheme, paper: this.paper, phClr }; }

  fontScheme() {
    const t = this.sl.theme, out = { major: "sans-serif", minor: "sans-serif" };
    if (!t) return out;
    for (const key of ["major", "minor"]) {
      const el = findAll(t.root, (k) => k.name === `${key}font`)[0], latin = el && firstNamed(el, "latin");
      if (latin) out[key] = FONT_FAMILY(xmlAttr(t.src, latin, "typeface"));
    }
    return out;
  }

  /* ---- the page */

  render() {
    this.background();
    const sl = this.sl, cSld = findAll(sl.root, (k) => k.name === "csld")[0];
    const showMaster = !cSld || xmlAttr(sl.src, cSld, "showMasterSp") !== "0";
    if (showMaster) for (const p of [sl.master, sl.layout]) {
      const tree = p && findAll(p.root, (k) => k.name === "sptree")[0];
      if (tree) this.tree(p, tree, [1, 0, 0, 1, 0, 0], true);
    }
    const tree = findAll(sl.root, (k) => k.name === "sptree")[0];
    if (tree) this.tree(sl, tree, [1, 0, 0, 1, 0, 0], false);
    return this.ops.join("\n");
  }

  background() {
    const sl = this.sl;
    for (const p of [sl, sl.layout, sl.master]) {
      const bg = p && findAll(p.root, (k) => k.name === "bg")[0];
      if (!bg) continue;
      const pr = firstNamed(bg, "bgpr"), ref = firstNamed(bg, "bgref");
      let fill;
      if (pr) fill = fillOf(p.src, pr, this.ctx());
      else if (ref) {
        const idx = num(xmlAttr(p.src, ref, "idx")), st = themeStyle(sl, idx > 1000 ? "bgfillstylelst" : "fillstylelst", idx > 1000 ? idx - 1000 : idx);
        const phClr = firstColor(p.src, ref, this.ctx());
        if (st) fill = fillOf(st.src, { kids: [st.el] }, this.ctx(phClr));
        else if (phClr) fill = { color: phClr };
      }
      if (fill === undefined) continue;
      if (fill && fill.color) { this.paper = fill.color; this.ops.push(`q ${rg(fill.color)} 0 0 ${fmt(this.W)} ${fmt(this.H)} re f Q`); }
      if (fill && fill.image) this.picture(p, fill, [1, 0, 0, 1, 0, 0], this.W, this.H, null);
      return;
    }
  }

  /* ---- shapes */

  tree(part, el, m, inherited) {
    for (const k of el.kids || []) {
      if (!k.kids) continue;
      const nv = findAll(k, (x) => x.name === "cnvpr")[0];
      if (nv && xmlAttr(part.src, nv, "hidden") === "1") continue;
      const ph = findAll(k, (x) => x.name === "ph")[0];
      if (inherited && ph) continue; // placeholders of the master and layout are templates, not content
      if (k.name === "sp") this.shape(part, k, m, inherited);
      else if (k.name === "cxnsp") this.shape(part, k, m, inherited);
      else if (k.name === "pic") this.pic(part, k, m);
      else if (k.name === "grpsp") {
        const gp = firstNamed(k, "grpsppr"), xf = gp && xfrmOf(part.src, firstNamed(gp, "xfrm"));
        this.tree(part, k, xf ? mmul(m, xf.m) : m, inherited);
      } else if (k.name === "graphicframe") this.frame(part, k, m, inherited);
      else if (k.name === "alternatecontent") { const choice = firstNamed(k, "choice") || firstNamed(k, "fallback"); if (choice) this.tree(part, choice, m, inherited); }
    }
  }

  /** The layout's and master's placeholder matching a slide placeholder (same idx, else same type). */
  placeholderChain(src, ph) {
    const type = (xmlAttr(src, ph, "type") || "body").replace(/^ctrTitle$/, "title").replace(/^subTitle$/, "body"), idx = xmlAttr(src, ph, "idx");
    const find = (p, byIdx) => {
      if (!p) return null;
      for (const sp of findAll(p.root, (k) => k.name === "sp")) {
        const pph = findAll(sp, (x) => x.name === "ph")[0];
        if (!pph) continue;
        const pt = (xmlAttr(p.src, pph, "type") || "body").replace(/^ctrTitle$/, "title").replace(/^subTitle$/, "body");
        if (byIdx ? idx && xmlAttr(p.src, pph, "idx") === idx : pt === type) return { part: p, sp };
      }
      return null;
    };
    const chain = [];
    const lay = find(this.sl.layout, true) || find(this.sl.layout, false);
    if (lay) chain.push(lay);
    const mas = find(this.sl.master, false);
    if (mas) chain.push(mas);
    return { type, chain };
  }

  shape(part, sp, m, inherited) {
    const src = part.src, spPr = firstNamed(sp, "sppr");
    const ph = findAll(sp, (x) => x.name === "ph")[0];
    const inh = ph && !inherited ? this.placeholderChain(src, ph) : { type: "", chain: [] };
    let xf = spPr && xfrmOf(src, firstNamed(spPr, "xfrm"));
    if (!xf) for (const c of inh.chain) { const cp = firstNamed(c.sp, "sppr"); xf = cp && xfrmOf(c.part.src, firstNamed(cp, "xfrm")); if (xf) break; }
    if (!xf || xf.w < 0 || xf.h < 0) return;
    const M = mmul(m, xf.m), ctx = this.ctx();
    const style = firstNamed(sp, "style");
    // fill: the shape's own, else the theme fill its style refers to (placeholders: none)
    let fill = spPr ? fillOf(src, spPr, ctx) : undefined;
    if (fill === undefined && style && !ph) {
      const ref = firstNamed(style, "fillref"), idx = ref ? num(xmlAttr(src, ref, "idx")) : 0, st = themeStyle(this.sl, "fillstylelst", idx);
      const phClr = ref && firstColor(src, ref, ctx);
      if (st) fill = fillOf(st.src, { kids: [st.el] }, this.ctx(phClr)); else if (idx && phClr) fill = { color: phClr };
    }
    let line = spPr ? strokeOf(src, firstNamed(spPr, "ln"), ctx) : undefined;
    if ((line === undefined || (line && line.color === undefined)) && style && !ph) {
      const ref = firstNamed(style, "lnref"), idx = ref ? num(xmlAttr(src, ref, "idx")) : 0, st = themeStyle(this.sl, "lnstylelst", idx);
      const phClr = ref && firstColor(src, ref, ctx);
      if (st && idx) {
        const tl = strokeOf(st.src, st.el, this.ctx(phClr));
        if (line === undefined) line = tl; else if (tl) line.color = tl.color; else line = null;
      } else if (line) line.color = phClr || "#808080"; else line = null;
    } else if (line && line.color === undefined) line.color = "#808080";
    const geom = shapePath(src, spPr, xf.w, xf.h);
    const isLine = sp.name === "cxnsp" || geom.open;
    if (isLine && line === undefined) line = { width: 0.75, color: "#808080" };
    if (fill && fill.image) { this.ops.push(`q ${mfmt(M)} cm ${geom.d} W n`); this.picture(part, fill, [1, 0, 0, 1, 0, 0], xf.w, xf.h, null); this.ops.push("Q"); fill = undefined; }
    const doFill = fill && fill.color && !geom.noFill && !geom.open, doStroke = line && line.color && !geom.noStroke;
    if (doFill || doStroke) {
      const op = doFill && doStroke ? "B" : doFill ? "f" : "S";
      this.ops.push(`q ${mfmt(M)} cm ${doFill ? rg(fill.color) : ""} ${doStroke ? `${RG(line.color)} ${fmt(Math.max(0.3, line.width))} w` : ""} ${geom.d} ${op} Q`);
    }
    const body = firstNamed(sp, "txbody");
    if (body && !inherited) {
      const fontRef = style && firstNamed(style, "fontref");
      const refColor = fontRef ? firstColor(src, fontRef, ctx) : null;
      const refFont = fontRef && xmlAttr(src, fontRef, "idx") === "major" ? this.themeFonts.major : null;
      this.textBody(part, body, M, xf, inh, refColor, refFont);
    }
  }

  /* ---- pictures */

  image(target) {
    if (this.images.has(target)) return this.images.get(target);
    let entry = null;
    const bytes = this.deck.media.get(target);
    if (bytes) {
      try {
        const img = new M.Image(bytes);
        try { entry = { ref: this.doc.addImage(img), w: img.getWidth(), h: img.getHeight(), name: `Im${this.images.size}` }; } finally { free(img); }
      } catch (_) { entry = null; } // a format MuPDF cannot decode
    }
    this.images.set(target, entry);
    return entry;
  }

  /** Draw the picture of `fill` ({image: rId, crop}) into the box (0..w, 0..h) under `M`. */
  picture(part, fill, M, w, h, clipPath) {
    const rel = part.rels[fill.image];
    const entry = rel && this.image(rel.target);
    if (!entry) return;
    this.xobjs.set(entry.name, entry.ref);
    const [l, t, r, b] = fill.crop || [0, 0, 0, 0];
    const fx = Math.max(0.01, 1 - l - r), fy = Math.max(0.01, 1 - t - b);
    const fw = w / fx, fh = h / fy, x0 = -l * fw, y0 = -t * fh;
    this.ops.push(`q ${mfmt(M)} cm ${clipPath ? `${clipPath} W n` : `0 0 ${fmt(w)} ${fmt(h)} re W n`} ${fmt(fw)} 0 0 ${fmt(-fh)} ${fmt(x0)} ${fmt(y0 + fh)} cm /${entry.name} Do Q`);
  }

  pic(part, pic, m) {
    const src = part.src, spPr = firstNamed(pic, "sppr"), xf = spPr && xfrmOf(src, firstNamed(spPr, "xfrm"));
    if (!xf) return;
    const blipFill = firstNamed(pic, "blipfill");
    const fill = blipFill ? fillOf(src, { kids: [blipFill] }, this.ctx()) : null;
    const M = mmul(m, xf.m), geom = shapePath(src, spPr, xf.w, xf.h);
    if (fill && fill.image) this.picture(part, fill, M, xf.w, xf.h, geom.d);
    const line = spPr ? strokeOf(src, firstNamed(spPr, "ln"), this.ctx()) : undefined;
    if (line && line.color) this.ops.push(`q ${mfmt(M)} cm ${RG(line.color)} ${fmt(Math.max(0.3, line.width))} w ${geom.d} S Q`);
  }

  /* ---- tables, charts */

  frame(part, gf, m, inherited) {
    const src = part.src, xf = xfrmOf(src, firstNamed(gf, "xfrm"));
    if (!xf) return;
    const M = mmul(m, xf.m);
    const tbl = findAll(gf, (k) => k.name === "tbl")[0];
    if (tbl) { if (!inherited) this.table(part, tbl, M, xf); return; }
    const relIds = findAll(gf, (k) => k.name === "relids")[0];
    if (relIds && part.diagramData) { // SmartArt: the stored drawing of the diagram (shapes relative to the frame)
      const data = part.diagramData[xmlAttr(src, relIds, "r:dm") || ""];
      const d = data ? data.drawing : null;
      const tree = d && findAll(d.root, (k) => k.name === "sptree")[0];
      if (tree) { this.tree({ src: d.src, fi: -1, rels: d.rels, dgm: diagramTextMap(data, this.segsByFile.get(data.fi) || []) }, tree, M, false); return; }
    }
    // a chart, an embedded object: a quiet placeholder box
    this.ops.push(`q ${mfmt(M)} cm 0.95 0.95 0.95 rg 0.75 0.75 0.75 RG 0.75 w 0 0 ${fmt(xf.w)} ${fmt(xf.h)} re B Q`);
  }

  table(part, tbl, M, xf) {
    const src = part.src, ctx = this.ctx();
    const cols = kidsNamed(firstNamed(tbl, "tblgrid") || { kids: [] }, "gridcol").map((c) => num(xmlAttr(src, c, "w")) * EMU_PT);
    const rows = kidsNamed(tbl, "tr");
    const pr = firstNamed(tbl, "tblpr"), styleId = pr && firstNamed(pr, "tablestyleid");
    const accent = styleId ? TABLE_STYLE_ACCENT[plainOf(src, styleId.kids).trim()] : null;
    const firstRow = pr && xmlAttr(src, pr, "firstRow") === "1", bands = pr && xmlAttr(src, pr, "bandRow") === "1";
    const tblFill = pr ? fillOf(src, pr, ctx) : undefined;
    let y = 0;
    rows.forEach((tr, ri) => {
      const h = num(xmlAttr(src, tr, "h")) * EMU_PT;
      let x = 0, ci = 0;
      for (const tc of kidsNamed(tr, "tc")) {
        const span = num(xmlAttr(src, tc, "gridSpan"), 1), rowSpan = num(xmlAttr(src, tc, "rowSpan"), 1);
        const w = cols.slice(ci, ci + span).reduce((s, v) => s + v, 0);
        const merged = xmlAttr(src, tc, "hMerge") === "1" || xmlAttr(src, tc, "vMerge") === "1";
        if (!merged) {
          const ch = rowSpan > 1 ? rows.slice(ri, ri + rowSpan).reduce((s, r) => s + num(xmlAttr(src, r, "h")) * EMU_PT, 0) : h;
          const tcPr = firstNamed(tc, "tcpr");
          let fill = tcPr ? fillOf(src, tcPr, ctx) : undefined;
          if (fill === undefined && tblFill) fill = tblFill;
          let textColor = null, bold = false;
          if (fill === undefined && accent) {
            const base = this.scheme(accent);
            if (firstRow && ri === 0) { fill = { color: base }; textColor = "#ffffff"; bold = true; }
            else if (bands) { const [r, g, b] = hexRgb255(base); const t = (ri - (firstRow ? 1 : 0)) % 2 ? 0.8 : 0.6; fill = { color: rgbHex(255 - (255 - r) * (1 - t), 255 - (255 - g) * (1 - t), 255 - (255 - b) * (1 - t)) }; }
          }
          if (fill && fill.color) this.ops.push(`q ${mfmt(M)} cm ${rg(fill.color)} ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(ch)} re f Q`);
          const border = accent ? "#ffffff" : "#9a9a9a";
          this.ops.push(`q ${mfmt(M)} cm ${RG(border)} 0.75 w ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(ch)} re S Q`);
          const body = firstNamed(tc, "txbody");
          if (body) {
            const ins = (a, d) => (tcPr ? num(xmlAttr(src, tcPr, a), d) : d) * EMU_PT;
            const box = { x: x + ins("marL", 91440), y: y + ins("marT", 45720), w: w - ins("marL", 91440) - ins("marR", 91440), h: ch - ins("marT", 45720) - ins("marB", 45720) };
            const anchor = tcPr ? xmlAttr(src, tcPr, "anchor") || "t" : "t";
            this.paragraphs(part, body, M, box, { anchor, chain: [], type: "", defaultSize: 14, color: textColor, bold, scale: 1, wrap: true });
          }
        }
        x += w; ci += span;
      }
      y += h;
    });
  }

  /* ---- text */

  /** Paragraph/run properties inherited through the placeholder chain and the master's text styles. */
  inheritedProps(inh, level) {
    const out = [];
    const master = this.sl.master;
    if (master) {
      const styles = findAll(master.root, (k) => k.name === "txstyles")[0];
      const which = inh.type === "title" ? "titlestyle" : /^(body|obj|subTitle)$/.test(inh.type) || inh.type === "body" ? "bodystyle" : "otherstyle";
      const st = styles && (firstNamed(styles, which) || firstNamed(styles, "otherstyle"));
      const lvl = st && firstNamed(st, `lvl${level + 1}ppr`);
      if (lvl) out.push({ src: master.src, el: lvl });
      if (!inh.type) { const other = styles && firstNamed(styles, "otherstyle"), l2 = other && firstNamed(other, `lvl${level + 1}ppr`); if (l2 && l2 !== lvl) out.unshift({ src: master.src, el: l2 }); }
    }
    for (const c of [...inh.chain].reverse()) { // master placeholder first, then the layout's
      const body = firstNamed(c.sp, "txbody"), lst = body && firstNamed(body, "lststyle"), lvl = lst && firstNamed(lst, `lvl${level + 1}ppr`);
      if (lvl) out.push({ src: c.part.src, el: lvl });
    }
    return out;
  }

  /** Merge paragraph properties (pPr-like elements, least specific first) into one style. */
  paraStyle(list, base) {
    const st = { ...base };
    for (const { src, el } of list) {
      if (!el) continue;
      const algn = xmlAttr(src, el, "algn"); if (algn) st.align = algn;
      const marL = xmlAttr(src, el, "marL"); if (marL !== null) st.marL = num(marL) * EMU_PT;
      const indent = xmlAttr(src, el, "indent"); if (indent !== null) st.indent = num(indent) * EMU_PT;
      for (const k of el.kids || []) {
        if (k.name === "bunone") st.bullet = null;
        else if (k.name === "buchar") st.bullet = xmlAttr(src, k, "char") || "•";
        else if (k.name === "buautonum") st.bullet = "#";
        else if (k.name === "buclr") st.bulletColor = firstColor(src, k, this.ctx());
        else if (k.name === "lnspc") { const p = firstNamed(k, "spcpct"); if (p) st.lnSpc = num(xmlAttr(src, p, "val"), 100000) / 100000; const pts = firstNamed(k, "spcpts"); if (pts) st.lnSpcPts = num(xmlAttr(src, pts, "val")) / 100; }
        else if (k.name === "spcbef") { const p = firstNamed(k, "spcpts"); if (p) st.spcBef = num(xmlAttr(src, p, "val")) / 100; }
        else if (k.name === "spcaft") { const p = firstNamed(k, "spcpts"); if (p) st.spcAft = num(xmlAttr(src, p, "val")) / 100; }
        else if (k.name === "defrpr") this.runStyle(src, k, st);
      }
    }
    return st;
  }

  runStyle(src, rpr, st) {
    if (!rpr) return st;
    const sz = xmlAttr(src, rpr, "sz"); if (sz) st.size = num(sz) / 100;
    const b = xmlAttr(src, rpr, "b"); if (b !== null) st.bold = b === "1" || b === "true";
    const i = xmlAttr(src, rpr, "i"); if (i !== null) st.italic = i === "1" || i === "true";
    const c = fillOf(src, rpr, this.ctx()); if (c && c.color) st.color = c.color;
    const latin = firstNamed(rpr, "latin");
    if (latin) { const tf = xmlAttr(src, latin, "typeface") || ""; st.family = /^\+mj/.test(tf) ? this.themeFonts.major : /^\+mn/.test(tf) ? this.themeFonts.minor : FONT_FAMILY(tf); }
    return st;
  }

  /** Text shown for a paragraph: its segments' translation or text; else its plain text (fields). */
  paraText(part, p) {
    const shown = (s) => unescapeMarkers(shownText((this.translations[s.id] || "").trim() || s.text, s.tags).replace(/<\/?\d+\/?>/g, ""));
    if (part.dgm) { // a diagram shape: its text is the data node's paragraph
      let sp = p.parent;
      while (sp && sp.name !== "sp") sp = sp.parent;
      const seg = sp && part.dgm.get(`${xmlAttr(part.src, sp, "modelId")}/${kidsNamed(p.parent, "p").indexOf(p)}`);
      if (seg) return shown(seg);
    }
    const segs = this.segs.filter((s) => s.file === part.fi && s.s >= p.s && s.e <= p.e);
    if (segs.length) {
      return segs.map((s) => {
        const raw = (this.translations[s.id] || "").trim() || s.text;
        return unescapeMarkers(shownText(raw, s.tags).replace(/<\/?\d+\/?>/g, ""));
      }).join("\n");
    }
    const parts = [];
    for (const k of p.kids || []) {
      if (k.name === "r" || k.name === "fld") { const t = firstNamed(k, "t"); if (t) parts.push(plainOf(part.src, t.kids)); }
      else if (k.name === "br") parts.push("\n");
    }
    return parts.join("");
  }

  textBody(part, body, M, xf, inh, refColor, refFont) {
    const src = part.src;
    const bodyPr = firstNamed(body, "bodypr") || { kids: [] };
    // insets and anchor: the shape's, else the placeholder's
    const attr = (name) => { let v = xmlAttr(src, bodyPr, name); if (v === null) for (const c of inh.chain) { const b = firstNamed(c.sp, "txbody"), bp = b && firstNamed(b, "bodypr"); v = bp ? xmlAttr(c.part.src, bp, name) : null; if (v !== null) break; } return v; };
    const ins = (name, d) => num(attr(name), d) * EMU_PT;
    const vert = attr("vert"), wrapNone = attr("wrap") === "none";
    let box = { x: ins("lIns", 91440), y: ins("tIns", 45720), w: xf.w - ins("lIns", 91440) - ins("rIns", 91440), h: xf.h - ins("tIns", 45720) - ins("bIns", 45720) };
    let Mt = M;
    if (vert === "vert" || vert === "vert270" || vert === "eaVert") { // the text runs down (or up) the box: turn it
      const ccw = vert === "vert270";
      Mt = mmul(M, mmul(mtranslate(xf.w / 2, xf.h / 2), mmul(mrotate(ccw ? -90 : 90), mtranslate(-xf.h / 2, -xf.w / 2))));
      box = { x: ins("tIns", 45720), y: ins("lIns", 91440), w: xf.h - ins("tIns", 45720) - ins("bIns", 45720), h: xf.w - ins("lIns", 91440) - ins("rIns", 91440) };
    }
    const auto = firstNamed(bodyPr, "normautofit");
    const scale = auto ? num(xmlAttr(src, auto, "fontScale"), 100000) / 100000 : 1;
    const defaultSize = inh.type === "title" ? 44 : inh.type ? 18 : 18;
    this.paragraphs(part, body, Mt, box, { anchor: attr("anchor") || "t", chain: inh.chain, type: inh.type, defaultSize, color: refColor, family: refFont, bold: false, scale, wrap: !wrapNone });
  }

  /**
   * Lay out and draw the paragraphs of a text body in `box` (local coordinates under `M`).
   * The text is shrunk when it does not fit the box (as PowerPoint's autofit does).
   */
  paragraphs(part, body, M, box, o) {
    const src = part.src, fk = this.fk;
    // Inside a scaled group the geometry is scaled but the text keeps its point size.
    const sx = Math.hypot(M[0], M[1]) || 1, sy = Math.hypot(M[2], M[3]) || 1;
    if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
      M = mmul(M, mscale(1 / sx, 1 / sy));
      box = { x: box.x * sx, y: box.y * sy, w: box.w * sx, h: box.h * sy };
    }
    const lst = firstNamed(body, "lststyle");
    const paras = [];
    for (const p of kidsNamed(body, "p")) {
      const pPr = firstNamed(p, "ppr");
      const level = pPr ? num(xmlAttr(src, pPr, "lvl")) : 0;
      const defaults = { align: "l", marL: 0, indent: 0, bullet: null, size: o.defaultSize, bold: o.bold, italic: false, color: o.color || this.scheme("tx1"), family: o.family || (o.type === "title" ? this.themeFonts.major : this.themeFonts.minor), lnSpc: 1, spcBef: 0, spcAft: 0 };
      const chain = [...this.inheritedProps({ type: o.type, chain: o.chain }, level)];
      const lvl = lst && firstNamed(lst, `lvl${level + 1}ppr`);
      if (lvl) chain.push({ src, el: lvl });
      if (pPr) chain.push({ src, el: pPr });
      const st = this.paraStyle(chain, defaults);
      if (o.color) st.color = o.color; // table header text
      const run = kidsNamed(p, "r")[0] || kidsNamed(p, "fld")[0];
      const rPr = run ? firstNamed(run, "rpr") : firstNamed(p, "endpararpr");
      this.runStyle(src, rPr, st);
      // a mixed paragraph: bold/italic are taken from the first run, the size from the largest run
      for (const r of kidsNamed(p, "r")) { const rp = firstNamed(r, "rpr"), sz = rp && xmlAttr(src, rp, "sz"); if (sz && num(sz) / 100 > st.size) st.size = num(sz) / 100; }
      const text = this.paraText(part, p);
      paras.push({ ...st, text, level });
    }
    if (!paras.some((p) => p.text.trim())) return;
    const lineH = (p, s) => (p.lnSpcPts ? p.lnSpcPts : 1.2 * s * (p.lnSpc || 1));
    const measure = (k) => {
      let height = 0;
      for (const p of paras) {
        const s = p.size * k;
        p.s = s;
        p.chain = fk.chain({ family: p.family, bold: p.bold, italic: p.italic }, p.text);
        p.tok = tokenize(p.text || " ", fk, p.chain);
        const avail = Math.max(1, box.w - p.marL) / s;
        p.lines = o.wrap ? wrap(p.tok, avail) : wrap(p.tok, 1e9);
        p.L = lineH(p, s);
        p.height = (paras.indexOf(p) ? p.spcBef : 0) + p.lines.length * p.L + p.spcAft;
        height += p.height;
      }
      return height;
    };
    let k = Math.min(1, o.scale || 1), height = measure(k);
    if (height > box.h + 0.5 && box.h > 4) {
      let lo = 0.25, hi = k;
      for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (measure(mid) <= box.h + 0.5) lo = mid; else hi = mid; }
      k = lo; height = measure(k);
    }
    let y = box.y + (o.anchor === "ctr" ? Math.max(0, (box.h - height) / 2) : o.anchor === "b" ? Math.max(0, box.h - height) : 0);
    const ops = [`q ${mfmt(M)} cm BT`];
    let curFont = null, curColor = null;
    const glyphRun = (glyphs, x, base, s, color) => {
      let run = null;
      const flush = () => {
        if (!run) return;
        if (curFont !== run.e) { ops.push(`/${run.e.res} 1 Tf`); curFont = run.e; }
        if (curColor !== run.color) { ops.push(rg(run.color)); curColor = run.color; }
        ops.push(`${fmt(s * run.scale)} 0 0 ${fmt(-s * run.scale)} ${fmt(run.x)} ${fmt(base)} Tm <${run.hex}> Tj`);
        run = null;
      };
      for (const g of glyphs) {
        const scale = g.scale || 1;
        if (g.own !== undefined) flush(); // (its advance differs from the font's own: positioned by itself)
        if (!run || run.e !== g.e || run.scale !== scale) { flush(); run = { e: g.e, color, scale, x: x - (g.own || 0) * s * scale, hex: "" }; fk.ref(g.e); this.used.add(g.e); }
        run.hex += g.gid.toString(16).padStart(4, "0");
        x += g.adv * s * scale;
        if (g.own !== undefined) flush();
      }
      flush();
      return x;
    };
    let number = 0;
    for (const [pi, p] of paras.entries()) {
      if (pi) y += p.spcBef;
      const s = p.s, L = p.L, x0 = box.x + p.marL, availW = Math.max(1, box.w - p.marL);
      p.lines.forEach((line, li) => {
        const base = y + (L - s) / 2 + 0.82 * s;
        const lw = line.w * s;
        let x = x0, extra = 0;
        if (p.align === "ctr") x = x0 + (availW - lw) / 2;
        else if (p.align === "r") x = x0 + availW - lw;
        else if ((p.align === "just" || p.align === "dist") && !line.last) { const gaps = line.tokens.filter((t, j) => j > 0 && t.sp).length; if (gaps) extra = Math.max(0, availW - lw) / gaps; }
        if (li === 0 && p.bullet && p.text.trim()) {
          number++;
          const mark = p.bullet === "#" ? `${number}.` : p.bullet;
          const bt = tokenize(mark, fk, p.chain);
          const bx = Math.max(box.x, x0 + Math.min(0, p.indent));
          if (bt.paras[0] && bt.paras[0][0]) glyphRun(bt.paras[0][0].glyphs, bx, base, s, p.bulletColor || p.color);
          if (p.indent > 0 && p.align === "l") x += p.indent;
        } else if (li === 0 && p.indent > 0 && p.align === "l") x += p.indent;
        for (const [j, t] of line.tokens.entries()) {
          if (j > 0 && t.sp) x += p.tok.spaceAdv * s + extra;
          x = glyphRun(t.glyphs, x, base, s, p.color);
        }
        y += L;
      });
      if (!p.bullet || p.bullet !== "#") number = p.bullet === "#" ? number : 0;
      y += p.spcAft;
    }
    ops.push("ET Q");
    this.ops.push(ops.join("\n"));
  }
}

/* ---------------------------------------------------------------- the document */

/** The slides as a PDF (one page per slide, then a page for each slide's notes). */
function renderSlides(book, segments, translations = {}, opts = {}) {
  const deck = book.deck;
  deck.slidePages = []; // page index of each slide (notes pages come between)
  const doc = new M.PDFDocument();
  const fk = new FontKit(doc, { fontMode: "auto" });
  const images = new Map();
  const W = deck.sldCx * EMU_PT, H = deck.sldCy * EMU_PT;
  try {
    const byFile = new Map();
    for (const s of segments) { if (!byFile.has(s.file)) byFile.set(s.file, []); byFile.get(s.file).push(s); }
    const addPage = (content, used, xobjs) => {
      const res = doc.newDictionary();
      if (used.size) { const fonts = doc.newDictionary(); for (const e of used) fonts.put(e.res, fk.ref(e)); res.put("Font", fonts); }
      if (xobjs.size) { const xo = doc.newDictionary(); for (const [name, ref] of xobjs) xo.put(name, ref); res.put("XObject", xo); }
      // drawn in page space (origin top left, y down), like the engine's other output
      const page = doc.addPage([0, 0, W, H], 0, res, `q 1 0 0 -1 0 ${fmt(H)} cm\n${content}\nQ`);
      doc.insertPage(-1, page);
      free(page);
    };
    for (const sl of deck.slides) {
      deck.slidePages.push(doc.countPages());
      if (!sl) { addPage("", new Set(), new Map()); continue; }
      const R = new SlideRenderer(doc, fk, images, deck, sl, (byFile.get(sl.fi) || []).sort((a, b) => a.s - b.s), translations, byFile);
      let content;
      try { content = R.render(); } catch (e) { content = R.ops.join("\n"); } // a damaged shape costs the rest of its slide, not the deck
      addPage(content, R.used, R.xobjs);
      // the slide's notes on a page of their own
      const notes = sl.notesFi >= 0 && opts.notes !== false ? (byFile.get(sl.notesFi) || []).filter((s) => /\S/.test(s.text)) : [];
      if (notes.length) {
        const N = new SlideRenderer(doc, fk, images, deck, sl, notes, translations);
        const text = notes.map((s) => unescapeMarkers(shownText((translations[s.id] || "").trim() || s.text, s.tags).replace(/<\/?\d+\/?>/g, ""))).join("\n");
        const body = { kids: [{ name: "p", kids: [], s: 0, e: 0 }] };
        N.paraText = () => text;
        N.paragraphs({ src: "", fi: sl.notesFi, rels: {} }, body, [1, 0, 0, 1, 0, 0], { x: 0.08 * W, y: 0.1 * H, w: 0.84 * W, h: 0.8 * H }, { anchor: "t", chain: [], type: "", defaultSize: 16, color: "#333333", bold: false, scale: 1, wrap: true });
        addPage(`q 0.97 0.97 0.97 rg 0 0 ${fmt(W)} ${fmt(H)} re f Q\n${N.ops.join("\n")}`, N.used, N.xobjs);
      }
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

/* ---------------------------------------------------------------- SmartArt text */

/** Presentation point id → data node id, from the data part of a diagram. */
function diagramNodeMap(data) {
  const map = new Map();
  for (const pt of findAll(data.root, (k) => k.name === "pt")) {
    if (xmlAttr(data.src, pt, "type") !== "pres") continue;
    const prSet = firstNamed(pt, "prset"), node = prSet && xmlAttr(data.src, prSet, "presAssocID");
    if (node) map.set(xmlAttr(data.src, pt, "modelId"), node);
  }
  return map;
}

/** "<drawing shape modelId>/<paragraph index>" → the data segment shown in that paragraph. */
function diagramTextMap(data, segs) {
  const nodes = diagramNodeMap(data), byNode = new Map();
  for (const s of segs) if (s.dgm) { if (!byNode.has(s.dgm.id)) byNode.set(s.dgm.id, []); byNode.get(s.dgm.id).push(s); }
  const map = new Map();
  for (const [pres, node] of nodes) for (const s of byNode.get(node) || []) map.set(`${pres}/${s.dgm.pi}`, s);
  for (const [node, list] of byNode) for (const s of list) map.set(`${node}/${s.dgm.pi}`, s); // (a shape may carry the node id itself)
  return map;
}

/**
 * Write the translations of SmartArt text into the diagrams' stored drawings as well: PowerPoint
 * rebuilds a diagram from its data, other programs show the drawing. `changed` gets the new XML.
 */
function mirrorDiagramDrawings(book, segments, translations, changed, opts = {}) {
  const deck = book.deck;
  if (!deck) return;
  const plain = (s, tr) => unescapeMarkers(shownText(tr, s.tags).replace(/<\/?\d+\/?>/g, ""));
  for (const sl of deck.slides) {
    if (!sl || !sl.diagramData) continue;
    for (const data of Object.values(sl.diagramData)) {
      const d = data.drawing;
      if (!d) continue;
      const map = diagramTextMap(data, segments.filter((s) => s.file === data.fi));
      const edits = [];
      for (const sp of findAll(d.root, (k) => k.name === "sp")) {
        const id = xmlAttr(d.src, sp, "modelId"), body = findAll(sp, (k) => k.name === "txbody")[0];
        if (!id || !body) continue;
        kidsNamed(body, "p").forEach((p, pi) => {
          const seg = map.get(`${id}/${pi}`), tr = seg && (translations[seg.id] || "").trim();
          if (!tr) return;
          const text = opts.bilingual ? `${plain(seg, seg.text)}\n${plain(seg, tr)}` : plain(seg, tr);
          const pPr = firstNamed(p, "ppr"), endPr = firstNamed(p, "endpararpr");
          const run = kidsNamed(p, "r")[0], rPrEl = run && firstNamed(run, "rpr");
          const rPr = rPrEl ? d.src.slice(rPrEl.s, rPrEl.e) : endPr ? d.src.slice(endPr.s, endPr.e).replace(/endParaRPr/g, "rPr") : "";
          const runs = text.split("\n").map((line) => `<a:r>${rPr}<a:t>${escapeXmlText(line)}</a:t></a:r>`).join(`<a:br>${rPr}</a:br>`);
          edits.push({ s: p.cs, e: p.ce, text: (pPr ? d.src.slice(pPr.s, pPr.e) : "") + runs + (endPr ? d.src.slice(endPr.s, endPr.e) : "") });
        });
      }
      if (!edits.length) continue;
      edits.sort((a, b) => a.s - b.s);
      let out = "", pos = 0;
      for (const ed of edits) { out += d.src.slice(pos, ed.s) + ed.text; pos = ed.e; }
      out += d.src.slice(pos);
      changed.set(d.path, out);
    }
  }
}
