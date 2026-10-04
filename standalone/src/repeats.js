/* ------------------------------------------------------------- headers and footers (PDF)
 * Text that repeats in the top or bottom band of the pages ("Systembeskrivning", "Page 5 of 26",
 * a classification note) forms a group: the same text on at least 30 % of the pages (numbers
 * aside). A group is translated once – its first segment stands for all, the others follow with
 * their own numbers –, kept in the original, or left as single segments ("each"). Any other
 * repeated text can be made a group by hand; single pages can be taken out of a group. The
 * choices are kept per document; the mode chosen "for all" is the default for new documents.
 */
const REP_BAND = 0.12;         // top/bottom share of the page height
const REP_SHARE = 0.3;         // on at least this share of the pages (and on two)
const LS_REP_MODE = "pdftr:repmode";
const repCfgKey = (docId) => `pdftr:rep:${docId}`;
const repNorm = (text) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const repPlace = (s) => `${s.page}|${s.text}`; // (survives renumbering after a split, join or OCR)

/** Header/footer groups of a PDF's segments: Map key → [segments] (in document order). */
function repDetect(segments, pages) {
  const n = pages ? (Array.isArray(pages) ? pages.length : Object.keys(pages).length) : 0;
  const out = new Map();
  if (n < 2) return out;
  const by = new Map();
  for (const s of segments) {
    if (s.skip || s.formula || !s.bbox) continue;
    const p = pages[s.page];
    if (!p || !p.height) continue;
    const y0 = p.y0 || 0, h = p.height;
    const band = s.bbox[3] - y0 <= REP_BAND * h ? "top" : s.bbox[1] - y0 >= (1 - REP_BAND) * h ? "bottom" : null;
    if (!band) continue;
    const norm = repNorm(s.text);
    if (!/\p{L}/u.test(norm)) continue;
    const key = `${band}|${norm}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(s);
  }
  const min = Math.max(2, Math.ceil(REP_SHARE * n));
  for (const [key, list] of by) if (new Set(list.map((s) => s.page)).size >= min) out.set(key, list);
  return out;
}

function repDefaultMode() {
  try { const m = localStorage.getItem(LS_REP_MODE); return ["once", "keep", "each"].includes(m) ? m : "once"; } catch (_) { return "once"; }
}
function repLoadCfg(docId) {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(repCfgKey(docId)) || "null"); } catch (_) { c = null; }
  c = c && typeof c === "object" ? c : {};
  return { modes: c.modes || {}, drop: c.drop || [], man: c.man || [], def: c.def || null };
}

/**
 * The groups of a document with the user's choices: [{key, kind: top|bottom|man, segs, lead,
 * mode}]. `segs` excludes pages taken out of the group; `lead` is the first remaining segment.
 */
function repGroupsOf(segments, pages, cfg) {
  const groups = new Map(repDetect(segments, pages));
  for (const norm of cfg.man) {
    const key = `man|${norm}`;
    if (groups.has(`top|${norm}`) || groups.has(`bottom|${norm}`)) continue;
    const list = segments.filter((s) => !s.skip && repNorm(s.text) === norm);
    if (list.length > 1) groups.set(key, list);
  }
  const drop = new Set(cfg.drop);
  const def = cfg.def || repDefaultMode();
  const out = [];
  for (const [key, list] of groups) {
    const segs = list.filter((s) => !drop.has(repPlace(s)));
    if (segs.length < 2) continue;
    out.push({ key, kind: key.slice(0, key.indexOf("|")), segs, lead: segs[0].id, mode: cfg.modes[key] || def });
  }
  return out;
}

/** `tr` (the lead's translation) with the lead's numbers replaced by those of `text`. */
function repNumbers(tr, leadText, text) {
  const a = leadText.match(/\d+/g) || [], b = text.match(/\d+/g) || [];
  if (a.length !== b.length || a.join() === b.join()) return tr;
  const used = new Array(a.length).fill(false);
  return tr.replace(/\d+/g, (d) => {
    const k = a.findIndex((v, i) => !used[i] && v === d);
    if (k < 0) return d;
    used[k] = true;
    return b[k];
  });
}

/** Brings the group members of a plain {id: text} map in line with their lead; changed ids. */
function repSyncMap(groups, tr) {
  const changed = [];
  const set = (id, v) => {
    const cur = tr[id] || "";
    if (cur === v) return;
    if (v) tr[id] = v; else delete tr[id];
    changed.push(id);
  };
  for (const g of groups) {
    if (g.mode === "each") continue;
    if (g.mode === "keep") { for (const s of g.segs) set(s.id, ""); continue; }
    const lead = g.segs[0], lt = (tr[lead.id] || "").trim() ? tr[lead.id] : "";
    for (const s of g.segs.slice(1)) set(s.id, lt ? repNumbers(lt, lead.text, s.text) : "");
  }
  return changed;
}

/** Ids a prompt or the progress leaves out: members after the lead, and every kept member. */
function repHiddenIds(groups) {
  const out = new Set();
  for (const g of groups) {
    if (g.mode === "keep") g.segs.forEach((s) => out.add(s.id));
    else if (g.mode === "once") g.segs.slice(1).forEach((s) => out.add(s.id));
  }
  return out;
}

/* ---- the open document */

const rep = { groups: [], byId: new Map(), hidden: new Set(), open: new Set(), cfg: null };

const repSupported = () => Boolean(state.doc && (state.doc.kind || "pdf") === "pdf" && !isBook() && !isOffice());

/** Groups found again for the open document (after opening, OCR, a split or a join). */
function repSetup() {
  rep.groups = []; rep.byId.clear(); rep.hidden.clear();
  if (!repSupported()) return;
  rep.cfg = repLoadCfg(state.doc.id);
  rep.groups = repGroupsOf(state.doc.segments, state.doc.pages, rep.cfg);
  for (const g of rep.groups) for (const s of g.segs) rep.byId.set(s.id, g);
  rep.hidden = repHiddenIds(rep.groups);
  for (const k of [...rep.open]) if (!rep.groups.some((g) => g.key === k)) rep.open.delete(k);
}

function repSaveCfg() {
  if (!state.doc || !rep.cfg) return;
  try { localStorage.setItem(repCfgKey(state.doc.id), JSON.stringify(rep.cfg)); } catch (_) { /* storage blocked */ }
}

/** After translations changed: members follow their lead (called by persist). */
function repSync() {
  if (!rep.groups.length) return;
  const changed = repSyncMap(rep.groups, state.translations);
  for (const id of changed) {
    vl.heights.delete(id);
    const ta = vl.rendered.get(id)?.querySelector("textarea");
    if (ta && document.activeElement !== ta) ta.value = state.translations[id] || "";
    markDone(id);
  }
}

const repHidden = (id) => rep.hidden.has(Number(id));
const repGroup = (id) => rep.byId.get(Number(id)) || null;

function repLabel(g) {
  const pages = new Set(g.segs.map((s) => s.page)).size;
  return t(g.kind === "top" ? "rep.header" : g.kind === "bottom" ? "rep.footer" : "rep.repeated", { n: pages, k: g.segs.length });
}

/** The group line of a card: what the group is, its mode, and the pages it stands for. */
function repCardHtml(id) {
  const g = repGroup(id);
  if (!g) return "";
  const lead = g.lead === Number(id);
  const opt = (v) => `<option value="${v}"${g.mode === v ? " selected" : ""}>${escapeHtml(t(`rep.mode_${v}`))}</option>`;
  const modeSel = `<select class="rep-mode" data-rep-mode title="${escapeHtml(t("rep.modeTitle"))}" aria-label="${escapeHtml(t("rep.modeTitle"))}">${opt("once")}${opt("keep")}${opt("each")}</select>`;
  if (g.mode === "each" || lead) {
    const open = g.mode !== "each" ? `<button type="button" class="mini" data-act="repOpen">${escapeHtml(t(rep.open.has(g.key) ? "rep.hidePages" : "rep.showPages", { n: g.segs.length - 1 }))}</button>` : "";
    return `<div class="seg-rep"><span class="rep-tag">${escapeHtml(repLabel(g))}</span>${modeSel}${open}<button type="button" class="mini" data-act="repAll" title="${escapeHtml(t("rep.allTitle"))}">${escapeHtml(t("rep.all"))}</button><button type="button" class="mini" data-act="repDrop" title="${escapeHtml(t("rep.dropTitle"))}">${escapeHtml(t("rep.drop"))}</button></div>`;
  }
  return `<div class="seg-rep member"><span class="rep-tag">↳ ${escapeHtml(t(g.mode === "keep" ? "rep.memberKeep" : "rep.memberOnce", { n: g.lead }))}</span><button type="button" class="mini" data-act="repDrop" title="${escapeHtml(t("rep.dropTitle"))}">${escapeHtml(t("rep.drop"))}</button></div>`;
}

/** Whether a card's translation box is read-only (it follows its lead, or the original stays). */
function repLocked(id) {
  const g = repGroup(id);
  return Boolean(g && (g.mode === "keep" || (g.mode === "once" && g.lead !== Number(id))));
}

/** The list order: an open group's members right after its lead. */
function repListIds(ids) {
  if (!rep.groups.length) return ids;
  const out = [];
  for (const id of ids) {
    out.push(id);
    const g = repGroup(id);
    if (g && g.lead === id && rep.open.has(g.key) && g.mode !== "each") for (const s of g.segs.slice(1)) out.push(s.id);
  }
  return out;
}

/** Applies a changed group set-up: groups, translations, list, progress. */
function repChanged(before) {
  repSetup();
  repSync();
  const after = { ...state.translations };
  const diff = {}, back = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[id] || "") !== (after[id] || "")) { diff[id] = after[id] || ""; back[id] = before[id] || ""; }
  }
  persist();
  if (Object.keys(diff).length) recordTranslations(back, diff, t("hist.repeats"));
  refreshCards();
}

function repSetMode(id, mode) {
  const g = repGroup(id);
  if (!g || !["once", "keep", "each"].includes(mode)) return;
  const before = { ...state.translations };
  // Going to "once" with the lead still empty: a member's translation is taken over.
  if (mode === "once" && !hasTr(g.lead)) {
    const done = g.segs.find((s) => hasTr(s.id));
    if (done) state.translations[g.lead] = done.text === segById(g.lead).text ? state.translations[done.id] : repNumbers(state.translations[done.id], done.text, segById(g.lead).text);
  }
  rep.cfg.modes[g.key] = mode;
  repSaveCfg();
  repChanged(before);
}

/** The mode of this group for all groups of the document, and as the default for new ones. */
function repSetAll(id) {
  const g = repGroup(id);
  if (!g) return;
  const before = { ...state.translations };
  for (const x of rep.groups) {
    if (x.mode === "once" || g.mode !== "once" || hasTr(x.lead)) continue;
    const done = x.segs.find((s) => hasTr(s.id));
    if (done) state.translations[x.lead] = repNumbers(state.translations[done.id], done.text, segById(x.lead).text);
  }
  rep.cfg.modes = {};
  rep.cfg.def = g.mode;
  try { localStorage.setItem(LS_REP_MODE, g.mode); } catch (_) { /* storage blocked */ }
  repSaveCfg();
  repChanged(before);
  toast(t("rep.allDone", { mode: t(`rep.mode_${g.mode}`), n: rep.groups.length }), "ok");
}

/** Takes one segment out of its group; it becomes a normal segment again. */
function repDrop(id) {
  const s = segById(id), g = repGroup(id);
  if (!s || !g) return;
  const before = { ...state.translations };
  // (a member that followed its lead keeps the translation it had)
  rep.cfg.drop = [...new Set([...rep.cfg.drop, repPlace(s)])];
  repSaveCfg();
  repChanged(before);
  toast(t("rep.dropped", { n: id }), "ok");
}

/** Makes all segments with this text (numbers aside) one group. */
function repMakeGroup(id) {
  const s = segById(id);
  if (!s) return;
  const norm = repNorm(s.text);
  const same = state.doc.segments.filter((x) => !x.skip && repNorm(x.text) === norm);
  if (same.length < 2) { toast(t("rep.single"), "error"); return; }
  const before = { ...state.translations };
  rep.cfg.man = [...new Set([...rep.cfg.man, norm])];
  rep.cfg.drop = rep.cfg.drop.filter((p) => !same.some((x) => repPlace(x) === p));
  // The segment clicked leads when it has a translation and the first one has none.
  if (hasTr(id) && !hasTr(same[0].id)) state.translations[same[0].id] = repNumbers(state.translations[id], s.text, same[0].text);
  repSaveCfg();
  repChanged(before);
  toast(t("rep.made", { n: same.length }), "ok");
}

function repToggleOpen(id) {
  const g = repGroup(id);
  if (!g) return;
  if (rep.open.has(g.key)) rep.open.delete(g.key); else rep.open.add(g.key);
  refreshCards();
}

/** A hidden member asked for in the list (a click on its box): its group opens. */
function repReveal(id) {
  const g = repGroup(id);
  if (!g || !repHidden(id) || g.mode !== "once") return false;
  rep.open.add(g.key);
  return true;
}

/** Updating a lead's field in the PDF updates its members' fields too. */
function repApplyMembers(id) {
  const g = repGroup(id);
  if (!g || g.mode !== "once" || g.lead !== Number(id)) return;
  for (const s of g.segs.slice(1)) applyField(s.id);
}

/* ---- batch files (not open): their stored segments carry the group key from reading */

/** The groups of a batch file's stored segments with that document's choices. */
function repBatchGroups(fileId, segs) {
  if (!segs.some((s) => s.rep)) return [];
  const cfg = repLoadCfg(fileId), drop = new Set(cfg.drop), def = cfg.def || repDefaultMode();
  const by = new Map();
  for (const s of segs) {
    if (!s.rep || drop.has(repPlace(s))) continue;
    if (!by.has(s.rep)) by.set(s.rep, []);
    by.get(s.rep).push(s);
  }
  const out = [];
  for (const [key, list] of by) if (list.length > 1) out.push({ key, kind: key.slice(0, key.indexOf("|")), segs: list, lead: list[0].id, mode: cfg.modes[key] || def });
  return out;
}

/** Marks the header/footer group of each segment of a freshly read batch file. */
function repMarkBatch(segs, pages) {
  for (const [key, list] of repDetect(segs, pages)) for (const s of list) s.rep = key;
}
