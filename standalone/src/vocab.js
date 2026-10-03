/* ------------------------------------------------------------- the vocabulary */
// Terms build up across documents: every keyword list that arrives is added to the vocabulary of
// its language pair (source → target). The vocabulary is kept in the browser, can be browsed,
// searched, learnt as flashcards, exported as a PDF or as a text file Anki imports, and imported
// from such a file.

const LS_VOCAB = "pdftr:vocab";
const kwPairKey = (id) => `pdftr:kwpair:${id}`;

/** Common language names (German and English) to codes, for the AI dialog's target language. */
const LANG_CODES = {
  deutsch: "de", german: "de", englisch: "en", english: "en", französisch: "fr", french: "fr", spanisch: "es", spanish: "es", italienisch: "it", italian: "it",
  portugiesisch: "pt", portuguese: "pt", niederländisch: "nl", dutch: "nl", polnisch: "pl", polish: "pl", tschechisch: "cs", czech: "cs", slowakisch: "sk", slovak: "sk",
  ungarisch: "hu", hungarian: "hu", russisch: "ru", russian: "ru", ukrainisch: "uk", ukrainian: "uk", bulgarisch: "bg", bulgarian: "bg", griechisch: "el", greek: "el",
  türkisch: "tr", turkish: "tr", schwedisch: "sv", swedish: "sv", dänisch: "da", danish: "da", norwegisch: "no", norwegian: "no", finnisch: "fi", finnish: "fi",
  rumänisch: "ro", romanian: "ro", kroatisch: "hr", croatian: "hr", serbisch: "sr", serbian: "sr", arabisch: "ar", arabic: "ar", hebräisch: "he", hebrew: "he",
  chinesisch: "zh", chinese: "zh", japanisch: "ja", japanese: "ja", koreanisch: "ko", korean: "ko", hindi: "hi", vietnamesisch: "vi", vietnamese: "vi", thai: "th",
  indonesisch: "id", indonesian: "id", lateinisch: "la", latin: "la", esperanto: "eo",
};
const langCode = (name) => {
  const n = (name || "").trim().toLowerCase();
  if (!n) return "";
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(n)) return n.slice(0, 2);
  for (const [k, v] of Object.entries(LANG_CODES)) if (n === k || n.startsWith(k)) return v;
  return n.replace(/[^a-z]/g, "").slice(0, 8) || "";
};

/** The language of a text by its most frequent small words (and its script), or "" when unsure. */
const STOPWORDS = {
  de: "der die das und ist nicht ein eine mit von zu den dem für auf im sich auch wird werden bei oder als aus nach wie",
  en: "the and of to in is that for with as on are this be by from or at which it was an not have has",
  fr: "le la les et des de un une est pour dans que qui pas sur avec par au aux du ce cette sont il elle",
  es: "el la los las y de que en un una es por para con del se no su al como más pero sus",
  it: "il la di che e un una per con non sono del della nel alla gli le da si come anche più",
  pt: "o a os as de que e do da em um uma para com não por se na no mais como mas ao",
  nl: "de het een en van in is dat op te met voor zijn niet aan ook als er maar bij uit om door",
  pl: "i w z na do nie się jest to że od przez dla jak są po oraz lub tym",
  cs: "a v na se je to že s z do pro za od jako o jsou nebo při které",
  sv: "och att det i en som är av för med på till den har inte ett om kan",
  tr: "ve bir bu da de için ile olarak daha gibi en çok var olan ya",
  ru: "и в не на что с по как это от для за из или при его их то",
  uk: "і в не на що з до як це від для за із або при його їх та у",
};
const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(" "))]));
function detectLanguage(text) {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[֐-׿]/.test(text)) return "he";
  if (/[Ͱ-Ͽ]/.test(text)) return "el";
  const words = (text.toLowerCase().match(/\p{L}+/gu) || []);
  if (words.length < 3) return "";
  const score = {};
  for (const w of words) for (const [k, set] of Object.entries(STOP_SETS)) if (set.has(w)) score[k] = (score[k] || 0) + 1;
  // Letters only one language writes count like three small words: ě/ř/ů Czech, ą/ę/ł Polish, ß German, ñ Spanish, ã/õ Portuguese …
  const UNIQUE = { cs: /[ěřůň]/g, pl: /[ąęłńśźż]/g, tr: /[ğış]/g, sv: /[å]/g, de: /[ß]/g, fr: /[èêœ]/g, es: /[ñ¿¡]/g, pt: /[ãõ]/g, uk: /[іїє]/g, ru: /[ыэъ]/g };
  for (const [k, re] of Object.entries(UNIQUE)) { const hits = (text.match(re) || []).length; if (hits) score[k] = (score[k] || 0) + Math.min(9, 3 * hits); }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  // A language whose own letters never show up in a longer text is not it (Czech without ě/ř/ž, Swedish without å/ä/ö …).
  const MARKS = { cs: /[ěřůňžšč]/, pl: /[ąęłńśźż]/, tr: /[ğış]/, sv: /[åäö]/, de: /[äöüß]/, fr: /[éèêàçù]/, es: /[ñáéíóú¿¡]/, it: /[àèéìòù]/, pt: /[ãõçáéíóú]/, ru: /[а-я]/i, uk: /[а-я]/i }; // (é alone, as in "café", does not make a text Czech)
  const plausible = ranked.filter(([k]) => !(text.length > 200 && MARKS[k] && !MARKS[k].test(text)));
  const best = plausible[0];
  if (!best || best[1] < 2) return "";
  if (/[іїє]/.test(text) && best[0] === "ru") return "uk";
  return best[0];
}

