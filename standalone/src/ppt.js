// ======================================================================
// ppt.js: converter of the legacy PowerPoint binary format (.ppt of PowerPoint 97–2003, MS-PPT)
// to a .pptx package. Plain JavaScript without libraries, running in the engine's Web Worker (and
// in Node for the tests). Only the texts are converted: one <p:sp> per shape with text (title,
// body and subtitle placeholders are kept as placeholders), with paragraphs, bullets, alignment,
// bold/italic/underline, font size, font and colour of the runs, and the speaker notes. Pictures,
// lines, autoshapes without text, tables (converted as their text shapes), headers, footers,
// slide numbers, dates and the master slides' own texts are not converted.
// ======================================================================

const PPT_EMU = 1587.5; // EMU per master unit (1/576 inch)

// Record types of MS-PPT (RT_*) and of the OfficeArt drawing records (OfficeArt*) used here.
const PPT_RT = {
  Document: 0x03e8, DocumentAtom: 0x03e9, Slide: 0x03ee, SlideAtom: 0x03ef, Notes: 0x03f0, NotesAtom: 0x03f1,
  Environment: 0x03f2, SlidePersistAtom: 0x03f3, MainMaster: 0x03f8, FontCollection: 0x07d5, FontEntityAtom: 0x0fb7,
  PPDrawing: 0x040c, OEPlaceholderAtom: 0x0bc3, OutlineTextRefAtom: 0x0f9e, TextHeaderAtom: 0x0f9f,
  TextCharsAtom: 0x0fa0, StyleTextPropAtom: 0x0fa1, TextBytesAtom: 0x0fa8, SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5, CurrentUserAtom: 0x0ff6, PersistDirectoryAtom: 0x1772, CryptSession10Container: 0x2f14,
  SlideNumberMetaCharAtom: 0x0fd8, DateTimeMetaCharAtom: 0x0ff7, GenericDateMetaCharAtom: 0x0ff8, HeaderMetaCharAtom: 0x0ff9, FooterMetaCharAtom: 0x0ffa, RTFDateTimeMetaCharAtom: 0x0ffb,
  DgContainer: 0xf002, SpgrContainer: 0xf003, SpContainer: 0xf004, FSPGR: 0xf009, FSP: 0xf00a, FOPT: 0xf00b,
  ClientTextbox: 0xf00d, ChildAnchor: 0xf00f, ClientAnchor: 0xf010, ClientData: 0xf011, SecondaryFOPT: 0xf121, TertiaryFOPT: 0xf122,
};

/** The meta-character atoms: a field (slide number, date, header, footer) stands at a text position. */
const PPT_META_CHARS = new Set([PPT_RT.SlideNumberMetaCharAtom, PPT_RT.DateTimeMetaCharAtom, PPT_RT.GenericDateMetaCharAtom, PPT_RT.HeaderMetaCharAtom, PPT_RT.FooterMetaCharAtom, PPT_RT.RTFDateTimeMetaCharAtom]);
/** True when a text consists only of field characters (and white space): nothing to translate. */
const pptOnlyFields = (text, fields) => !text.split("").some((c, i) => !fields.includes(i) && c > " ");

const PPT_ERR_ENCRYPTED = "This PowerPoint file is encrypted and cannot be opened.";
const PPT_ERR_OLD = "This PowerPoint file is too old (PowerPoint 95 or earlier).";

/** Attribute value escaper (the name xmlAttr belongs to office.js). */
const pptAttr = (s) => escapeXmlText(String(s)).replace(/"/g, "&quot;");

/** The records between two offsets of a stream: {ver, inst, type, len, start, end, off}. */
function pptRecords(dv, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const vi = dv.getUint16(off, true), type = dv.getUint16(off + 2, true), len = dv.getUint32(off + 4, true);
    const s = off + 8;
    out.push({ ver: vi & 0xf, inst: vi >> 4, type, len, start: s, end: Math.min(s + len, end), off });
    off = s + len;
  }
  return out;
}

/** The child records of a container (none for an atom). */
const pptKids = (dv, r) => (r && r.ver === 0xf ? pptRecords(dv, r.start, r.end) : []);
const pptFind = (list, type) => list.find((r) => r.type === type) || null;

/** The first record of a type anywhere below a container (depth first). */
function pptFindDeep(dv, r, type) {
  for (const k of pptKids(dv, r)) {
    if (k.type === type) return k;
    const d = pptFindDeep(dv, k, type);
    if (d) return d;
  }
  return null;
}

/** The text of a TextCharsAtom / TextBytesAtom. */
function pptAtomText(doc, r) {
  const b = doc.subarray(r.start, r.end);
  return r.type === PPT_RT.TextCharsAtom ? utf16(b.subarray(0, b.length & ~1)) : cp1252(b);
}

/**
 * Decode a StyleTextPropAtom for a text of n characters: the paragraph runs (count, indent level,
 * bullet, alignment, margins) followed by the character runs (count, bold/italic/underline, font,
 * size, colour). Fields exist only when their mask bit is set.
 */
