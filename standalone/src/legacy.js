// ======================================================================
// Legacy binary Office files (.doc, .xls, .ppt of Office 97–2003): the OLE compound file
// container, and the conversion of such a file into its Office Open XML equivalent when it is
// opened. The converters themselves are in doc.js, xls.js and ppt.js; the translated file is
// saved in the modern format (.docx, .xlsx, .pptx).
// ======================================================================

const LEGACY_KINDS = new Set(["doc", "xls", "ppt"]);
const LEGACY_TO_MODERN = { doc: "docx", xls: "xlsx", ppt: "pptx" };

/** The file starts with the compound file signature. */
const isCfb = (bytes) => bytes.length > 512 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;

const CFB_FREE = 0xfffffffa; // sector numbers from here up are markers (free, end of chain, FAT, DIFAT)

/**
 * Open a compound file. Returns {entries, stream(name)}: `entries` are the directory entries
 * ({name, type (1 storage, 2 stream, 5 root), size, start}), `stream(name)` returns the bytes of
 * the first stream with that name (case-insensitive, anywhere in the tree) or null.
 */
function cfbOpen(bytes) {
  if (!isCfb(bytes)) throw new Error("Not a compound (OLE) file.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (off) => (off + 4 <= bytes.length ? dv.getUint32(off, true) : CFB_FREE);
  const S = 1 << dv.getUint16(0x1e, true), MS = 1 << dv.getUint16(0x20, true);
  const nFat = u32(0x2c), dirStart = u32(0x30), miniCutoff = u32(0x38), miniFatStart = u32(0x3c);
  const perSector = S / 4;
  const sectorOff = (s) => (s + 1) * S;
  // The FAT sectors are listed in the header (109) and in the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const s = u32(0x4c + i * 4); if (s < CFB_FREE) fatSectors.push(s); }
  let difat = u32(0x44);
  for (let n = 0; n < u32(0x48) && difat < CFB_FREE && sectorOff(difat) + S <= bytes.length; n++) {
    const off = sectorOff(difat);
    for (let i = 0; i < perSector - 1 && fatSectors.length < nFat; i++) { const s = u32(off + i * 4); if (s < CFB_FREE) fatSectors.push(s); }
    difat = u32(off + S - 4);
  }
  const fat = new Uint32Array(fatSectors.length * perSector).fill(CFB_FREE);
  fatSectors.forEach((s, k) => { for (let i = 0; i < perSector; i++) fat[k * perSector + i] = u32(sectorOff(s) + i * 4); });
  const chain = (start, table) => {
    const out = [], seen = new Set();
    for (let s = start; s < CFB_FREE && s < table.length && !seen.has(s); s = table[s]) { seen.add(s); out.push(s); }
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat), out = new Uint8Array(Math.min(size, secs.length * S));
    secs.forEach((s, i) => {
      const off = sectorOff(s), n = Math.min(S, out.length - i * S);
      if (n > 0 && off + n <= bytes.length) out.set(bytes.subarray(off, off + n), i * S);
    });
    return out;
  };
  // Directory entries (128 bytes each, UTF-16 names).
  const dirBytes = readChain(dirStart, chain(dirStart, fat).length * S);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
    const type = dirBytes[off + 0x42], nameLen = Math.min(d.getUint16(0x40, true), 64);
    if (!type) continue;
    let name = "";
    for (let i = 0; i + 1 < nameLen; i += 2) { const c = d.getUint16(i, true); if (!c) break; name += String.fromCharCode(c); }
    entries.push({ name, type, start: d.getUint32(0x74, true), size: d.getUint32(0x78, true) });
  }
  // Small streams live in the mini stream of the root entry, addressed through the mini FAT.
  const root = entries.find((e) => e.type === 5);
  let mini = null, miniFat = null;
  const miniData = () => {
    if (!mini) {
      mini = root ? readChain(root.start, root.size) : new Uint8Array(0);
      const mf = readChain(miniFatStart, chain(miniFatStart, fat).length * S);
      miniFat = new Uint32Array(mf.buffer, mf.byteOffset, Math.floor(mf.length / 4));
    }
    return mini;
  };
  const stream = (name) => {
    const e = entries.find((x) => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
    if (!e) return null;
    if (e.size >= miniCutoff) return readChain(e.start, e.size);
    const data = miniData(), out = new Uint8Array(e.size);
    chain(e.start, miniFat).forEach((s, i) => {
      const off = s * MS, n = Math.min(MS, out.length - i * MS);
      if (n > 0 && off + n <= data.length) out.set(data.subarray(off, off + n), i * MS);
    });
    return out;
  };
  return { entries, stream };
}

/** "doc", "xls" or "ppt" for a compound file holding such a document, else null. */
function legacyKindOf(bytes, name = "") {
  if (!isCfb(bytes)) return null;
  let names;
  try { names = new Set(cfbOpen(bytes).entries.map((e) => e.name.toLowerCase())); } catch (_) { return null; }
  if (names.has("worddocument")) return "doc";
  if (names.has("workbook") || names.has("book")) return "xls";
  if (names.has("powerpoint document")) return "ppt";
  if (names.has("encryptedpackage")) throw new Error("This Office file is encrypted and cannot be opened.");
  const ext = (/\.(doc|xls|ppt)$/i.exec(name) || [])[1];
  return ext ? ext.toLowerCase() : null;
}

/**
 * Convert a legacy file to its Office Open XML equivalent. Returns {bytes, kind} with the
 * modern kind. Each converter gets the opened compound file and returns the package parts as
 * {path: string | Uint8Array} (strings are XML, encoded as UTF-8).
 */
async function convertLegacy(bytes, kind) {
  const cfb = cfbOpen(bytes);
  const parts = kind === "doc" ? await docToDocx(cfb) : kind === "xls" ? await xlsToXlsx(cfb) : await pptToPptx(cfb);
  return { bytes: await ooxmlZip(parts), kind: LEGACY_TO_MODERN[kind] };
}

/** Zip the parts of a package; [Content_Types].xml goes first. */
async function ooxmlZip(parts) {
  const enc = new TextEncoder();
  const names = Object.keys(parts).sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : 0));
  return zipWrite(names.map((name) => {
    const v = parts[name];
    return { name, data: typeof v === "string" ? enc.encode(v) : v };
  }));
}

/** Windows-1252 bytes to text (the 8-bit text of the old formats). */
const cp1252 = (() => {
  let dec = null;
  try { dec = new TextDecoder("windows-1252"); } catch (_) { dec = new TextDecoder("latin1"); }
  return (bytes) => dec.decode(bytes);
})();

/** UTF-16LE bytes to text. */
const utf16 = (() => { const dec = new TextDecoder("utf-16le"); return (bytes) => dec.decode(bytes); })();
