/* ----------------------------------------------------- subtitles, Markdown and plain text */
// SRT and WebVTT subtitles, Markdown and plain text files are books of one file: the segments
// are the cues or paragraphs (character ranges in the source), a translation replaces its text in
// place, and the viewer shows the file laid out as a simple page. Runs with the engine.

const TEXT_KINDS = new Set(["srt", "vtt", "md", "txt"]);
const TEXT_EXT = { srt: /\.srt$/i, vtt: /\.vtt$/i, md: /\.(md|markdown|mdown|mkd)$/i, txt: /\.(txt|text)$/i };

/** "srt", "vtt", "md" or "txt" for a text file (by its name, or by what it starts with), else null. */
function textKindOf(bytes, name, head) {
  for (const [k, re] of Object.entries(TEXT_EXT)) if (re.test(name)) return k;
  const h = head.replace(/^(ï»¿|﻿)/, "").trimStart(); // (the head is Latin-1 decoded: a UTF-8 BOM reads as ï»¿)
  if (/^WEBVTT(\s|$)/.test(h)) return "vtt";
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(h)) return "srt";
  return null;
}

/** The file as text: UTF-8 (with or without BOM), UTF-16 by its BOM, else Windows-1252. */
function decodeTextFile(bytes) {
  let enc = "utf-8", bom = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { enc = "utf-16le"; bom = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { enc = "utf-16be"; bom = 2; }
  let text;
  try { text = new TextDecoder(enc, { fatal: true }).decode(bytes.subarray(bom)); } catch (_) { enc = "windows-1252"; text = new TextDecoder("windows-1252").decode(bytes); }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Written back as UTF-8; a BOM marks it when the file had one, or came in another encoding.
  return { text, meta: { eol, bom: bom > 0 || enc !== "utf-8" } };
}
function encodeTextFile(text, meta) {
  const body = new TextEncoder().encode(text);
  if (!meta || !meta.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]); out.set(body, 3);
  return out;
}

/** The lines of a text with their ranges: [{s, e, text}] (e before the line break). */
function textLines(src) {
  const lines = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m;
  while ((m = re.exec(src))) {
    lines.push({ s: m.index, e: m.index + m[1].length, text: m[1] });
    if (m[2] === "") break;
  }
  return lines;
}
const trimRange = (src, s, e) => {
  while (s < e && /\s/.test(src[s])) s++;
  while (e > s && /\s/.test(src[e - 1])) e--;
  return [s, e];
};
const segText = (src, s, e) => escapeMarkers(src.slice(s, e).replace(/\r\n|\r/g, "\n"));

/**
 * A cue's inline tags (<i>…</i>, <b>, <u>, <font>, WebVTT <c.class>, <v Name>, timestamps
 * <00:01.000>, ASS codes like {\an8}) become the markers <1>…</1> and <2/> of a segment.
 */
function markCue(raw) {
  const tags = {}, open = [];
  let n = 0, out = "", last = 0, m;
  const re = /<(\/?)([A-Za-z][\w.-]*)([^<>]*)>|<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>|\{\\[^}]*\}/g;
  while ((m = re.exec(raw))) {
    out += escapeMarkers(raw.slice(last, m.index));
    const base = m[2] !== undefined ? m[2].toLowerCase().split(".")[0] : ""; // <c.yellow> closes with </c>
    if (m[2] !== undefined && !m[1]) { n++; tags[n] = { open: m[0], close: `</${base}>`, name: base }; open.push(n); out += `<${n}>`; }
    else if (m[2] !== undefined) {
      let k = -1;
      for (let i = open.length - 1; i >= 0; i--) if (tags[open[i]].name === base) { k = i; break; }
      if (k >= 0) { const id = open.splice(k, 1)[0]; tags[id].close = m[0]; out += `</${id}>`; } else out += escapeMarkers(m[0]); // a stray closing tag stays text
    } else { n++; tags[n] = { empty: m[0], text: "" }; out += `<${n}/>`; }
    last = re.lastIndex;
  }
  out += escapeMarkers(raw.slice(last));
  for (const id of open.reverse()) out += `</${id}>`; // tags left open close at the end
  return { text: out, tags: n ? tags : undefined };
}