function pptParseStyle(bytes, n) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => (p + 2 <= bytes.length ? dv.getUint16(p, true) : 0);
  const i16 = (p) => (p + 2 <= bytes.length ? dv.getInt16(p, true) : 0);
  const u32 = (p) => (p + 4 <= bytes.length ? dv.getUint32(p, true) : 0);
  const pf = [], cf = [];
  let p = 0;
  for (let sum = 0; sum <= n && p + 10 <= bytes.length;) {
    const run = { count: u32(p), indent: u16(p + 4), mask: u32(p + 6) };
    p += 10;
    const m = run.mask;
    if (m & 0xf) { run.bulletFlags = u16(p); p += 2; }
    if (m & 0x80) { run.bulletChar = u16(p); p += 2; }
    if (m & 0x10) p += 2; // bullet font
    if (m & 0x40) p += 2; // bullet size
    if (m & 0x20) p += 4; // bullet colour
    if (m & 0x800) { run.align = u16(p); p += 2; }
    if (m & 0x1000) p += 2; // line spacing
    if (m & 0x2000) p += 2; // space before
    if (m & 0x4000) p += 2; // space after
    if (m & 0x100) { run.leftMargin = i16(p); p += 2; }
    if (m & 0x400) { run.indentPos = i16(p); p += 2; }
    if (m & 0x8000) p += 2; // default tab size
    if (m & 0x100000) { const c = u16(p); p += 2 + c * 4; } // tab stops
    if (m & 0x10000) p += 2; // font align
    if (m & 0xe0000) p += 2; // wrap flags
    if (m & 0x200000) p += 2; // text direction
    sum += run.count || 1;
    pf.push(run);
  }
  for (let sum = 0; sum <= n && p + 8 <= bytes.length;) {
    const run = { count: u32(p), mask: u32(p + 4) };
    p += 8;
    const m = run.mask;
    if (m & 0xffff) { run.style = u16(p); p += 2; }
    if (m & 0x10000) { run.fontRef = u16(p); p += 2; }
    if (m & 0x200000) p += 2; // old East Asian font
    if (m & 0x400000) p += 2; // ANSI font
    if (m & 0x800000) p += 2; // symbol font
    if (m & 0x20000) { run.size = u16(p); p += 2; }
    if (m & 0x40000) { run.color = u32(p); p += 4; }
    if (m & 0x80000) { run.position = i16(p); p += 2; }
    sum += run.count || 1;
    cf.push(run);
  }
  return { pf, cf };
}

/** The run of a list of runs holding the character position `pos`. */
function pptRunAt(runs, pos) {
  let sum = 0;
  for (const r of runs) { sum += r.count; if (pos < sum) return r; }
  return runs.length ? runs[runs.length - 1] : null;
}

/** <a:solidFill> for a PPT ColorIndexStruct (RGB only when the index byte says so); "" otherwise. */
function pptColorFill(color) {
  if (((color >>> 24) & 0xff) !== 0xfe) return "";
  const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff;
  if (r + g + b > 3 * 240) return ""; // (near-)white text would vanish on the white background of the new master
  return `<a:solidFill><a:srgbClr val="${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}"/></a:solidFill>`;
}

const PPT_BULLET_CHARS = new Set(["•", "–", "—", "◦", "▪", "■", "●", "○", "✓", "✔", "►", "▶", "➢", "→", "-", "*", "·"]);
const PPT_ALIGN = ["l", "ctr", "r", "just", "dist", "thaiDist", "justLow"];

/**
 * The <a:p> elements of a text: paragraphs are split at CR, 0x0B is a line break, other control
 * characters are dropped. `opts`: {bullets: default when the style does not say, fonts: names by
 * index}.
 */
