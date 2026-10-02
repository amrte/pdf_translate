// ======================================================================
// xls.js: converter of the legacy Excel binary format (.xls: BIFF8 of Excel 97–2003, BIFF5 of
// Excel 5/95) to an Office Open XML package (.xlsx), following [MS-XLS]. Plain JavaScript, no
// library; runs in a Web Worker and in Node. The opened compound file comes from legacy.js.
//
// Carried over: sheet names and visibility, cell texts (shared strings with rich-text runs,
// labels, cached formula results), numbers, booleans, errors, cell fonts (bold, italic, strike,
// underline, size, name, colour), a few number formats, alignment, column widths, row heights,
// merged cells. Not carried: formula expressions (only their cached values; decoding parsed
// token streams is out of scope), fills, borders, charts, drawings, comments, hyperlinks,
// pivot tables, macros.
// ======================================================================

const XLS_MAX_CELLS = 200000; // cells per sheet: a bigger sheet is cut off here

// Record types (BIFF5/BIFF8).
const XLS_REC = {
  BOF: 0x809, EOF: 0x0a, CONTINUE: 0x3c, FILEPASS: 0x2f, CODEPAGE: 0x42, DATE1904: 0x22, BOUNDSHEET: 0x85,
  SST: 0xfc, FONT: 0x31, FORMAT: 0x41e, XF: 0xe0, PALETTE: 0x92, MERGECELLS: 0xe5, COLINFO: 0x7d,
  DEFCOLWIDTH: 0x55, STANDARDWIDTH: 0x99, DEFAULTROWHEIGHT: 0x225, ROW: 0x208, DIMENSIONS: 0x200,
  LABELSST: 0xfd, LABEL: 0x204, RSTRING: 0xd6, NUMBER: 0x203, RK: 0x27e, MULRK: 0xbd, MULBLANK: 0xbe,
  BLANK: 0x201, BOOLERR: 0x205, FORMULA: 0x06, STRING: 0x207,
};

