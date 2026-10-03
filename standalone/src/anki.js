/* ------------------------------------------------------------- Anki packages (.apkg) */
// An .apkg is a zip with an SQLite database (collection.anki2 / .anki21) and a media list. The
// reader walks the database's tables to pull the notes out of a deck; the writer builds a small
// database of its own – the tables Anki expects, with one Basic note per term – so that the
// vocabulary can be imported straight into Anki. Newer "collection.anki21b" packages are
// compressed with zstd and cannot be read here: Anki exports the older format when "support older
// Anki versions" is ticked.

/* ---- reading: the smallest SQLite reader that walks table b-trees */
function sqliteOpen(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 15)) !== "SQLite format 3") throw new Error("Not an SQLite database.");
  let pageSize = dv.getUint16(16);
  if (pageSize === 1) pageSize = 65536;
  const usable = pageSize - bytes[20];
  const td = new TextDecoder();
  const varint = (arr, pos) => { // [value, next position] read from `arr`; values beyond 2^53 lose precision (ids fit)
    let v = 0;
    for (let i = 0; i < 8; i++) { const b = arr[pos + i]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return [v, pos + i + 1]; }
    return [v * 256 + arr[pos + 8], pos + 9];
  };
  const pageBytes = (no) => bytes.subarray((no - 1) * pageSize, no * pageSize);
  /** The payload of a cell, following the overflow chain when it spills over the page. */
  const payloadOf = (page, pos, size) => {
    const maxLocal = usable - 35, minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let local = size;
    if (size > maxLocal) { const k = minLocal + ((size - minLocal) % (usable - 4)); local = k <= maxLocal ? k : minLocal; }
    const out = new Uint8Array(size);
    out.set(page.subarray(pos, pos + local), 0);
    let got = local, next = local < size ? new DataView(page.buffer, page.byteOffset + pos + local, 4).getUint32(0) : 0;
    while (next && got < size) {
      const op = pageBytes(next);
      const n = Math.min(size - got, usable - 4);
      out.set(op.subarray(4, 4 + n), got); got += n;
      next = new DataView(op.buffer, op.byteOffset, 4).getUint32(0);
    }
    return out;
  };
  /** A record's values: numbers, strings, Uint8Array blobs, null. */
  const decodeRecord = (p) => {
    const vals = [];
    let [hlen, pos] = (() => { let v = 0; for (let i = 0; i < 9; i++) { const b = p[i]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return [v, i + 1]; } return [v, 9]; })();
    const types = [];
    while (pos < hlen) { let v = 0, i = 0; for (; i < 9; i++) { const b = p[pos + i]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) break; } pos += i + 1; types.push(v); }
    let body = hlen;
    const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (const st of types) {
      if (st === 0) vals.push(null);
      else if (st >= 1 && st <= 6) {
        const n = [1, 2, 3, 4, 6, 8][st - 1];
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + p[body + i];
        if (p[body] & 0x80) v -= 2 ** (8 * n); // negative
        vals.push(v); body += n;
      } else if (st === 7) { vals.push(pdv.getFloat64(body)); body += 8; }
      else if (st === 8) vals.push(0);
      else if (st === 9) vals.push(1);
      else if (st >= 12) { const n = Math.floor((st - 12) / 2); vals.push(st % 2 ? td.decode(p.subarray(body, body + n)) : p.subarray(body, body + n)); body += n; }
    }
    return vals;
  };
  /** All rows of a table b-tree: [rowid, values[]]. */
  const rowsOf = (root) => {
    const out = [];
    const walk = (no) => {
      const page = pageBytes(no), off = no === 1 ? 100 : 0;
      const pdv = new DataView(page.buffer, page.byteOffset, page.byteLength);
      const type = page[off], cells = pdv.getUint16(off + 3);
      if (type === 0x05) { // interior: children left of each cell, then the right-most
        for (let i = 0; i < cells; i++) walk(pdv.getUint32(pdv.getUint16(off + 12 + 2 * i)));
        walk(pdv.getUint32(off + 8));
      } else if (type === 0x0d) {
        for (let i = 0; i < cells; i++) {
          let pos = pdv.getUint16(off + 8 + 2 * i);
          const [size, p1] = varint(page, pos); const [rowid, p2] = varint(page, p1);
          out.push([rowid, decodeRecord(payloadOf(page, p2, size))]);
        }
      }
    };
    walk(root);
    return out;
  };
  const master = rowsOf(1).map(([, v]) => ({ type: v[0], name: v[1], root: v[3], sql: v[4] }));
  return { table: (name) => { const t = master.find((m) => m.type === "table" && m.name === name); if (!t) throw new Error(`No table ${name}.`); return rowsOf(t.root).map(([, v]) => v); }, tables: master.filter((m) => m.type === "table").map((m) => m.name) };
}

