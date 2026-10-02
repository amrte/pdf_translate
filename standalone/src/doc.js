// ======================================================================
// Word 97–2003 documents (.doc, the MS-DOC binary format): converted to a .docx package when
// such a file is opened. Text, paragraph and character formatting, styles, lists, tables,
// section properties, headers/footers, footnotes/endnotes and the text of text boxes are
// carried over. Pictures, drawings, OLE objects, comments, bookmarks and revision marks are
// not converted (the picture/anchor characters are dropped). Field codes are dropped and the
// field results are kept as text.
// ======================================================================

const DOC_W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const DOC_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.";

/** Windows-1252 characters of the bytes 0x80–0x9F, for decoders that leave them as C1 controls. */
const DOC_C1 = "\u20ac\x81\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\x8d\u017d\x8f\x90\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\x9d\u017e\u0178";
const docCp1252 = (bytes) => cp1252(bytes).replace(/[\x80-\x9f]/g, (c) => DOC_C1[c.charCodeAt(0) - 0x80]);

/** Text for an XML attribute value (illegal characters removed, & < > " escaped). */
const docAttr = (s) => escapeXmlText(String(s)).replace(/"/g, "&quot;");

/** Little-endian readers over a byte array; reads past the end give 0. */
function docReader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = bytes.length;
  return {
    u8: (o) => (o >= 0 && o < n ? bytes[o] : 0),
    u16: (o) => (o >= 0 && o + 2 <= n ? dv.getUint16(o, true) : 0),
    i16: (o) => (o >= 0 && o + 2 <= n ? dv.getInt16(o, true) : 0),
    u32: (o) => (o >= 0 && o + 4 <= n ? dv.getUint32(o, true) : 0),
    i32: (o) => (o >= 0 && o + 4 <= n ? dv.getInt32(o, true) : 0),
  };
}
const docU16 = (b, i = 0) => (b[i] | (b[i + 1] << 8)) >>> 0;
const docI16 = (b, i = 0) => ((docU16(b, i) << 16) >> 16);
const docI32 = (b, i = 0) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/**
 * The FIB (MS-DOC 2.5.1 and 2.5.5): the fields this converter needs. The FibRgFcLcb97 pairs
 * start at 0x9A; the index of each pair follows the specification's order.
 */
function docFib(wd) {
  const r = docReader(wd);
  const wIdent = r.u16(0), nFib = r.u16(2), flags = r.u16(0x0a);
  // 0xA5DC with nFib 0x65–0x68 is Word 6/95: a different layout that MS-DOC does not cover.
  if (wd.length < 0x200 || wIdent !== 0xa5ec || nFib < 0x00c1) throw new Error("This Word file is too old (Word 95 or earlier).");
  if (flags & 0x0100) throw new Error("This Word file is encrypted and cannot be opened.");
  const cbRgFcLcb = Math.max(r.u16(0x98), 93);
  const pair = (i) => (i < cbRgFcLcb ? [r.u32(0x9a + i * 8), r.u32(0x9e + i * 8)] : [0, 0]);
  return {
    nFib, whichTbl: (flags >> 9) & 1,
    fcMin: r.u32(0x18), fcMac: r.u32(0x1c),
    ccpText: r.u32(0x4c), ccpFtn: r.u32(0x50), ccpHdd: r.u32(0x54), ccpAtn: r.u32(0x5c), ccpEdn: r.u32(0x60),
    ccpTxbx: r.u32(0x64), ccpHdrTxbx: r.u32(0x68),
    stshf: pair(1), plcffndRef: pair(2), plcffndTxt: pair(3), plcfSed: pair(6), plcfhdd: pair(11),
    plcfBteChpx: pair(12), plcfBtePapx: pair(13), sttbfFfn: pair(15), dop: pair(31), clx: pair(33),
    plcSpaMom: pair(40), plcfendRef: pair(46), plcfendTxt: pair(47), plcftxbxTxt: pair(56),
    plfLst: pair(73), plfLfo: pair(74),
  };
}

/**
 * A PLC: n+1 CPs (or FCs) then n data items of cbData bytes. Some writers pad the structure, so
 * n is reduced until the positions are non-decreasing and do not exceed `max`.
 */
function docPlc(bytes, [fc, lcb], cbData, max = Infinity) {
  const r = docReader(bytes);
  if (!lcb || lcb < 4 || fc + lcb > bytes.length) return { cps: [], data: [] };
  let n = cbData ? Math.floor((lcb - 4) / (4 + cbData)) : Math.floor(lcb / 4) - 1;
  for (; n > 0; n--) {
    const cps = [];
    let ok = true;
    for (let i = 0; i <= n && ok; i++) { cps.push(r.u32(fc + i * 4)); if (i && cps[i] < cps[i - 1]) ok = false; }
    if (ok && cps[n] <= max) {
      const base = fc + (n + 1) * 4;
      return { cps, data: cbData ? cps.slice(0, n).map((_, i) => bytes.subarray(base + i * cbData, base + (i + 1) * cbData)) : [] };
    }
  }
  return { cps: [], data: [] };
}

/** Calls fn(opcode, operand) for each sprm of a grpprl; the operand of a variable-size sprm includes its size prefix. */
function docSprms(g, fn) {
  for (let i = 0; i + 2 <= g.length;) {
    const op = docU16(g, i), spra = op >> 13;
    let n;
    if (spra === 0 || spra === 1) n = 1;
    else if (spra === 2 || spra === 4 || spra === 5) n = 2;
    else if (spra === 3) n = 4;
    else if (spra === 7) n = 3;
    else if (op === 0xd608 || op === 0xd606) n = docU16(g, i + 2) + 1; // sprmTDefTable: 2-byte size, counted plus one
    else if (op === 0xc615 && g[i + 2] === 255) { // sprmPChgTabs with the long form
      const cDel = g[i + 3], cAdd = g[i + 4 + 4 * cDel];
      n = 3 + 4 * cDel + 3 * cAdd;
    } else n = g[i + 2] + 1;
    if (i + 2 + n > g.length) break;
    fn(op, g.subarray(i + 2, i + 2 + n));
    i += 2 + n;
  }
}