function vocabLoad() {
  try { const v = JSON.parse(localStorage.getItem(LS_VOCAB) || "{}"); return v && typeof v === "object" ? v : {}; } catch (_) { return {}; }
}
function vocabSave(v) {
  try { localStorage.setItem(LS_VOCAB, JSON.stringify(v)); } catch (_) { toast(t("vocab.full"), "error"); }
}
const FAV_ALL = "*fav"; // the pseudo pair that shows the favourites of every pair
const pairLabel = (pair) => (pair === FAV_ALL ? t("vocab.favAll") : pair.replace("-", " → "));
const pairFile = (pair) => (pair === FAV_ALL ? "favourites" : pair);
/** The chameleon, small, in the current colour: the sign for a favourite. */
const KAM_ICON = '<svg class="kam-ic" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g transform="translate(2.5 1) scale(0.9)" fill="currentColor"><ellipse cx="21" cy="25" rx="7" ry="7.5"/><ellipse cx="33" cy="23.5" rx="7.5" ry="8"/><path d="M13 38c0-9 7-16 17-16h10c5.5 0 9.5 2.6 11 6l-1 6c-1.5 6-6 10-12 10H23c-6.5 0-10-1.5-10-5z"/><path d="M41 34.2L59 32.4c-.3 3.2-3.8 5.4-9.5 5.4-4 0-7.5-1.6-8.5-5.6z"/><path d="M38 24c6.5-3 15-1.5 20 5.5 1.2 1.7.6 3.2-1.5 3.3L41 34c-2 .2-3.2-1-3-3z"/><path d="M15 40c-5.5-.8-9 3.6-7.4 7.6 1.3 3 5 3.6 6.8 1.2 1.2-1.7.4-3.7-1.6-3.6" fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round"/><path d="M21 43l-1 10M30 44v9M38 43l1 10" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></g><circle cx="43.5" cy="24.9" r="2.4" fill="#fff"/></svg>';

/** Is this term a favourite of its pair? */
function isFav(pair, term) {
  const v = vocabLoad(), list = Array.isArray(v[pair]) ? v[pair] : [];
  const r = list.find((x) => x.term === term);
  return Boolean(r && r.fav);
}
/** Mark or unmark a favourite; a term not yet in the vocabulary is added first. Returns the new state. */
function toggleFav(pair, row) {
  if (!pair || pair === FAV_ALL) return false;
  const v = vocabLoad();
  let list = Array.isArray(v[pair]) ? v[pair] : [];
  let r = list.find((x) => x.term === row.term);
  if (!r) { vocabAdd(pair, [row], state.doc ? state.doc.name : ""); list = vocabLoad()[pair] || []; r = list.find((x) => x.term === row.term); if (!r) return false; }
  r.fav = !r.fav;
  if (!r.fav) delete r.fav;
  const v2 = vocabLoad(); v2[pair] = list; vocabSave(v2);
  return Boolean(r.fav);
}
/** The favourites of every pair, each row knowing its pair. */
function favRows() {
  const v = vocabLoad(), out = [];
  for (const pair of Object.keys(v).sort()) for (const r of v[pair] || []) if (r.fav) out.push({ ...r, _pair: pair });
  return out;
}
const vocabPairs = (v = vocabLoad()) => Object.keys(v).filter((k) => Array.isArray(v[k]) && v[k].length).sort();