// Error codes of BoolErr cells and cached formula results.
const XLS_ERRORS = { 0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A", 0x2b: "#GETTING_DATA" };

// Number formats that are built into both BIFF and SpreadsheetML under the same id.
const XLS_BUILTIN_FMT = new Set([...Array.from({ length: 23 }, (_, i) => i), 37, 38, 39, 40, 45, 46, 47, 48, 49]);

// The default colour palette (icv 8–63); icv 0–7 are the fixed EGA colours below.
const XLS_PALETTE = ("000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 "
  + "9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF "
  + "00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 "
  + "003366 339966 003300 333300 993300 993366 333399 333333").split(" ");

// Format codes of built-in formats, as FORMAT records sometimes spell them out.
const XLS_BUILTIN_CODES = { 0: 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10, "0.00E+00": 11, "# ?/?": 12, "# ??/??": 13,
  "m/d/yyyy": 14, "d-mmm-yy": 15, "d-mmm": 16, "mmm-yy": 17, "h:mm AM/PM": 18, "h:mm:ss AM/PM": 19, "h:mm": 20, "h:mm:ss": 21,
  "m/d/yyyy h:mm": 22, "#,##0 ;(#,##0)": 37, "#,##0 ;[Red](#,##0)": 38, "#,##0.00;(#,##0.00)": 39, "#,##0.00;[Red](#,##0.00)": 40,
  "mm:ss": 45, "[h]:mm:ss": 46, "mmss.0": 47, "##0.0E+0": 48, "@": 49 };

const XLS_H_ALIGN = ["", "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"];
const XLS_V_ALIGN = ["top", "center", "", "justify", "distributed"]; // 2 = bottom, the default

/** XML attribute value (escapeXmlText comes from ebook.js). */
const xlsAttr = (s) => escapeXmlText(String(s)).replace(/"/g, "&quot;");

/** Column index (0-based) to letters. */
function xlsColName(c) {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Latin-1 bytes to text (the "compressed" BIFF8 strings hold the low byte of each UTF-16 unit). */
function xlsLatin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

/** A decoder for the 8-bit strings of a CODEPAGE record, cp1252 when unknown. */
function xlsCodepageDecoder(cp) {
  const labels = { 437: "ibm437", 737: "ibm737", 850: "ibm850", 852: "ibm852", 855: "ibm855", 857: "ibm857", 866: "ibm866", 874: "windows-874",
    932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 1250: "windows-1250", 1251: "windows-1251", 1252: "windows-1252",
    1253: "windows-1253", 1254: "windows-1254", 1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257", 1258: "windows-1258",
    10000: "macintosh", 32768: "macintosh", 10007: "x-mac-cyrillic", 28591: "iso-8859-1", 28592: "iso-8859-2", 28595: "iso-8859-5", 65001: "utf-8" };
  if (cp === 1200) return utf16;
  try { const dec = new TextDecoder(labels[cp] || "windows-1252"); return (b) => dec.decode(b); } catch (_) { return cp1252; }
}

/**
 * A cursor over the data of a record and its CONTINUE records. Fields may span the boundary
 * between two parts; the characters of a BIFF8 string that continue in the next part start with
 * a fresh fHighByte flag there.
 */
class XlsCursor {
  constructor(parts) { this.parts = parts; this.pi = 0; this.po = 0; }
  get done() {
    while (this.pi < this.parts.length && this.po >= this.parts[this.pi].length) { this.pi++; this.po = 0; }
    return this.pi >= this.parts.length;
  }
  u8() { if (this.done) throw new RangeError("record data exhausted"); return this.parts[this.pi][this.po++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) {
    while (n > 0) {
      if (this.done) throw new RangeError("record data exhausted");
      const take = Math.min(n, this.parts[this.pi].length - this.po);
      this.po += take; n -= take;
    }
  }
  /** `cch` characters; `high` = UTF-16LE, else 8-bit through `dec8`. */
  chars(cch, high, dec8, flagOnContinue) {
    let s = "";
    while (cch > 0) {
      if (this.po >= this.parts[this.pi].length) {
        this.pi++; this.po = 0;
        if (this.pi >= this.parts.length) throw new RangeError("string beyond record");
        if (flagOnContinue) high = this.u8() & 1;
        continue;
      }
      const part = this.parts[this.pi], avail = part.length - this.po;
      if (high) {
        const n = Math.min(cch, avail >> 1);
        if (!n) { this.po = part.length; continue; } // a stray odd byte
        s += utf16(part.subarray(this.po, this.po + 2 * n)); this.po += 2 * n; cch -= n;
      } else {
        const n = Math.min(cch, avail);
        s += dec8(part.subarray(this.po, this.po + n)); this.po += n; cch -= n;
      }
    }
    return s;
  }
}

/** The value of an RK number (a packed 30-bit integer or double, optionally divided by 100). */
function xlsRk(rk) {
  let v;
  if (rk & 2) v = rk >> 2;
  else {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    v = dv.getFloat64(0, true);
  }
  return rk & 1 ? v / 100 : v;
}

/** A number for <v>: shortest round-trip form; Excel wants an upper-case exponent marker. */
const xlsNum = (n) => String(n).replace("e", "E");

/**
 * Convert an opened .xls compound file to the parts of an .xlsx package ({path: xml}).
 * Throws for encrypted files and for files without a BIFF5/BIFF8 workbook stream.
 */
async function xlsToXlsx(cfb) {
  let streamName = "Workbook";
  let data = cfb.stream(streamName);
  if (!data) { streamName = "Book"; data = cfb.stream(streamName); }
  if (!data) throw new Error("This Excel file is too old (Excel 4 or earlier).");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ---- the record stream: a record and its CONTINUE records as parts
  const record = (off) => {
    if (off + 4 > data.length) return null;
    const type = dv.getUint16(off, true), len = dv.getUint16(off + 2, true);
    const end = Math.min(off + 4 + len, data.length);
    const parts = [data.subarray(off + 4, end)];
    let next = end;
    while (next + 4 <= data.length && dv.getUint16(next, true) === XLS_REC.CONTINUE) {
      const l = dv.getUint16(next + 2, true), e = Math.min(next + 4 + l, data.length);
      parts.push(data.subarray(next + 4, e));
      next = e;
    }
    return { type, parts, data: parts[0], next };
  };
  const u8 = (p, o) => (o < p.length ? p[o] : 0);
  const u16 = (p, o) => (o + 2 <= p.length ? p[o] | (p[o + 1] << 8) : 0);
  const u32 = (p, o) => (u16(p, o) | (u16(p, o + 2) << 16)) >>> 0;
  const f64 = (p, o) => (o + 8 <= p.length ? new DataView(p.buffer, p.byteOffset + o, 8).getFloat64(0, true) : 0);

  // ---- workbook globals
  let biff8 = streamName === "Workbook";
  let dec8 = xlsCodepageDecoder(1252); // BIFF5 byte strings; BIFF8 ones are Unicode
  let date1904 = false;
  const fonts = [], formats = new Map(), xfs = [], bounds = [], sst = [];
  const palette = XLS_PALETTE.slice();
  // A string: `lenBytes` of character count, then (BIFF8) flags, optional run count and
  // extended size, characters, runs, extended data. Returns {text, runs: [[ich, ifnt]]}.
  const readString = (cur, lenBytes, rich = false) => {
    const cch = lenBytes === 1 ? cur.u8() : cur.u16();
    if (!biff8) return { text: cur.chars(cch, 0, dec8, false), runs: [] };
    const flags = cur.u8();
    const cRun = rich && flags & 8 ? cur.u16() : 0, cbExt = rich && flags & 4 ? cur.u32() : 0;
    const text = cur.chars(cch, flags & 1, xlsLatin1, true);
    const runs = [];
    for (let i = 0; i < cRun; i++) runs.push([cur.u16(), cur.u16()]);
    cur.skip(cbExt);
    return { text, runs };
  };
  const stringOf = (parts, skip, lenBytes, rich) => {
    const cur = new XlsCursor(parts);
    try { cur.skip(skip); return readString(cur, lenBytes, rich); } catch (_) { return { text: "", runs: [] }; }
  };

  let off = 0, depth = 0, rec;
  for (; (rec = record(off)); off = rec.next) {
    const p = rec.data;
    if (rec.type === XLS_REC.BOF) {
      if (depth === 0) {
        const vers = u16(p, 0);
        if (vers === 0x0600) biff8 = true; else if (vers === 0x0500) biff8 = false;
        else if (vers && vers < 0x0500) throw new Error("This Excel file is too old (Excel 4 or earlier).");
      }
      depth++;
    } else if (rec.type === XLS_REC.EOF) {
      if (--depth <= 0) break;
    } else if (depth !== 1) continue;
    else if (rec.type === XLS_REC.FILEPASS) throw new Error("This Excel file is encrypted and cannot be opened.");
    else if (rec.type === XLS_REC.CODEPAGE) { if (!biff8) dec8 = xlsCodepageDecoder(u16(p, 0)); }
    else if (rec.type === XLS_REC.DATE1904) date1904 = !!(u16(p, 0) & 1);
    else if (rec.type === XLS_REC.BOUNDSHEET) {
      bounds.push({ pos: u32(p, 0), hidden: u8(p, 4) & 3, kind: u8(p, 5), name: stringOf(rec.parts, 6, 1).text });
    } else if (rec.type === XLS_REC.FONT) {
      const cur = new XlsCursor(rec.parts);
      let name = "";
      try { cur.skip(14); name = readString(cur, 1).text; } catch (_) { /* nameless font */ }
      fonts.push({ size: u16(p, 0) / 20, italic: !!(u16(p, 2) & 2), strike: !!(u16(p, 2) & 8), icv: u16(p, 4), bold: u16(p, 6) >= 600,
        sss: u16(p, 8), uls: u8(p, 10), name });
    } else if (rec.type === XLS_REC.FORMAT) {
      formats.set(u16(p, 0), stringOf(rec.parts, 2, biff8 ? 2 : 1).text);
    } else if (rec.type === XLS_REC.XF) {
      const al = u8(p, 6);
      xfs.push({ ifnt: u16(p, 0), ifmt: u16(p, 2), style: !!(u16(p, 4) & 4), alc: al & 7, wrap: !!(al & 8), alcV: (al >> 4) & 7 });
    } else if (rec.type === XLS_REC.PALETTE) {
      const n = Math.min(u16(p, 0), 56);
      for (let i = 0; i < n && 2 + i * 4 + 3 <= p.length; i++) {
        const o = 2 + i * 4;
        palette[8 + i] = [p[o], p[o + 1], p[o + 2]].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      }
    } else if (rec.type === XLS_REC.SST) {
      const cur = new XlsCursor(rec.parts);
      try {
        cur.u32(); // cstTotal
        const unique = cur.u32();
        for (let i = 0; i < unique && !cur.done; i++) sst.push(readString(cur, 2, true));
      } catch (_) { /* a damaged table: keep what was read */ }
    }
  }

  // ---- styles: fonts, number formats, cell formats
  // BIFF skips font index 4: ifnt 0–3 are the first four FONT records, ifnt ≥ 5 the following ones.
  const fontId = (ifnt) => { const k = ifnt >= 4 ? ifnt - 1 : ifnt; return k >= 0 && k < fonts.length ? k : 0; };
  if (!fonts.length) fonts.push({ size: 11, italic: false, strike: false, icv: 0x7fff, bold: false, sss: 0, uls: 0, name: "Calibri" });
  const fontColor = (icv) => (icv < 64 && palette[icv] ? `<color rgb="FF${palette[icv]}"/>` : "");
  const fontXml = (f, nameTag) => {
    const x = [];
    if (f.bold) x.push("<b/>");
    if (f.italic) x.push("<i/>");
    if (f.strike) x.push("<strike/>");
    if (f.uls) x.push(f.uls === 2 || f.uls === 0x22 ? '<u val="double"/>' : "<u/>");
    if (f.sss === 1 || f.sss === 2) x.push(`<vertAlign val="${f.sss === 1 ? "superscript" : "subscript"}"/>`);
    if (f.size > 0) x.push(`<sz val="${xlsNum(f.size)}"/>`);
    x.push(fontColor(f.icv));
    if (f.name) x.push(`<${nameTag} val="${xlsAttr(f.name)}"/>`);
    return x.join("");
  };
  // Custom number formats get ids from 164 up (a code that is a built-in format gets that
  // format's id); built-in ids are kept; the rest is General.
  const numFmts = new Map(), customIds = new Map();
  const numFmtId = (ifmt) => {
    if (XLS_BUILTIN_FMT.has(ifmt)) return ifmt;
    const code = formats.get(ifmt);
    if (!code || /^general$/i.test(code)) return 0;
    if (XLS_BUILTIN_CODES[code] !== undefined) return XLS_BUILTIN_CODES[code];
    if (!customIds.has(ifmt)) { const id = 164 + customIds.size; customIds.set(ifmt, id); numFmts.set(id, code); }
    return customIds.get(ifmt);
  };
  if (!xfs.length) xfs.push({ ifnt: 0, ifmt: 0, style: false, alc: 0, wrap: false, alcV: 2 });
  const cellXfs = xfs.map((xf) => {
    const fmt = numFmtId(xf.ifmt), fid = fontId(xf.ifnt);
    const align = [];
    if (XLS_H_ALIGN[xf.alc]) align.push(`horizontal="${XLS_H_ALIGN[xf.alc]}"`);
    if (XLS_V_ALIGN[xf.alcV]) align.push(`vertical="${XLS_V_ALIGN[xf.alcV]}"`);
    if (xf.wrap) align.push('wrapText="1"');
    return `<xf numFmtId="${fmt}" fontId="${fid}" fillId="0" borderId="0" xfId="0"${fid ? ' applyFont="1"' : ""}${fmt ? ' applyNumberFormat="1"' : ""}`
      + (align.length ? ` applyAlignment="1"><alignment ${align.join(" ")}/></xf>` : "/>");
  });

  // ---- shared strings: the SST entries first, then the inline labels and formula results
  const strings = sst.map((s) => ({ text: s.text, runs: s.runs }));
  const stringIndex = new Map();
  strings.forEach((s, i) => { if (!s.runs.length && !stringIndex.has(s.text)) stringIndex.set(s.text, i); });
  const internString = (text) => {
    let i = stringIndex.get(text);
    if (i === undefined) { i = strings.length; strings.push({ text, runs: [] }); stringIndex.set(text, i); }
    return i;
  };

  // ---- the sheets
  const sheets = [];
  const usedNames = new Set();
  for (const b of bounds) {
    if (b.kind !== 0) continue; // chart sheets, macro sheets, VB modules
    let name = b.name.replace(/[\[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31).trim() || `Sheet${sheets.length + 1}`;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${name.replace(/ \(\d+\)$/, "").slice(0, 31 - ` (${n})`.length)} (${n})`;
    usedNames.add(name.toLowerCase());
    sheets.push({ name, hidden: b.hidden, xml: xlsSheetXml(b.pos) });
  }
  if (!sheets.length) sheets.push({ name: "Sheet1", hidden: 0, xml: xlsSheetXml(-1) });
  if (sheets.every((s) => s.hidden)) sheets[0].hidden = 0;

  /** The worksheet XML of the substream starting at `pos`. */
  function xlsSheetXml(pos) {
    const rows = new Map(); // row index → Map(col → cell)
    const rowProps = new Map(), cols = [], merges = [];
    let defColWidth = null, stdWidth = null, defRowHeight = null, count = 0, pending = null;
    const put = (rw, col, cell) => {
      if (count >= XLS_MAX_CELLS) return; // beyond the cap the rest of the sheet is dropped
      let row = rows.get(rw);
      if (!row) { row = new Map(); rows.set(rw, row); }
      if (!row.has(col)) count++;
      row.set(col, cell);
    };
    const cellOf = (rw, col, ixfe) => ({ s: ixfe < cellXfs.length ? ixfe : 0 });
    const putNumber = (rw, col, ixfe, v) => put(rw, col, Number.isFinite(v) ? { ...cellOf(rw, col, ixfe), t: "n", v: xlsNum(v) } : { ...cellOf(rw, col, ixfe), t: "e", v: "#NUM!" });
    const putString = (rw, col, ixfe, text) => put(rw, col, { ...cellOf(rw, col, ixfe), t: "s", v: String(internString(text)) });
    const putBoolErr = (rw, col, ixfe, isErr, b) => put(rw, col, isErr ? { ...cellOf(rw, col, ixfe), t: "e", v: XLS_ERRORS[b] || "#N/A" } : { ...cellOf(rw, col, ixfe), t: "b", v: b ? "1" : "0" });

    let dep = 0, r;
    for (let o = pos; pos >= 0 && (r = record(o)); o = r.next) {
      const p = r.data;
      if (r.type === XLS_REC.BOF) { dep++; continue; }
      if (r.type === XLS_REC.EOF) { if (--dep <= 0) break; continue; }
      if (dep !== 1) continue; // records of an embedded chart
      if (count >= XLS_MAX_CELLS && r.type !== XLS_REC.MERGECELLS) continue;
      const rw = u16(p, 0), col = u16(p, 2), ixfe = u16(p, 4);
      if (r.type !== XLS_REC.STRING) pending = null;
      switch (r.type) {
        case XLS_REC.LABELSST: { const s = sst[u32(p, 6)]; put(rw, col, { ...cellOf(rw, col, ixfe), t: "s", v: String(s ? u32(p, 6) : internString("")) }); break; }
        case XLS_REC.LABEL:
        case XLS_REC.RSTRING: putString(rw, col, ixfe, stringOf(r.parts, 6, 2).text); break;
        case XLS_REC.NUMBER: putNumber(rw, col, ixfe, f64(p, 6)); break;
        case XLS_REC.RK: putNumber(rw, col, ixfe, xlsRk(u32(p, 6) | 0)); break;
        case XLS_REC.MULRK: for (let o2 = 4, c = col; o2 + 6 <= p.length - 2; o2 += 6, c++) putNumber(rw, c, u16(p, o2), xlsRk(u32(p, o2 + 2) | 0)); break;
        case XLS_REC.MULBLANK: for (let o2 = 4, c = col; o2 + 2 <= p.length - 2; o2 += 2, c++) put(rw, c, cellOf(rw, c, u16(p, o2))); break;
        case XLS_REC.BLANK: put(rw, col, cellOf(rw, col, ixfe)); break;
        case XLS_REC.BOOLERR: putBoolErr(rw, col, ixfe, u8(p, 7), u8(p, 6)); break;
        case XLS_REC.FORMULA: {
          // Only the cached result is written: the parsed formula expression is not decoded.
          if (u16(p, 12) === 0xffff) {
            const kind = u8(p, 6);
            if (kind === 0) { pending = { rw, col, ixfe }; put(rw, col, { ...cellOf(rw, col, ixfe), t: "s", v: null }); } // text follows in STRING
            else if (kind === 1) putBoolErr(rw, col, ixfe, 0, u8(p, 8));
            else if (kind === 2) putBoolErr(rw, col, ixfe, 1, u8(p, 8));
            else putString(rw, col, ixfe, "");
          } else putNumber(rw, col, ixfe, f64(p, 6));
          break;
        }
        case XLS_REC.STRING: if (pending) { putString(pending.rw, pending.col, pending.ixfe, stringOf(r.parts, 0, 2).text); pending = null; } break;
        case XLS_REC.ROW: {
          const flags = u8(p, 12), ht = (u16(p, 6) & 0x7fff) / 20;
          if (flags & 0x60) rowProps.set(rw, { ht: flags & 0x40 ? ht : null, hidden: !!(flags & 0x20) });
          break;
        }
        case XLS_REC.COLINFO: cols.push({ first: u16(p, 0), last: u16(p, 2), width: u16(p, 4) / 256, hidden: !!(u16(p, 8) & 1) }); break;
        case XLS_REC.DEFCOLWIDTH: defColWidth = u16(p, 0); break;
        case XLS_REC.STANDARDWIDTH: stdWidth = u16(p, 0) / 256; break;
        case XLS_REC.DEFAULTROWHEIGHT: defRowHeight = u16(p, 2) / 20; break;
        case XLS_REC.MERGECELLS: {
          const n = u16(p, 0);
          for (let i = 0; i < n && 2 + i * 8 + 8 <= p.length; i++) {
            const o2 = 2 + i * 8, r1 = u16(p, o2), r2 = u16(p, o2 + 2), c1 = u16(p, o2 + 4), c2 = u16(p, o2 + 6);
            if (r2 >= r1 && c2 >= c1 && (r2 > r1 || c2 > c1)) merges.push(`${xlsColName(c1)}${r1 + 1}:${xlsColName(c2)}${r2 + 1}`);
          }
          break;
        }
        default: break;
      }
    }

    const out = ['<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    const rowNums = [...new Set([...rows.keys(), ...rowProps.keys()])].sort((a, b) => a - b);
    let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
    for (const [rw, row] of rows) { minR = Math.min(minR, rw); maxR = Math.max(maxR, rw); for (const c of row.keys()) { minC = Math.min(minC, c); maxC = Math.max(maxC, c); } }
    if (maxR >= 0) out.push(`<dimension ref="${xlsColName(minC)}${minR + 1}:${xlsColName(maxC)}${maxR + 1}"/>`);
    out.push(`<sheetFormatPr${defColWidth !== null ? ` baseColWidth="${defColWidth}"` : ""}${stdWidth !== null ? ` defaultColWidth="${xlsNum(stdWidth)}"` : ""} defaultRowHeight="${xlsNum(defRowHeight ?? 15)}"/>`);
    if (cols.length) {
      out.push("<cols>");
      let last = 0;
      for (const c of cols.sort((a, b) => a.first - b.first)) {
        const first = Math.max(c.first + 1, last + 1), end = Math.min(c.last + 1, 16384);
        if (end < first) continue;
        out.push(`<col min="${first}" max="${end}" width="${xlsNum(c.width)}" customWidth="1"${c.hidden ? ' hidden="1"' : ""}/>`);
        last = end;
      }
      out.push("</cols>");
    }
    out.push("<sheetData>");
    for (const rw of rowNums) {
      const props = rowProps.get(rw), row = rows.get(rw);
      let attrs = ` r="${rw + 1}"`;
      if (props && props.ht !== null) attrs += ` ht="${xlsNum(props.ht)}" customHeight="1"`;
      if (props && props.hidden) attrs += ' hidden="1"';
      if (!row) { out.push(`<row${attrs}/>`); continue; }
      out.push(`<row${attrs}>`);
      for (const c of [...row.keys()].sort((a, b) => a - b)) {
        const cell = row.get(c), ref = `${xlsColName(c)}${rw + 1}`, s = cell.s ? ` s="${cell.s}"` : "";
        if (cell.v === null) cell.v = String(internString("")); // a string formula without its STRING record
        if (!cell.t) out.push(`<c r="${ref}"${s}/>`);
        else if (cell.t === "n") out.push(`<c r="${ref}"${s}><v>${cell.v}</v></c>`);
        else out.push(`<c r="${ref}"${s} t="${cell.t}"><v>${escapeXmlText(cell.v)}</v></c>`);
      }
      out.push("</row>");
    }
    out.push("</sheetData>");
    if (merges.length) out.push(`<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`);
    out.push("</worksheet>");
    return out.join("");
  }

  // ---- the package
  const siXml = (s) => {
    if (!s.runs.length) return `<si><t xml:space="preserve">${escapeXmlText(s.text)}</t></si>`;
    const runs = s.runs.filter((r) => r[0] <= s.text.length).sort((a, b) => a[0] - b[0]);
    const pieces = [];
    const piece = (from, to, ifnt) => {
      if (to <= from) return;
      const f = ifnt === null ? null : fonts[fontId(ifnt)];
      pieces.push(`<r>${f ? `<rPr>${fontXml(f, "rFont")}</rPr>` : ""}<t xml:space="preserve">${escapeXmlText(s.text.slice(from, to))}</t></r>`);
    };
    piece(0, runs.length ? runs[0][0] : s.text.length, null);
    runs.forEach((r, i) => piece(r[0], i + 1 < runs.length ? runs[i + 1][0] : s.text.length, r[1]));
    return `<si>${pieces.join("") || '<t xml:space="preserve"></t>'}</si>`;
  };
  const parts = {};
  const nsMain = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const nsRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const relType = (t) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
  parts["[Content_Types].xml"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + "</Types>";
  parts["_rels/.rels"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${relType("officeDocument")}" Target="xl/workbook.xml"/></Relationships>`;
  parts["xl/workbook.xml"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<workbook xmlns="${nsMain}" xmlns:r="${nsRel}">${date1904 ? '<workbookPr date1904="1"/>' : "<workbookPr/>"}<sheets>`
    + sheets.map((s, i) => `<sheet name="${xlsAttr(s.name)}" sheetId="${i + 1}"${s.hidden ? ` state="${s.hidden === 2 ? "veryHidden" : "hidden"}"` : ""} r:id="rId${i + 1}"/>`).join("")
    + "</sheets></workbook>";
  parts["xl/_rels/workbook.xml.rels"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relType("worksheet")}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheets.length + 1}" Type="${relType("styles")}" Target="styles.xml"/>`
    + `<Relationship Id="rId${sheets.length + 2}" Type="${relType("sharedStrings")}" Target="sharedStrings.xml"/></Relationships>`;
  parts["xl/styles.xml"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<styleSheet xmlns="${nsMain}">`
    + (numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xlsAttr(code)}"/>`).join("")}</numFmts>` : "")
    + `<fonts count="${fonts.length}">${fonts.map((f) => `<font>${fontXml(f, "name")}</font>`).join("")}</fonts>`
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + "</styleSheet>";
  parts["xl/sharedStrings.xml"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="${nsMain}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(siXml).join("")}</sst>`;
  sheets.forEach((s, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + s.xml; });
  return parts;
}
