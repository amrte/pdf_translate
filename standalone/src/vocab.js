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
const pairLabel = (pair) => pair.replace("-", " → ");
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
/** A text file Anki imports: tab-separated, HTML on, with the deck and the note type named in its header. */
function ankiText(pair, rows) {
  const head = [`#separator:tab`, `#html:true`, `#notetype:Basic`, `#deck:Kameleon ${pairLabel(pair)}`, `#tags column:3`];
  const body = rows.map((r) => [
    ankiEsc(r.term) + (r.example ? `<br><i>${ankiEsc(r.example)}</i>` : ""),
    ankiEsc(r.translation) + (r.exampleTr ? `<br><i>${ankiEsc(r.exampleTr)}</i>` : ""),
    `kameleon ${pair}`,
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
const vb = { pair: "", query: "" };
function vocabRows(pair = vb.pair) { const v = vocabLoad(); return Array.isArray(v[pair]) ? v[pair] : []; }
function vocabFiltered() {
  const q = vb.query.trim().toLowerCase();
  const rows = vocabRows();
  return q ? rows.filter((r) => `${r.term} ${r.translation} ${r.example || ""} ${r.exampleTr || ""}`.toLowerCase().includes(q)) : rows;
}
function vocabRender() {
  const pairs = vocabPairs();
  const cur = currentPair();
  if (cur && !pairs.includes(cur)) pairs.push(cur);
  if (!vb.pair || !pairs.includes(vb.pair)) vb.pair = pairs.includes(cur) && cur ? cur : pairs[0] || "";
  const sel = $("#vocabPair");
  sel.innerHTML = pairs.map((p) => `<option value="${p}"${p === vb.pair ? " selected" : ""}>${escapeHtml(pairLabel(p))} (${vocabRows(p).length})</option>`).join("") || `<option value="">–</option>`;
  const rows = vocabFiltered(), all = vocabRows();
  $("#vocabCount").textContent = rows.length === all.length ? t("vocab.count", { n: all.length }) : t("vocab.countOf", { n: rows.length, total: all.length });
  const list = $("#vocabList");
  list.innerHTML = rows.length ? rows.map((r) => `<div class="kw-row vocab-row" data-term="${escapeHtml(r.term)}">
      <input data-k="term" value="${escapeHtml(r.term)}">
      <input data-k="translation" value="${escapeHtml(r.translation)}">
      <span class="vocab-row-btns"><button type="button" class="mini" data-act="move" title="${escapeHtml(t("vocab.moveRow"))}" aria-label="${escapeHtml(t("vocab.moveRow"))}">⇄</button><button type="button" class="mini" data-act="del" title="${escapeHtml(t("kw.remove"))}" aria-label="${escapeHtml(t("kw.remove"))}">✕</button></span>
      <input class="kw-ex" data-k="example" value="${escapeHtml(r.example || "")}" placeholder="${escapeHtml(t("kw.example"))}">
      <input class="kw-ex" data-k="exampleTr" value="${escapeHtml(r.exampleTr || "")}" placeholder="${escapeHtml(t("kw.exampleTr"))}">
    </div>`).join("") : `<p class="muted small">${escapeHtml(all.length ? t("vocab.noMatch") : t("vocab.empty"))}</p>`;
  const some = all.length > 0;
  for (const id of ["#vocabCards", "#vocabPdf", "#vocabAnki", "#vocabApkg", "#vocabClear", "#vocabMove"]) $(id).disabled = !some;
  $("#vocabMove").textContent = rows.length === all.length ? t("vocab.moveAll") : t("vocab.moveShown", { n: rows.length });
  $("#vocabToHere").hidden = !(state.doc && (state.keywords || []).some((r) => r.term && r.translation));
}
function vocabUpdateRow(termKey, k, value) {
  const v = vocabLoad(), list = v[vb.pair] || [];
  const row = list.find((r) => r.term === termKey);
  if (!row) return;
  row[k] = value;
  v[vb.pair] = list;
  vocabSave(v);
}
async function vocabPdfBytes() {
  const rows = vocabRows();
  const args = {
    title: `${t("vocab.title")} ${pairLabel(vb.pair)}`, headers: [t("kw.term"), t("kw.translation")], rows,
    subtitle: t("vocab.subtitle", { n: rows.length, date: new Date().toLocaleDateString(LANG === "de" ? "de-DE" : "en-GB") }),
  };
  return new Uint8Array(await pool.workers[0].call("keywordsPdf", args));
}
window.Kameleon = Object.assign(window.Kameleon || {}, { detectLanguage, langCode });

function initVocab() {
  $("#kwModeVocab").addEventListener("click", () => kwSetMode("vocab"));
  $("#vocabPair").addEventListener("change", (e) => { vb.pair = e.target.value; vb.query = ""; $("#vocabSearch").value = ""; vocabRender(); });
  $("#vocabSearch").addEventListener("input", (e) => { vb.query = e.target.value; vocabRender(); });
  const list = $("#vocabList");
  list.addEventListener("input", (e) => {
    const row = e.target.closest(".vocab-row"), k = e.target.dataset.k;
    if (!row || !k) return;
    vocabUpdateRow(row.dataset.term, k, e.target.value);
    if (k === "term") row.dataset.term = e.target.value;
  });
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"), row = e.target.closest(".vocab-row");
    if (!b || !row) return;
    if (b.dataset.act === "del") {
      const v = vocabLoad();
      v[vb.pair] = (v[vb.pair] || []).filter((r) => r.term !== row.dataset.term);
      vocabSave(v); vocabRender();
    } else if (b.dataset.act === "move") { // this one term to another pair
      const [src, tgt] = vb.pair.split("-");
      const ans = await askPair({ src, tgt, text: t("pair.textMove", { n: 1 }) });
      if (!ans) return;
      const n = vocabMove(vb.pair, [row.dataset.term], ans.pair);
      toast(t("vocab.moved", { n, pair: pairLabel(ans.pair) }), "ok"); vocabRender();
    }
  });
  $("#vocabMove").addEventListener("click", async () => { // the shown terms (all, or the search's hits) to another pair
    const rows = vocabFiltered();
    if (!rows.length) return;
    const [src, tgt] = vb.pair.split("-");
    const ans = await askPair({ src, tgt, text: t("pair.textMove", { n: rows.length }) });
    if (!ans) return;
    const n = vocabMove(vb.pair, rows.map((r) => r.term), ans.pair);
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
  $("#vocabCards").addEventListener("click", () => { fcSource = vocabRows().filter((r) => r.term && r.translation); kwSetMode("cards"); });
  $("#vocabPdf").addEventListener("click", async () => {
    try { saveBlob(new Blob([await vocabPdfBytes()], { type: "application/pdf" }), `vocabulary-${vb.pair}.pdf`); } catch (err) { toast(userError(err), "error"); }
  });
  $("#vocabAnki").addEventListener("click", () => saveBlob(new Blob([ankiText(vb.pair, vocabRows())], { type: "text/plain;charset=utf-8" }), `kameleon-${vb.pair}-anki.txt`));
  $("#vocabApkg").addEventListener("click", async () => {
    try { saveBlob(new Blob([await buildApkg(vb.pair, vocabRows())], { type: "application/octet-stream" }), `kameleon-${vb.pair}.apkg`); } catch (err) { toast(userError(err), "error"); }
  });
  $("#vocabImport").addEventListener("click", () => $("#vocabFile").click());
  $("#vocabFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let rows, deckName = file.name, hint = { src: "", tgt: "" };
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
  $("#btnVocabStart").addEventListener("click", () => { kwRenderList(); openModal($("#kwDialog")); kwSetMode("vocab"); });
  const refreshStart = () => { $("#btnVocabStart").hidden = !vocabPairs().length; };
  refreshStart();
  window.addEventListener("storage", refreshStart);
  $("#kwDialog").addEventListener("close", refreshStart);
}