/** Terms added to a pair's vocabulary: new ones are appended, known ones get the newer translation and examples. */
function vocabAdd(pair, rows, docName = "") {
  if (!pair || !/^[a-z]{2,8}-[a-z]{2,8}$/.test(pair)) return 0;
  const v = vocabLoad();
  const list = Array.isArray(v[pair]) ? v[pair] : [];
  const have = new Map(list.map((r) => [r.term.trim().toLowerCase(), r]));
  let added = 0;
  for (const r of rows) {
    const term = (r.term || "").trim(), translation = (r.translation || "").trim();
    if (!term || !translation) continue;
    const k = term.toLowerCase();
    if (have.has(k)) {
      const cur = have.get(k);
      cur.translation = translation;
      if (r.example) cur.example = r.example;
      if (r.exampleTr) cur.exampleTr = r.exampleTr;
      cur.seen = (cur.seen || 1) + 1;
    } else {
      const row = { term, translation, example: r.example || "", exampleTr: r.exampleTr || "", added: Date.now(), doc: docName, seen: 1 };
      list.push(row); have.set(k, row); added++;
    }
  }
  v[pair] = list;
  vocabSave(v);
  return added;
}

/** The pair of the open document's keywords: as the AI said, as the user set it, or as detected. */
function currentPair() {
  if (!state.doc) return "";
  let pair = "";
  try { pair = localStorage.getItem(kwPairKey(state.doc.id)) || ""; } catch (_) { /* fine */ }
  if (pair) return pair;
  const rows = (state.keywords || []).filter((r) => r.term && r.translation);
  const src = detectLanguage(rows.map((r) => `${r.term} ${r.example || ""}`).join(" ")) || detectLanguage((state.doc.segments || []).slice(0, 80).map((s) => s.text).join(" "));
  const tgt = detectLanguage(rows.map((r) => `${r.translation} ${r.exampleTr || ""}`).join(" ")) || langCode($("#aiTarget").value) || langCode($("#tgtLang").value);
  return src && tgt ? `${src}-${tgt}` : "";
}
function setCurrentPair(pair) {
  if (!state.doc) return;
  try { if (pair) localStorage.setItem(kwPairKey(state.doc.id), pair); else localStorage.removeItem(kwPairKey(state.doc.id)); } catch (_) { /* fine */ }
}

/* ---- export and import */
const ankiEsc = (s) => (s || "").replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
const ankiTag = (pair) => (pair === FAV_ALL ? "favourites" : pair);
/** A text file Anki imports: tab-separated, HTML on, with the deck and the note type named in its header. */
function ankiText(pair, rows) {
  const head = [`#separator:tab`, `#html:true`, `#notetype:Basic`, `#deck:Kameleon ${pairLabel(pair)}`, `#tags column:3`];
  const body = rows.map((r) => [
    ankiEsc(r.term) + (r.example ? `<br><i>${ankiEsc(r.example)}</i>` : ""),
    ankiEsc(r.translation) + (r.exampleTr ? `<br><i>${ankiEsc(r.exampleTr)}</i>` : ""),
    `kameleon ${ankiTag(pair)}`,
  ].join("\t"));
  return head.concat(body).join("\n") + "\n";
}
/** Rows from a text file: tab, semicolon or " = " separated; Anki header lines and HTML are stripped. */
function parseVocabText(text) {
  const rows = [];
  const clean = (s) => (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^#/.test(raw)) continue;
    let parts = raw.includes("\t") ? raw.split("\t") : raw.includes(";") ? raw.split(";") : raw.split(/\s(?:=|→|->)\s/);
    if (parts.length < 2) continue;
    parts = parts.map(clean);
    // "term\nexample" in one field (as the Anki export writes it) is taken apart again
    const [term, example = ""] = parts[0].split("\n"), [translation, exampleTr = ""] = parts[1].split("\n");
    if (!term || !translation) continue;
    rows.push({ term, translation, example: parts.length > 3 ? parts[2] : example, exampleTr: parts.length > 3 ? parts[3] : exampleTr });
  }
  return rows;
}

/* ---- asking for a language pair: on import, and to move terms */
let pairAsk = null;
function askPair({ src = "", tgt = "", text = "" } = {}) {
  const dlg = $("#pairDialog");
  $("#pairSrc").value = src; $("#pairTgt").value = tgt; $("#pairText").textContent = text;
  return new Promise((resolve) => {
    pairAsk = resolve;
    openModal(dlg);
    $("#pairSrc").focus();
  });
}
const codeOf = (s) => (s || "").trim().toLowerCase().replace(/[^a-z-]/g, "").slice(0, 8);
/** Terms (by their text) of one pair moved to another; returns how many moved. */
function vocabMove(fromPair, terms, toPair) {
  if (!toPair || fromPair === toPair) return 0;
  const v = vocabLoad();
  const list = Array.isArray(v[fromPair]) ? v[fromPair] : [];
  const set = new Set(terms);
  const moving = list.filter((r) => set.has(r.term));
  v[fromPair] = list.filter((r) => !set.has(r.term));
  if (!v[fromPair].length) delete v[fromPair];
  vocabSave(v);
  vocabAdd(toPair, moving, "");
  return moving.length;
}

