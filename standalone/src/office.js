// ======================================================================
// Office documents (Word .docx, PowerPoint .pptx, Excel .xlsx): segments come from the Office
// Open XML parts, translations are written back into those parts (styles, images, formulas and
// everything else stay as they are), and a simple HTML preview is laid out by MuPDF for the
// viewer: the document as one flow, one page per slide, one page per sheet.
// ======================================================================

const OFFICE_KINDS = new Set(["docx", "pptx", "xlsx"]);
const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** Page size and font size of the preview: A4, a 4:3 slide, landscape A4. */
const OFFICE_LAYOUT = { docx: [595, 842, 10], pptx: [720, 540, 12], xlsx: [842, 595, 11] };
const XLSX_MAX_ROWS = 2000, XLSX_MAX_COLS = 50;

/** Content types of the main parts, and the usual paths (used when the package has no _rels/.rels). */
const OFFICE_MAIN_TYPE = {
  docx: /application\/vnd\.(?:openxmlformats-officedocument\.wordprocessingml\.document|ms-word\.(?:document|template)\.macroEnabled|openxmlformats-officedocument\.wordprocessingml\.template)\.main\+xml/,
  pptx: /application\/vnd\.(?:openxmlformats-officedocument\.presentationml\.(?:presentation|slideshow|template)|ms-powerpoint\.\w+\.macroEnabled)\.main\+xml/,
  xlsx: /application\/vnd\.(?:openxmlformats-officedocument\.spreadsheetml\.(?:sheet|template)|ms-excel\.\w+\.macroEnabled)\.main\+xml/,
};
const OFFICE_MAIN_PATH = { docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" };

/**
 * "docx", "pptx" or "xlsx" from the parts of a zip, or null. (Synchronous, so the compressed
 * package relationships cannot be read here: the kind comes from [Content_Types].xml when that
 * part is stored uncompressed, else from the names of the parts; openOffice then resolves the
 * main part itself.)
 */
function officeKindOf(bytes) {
  try {
    const entries = zipEntries(bytes);
    const ct = entries.find((e) => e.name === "[Content_Types].xml");
    if (ct && ct.method === 0) {
      const types = new TextDecoder().decode(ct.raw);
      for (const kind of Object.keys(OFFICE_MAIN_TYPE)) if (OFFICE_MAIN_TYPE[kind].test(types)) return kind;
    }
    const names = entries.map((e) => e.name);
    for (const kind of Object.keys(OFFICE_MAIN_PATH)) {
      const main = OFFICE_MAIN_PATH[kind];
      if (names.some((n) => n === main || new RegExp(`^${main.replace(/\.xml$/, "")}\\d*\\.xml$`).test(n))) return kind;
    }
    if (names.some((n) => n.startsWith("word/"))) return "docx";
    if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
    if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  } catch (_) { /* not a zip */ }
  return null;
}

// ---------------------------------------------------------- paragraphs

// Inside a paragraph (w:p, a:p) or a string item (si, is):
const OX_PARA = new Set(["p", "si", "is"]);
/** Elements around runs that are kept around the translated runs (links, insertions, fields). */
const OX_WRAP = new Set(["hyperlink", "smarttag", "ins", "customxml", "fldsimple", "dir", "bdo", "moveto"]);
/** Left out of the translation: paragraph properties, deleted text, spelling marks. */
const OX_DROP = new Set(["ppr", "endpararpr", "del", "movefrom", "prooferr", "lastrenderedpagebreak", "rph", "phoneticpr", "rpr",
  "deltext", "delinstrtext", "softhyphen", "annotationref"]);
/** Zero-width markers: carried to the start or end of the translation. */
const OX_MARK = new Set(["bookmarkstart", "bookmarkend", "commentrangestart", "commentrangeend", "permstart", "permend",
  "movefromrangestart", "movefromrangeend", "movetorangestart", "movetorangeend"]);
/** A run holding a drawing or text box: the paragraph's text is split around it. */
const OX_BLOCK = new Set(["drawing", "pict", "object", "alternatecontent"]);

/** A label of the preview (sheet name, slide number) that segment texts are never matched in. */
const label = (s) => escapeXmlText([...s].join("\u200b"));

const xmlAttr = (src, el, name) => {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(src.slice(el.s, el.cs));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
};
const kidsNamed = (el, name) => (el.kids || []).filter((k) => k.name === name);
const firstNamed = (el, name) => (el.kids || []).find((k) => k.name === name);

/* Pictures in the slide preview: the media parts become data URIs, sized from their EMU extents. */
const PIC_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff" };
const PIC_MAX_BYTES = 8 * 1048576, PIC_MAX_W = 680, PIC_MAX_H = 240;
function toBase64(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(str);
}
/** `<img>` for a `p:pic` whose picture is among `ctx.images` (relationship id → data URI). */
function oxPicHtml(src, pic, ctx) {
  const blip = findAll(pic, (x) => x.name === "blip")[0];
  const uri = blip && ctx.images[xmlAttr(src, blip, "r:embed") || ""];
  if (!uri) return "";
  const ext = findAll(pic, (x) => x.name === "ext" && xmlAttr(src, x, "cx"))[0];
  let w = ext ? +xmlAttr(src, ext, "cx") * ctx.scale : 120, h = ext ? +xmlAttr(src, ext, "cy") * ctx.scale : 90;
  if (!(w > 0 && h > 0)) { w = 120; h = 90; }
  const cap = Math.min(1, PIC_MAX_W / w, PIC_MAX_H / h);
  return `<img src="${uri}" width="${Math.max(6, Math.round(w * cap))}" height="${Math.max(6, Math.round(h * cap))}"/>`;
}
const hasDeep = (el, names) => (el.kids || []).some((k) => k.kids && (names.has(k.name) || hasDeep(k, names)));

/** Style key of a run: its properties without language and spelling flags. */
function runKey(rpr) {
  return rpr.replace(/<(?:\w+:)?lang\b[^>]*\/>/g, "").replace(/<(?:\w+:)?noProof\b[^>]*\/>/g, "")
    .replace(/\s(?:w:hint|lang|altLang|dirty|err|smtClean|smtId|noProof)="[^"]*"/g, "").replace(/\s+/g, " ")
    .replace(/<((?:\w+:)?rPr)\s*>\s*<\/\1>|<(?:\w+:)?rPr\s*\/>/g, "");
}

/**
 * Turn a paragraph into preview chunks and segments. Returns [string | {seg}]: the paragraph's
 * text as HTML pieces, with {seg: index} where a segment is shown.
 */
function oxParagraph(src, p, ctx) {
  const chunks = [];
  let toks = [], first = -1, last = -1;
  const flush = () => {
    if (toks.length) chunks.push(...oxSegment(src, p, toks, first, last, ctx));
    toks = []; first = last = -1;
  };
  const add = (tok, top) => { toks.push(tok); if (first < 0) first = top.s; last = top.e; };
  const plainT = p.name !== "p"; // xlsx string: <t> directly in <si>, or rich-text runs <r>
  const run = (r, wraps, top) => {
    const rprEl = firstNamed(r, "rpr");
    const rpr = rprEl ? src.slice(rprEl.s, rprEl.e) : "";
    const style = { rpr, wraps, open: src.slice(r.s, r.cs), close: src.slice(r.ce, r.e), q: r.qname };
    style.key = wraps.map((w) => w.open).join("") + "|" + runKey(rpr);
    const atom = (xml, shown = "") => add({ t: "atom", xml: style.open + rpr + xml + style.close, shown, wraps }, top);
    for (const k of r.kids) {
      if (k.text || k.other || OX_DROP.has(k.name)) continue;
      if (k.name === "t") {
        style.tq = k.qname;
        add({ t: "text", text: escapeMarkers(plainOf(src, k.kids)), style }, top);
      } else if ((k.name === "br" || k.name === "cr") && !/type\s*=\s*["'](page|column)/.test(src.slice(k.s, k.cs))) {
        add({ t: "br", style }, top);
      } else if (k.name === "nobreakhyphen") add({ t: "text", text: "\u2011", style }, top);
      else if (k.name === "tab") atom(src.slice(k.s, k.e), " ");
      else atom(src.slice(k.s, k.e)); // field characters, footnote references, symbols …
    }
  };
  const visit = (k, wraps, top) => {
    if (k.text || k.other || OX_DROP.has(k.name)) return;
    if (OX_MARK.has(k.name)) { add({ t: "mark", xml: src.slice(k.s, k.e) }, top); return; }
    if (k.name === "r" && top === k && hasDeep(k, OX_BLOCK)) {
      // A drawing or text box: its own paragraphs are shown (and translated) after this text.
      flush();
      chunks.push(...oxNested(src, k, ctx));
      return;
    }
    if (k.name === "r") { run(k, wraps, top); return; }
    if (k.name === "t" && plainT) {
      add({ t: "text", text: escapeMarkers(plainOf(src, k.kids)), style: { rpr: "", wraps, key: "|", plain: true, tq: k.qname } }, top);
      return;
    }
    if (k.name === "br" && k.qname.includes(":")) { // DrawingML line break <a:br><a:rPr/></a:br>
      const rprEl = firstNamed(k, "rpr");
      const rpr = rprEl ? src.slice(rprEl.s, rprEl.e) : "";
      add({ t: "br", style: { rpr, wraps, key: wraps.map((w) => w.open).join("") + "|" + runKey(rpr), q: k.qname.replace(/br$/, "r") } }, top);
      return;
    }
    if (OX_WRAP.has(k.name) && k.kids && !hasDeep(k, OX_BLOCK)) {
      const props = k.kids.filter((c) => c.kids && /pr$/.test(c.name)).map((c) => src.slice(c.s, c.e)).join("");
      const w = { open: src.slice(k.s, k.cs) + props, close: src.slice(k.ce, k.e) };
      for (const c of k.kids) if (!(c.kids && /pr$/.test(c.name))) visit(c, [...wraps, w], top);
      return;
    }
    // A run-level content control: <w:sdt><w:sdtPr/>…<w:sdtContent>runs</w:sdtContent></w:sdt>
    // is a wrapper around its content's runs.
    const content = k.name === "sdt" && !hasDeep(k, OX_BLOCK) ? firstNamed(k, "sdtcontent") : null;
    if (content && content.kids) {
      const props = k.kids.filter((c) => c.kids && /pr$/.test(c.name)).map((c) => src.slice(c.s, c.e)).join("");
      const w = { open: src.slice(k.s, k.cs) + props + src.slice(content.s, content.cs), close: src.slice(content.ce, content.e) + src.slice(k.ce, k.e) };
      for (const c of content.kids) visit(c, [...wraps, w], top);
      return;
    }
    // Anything else (a DrawingML field <a:fld>, math, an empty content control) is kept as it is.
    add({ t: "atom", xml: src.slice(k.s, k.e), shown: k.name === "fld" ? plainOf(src, k.kids).trim() : "", wraps }, top);
  };
  for (const k of p.kids) visit(k, [], k);
  flush();
  // A paragraph that is one segment can be repeated with its translation (bilingual file).
  const segChunks = chunks.filter((c) => typeof c === "object");
  if (segChunks.length === 1 && chunks.every((c) => typeof c === "object" || !c.includes("<div"))) {
    const seg = ctx.out[segChunks[0].seg];
    if (seg.ox.fmt !== "x") seg.block = { s: p.s, e: p.e, open: src.slice(p.s, p.cs), close: src.slice(p.ce, p.e) };
  }
  return chunks;
}

/** Paragraphs inside a drawing (text boxes): the fallback copy for old programs is skipped. */
function oxNested(src, el, ctx) {
  const chunks = [];
  const walk = (k) => {
    if (!k.kids || k.name === "fallback") return;
    if (k.name === "txbxcontent") {
      chunks.push('<div class="box">');
      chunks.push(...oxBlocks(src, k, { ...ctx, tag: "box" }));
      chunks.push("</div>");
      return;
    }
    k.kids.forEach(walk);
  };
  walk(el);
  return chunks;
}

/** One segment from a paragraph's tokens; returns its preview chunks. */
function oxSegment(src, p, toks, s, e, ctx) {
  // Neighbouring atoms (the parts of a field) become one.
  const list = [];
  for (const tk of toks) {
    const prev = list[list.length - 1];
    if (tk.t === "atom" && prev && prev.t === "atom" && oxWrapKey(prev.wraps) === oxWrapKey(tk.wraps)) list[list.length - 1] = { ...prev, xml: prev.xml + tk.xml, shown: prev.shown + tk.shown };
    else list.push(tk);
  }
  const plain = list.map((tk) => (tk.t === "text" ? tk.text : tk.t === "br" ? "\n" : tk.t === "atom" ? tk.shown : "")).join("");
  // No text of its own (only fields such as a slide's date, or line breaks): shown, not translated.
  if (!hasLetters(plain) || !list.some((tk) => tk.t === "text")) return plain.trim() ? [escapeXmlText(plain).replace(/\n/g, "<br/>")] : [];
  // The style with the most text is the paragraph's own; other styles become <n>…</n>.
  const weight = new Map();
  for (const tk of list) if (tk.t === "text") weight.set(tk.style.key, (weight.get(tk.style.key) || 0) + tk.text.length);
  let baseKey = null, best = -1;
  for (const [k, w] of weight) if (w > best) { best = w; baseKey = k; }
  const base = list.find((tk) => tk.t === "text" && tk.style.key === baseKey).style;
  const tags = {}, styles = {}, pre = [], post = [];
  let text = "", next = 1, open = null, any = false;
  const close = () => { if (open !== null) { text += `</${open.n}>`; open = null; } };
  for (const tk of list) {
    if (tk.t === "mark") { (any ? post : pre).push(tk.xml); continue; }
    any = true;
    if (tk.t === "atom") {
      close();
      const n = next++;
      tags[n] = { empty: tk.xml, keep: true, ...(tk.shown.trim() ? { text: tk.shown } : {}) };
      if (tk.wraps && tk.wraps.length) styles[n] = { wraps: tk.wraps }; // (the link or field the atom sits in)
      text += `<${n}/>`;
      continue;
    }
    const piece = tk.t === "br" ? "\ue000" : tk.text;
    const key = tk.style.key;
    if (key === baseKey || (tk.t === "br" && !weight.has(key))) { close(); text += piece; continue; }
    if (!open || open.key !== key) {
      close();
      const n = next++;
      tags[n] = {};
      styles[n] = tk.style;
      open = { n, key };
      text += `<${n}>`;
    }
    text += piece;
  }
  close();
  // Spaces at the ends (e.g. before a text box) are put back around the translation.
  const lead = /^[ \t]*/.exec(text)[0], trail = /[ \t]*$/.exec(text)[0];
  text = text.replace(/^[\s\ue000]+|[\s\ue000]+$/g, "").replace(/\ue000/g, "\n");
  const fmt = base.plain ? "x" : /^a:/.test(base.q || "") || p.qname.startsWith("a:") ? "a" : p.name === "p" ? "w" : "x";
  const seg = { text, s, e, tag: ctx.tag, file: ctx.file, ...(next > 1 ? { tags } : {}), ox: { base, styles, pre, post, fmt, lead, trail } };
  ctx.out.push(seg);
  return [{ seg: ctx.out.length - 1 }];
}

// ------------------------------------------------------------- writing back

/** A translation (with its <n> tags and line breaks) as Office XML runs. */
function oxMarkup(translation, seg, opts = {}) {
  const ox = seg.ox, tags = seg.tags || {};
  if (ox.lead && !/^\s/.test(translation)) translation = ox.lead + translation;
  if (ox.trail && !/\s$/.test(translation)) translation += ox.trail;
  const pieces = [];
  const re = /<(\/?)(\d+)(\/?)>|\n/g;
  let lastAt = 0, m;
  while ((m = re.exec(translation))) {
    if (m.index > lastAt) pieces.push({ text: translation.slice(lastAt, m.index) });
    if (m[0] === "\n") pieces.push({ br: true });
    else if (!tags[Number(m[2])]) pieces.push({ text: m[0] });
    else pieces.push({ id: Number(m[2]), close: !!m[1], empty: !!m[3] });
    lastAt = re.lastIndex;
  }
  if (lastAt < translation.length) pieces.push({ text: translation.slice(lastAt) });
  const stack = [], keep = new Set();
  pieces.forEach((p, i) => {
    if (p.id === undefined || p.empty) return;
    if (!p.close) { stack.push(i); return; }
    const top = stack.length ? stack[stack.length - 1] : -1;
    if (top >= 0 && pieces[top].id === p.id) { stack.pop(); keep.add(top); keep.add(i); }
  });
  if (ox.fmt === "x" && ox.base.plain) {
    // A plain spreadsheet string: one <t>, no formatting.
    let plainText = "";
    for (const p of pieces) plainText += p.text !== undefined ? unescapeMarkers(p.text) : p.br ? "\n" : p.empty && tags[p.id].text ? tags[p.id].text : "";
    const tq = ox.base.tq || "t";
    return `${ox.pre.join("")}<${tq} xml:space="preserve">${escapeXmlText(plainText)}</${tq}>${ox.post.join("")}`;
  }
  const used = new Set(), open = [], out = []; // out: [{xml, id?, wraps?}]
  const styleNow = () => (open.length && ox.styles[open[open.length - 1]]) || ox.base;
  const atomWraps = (id) => ({ wraps: (ox.styles[id] || {}).wraps });
  pieces.forEach((p, i) => {
    if (p.text !== undefined) { const st = styleNow(); out.push({ xml: oxRun(st, unescapeMarkers(p.text), ox.fmt, opts), wraps: st.wraps }); return; }
    if (p.br) { const st = styleNow(); out.push({ xml: oxBreak(st, ox.fmt, opts), wraps: st.wraps }); return; }
    const tag = tags[p.id];
    if (p.empty) { if (tag.empty) { out.push({ xml: tag.empty, id: p.id, ...atomWraps(p.id) }); used.add(p.id); } return; }
    if (!keep.has(i) || tag.empty) return;
    if (p.close) { const k = open.lastIndexOf(p.id); if (k >= 0) open.splice(k, 1); } else { open.push(p.id); out.push({ xml: "", id: p.id }); }
  });
  restoreDropped(out, tags, used, atomWraps);
  return ox.pre.join("") + oxWrapped(out) + ox.post.join("");
}

const oxWrapKey = (wraps) => (wraps || []).map((w) => w.open + "\u0001" + w.close).join("\u0002");
const oxWrapIn = (xml, wraps) => (wraps || []).reduceRight((inner, w) => w.open + inner + w.close, xml);

/**
 * Join runs (and atoms) and put each stretch of neighbours that sit in the same links, fields or
 * insertions into one copy of those wrapper elements.
 */
function oxWrapped(list) {
  let xml = "", group = null, key = null;
  const flush = () => { if (group) xml += oxWrapIn(group.xml, group.wraps); group = null; };
  for (const o of list) {
    if (!o.xml) continue;
    const k = oxWrapKey(o.wraps);
    if (group && k === key) group.xml += o.xml;
    else { flush(); group = { xml: o.xml, wraps: o.wraps }; key = k; }
  }
  flush();
  return xml;
}

/**
 * Run properties with the target language. In Word's rPr, w:lang goes after w:em and before
 * w:eastAsianLayout, w:specVanish, w:oMath and w:rPrChange; a run without properties gets some.
 */
function withLang(rpr, fmt, lang) {
  const code = (lang || "").replace(/[^A-Za-z0-9-]/g, "");
  if (!code) return rpr;
  if (fmt === "w") {
    if (!rpr) return `<w:rPr><w:lang w:val="${code}"/></w:rPr>`;
    if (/<w:lang\b[^>]*\bw:val="/.test(rpr)) return rpr.replace(/(<w:lang\b[^>]*\bw:val=")[^"]*"/, `$1${code}"`);
    if (/<w:lang\b/.test(rpr)) return rpr.replace(/<w:lang\b/, `<w:lang w:val="${code}"`);
    const langEl = `<w:lang w:val="${code}"/>`;
    if (/<w:rPr\s*\/>/.test(rpr)) return rpr.replace(/<w:rPr\s*\/>/, `<w:rPr>${langEl}</w:rPr>`);
    const after = /<w:(?:eastAsianLayout|specVanish|oMath|rPrChange)\b/.exec(rpr);
    const at = after ? after.index : rpr.lastIndexOf("</w:rPr>");
    return at < 0 ? rpr : rpr.slice(0, at) + langEl + rpr.slice(at);
  }
  if (fmt === "a") {
    if (!rpr) return `<a:rPr lang="${code}"/>`;
    if (/^<a:rPr\b[^>]*?\slang="/.test(rpr)) return rpr.replace(/^(<a:rPr\b[^>]*?\slang=")[^"]*"/, `$1${code}"`);
    return rpr.replace(/^<a:rPr\b/, `<a:rPr lang="${code}"`);
  }
  return rpr;
}

/** One run (without the wrapper elements around it: oxWrapped adds those). */
function oxRun(style, text, fmt, opts) {
  if (!text) return "";
  const rpr = withLang(style.rpr, fmt, opts.lang);
  const q = style.q || (fmt === "a" ? "a:r" : fmt === "w" ? "w:r" : "r");
  const tq = style.tq || q.replace(/r$/, "t");
  const runOpen = style.open || `<${q}>`, runClose = style.close || `</${q}>`;
  const t = fmt === "a" ? `<${tq}>${escapeXmlText(text)}</${tq}>` : `<${tq} xml:space="preserve">${escapeXmlText(text)}</${tq}>`;
  return `${runOpen.endsWith("/>") ? `<${q}>` : runOpen}${rpr}${t}${runOpen.endsWith("/>") ? `</${q}>` : runClose}`;
}

function oxBreak(style, fmt, opts) {
  if (fmt === "x") return oxRun(style, "\n", fmt, opts);
  const rpr = withLang(style.rpr, fmt, opts.lang);
  const q = style.q || (fmt === "a" ? "a:r" : "w:r");
  if (fmt === "a") {
    const bq = q.replace(/r$/, "br");
    return rpr ? `<${bq}>${rpr}</${bq}>` : `<${bq}/>`;
  }
  const runOpen = style.open && !style.open.endsWith("/>") ? style.open : `<${q}>`;
  return `${runOpen}${rpr}<${q.replace(/r$/, "br")}/></${q}>`;
}

/** Elements that must not be repeated in a paragraph's bilingual copy. */
const OX_COPY_DROP = new Set(["footnotereference", "endnotereference", "commentreference", "commentrangestart", "commentrangeend", "bookmarkstart", "bookmarkend"]);

/** Remove the elements `pred` selects (outermost ones) from a piece of XML. */
function oxStrip(xml, pred) {
  const root = parseXml(xml);
  const ranges = [];
  const walk = (el) => { for (const k of el.kids || []) if (k.kids) { if (pred(k)) ranges.push([k.s, k.e]); else walk(k); } };
  walk(root);
  if (!ranges.length) return xml;
  let out = "", pos = 0;
  for (const [s, e] of ranges) { out += xml.slice(pos, s); pos = e; }
  return out + xml.slice(pos);
}

/**
 * Bilingual file: a paragraph is repeated with the translation (without numbering, bookmarks,
 * comments, notes, anchored drawings and paragraph ids: those stay with the original); a
 * spreadsheet cell holds the original and the translation on two lines.
 */
function oxBilingual(seg, f, tr, opts) {
  // (a run that held only a dropped reference goes as a whole)
  const emptied = (r) => r.kids.some((c) => c.kids && OX_COPY_DROP.has(c.name)) && r.kids.every((c) => !c.kids || c.name === "rpr" || OX_COPY_DROP.has(c.name));
  const once = (xml) => (seg.ox.fmt === "w" ? oxStrip(xml, (k) => OX_COPY_DROP.has(k.name) || (k.name === "r" && (hasDeep(k, OX_BLOCK) || emptied(k)))) : xml);
  if (!seg.block && seg.ox.base.plain) return { s: seg.s, e: seg.e, text: oxMarkup(`${seg.text}\n${tr}`, seg, opts) };
  if (!seg.block) return { s: seg.s, e: seg.e, text: oxMarkup(seg.text, seg, {}) + oxWrapIn(oxBreak(seg.ox.base, seg.ox.fmt, {}), seg.ox.base.wraps) + once(oxMarkup(tr, seg, opts)) };
  const b = seg.block;
  const inner = f.src.slice(b.s + b.open.length, seg.s) + oxMarkup(tr, seg, opts) + f.src.slice(seg.e, b.e - b.close.length);
  const copy = (b.open + inner + b.close)
    .replace(/\s(?:w14:paraId|w14:textId)="[^"]*"/g, "")
    .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, "");
  return { s: b.e, e: b.e, text: once(copy) };
}

// ------------------------------------------------------------------ parts

/** Relationships of a part: {id: {target (resolved path), type}}. */
function oxRels(text, part) {
  const rels = {};
  if (!text) return rels;
  const relsPath = part.replace(/[^/]*$/, (n) => `_rels/${n}.rels`);
  const root = parseXml(text);
  for (const r of findAll(root, (k) => k.name === "relationship")) {
    const target = xmlAttr(text, r, "Target") || "";
    if (xmlAttr(text, r, "TargetMode") === "External") continue;
    rels[xmlAttr(text, r, "Id")] = { target: target.startsWith("/") ? target.slice(1) : resolvePath(relsPath.replace(/_rels\/[^/]*$/, ""), target), type: xmlAttr(text, r, "Type") || "" };
  }
  return rels;
}

/** Block-level content (Word body, header, footnote, table cell, text box) as preview chunks. */
function oxBlocks(src, el, ctx) {
  const chunks = [];
  for (const k of el.kids || []) {
    if (!k.kids) continue;
    if (k.name === "p") {
      const ppr = firstNamed(k, "ppr");
      const pprSrc = ppr ? src.slice(ppr.s, ppr.e) : "";
      const style = (/<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pprSrc) || [])[1] || "";
      const level = /^(title|titel|otsikko)$/i.test(style) ? 1 : +((/(?:heading|berschrift|otsikko|заголовок|titre)\s*(\d)/i.exec(style) || [])[1] || 0);
      const list = /<w:numPr>/.test(pprSrc);
      const tag = ctx.tag !== "p" ? ctx.tag : level ? `h${Math.min(level, 4)}` : list ? "li" : "p";
      const el2 = level ? `h${Math.min(level + 1, 4)}` : "p";
      chunks.push(`<${el2}${list ? ' class="li"' : ""}>${list ? "• " : ""}`);
      chunks.push(...oxParagraph(src, k, { ...ctx, tag }));
      chunks.push(`</${el2}>`);
    } else if (k.name === "tbl") {
      chunks.push("<table>");
      for (const tr of kidsNamed(k, "tr")) {
        chunks.push("<tr>");
        for (const tc of kidsNamed(tr, "tc")) {
          const span = /<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(src.slice(tc.s, tc.e));
          chunks.push(span ? `<td colspan="${span[1]}">` : "<td>");
          chunks.push(...oxBlocks(src, tc, { ...ctx, tag: ctx.tag === "p" ? "td" : ctx.tag }));
          chunks.push("</td>");
        }
        chunks.push("</tr>");
      }
      chunks.push("</table>");
    } else if (k.name === "fallback") {
      continue;
    } else if (k.name !== "sectpr" && k.name !== "tblpr" && k.name !== "tblgrid" && k.name !== "sdtpr") {
      chunks.push(...oxBlocks(src, k, ctx)); // content controls, custom XML, alternate content …
    }
  }
  return chunks;
}