const ankiPlain = (s) => (s || "").replace(/\[sound:[^\]]*\]/g, "").replace(/<br\s*\/?>|<\/div>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();

/** The notes of an .apkg as vocabulary rows, with the deck's name: {rows, deck, notes}. */
async function readApkg(bytes) {
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const dbEntry = byName.get("collection.anki21") || byName.get("collection.anki2");
  if (!dbEntry) throw new Error(byName.has("collection.anki21b") ? t("anki.zstd") : t("anki.noDb"));
  const db = sqliteOpen(await zipRead(dbEntry));
  const col = db.table("col")[0];
  let models = {}, decks = {};
  try { models = JSON.parse(col[9] || "{}"); decks = JSON.parse(col[10] || "{}"); } catch (_) { /* odd json: field positions are used */ }
  const deckNames = Object.values(decks).map((d) => d.name).filter((n) => n && n !== "Default");
  const rows = [];
  const EXAMPLE_RE = /example|beispiel|sentence|satz|пример|приклад|exemple|ejemplo|esempio|usage|context/i;
  const PRON_RE = /pinyin|pīnyīn|reading|romaji|furigana|translit|transcri|pronunc|aussprache|romani[sz]|jyutping|zhuyin|bopomofo|kana|ipa$/i;
  const MEDIA_RE = /audio|sound|image|picture|photo|bild|^ton$|mp3|recording/i;
  const langs = { src: "", tgt: "" }; // what the field names say about the languages ("Hanzi", "English")
  for (const n of db.table("notes")) {
    const flds = String(n[6] || "").split("\x1f");
    const model = models[String(n[2])];
    const names = model ? model.flds.map((f) => f.name) : [];
    let fi = 0, bi = 1, pi = -1;
    if (names.length) { // the front is the first field that is no example, pronunciation or media; the back the next such field
      const plain = (nm) => !EXAMPLE_RE.test(nm) && !PRON_RE.test(nm) && !MEDIA_RE.test(nm);
      fi = Math.max(0, names.findIndex(plain));
      bi = names.findIndex((nm, i) => i !== fi && plain(nm));
      if (bi < 0) bi = names.findIndex((nm, i) => i !== fi && !MEDIA_RE.test(nm) && !EXAMPLE_RE.test(nm));
      if (bi < 0) bi = fi === 0 ? 1 : 0;
      pi = names.findIndex((nm, i) => i !== fi && i !== bi && PRON_RE.test(nm));
      if (!langs.src) langs.src = fieldLang(names[fi]);
      if (!langs.tgt) langs.tgt = fieldLang(names[bi]);
    }
    let term = ankiPlain(flds[fi]);
    const translation = ankiPlain(flds[bi]);
    if (!term || !translation) continue;
    const pron = pi >= 0 ? ankiPlain(flds[pi]).replace(/\s*\n\s*/g, " ") : "";
    if (pron && pron !== term) term += ` (${pron})`; // 的 (de)
    const exIdx = names.findIndex((nm, i) => i !== fi && i !== bi && i !== pi && EXAMPLE_RE.test(nm));
    const rest = flds.map((f, i) => (i === fi || i === bi || i === pi || (names[i] && MEDIA_RE.test(names[i])) ? "" : ankiPlain(f))).filter(Boolean);
    let example = exIdx >= 0 ? ankiPlain(flds[exIdx]) : rest[0] || "", exampleTr = "";
    const exLines = example.split("\n").filter((l) => l.trim());
    if (exLines.length >= 2 && exLines.length % 2 === 0) { // "sentence / its translation" in one field, line by line
      const half = exLines.length / 2;
      example = exLines.slice(0, half).join(" "); exampleTr = exLines.slice(half).join(" ");
    } else example = exLines.join(" ");
    rows.push({ term: term.replace(/\s*\n\s*/g, " "), translation: translation.replace(/\s*\n\s*/g, " "), example, exampleTr });
  }
  return { rows, deck: deckNames[0] || "", notes: rows.length, langs };
}

/** The language a field name stands for ("English", "Deutsch", "Hanzi", "Kanji" …), or "". */
function fieldLang(name) {
  const n = (name || "").toLowerCase().replace(/\(.*?\)/g, "").trim();
  const extra = { hanzi: "zh", 汉字: "zh", 中文: "zh", mandarin: "zh", kanji: "ja", 日本語: "ja", hangul: "ko", 한국어: "ko", 한글: "ko", русский: "ru", українська: "uk", deutsch: "de", français: "fr", español: "es", italiano: "it", português: "pt" };
  if (extra[n]) return extra[n];
  return LANG_CODES[n] || "";
}

/* ---- writing: a small database with the tables Anki expects */
const PAGE = 4096;
const enc8 = new TextEncoder();
const putVarint = (out, v) => { // v up to 2^53
  const bytes = [];
  do { bytes.unshift(v % 128); v = Math.floor(v / 128); } while (v > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  out.push(...bytes);
};
/** An SQLite record from JS values (integers, strings, null). */
function sqliteRecord(values) {
  const types = [], body = [];
  for (const v of values) {
    if (v === null || v === undefined) types.push(0);
    else if (typeof v === "number") {
      if (v === 0) types.push(8); else if (v === 1) types.push(9);
      else {
        const neg = v < 0, abs = Math.abs(v);
        const n = abs < 0x80 ? 1 : abs < 0x8000 ? 2 : abs < 0x800000 ? 3 : abs < 0x80000000 ? 4 : abs < 0x800000000000 ? 6 : 8;
        types.push([1, 2, 3, 4, 6, 8].indexOf(n) + 1);
        let x = neg ? 2 ** (8 * n) + v : v;
        const bs = [];
        for (let i = 0; i < n; i++) { bs.unshift(x % 256); x = Math.floor(x / 256); }
        body.push(...bs);
      }
    } else { const b = enc8.encode(String(v)); types.push(13 + 2 * b.length); body.push(...b); }
  }
  const head = [];
  for (const st of types) putVarint(head, st);
  const hlen = []; putVarint(hlen, head.length + 1);
  if (hlen.length > 1) { hlen.length = 0; putVarint(hlen, head.length + hlen.length); }
  return Uint8Array.from([...hlen, ...head, ...body]);
}

/** The database file: tables as b-trees of leaf pages (with an interior page when there are many), overflow for long rows. */
function sqliteBuild(tables) {
  // tables: [{name, sql, rows: [[rowid, values]]}] – sqlite_master is page 1
  const pages = []; // Uint8Array per page, index = page number - 1
  const newPage = () => { pages.push(new Uint8Array(PAGE)); return pages.length; };
  const usable = PAGE, maxLocal = usable - 35, minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  /** A leaf cell: [size varint][rowid varint][local payload][overflow page no]. Overflow pages are made here. */
  const makeCell = (rowid, payload) => {
    const head = []; putVarint(head, payload.length); putVarint(head, rowid);
    let local = payload.length;
    if (payload.length > maxLocal) { const k = minLocal + ((payload.length - minLocal) % (usable - 4)); local = k <= maxLocal ? k : minLocal; }
    const cell = [...head, ...payload.subarray(0, local)];
    if (local < payload.length) {
      let pos = local, first = 0, prev = null;
      while (pos < payload.length) {
        const no = newPage(), pg = pages[no - 1];
        if (prev) new DataView(prev.buffer).setUint32(0, no); else first = no;
        const n = Math.min(payload.length - pos, usable - 4);
        pg.set(payload.subarray(pos, pos + n), 4); pos += n; prev = pg;
      }
      cell.push((first >>> 24) & 255, (first >>> 16) & 255, (first >>> 8) & 255, first & 255);
    }
    return { rowid, bytes: Uint8Array.from(cell) };
  };
  /** Cells into leaf pages; returns the page numbers (page 1 reserved for sqlite_master is passed as `fixed`). */
  const writeLeaves = (cells, fixed = 0) => {
    const leaves = [];
    let i = 0;
    do {
      const no = fixed && !leaves.length ? fixed : newPage();
      const pg = pages[no - 1], off = no === 1 ? 100 : 0;
      const dv = new DataView(pg.buffer);
      let top = PAGE, count = 0, ptr = off + 8;
      const pending = [];
      while (i < cells.length && top - cells[i].bytes.length >= ptr + 2 * (count + 1)) {
        top -= cells[i].bytes.length; pg.set(cells[i].bytes, top); pending.push(top); count++; i++;
      }
      pg[off] = 0x0d; dv.setUint16(off + 1, 0); dv.setUint16(off + 3, count); dv.setUint16(off + 5, top); pg[off + 7] = 0; // (an empty page: content starts at its end)
      pending.forEach((p, k) => dv.setUint16(ptr + 2 * k, p));
      leaves.push({ no, maxRowid: count ? cells[i - 1].rowid : 0 });
    } while (i < cells.length);
    return leaves;
  };
  /** One table: its root page number. */
  const writeTable = (rows, fixedRoot = 0) => {
    const cells = rows.map(([rowid, values]) => makeCell(rowid, sqliteRecord(values)));
    const leaves = writeLeaves(cells, fixedRoot);
    if (leaves.length === 1) return leaves[0].no;
    const no = fixedRoot || newPage(), pg = pages[no - 1], off = no === 1 ? 100 : 0, dv = new DataView(pg.buffer);
    if (fixedRoot) throw new Error("sqlite_master does not fit one page."); // (five tables: never)
    let top = PAGE;
    const ptrs = [];
    for (let k = 0; k < leaves.length - 1; k++) {
      const cell = []; const c = leaves[k].no; cell.push((c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255); putVarint(cell, leaves[k].maxRowid);
      top -= cell.length; pg.set(cell, top); ptrs.push(top);
    }
    pg[off] = 0x05; dv.setUint16(off + 1, 0); dv.setUint16(off + 3, ptrs.length); dv.setUint16(off + 5, top); pg[off + 7] = 0; dv.setUint32(off + 8, leaves[leaves.length - 1].no);
    ptrs.forEach((p, k) => dv.setUint16(off + 12 + 2 * k, p));
    return no;
  };
  newPage(); // page 1: sqlite_master
  const roots = tables.map((tb) => writeTable(tb.rows));
  const master = tables.map((tb, i) => [i + 1, ["table", tb.name, tb.name, roots[i], tb.sql]]);
  writeTable(master, 1);
  // the file header on page 1
  const h = pages[0], dv = new DataView(h.buffer);
  h.set(enc8.encode("SQLite format 3\0"), 0);
  dv.setUint16(16, PAGE); h[18] = 1; h[19] = 1; h[20] = 0; h[21] = 64; h[22] = 32; h[23] = 32;
  dv.setUint32(24, 1); dv.setUint32(28, pages.length); dv.setUint32(32, 0); dv.setUint32(36, 0);
  dv.setUint32(40, 1); dv.setUint32(44, 4); dv.setUint32(48, 0); dv.setUint32(52, 0); dv.setUint32(56, 1); dv.setUint32(60, 0); dv.setUint32(64, 0); dv.setUint32(68, 0);
  dv.setUint32(92, 1); dv.setUint32(96, 3045000);
  const out = new Uint8Array(PAGE * pages.length);
  pages.forEach((p, i) => out.set(p, i * PAGE));
  return out;
}

const ANKI_SQL = {
  col: "CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)",
  notes: "CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)",
  cards: "CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)",
  revlog: "CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)",
  graves: "CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)",
};
const htmlEsc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
async function sha1hex(text) {
  const d = await crypto.subtle.digest("SHA-1", enc8.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The vocabulary of a pair as an .apkg: one deck "Kameleon xx → yy", Basic notes (front: term, back: translation, examples under them). */
async function buildApkg(pair, rows) {
  const now = Date.now(), secs = Math.floor(now / 1000);
  const mid = now - 1, did = now - 2, deckName = `Kameleon ${pairLabel(pair)}`;
  const model = {
    id: mid, name: "Kameleon Basic", type: 0, mod: secs, usn: 0, sortf: 0, did, css: ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }\n.example { font-size: 15px; color: #555; margin-top: 10px; }",
    latexPre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n", latexPost: "\\end{document}", latexsvg: false,
    flds: ["Front", "Back", "Example", "ExampleTranslation"].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [], description: "" })),
    tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}<div class=example>{{Example}}</div>", afmt: "{{FrontSide}}<hr id=answer>{{Back}}<div class=example>{{ExampleTranslation}}</div>", bqfmt: "", bafmt: "", did: null, bfont: "", bsize: 0 }],
    req: [[0, "any", [0]]], tags: [], vers: [],
  };
  const deck = (id, name) => ({ id, name, mod: secs, usn: 0, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: "", dyn: 0, conf: 1, extendNew: 0, extendRev: 0 });
  const dconf = { 1: { id: 1, name: "Default", replayq: true, lapse: { leechFails: 8, minInt: 1, delays: [10], leechAction: 1, mult: 0 }, rev: { perDay: 200, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, ease4: 1.3, bury: false, minSpace: 1, hardFactor: 1.2 }, timer: 0, maxTaken: 60, usn: 0, new: { perDay: 20, delays: [1, 10], separate: true, ints: [1, 4, 0], initialFactor: 2500, bury: false, order: 1 }, mod: 0, autoplay: true } };
  const conf = { nextPos: rows.length + 1, estTimes: true, activeDecks: [1], sortType: "noteFld", timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0, dueCounts: true, curModel: String(mid), collapseTime: 1200 };
  const colRow = [1, [1, secs - (secs % 86400), now, now, 11, 0, 0, 0, JSON.stringify(conf), JSON.stringify({ [mid]: model }), JSON.stringify({ 1: deck(1, "Default"), [did]: deck(did, deckName) }), JSON.stringify(dconf), "{}"]];
  const notes = [], cards = [];
  const GUID = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (const [i, r] of rows.entries()) {
    const nid = now + i, cid = now + rows.length + i;
    let guid = ""; for (let k = 0; k < 10; k++) guid += GUID[Math.floor(Math.random() * GUID.length)];
    const front = htmlEsc(r.term), csum = parseInt((await sha1hex(r.term)).slice(0, 8), 16);
    const flds = [front, htmlEsc(r.translation), htmlEsc(r.example || ""), htmlEsc(r.exampleTr || "")].join("\x1f");
    notes.push([nid, [nid, guid, mid, secs, -1, ` kameleon ${pair} `, flds, r.term, csum, 0, ""]]);
    cards.push([cid, [cid, nid, did, 0, secs, -1, 0, 0, i + 1, 0, 0, 0, 0, 0, 0, 0, 0, ""]]);
  }
  const db = sqliteBuild([
    { name: "col", sql: ANKI_SQL.col, rows: [colRow] },
    { name: "notes", sql: ANKI_SQL.notes, rows: notes },
    { name: "cards", sql: ANKI_SQL.cards, rows: cards },
    { name: "revlog", sql: ANKI_SQL.revlog, rows: [] },
    { name: "graves", sql: ANKI_SQL.graves, rows: [] },
  ]);
  return zipWrite([{ name: "collection.anki2", data: db }, { name: "media", data: enc8.encode("{}") }]);
}