function pptParagraphsXml(text, styleBytes, opts) {
  const style = styleBytes ? pptParseStyle(styleBytes, text.length) : { pf: [], cf: [] };
  const clean = (s) => s.replace(/\x1e/g, "‑").replace(/\x1f/g, "­").replace(/[\x00-\x08\x0a-\x1f]/g, "");
  const rPr = (run) => {
    let a = ' lang="en-US"';
    if (run && run.size) a += ` sz="${run.size * 100}"`;
    if (run && run.style !== undefined) {
      if (run.mask & 1) a += ` b="${run.style & 1 ? 1 : 0}"`;
      if (run.mask & 2) a += ` i="${run.style & 2 ? 1 : 0}"`;
      if (run.mask & 4) a += ` u="${run.style & 4 ? "sng" : "none"}"`;
    }
    if (run && run.position) a += ` baseline="${run.position > 0 ? 30000 : -25000}"`;
    const fill = run && run.color !== undefined ? pptColorFill(run.color) : "";
    const font = run && run.fontRef !== undefined && opts.fonts[run.fontRef] ? `<a:latin typeface="${pptAttr(opts.fonts[run.fontRef])}"/>` : "";
    return `<a:rPr${a}${fill || font ? `>${fill}${font}</a:rPr>` : "/>"}`;
  };
  const out = [];
  // Paragraphs end at CR (or LF, CR LF); the positions stay those of the style runs.
  const paras = [];
  for (let pos = 0; pos <= text.length;) {
    const m = /\r\n|\r|\n/g; m.lastIndex = pos;
    const hit = m.exec(text);
    const end = hit ? hit.index : text.length;
    paras.push([pos, end]);
    if (!hit) break;
    pos = end + hit[0].length;
    if (pos === text.length) break; // a trailing CR does not start a paragraph
  }
  for (const [start, end] of paras) {
    const para = text.slice(start, end);
    const pf = pptRunAt(style.pf, start);
    // Paragraph properties: level, bullet, alignment, margins.
    let pPr = "", inner = "";
    const lvl = pf && pf.indent > 0 && pf.indent < 9 ? pf.indent : 0;
    if (lvl) pPr += ` lvl="${lvl}"`;
    const hasBullet = pf && pf.bulletFlags !== undefined ? !!(pf.bulletFlags & 1) : opts.bullets;
    if (pf && pf.leftMargin !== undefined) {
      const marL = Math.max(0, Math.round(pf.leftMargin * PPT_EMU));
      pPr += ` marL="${marL}"`;
      if (pf.indentPos !== undefined) pPr += ` indent="${Math.round(pf.indentPos * PPT_EMU) - marL}"`;
    } else if (hasBullet) pPr += ` marL="${342900 * (lvl + 1)}" indent="-342900"`;
    if (pf && pf.align !== undefined && PPT_ALIGN[pf.align]) pPr += ` algn="${PPT_ALIGN[pf.align]}"`;
    if (hasBullet) {
      const ch = pf && pf.bulletChar ? String.fromCharCode(pf.bulletChar) : "•";
      inner += `<a:buChar char="${pptAttr(PPT_BULLET_CHARS.has(ch) ? ch : "•")}"/>`;
    } else inner += "<a:buNone/>";
    const pPrXml = `<a:pPr${pPr}>${inner}</a:pPr>`;
    // Character runs intersecting the paragraph; a run is split at line breaks.
    const runs = [];
    let sum = 0, any = false;
    for (const cf of style.cf) {
      const rs = sum, re = sum + cf.count;
      sum = re;
      if (re <= start || rs >= end) continue;
      runs.push({ run: cf, text: text.slice(Math.max(rs, start), Math.min(re, end)) });
    }
    if (!runs.length) runs.push({ run: style.cf[0] || null, text: para });
    let body = "";
    for (const { run, text: t } of runs) {
      const pieces = t.split("\x0b");
      pieces.forEach((piece, i) => {
        if (i) body += "<a:br/>";
        const s = clean(piece);
        if (!s) return;
        any = true;
        body += `<a:r>${rPr(run)}<a:t>${escapeXmlText(s)}</a:t></a:r>`;
      });
    }
    const endRun = runs[runs.length - 1].run;
    out.push(any || body ? `<a:p>${pPrXml}${body}</a:p>` : `<a:p>${pPrXml}${rPr(endRun).replace("<a:rPr", "<a:endParaRPr").replace("</a:rPr>", "</a:endParaRPr>")}</a:p>`);
  }
  return out.join("");
}

// Placeholder ids (PlaceholderEnum) → OOXML placeholder types. Dates, footers, slide numbers,
// headers and the master's own placeholders are skipped (null).
const PPT_PLACEHOLDERS = { 13: "title", 14: "body", 15: "ctrTitle", 16: "subTitle", 17: "title", 18: "body", 12: "body" };
const PPT_PLACEHOLDER_SKIP = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
// OfficeArt shape types with a DrawingML preset of the same geometry.
const PPT_PRST = { 1: "rect", 2: "roundRect", 3: "ellipse", 4: "diamond", 5: "triangle", 6: "rtTriangle", 7: "parallelogram", 8: "trapezoid", 9: "hexagon", 10: "octagon", 11: "plus", 12: "star5", 13: "rightArrow", 16: "cube", 56: "pentagon", 61: "wedgeRectCallout", 62: "wedgeRRectCallout", 63: "wedgeEllipseCallout", 202: "rect" };

/** The property table(s) of a shape: {pid: value}. */
function pptShapeProps(dv, kids) {
  const props = {};
  for (const r of kids) {
    if (r.type !== PPT_RT.FOPT && r.type !== PPT_RT.SecondaryFOPT && r.type !== PPT_RT.TertiaryFOPT) continue;
    let p = r.start;
    for (let i = 0; i < r.inst && p + 6 <= r.end; i++, p += 6) {
      const pid = dv.getUint16(p, true);
      if (!(pid & 0x8000)) props[pid & 0x3fff] = dv.getUint32(p + 2, true); // (complex properties are skipped)
    }
  }
  return props;
}