/** Border (Brc80, 4 bytes) → {val, sz, color} or null for no border. */
function docBrc80(b, i) {
  const width = b[i], type = b[i + 1], ico = b[i + 2];
  if (!type || (width === 0xff && type === 0xff)) return null;
  const val = { 1: "single", 2: "thick", 3: "double", 5: "single", 6: "dotted", 7: "dashed", 8: "dotDash", 9: "dotDotDash", 10: "triple" }[type] || "single";
  return { val, sz: width || 4, color: DOC_ICO[ico] || "auto" };
}
const DOC_ICO = ["auto", "000000", "0000FF", "00FFFF", "00FF00", "FF00FF", "FF0000", "FFFF00", "FFFFFF", "000080", "008080", "008000", "800080", "800000", "808000", "808080", "C0C0C0"];
const DOC_HIGHLIGHT = [null, "black", "blue", "cyan", "green", "magenta", "red", "yellow", "white", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray"];
const DOC_KUL = { 1: "single", 2: "words", 3: "double", 4: "dotted", 6: "thick", 7: "dash", 9: "dotDash", 10: "dotDotDash", 11: "wave", 20: "dottedHeavy", 23: "dashedHeavy", 25: "dashDotHeavy", 26: "dashDotDotHeavy", 27: "wavyHeavy", 39: "dashLong", 43: "wavyDouble", 55: "dashLongHeavy" };
const DOC_JC = ["left", "center", "right", "both", "distribute", "both", "both", "both", "both"];
const DOC_NFC = { 0: "decimal", 1: "upperRoman", 2: "lowerRoman", 3: "upperLetter", 4: "lowerLetter", 5: "ordinal", 6: "cardinalText", 7: "ordinalText", 22: "decimalZero", 23: "bullet", 255: "none" };
/** Style identifiers of the built-in styles (by sti), as Word writes them in .docx files. */
const DOC_STI_ID = { 0: "Normal", 1: "Heading1", 2: "Heading2", 3: "Heading3", 4: "Heading4", 5: "Heading5", 6: "Heading6", 7: "Heading7", 8: "Heading8", 9: "Heading9",
  29: "FootnoteText", 30: "CommentText", 31: "Header", 32: "Footer", 34: "Caption", 38: "FootnoteReference", 42: "EndnoteReference", 43: "EndnoteText",
  47: "List", 48: "ListBullet", 49: "ListNumber", 64: "Title", 65: "Closing", 66: "Signature", 67: "DefaultParagraphFont", 68: "BodyText", 69: "BodyTextIndent",
  70: "ListContinue", 76: "Subtitle", 77: "Salutation", 78: "Date", 82: "BodyText2", 83: "BodyText3", 87: "Hyperlink", 88: "FollowedHyperlink", 89: "Strong", 90: "Emphasis", 92: "PlainText" };

// ------------------------------------------------------------- properties

/** Applies a CHPX grpprl to `chp`; toggles of 128/129 take the value of `base` (the style's). */
function docApplyChpx(chp, g, base) {
  const toggle = (name, v) => {
    if (v === 0 || v === 1) chp[name] = v === 1;
    else if (v === 128) { if (name in base) chp[name] = base[name]; else delete chp[name]; }
    else if (v === 129) chp[name] = !base[name];
  };
  docSprms(g, (op, o) => {
    switch (op) {
      case 0x0835: toggle("b", o[0]); break;
      case 0x0836: toggle("i", o[0]); break;
      case 0x0837: toggle("strike", o[0]); break;
      case 0x0838: toggle("outline", o[0]); break;
      case 0x0839: toggle("shadow", o[0]); break;
      case 0x083a: toggle("smallCaps", o[0]); break;
      case 0x083b: toggle("caps", o[0]); break;
      case 0x083c: toggle("vanish", o[0]); break;
      case 0x0854: toggle("emboss", o[0]); break;
      case 0x0858: toggle("imprint", o[0]); break;
      case 0x0855: toggle("fSpec", o[0]); break;
      case 0x0800: chp.deleted = o[0] === 1; break; // text deleted with revision marks (0x0801 marks insertions)
      case 0x2a53: chp.dstrike = o[0] === 1; break;
      case 0x2a3e: chp.u = o[0]; break;
      case 0x4a43: chp.hps = docU16(o); break;
      case 0x4a61: chp.hpsBi = docU16(o); break;
      case 0x4a4f: chp.ftc = docU16(o); break;
      case 0x4a50: chp.ftcFE = docU16(o); break;
      case 0x4a51: chp.ftcOther = docU16(o); break;
      case 0x4a5e: chp.ftcBi = docU16(o); break;
      case 0x2a42: chp.ico = o[0]; delete chp.cv; break;
      case 0x6870: chp.cv = o[3] === 0xff ? "auto" : [o[0], o[1], o[2]].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase(); break;
      case 0x2a48: chp.iss = o[0]; break;
      case 0x2a0c: chp.highlight = o[0]; break;
      case 0x4a30: chp.istd = docU16(o); break;
      case 0x6a09: chp.symbol = { ftc: docU16(o, 0), ch: docU16(o, 2) }; break;
      default: break;
    }
  });
  return chp;
}

/** Applies a PAPX grpprl (paragraph and table sprms) to `pap`. */
function docApplyPapx(pap, g) {
  docSprms(g, (op, o) => {
    switch (op) {
      case 0x4600: pap.istd = docU16(o); break;
      case 0x2403: case 0x2461: pap.jc = o[0]; break;
      case 0x2416: pap.inTable = o[0] !== 0; break;
      case 0x244b: if (o[0]) pap.inTable = true; break; // inner cell of a nested table: flattened
      case 0x2417: pap.ttp = o[0] !== 0; break;
      case 0x244c: if (o[0]) pap.ttp = true; break;
      case 0x6649: pap.itap = docI32(o); break;
      case 0x260a: pap.ilvl = o[0]; break;
      case 0x460b: pap.ilfo = docU16(o); break;
      case 0x2640: pap.outLvl = o[0]; break;
      case 0x840f: case 0x845e: pap.dxaLeft = docI16(o); break;
      case 0x8411: case 0x8460: pap.dxaLeft1 = docI16(o); break;
      case 0x840e: case 0x845d: pap.dxaRight = docI16(o); break;
      case 0xa413: pap.dyaBefore = docU16(o); break;
      case 0xa414: pap.dyaAfter = docU16(o); break;
      case 0x6412: pap.lspd = { dyaLine: docI16(o, 0), fMult: docI16(o, 2) }; break;
      case 0x2405: pap.keep = o[0] !== 0; break;
      case 0x2406: pap.keepNext = o[0] !== 0; break;
      case 0x2407: pap.pageBreakBefore = o[0] !== 0; break;
      case 0x2441: pap.bidi = o[0] !== 0; break;
      case 0xd608: pap.tap = docTDefTable(o); break;
      case 0x5400: pap.tjc = docU16(o); break;
      case 0x9407: pap.rowHeight = docI16(o); break;
      case 0x3404: pap.tblHeader = o[0] !== 0; break;
      default: break;
    }
  });
  return pap;
}

/** sprmTDefTable operand → {centers (itcMac+1 twips), cells [{grf, borders}]}. */
function docTDefTable(o) {
  const itcMac = o[2], centers = [], cells = [];
  for (let i = 0; i <= itcMac; i++) centers.push(docI16(o, 3 + 2 * i));
  const base = 3 + 2 * (itcMac + 1);
  for (let i = 0; i < itcMac; i++) {
    const p = base + 20 * i;
    if (p + 20 > o.length) { cells.push({ grf: 0, borders: {} }); continue; }
    cells.push({ grf: docU16(o, p), borders: { top: docBrc80(o, p + 4), left: docBrc80(o, p + 8), bottom: docBrc80(o, p + 12), right: docBrc80(o, p + 16) } });
  }
  return { centers, cells };
}

/** Paragraph properties → the inside of w:pPr (elements in schema order). */
function docPPrXml(pap, styleId, numPr, extra = "") {
  let x = "";
  if (styleId) x += `<w:pStyle w:val="${docAttr(styleId)}"/>`;
  if (pap.keepNext) x += "<w:keepNext/>";
  if (pap.keep) x += "<w:keepLines/>";
  if (pap.pageBreakBefore) x += "<w:pageBreakBefore/>";
  if (numPr) x += numPr;
  if (pap.bidi) x += "<w:bidi/>";
  if (pap.dyaBefore !== undefined || pap.dyaAfter !== undefined || pap.lspd) {
    let s = "";
    if (pap.dyaBefore !== undefined) s += ` w:before="${pap.dyaBefore}"`;
    if (pap.dyaAfter !== undefined) s += ` w:after="${pap.dyaAfter}"`;
    if (pap.lspd && pap.lspd.dyaLine) {
      s += pap.lspd.fMult ? ` w:line="${pap.lspd.dyaLine}" w:lineRule="auto"`
        : ` w:line="${Math.abs(pap.lspd.dyaLine)}" w:lineRule="${pap.lspd.dyaLine < 0 ? "exact" : "atLeast"}"`;
    }
    if (s) x += `<w:spacing${s}/>`;
  }
  if (pap.dxaLeft !== undefined || pap.dxaRight !== undefined || pap.dxaLeft1 !== undefined) {
    let s = "";
    if (pap.dxaLeft !== undefined) s += ` w:left="${pap.dxaLeft}"`;
    if (pap.dxaRight !== undefined) s += ` w:right="${pap.dxaRight}"`;
    if (pap.dxaLeft1 !== undefined) s += pap.dxaLeft1 < 0 ? ` w:hanging="${-pap.dxaLeft1}"` : ` w:firstLine="${pap.dxaLeft1}"`;
    x += `<w:ind${s}/>`;
  }
  if (pap.jc !== undefined) x += `<w:jc w:val="${DOC_JC[pap.jc] || "left"}"/>`;
  if (pap.outLvl !== undefined && pap.outLvl < 9) x += `<w:outlineLvl w:val="${pap.outLvl}"/>`;
  return x + extra;
}

/** Character properties → the inside of w:rPr (elements in schema order). */
function docRPrXml(chp, fonts, styleId) {
  let x = "";
  const flag = (name, tag) => { if (name in chp) x += chp[name] ? `<w:${tag}/>` : `<w:${tag} w:val="0"/>`; };
  if (styleId) x += `<w:rStyle w:val="${docAttr(styleId)}"/>`;
  const font = (ftc) => (ftc !== undefined && fonts[ftc] ? docAttr(fonts[ftc]) : null);
  const ascii = font(chp.ftc), fe = font(chp.ftcFE), cs = font(chp.ftcBi);
  if (ascii || fe || cs) {
    x += "<w:rFonts" + (ascii ? ` w:ascii="${ascii}" w:hAnsi="${ascii}"` : "") + (fe ? ` w:eastAsia="${fe}"` : "") + (cs ? ` w:cs="${cs}"` : "") + "/>";
  }
  flag("b", "b"); if ("b" in chp) flag("b", "bCs");
  flag("i", "i"); if ("i" in chp) flag("i", "iCs");
  flag("caps", "caps"); flag("smallCaps", "smallCaps"); flag("strike", "strike"); flag("dstrike", "dstrike");
  flag("outline", "outline"); flag("shadow", "shadow"); flag("emboss", "emboss"); flag("imprint", "imprint"); flag("vanish", "vanish");
  if (chp.cv !== undefined) x += `<w:color w:val="${chp.cv}"/>`;
  else if (chp.ico !== undefined) x += `<w:color w:val="${DOC_ICO[chp.ico] || "auto"}"/>`;
  if (chp.hps !== undefined) x += `<w:sz w:val="${chp.hps}"/>`;
  if (chp.hpsBi !== undefined) x += `<w:szCs w:val="${chp.hpsBi}"/>`;
  else if (chp.hps !== undefined) x += `<w:szCs w:val="${chp.hps}"/>`;
  if (chp.highlight !== undefined) x += chp.highlight && DOC_HIGHLIGHT[chp.highlight] ? `<w:highlight w:val="${DOC_HIGHLIGHT[chp.highlight]}"/>` : "";
  if (chp.u !== undefined) x += `<w:u w:val="${chp.u ? DOC_KUL[chp.u] || "single" : "none"}"/>`;
  if (chp.iss) x += `<w:vertAlign w:val="${chp.iss === 1 ? "superscript" : "subscript"}"/>`;
  return x;
}

// -------------------------------------------------------------- the file

/**
 * Convert an opened compound file holding a Word 97–2003 document into the parts of a .docx
 * package: {path: xml string}. Throws for encrypted files and for Word 6/95 files.
 */
async function docToDocx(cfb) {
  const wd = cfb.stream("WordDocument");
  if (!wd) throw new Error("Not a Word document (no WordDocument stream).");
  const fib = docFib(wd);
  const tbl = cfb.stream(fib.whichTbl ? "1Table" : "0Table") || cfb.stream("1Table") || cfb.stream("0Table");
  if (!tbl) throw new Error("This Word file has no table stream and cannot be read.");
  const wr = docReader(wd), tr = docReader(tbl);

  // ---- text: the piece table (CLX → PlcPcd), one UTF-16 code unit per CP
  const pieces = [];
  {
    const [fcClx, lcbClx] = fib.clx;
    let off = fcClx, pcdt = -1, lcbPcdt = 0;
    while (off < fcClx + lcbClx && off < tbl.length) {
      const clxt = tbl[off];
      if (clxt === 1) off += 3 + tr.u16(off + 1);
      else if (clxt === 2) { lcbPcdt = tr.u32(off + 1); pcdt = off + 5; break; } else break;
    }
    const total = fib.ccpText + fib.ccpFtn + fib.ccpHdd + fib.ccpAtn + fib.ccpEdn + fib.ccpTxbx + fib.ccpHdrTxbx;
    if (pcdt >= 0 && lcbPcdt >= 16) {
      const n = Math.floor((lcbPcdt - 4) / 12);
      for (let i = 0; i < n; i++) {
        const cp = tr.u32(pcdt + i * 4), cpEnd = tr.u32(pcdt + (i + 1) * 4), fc = tr.u32(pcdt + (n + 1) * 4 + i * 8 + 2);
        const compressed = (fc & 0x40000000) !== 0;
        if (cpEnd > cp) pieces.push({ cp, cpEnd, fc: compressed ? (fc & 0x3fffffff) >>> 1 : fc & 0x3fffffff, compressed });
      }
    } else if (total) { // no piece table: the text is one run from fcMin
      pieces.push({ cp: 0, cpEnd: total, fc: fib.fcMin, compressed: fib.fcMac - fib.fcMin < total * 2 });
    }
  }
  let text = "";
  for (const p of pieces) {
    const len = p.cpEnd - p.cp, w = p.compressed ? 1 : 2;
    const bytes = wd.subarray(Math.min(p.fc, wd.length), Math.min(p.fc + len * w, wd.length));
    let s = p.compressed ? docCp1252(bytes) : utf16(bytes.subarray(0, bytes.length & ~1));
    if (!p.compressed && s.length < len && bytes.length >= 2 && docU16(bytes) === 0xfeff) s = "﻿" + s; // a BOM the decoder dropped
    if (s.length < len) s += " ".repeat(len - s.length);
    text += s.slice(0, len);
  }
  const cpTotal = text.length;
  /** File offset of a CP (the piece table maps CPs to the WordDocument stream). */
  const fcOf = (cp) => {
    let lo = 0, hi = pieces.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pieces[mid].cp <= cp) lo = mid; else hi = mid - 1; }
    const p = pieces[lo];
    return p ? p.fc + (Math.min(cp, p.cpEnd) - p.cp) * (p.compressed ? 1 : 2) : 0;
  };

  // ---- fonts (SttbfFfn: count, cbExtra, then FFN entries with a 1-byte size and the UTF-16 name at offset 40)
  const fonts = [];
  {
    let [off, lcb] = fib.sttbfFfn;
    const end = off + lcb;
    if (lcb > 4) {
      if (tr.u16(off) === 0xffff) off += 2;
      const count = tr.u16(off), cbExtra = tr.u16(off + 2);
      off += 4;
      for (let i = 0; i < count && off < end; i++) {
        const cb = tbl[off];
        let name = "";
        for (let p = off + 40; p + 1 < off + 1 + cb && p + 1 < end; p += 2) { const ch = tr.u16(p); if (!ch) break; name += String.fromCharCode(ch); }
        fonts.push(name);
        off += 1 + cb + cbExtra;
      }
    }
  }

  // ---- style sheet (STSH: STSHI, then LPStd entries; UPXs hold the style's own PAPX/CHPX)
  const styles = [];
  let defaultFtc = 0;
  {
    const [fc, lcb] = fib.stshf;
    if (lcb > 4) {
      const cbStshi = tr.u16(fc), stshi = fc + 2;
      const cstd = tr.u16(stshi), cbBase = tr.u16(stshi + 2) || 10;
      defaultFtc = tr.u16(stshi + 12);
      let off = stshi + cbStshi;
      for (let i = 0; i < cstd && off + 2 <= fc + lcb; i++) {
        const cbStd = tr.u16(off);
        off += 2;
        if (cbStd) {
          const o = off, end = Math.min(o + cbStd, tbl.length);
          const sti = tr.u16(o) & 0x0fff, stk = tr.u16(o + 2) & 0x0f, istdBase = tr.u16(o + 2) >> 4, cupx = tr.u16(o + 4) & 0x0f;
          let p = o + cbBase;
          const cch = tr.u16(p);
          const name = utf16(tbl.subarray(p + 2, Math.min(p + 2 + 2 * cch, end)));
          p += 4 + 2 * cch;
          if ((p - o) & 1) p++;
          const upx = [];
          for (let u = 0; u < cupx && p + 2 <= end; u++) {
            const cb = tr.u16(p);
            p += 2;
            upx.push(tbl.subarray(p, Math.min(p + cb, end)));
            p += cb + (cb & 1);
          }
          const style = { istd: i, sti, stk, istdBase, name, papx: null, chpx: null };
          if (stk === 1) { style.papx = upx[0] ? upx[0].subarray(2) : null; style.chpx = upx[1] || null; }
          else if (stk === 2) style.chpx = upx[0] || null;
          else if (stk === 3) { style.papx = upx[1] ? upx[1].subarray(2) : null; style.chpx = upx[2] || null; }
          else if (stk === 4) { style.papx = upx[0] ? upx[0].subarray(2) : null; style.chpx = upx[1] || null; }
          styles[i] = style;
        }
        off += cbStd;
      }
    }
  }
  const defaultChp = { hps: 20, ftc: defaultFtc };
  const styleChpCache = new Map(), stylePapCache = new Map();
  /** Character properties of a style, resolved through its base styles. */
  const styleChp = (istd, depth = 0) => {
    if (styleChpCache.has(istd)) return styleChpCache.get(istd);
    const st = styles[istd];
    let chp;
    if (!st || depth > 20) chp = { ...defaultChp };
    else {
      const base = st.istdBase !== 0x0fff && st.istdBase !== istd ? styleChp(st.istdBase, depth + 1) : defaultChp;
      chp = { ...base };
      if (st.chpx) docApplyChpx(chp, st.chpx, base);
    }
    styleChpCache.set(istd, chp);
    return chp;
  };
  const stylePap = (istd, depth = 0) => {
    if (stylePapCache.has(istd)) return stylePapCache.get(istd);
    const st = styles[istd];
    let pap;
    if (!st || depth > 20) pap = {};
    else {
      pap = { ...(st.istdBase !== 0x0fff && st.istdBase !== istd ? stylePap(st.istdBase, depth + 1) : {}) };
      if (st.papx) docApplyPapx(pap, st.papx);
    }
    stylePapCache.set(istd, pap);
    return pap;
  };
  // Style identifiers for the .docx: the built-in ones by sti, else from the name; unique.
  const styleIds = new Map(), usedIds = new Set();
  for (const st of styles) {
    if (!st || (st.stk !== 1 && st.stk !== 2)) continue;
    let id = (st.sti < 0x0ffe && DOC_STI_ID[st.sti]) || st.name.replace(/[^A-Za-z0-9]/g, "") || `Style${st.istd}`;
    if (usedIds.has(id)) id += st.istd;
    usedIds.add(id);
    styleIds.set(st.istd, id);
  }
  const styleId = (istd) => styleIds.get(istd) || null;

  // ---- lists (PlfLst: LSTFs then their LVLs; PlfLfo: LFOs referring to lists by lsid)
  const lists = [], lfos = [];
  {
    const [fc, lcb] = fib.plfLst;
    if (lcb > 2) {
      const cLst = tr.u16(fc);
      let off = fc + 2;
      for (let i = 0; i < cLst; i++, off += 28) lists.push({ lsid: tr.i32(off), simple: (tbl[off + 26] & 1) !== 0, levels: [] });
      for (const list of lists) {
        for (let l = 0; l < (list.simple ? 1 : 9) && off + 28 <= tbl.length; l++) {
          const lvl = { start: tr.i32(off), nfc: tbl[off + 4], jc: tbl[off + 5] & 3, follow: tbl[off + 15] };
          const cbChpx = tbl[off + 24], cbPapx = tbl[off + 25];
          off += 28;
          lvl.papx = tbl.subarray(off, off + cbPapx); off += cbPapx;
          lvl.chpx = tbl.subarray(off, off + cbChpx); off += cbChpx;
          const cch = tr.u16(off);
          lvl.text = utf16(tbl.subarray(off + 2, off + 2 + 2 * cch)); off += 2 + 2 * cch;
          list.levels.push(lvl);
        }
      }
    }
    const [fcLfo, lcbLfo] = fib.plfLfo;
    if (lcbLfo > 4) {
      const cLfo = tr.i32(fcLfo);
      for (let i = 0; i < cLfo && fcLfo + 4 + (i + 1) * 16 <= fcLfo + lcbLfo; i++) {
        const lsid = tr.i32(fcLfo + 4 + i * 16);
        lfos.push(lists.findIndex((l) => l.lsid === lsid));
      }
    }
  }
  /** w:numPr for a paragraph, or "" when its list level shows no label. */
  const numPrXml = (pap) => {
    const ilfo = pap.ilfo, ilvl = pap.ilvl || 0;
    if (!ilfo || ilfo > lfos.length || lfos[ilfo - 1] < 0) return "";
    const lvl = lists[lfos[ilfo - 1]].levels[ilvl];
    if (!lvl || lvl.nfc === 255 || !lvl.text) return "";
    return `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${ilfo}"/></w:numPr>`;
  };

  // ---- character runs: CHPX FKPs (via PlcfBteChpx) mapped from file offsets to CPs
  const runs = [];
  {
    const bte = docPlc(tbl, fib.plcfBteChpx, 4);
    const pageAt = (fc) => {
      let lo = 0, hi = bte.data.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bte.cps[mid] <= fc) lo = mid; else hi = mid - 1; }
      return lo;
    };
    for (const p of pieces) {
      const w = p.compressed ? 1 : 2, fcStart = p.fc, fcEnd = p.fc + (p.cpEnd - p.cp) * w;
      let cpDone = p.cp;
      for (let i = bte.data.length ? pageAt(fcStart) : bte.data.length; i < bte.data.length; i++) {
        const pn = docU16(bte.data[i]) | ((bte.data[i][2] & 0x3f) << 16), page = wd.subarray(pn * 512, pn * 512 + 512);
        if (page.length < 512) break;
        const pr = docReader(page), crun = page[511];
        let last = 0;
        for (let k = 0; k < crun; k++) {
          const fcA = pr.u32(k * 4), fcB = pr.u32(k * 4 + 4);
          last = fcB;
          if (fcB <= fcStart) continue;
          if (fcA >= fcEnd) break;
          const cpB = p.cp + Math.floor((Math.min(fcB, fcEnd) - fcStart) / w);
          const off = page[(crun + 1) * 4 + k] * 2;
          if (cpB > cpDone) { runs.push({ s: cpDone, e: cpB, chpx: off ? page.subarray(off + 1, off + 1 + page[off]) : null, cache: null }); cpDone = cpB; }
        }
        if (last >= fcEnd) break;
      }
      if (cpDone < p.cpEnd) runs.push({ s: cpDone, e: p.cpEnd, chpx: null, cache: null });
    }
  }
  const runAt = (cp) => {
    let lo = 0, hi = runs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (runs[mid].s <= cp) lo = mid; else hi = mid - 1; }
    return lo;
  };
  /** Direct character properties of a run, relative to the paragraph style (toggles resolved). */
  const runProps = (run, istd) => {
    if (!run.cache) run.cache = new Map();
    let r = run.cache.get(istd);
    if (r) return r;
    const chp = {};
    let base = styleChp(istd);
    if (run.chpx) {
      let cistd = -1;
      docSprms(run.chpx, (op, o) => { if (op === 0x4a30) cistd = docU16(o); });
      if (cistd >= 0 && styles[cistd] && styles[cistd].stk === 2) base = { ...base, ...styleChp(cistd) };
      docApplyChpx(chp, run.chpx, base);
    }
    const cs = chp.istd !== undefined ? styles[chp.istd] : null;
    const sid = cs && cs.stk === 2 && cs.sti !== 67 ? styleId(chp.istd) : null; // (67: "Default Paragraph Font")
    r = { chp, rpr: (() => { const x = docRPrXml(chp, fonts, sid); return x ? `<w:rPr>${x}</w:rPr>` : ""; })() };
    run.cache.set(istd, r);
    return r;
  };

  // ---- paragraph properties: PAPX FKPs (via PlcfBtePapx), looked up by the paragraph mark's offset
  const btePapx = docPlc(tbl, fib.plcfBtePapx, 4), papxPages = new Map();
  const papxAt = (fc) => {
    if (!btePapx.data.length) return { istd: 0, grpprl: null };
    let lo = 0, hi = btePapx.data.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (btePapx.cps[mid] <= fc) lo = mid; else hi = mid - 1; }
    const pn = docU16(btePapx.data[lo]) | ((btePapx.data[lo][2] & 0x3f) << 16);
    let page = papxPages.get(pn);
    if (!page) {
      const bytes = wd.subarray(pn * 512, pn * 512 + 512), pr = docReader(bytes), crun = bytes.length === 512 ? bytes[511] : 0;
      page = { fcs: [], entries: [] };
      for (let k = 0; k <= crun; k++) page.fcs.push(pr.u32(k * 4));
      for (let k = 0; k < crun; k++) {
        const off = bytes[(crun + 1) * 4 + k * 13] * 2;
        if (!off) { page.entries.push({ istd: 0, grpprl: null }); continue; }
        let cb = bytes[off], start = off + 1;
        if (cb === 0) { cb = bytes[off + 1] * 2; start = off + 2; } else cb = cb * 2 - 1;
        const g = bytes.subarray(start, Math.min(start + cb, 511));
        page.entries.push({ istd: g.length >= 2 ? docU16(g) : 0, grpprl: g.length > 2 ? g.subarray(2) : null });
      }
      papxPages.set(pn, page);
    }
    for (let k = 0; k < page.entries.length; k++) if (fc >= page.fcs[k] && fc < page.fcs[k + 1]) return page.entries[k];
    return page.entries[page.entries.length - 1] || { istd: 0, grpprl: null };
  };

  // ---- notes, headers, text boxes, sections
  const cpFtn = fib.ccpText, cpHdd = cpFtn + fib.ccpFtn, cpAtn = cpHdd + fib.ccpHdd, cpEdn = cpAtn + fib.ccpAtn, cpTxbx = cpEdn + fib.ccpEdn;
  /** The stories of a CP-only PLC (headers, note texts): [start, end) pairs; the last CP is a guard. */
  const stories = (plc, base, ccp) => {
    const out = [];
    for (let i = 0; i + 2 < plc.cps.length; i++) out.push([base + Math.min(plc.cps[i], ccp), base + Math.min(plc.cps[i + 1], ccp)]);
    return out;
  };
  const noteRefs = (plcRef, plcTxt, base, ccp) => {
    const refs = docPlc(tbl, plcRef, 2, cpTotal + 1), texts = stories(docPlc(tbl, plcTxt, 0), base, ccp);
    const byCp = new Map();
    texts.forEach((range, i) => { if (i < refs.cps.length - 1) byCp.set(refs.cps[i], { id: i + 1, range }); });
    return { byCp, texts };
  };
  const footnotes = fib.ccpFtn ? noteRefs(fib.plcffndRef, fib.plcffndTxt, cpFtn, fib.ccpFtn) : { byCp: new Map(), texts: [] };
  const endnotes = fib.ccpEdn ? noteRefs(fib.plcfendRef, fib.plcfendTxt, cpEdn, fib.ccpEdn) : { byCp: new Map(), texts: [] };
  const hddStories = fib.ccpHdd ? stories(docPlc(tbl, fib.plcfhdd, 0), cpHdd, fib.ccpHdd) : [];
  // Text boxes: their stories are inserted after the paragraph holding the anchor of their shape.
  const textboxesAt = new Map();
  if (fib.ccpTxbx) {
    const txbx = docPlc(tbl, fib.plcftxbxTxt, 22, cpTotal + 1), spa = docPlc(tbl, fib.plcSpaMom, 26, cpTotal + 1);
    const anchorOfSpid = new Map();
    spa.data.forEach((d, i) => anchorOfSpid.set(docI32(d), spa.cps[i]));
    txbx.data.forEach((d, i) => {
      const range = [cpTxbx + Math.min(txbx.cps[i], fib.ccpTxbx), cpTxbx + Math.min(txbx.cps[i + 1], fib.ccpTxbx)];
      if (range[1] <= range[0] || !/\S/.test(text.slice(range[0], range[1]))) return;
      const anchor = anchorOfSpid.get(docI32(d, 14));
      const key = anchor !== undefined ? anchor : fib.ccpText - 1;
      if (!textboxesAt.has(key)) textboxesAt.set(key, []);
      textboxesAt.get(key).push(range);
    });
  }
  const sed = docPlc(tbl, fib.plcfSed, 12, cpTotal + 1);
  const sectionEnds = new Map(); // CP just after a section mark → section index
  for (let i = 0; i < sed.data.length && i + 1 < sed.cps.length; i++) sectionEnds.set(sed.cps[i + 1], i);
  const sectionProps = (i) => {
    const sep = { xaPage: 12240, yaPage: 15840, dxaLeft: 1800, dxaRight: 1800, dyaTop: 1440, dyaBottom: 1440, dyaHdrTop: 720, dyaHdrBottom: 720, cols: 1, titlePage: false, orient: 1 };
    const d = sed.data[i];
    const fcSepx = d ? docU16(d, 2) | (docU16(d, 4) << 16) : 0xffffffff;
    if (d && fcSepx !== 0xffffffff && fcSepx + 2 <= wd.length) {
      const cb = wr.i16(fcSepx);
      if (cb > 0) {
        docSprms(wd.subarray(fcSepx + 2, Math.min(fcSepx + 2 + cb, wd.length)), (op, o) => {
          switch (op) {
            case 0xb01f: sep.xaPage = docU16(o); break;
            case 0xb020: sep.yaPage = docU16(o); break;
            case 0xb021: sep.dxaLeft = docU16(o); break;
            case 0xb022: sep.dxaRight = docU16(o); break;
            case 0x9023: sep.dyaTop = docI16(o); break;
            case 0x9024: sep.dyaBottom = docI16(o); break;
            case 0xb017: sep.dyaHdrTop = docU16(o); break;
            case 0xb018: sep.dyaHdrBottom = docU16(o); break;
            case 0x500b: sep.cols = docU16(o) + 1; break;
            case 0x300a: sep.titlePage = o[0] !== 0; break;
            case 0x301d: sep.orient = o[0]; break;
            default: break;
          }
        });
      }
    }
    return sep;
  };
  const facingPages = fib.dop[1] > 0 && fib.dop[0] < tbl.length ? (tbl[fib.dop[0]] & 1) !== 0 : false;

  // ---- paragraphs and tables
  const parts = {}, rels = [], contentTypes = [];
  let relId = 0;
  const addRel = (type, target) => { rels.push(`<Relationship Id="rId${++relId}" Type="${DOC_REL_NS}${type}" Target="${target}"/>`); return `rId${relId}`; };
  const addPart = (path, ct, xml) => { parts[`word/${path}`] = xml; contentTypes.push(`<Override PartName="/word/${path}" ContentType="${DOC_CT}${ct}+xml"/>`); };
  const symXml = (chp) => `<w:sym w:font="${docAttr(fonts[chp.symbol.ftc] || "Symbol")}" w:char="${chp.symbol.ch.toString(16).toUpperCase().padStart(4, "0")}"/>`;

  /** The runs of a paragraph [s, e) as XML; `story` holds the field state. */
  const runsXml = (s, e, istd, story) => {
    const out = [];
    let cur = null;
    const push = (rpr, frag) => { if (!cur || cur.rpr !== rpr) { cur = { rpr, frags: [] }; out.push(cur); } cur.frags.push(frag); };
    for (let ri = runs.length ? runAt(s) : 0; ri < runs.length && runs[ri].s < e; ri++) {
      const run = runs[ri], a = Math.max(run.s, s), b = Math.min(run.e, e);
      if (b <= a) continue;
      const { chp, rpr } = runProps(run, istd);
      if (chp.deleted) continue; // (field characters inside deleted text are dropped with it)
      let t = "";
      const flush = () => { if (t) { push(rpr, `<w:t xml:space="preserve">${escapeXmlText(t)}</w:t>`); t = ""; } };
      for (let cp = a; cp < b; cp++) {
        const c = text.charCodeAt(cp);
        if (c === 0x13) { flush(); story.fields.push(true); continue; }
        if (c === 0x14) { flush(); if (story.fields.length) story.fields[story.fields.length - 1] = false; continue; }
        if (c === 0x15) { flush(); story.fields.pop(); continue; }
        if (story.fields.includes(true)) continue; // inside a field code
        if (c >= 0x20) {
          if (c === 0x28 && chp.fSpec && chp.symbol) { flush(); push(rpr, symXml(chp)); } else t += text[cp];
          continue;
        }
        switch (c) {
          case 0x09: flush(); push(rpr, "<w:tab/>"); break;
          case 0x0b: flush(); push(rpr, "<w:br/>"); break;
          case 0x0c: flush(); push(rpr, '<w:br w:type="page"/>'); break;
          case 0x0e: flush(); push(rpr, '<w:br w:type="column"/>'); break;
          case 0x1e: t += "‑"; break;
          case 0x02: {
            flush();
            const fn = footnotes.byCp.get(cp), en = endnotes.byCp.get(cp);
            if (story.kind === "main" && fn) push(rpr, `<w:footnoteReference w:id="${fn.id}"/>`);
            else if (story.kind === "main" && en) push(rpr, `<w:endnoteReference w:id="${en.id}"/>`);
            else if (story.kind === "footnote") push(rpr, "<w:footnoteRef/>");
            else if (story.kind === "endnote") push(rpr, "<w:endnoteRef/>");
            break;
          }
          default: break; // pictures (0x01), anchors (0x08), optional hyphens (0x1F) and other marks are dropped
        }
      }
      flush();
    }
    return out.map((r) => `<w:r>${r.rpr}${r.frags.join("")}</w:r>`).join("");
  };

  /** A table from its rows [{cells: [{blocks, tc}], tap}] as XML. */
  const tableXml = (rows) => {
    const edges = new Set();
    for (const row of rows) if (row.tap) row.tap.centers.forEach((c) => edges.add(c));
    const grid = [...edges].sort((a, b) => a - b);
    const maxCells = Math.max(1, ...rows.map((r) => r.cells.length));
    const fallbackW = Math.round(9000 / maxCells);
    let x = "<w:tbl><w:tblPr>";
    x += grid.length > 1 ? `<w:tblW w:w="${grid[grid.length - 1] - grid[0]}" w:type="dxa"/>` : '<w:tblW w:w="0" w:type="auto"/>';
    const tjc = rows.find((r) => r.tap && r.tap.tjc !== undefined);
    if (tjc && tjc.tap.tjc) x += `<w:jc w:val="${DOC_JC[tjc.tap.tjc] || "left"}"/>`;
    x += '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>';
    if (grid.length > 1) for (let i = 1; i < grid.length; i++) x += `<w:gridCol w:w="${grid[i] - grid[i - 1]}"/>`;
    else for (let i = 0; i < maxCells; i++) x += `<w:gridCol w:w="${fallbackW}"/>`;
    x += "</w:tblGrid>";
    for (const row of rows) {
      const tap = row.tap;
      let tr = "", trPr = "";
      const col = (v) => grid.indexOf(v);
      if (tap && grid.length > 1 && tap.centers.length) {
        const before = col(tap.centers[0]), after = grid.length - 1 - col(tap.centers[tap.centers.length - 1]);
        if (before > 0) trPr += `<w:gridBefore w:val="${before}"/>`;
        if (after > 0) trPr += `<w:gridAfter w:val="${after}"/>`;
      }
      if (tap && tap.rowHeight) trPr += `<w:trHeight w:val="${Math.abs(tap.rowHeight)}"${tap.rowHeight < 0 ? ' w:hRule="exact"' : ""}/>`;
      if (tap && tap.tblHeader) trPr += "<w:tblHeader/>";
      if (trPr) tr += `<w:trPr>${trPr}</w:trPr>`;
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i], tc = tap && tap.cells[i];
        if (tc && (tc.grf & 2) && !(tc.grf & 1) && i) continue; // horizontally merged into the previous cell
        let span = 1, left = tap && tap.centers[i], right = tap && tap.centers[i + 1];
        let blocks = cell.blocks;
        if (tc && (tc.grf & 1)) {
          for (let j = i + 1; j < row.cells.length && tap.cells[j] && (tap.cells[j].grf & 2) && !(tap.cells[j].grf & 1); j++) {
            right = tap.centers[j + 1]; blocks = blocks.concat(row.cells[j].blocks);
          }
        }
        if (grid.length > 1 && left !== undefined && right !== undefined && col(left) >= 0 && col(right) >= 0) span = col(right) - col(left);
        let tcPr = "";
        tcPr += left !== undefined && right !== undefined ? `<w:tcW w:w="${Math.max(0, right - left)}" w:type="dxa"/>` : `<w:tcW w:w="${fallbackW}" w:type="dxa"/>`;
        if (span > 1) tcPr += `<w:gridSpan w:val="${span}"/>`;
        if (tc && (tc.grf & 0x40)) tcPr += '<w:vMerge w:val="restart"/>';
        else if (tc && (tc.grf & 0x20)) tcPr += "<w:vMerge/>";
        if (tc) {
          let b = "";
          for (const side of ["top", "left", "bottom", "right"]) {
            const br = tc.borders[side];
            if (br) b += `<w:${side} w:val="${br.val}" w:sz="${br.sz}" w:space="0" w:color="${br.color}"/>`;
          }
          if (b) tcPr += `<w:tcBorders>${b}</w:tcBorders>`;
          const va = (tc.grf >> 7) & 3;
          if (va) tcPr += `<w:vAlign w:val="${va === 1 ? "center" : "bottom"}"/>`;
        }
        tr += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${blocks.length ? blocks.join("") : "<w:p/>"}</w:tc>`;
      }
      if (!row.cells.length) tr += `<w:tc><w:tcPr><w:tcW w:w="${fallbackW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
      x += `<w:tr>${tr}</w:tr>`;
    }
    return x + "</w:tbl>";
  };

  const sectPrXml = (sectIndex, headerRefs) => {
    const sep = sectionProps(sectIndex);
    let x = `<w:sectPr>${headerRefs}`;
    x += `<w:pgSz w:w="${sep.xaPage}" w:h="${sep.yaPage}"${sep.orient === 2 ? ' w:orient="landscape"' : ""}/>`;
    x += `<w:pgMar w:top="${sep.dyaTop}" w:right="${sep.dxaRight}" w:bottom="${sep.dyaBottom}" w:left="${sep.dxaLeft}" w:header="${sep.dyaHdrTop}" w:footer="${sep.dyaHdrBottom}" w:gutter="0"/>`;
    if (sep.cols > 1) x += `<w:cols w:num="${sep.cols}" w:space="708"/>`;
    if (sep.titlePage) x += "<w:titlePg/>";
    return x + "</w:sectPr>";
  };

  /**
   * The block content (paragraphs and tables) of the text range [cpStart, cpEnd) as XML strings.
   * Paragraphs end at 0x0D, at a cell mark 0x07, or at a section mark 0x0C.
   */
  const blocksXml = (cpStart, cpEnd, story) => {
    const blocks = [];
    let rows = null, row = null, cell = null;
    const flushTable = () => {
      if (rows) { if (row && row.cells.length) rows.push(row); if (rows.length) blocks.push(tableXml(rows)); }
      rows = row = cell = null;
    };
    let s = cpStart;
    while (s < cpEnd) {
      let e = s;
      for (; e < cpEnd; e++) {
        const c = text.charCodeAt(e);
        if (c === 0x0d || c === 0x07 || (c === 0x0c && sectionEnds.has(e + 1))) break;
      }
      const mark = e < cpEnd ? text.charCodeAt(e) : 0x0d;
      const papx = papxAt(fcOf(Math.min(e, cpTotal - 1)));
      const pap = papx.grpprl ? docApplyPapx({}, papx.grpprl) : {};
      const istd = pap.istd !== undefined ? pap.istd : papx.istd;
      const sectEnd = mark === 0x0c && sectionEnds.has(e + 1) && sectionEnds.get(e + 1) < sed.data.length - 1 ? sectionEnds.get(e + 1) : -1;
      if (pap.ttp && story.kind !== "textbox") {
        if (rows) { if (row) { row.tap = pap.tap ? { ...pap.tap, tjc: pap.tjc, rowHeight: pap.rowHeight, tblHeader: pap.tblHeader } : null; rows.push(row); } row = cell = null; }
      } else {
        const stylePapOf = stylePap(istd);
        const inTable = pap.inTable || (pap.itap > 0 && stylePapOf.inTable);
        let x = `<w:p><w:pPr>${docPPrXml(pap, styleId(istd), numPrXml({ ...stylePapOf, ...pap }), sectEnd >= 0 ? sectPrXml(sectEnd, headerRefsOf(sectEnd)) : "")}</w:pPr>`;
        x += runsXml(s, e, istd, story);
        x += "</w:p>";
        const target = [];
        target.push(x);
        // Text boxes anchored in this paragraph follow it.
        for (let cp = s; cp <= e; cp++) {
          const boxes = textboxesAt.get(cp);
          if (boxes) for (const [a, b] of boxes) target.push(...blocksXml(a, b, { kind: "textbox", fields: [] }));
        }
        if (inTable && story.kind !== "textbox") {
          if (!rows) rows = [];
          if (!row) row = { cells: [], tap: null };
          if (!cell) { cell = { blocks: [] }; row.cells.push(cell); }
          cell.blocks.push(...target);
          if (mark === 0x07) cell = null;
        } else {
          flushTable();
          blocks.push(...target);
        }
      }
      s = e + 1;
    }
    flushTable();
    return blocks;
  };
  /** Paragraphs of a story without the empty trailing ones that some writers add. */
  const trimmed = (xmls) => {
    const empty = (x) => x.startsWith("<w:p>") && !x.includes("<w:r>") && !x.includes("<w:sectPr>");
    while (xmls.length > 1 && empty(xmls[xmls.length - 1])) xmls.pop();
    return xmls;
  };

  // ---- headers and footers of each section (6 separator stories first, then 6 per section)
  let headerCount = 0, footerCount = 0, needEvenOdd = false;
  const headerRefsOf = (sectIndex) => {
    let refs = "";
    const sep = sectionProps(sectIndex);
    const kinds = [["even", "header", 0], ["default", "header", 1], ["even", "footer", 2], ["default", "footer", 3], ["first", "header", 4], ["first", "footer", 5]];
    for (const [type, kind, k] of kinds) {
      const range = hddStories[6 + sectIndex * 6 + k];
      if (!range || range[1] <= range[0] || !/[^\r\x07]/.test(text.slice(range[0], range[1]))) continue;
      if (type === "first" && !sep.titlePage) continue;
      if (type === "even" && !facingPages) continue;
      if (type === "even") needEvenOdd = true;
      const xmls = trimmed(blocksXml(range[0], range[1], { kind: kind, fields: [] }));
      const n = kind === "header" ? ++headerCount : ++footerCount, path = `${kind}${n}.xml`;
      const root = kind === "header" ? "hdr" : "ftr";
      addPart(path, kind, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${root} ${DOC_W_NS}>${xmls.join("")}</w:${root}>`);
      refs += `<w:${kind}Reference w:type="${type}" r:id="${addRel(kind, path)}"/>`;
    }
    return refs;
  };

  // ---- the main document (the sectPr of the last section closes the body; earlier ones sit in
  // the paragraph that ends their section)
  let bodyXml = blocksXml(0, fib.ccpText, { kind: "main", fields: [] }).join("");
  const lastSect = Math.max(0, sed.data.length - 1);
  bodyXml += sectPrXml(lastSect, headerRefsOf(lastSect));

  // ---- footnotes and endnotes
  const notesXml = (notes, kind) => {
    const tag = kind === "footnote" ? "footnotes" : "endnotes";
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${tag} ${DOC_W_NS}>`;
    x += `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>`;
    x += `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
    notes.texts.forEach(([a, b], i) => {
      const xmls = trimmed(blocksXml(a, b, { kind, fields: [] }));
      x += `<w:${kind} w:id="${i + 1}">${xmls.length ? xmls.join("") : "<w:p/>"}</w:${kind}>`;
    });
    return x + `</w:${tag}>`;
  };
  let settingsExtra = "";
  if (footnotes.texts.length) {
    addPart("footnotes.xml", "footnotes", notesXml(footnotes, "footnote"));
    addRel("footnotes", "footnotes.xml");
    settingsExtra += '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>';
  }
  if (endnotes.texts.length) {
    addPart("endnotes.xml", "endnotes", notesXml(endnotes, "endnote"));
    addRel("endnotes", "endnotes.xml");
    settingsExtra += '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>';
  }

  // ---- styles.xml: the document's styles, plus fallbacks so headings and notes look right
  const stylesXml = () => {
    const defFont = fonts[defaultFtc] ? docAttr(fonts[defaultFtc]) : "Times New Roman";
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${DOC_W_NS}><w:docDefaults><w:rPrDefault><w:rPr>`;
    x += `<w:rFonts w:ascii="${defFont}" w:hAnsi="${defFont}" w:eastAsia="${defFont}" w:cs="${defFont}"/><w:sz w:val="20"/><w:szCs w:val="20"/>`;
    x += "</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>";
    const emitted = new Set();
    for (const st of styles) {
      if (!st || !styleIds.has(st.istd)) continue;
      const id = styleIds.get(st.istd);
      emitted.add(id);
      const type = st.stk === 2 ? "character" : "paragraph";
      x += `<w:style w:type="${type}" w:styleId="${docAttr(id)}"${st.sti === 0 || st.sti === 67 ? ' w:default="1"' : ""}><w:name w:val="${docAttr(st.name || id)}"/>`;
      if (st.istdBase !== 0x0fff && styleIds.has(st.istdBase) && st.istdBase !== st.istd) x += `<w:basedOn w:val="${docAttr(styleIds.get(st.istdBase))}"/>`;
      if (st.sti < 10 || st.sti === 64) x += "<w:qFormat/>";
      if (st.stk === 1 && st.papx) {
        const pap = docApplyPapx({}, st.papx);
        const ppr = docPPrXml(pap, null, numPrXml(pap));
        if (ppr) x += `<w:pPr>${ppr}</w:pPr>`;
      }
      if (st.chpx) {
        const base = st.istdBase !== 0x0fff ? styleChp(st.istdBase) : defaultChp;
        const rpr = docRPrXml(docApplyChpx({}, st.chpx, base), fonts, null);
        if (rpr) x += `<w:rPr>${rpr}</w:rPr>`;
      }
      x += "</w:style>";
    }
    const fallback = (id, name, type, ppr, rpr, attrs = "", extra = "") => {
      if (emitted.has(id)) return;
      x += `<w:style w:type="${type}" w:styleId="${id}"${attrs}><w:name w:val="${name}"/>${emitted.has("Normal") && type === "paragraph" && id !== "Normal" ? '<w:basedOn w:val="Normal"/>' : ""}${extra}`;
      if (ppr) x += `<w:pPr>${ppr}</w:pPr>`;
      if (rpr) x += `<w:rPr>${rpr}</w:rPr>`;
      x += "</w:style>";
    };
    fallback("Normal", "Normal", "paragraph", "", "", ' w:default="1"');
    emitted.add("Normal");
    fallback("Title", "Title", "paragraph", '<w:spacing w:after="300"/><w:jc w:val="center"/>', '<w:b/><w:sz w:val="52"/>', "", "<w:qFormat/>");
    fallback("Heading1", "heading 1", "paragraph", '<w:keepNext/><w:spacing w:before="480" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="32"/>', "", "<w:qFormat/>");
    fallback("Heading2", "heading 2", "paragraph", '<w:keepNext/><w:spacing w:before="360" w:after="100"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="28"/>', "", "<w:qFormat/>");
    fallback("Heading3", "heading 3", "paragraph", '<w:keepNext/><w:spacing w:before="280" w:after="80"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="24"/>', "", "<w:qFormat/>");
    if (footnotes.texts.length || endnotes.texts.length) {
      fallback("FootnoteText", "footnote text", "paragraph", "", '<w:sz w:val="20"/>');
      fallback("FootnoteReference", "footnote reference", "character", "", '<w:vertAlign w:val="superscript"/>');
      fallback("EndnoteText", "endnote text", "paragraph", "", '<w:sz w:val="20"/>');
      fallback("EndnoteReference", "endnote reference", "character", "", '<w:vertAlign w:val="superscript"/>');
    }
    return x + "</w:styles>";
  };
  addPart("styles.xml", "styles", stylesXml());
  addRel("styles", "styles.xml");

  // ---- numbering.xml: one abstract definition per list, one w:num per LFO
  if (lfos.some((i) => i >= 0)) {
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${DOC_W_NS}>`;
    lists.forEach((list, li) => {
      x += `<w:abstractNum w:abstractNumId="${li}"><w:multiLevelType w:val="${list.simple ? "singleLevel" : "hybridMultilevel"}"/>`;
      list.levels.forEach((lvl, l) => {
        const lvlText = lvl.text.replace(/[\x00-\x08]/g, (c) => `%${c.charCodeAt(0) + 1}`);
        x += `<w:lvl w:ilvl="${l}"><w:start w:val="${Math.max(0, lvl.start)}"/><w:numFmt w:val="${DOC_NFC[lvl.nfc] || "decimal"}"/>`;
        if (lvl.follow === 1 || lvl.follow === 2) x += `<w:suff w:val="${lvl.follow === 1 ? "space" : "nothing"}"/>`;
        x += `<w:lvlText w:val="${docAttr(lvlText)}"/><w:lvlJc w:val="${DOC_JC[lvl.jc] || "left"}"/>`;
        const ppr = docPPrXml(docApplyPapx({}, lvl.papx), null, "");
        if (ppr) x += `<w:pPr>${ppr}</w:pPr>`;
        const rpr = docRPrXml(docApplyChpx({}, lvl.chpx, {}), fonts, null);
        if (rpr) x += `<w:rPr>${rpr}</w:rPr>`;
        x += "</w:lvl>";
      });
      x += "</w:abstractNum>";
    });
    lfos.forEach((li, i) => { if (li >= 0) x += `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${li}"/></w:num>`; });
    addPart("numbering.xml", "numbering", x + "</w:numbering>");
    addRel("numbering", "numbering.xml");
  }

  // ---- settings.xml (only when something has to be said)
  if (needEvenOdd) settingsExtra = "<w:evenAndOddHeaders/>" + settingsExtra;
  if (settingsExtra) {
    addPart("settings.xml", "settings", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings ${DOC_W_NS}>${settingsExtra}</w:settings>`);
    addRel("settings", "settings.xml");
  }

  parts["word/document.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${DOC_W_NS}><w:body>${bodyXml}</w:body></w:document>`;
  parts["word/_rels/document.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  parts["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${DOC_REL_NS}officeDocument" Target="word/document.xml"/></Relationships>`;
  parts["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/word/document.xml" ContentType="${DOC_CT}document.main+xml"/>${contentTypes.join("")}</Types>`;
  return parts;
}