/** DrawingML text (slides, notes, tables on slides) as preview chunks. */
function oxDrawing(src, el, ctx) {
  const chunks = [];
  for (const k of el.kids || []) {
    if (!k.kids || k.name === "fallback") continue;
    if (ctx.picsOnly && !/^(pic|grpsp)$/.test(k.name)) continue;
    if (k.name === "pic") {
      if (ctx.images) chunks.push(oxPicHtml(src, k, ctx));
    } else if (k.name === "sp") {
      const ph = findAll(k, (x) => x.name === "ph")[0];
      const type = ph ? xmlAttr(src, ph, "type") || "" : "";
      if (ctx.notes && /^(sldNum|sldImg|hdr|ftr|dt)$/.test(type)) continue;
      const title = /title/i.test(type);
      const body = findAll(k, (x) => x.name === "txbody")[0];
      if (!body) continue;
      chunks.push(title ? '<div class="title">' : '<div class="shape">');
      for (const p of kidsNamed(body, "p")) {
        chunks.push("<p>");
        chunks.push(...oxParagraph(src, p, { ...ctx, tag: ctx.notes ? "notes" : title ? "title" : "p" }));
        chunks.push("</p>");
      }
      chunks.push("</div>");
    } else if (k.name === "tbl") {
      chunks.push("<table>");
      for (const tr of kidsNamed(k, "tr")) {
        chunks.push("<tr>");
        for (const tc of kidsNamed(tr, "tc")) {
          chunks.push("<td>");
          const body = firstNamed(tc, "txbody");
          for (const p of body ? kidsNamed(body, "p") : []) {
            chunks.push("<p>");
            chunks.push(...oxParagraph(src, p, { ...ctx, tag: "td" }));
            chunks.push("</p>");
          }
          chunks.push("</td>");
        }
        chunks.push("</tr>");
      }
      chunks.push("</table>");
    } else {
      chunks.push(...oxDrawing(src, k, ctx)); // groups, graphic frames …
    }
  }
  return chunks;
}