/** Markers back to the cue's tags; pairs that do not match are dropped, position codes come back. */
function textMarkupOf(tr, tags) {
  tags = tags || {};
  const pieces = [];
  const re = /<(\/?)(\d+)(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(tr))) {
    if (m.index > last) pieces.push({ text: tr.slice(last, m.index) });
    const id = Number(m[2]);
    if (!tags[id]) pieces.push({ text: m[0] }); else pieces.push({ id, close: !!m[1], empty: !!m[3] });
    last = re.lastIndex;
  }
  if (last < tr.length) pieces.push({ text: tr.slice(last) });
  const stack = [], keep = new Set(), used = new Set();
  pieces.forEach((p, i) => {
    if (p.id === undefined || p.empty) return;
    if (!p.close) { stack.push(i); return; }
    const top = stack.length ? stack[stack.length - 1] : -1;
    if (top >= 0 && pieces[top].id === p.id) { stack.pop(); keep.add(top); keep.add(i); }
  });
  let out = "";
  for (const [i, p] of pieces.entries()) {
    if (p.text !== undefined) out += unescapeMarkers(p.text);
    else if (p.empty) { if (tags[p.id].empty) { out += tags[p.id].empty; used.add(p.id); } }
    else if (keep.has(i)) out += p.close ? tags[p.id].close : tags[p.id].open;
  }
  for (const [id, tag] of Object.entries(tags)) if (tag.empty && !used.has(Number(id))) out = tag.empty + out; // a position code the translation left out
  return out;
}

/** SRT / WebVTT: one segment per cue (its text lines), with the timing kept for the viewer. */
function cueSegments(src, kind) {
  const lines = textLines(src), segs = [];
  let i = 0;
  if (kind === "vtt") while (i < lines.length && lines[i].text.trim() !== "") i++; // the WEBVTT header block
  while (i < lines.length) {
    while (i < lines.length && lines[i].text.trim() === "") i++;
    if (i >= lines.length) break;
    const start = i;
    while (i < lines.length && lines[i].text.trim() !== "") i++;
    const block = lines.slice(start, i);
    const ti = block.findIndex((l) => l.text.includes("-->"));
    if (ti < 0 || ti === block.length - 1) continue; // NOTE, STYLE and REGION blocks, or a cue without text
    const s = block[ti + 1].s, e = block[block.length - 1].e;
    const { text, tags } = markCue(src.slice(s, e).replace(/\r\n|\r/g, "\n"));
    segs.push({ s, e, text, ...(tags ? { tags } : {}), tag: "cue", timing: block[ti].text.trim() });
  }
  return segs;
}

/** Plain text: one segment per paragraph (lines up to a blank line). */
function paragraphSegments(src) {
  const lines = textLines(src), segs = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].text.trim() === "") i++;
    if (i >= lines.length) break;
    const start = i;
    while (i < lines.length && lines[i].text.trim() !== "") i++;
    const [s, e] = trimRange(src, lines[start].s, lines[i - 1].e);
    if (e > s) segs.push({ s, e, text: segText(src, s, e), tag: "p" });
  }
  return segs;
}

/** Markdown: headings, paragraphs, list items, quotes and table cells; code, HTML and front matter stay. */
function markdownSegments(src) {
  const lines = textLines(src), segs = [];
  const push = (s, e, tag, level = 0) => {
    [s, e] = trimRange(src, s, e);
    if (e > s) segs.push({ s, e, text: segText(src, s, e), tag, ...(level ? { level } : {}) });
  };
  let i = 0;
  if (lines.length && /^---\s*$/.test(lines[0].text)) { // front matter
    let j = 1;
    while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j].text)) j++;
    if (j < lines.length) i = j + 1;
  }
  const BLOCK_START = /^\s{0,3}(#{1,6}\s|```|~~~|>|(?:[-*+]|\d+[.)])\s|\||<\w)/;
  const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
  let fence = null;
  while (i < lines.length) {
    const L = lines[i], t = L.text;
    if (fence) { if (new RegExp(`^\\s{0,3}\\${fence}{3,}\\s*$`).test(t)) fence = null; i++; continue; }
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(t);
    if (fm) { fence = fm[1][0]; i++; continue; }
    if (t.trim() === "") { i++; continue; }
    if (/^\s{0,3}<\w/.test(t)) { while (i < lines.length && lines[i].text.trim() !== "") i++; continue; } // an HTML block
    if (/^\s{0,3}\[[^\]]+\]:\s/.test(t) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(t)) { i++; continue; } // link reference, rule
    let m;
    if ((m = /^(\s{0,3}#{1,6}\s+)(.*?)(\s+#+\s*)?$/.exec(t))) { push(L.s + m[1].length, L.s + m[1].length + m[2].length, "h", m[1].trim().length); i++; continue; }
    if (/^\s{0,3}\|/.test(t) || (t.includes("|") && i + 1 < lines.length && /^\s{0,3}\|?\s*:?-{3,}/.test(lines[i + 1].text))) { // a table row
      if (!/^\s{0,3}\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(t)) {
        let cs = L.s;
        for (let p = L.s; p <= L.e; p++) {
          if (p === L.e || (src[p] === "|" && src[p - 1] !== "\\")) { push(cs, p, "td"); cs = p + 1; }
        }
      }
      i++; continue;
    }
    if ((m = /^(\s*>\s?)/.exec(t))) { push(L.s + m[1].length, L.e, "quote"); i++; continue; }
    if ((m = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(t))) { // a list item with its indented continuation lines
      let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j].text) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[j].text)) j++;
      push(L.s + m[1].length, lines[j - 1].e, "li");
      i = j; continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].text.trim() !== "" && !BLOCK_START.test(lines[j].text) && !SETEXT.test(lines[j].text)) j++;
    const setext = j < lines.length && SETEXT.test(lines[j].text) && j > i;
    push(L.s, lines[j - 1].e, setext ? "h" : "p", setext ? (lines[j].text.trim()[0] === "=" ? 1 : 2) : 0);
    i = setext ? j + 1 : j;
  }
  return segs;
}

