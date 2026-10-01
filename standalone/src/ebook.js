// ======================================================================
// E-books (EPUB and FB2): segments come from the XHTML / FictionBook source, translations are
// written back into that source (all other markup, images and styles stay as they are), and
// MuPDF lays the book out into pages for the viewer.
// ======================================================================

/** Page size and font size used to lay out e-books for the viewer (A5, 11 pt). */
const BOOK_LAYOUT = [420, 595, 11];

const BOOK_MIME = { epub: "application/epub+zip", fb2: "application/x-fictionbook" };

/** "pdf", "epub" or "fb2" from the file's first bytes (and its name as a hint). */
function detectKind(bytes, name = "") {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (head.startsWith("%PDF") || head.slice(0, 1024).includes("%PDF-")) return "pdf";
  if (head.startsWith("PK")) {
    if (head.includes("mimetypeapplication/epub+zip") || /\.epub$/i.test(name)) return "epub";
    if (/\.(fb2\.zip|fbz|zip)$/i.test(name) || /\.fb2/i.test(head)) return "fb2";
    return "epub";
  }
  if (/<FictionBook/i.test(head) || /\.fb2$/i.test(name)) return "fb2";
  // UTF-16 FB2
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return "fb2";
  return /\.epub$/i.test(name) ? "epub" : "pdf";
}

// --------------------------------------------------------------------- zip