/* ---- the vocabulary view in the keywords dialog */
const vb = { pair: "", query: "", favOnly: false, preview: false };
let vbPreviewTimer = null;
function vocabSchedulePreview(delay = 300) {
  clearTimeout(vbPreviewTimer);
  if (!vb.preview) return;
  vbPreviewTimer = setTimeout(async () => {
    try { await kwRenderPages($("#vocabPreviewWrap"), await vocabPdfBytes()); } catch (err) { console.warn("vocabulary preview failed", err); }
  }, delay);
}
function vocabRows(pair = vb.pair) { if (pair === FAV_ALL) return favRows(); const v = vocabLoad(); return Array.isArray(v[pair]) ? v[pair] : []; }
/** The rows as shown: the pair's (or all favourites'), narrowed by the favourites toggle and the search. */
/** The learning stage of a row: new, learning (steps 1-3) or mature (step 4 and up). */
const vocabStage = (r) => (!rowKnown(r) ? "new" : Number(r.known) < 4 ? "learning" : "mature");
const VOCAB_FILTERS = { all: () => true, due: (r) => fcDue(r), new: (r) => vocabStage(r) === "new", learning: (r) => vocabStage(r) === "learning", mature: (r) => vocabStage(r) === "mature" };
function vocabFiltered() {
  const q = vb.query.trim().toLowerCase();
  let rows = vocabRows();
  if (vb.favOnly && vb.pair !== FAV_ALL) rows = rows.filter((r) => r.fav);
  if (vb.filter && vb.filter !== "all") rows = rows.filter(VOCAB_FILTERS[vb.filter] || (() => true));
  return q ? rows.filter((r) => `${r.term} ${r.translation} ${r.example || ""} ${r.exampleTr || ""}`.toLowerCase().includes(q)) : rows;
}
/** The statistics bar: stages of the pair's words, what is due today, and the streak of study days. */
function vocabStatsHtml(all) {
  if (!all.length) return "";
  const n = { new: 0, learning: 0, mature: 0 };
  for (const r of all) n[vocabStage(r)]++;
  const due = all.filter((r) => rowKnown(r) && fcDue(r)).length, streak = fcStreak();
  const seg = (k) => (n[k] ? `<span class="vocab-stat-seg ${k}" style="flex:${n[k]}" title="${escapeHtml(t(`vocab.stage_${k}`))}: ${n[k]}"></span>` : "");
  return `<div class="vocab-stat-bar">${seg("new")}${seg("learning")}${seg("mature")}</div>
    <div class="vocab-stat-legend muted small">
      <span><i class="vocab-stat-dot new"></i>${escapeHtml(t("vocab.stage_new"))} ${n.new}</span>
      <span><i class="vocab-stat-dot learning"></i>${escapeHtml(t("vocab.stage_learning"))} ${n.learning}</span>
      <span><i class="vocab-stat-dot mature"></i>${escapeHtml(t("vocab.stage_mature"))} ${n.mature}</span>
      <span>· ${escapeHtml(t("vocab.dueToday", { n: due }))}</span>
      <span>· ${escapeHtml(t(streak === 1 ? "vocab.streak1" : "vocab.streak", { n: streak }))}</span>
    </div>`;
}
/** Rows of a pair that mean the same word: the same term apart from case, an article and punctuation. */
const vocabNormTerm = (term) => (term || "").toLowerCase().replace(/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|the|a|an|le|la|les|l'|un|une|des|el|los|las|un|una|unos|unas|il|lo|gli|i|le|o|os|as|um|uma|de|het|een)\s+/u, "").replace(/[\s.,;:!?"“”„'‘’()]+/gu, " ").trim();
function vocabDupeGroups(rows) {
  const groups = new Map();
  for (const r of rows) { const k = vocabNormTerm(r.term); if (!k) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.values()].filter((g) => g.length > 1);
}
/** Duplicates of the shown pair merged: the longer term stays, translations and examples are kept, the learning state too. */
function vocabMergeDupes() {
  if (!vb.pair || vb.pair === FAV_ALL) return;
  const v = vocabLoad(), list = v[vb.pair] || [];
  const groups = vocabDupeGroups(list);
  if (!groups.length) { toast(t("vocab.noDupes")); return; }
  if (!confirm(t("vocab.mergeConfirm", { n: groups.reduce((a, g) => a + g.length - 1, 0) }))) return;
  const drop = new Set();
  for (const g of groups) {
    g.sort((a, b) => b.term.length - a.term.length || (b.known || 0) - (a.known || 0));
    const keep = g[0];
    for (const r of g.slice(1)) {
      const trs = keep.translation.split(/\s*;\s*/);
      for (const tr of r.translation.split(/\s*;\s*/)) if (tr && !trs.some((x) => x.toLowerCase() === tr.toLowerCase())) trs.push(tr);
      keep.translation = trs.filter(Boolean).join("; ");
      if (!keep.example && r.example) { keep.example = r.example; keep.exampleTr = r.exampleTr || keep.exampleTr; }
      if (!keep.exampleTr && r.exampleTr) keep.exampleTr = r.exampleTr;
      keep.fav = keep.fav || r.fav || false;
      keep.known = Math.max(Number(keep.known) || 0, Number(r.known) || 0);
      keep.last = Math.max(Number(keep.last) || 0, Number(r.last) || 0) || undefined;
      keep.seen = (Number(keep.seen) || 1) + (Number(r.seen) || 1);
      keep.added = Math.min(keep.added || Date.now(), r.added || Date.now());
      drop.add(r);
    }
  }
  v[vb.pair] = list.filter((r) => !drop.has(r));
  vocabSave(v);
  toast(t("vocab.merged", { n: drop.size }), "ok");
  vocabRender();
}
/* ---- backup and restore: the whole vocabulary with its learning state, as one file */
function vocabBackup() {
  const data = { app: "Kameleon", kind: "vocabulary", version: 1, exported: new Date().toISOString(), vocab: vocabLoad() };
  try { data.days = JSON.parse(localStorage.getItem(LS_FC_DAYS) || "[]"); } catch (_) { data.days = []; }
  const pairs = vocabPairs(data.vocab).length, n = Object.values(data.vocab).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
  saveBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), `kameleon-vocabulary-${new Date().toISOString().slice(0, 10)}.json`);
  toast(t("vocab.backedUp", { n, pairs }), "ok");
}
/** A backup merged in: by pair and term; the higher learning step and the newer time win, favourites and examples are kept. */
function vocabRestore(data) {
  const v = vocabLoad();
  let added = 0, updated = 0, pairs = 0;
  for (const [pair, rows] of Object.entries(data.vocab || {})) {
    if (!Array.isArray(rows) || !/^[a-z]{2,3}-[a-z]{2,3}$/.test(pair)) continue;
    pairs++;
    const list = Array.isArray(v[pair]) ? v[pair] : (v[pair] = []);
    const byTerm = new Map(list.map((r) => [r.term, r]));
    for (const r of rows) {
      if (!r || !r.term) continue;
      const cur = byTerm.get(r.term);
      if (!cur) { list.push({ ...r }); byTerm.set(r.term, r); added++; continue; }
      let changed = false;
      if ((Number(r.known) || 0) > (Number(cur.known) || 0) || ((Number(r.known) || 0) === (Number(cur.known) || 0) && (Number(r.last) || 0) > (Number(cur.last) || 0))) { cur.known = r.known; cur.last = r.last; changed = true; }
      if (r.fav && !cur.fav) { cur.fav = true; changed = true; }
      for (const k of ["translation", "example", "exampleTr"]) if (!cur[k] && r[k]) { cur[k] = r[k]; changed = true; }
      if (changed) updated++;
    }
  }
  vocabSave(v);
  if (Array.isArray(data.days)) {
    let days = [];
    try { days = JSON.parse(localStorage.getItem(LS_FC_DAYS) || "[]"); } catch (_) { /* fine */ }
    const merged = [...new Set([...days, ...data.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))])].sort();
    try { localStorage.setItem(LS_FC_DAYS, JSON.stringify(merged.slice(-400))); } catch (_) { /* fine */ }
  }
  return { added, updated, pairs };
}
/** The shown rows as a printable two-sided card sheet. */
async function vocabCardsPdfBytes() {
  const rows = vocabFiltered().filter((r) => r.term && r.translation);
  const [src, tgt] = (vb.pair === FAV_ALL ? "" : vb.pair).split("-");
  return new Uint8Array(await pool.workers[0].call("cardsPdf", { rows, frontLabel: src ? src.toUpperCase() : "", backLabel: tgt ? tgt.toUpperCase() : "" }));
}
const rowPair = (r) => r._pair || vb.pair;
function vocabRender() {
  const pairs = vocabPairs();
  const cur = currentPair();
  if (cur && !pairs.includes(cur)) pairs.push(cur);
  const favs = favRows().length;
  if (vb.pair === FAV_ALL && !favs) vb.pair = "";
  if (!vb.pair || (vb.pair !== FAV_ALL && !pairs.includes(vb.pair))) vb.pair = pairs.includes(cur) && cur ? cur : pairs[0] || "";
  const sel = $("#vocabPair");
  sel.innerHTML = (pairs.map((p) => `<option value="${p}"${p === vb.pair ? " selected" : ""}>${escapeHtml(pairLabel(p))} (${vocabRows(p).length})</option>`).join("") || `<option value="">–</option>`)
    + (favs ? `<option value="${FAV_ALL}"${vb.pair === FAV_ALL ? " selected" : ""}>${escapeHtml(t("vocab.favAll"))} (${favs})</option>` : "");
  $("#vocabFavs").classList.toggle("on", vb.favOnly && vb.pair !== FAV_ALL);
  $("#vocabFavs").disabled = vb.pair === FAV_ALL;
  const rows = vocabFiltered(), all = vocabRows();
  $("#vocabCount").textContent = rows.length === all.length ? t("vocab.count", { n: all.length }) : t("vocab.countOf", { n: rows.length, total: all.length });
  $("#vocabStats").innerHTML = vocabStatsHtml(all);
  $("#vocabFilter").value = vb.filter || "all";
  const dupes = vb.pair && vb.pair !== FAV_ALL ? vocabDupeGroups(all).reduce((a, g) => a + g.length - 1, 0) : 0;
  $("#vocabMerge").textContent = t("vocab.merge", { n: dupes });
  $("#vocabMerge").disabled = !dupes;
  $("#vocabBackup").disabled = !vocabPairs().length;
  const list = $("#vocabList");
  list.innerHTML = rows.length ? rows.map((r) => `<div class="kw-row vocab-row${r.fav ? " fav" : ""}" data-term="${escapeHtml(r.term)}" data-pair="${escapeHtml(rowPair(r))}">
      <input data-k="term" value="${escapeHtml(r.term)}">
      <input data-k="translation" value="${escapeHtml(r.translation)}">
      <span class="vocab-row-btns">${r._pair ? `<span class="vocab-pair-badge">${escapeHtml(pairLabel(r._pair))}</span>` : ""}<button type="button" class="mini fav${r.fav ? " on" : ""}" data-act="fav" title="${escapeHtml(t("vocab.favTitle"))}" aria-label="${escapeHtml(t("vocab.fav"))}" aria-pressed="${r.fav ? "true" : "false"}">${KAM_ICON}</button><button type="button" class="mini" data-act="move" title="${escapeHtml(t("vocab.moveRow"))}" aria-label="${escapeHtml(t("vocab.moveRow"))}">⇄</button><button type="button" class="mini" data-act="del" title="${escapeHtml(t("kw.remove"))}" aria-label="${escapeHtml(t("kw.remove"))}">✕</button></span>
      <input class="kw-ex" data-k="example" value="${escapeHtml(r.example || "")}" placeholder="${escapeHtml(t("kw.example"))}">
      <input class="kw-ex" data-k="exampleTr" value="${escapeHtml(r.exampleTr || "")}" placeholder="${escapeHtml(t("kw.exampleTr"))}">
    </div>`).join("") : `<p class="muted small">${escapeHtml(all.length ? t("vocab.noMatch") : t("vocab.empty"))}</p>`;
  const some = rows.length > 0;
  for (const id of ["#vocabCards", "#vocabPdf", "#vocabApkg", "#vocabMove", "#vocabPreview", "#vocabCardsPdf"]) $(id).disabled = !some && !vb.preview;
  $("#vocabPreview").textContent = t(vb.preview ? "vocab.previewOff" : "vocab.preview");
  $("#vocabPreview").classList.toggle("on", vb.preview);
  $("#vocabList").parentElement.classList.toggle("preview", vb.preview);
  vocabSchedulePreview();
  $("#vocabClear").disabled = !all.length || vb.pair === FAV_ALL;
  $("#vocabMove").textContent = rows.length === all.length ? t("vocab.moveAll") : t("vocab.moveShown", { n: rows.length });
  $("#vocabToHere").hidden = !(state.doc && (state.keywords || []).some((r) => r.term && r.translation));
}
function vocabUpdateRow(pair, termKey, k, value) {
  const v = vocabLoad(), list = v[pair] || [];
  const row = list.find((r) => r.term === termKey);
  if (!row) return;
  row[k] = value;
  v[pair] = list;
  vocabSave(v);
}
/**
 * A word marked "known" on a flashcard: the count goes up and the time is noted (count 0 resets
 * it). Returns the new count; a word that is not in the pair's vocabulary stays unrecorded (0).
 */