/** <a:solidFill> for an OfficeArtCOLORREF that is a plain RGB value; "" otherwise. */
function pptRgbFill(v) {
  if (v === undefined || (v >>> 24) & 0xff) return "";
  return `<a:solidFill><a:srgbClr val="${[v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase()}"/></a:solidFill>`;
}

/**
 * The shapes with text of a drawing (PPDrawing of a slide or notes page): recursive walk of the
 * OfficeArt group containers. `texts` are the SlideListWithText texts the OutlineTextRefAtoms of
 * the shapes refer to. Returns [{anchor: [x, y, cx, cy] in EMU or null, ph: placeholder type or
 * null, phId, textType, text, style, props, shapeType}].
 */
function pptDrawingShapes(doc, dv, drawing, texts) {
  const out = [];
  const u32 = (o) => (o + 4 <= doc.length ? dv.getUint32(o, true) : 0);
  const i32 = (o) => (o + 4 <= doc.length ? dv.getInt32(o, true) : 0);
  const i16 = (o) => (o + 2 <= doc.length ? dv.getInt16(o, true) : 0);
  const masterMap = (l, t, r, b) => [l * PPT_EMU, t * PPT_EMU, (r - l) * PPT_EMU, (b - t) * PPT_EMU];
  const clientAnchor = (r) => {
    if (r.len >= 16) return masterMap(i32(r.start + 4), i32(r.start), i32(r.start + 8), i32(r.start + 12));
    if (r.len >= 8) return masterMap(i16(r.start + 2), i16(r.start), i16(r.start + 4), i16(r.start + 6));
    return null;
  };
  // `map` turns a child anchor (coordinates of the enclosing group) into EMU.
  const shape = (sp, map) => {
    const kids = pptKids(dv, sp);
    const fsp = pptFind(kids, PPT_RT.FSP);
    if (!fsp) return;
    const flags = u32(fsp.start + 4);
    if (flags & 0x8) return; // deleted
    let anchor = null;
    const ca = pptFind(kids, PPT_RT.ClientAnchor), cha = pptFind(kids, PPT_RT.ChildAnchor);
    if (ca) anchor = clientAnchor(ca);
    else if (cha && map) anchor = map(i32(cha.start), i32(cha.start + 4), i32(cha.start + 8), i32(cha.start + 12));
    let phId = 0, refIdx = -1, textType = 4, text = null, style = null, fields = [];
    const data = pptFind(kids, PPT_RT.ClientData), box = pptFind(kids, PPT_RT.ClientTextbox);
    for (const k of [...pptKids(dv, data), ...pptKids(dv, box)]) {
      if (k.type === PPT_RT.OEPlaceholderAtom && k.len >= 5) phId = doc[k.start + 4];
      else if (k.type === PPT_RT.OutlineTextRefAtom) refIdx = i32(k.start);
      else if (k.type === PPT_RT.TextHeaderAtom) textType = u32(k.start);
      else if (k.type === PPT_RT.TextCharsAtom || k.type === PPT_RT.TextBytesAtom) text = pptAtomText(doc, k);
      else if (k.type === PPT_RT.StyleTextPropAtom) style = doc.subarray(k.start, k.end);
      else if (PPT_META_CHARS.has(k.type)) fields.push(u32(k.start));
    }
    if (text === null && refIdx >= 0 && texts && texts[refIdx]) ({ text, style, type: textType, fields } = texts[refIdx]);
    if (text === null || pptOnlyFields(text, fields)) return; // no text: pictures, lines, autoshapes, date/number fields … are not converted
    if (PPT_PLACEHOLDER_SKIP.has(phId)) return;
    out.push({ anchor, ph: PPT_PLACEHOLDERS[phId] || null, phId, textType, text, style, props: pptShapeProps(dv, kids), shapeType: fsp.inst });
  };
  const group = (spgr, map) => {
    const kids = pptKids(dv, spgr);
    kids.forEach((k, i) => {
      if (k.type === PPT_RT.SpContainer) { if (i || !map) shape(k, map); } // (the first container of a group is the group shape itself)
      else if (k.type === PPT_RT.SpgrContainer) {
        // The group's own container gives its bounds in EMU (its anchor) and the coordinate
        // space of its children (OfficeArtFSPGR).
        const first = pptKids(dv, k)[0];
        const fk = first && first.type === PPT_RT.SpContainer ? pptKids(dv, first) : [];
        const spgrRec = pptFind(fk, PPT_RT.FSPGR), ca = pptFind(fk, PPT_RT.ClientAnchor), cha = pptFind(fk, PPT_RT.ChildAnchor);
        let bounds = ca ? clientAnchor(ca) : cha && map ? map(i32(cha.start), i32(cha.start + 4), i32(cha.start + 8), i32(cha.start + 12)) : null;
        let childMap = map || ((l, t, r, b) => masterMap(l, t, r, b));
        if (spgrRec && bounds) {
          const gl = i32(spgrRec.start), gt = i32(spgrRec.start + 4), gw = i32(spgrRec.start + 8) - gl, gh = i32(spgrRec.start + 12) - gt;
          const [bx, by, bw, bh] = bounds;
          if (gw > 0 && gh > 0) childMap = (l, t, r, b) => [bx + (l - gl) * bw / gw, by + (t - gt) * bh / gh, (r - l) * bw / gw, (b - t) * bh / gh];
        }
        group(k, childMap);
      }
    });
  };
  const dg = pptFind(pptKids(dv, drawing), PPT_RT.DgContainer);
  for (const k of pptKids(dv, dg)) {
    if (k.type === PPT_RT.SpgrContainer) group(k, null);
    else if (k.type === PPT_RT.SpContainer) shape(k, null);
  }
  return out;
}