/** "B12" -> 1 (the column index, from 0). */
function colIndex(ref) {
  const letters = (/^[A-Z]+/i.exec(ref || "") || [""])[0].toUpperCase();
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Open an Office document: {book: {kind, files, entries, preview}, segments}. The preview is a
 * list of HTML pieces and {seg: index} where a segment is shown; segments come in the order the
 * preview shows them (strings no sheet uses come last, marked hidden).
 */
async function openOffice(bytes, kind) {
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = async (name) => { const e = byName.get(name); return e ? decodeXml(await zipRead(e)) : null; };
  const relsOf = async (part) => oxRels(await text(part.replace(/[^/]*$/, (n) => `_rels/${n}.rels`)), part);
  const files = [], segments = [], preview = [];
  const book = { kind, files, entries, preview };
  const addFile = async (path) => {
    const src = await text(path);
    if (src === null) return null;
    files.push({ path, type: "ox", src });
    return { fi: files.length - 1, src, root: parseXml(src) };
  };
  const pageBreak = '<div class="pb"></div>';
  // The main part (word/document.xml, ppt/presentation.xml, xl/workbook.xml, or another name) from
  // the package relationships, else from the content types, else the usual path.
  const rootRel = Object.values(oxRels(await text("_rels/.rels"), "")).find((r) => /\/officeDocument$/i.test(r.type));
  let mainPath = rootRel && byName.has(rootRel.target) ? rootRel.target : null;
  if (!mainPath) {
    const ct = (await text("[Content_Types].xml")) || "";
    for (const o of findAll(parseXml(ct), (k) => k.name === "override")) {
      if (OFFICE_MAIN_TYPE[kind].test(xmlAttr(ct, o, "ContentType") || "")) { mainPath = (xmlAttr(ct, o, "PartName") || "").replace(/^\//, ""); break; }
    }
  }
  if (!mainPath || !byName.has(mainPath)) mainPath = OFFICE_MAIN_PATH[kind];

  if (kind === "docx") {
    const rels = await relsOf(mainPath);
    const parts = Object.values(rels);
    const ofType = (re) => parts.filter((r) => re.test(r.type)).map((r) => r.target).sort();
    const section = async (path, cls, tag) => {
      const f = await addFile(path);
      if (!f) return;
      const root = findAll(f.root, (k) => ["document", "hdr", "ftr", "footnotes", "endnotes"].includes(k.name))[0] || f.root;
      const body = root.name === "document" ? firstNamed(root, "body") || root : root;
      const ctx = { file: f.fi, out: segments, tag };
      const chunks = [];
      if (root.name === "footnotes" || root.name === "endnotes") {
        for (const note of [...kidsNamed(root, "footnote"), ...kidsNamed(root, "endnote")]) {
          if (xmlAttr(f.src, note, "w:type")) continue; // separators
          chunks.push(...oxBlocks(f.src, note, ctx));
        }
      } else chunks.push(...oxBlocks(f.src, body, ctx));
      if (chunks.some((c) => typeof c === "object" || /\w/.test(c.replace(/<[^>]*>/g, "")))) preview.push(cls ? `<div class="${cls}">` : "", ...chunks, cls ? "</div>" : "");
    };
    for (const h of ofType(/\/header$/)) await section(h, "hdr", "header");
    await section(mainPath, "", "p");
    for (const n of ofType(/\/(footnotes|endnotes)$/)) await section(n, "notes", "footnote");
    for (const h of ofType(/\/footer$/)) await section(h, "ftr", "footer");
  } else if (kind === "pptx") {
    const pres = await text(mainPath);
    const rels = await relsOf(mainPath);
    const presRoot = parseXml(pres || "");
    const slides = findAll(presRoot, (k) => k.name === "sldid").map((k) => rels[xmlAttr(pres, k, "r:id")]).filter(Boolean).map((r) => r.target);
    // Pictures: EMU → preview pixels; the media parts as data URIs (each read once).
    const sldSz = findAll(presRoot, (k) => k.name === "sldsz")[0];
    const sldCx = (sldSz && +xmlAttr(pres, sldSz, "cx")) || 9144000, sldCy = (sldSz && +xmlAttr(pres, sldSz, "cy")) || 6858000;
    const scale = Math.min(PIC_MAX_W / sldCx, 480 / sldCy);
    const uris = new Map();
    const dataUri = async (target) => {
      if (uris.has(target)) return uris.get(target);
      const e = byName.get(target), mime = PIC_MIME[(target.split(".").pop() || "").toLowerCase()];
      let uri = null;
      if (e && mime) { const data = await zipRead(e); if (data.length <= PIC_MAX_BYTES) uri = `data:${mime};base64,${toBase64(data)}`; }
      uris.set(target, uri);
      return uri;
    };
    const imagesOf = async (part) => {
      const out = {};
      for (const [id, r] of Object.entries(await relsOf(part))) if (/\/image$/.test(r.type)) { const u = await dataUri(r.target); if (u) out[id] = u; }
      return out;
    };
    const partOf = async (part) => { const src = await text(part); return src === null ? null : { part, src, root: parseXml(src), images: await imagesOf(part) }; };
    const bgHtml = (p) => {
      const bg = findAll(p.root, (k) => k.name === "bg")[0], blip = bg && findAll(bg, (k) => k.name === "blip")[0];
      const uri = blip && p.images[xmlAttr(p.src, blip, "r:embed") || ""];
      return uri ? `<img class="bg" src="${uri}" width="${Math.round((72 * sldCx) / sldCy)}" height="72"/>` : "";
    };
    for (const [i, path] of slides.entries()) {
      const f = await addFile(path);
      if (!f) continue;
      if (i) preview.push(pageBreak);
      preview.push(`<p class="slide-no">${label(String(i + 1))}</p>`);
      // The slide's artwork: its background (own, or the layout's, or the master's) as a small
      // strip, then the pictures of the master and layout, then its own shapes in order.
      const slide = { part: path, src: f.src, root: f.root, images: await imagesOf(path) };
      const layoutRel = Object.values(await relsOf(path)).find((r) => /\/slideLayout$/.test(r.type));
      const layout = layoutRel ? await partOf(layoutRel.target) : null;
      const masterRel = layout && Object.values(await relsOf(layout.part)).find((r) => /\/slideMaster$/.test(r.type));
      const master = masterRel ? await partOf(masterRel.target) : null;
      preview.push(bgHtml(slide) || (layout && bgHtml(layout)) || (master && bgHtml(master)) || "");
      const cSld = findAll(f.root, (k) => k.name === "csld")[0];
      if (!cSld || xmlAttr(f.src, cSld, "showMasterSp") !== "0") {
        for (const p of [master, layout]) {
          const ptree = p && findAll(p.root, (k) => k.name === "sptree")[0];
          if (ptree) preview.push(...oxDrawing(p.src, ptree, { images: p.images, scale, picsOnly: true }));
        }
      }
      const tree = findAll(f.root, (k) => k.name === "sptree")[0];
      if (tree) preview.push(...oxDrawing(f.src, tree, { file: f.fi, out: segments, tag: "p", images: slide.images, scale }));
      const notesRel = Object.values(await relsOf(path)).find((r) => /\/notesSlide$/.test(r.type));
      const nf = notesRel && await addFile(notesRel.target);
      const ntree = nf && findAll(nf.root, (k) => k.name === "sptree")[0];
      if (ntree) {
        const chunks = oxDrawing(nf.src, ntree, { file: nf.fi, out: segments, tag: "notes", notes: true });
        if (chunks.some((c) => typeof c === "object")) preview.push('<div class="notes">', ...chunks, "</div>");
      }
    }
  } else {
    const wbPath = mainPath;
    const wb = await text(wbPath);
    const rels = await relsOf(wbPath);
    const sstRel = Object.values(rels).find((r) => /\/sharedStrings$/.test(r.type));
    const sst = sstRel ? await addFile(sstRel.target) : null;
    const sstChunks = [];
    if (sst) {
      const table = findAll(sst.root, (k) => k.name === "sst")[0] || sst.root;
      for (const si of kidsNamed(table, "si")) sstChunks.push(oxParagraph(sst.src, si, { file: sst.fi, out: segments, tag: "cell" }));
    }
    const wbRoot = parseXml(wb || "");
    const sheets = findAll(wbRoot, (k) => k.name === "sheet").map((k) => ({ name: xmlAttr(wb, k, "name") || "", rel: rels[xmlAttr(wb, k, "r:id")] })).filter((s) => s.rel);
    for (const [i, sh] of sheets.entries()) {
      const f = await addFile(sh.rel.target);
      if (!f) continue;
      if (i) preview.push(pageBreak);
      preview.push(`<h2>${label(sh.name)}</h2><table>`);
      const data = findAll(f.root, (k) => k.name === "sheetdata")[0];
      const rows = data ? kidsNamed(data, "row") : [];
      for (const [ri, row] of rows.entries()) {
        const cells = [];
        for (const c of kidsNamed(row, "c")) {
          const col = colIndex(xmlAttr(f.src, c, "r"));
          const type = xmlAttr(f.src, c, "t") || "n";
          // Beyond the preview's size only inline strings matter: they are still translated (as
          // hidden segments, like shared strings no shown cell uses).
          const shown = ri < XLSX_MAX_ROWS && col >= 0 && col < XLSX_MAX_COLS;
          if (!shown && type !== "inlineStr") continue;
          const v = firstNamed(c, "v"), vText = v ? plainOf(f.src, v.kids) : "";
          let chunks = [];
          if (type === "s") chunks = v ? sstChunks[+vText] || [] : [];
          else if (type === "inlineStr") {
            const is = firstNamed(c, "is");
            if (is) chunks = oxParagraph(f.src, is, { file: f.fi, out: segments, tag: "cell" });
          } else if (type === "b") chunks = [vText === "1" ? "TRUE" : "FALSE"];
          else if (vText) chunks = [escapeXmlText(vText)];
          if (shown) cells[col] = chunks;
        }
        if (!cells.length) continue;
        preview.push("<tr>");
        for (let k = 0; k < cells.length; k++) preview.push("<td>", ...(cells[k] || []), "</td>");
        preview.push("</tr>");
      }
      preview.push("</table>");
    }
  }
  // Segments in the order the preview shows them, so they can be found on the laid-out pages.
  const order = [], seen = new Set();
  for (const c of preview) if (typeof c === "object" && !seen.has(c.seg)) { seen.add(c.seg); order.push(c.seg); }
  segments.forEach((_, k) => { if (!seen.has(k)) order.push(k); });
  const newIndex = new Map(order.map((k, i) => [k, i]));
  for (const c of preview) if (typeof c === "object") c.seg = newIndex.get(c.seg);
  const sorted = order.map((k) => (seen.has(k) ? segments[k] : { ...segments[k], hidden: true }));
  return { book, segments: sorted };
}

// ---------------------------------------------------------------- preview

const PREVIEW_CSS = `
body { font-family: sans-serif; margin: 0; }
p { margin: 0 0 0.45em; } p.li { margin-left: 1em; }
h2 { font-size: 1.6em; margin: 0.3em 0 0.4em; } h3 { font-size: 1.3em; margin: 0.3em 0; } h4 { font-size: 1.1em; margin: 0.3em 0; }
table { border-collapse: collapse; margin: 0.4em 0; }
td { border: 0.5pt solid #999; padding: 1pt 3pt; vertical-align: top; }
td p { margin: 0; }
.hdr, .ftr { color: #666; font-size: 0.85em; margin: 0 0 1em; }
.ftr { margin: 1em 0 0; }
.notes { color: #555; font-size: 0.9em; border-top: 0.5pt solid #aaa; margin-top: 1em; padding-top: 0.3em; }
.box { border: 0.5pt dashed #aaa; padding: 2pt 4pt; margin: 0.3em 0; }
.slide-no { color: #999; font-size: 0.75em; }
.title p { font-size: 1.5em; font-weight: bold; }
.shape { margin: 0 0 0.6em; }
.pb { page-break-after: always; }
img { display: block; margin: 0 0 0.4em; }
img.bg { margin: 0 0 0.5em; }
`;

/** CSS for a run's properties (bold, italic, underline, colour). */
function oxCss(rpr) {
  if (!rpr) return "";
  const css = [];
  const flag = (name) => {
    const el = new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*)?/>`).exec(rpr);
    if (el) return !/val="(0|false|off|none)"/i.test(el[1] || "");
    return new RegExp(`^<a:rPr\\b[^>]*\\s${name}="(1|true|sng|dbl|[a-z]+)"`).test(rpr) && !new RegExp(`\\s${name}="none"`).test(rpr);
  };
  if (flag("b")) css.push("font-weight:bold");
  if (flag("i")) css.push("font-style:italic");
  if (flag("u")) css.push("text-decoration:underline");
  const color = /<(?:\w+:)?color\b[^>]*?(?:w:val|rgb)="(?:FF)?([0-9A-Fa-f]{6})"/.exec(rpr) || /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr);
  if (color) css.push(`color:#${color[1]}`);
  return css.join(";");
}

/** A segment's text (original or translation) as preview HTML. */
function oxSegHtml(seg, text) {
  const tags = seg.tags || {}, ox = seg.ox;
  const used = new Set();
  let out = "", depth = 0;
  const re = /<(\/?)(\d+)(\/?)>|\n/g;
  let lastAt = 0, m;
  const esc = (s) => escapeXmlText(unescapeMarkers(s)); // (a literal "<1>" in the text is shown as such)
  while ((m = re.exec(text))) {
    out += esc(text.slice(lastAt, m.index));
    lastAt = re.lastIndex;
    if (m[0] === "\n") { out += "<br/>"; continue; }
    const id = Number(m[2]), tag = tags[id];
    if (!tag) { out += esc(m[0]); continue; }
    if (m[3]) { used.add(id); out += esc(tag.text || ""); continue; }
    if (m[1]) { if (depth) { out += "</span>"; depth--; } continue; }
    out += `<span style="${oxCss(ox.styles[id] && ox.styles[id].rpr)}">`;
    depth++;
  }
  out += esc(text.slice(lastAt));
  while (depth--) out += "</span>";
  for (const [id, tag] of Object.entries(tags)) if (tag.keep && tag.text && !used.has(Number(id))) out += esc(tag.text);
  const base = oxCss(ox.base.rpr);
  return base ? `<span style="${base}">${out}</span>` : out;
}

/** The preview as an HTML document, with translations where there are any. */
function officePreviewHtml(book, segments, translations = {}) {
  // (segment ids are their place in the extracted order, from 1)
  const byId = new Map(segments.map((sg) => [sg.id, sg]));
  const body = book.preview.map((c) => {
    if (typeof c === "string") return c;
    const seg = byId.get(c.seg + 1);
    if (!seg) return "";
    return oxSegHtml(seg, (translations[seg.id] || "").trim() || seg.text);
  }).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${PREVIEW_CSS}</style></head><body>${body}</body></html>`;
}

function openOfficePreview(book, segments, translations, kind) {
  const doc = M.Document.openDocument(new TextEncoder().encode(officePreviewHtml(book, segments, translations)), "text/html");
  doc.layout(...OFFICE_LAYOUT[kind]);
  return doc;
}