const textSegments = (src, kind) => (kind === "srt" || kind === "vtt" ? cueSegments(src, kind) : kind === "md" ? markdownSegments(src) : paragraphSegments(src));

/** The text as a simple XHTML page for the viewer (timings in grey, headings and lists as such). */
function textHtml(kind, segs) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (seg) => {
    const tags = seg.tags || {};
    let html = "";
    const re = /<(\/?)(\d+)(\/?)>/g;
    let last = 0, m;
    while ((m = re.exec(seg.text))) {
      html += esc(unescapeMarkers(seg.text.slice(last, m.index)));
      const tag = tags[Number(m[2])];
      if (tag && !m[3]) { const h = ["i", "b", "u", "em", "strong"].includes(tag.name) ? tag.name : "span"; html += m[1] ? `</${h}>` : `<${h}>`; }
      else if (!tag) html += esc(m[0]);
      last = re.lastIndex;
    }
    html += esc(unescapeMarkers(seg.text.slice(last)));
    return html.replace(/\n/g, "<br/>");
  };
  const body = segs.map((s) => {
    const inner = inline(s);
    if (s.tag === "cue") return `<p class="t">${esc(s.timing)}</p><p>${inner}</p>`;
    if (s.tag === "h") return `<h${Math.min(3, s.level || 1)}>${inner}</h${Math.min(3, s.level || 1)}>`;
    if (s.tag === "li") return `<p class="li">• ${inner}</p>`;
    if (s.tag === "quote") return `<p class="q">${inner}</p>`;
    if (s.tag === "td") return `<p class="td">${inner}</p>`;
    return `<p>${inner}</p>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>.</title><style>
body { font-family: sans-serif; font-size: 11pt; } p { margin: 0 0 0.5em; }
.t { color: #888; font-size: 0.8em; margin: 0.7em 0 0.1em; } .li { margin-left: 1.2em; } .q { color: #555; border-left: 2pt solid #bbb; padding-left: 0.6em; } .td { margin: 0 0 0.2em; }
h1 { font-size: 1.8em; margin: 0.6em 0 0.4em; } h2 { font-size: 1.5em; margin: 0.6em 0 0.4em; } h3 { font-size: 1.25em; margin: 0.5em 0 0.3em; }
</style></head><body>${body}</body></html>`;
}

/** The text file as a book of one file with its segments. */
function openText(bytes, kind) {
  const { text, meta } = decodeTextFile(bytes);
  const segs = textSegments(text, kind);
  const book = { kind, files: [{ path: `text.${kind}`, type: kind, src: text, meta }], entries: null };
  return { book, segments: segs.map((s) => ({ ...s, file: 0 })) };
}

/** The text laid out as pages for the viewer. */
function openTextLaidOut(bytes, kind) {
  const { text } = decodeTextFile(bytes);
  const html = textHtml(kind, textSegments(text, kind));
  const doc = M.Document.openDocument(new TextEncoder().encode(html), "application/xhtml+xml");
  doc.layout(...BOOK_LAYOUT);
  return doc;
}

/** The edit that puts a translation into the text (bilingual: original, then translation). */
function textEdit(seg, f, tr, opts) {
  const eol = f.meta.eol;
  const out = textMarkupOf(tr, seg.tags).replace(/\r?\n/g, eol);
  if (!opts.bilingual) return { s: seg.s, e: seg.e, text: out };
  const sep = f.type === "srt" || f.type === "vtt" ? eol : f.type === "md" && seg.tag !== "p" ? " / " : eol + eol;
  return { s: seg.s, e: seg.e, text: f.src.slice(seg.s, seg.e) + sep + out };
}
