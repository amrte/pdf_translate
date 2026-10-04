// ---------------------------------------------------------------------------------------------
// Rearranging pages. A plan lists the new pages in order: {from: 0, page} is a page of the open
// file (a PDF page may carry rot: 90, 180, 270 – turned clockwise – and skew: the tilt in degrees to take out), {from: k ≥ 1, page} a page of the k-th extra file, {from: -1, w, h} a blank page. A PDF
// is put together from the pages (grafted with their resources); a PPTX gets its slide list
// rewritten, dropped slides removed, blank slides added and slides of other decks copied in with
// their layouts, masters, themes and pictures. Runs with the engine.
// ---------------------------------------------------------------------------------------------

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml", wav: "audio/wav", mp3: "audio/mpeg", mp4: "video/mp4", m4v: "video/mp4",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bin: "application/vnd.openxmlformats-officedocument.oleObject", xml: "application/xml", rels: "application/vnd.openxmlformats-package.relationships+xml" };

/** The pages of the plan as a new PDF. `extras` are the bytes of the extra files (PDFs). */
function rearrangePdf(bytes, plan, extras) {
  const docs = [bytes, ...extras].map((b) => {
    const d = M.Document.openDocument(b.slice(), "application/pdf");
    if (d.needsPassword && d.needsPassword()) { free(d); throw new Error("A file is password-protected."); }
    return d;
  });
  const out = new M.PDFDocument();
  try {
    let n = 0;
    for (const it of plan) {
      const turn = (((Number(it.rot) || 0) % 360) + 360) % 360;
      if (it.from < 0) {
        const page = out.addPage([0, 0, it.w || 595, it.h || 842], turn, out.newDictionary(), "q Q");
        out.insertPage(-1, page);
        free(page);
      } else {
        const d = docs[it.from];
        if (!d || it.page < 0 || it.page >= d.countPages()) continue;
        out.graftPage(out.countPages(), d, it.page);
        if (turn) {
          // turned on top of the page's own /Rotate (which the graft copies onto the page)
          const pobj = out.findPage(out.countPages() - 1);
          const own = pobj.getInheritable("Rotate");
          const was = own.isNumber() ? own.asNumber() : 0;
          pobj.put("Rotate", (((was + turn) % 360) + 360) % 360);
        }
        if (it.skew) deskewPdfPage(out, out.findPage(out.countPages() - 1), Number(it.skew)); // (straightened, see deskew.js)
      }
      n++;
    }
    if (!n) throw new Error("No pages left.");
    const buf = out.saveToBuffer("garbage,compress");
    const res = buf.asUint8Array().slice();
    free(buf);
    return res;
  } finally {
    free(out);
    docs.forEach(free);
  }
}

/* ---------------------------------------------------------------- OOXML packages */

const relsPathOf = (part) => part.replace(/[^/]*$/, (n) => `_rels/${n}.rels`);
const dirOfPart = (part) => part.replace(/[^/]*$/, "");

/** Path of `to` relative to the directory of `from` ("../slideLayouts/slideLayout3.xml"). */
function relativePart(from, to) {
  const a = dirOfPart(from).split("/").filter(Boolean), b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return "../".repeat(a.length - i) + b.slice(i).join("/");
}

function pkgOpen(bytes) {
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const texts = new Map();
  const pkg = {
    entries, byName,
    async text(name) {
      if (texts.has(name)) return texts.get(name);
      const e = byName.get(name);
      const t = e ? decodeXml(await zipRead(e)) : null;
      texts.set(name, t);
      return t;
    },
  };
  return pkg;
}

/** The relationships of a part: [{id, type, target (absolute part path, or the URL), external}]. */
async function pkgRels(pkg, part) {
  const xml = await pkg.text(relsPathOf(part));
  const out = [];
  if (!xml) return out;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = (name) => { const r = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(m[1]); return r ? decodeEntities(r[1]) : null; };
    const target = a("Target") || "", external = a("TargetMode") === "External";
    out.push({ id: a("Id"), type: a("Type") || "", target: external ? target : target.startsWith("/") ? target.slice(1) : resolvePath(part, target), external });
  }
  return out;
}