/** The <p:sp> of a converted shape. */
function pptShapeXml(sh, id, slideW, slideH, fonts, phIdx) {
  const isTitle = sh.ph === "title" || sh.ph === "ctrTitle" || sh.textType === 0 || sh.textType === 7;
  let [x, y, cx, cy] = sh.anchor || (isTitle ? [457200, 274638, slideW - 914400, 1143000] : [457200, 1600200, slideW - 914400, Math.max(914400, slideH - 2057400)]);
  if (cx < 0) { x += cx; cx = -cx; }
  if (cy < 0) { y += cy; cy = -cy; }
  const r = (v) => Math.round(v);
  const body = sh.ph === "body" || sh.ph === "subTitle";
  const nv = sh.ph
    ? `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${sh.ph}"${body ? ` idx="${phIdx}"` : ""}/></p:nvPr>`
    : `<p:cNvSpPr txBox="1"/><p:nvPr/>`;
  const name = sh.ph ? { title: "Title", ctrTitle: "Title", subTitle: "Subtitle", body: "Content Placeholder" }[sh.ph] : "TextBox";
  const p = sh.props;
  const fillBools = p[0x1bf] || 0, lineBools = p[0x1ff] || 0;
  const fill = fillBools & 0x100000 && fillBools & 0x10 ? pptRgbFill(p[0x181]) : "";
  const line = lineBools & 0x80000 && lineBools & 0x8 ? `<a:ln>${pptRgbFill(p[0x1c0]) || '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>'}</a:ln>` : "";
  const wrap = p[0x85] === 2 ? "none" : "square";
  const anchorText = { 0: "t", 1: "ctr", 2: "b", 3: "t", 4: "ctr", 5: "b" }[p[0x87]];
  const bodyPr = `<a:bodyPr wrap="${wrap}"${anchorText ? ` anchor="${anchorText}"` : ""} rtlCol="0"/>`;
  // Bullets by default for body texts (the master styles of PowerPoint give them bullets).
  const bullets = sh.ph === "body" || [1, 6, 8, 9].includes(sh.textType);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id - 1}"/>${nv}</p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${r(x)}" y="${r(y)}"/><a:ext cx="${r(cx)}" cy="${r(cy)}"/></a:xfrm><a:prstGeom prst="${PPT_PRST[sh.shapeType] || "rect"}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>`
    + `<p:txBody>${bodyPr}<a:lstStyle/>${pptParagraphsXml(sh.text, sh.style, { bullets, fonts })}</p:txBody></p:sp>`;
}

const PPT_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PPT_XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PPT_REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const PPT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const pptRels = (list) => `${PPT_XML_HEAD}<Relationships ${PPT_REL_NS}>${list.map((r, i) => `<Relationship Id="rId${i + 1}" Type="${PPT_REL_TYPE}${r.type}" Target="${pptAttr(r.target)}"/>`).join("")}</Relationships>`;
const pptSpTreeHead = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const PPT_CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