/** Entries of a zip file: {name, method, crc, csize, size, raw (compressed bytes)}. */
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a valid zip file.");
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  const utf8 = new TextDecoder(), latin = new TextDecoder("latin1");
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? utf8 : latin).decode(nameBytes);
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    out.push({ name, method, crc, csize, size, raw: bytes.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function streamBytes(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipRead(entry) {
  if (entry.method === 0) return entry.raw;
  if (entry.method !== 8) throw new Error(`Unsupported compression in ${entry.name}.`);
  return streamBytes(entry.raw, new DecompressionStream("deflate-raw"));
}

/**
 * Write a zip. Entries are {name, raw, method, crc, csize, size} (copied as they are) or
 * {name, data, store} (compressed here unless `store`).
 */
async function zipWrite(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    let { raw, method, crc, csize, size } = e;
    if (e.data) {
      size = e.data.length;
      crc = crc32(e.data);
      if (e.store || typeof CompressionStream === "undefined") { raw = e.data; method = 0; } else {
        raw = await streamBytes(e.data, new CompressionStream("deflate-raw"));
        method = 8;
      }
      csize = raw.length;
    }
    const name = enc.encode(e.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, method, true);
    local.setUint32(14, crc, true); local.setUint32(18, csize, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, raw);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, method, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, csize, true); cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + raw.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}

/** The .fb2 file inside a zipped FB2 (.fb2.zip, .fbz); a plain FB2 is returned as it is. */
async function unzipFb2(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return bytes;
  const entry = zipEntries(bytes).find((e) => /\.fb2$/i.test(e.name));
  if (!entry) throw new Error("No .fb2 file in the zip archive.");
  return zipRead(entry);
}

// ----------------------------------------------------------------- XML text

/** Decode an XML file, honouring a BOM or the encoding in its XML declaration. */
function decodeXml(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const m = /^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  let label = m ? m[1].trim().toLowerCase() : "utf-8";
  try { return new TextDecoder(label).decode(bytes); } catch (_) { label = "utf-8"; }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Re-encode as UTF-8 and make the XML declaration say so. */
function encodeXml(text) {
  return new TextEncoder().encode(text.replace(/^(<\?xml[^>]*encoding\s*=\s*)(["'])[^"']*\2/i, "$1$2UTF-8$2"));
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", shy: "\u00ad", ndash: "–", mdash: "—",
  hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bdquo: "„", sbquo: "‚",
  copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•", times: "×", euro: "€", thinsp: "\u2009",
  ensp: "\u2002", emsp: "\u2003", zwnj: "\u200c", zwj: "\u200d", lrm: "\u200e", rlm: "\u200f", sect: "§", para: "¶",
};

function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (_) { return all; }
    }
    const v = NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

const escapeXmlText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A forgiving XML scanner that keeps source offsets: elements {name (local, lower case), s, cs,
 * ce, e, kids} where [cs, ce) is the content; text {text: true, s, e}.
 */
function parseXml(src) {
  const root = { name: "#root", s: 0, cs: 0, ce: src.length, e: src.length, kids: [], parent: null };
  let cur = root, i = 0;
  const n = src.length;
  const localName = (q) => { const k = q.indexOf(":"); return (k >= 0 ? q.slice(k + 1) : q).toLowerCase(); };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { cur.kids.push({ text: true, s: i, e: n }); break; }
    if (lt > i) cur.kids.push({ text: true, s: i, e: lt });
    let end;
    if (src.startsWith("<!--", lt)) {
      const k = src.indexOf("-->", lt + 4); end = k < 0 ? n : k + 3;
      cur.kids.push({ other: true, s: lt, e: end });
    } else if (src.startsWith("<![CDATA[", lt)) {
      const k = src.indexOf("]]>", lt + 9); end = k < 0 ? n : k + 3;
      cur.kids.push({ text: true, cdata: true, s: lt, e: end });
    } else if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      // processing instruction / doctype (possibly with an internal subset in brackets)
      let depth = 0, j = lt + 2;
      for (; j < n; j++) { const c = src[j]; if (c === "[") depth++; else if (c === "]") depth--; else if (c === ">" && depth <= 0) break; }
      end = j + 1;
      cur.kids.push({ other: true, s: lt, e: end });
    } else {
      let j = lt + 1, q = null;
      for (; j < n; j++) { const c = src[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; }
      end = Math.min(n, j + 1);
      if (src[lt + 1] === "/") {
        const name = localName(src.slice(lt + 2, end - 1).trim());
        let el = cur;
        while (el !== root && el.name !== name) el = el.parent;
        if (el !== root) {
          // close `el` (and anything left open inside it)
          for (let x = cur; x !== el.parent; x = x.parent) { if (x.ce === undefined) { x.ce = lt; x.e = x === el ? end : lt; } }
          cur = el.parent;
        }
      } else {
        const m = /^<([^\s/>]+)/.exec(src.slice(lt, Math.min(end, lt + 200)));
        const qname = m ? m[1] : "";
        const el = { name: localName(qname), qname, s: lt, cs: end, kids: [], parent: cur };
        cur.kids.push(el);
        if (src[end - 2] === "/") { el.ce = end; el.e = end; el.empty = true; } else cur = el;
      }
    }
    i = end;
  }
  for (let x = cur; x && x !== root; x = x.parent) if (x.ce === undefined) { x.ce = n; x.e = n; }
  return root;
}

// ----------------------------------------------------------- segment rules

const XHTML_RULES = {
  inline: new Set(["a", "abbr", "acronym", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i", "img",
    "ins", "kbd", "label", "mark", "q", "ruby", "rt", "rp", "rb", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time",
    "tt", "u", "var", "wbr", "svg", "math", "object", "video", "audio", "iframe", "canvas", "picture", "input", "select", "textarea", "button", "image"]),
  atomic: new Set(["img", "br", "wbr", "svg", "math", "object", "video", "audio", "iframe", "canvas", "picture", "input", "select", "textarea", "button", "image"]),
  skip: new Set(["head", "script", "style", "template", "pre", "noscript"]),
  br: "br",
};
const FB2_RULES = {
  inline: new Set(["emphasis", "strong", "style", "a", "strikethrough", "sub", "sup", "code", "image"]),
  atomic: new Set(["image"]),
  skip: new Set(["binary", "document-info", "publish-info", "custom-info", "src-title-info", "genre", "author", "lang", "src-lang",
    "translator", "sequence", "coverpage", "keywords", "date", "id", "version", "history", "output", "output-document-class", "empty-line", "stylesheet"]),
  br: null,
};
const NCX_RULES = { inline: new Set(), atomic: new Set(), skip: new Set(["head", "content", "meta"]), br: null };

const hasLetters = (s) => /[\p{L}\p{N}]/u.test(s);

/** Text of a range of nodes, without markup. */
function plainOf(src, nodes) {
  let out = "";
  const walk = (k) => {
    if (k.text) out += k.cdata ? src.slice(k.s + 9, k.e - 3) : decodeEntities(src.slice(k.s, k.e));
    else if (k.kids) k.kids.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/**
 * Runs of inline content inside block elements become segments. A segment's text marks inline
 * elements with numbered tags: <1>bold words</1>, <2/> for an image; a line break is "\n".
 */
function collectSegments(src, root, rules, out, tagName = "") {
  const isInline = (k) => k.text || k.other || rules.inline.has(k.name);
  const visit = (el) => {
    if (el.name && rules.skip.has(el.name)) return;
    let run = [];
    const flush = () => {
      if (run.length) makeSegment(src, run, rules, out, el.name === "#root" ? tagName : el.name);
      run = [];
    };
    for (const k of el.kids) {
      if (isInline(k)) run.push(k);
      else { flush(); visit(k); }
    }
    flush();
  };
  visit(root);
}

function makeSegment(src, run, rules, out, tag) {
  // Trim whitespace-only text and comments at both ends.
  let a = 0, b = run.length;
  const blank = (k) => k.other || (k.text && !k.cdata && !src.slice(k.s, k.e).trim());
  while (a < b && blank(run[a])) a++;
  while (b > a && blank(run[b - 1])) b--;
  let nodes = run.slice(a, b);
  if (!nodes.length || !hasLetters(plainOf(src, nodes))) return;
  const isAtomic = (k) => k.empty || rules.atomic.has(k.name) || (rules.br && k.name === rules.br);
  // One inline element around everything (<p><em>...</em></p>): its content is the segment.
  while (nodes.length === 1 && nodes[0].kids && !isAtomic(nodes[0]) && /\p{L}/u.test(plainOf(src, nodes[0].kids))
    && nodes[0].kids.every((k) => k.text || k.other || rules.inline.has(k.name))) {
    const inner = nodes[0].kids;
    let x = 0, y = inner.length;
    while (x < y && blank(inner[x])) x++;
    while (y > x && blank(inner[y - 1])) y--;
    if (x >= y) break;
    nodes = inner.slice(x, y);
  }
  const tags = {};
  let next = 1, text = "";
  // A styled first letter (drop cap: <span class="initial">N</span>o one…) is plain text in the
  // segment; its style goes onto the first letter of the translation.
  const first = nodes[0], after = nodes[1];
  if (first.kids && !isAtomic(first) && after && after.text && /^\p{L}/u.test(decodeEntities(src.slice(after.s, after.e)))
    && /^\p{L}{1,2}$/u.test(plainOf(src, first.kids).trim())) {
    const n = next++;
    tags[n] = { open: src.slice(first.s, first.cs), close: src.slice(first.ce, first.e), initial: true };
    text += plainOf(src, first.kids).trim();
    nodes = nodes.slice(1);
  }
  const walk = (k) => {
    if (k.other) return;
    if (k.text) { text += k.cdata ? src.slice(k.s + 9, k.e - 3) : decodeEntities(src.slice(k.s, k.e)); return; }
    if (rules.br && k.name === rules.br) { text += "\ue000"; return; }
    const n = next++;
    // Images, anchors and footnote references ("1", "[2]", "*": no letters) are kept whole and
    // are put back even when a translator drops their marker.
    if (isAtomic(k) || !/\p{L}/u.test(plainOf(src, k.kids))) {
      const shown = isAtomic(k) ? "" : plainOf(src, k.kids).replace(/\s+/g, " ").trim(); // e.g. a chapter or footnote number
      tags[n] = { empty: src.slice(k.s, k.e), keep: true, ...(shown ? { text: shown } : {}) };
      text += `<${n}/>`;
      return;
    }
    tags[n] = { open: src.slice(k.s, k.cs), close: src.slice(k.ce, k.e) };
    text += `<${n}>`;
    k.kids.forEach(walk);
    text += `</${n}>`;
  };
  nodes.forEach(walk);
  text = text.replace(/\s+/g, " ").replace(/ *\ue000 */g, "\n").trim();
  if (!/[\p{L}\p{N}]/u.test(text.replace(/<\/?\d+\/?>/g, ""))) return;
  const s = tags[1] && tags[1].initial ? first.s : nodes[0].s, e = nodes[nodes.length - 1].e;
  out.push({ text, s, e, tag, ...(next > 1 ? { tags } : {}) });
}

/** Turn a translation back into markup, restoring the segment's inline elements. */
function markupOf(translation, tags, rules) {
  tags = tags || {};
  const pieces = [];
  const re = /<(\/?)(\d+)(\/?)>|\n/g;
  let last = 0, m;
  while ((m = re.exec(translation))) {
    if (m.index > last) pieces.push({ text: translation.slice(last, m.index) });
    if (m[0] === "\n") pieces.push({ br: true });
    else {
      const id = Number(m[2]);
      if (!tags[id]) pieces.push({ text: m[0] }); // not ours: keep as text
      else pieces.push({ id, close: !!m[1], empty: !!m[3] });
    }
    last = re.lastIndex;
  }
  if (last < translation.length) pieces.push({ text: translation.slice(last) });
  // Pair opening and closing tags; tags that do not pair up are dropped.
  const stack = [], keep = new Set();
  pieces.forEach((p, i) => {
    if (p.id === undefined || p.empty) return;
    if (!p.close) { stack.push(i); return; }
    const top = stack.length ? stack[stack.length - 1] : -1;
    if (top >= 0 && pieces[top].id === p.id) { stack.pop(); keep.add(top); keep.add(i); }
  });
  const used = new Set();
  let out = "";
  pieces.forEach((p, i) => {
    if (p.text !== undefined) { out += escapeXmlText(p.text); return; }
    if (p.br) { out += rules.br ? "<br/>" : " "; return; }
    const tag = tags[p.id];
    if (p.empty) { if (tag.empty) { out += tag.empty; used.add(p.id); } return; }
    if (!keep.has(i) || tag.empty) return;
    out += p.close ? tag.close : tag.open;
    used.add(p.id);
  });
  // Footnote references, images and anchors the translator dropped are put back at the end.
  for (const [id, tag] of Object.entries(tags)) if (tag.keep && !used.has(Number(id))) out += tag.empty;
  // The drop cap goes on the translation's first letter.
  const initial = Object.values(tags).find((tag) => tag.initial);
  if (initial) {
    const m = /^((?:<[^>]*>|&[^;]*;|[^\p{L}<&])*)(\p{L})/u.exec(out);
    if (m) out = m[1] + initial.open + m[2] + initial.close + out.slice(m[0].length);
  }
  return out;
}

// ------------------------------------------------------------------- books

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
function resolvePath(base, href) {
  const parts = (dirOf(base) + decodeURIComponent(href.split("#")[0])).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return out.join("/");
}
const attrOf = (src, el, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(src.slice(el.s, el.cs));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
};
function findAll(el, pred, out = []) {
  for (const k of el.kids || []) if (k.kids) { if (pred(k)) out.push(k); findAll(k, pred, out); }
  return out;
}

/**
 * Open an e-book: {kind, files: [{path, src}], segments, entries (zip) | fb2 info}.
 * Segments carry {file, s, e, tags} to write the translation back.
 */
async function openBook(bytes, kind) {
  const files = [];
  const book = { kind, files, entries: null };
  if (kind === "fb2") {
    files.push({ path: "book.fb2", type: "fb2", src: decodeXml(await unzipFb2(bytes)) });
  } else {
    const entries = zipEntries(bytes);
    book.entries = entries;
    const byName = new Map(entries.map((e) => [e.name, e]));
    const text = async (name) => { const e = byName.get(name); return e ? decodeXml(await zipRead(e)) : null; };
    const container = await text("META-INF/container.xml");
    const opfPath = container && (/full-path\s*=\s*["']([^"']+)["']/.exec(container) || [])[1];
    const opfSrc = opfPath && await text(opfPath);
    if (!opfSrc) throw new Error("This EPUB has no package file (content.opf).");
    files.push({ path: opfPath, type: "opf", src: opfSrc });
    const opf = parseXml(opfSrc);
    const items = new Map();
    for (const it of findAll(opf, (k) => k.name === "item")) {
      items.set(attrOf(opfSrc, it, "id"), { href: resolvePath(opfPath, attrOf(opfSrc, it, "href") || ""), type: attrOf(opfSrc, it, "media-type") || "" });
    }
    const order = [];
    for (const ref of findAll(opf, (k) => k.name === "itemref")) {
      const it = items.get(attrOf(opfSrc, ref, "idref"));
      if (it && /html/.test(it.type) && !order.includes(it.href)) order.push(it.href);
    }
    const spine = order.length;
    for (const it of items.values()) if (/html/.test(it.type) && !order.includes(it.href)) order.push(it.href); // nav, other pages
    for (const it of items.values()) if (/dtbncx/.test(it.type) && !order.includes(it.href)) order.push(it.href);
    for (const [i, path] of order.entries()) {
      const src = await text(path);
      // Only the spine is shown in the viewer; metadata and table-of-contents files are not.
      if (src !== null) files.push({ path, type: /\.ncx$/i.test(path) ? "ncx" : "xhtml", src, hidden: i >= spine });
    }
    files[0].hidden = true;
  }
  const segments = [];
  files.forEach((f, fi) => {
    const root = parseXml(f.src);
    const segs = [];
    const desc = f.type === "fb2" ? findAll(root, (k) => k.name === "description")[0] : null;
    const descEnd = desc ? desc.e : -1;
    if (f.type === "opf") {
      for (const el of findAll(root, (k) => (k.name === "title" || k.name === "description") && /^dc:/i.test(k.qname))) {
        collectSegments(f.src, { name: "#root", kids: [el], s: el.s, e: el.e }, { inline: new Set(), atomic: new Set(), skip: new Set(), br: null }, segs, el.name);
      }
    } else if (f.type === "ncx") collectSegments(f.src, root, NCX_RULES, segs);
    else if (f.type === "fb2") collectSegments(f.src, root, FB2_RULES, segs);
    else {
      const body = findAll(root, (k) => k.name === "body")[0];
      if (body) collectSegments(f.src, body, XHTML_RULES, segs);
    }
    for (const s of segs) {
      // FB2 description (book title, annotation) is not shown in the laid-out book.
      const hidden = f.hidden || (f.type === "fb2" && s.s < descEnd);
      segments.push({ ...s, file: fi, ...(hidden ? { hidden: true } : {}) });
    }
  });
  return { book, segments };
}

const rulesFor = (type) => (type === "fb2" ? FB2_RULES : type === "ncx" ? NCX_RULES : type === "xhtml" ? XHTML_RULES : { br: null });

/** Write the translations into the book's files and return the new book bytes. */
async function saveBook(book, bytes, segments, translations, opts = {}) {
  const edits = new Map(); // file index -> [{s, e, text}]
  let replaced = 0;
  for (const seg of segments) {
    const tr = (translations[seg.id] || "").trim();
    if (!tr) continue;
    const f = book.files[seg.file];
    const raw = f.src.slice(seg.s, seg.e);
    const lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
    if (!edits.has(seg.file)) edits.set(seg.file, []);
    edits.get(seg.file).push({ s: seg.s, e: seg.e, text: lead + markupOf(tr, seg.tags, rulesFor(f.type)) + trail });
    replaced++;
  }
  const lang = (opts.lang || "").trim();
  const changed = new Map();
  book.files.forEach((f, fi) => {
    const list = (edits.get(fi) || []).sort((a, b) => a.s - b.s);
    if (!list.length && !lang) return;
    let out = "", pos = 0;
    for (const ed of list) { out += f.src.slice(pos, ed.s) + ed.text; pos = ed.e; }
    out += f.src.slice(pos);
    if (lang) out = setBookLanguage(out, f.type, lang);
    if (out !== f.src || list.length) changed.set(f.path, out);
  });
  let result;
  if (book.kind === "fb2") {
    result = encodeXml(changed.get("book.fb2") ?? book.files[0].src);
  } else {
    const entries = [];
    for (const e of book.entries) {
      if (changed.has(e.name)) entries.push({ name: e.name, data: encodeXml(changed.get(e.name)), store: e.name === "mimetype" });
      else if (e.name === "mimetype") entries.unshift({ ...e, data: await zipRead(e), store: true });
      else entries.push(e);
    }
    // The mimetype entry must come first and be stored uncompressed.
    entries.sort((a, b) => (b.name === "mimetype") - (a.name === "mimetype"));
    result = await zipWrite(entries);
  }
  return { bytes: result, stats: { replaced, untranslated: segments.length - replaced, shrunk: [], missing: 0, missingChars: "" } };
}

/** Mark the book as being in the target language (dc:language, lang attributes, FB2 <lang>). */
function setBookLanguage(src, type, lang) {
  const code = lang.replace(/[^A-Za-z0-9-]/g, "");
  if (!code) return src;
  if (type === "opf") return src.replace(/(<dc:language\b[^>]*>)[^<]*(<\/dc:language>)/i, `$1${code}$2`);
  if (type === "xhtml") {
    return src.replace(/<html\b[^>]*>/i, (tag) => tag.replace(/(\s(?:xml:)?lang\s*=\s*)(["'])[^"']*\2/gi, `$1$2${code}$2`));
  }
  if (type === "fb2") return src.replace(/(<title-info>[\s\S]*?<lang>)[^<]*(<\/lang>)/, `$1${code}$2`);
  return src;
}

// --------------------------------------------------------------- viewer map

/**
 * Text of the laid-out pages without spaces, in lower case, line by line: {text, lineAt (offset
 * of each line in text), linePage, lineBox}. Lines (not characters) keep it fast on long books.
 */
function bookChars(doc) {
  const n = doc.countPages();
  const pages = [], parts = [], lineAt = [], linePage = [], lineBox = [];
  let len = 0;
  for (let p = 0; p < n; p++) {
    const page = doc.loadPage(p);
    const b = page.getBounds();
    pages.push({ width: b[2] - b[0], height: b[3] - b[1], x0: b[0], y0: b[1], protect: [], graphics: { seps: [], containers: [] } });
    const st = page.toStructuredText();
    const json = JSON.parse(st.asJSON());
    free(st);
    free(page);
    for (const block of json.blocks || []) {
      for (const line of block.lines || []) {
        const text = line.text.replace(/[\s\u00ad]/g, "").toLowerCase();
        if (!text) continue;
        const bb = line.bbox;
        lineAt.push(len); linePage.push(p); lineBox.push([bb.x, bb.y, bb.x + bb.w, bb.y + bb.h]);
        parts.push(text);
        len += text.length;
      }
    }
  }
  return { pages, text: parts.join(""), lineAt, linePage, lineBox };
}

/** Index of the line that contains character `i`. */
function lineOf(chars, i) {
  let lo = 0, hi = chars.lineAt.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chars.lineAt[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const matchKey = (s) => s.replace(/<\/?\d+\/?>/g, "").replace(/[\s\u00ad]/g, "").toLowerCase();

/** A segment's text as the reader sees it: placeholders replaced by what they show ("1"). */
function shownText(text, tags) {
  if (!tags) return text;
  const used = new Set();
  let out = text.replace(/<(\d+)\/>/g, (m, n) => { used.add(n); return (tags[n] && tags[n].text) || ""; });
  for (const [n, tag] of Object.entries(tags)) if (tag.keep && tag.text && !used.has(n)) out += tag.text; // put back at the end
  return out;
}

/**
 * Find each segment on the laid-out pages, in reading order: {id: [[page, bbox], ...]}.
 * Segments that are not shown (metadata, table of contents files) get no box.
 */
function mapBook(chars, items) {
  const result = {};
  let cursor = 0;
  const keys = items.map((it) => (it.hidden ? "" : matchKey(it.text)));
  const nextKeys = new Array(keys.length);
  for (let k = keys.length - 1, nk = ""; k >= 0; k--) { nextKeys[k] = nk; if (keys[k]) nk = keys[k]; }
  for (let k = 0; k < items.length; k++) {
    const key = keys[k], id = items[k].id;
    if (!key) continue;
    const probe = key.slice(0, 48);
    let at = chars.text.indexOf(probe, cursor);
    if (at >= 0 && key.length < 8 && at - cursor > 4000) at = -1; // a short text found far ahead is probably another one
    // If the next segment is found before this one, this match is a repeat of the text further on.
    const nextKey = nextKeys[k];
    if (at > cursor && nextKey) {
      const nx = chars.text.indexOf(nextKey.slice(0, 48), cursor);
      if (nx >= 0 && nx < at) at = -1;
    }
    if (at < 0) continue;
    const end = Math.min(chars.text.length, at + key.length);
    const boxes = [];
    for (let li = lineOf(chars, at), last = lineOf(chars, end - 1); li <= last; li++) {
      const p = chars.linePage[li], prev = boxes[boxes.length - 1];
      if (prev && prev[0] === p) prev[1] = union(prev[1], chars.lineBox[li]);
      else boxes.push([p, chars.lineBox[li].slice()]);
    }
    result[id] = boxes.map(([p, b]) => [p, b.map(round2)]);
    cursor = end;
  }
  return result;
}

function openLaidOut(bytes, kind) {
  const doc = M.Document.openDocument(bytes, BOOK_MIME[kind]);
  doc.layout(...BOOK_LAYOUT);
  return doc;
}

/** Extract an e-book's segments and place them on the laid-out pages. */
async function extractBook(bytes, kind, doc) {
  const { book, segments } = await openBook(bytes, kind);
  segments.forEach((s, i) => { s.id = i + 1; });
  const chars = bookChars(doc);
  const map = mapBook(chars, segments.map((s) => ({ id: s.id, hidden: s.hidden, text: shownText(s.text, s.tags) })));
  let page = 0;
  for (const s of segments) {
    const boxes = map[s.id];
    if (boxes) { page = boxes[0][0]; s.page = page; s.bbox = boxes[0][1]; if (boxes.length > 1) s.boxes = boxes; } else { s.page = page; s.bbox = null; }
    s.skip = !/\p{L}/u.test(s.text.replace(/<\/?\d+\/?>/g, ""));
    s.lines = 1;
  }
  return { book, pages: chars.pages, segments };
}

/** Boxes of the translations in a rebuilt book, for the "Translated" view. */
function mapTranslated(doc, segments, translations) {
  const chars = bookChars(doc);
  const items = segments.map((s) => ({ id: s.id, hidden: s.hidden, text: shownText((translations[s.id] || "").trim() || s.text, s.tags) }));
  return { pages: chars.pages, boxes: mapBook(chars, items) };
}