const relsXml = (rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">` +
  rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXmlText(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("") + "</Relationships>";

/** [Content_Types].xml as maps, and back. */
async function pkgContentTypes(pkg) {
  const xml = (await pkg.text("[Content_Types].xml")) || "";
  const defaults = new Map(), overrides = new Map();
  for (const m of xml.matchAll(/<Default\s+Extension="([^"]*)"\s+ContentType="([^"]*)"/g)) defaults.set(m[1].toLowerCase(), m[2]);
  for (const m of xml.matchAll(/<Default\s+ContentType="([^"]*)"\s+Extension="([^"]*)"/g)) defaults.set(m[2].toLowerCase(), m[1]);
  for (const m of xml.matchAll(/<Override\s+PartName="([^"]*)"\s+ContentType="([^"]*)"/g)) overrides.set(m[1], m[2]);
  for (const m of xml.matchAll(/<Override\s+ContentType="([^"]*)"\s+PartName="([^"]*)"/g)) overrides.set(m[2], m[1]);
  return { defaults, overrides };
}
const contentTypesXml = (ct) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  [...ct.defaults].map(([e, c]) => `<Default Extension="${e}" ContentType="${c}"/>`).join("") +
  [...ct.overrides].map(([p, c]) => `<Override PartName="${escapeXmlText(p)}" ContentType="${c}"/>`).join("") + "</Types>";

/**
 * The slides of the plan as a new PPTX. Slides of the open deck keep their parts; a slide used
 * twice is duplicated; slides from other decks are copied with everything they refer to.
 */
async function rearrangePptx(bytes, plan, extras, opts = {}) {
  const pkg = pkgOpen(bytes);
  const rootRel = (await pkgRels(pkg, "")).find((r) => /\/officeDocument$/.test(r.type));
  const presPath = rootRel && pkg.byName.has(rootRel.target) ? rootRel.target : "ppt/presentation.xml";
  const pres = await pkg.text(presPath);
  if (!pres) throw new Error("Not a PowerPoint file.");
  const presRels = await pkgRels(pkg, presPath);
  const ct = await pkgContentTypes(pkg);
  const relById = new Map(presRels.map((r) => [r.id, r]));
  const slides = [...pres.matchAll(/<p:sldId\b([^>]*)\/>/g)].map((m) => {
    const id = /\sid="(\d+)"/.exec(m[1]), rid = /\sr:id="([^"]+)"/.exec(m[1]);
    const rel = rid && relById.get(rid[1]);
    return rel ? { id: Number(id ? id[1] : 0), rId: rid[1], target: rel.target } : null;
  }).filter(Boolean);

  const names = new Set(pkg.byName.keys());
  const added = new Map(); // name → {data} | {entry}
  const removed = new Set();
  const alloc = (path) => {
    const m = /^(.*\/)?([^/]*?)\d*(\.[^./]+)$/.exec(path);
    const dir = (m && m[1]) || "", base = m ? m[2] : "part", ext = m ? m[3] : "";
    let n = 1;
    while (names.has(`${dir}${base}${n}${ext}`)) n++;
    const name = `${dir}${base}${n}${ext}`;
    names.add(name);
    return name;
  };
  const addText = (name, xml) => { added.set(name, { data: encodeXml(xml) }); names.add(name); };
  const ensureType = (newName, srcCt, srcPath) => {
    const over = srcCt.overrides.get(`/${srcPath}`);
    if (over) { ct.overrides.set(`/${newName}`, over); return; }
    const ext = (newName.split(".").pop() || "").toLowerCase();
    if (!ct.defaults.has(ext)) ct.defaults.set(ext, srcCt.defaults.get(ext) || MIME_BY_EXT[ext] || "application/octet-stream");
  };
  let nextRel = Math.max(0, ...presRels.map((r) => Number((/^rId(\d+)$/.exec(r.id) || [0, 0])[1]))) + 1;
  const newRel = () => `rId${nextRel++}`;
  let nextSlideId = Math.max(255, ...slides.map((s) => s.id)) + 1;
  let nextBigId = Math.max(2147483647, ...[...pres.matchAll(/<p:sld(?:Master|Layout)Id\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;

  // --- copying parts (from another deck, or a duplicate within this one)
  const DROP = /\/(notesSlide|slide|comments|commentAuthors|tags)$/; // links to other slides and notes are not copied
  const newMasters = [];
  const copyPart = async (src, srcCt, path, cache, shallow) => {
    if (cache.has(path)) return cache.get(path);
    const e = src.byName.get(path);
    if (!e) return null;
    const name = alloc(path);
    cache.set(path, name);
    ensureType(name, srcCt, path);
    const rels = await pkgRels(src, path);
    if (rels.length) {
      const out = [];
      for (const r of rels) {
        if (r.external) { out.push(r); continue; }
        if (DROP.test(r.type)) continue;
        if (shallow) { out.push({ ...r, target: relativePart(name, r.target) }); continue; } // (the parts exist in this deck)
        const child = await copyPart(src, srcCt, r.target, cache, false);
        if (child) out.push({ ...r, target: relativePart(name, child) });
      }
      addText(relsPathOf(name), relsXml(out));
    }
    if (/\/slideMasters\/[^/]+\.xml$/.test(path)) {
      // the layout ids of a copied master must be unique in the deck; the master is registered
      let xml = await src.text(path);
      xml = xml.replace(/(<p:sldLayoutId\b[^>]*\sid=")(\d+)(")/g, (m, a, _id, c) => `${a}${nextBigId++}${c}`);
      addText(name, xml);
      newMasters.push(name);
    } else { added.set(name, { entry: e }); }
    return name;
  };

  // --- blank slides use the deck's blank layout (else the first layout)
  let blankLayout = null;
  for (const n of names) {
    if (!/^ppt\/slideLayouts\/[^/]+\.xml$/.test(n)) continue;
    const xml = await pkg.text(n);
    if (/<p:sldLayout\b[^>]*\stype="blank"/.test(xml)) { blankLayout = n; break; }
    if (!blankLayout) blankLayout = n;
  }
  const blankSlide = () => {
    const name = alloc("ppt/slides/slide1.xml");
    ct.overrides.set(`/${name}`, CT_SLIDE);
    addText(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    addText(relsPathOf(name), relsXml(blankLayout ? [{ id: "rId1", type: `${REL_TYPE}slideLayout`, target: relativePart(name, blankLayout) }] : []));
    return name;
  };

  // --- the new slide list
  const extraPkgs = new Map();
  const extraOf = async (k) => {
    if (!extraPkgs.has(k)) {
      const p = pkgOpen(extras[k - 1]);
      const root = (await pkgRels(p, "")).find((r) => /\/officeDocument$/.test(r.type));
      const pp = root && p.byName.has(root.target) ? root.target : "ppt/presentation.xml";
      const px = await p.text(pp);
      if (!px) throw new Error("An added file is not a PowerPoint file.");
      const rels = new Map((await pkgRels(p, pp)).map((r) => [r.id, r]));
      const list = [...px.matchAll(/<p:sldId\b([^>]*)\/>/g)].map((m) => { const rid = /\sr:id="([^"]+)"/.exec(m[1]); const r = rid && rels.get(rid[1]); return r ? r.target : null; }).filter(Boolean);
      extraPkgs.set(k, { pkg: p, ct: await pkgContentTypes(p), slides: list, cache: new Map() });
    }
    return extraPkgs.get(k);
  };
  const usedOwn = new Set();
  const list = []; // {id, rId, target, newRel?}
  for (const it of plan) {
    if (it.from === 0) {
      const s = slides[it.page];
      if (!s) continue;
      if (!usedOwn.has(s.target)) { usedOwn.add(s.target); list.push(s); continue; }
      const copy = await copyPart(pkg, ct, s.target, new Map(), true); // the same slide a second time
      list.push({ id: nextSlideId++, rId: newRel(), target: copy, added: true });
    } else if (it.from < 0) {
      list.push({ id: nextSlideId++, rId: newRel(), target: blankSlide(), added: true });
    } else {
      const ex = await extraOf(it.from);
      const target = ex.slides[it.page];
      if (!target) continue;
      const copy = await copyPart(ex.pkg, ex.ct, target, ex.cache, false);
      if (copy) list.push({ id: nextSlideId++, rId: newRel(), target: copy, added: true });
    }
  }
  if (!list.length) throw new Error("No slides left.");

  // --- slides that are no longer used go, with their notes
  for (const s of slides) {
    if (usedOwn.has(s.target)) continue;
    const drop = (name) => { removed.add(name); removed.add(relsPathOf(name)); ct.overrides.delete(`/${name}`); };
    for (const r of await pkgRels(pkg, s.target)) if (/\/notesSlide$/.test(r.type)) drop(r.target);
    drop(s.target);
  }

  // --- the speaker notes of the kept slides go too, when asked (the slide's relationships lose the link)
  if (opts.dropNotes) {
    for (const s of slides) {
      if (!usedOwn.has(s.target)) continue;
      const rels = await pkgRels(pkg, s.target);
      const notes = rels.filter((r) => /\/notesSlide$/.test(r.type));
      if (!notes.length) continue;
      for (const r of notes) { removed.add(r.target); removed.add(relsPathOf(r.target)); ct.overrides.delete(`/${r.target}`); }
      const rest = rels.filter((r) => !notes.includes(r));
      addText(relsPathOf(s.target), relsXml(rest.map((r) => ({ ...r, target: r.external ? r.target : relativePart(s.target, r.target) }))));
    }
  }

  // --- presentation.xml and its relationships
  const keptRels = presRels.filter((r) => !(/\/slide$/.test(r.type) && !usedOwn.has(r.target)));
  for (const s of list) if (s.added) keptRels.push({ id: s.rId, type: `${REL_TYPE}slide`, target: s.target, external: false });
  const masterIds = [];
  for (const m of newMasters) { const rId = newRel(); keptRels.push({ id: rId, type: `${REL_TYPE}slideMaster`, target: m, external: false }); masterIds.push(`<p:sldMasterId id="${nextBigId++}" r:id="${rId}"/>`); }
  const sldIdLst = `<p:sldIdLst>${list.map((s) => `<p:sldId id="${s.id}" r:id="${s.rId}"/>`).join("")}</p:sldIdLst>`;
  let out = /<p:sldIdLst\b/.test(pres) ? pres.replace(/<p:sldIdLst\b[^>]*\/>|<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>/, sldIdLst) : pres.replace(/(<\/p:sldMasterIdLst>)/, `$1${sldIdLst}`);
  if (masterIds.length) out = out.replace(/(<\/p:sldMasterIdLst>)/, `${masterIds.join("")}$1`);
  addText(presPath, out);
  addText(relsPathOf(presPath), relsXml(keptRels.map((r) => ({ ...r, target: r.external ? r.target : relativePart(presPath, r.target) }))));
  addText("[Content_Types].xml", contentTypesXml(ct));

  // --- the new package
  const entries = [];
  for (const e of pkg.entries) {
    if (removed.has(e.name) || added.has(e.name)) continue;
    entries.push(e);
  }
  for (const [name, a] of added) entries.push(a.entry ? { ...a.entry, name, nameBytes: null } : { name, data: a.data });
  entries.sort((a, b) => (b.name === "[Content_Types].xml") - (a.name === "[Content_Types].xml"));
  return zipWrite(entries);
}

/** Dispatch by kind: PDF or PPTX (a converted .ppt is a PPTX here). */
async function rearrangeDocument(kind, bytes, plan, extras, opts = {}) {
  if (kind === "pdf") return rearrangePdf(bytes, plan, extras);
  if (kind === "pptx") return rearrangePptx(bytes, plan, extras, opts);
  throw new Error("Pages of this file type cannot be rearranged.");
}