/** A minimal theme (PowerPoint needs the three entries of every format list). */
function pptThemeXml(name) {
  const clr = ['<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>', '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>',
    "dk2:1F497D", "lt2:EEECE1", "accent1:4F81BD", "accent2:C0504D", "accent3:9BBB59", "accent4:8064A2", "accent5:4BACC6", "accent6:F79646", "hlink:0000FF", "folHlink:800080"]
    .map((s) => (s.startsWith("<") ? s : `<a:${s.split(":")[0]}><a:srgbClr val="${s.split(":")[1]}"/></a:${s.split(":")[0]}>`)).join("");
  const font = (tag, face) => `<a:${tag}><a:latin typeface="${face}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = (w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>`;
  return `${PPT_XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${pptAttr(name)}"><a:themeElements>`
    + `<a:clrScheme name="${pptAttr(name)}">${clr}</a:clrScheme>`
    + `<a:fontScheme name="${pptAttr(name)}">${font("majorFont", "Arial")}${font("minorFont", "Arial")}</a:fontScheme>`
    + `<a:fmtScheme name="${pptAttr(name)}"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${ln(9525)}${ln(25400)}${ln(38100)}</a:lnStyleLst>`
    + "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/** The title and body placeholders shared by the master and the layout. */
function pptMasterShapes(slideW, slideH) {
  const sp = (id, name, ph, x, y, cx, cy) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
  const m = Math.round(slideW / 20);
  return sp(2, "Title Placeholder 1", 'type="title"', m, Math.round(slideH * 0.04), slideW - 2 * m, Math.round(slideH * 0.17))
    + sp(3, "Text Placeholder 2", 'type="body" idx="1"', m, Math.round(slideH * 0.23), slideW - 2 * m, Math.round(slideH * 0.67));
}

function pptSlideMasterXml(slideW, slideH) {
  const lvl = (n, sz) => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return `${PPT_XML_HEAD}<p:sldMaster ${PPT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${pptSpTreeHead}${pptMasterShapes(slideW, slideH)}</p:spTree></p:cSld>${PPT_CLR_MAP}`
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`
    + `<p:bodyStyle>${lvl(1, 3200)}${lvl(2, 2800)}${lvl(3, 2400)}${lvl(4, 2000)}${lvl(5, 2000)}</p:bodyStyle><p:otherStyle>${lvl(1, 1800)}${lvl(2, 1800)}${lvl(3, 1800)}${lvl(4, 1800)}${lvl(5, 1800)}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

const pptSlideLayoutXml = (slideW, slideH) => `${PPT_XML_HEAD}<p:sldLayout ${PPT_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${pptSpTreeHead}${pptMasterShapes(slideW, slideH)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const pptNotesMasterXml = (w, h) => `${PPT_XML_HEAD}<p:notesMaster ${PPT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${pptSpTreeHead}`
  + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(w * 0.17)}" y="${Math.round(h * 0.08)}"/><a:ext cx="${Math.round(w * 0.66)}" cy="${Math.round(h * 0.37)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(w * 0.1)}" y="${Math.round(h * 0.48)}"/><a:ext cx="${Math.round(w * 0.8)}" cy="${Math.round(h * 0.42)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  + `</p:spTree></p:cSld>${PPT_CLR_MAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

/**
 * Convert an opened compound file holding a PowerPoint 97–2003 presentation into the parts of a
 * .pptx package ({path: xml}).
 */
async function pptToPptx(cfb) {
  const doc = cfb.stream("PowerPoint Document");
  const cu = cfb.stream("Current User");
  if (!doc || doc.length < 16) throw new Error(PPT_ERR_OLD);
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const u32 = (o) => (o >= 0 && o + 4 <= doc.length ? dv.getUint32(o, true) : 0);
  const i32 = (o) => (o >= 0 && o + 4 <= doc.length ? dv.getInt32(o, true) : 0);
  const recordAt = (off, type) => {
    if (off < 0 || off + 8 > doc.length) return null;
    const r = pptRecords(dv, off, Math.min(doc.length, off + 8 + u32(off + 4)))[0];
    return r && r.type === type ? r : null;
  };

  // --- Current User stream: the format token and the offset of the current UserEditAtom.
  let currentEdit = 0;
  if (cu && cu.length >= 24) {
    const cdv = new DataView(cu.buffer, cu.byteOffset, cu.byteLength);
    if (cdv.getUint16(2, true) === PPT_RT.CurrentUserAtom) {
      const token = cdv.getUint32(12, true);
      if (token === 0xf3d1c4df) throw new Error(PPT_ERR_ENCRYPTED);
      if (token !== 0xe391c05f) throw new Error(PPT_ERR_OLD);
      currentEdit = cdv.getUint32(16, true);
    } else throw new Error(PPT_ERR_OLD);
  }

  // --- Persist directory: the UserEditAtom chain from the current edit back to the first one; the
  // most recent definition of a persist object wins.
  const persist = new Map();
  let docRef = 0;
  const seen = new Set();
  for (let off = currentEdit; off && !seen.has(off);) {
    seen.add(off);
    const ue = recordAt(off, PPT_RT.UserEditAtom);
    if (!ue) break;
    if (!docRef) docRef = u32(ue.start + 16);
    if (ue.len >= 32 && u32(ue.start + 28)) throw new Error(PPT_ERR_ENCRYPTED);
    const dir = recordAt(u32(ue.start + 12), PPT_RT.PersistDirectoryAtom);
    for (let p = dir ? dir.start : 0; dir && p + 4 <= dir.end;) {
      const w = u32(p), id = w & 0xfffff, n = w >>> 20;
      for (let i = 0; i < n && p + 8 + i * 4 <= dir.end; i++) if (!persist.has(id + i)) persist.set(id + i, u32(p + 4 + i * 4));
      p += 4 + n * 4;
    }
    off = u32(ue.start + 8);
  }
  let docRec = docRef ? recordAt(persist.get(docRef), PPT_RT.Document) : null;
  if (!docRec) {
    // Recovery: scan the stream for the directories, the user edits and the document container.
    const top = pptRecords(dv, 0, doc.length);
    if (top.some((r) => r.type === PPT_RT.CryptSession10Container)) throw new Error(PPT_ERR_ENCRYPTED);
    for (const dir of top.filter((r) => r.type === PPT_RT.PersistDirectoryAtom)) {
      for (let p = dir.start; p + 4 <= dir.end;) {
        const w = u32(p), id = w & 0xfffff, n = w >>> 20;
        for (let i = 0; i < n && p + 8 + i * 4 <= dir.end; i++) persist.set(id + i, u32(p + 4 + i * 4));
        p += 4 + n * 4;
      }
    }
    const ue = top.filter((r) => r.type === PPT_RT.UserEditAtom).pop();
    docRec = (ue && recordAt(persist.get(u32(ue.start + 16)), PPT_RT.Document)) || top.filter((r) => r.type === PPT_RT.Document).pop() || null;
    if (!docRec) throw new Error(PPT_ERR_OLD);
  }
  const docKids = pptKids(dv, docRec);
  if (pptFind(docKids, PPT_RT.CryptSession10Container)) throw new Error(PPT_ERR_ENCRYPTED);

  // --- DocumentContainer: sizes, fonts, slide lists with their texts.
  const docAtom = pptFind(docKids, PPT_RT.DocumentAtom);
  const size = (o, dflt) => { const v = docAtom ? i32(docAtom.start + o) : 0; return v > 0 && v < 100000 ? Math.round(v * PPT_EMU) : dflt; };
  const slideW = size(0, 9144000), slideH = size(4, 6858000), notesW = size(8, 6858000), notesH = size(12, 9144000);
  const fonts = [];
  const env = pptFind(docKids, PPT_RT.Environment);
  const fontColl = env && pptFind(pptKids(dv, env), PPT_RT.FontCollection);
  for (const fe of fontColl ? pptKids(dv, fontColl) : []) {
    if (fe.type !== PPT_RT.FontEntityAtom) continue;
    const name = utf16(doc.subarray(fe.start, Math.min(fe.start + 64, fe.end))).replace(/\0.*$/s, "").trim();
    if (name) fonts.push(name); else fonts.push("");
  }
  // Slide lists: instance 0 slides, 1 masters, 2 notes. Entries: {persistIdRef, slideId, texts}.
  const slwt = { 0: [], 1: [], 2: [] };
  for (const list of docKids.filter((r) => r.type === PPT_RT.SlideListWithText)) {
    const entries = slwt[list.inst] || (slwt[list.inst] = []);
    let cur = null, text = null;
    for (const k of pptKids(dv, list)) {
      if (k.type === PPT_RT.SlidePersistAtom) { cur = { persistIdRef: u32(k.start), slideId: u32(k.start + 12), texts: [] }; entries.push(cur); text = null; }
      else if (k.type === PPT_RT.TextHeaderAtom) { text = { type: u32(k.start), text: "", style: null, fields: [] }; if (cur) cur.texts.push(text); }
      else if ((k.type === PPT_RT.TextCharsAtom || k.type === PPT_RT.TextBytesAtom) && text) text.text = pptAtomText(doc, k);
      else if (k.type === PPT_RT.StyleTextPropAtom && text) text.style = doc.subarray(k.start, k.end);
      else if (PPT_META_CHARS.has(k.type) && text) text.fields.push(u32(k.start));
    }
  }
  let slideEntries = slwt[0];
  if (!slideEntries.length) { // no slide list: the slide containers in the order of the directory
    slideEntries = [...persist.entries()].filter(([, off]) => recordAt(off, PPT_RT.Slide)).sort((a, b) => a[1] - b[1]).map(([id]) => ({ persistIdRef: id, slideId: 0, texts: [] }));
  }
  const notesByRef = new Map(slwt[2].map((e) => [e.slideId, e])); // notes slideId (= SlideAtom.notesIdRef) → entry

  // --- Slides and notes.
  const parts = {};
  const slideRels = [], noteParts = [];
  let slideNo = 0;
  for (const entry of slideEntries) {
    const slide = recordAt(persist.get(entry.persistIdRef), PPT_RT.Slide);
    if (!slide) continue;
    const kids = pptKids(dv, slide);
    const atom = pptFind(kids, PPT_RT.SlideAtom);
    const notesId = atom ? u32(atom.start + 16) : 0;
    slideNo++;
    const shapes = pptDrawingShapes(doc, dv, pptFind(kids, PPT_RT.PPDrawing), entry.texts);
    let id = 1, phIdx = 0;
    const sps = shapes.map((sh) => pptShapeXml(sh, ++id, slideW, slideH, fonts, sh.ph === "body" || sh.ph === "subTitle" ? ++phIdx : 0));
    const rels = [{ type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    // Notes page: through the notes list (instance 2) by the slide's notesIdRef, else by the
    // NotesAtom pointing back at the slide.
    let notes = notesId && notesByRef.has(notesId) ? recordAt(persist.get(notesByRef.get(notesId).persistIdRef), PPT_RT.Notes) : null;
    let notesEntry = notes ? notesByRef.get(notesId) : null;
    if (!notes && entry.slideId) {
      for (const [, off] of persist) {
        const n = recordAt(off, PPT_RT.Notes);
        const na = n && pptFind(pptKids(dv, n), PPT_RT.NotesAtom);
        if (na && u32(na.start) === entry.slideId) { notes = n; break; }
      }
    }
    if (notes) {
      const nshapes = pptDrawingShapes(doc, dv, pptFind(pptKids(dv, notes), PPT_RT.PPDrawing), notesEntry ? notesEntry.texts : [])
        .filter((sh) => sh.phId === 12 || sh.textType === 2 || !sh.ph);
      if (nshapes.length) {
        let nid = 1;
        const body = nshapes.map((sh) => {
          const paras = pptParagraphsXml(sh.text, sh.style, { bullets: false, fonts });
          const [x, y, cx, cy] = (sh.anchor || [notesW * 0.1, notesH * 0.48, notesW * 0.8, notesH * 0.42]).map(Math.round);
          return `<p:sp><p:nvSpPr><p:cNvPr id="${++nid}" name="Notes Placeholder ${nid - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="${nid + 1}"/></p:nvPr></p:nvSpPr>`
            + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.abs(cx)}" cy="${Math.abs(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
        }).join("");
        const n = noteParts.length + 1;
        parts[`ppt/notesSlides/notesSlide${n}.xml`] = `${PPT_XML_HEAD}<p:notes ${PPT_NS}><p:cSld><p:spTree>${pptSpTreeHead}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
        parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = pptRels([{ type: "notesMaster", target: "../notesMasters/notesMaster1.xml" }, { type: "slide", target: `../slides/slide${slideNo}.xml` }]);
        noteParts.push(n);
        rels.push({ type: "notesSlide", target: `../notesSlides/notesSlide${n}.xml` });
      }
    }
    parts[`ppt/slides/slide${slideNo}.xml`] = `${PPT_XML_HEAD}<p:sld ${PPT_NS}><p:cSld><p:spTree>${pptSpTreeHead}${sps.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${slideNo}.xml.rels`] = pptRels(rels);
    slideRels.push(slideNo);
  }
  if (!slideNo) throw new Error("No slides were found in this PowerPoint file.");

  // --- Presentation, master, layout, theme, package parts.
  const presRels = [{ type: "slideMaster", target: "slideMasters/slideMaster1.xml" }];
  const notesMasterRel = noteParts.length ? presRels.push({ type: "notesMaster", target: "notesMasters/notesMaster1.xml" }) : 0;
  const sldIds = slideRels.map((n, i) => { presRels.push({ type: "slide", target: `slides/slide${n}.xml` }); return `<p:sldId id="${256 + i}" r:id="rId${presRels.length}"/>`; });
  presRels.push({ type: "theme", target: "theme/theme1.xml" });
  parts["ppt/presentation.xml"] = `${PPT_XML_HEAD}<p:presentation ${PPT_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + (notesMasterRel ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${notesMasterRel}"/></p:notesMasterIdLst>` : "")
    + `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst><p:sldSz cx="${slideW}" cy="${slideH}"/><p:notesSz cx="${notesW}" cy="${notesH}"/>`
    + '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>';
  parts["ppt/_rels/presentation.xml.rels"] = pptRels(presRels);
  parts["ppt/slideMasters/slideMaster1.xml"] = pptSlideMasterXml(slideW, slideH);
  parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = pptRels([{ type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }, { type: "theme", target: "../theme/theme1.xml" }]);
  parts["ppt/slideLayouts/slideLayout1.xml"] = pptSlideLayoutXml(slideW, slideH);
  parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = pptRels([{ type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]);
  parts["ppt/theme/theme1.xml"] = pptThemeXml("Office Theme");
  if (noteParts.length) {
    parts["ppt/notesMasters/notesMaster1.xml"] = pptNotesMasterXml(notesW, notesH);
    parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = pptRels([{ type: "theme", target: "../theme/theme2.xml" }]);
    parts["ppt/theme/theme2.xml"] = pptThemeXml("Notes Theme");
  }
  parts["_rels/.rels"] = pptRels([{ type: "officeDocument", target: "ppt/presentation.xml" }]);
  const ctOf = { "ppt/presentation.xml": "presentationml.presentation.main", "ppt/slideMasters/": "presentationml.slideMaster", "ppt/slideLayouts/": "presentationml.slideLayout", "ppt/slides/": "presentationml.slide", "ppt/notesSlides/": "presentationml.notesSlide", "ppt/notesMasters/": "presentationml.notesMaster", "ppt/theme/": "drawingml.theme" };
  const overrides = Object.keys(parts).filter((p) => p.endsWith(".xml") && !p.includes("_rels/")).map((p) => {
    const key = Object.keys(ctOf).find((k) => p === k || (k.endsWith("/") && p.startsWith(k)));
    return `<Override PartName="/${pptAttr(p)}" ContentType="application/vnd.openxmlformats-officedocument.${ctOf[key]}+xml"/>`;
  });
  parts["[Content_Types].xml"] = `${PPT_XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`;
  return parts;
}