function vocabMarkKnown(pair, term, count = null) {
  const v = vocabLoad(), list = v[pair] || [];
  const row = list.find((r) => r.term === term);
  if (!row) return 0;
  row.known = count === null ? (Number(row.known) || 0) + 1 : count;
  row.last = Date.now();
  v[pair] = list;
  vocabSave(v);
  return row.known;
}
/** The exports take the rows as shown: the whole pair, the favourites, or a search's hits. */
async function vocabPdfBytes() {
  const rows = vocabFiltered();
  const args = {
    title: `${t("vocab.title")} ${pairLabel(vb.pair)}${vb.favOnly && vb.pair !== FAV_ALL ? ` – ${t("vocab.favFilter")}` : ""}`, headers: [t("kw.term"), t("kw.translation")], rows,
    subtitle: t("vocab.subtitle", { n: rows.length, date: new Date().toLocaleDateString(LANG === "de" ? "de-DE" : "en-GB") }),
  };
  return new Uint8Array(await pool.workers[0].call("keywordsPdf", args));
}
window.Kameleon = Object.assign(window.Kameleon || {}, { detectLanguage, langCode });

function initVocab() {
  $("#kwModeVocab").addEventListener("click", () => kwSetMode("vocab"));
  $("#vocabPair").addEventListener("change", (e) => { vb.pair = e.target.value; vb.query = ""; $("#vocabSearch").value = ""; vocabRender(); });
  $("#vocabSearch").addEventListener("input", (e) => { vb.query = e.target.value; vocabRender(); });
  $("#vocabFilter").addEventListener("change", (e) => { vb.filter = e.target.value; vocabRender(); });
  $("#vocabMerge").addEventListener("click", vocabMergeDupes);
  $("#vocabBackup").addEventListener("click", vocabBackup);
  $("#vocabCardsPdf").addEventListener("click", async () => {
    try { saveBlob(new Blob([await vocabCardsPdfBytes()], { type: "application/pdf" }), `flashcards-${pairFile(vb.pair)}.pdf`); } catch (err) { toast(userError(err), "error"); }
  });
  const list = $("#vocabList");
  list.addEventListener("input", (e) => {
    const row = e.target.closest(".vocab-row"), k = e.target.dataset.k;
    if (!row || !k) return;
    vocabUpdateRow(row.dataset.pair, row.dataset.term, k, e.target.value);
    if (k === "term") row.dataset.term = e.target.value;
  });
  $("#vocabFavs").addEventListener("click", () => { vb.favOnly = !vb.favOnly; vocabRender(); });
  $("#vocabFavs .kam-slot").innerHTML = KAM_ICON;
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"), row = e.target.closest(".vocab-row");
    if (!b || !row) return;
    const pair = row.dataset.pair;
    if (b.dataset.act === "del") {
      const v = vocabLoad();
      v[pair] = (v[pair] || []).filter((r) => r.term !== row.dataset.term);
      vocabSave(v); vocabRender();
    } else if (b.dataset.act === "fav") {
      const on = toggleFav(pair, { term: row.dataset.term, translation: row.querySelector('[data-k="translation"]').value });
      vocabRender(); // (the pair list's favourites entry and counts follow)
    } else if (b.dataset.act === "move") { // this one term to another pair
      const [src, tgt] = pair.split("-");
      const ans = await askPair({ src, tgt, text: t("pair.textMove", { n: 1 }) });
      if (!ans) return;
      const n = vocabMove(pair, [row.dataset.term], ans.pair);
      toast(t("vocab.moved", { n, pair: pairLabel(ans.pair) }), "ok"); vocabRender();
    }
  });
  $("#vocabMove").addEventListener("click", async () => { // the shown terms (all, the favourites, or the search's hits) to another pair
    const rows = vocabFiltered();
    if (!rows.length) return;
    const [src, tgt] = (vb.pair === FAV_ALL ? rowPair(rows[0]) : vb.pair).split("-");
    const ans = await askPair({ src, tgt, text: t("pair.textMove", { n: rows.length }) });
    if (!ans) return;
    let n = 0;
    const byPair = new Map();
    for (const r of rows) { const p = rowPair(r); if (!byPair.has(p)) byPair.set(p, []); byPair.get(p).push(r.term); }
    for (const [p, terms] of byPair) n += vocabMove(p, terms, ans.pair);
    vb.pair = ans.pair; vb.query = ""; $("#vocabSearch").value = "";
    toast(t("vocab.moved", { n, pair: pairLabel(ans.pair) }), "ok"); vocabRender();
  });
  $("#pairDialog").addEventListener("close", () => {
    const ok = $("#pairDialog").returnValue === "ok", src = codeOf($("#pairSrc").value), tgt = codeOf($("#pairTgt").value);
    const resolve = pairAsk; pairAsk = null;
    if (resolve) resolve(ok && src && tgt ? { src, tgt, pair: `${src}-${tgt}` } : null);
  });
  $("#langCodes").innerHTML = [...new Set(Object.values(LANG_CODES))].sort().map((c) => `<option value="${c}">${escapeHtml(Object.keys(LANG_CODES).find((k) => LANG_CODES[k] === c) || c)}</option>`).join("");
  $("#vocabToHere").addEventListener("click", () => { // the open document's terms into the vocabulary (the pair as shown)
    const pair = vb.pair || currentPair();
    if (!pair) { toast(t("vocab.noPair"), "error"); return; }
    const n = vocabAdd(pair, kwRows(), state.doc.name);
    setCurrentPair(pair);
    toast(t("vocab.added", { n, pair: pairLabel(pair) }), "ok"); vocabRender();
  });
  $("#vocabCards").addEventListener("click", () => { fcSource = vocabFiltered().filter((r) => r.term && r.translation); fcPair = vb.pair; kwSetMode("cards"); });
  $("#vocabPdf").addEventListener("click", async () => {
    try { saveBlob(new Blob([await vocabPdfBytes()], { type: "application/pdf" }), `vocabulary-${pairFile(vb.pair)}.pdf`); } catch (err) { toast(userError(err), "error"); }
  });
  $("#vocabPreview").addEventListener("click", () => { vb.preview = !vb.preview; if (!vb.preview) $("#vocabPreviewWrap").innerHTML = ""; vocabRender(); });
  $("#kwDialog").addEventListener("close", () => { vb.preview = false; $("#vocabPreviewWrap").innerHTML = ""; });
  $("#vocabApkg").addEventListener("click", async () => {
    try { saveBlob(new Blob([await buildApkg(vb.pair, vocabFiltered())], { type: "application/octet-stream" }), `kameleon-${pairFile(vb.pair)}.apkg`); } catch (err) { toast(userError(err), "error"); }
  });
  $("#vocabImport").addEventListener("click", () => $("#vocabFile").click());
  $("#vocabFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let rows, deckName = file.name, hint = { src: "", tgt: "" };
    if (/\.json$/i.test(file.name) || bytes[0] === 0x7b) { // a backup of the whole vocabulary
      let data = null;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { /* not JSON */ }
      if (!data || data.app !== "Kameleon" || !data.vocab) { toast(t("vocab.badBackup"), "error"); return; }
      const r = vocabRestore(data);
      toast(t("vocab.restored", r), "ok"); vocabRender();
      return;
    }
    if (/\.apkg$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      try { const r = await readApkg(bytes); rows = r.rows; deckName = r.deck || file.name; hint = r.langs || hint; } catch (err) { toast(userError(err), "error"); return; }
    } else rows = parseVocabText(new TextDecoder().decode(bytes));
    if (!rows.length) { toast(t("vocab.badFile"), "error"); return; }
    // The pair: what the deck's field names say, else what the texts look like; the user confirms or corrects it.
    const [curSrc, curTgt] = (vb.pair || "-").split("-");
    const src = hint.src || detectLanguage(rows.map((r) => r.term).join(" ")) || curSrc || "";
    const tgt = hint.tgt || detectLanguage(rows.map((r) => r.translation).join(" ")) || curTgt || "";
    const ans = await askPair({ src, tgt, text: t("pair.textImport", { n: rows.length, name: deckName }) });
    if (!ans) return;
    const pair = ans.pair;
    const n = vocabAdd(pair, rows, deckName);
    vb.pair = pair;
    toast(t("vocab.imported", { n, total: rows.length, pair: pairLabel(pair) }), "ok"); vocabRender();
  });
  $("#vocabClear").addEventListener("click", () => {
    if (!confirm(t("vocab.clearConfirm", { pair: pairLabel(vb.pair) }))) return;
    const v = vocabLoad(); delete v[vb.pair]; vocabSave(v); vb.pair = ""; vocabRender();
  });
}
