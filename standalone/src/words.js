/* ---------------------------------------------------------------- Learn: the document's words by frequency
 * Every word of the open document, counted, without the stop words of its language. The user picks
 * words (singly or the most frequent ones), copies a prompt that asks the AI for translations and
 * example sentences, and pastes the answer back: the words become keywords and vocabulary, and
 * flashcards. The list is computed once per document and kept while it is open.
 */
const wd = { docId: null, rows: [], phrases: [], lang: "", sel: new Set(), query: "", hideKnown: true, view: "words", sort: "count", selOnly: false };
const PHRASE_MIN = 2; // a word group counts from this many occurrences
const WORD_RE = /\p{L}[\p{L}\p{M}'’­-]*/gu;
const CJK_RE = /[぀-ヿ一-鿿가-힯]/;
const WORDS_SHOWN = 400; // (rows beyond that are reachable through the search)

const wordsText = (seg) => seg.text.replace(/<\d+\/>/g, " ").replace(/<\/?\d+>/g, "").replace(/\s+/g, " "); // (a formatting tag may sit inside a word)

/**
 * Function words left out of the list, on top of the short sets used for language detection:
 * pronouns, articles, prepositions, conjunctions, auxiliaries, common adverbs and numerals.
 */
const WORD_STOP = {
  de: "ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihn ihnen mein meine meinen meinem meiner dein deine sein seine seinen seinem seiner ihre ihren ihrem ihrer unser unsere euer eure des dies diese dieser dieses diesem diesen jene jener welche welcher welches was wer wen wem wo wann warum wieso weshalb ob da dort hier dann denn doch noch nur schon sehr auch aber oder und so wie wenn weil dass daß bis seit über unter vor hinter neben zwischen durch gegen ohne um an am ans beim vom zum zur ins im in bin bist sind seid war warst waren wart gewesen habe hast hat haben habt hatte hatten gehabt werde wirst wird werden werdet wurde wurden worden kann kannst können könnt konnte konnten muss musst müssen müsst musste mussten soll sollst sollen sollt sollte sollten will willst wollen wollt wollte wollten darf darfst dürfen dürft durfte durften mag magst mögen möchte möchten lässt lassen ja nein nicht kein keine keinen keinem keiner keines man mehr viel viele vielen weniger wenig alle allem allen aller alles etwas nichts jeder jede jedes jedem jeden einige einem einen einer eines eins zwei drei vier fünf sechs sieben acht neun zehn heute morgen gestern immer nie oft jetzt gerade wieder also etwa zwar sowie sondern obwohl während nachdem bevor damit sodass als ob z.B bzw",
  en: "i you he she it we they me him her us them my your his its our their mine yours hers ours theirs this these those that there here what who whom whose which when where why how a an the and or but if because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once all any both each few more most other some such no nor not only own same so than too very can could may might must shall should will would do does did doing done have has had having be been being am is are was were get got gets getting go goes went gone one two three four five six seven eight nine ten first second new also just now even still already yet ever never always often sometimes much many well back way like per etc e.g i.e",
  fr: "je tu il elle on nous vous ils elles me te se lui leur moi toi eux mon ma mes ton ta tes son sa ses notre nos votre vos leurs ce cet cette ces celui celle ceux celles qui que quoi dont où quand comment pourquoi ne pas plus moins très trop aussi bien mal si oui non et ou mais donc or ni car à de du des au aux en dans sur sous par pour sans avec chez vers entre avant après pendant depuis jusque contre être suis es est sommes êtes sont étais était étions étaient été avoir ai as avons avez ont avais avait avaient eu faire fais fait faisons faites font aller vais va allons allez vont pouvoir peux peut peuvent devoir dois doit doivent vouloir veux veut veulent tout tous toute toutes autre autres même mêmes chaque quelque quelques rien personne aucun aucune un une deux trois quatre cinq six sept huit neuf dix déjà encore toujours jamais souvent ici là",
  es: "yo tú él ella usted nosotros vosotros ellos ellas me te se nos os le les lo la los las mi mis tu tus su sus nuestro nuestra nuestros nuestras este esta estos estas ese esa esos esas aquel aquella que quien quienes cual cuales cuyo donde cuando como por qué no sí ni y o pero sino aunque porque si a de del al en con sin sobre bajo entre hacia hasta desde para contra durante según ser soy eres es somos sois son era eran fue fueron sido estar estoy está están estaba estaban haber he ha han había habían tener tengo tiene tienen tenía hacer hace hacen hizo poder puede pueden podía deber debe deben ir va van todo toda todos todas otro otra otros otras mismo misma cada algo nada alguien nadie alguno alguna algunos algunas ninguno ninguna un una unos unas dos tres cuatro cinco seis siete ocho nueve diez más menos muy mucho muchos poco pocos también ya aún todavía siempre nunca aquí allí ahí así",
  it: "io tu lui lei noi voi loro mi ti si ci vi me te sé lo la li le gli ne mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri nostre vostro vostra vostri vostre questo questa questi queste quello quella quelli quelle chi che cui quale quali dove quando come perché cosa non sì né e o ma però anche se a da di in su per tra fra con senza sopra sotto verso contro durante dopo prima essere sono sei è siamo siete era erano stato stata stati state avere ho hai ha abbiamo avete hanno aveva avevano fare fa fanno fatto potere può possono dovere deve devono volere vuole vogliono andare va vanno tutto tutta tutti tutte altro altra altri altre stesso stessa ogni qualche qualcosa niente nessuno uno una due tre quattro cinque sei sette otto nove dieci più meno molto molti poco pochi già ancora sempre mai spesso qui qua lì là così",
  pt: "eu tu ele ela você nós vós eles elas vocês me te se nos lhe lhes mim ti si meu minha meus minhas teu tua seu sua seus suas nosso nossa nossos nossas este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo que quem qual quais onde quando como porque não sim nem e ou mas porém a de do da dos das em no na nos nas ao aos à às por para com sem sobre sob entre até desde contra durante após antes ser sou és é somos são era eram foi foram sido estar estou está estão estava estavam ter tenho tem têm tinha tinham haver há havia fazer faz fazem fez poder pode podem dever deve devem querer quer querem ir vai vão todo toda todos todas outro outra outros outras mesmo mesma cada algo nada alguém ninguém algum alguma alguns algumas nenhum nenhuma um uma uns umas dois duas três quatro cinco seis sete oito nove dez mais menos muito muitos pouco poucos também já ainda sempre nunca aqui ali lá assim",
  nl: "ik jij je u hij zij ze het wij we jullie me mij jou hem haar ons hun hen mijn jouw uw zijn haar onze hun dit deze dat die wat wie welke waar wanneer hoe waarom niet geen wel ja nee en of maar want dus omdat als dan toch nog al ook zo te aan bij door in naar om onder op over tegen tot uit van voor zonder met tussen tijdens na ben bent is zijn was waren geweest heb hebt heeft hebben had hadden gehad word wordt worden werd werden kan kunt kunnen kon konden moet moeten moest moesten zal zult zullen zou zouden wil wilt willen wilde wilden mag mogen mocht mochten alle alles elk elke iets niets iemand niemand veel weinig meer minder heel erg een twee drie vier vijf zes zeven acht negen tien hier daar nu dan altijd nooit vaak weer",
  pl: "ja ty on ona ono my wy oni one mnie mi cię ci go mu jej ją nas nam was wam ich im nich nimi mój moja moje twój twoja twoje jego swój swoja swoje nasz nasza nasze wasz wasza wasze ten ta to te tamten który która które co kto gdzie kiedy jak dlaczego czy nie tak ani i a oraz albo lub ale lecz więc bo ponieważ gdy jeśli że aby żeby by w we z ze na do od o u po pod nad przed za przez przy bez dla między ku być jestem jesteś jest jesteśmy jesteście są był była było byli były będzie będą mieć mam masz ma mamy macie mają miał miała mieli móc może mogą musieć musi muszą chcieć chce chcą wszystko wszyscy każdy coś nic ktoś nikt jakiś jeden dwa trzy cztery pięć sześć siedem osiem dziewięć dziesięć bardzo dużo mało więcej mniej też także już jeszcze zawsze nigdy często tu tam teraz",
  cs: "já ty on ona ono my vy oni ony mě mi mně tě ti ho mu jí ji nás nám vás vám jich jim nich nimi můj moje tvůj tvoje jeho její svůj náš naše váš vaše ten ta to ti ty tento tato toto který která které co kdo kde kdy jak proč zda ne ano ani a i nebo ale však tedy protože když jestli že aby by v ve z ze na do od o u po pod nad před za přes při bez pro mezi k ke být jsem jsi je jsme jste jsou byl byla bylo byli byly bude budou mít mám máš má máme máte mají měl měla měli moci může mohou muset musí musí chtít chce chtějí všechno všichni každý něco nic někdo nikdo nějaký jeden dva tři čtyři pět šest sedm osm devět deset velmi hodně málo více méně také taky už ještě vždy nikdy často tady tam teď",
  sv: "jag du han hon den det vi ni de mig dig sig honom henne oss er dem min mitt mina din ditt dina hans hennes dess vår vårt våra er ert era deras denna detta dessa vilken vilket vilka vad vem var när hur varför inte ja nej och eller men så för att om i på av till från med utan över under mellan genom mot vid efter före är var varit vara har hade haft ha blir blev blivit bli kan kunde ska skulle vill ville måste får fick alla allt varje något ingenting någon ingen en ett två tre fyra fem sex sju åtta nio tio mycket många lite mer mindre också redan ännu alltid aldrig ofta här där nu",
  tr: "ben sen o biz siz onlar beni seni onu bizi sizi onları bana sana ona bize size onlara benim senin onun bizim sizin onların bu şu bunlar şunlar hangi ne kim nerede nereye ne zaman nasıl neden niçin mi mı mu mü değil evet hayır ve veya ya ama fakat ancak çünkü eğer ki de da ile için gibi kadar göre karşı doğru sonra önce üzerinde altında arasında içinde var yok olmak oldu olur olan olarak etmek etti eder yapmak yaptı yapar her hiç bir şey bazı tüm bütün çok az daha en pek iki üç dört beş altı yedi sekiz dokuz on şimdi hep hiçbir burada orada",
  ru: "я ты он она оно мы вы они меня тебя его её нас вас их мне тебе ему ей нам вам им мной тобой ею нами вами ими мой моя моё мои твой твоя твоё твои свой своя своё свои наш наша наше наши ваш ваша ваше ваши этот эта это эти тот та то те который которая которое которые что кто где когда как почему зачем ли не нет да ни и а но или же ведь потому если чтобы хотя пока в во на с со к ко о об обо у за из от до по под над при про без для между через быть есть был была было были будет будут мочь может могут должен должна должно должны хотеть хочет хотят всё все всех каждый что-то ничего кто-то никто один одна одно два три четыре пять шесть семь восемь девять десять очень много мало больше меньше также тоже уже ещё еще всегда никогда часто здесь там сейчас тогда так",
  uk: "я ти він вона воно ми ви вони мене тебе його її нас вас їх мені тобі йому їй нам вам їм мною тобою нею нами вами ними мій моя моє мої твій твоя твоє твої свій своя своє свої наш наша наше наші ваш ваша ваше ваші цей ця це ці той та те ті який яка яке які що хто де коли як чому навіщо чи не ні так і й а але або ж бо тому якщо щоб хоча поки в у на з із зі к до о об при за від по під над про без для між через бути є був була було були буде будуть могти може можуть повинен повинна повинні хотіти хоче хочуть все всі всіх кожен щось нічого хтось ніхто один одна одне два три чотири п'ять шість сім вісім дев'ять десять дуже багато мало більше менше також теж вже ще завжди ніколи часто тут там зараз тоді",
};

/** Terms the document's list or the pair's vocabulary already has, lower-cased. */
function wordsKnown() {
  const known = new Set((state.keywords || []).map((r) => r.term.trim().toLowerCase()));
  const pair = currentPair();
  if (pair) for (const r of vocabRows(pair)) known.add(r.term.trim().toLowerCase());
  return known;
}

function wordsSnippet(text, pos, len) {
  const span = 55;
  let a = Math.max(0, pos - span), b = Math.min(text.length, pos + len + span);
  if (a > 0) { const sp = text.indexOf(" ", a); if (sp >= 0 && sp < pos) a = sp + 1; }
  if (b < text.length) { const sp = text.lastIndexOf(" ", b); if (sp > pos + len) b = sp; }
  return `${a > 0 ? "…" : ""}${text.slice(a, b).trim()}${b < text.length ? "…" : ""}`;
}

/**
 * Words and word groups of the document. Every segment is cut into tokens; a token that is
 * not a function word is counted as a word. Two or three tokens that follow each other with
 * nothing but spaces between them form a word group when the first and the last are not
 * function words and the group occurs at least twice; a pair that only ever occurs inside a
 * group of three is left out.
 */
function wordsCompute() {
  const segs = (state.doc.segments || []).filter((s) => !s.skip && !s.hidden && !s.notes);
  const lang = detectLanguage(segs.slice(0, 300).map(wordsText).join(" ")) || "";
  const stop = new Set(`${STOPWORDS[lang] || ""} ${WORD_STOP[lang] || ""}`.toLowerCase().split(/\s+/).filter(Boolean));
  const counts = new Map(), groups = new Map(); // lower-cased key -> { forms, n, seg, pos, len, first }
  let seq = 0;
  const hit = (map, key, form, s, pos, len, text) => {
    let e = map.get(key);
    if (!e) map.set(key, e = { forms: new Map(), n: 0, seg: s, pos, len, first: seq++ });
    else if (wordsText(e.seg).length < 40 && text.length >= 40) { e.seg = s; e.pos = pos; e.len = len; } // a passage rather than a heading
    e.n++;
    e.forms.set(form, (e.forms.get(form) || 0) + 1);
  };
  for (const s of segs) {
    const text = wordsText(s);
    const toks = [];
    for (const m of text.matchAll(WORD_RE)) {
      const form = m[0].replace(/^[-'’­]+|[-'’­]+$/g, "");
      if (!form) continue;
      const key = form.toLowerCase(), small = form.length < 3 && !CJK_RE.test(form);
      toks.push({ form, key, start: m.index, end: m.index + m[0].length, stop: stop.has(key) || small });
      if (small || stop.has(key)) continue;
      hit(counts, key, form, s, m.index, form.length, text);
    }
    const adjacent = (a, b) => /^\s+$/.test(text.slice(a.end, b.start));
    for (let i = 0; i < toks.length; i++) {
      const a = toks[i], b = toks[i + 1], c = toks[i + 2];
      if (!b || a.stop || !adjacent(a, b)) continue;
      if (!b.stop) hit(groups, `${a.key} ${b.key}`, `${a.form} ${b.form}`, s, a.start, b.end - a.start, text);
      if (c && !c.stop && adjacent(b, c)) hit(groups, `${a.key} ${b.key} ${c.key}`, `${a.form} ${b.form} ${c.form}`, s, a.start, c.end - a.start, text);
    }
  }
  const toRow = ([key, e]) => ({ key, word: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], n: e.n, first: e.first, snippet: wordsSnippet(wordsText(e.seg), e.pos, e.len) });
  wd.rows = [...counts.entries()].map(toRow);
  const triples = [...groups.entries()].filter(([k, e]) => k.split(" ").length === 3 && e.n >= PHRASE_MIN);
  const inTriple = new Map(); // pair -> occurrences inside counted triples
  for (const [k, e] of triples) { const w = k.split(" "); for (const pr of [`${w[0]} ${w[1]}`, `${w[1]} ${w[2]}`]) inTriple.set(pr, (inTriple.get(pr) || 0) + e.n); }
  wd.phrases = [...groups.entries()].filter(([k, e]) => e.n >= PHRASE_MIN && (k.split(" ").length === 3 || e.n > (inTriple.get(k) || 0))).map(toRow);
  wd.lang = lang;
  wd.docId = state.doc.id;
  wd.sel.clear();
}

/** The rows of the current view (words or word groups), narrowed and sorted as chosen. */
function wordsVisible() {
  const q = wd.query.trim().toLowerCase(), known = wordsKnown();
  const all = wd.view === "phrases" ? wd.phrases : wd.rows;
  for (const r of all) r.known = known.has(r.key);
  const rows = all.filter((r) => (!wd.hideKnown || !r.known) && (!wd.selOnly || wd.sel.has(r.key)) && (!q || r.key.includes(q)));
  if (wd.sort === "alpha") rows.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));
  else if (wd.sort === "first") rows.sort((a, b) => a.first - b.first);
  else rows.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return rows;
}
const wordsAll = () => [...wd.rows, ...wd.phrases];

function wordsRender() {
  if (!state.doc) return;
  if (wd.docId !== state.doc.id) wordsCompute();
  const rows = wordsVisible();
  const list = $("#wordsList");
  const shown = rows.slice(0, WORDS_SHOWN);
  list.innerHTML = shown.length ? shown.map((r) => `<label class="words-row${wd.sel.has(r.key) ? " sel" : ""}${r.known ? " known" : ""}">
      <input type="checkbox" data-key="${escapeHtml(r.key)}"${wd.sel.has(r.key) ? " checked" : ""}>
      <span class="words-word">${escapeHtml(r.word)}</span>
      <span class="words-n" title="${escapeHtml(t("words.countTitle"))}">${r.n}×</span>
      ${r.known ? `<span class="words-known">${escapeHtml(t("words.known"))}</span>` : ""}
      <span class="words-snip">${escapeHtml(r.snippet)}</span>
    </label>`).join("") + (rows.length > shown.length ? `<p class="muted small">${escapeHtml(t("words.more", { n: rows.length - shown.length }))}</p>` : "")
    : `<p class="muted small">${escapeHtml(t("words.empty"))}</p>`;
  $("#wordsCount").textContent = t(wd.view === "phrases" ? "words.countPhrases" : "words.count", { n: rows.length, total: (wd.view === "phrases" ? wd.phrases : wd.rows).length, sel: wd.sel.size });
  $("#wordsViewWords").classList.toggle("active", wd.view === "words");
  $("#wordsViewPhrases").classList.toggle("active", wd.view === "phrases");
  $("#wordsViewPhrases").textContent = t("words.viewPhrases", { n: wd.phrases.length });
  $("#wordsPrompt").disabled = !wd.sel.size;
  $("#wordsPrompt").textContent = t("words.prompt", { n: wd.sel.size });
  $("#wordsCards").disabled = !(state.keywords || []).some((r) => r.term.trim() && r.translation.trim());
}

/** The prompt: the chosen words with a passage each, the target language and context from the AI window. */
function wordsPromptText() {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#aiTarget").value.trim() || P.target;
  const context = $("#aiContext").value.trim();
  const rows = wordsAll().filter((r) => wd.sel.has(r.key));
  const lines = [P.words(target, rows.length)];
  if (context) lines.push("", P.context(context.replace(/\.$/, "")));
  lines.push("", P.wordsList, ...rows.map((r) => `${r.word} — „${r.snippet}“`));
  return lines.join("\n");
}

function wordsImport() {
  const area = $("#wordsAnswer");
  const text = area.value;
  if (!text.trim()) { toast(t("msg.pasteFirst"), "error"); return; }
  const m = KW_MARK.exec(text);
  const { rows, pair } = kwParseRows(m ? text.slice(m.index + m[0].length) : text);
  if (!rows.length) { toast(t("words.noRows"), "error"); return; }
  kwTakeRows(rows, pair);
  for (const r of rows) wd.sel.delete(r.term.trim().toLowerCase());
  area.value = "";
  kwRenderList(); // (the list mode shows the new terms too)
  wordsRender();
}

function initWords() {
  $("#wordsList").addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-key]");
    if (!cb) return;
    if (cb.checked) wd.sel.add(cb.dataset.key); else wd.sel.delete(cb.dataset.key);
    cb.closest(".words-row").classList.toggle("sel", cb.checked);
    $("#wordsCount").textContent = t(wd.view === "phrases" ? "words.countPhrases" : "words.count", { n: wordsVisible().length, total: (wd.view === "phrases" ? wd.phrases : wd.rows).length, sel: wd.sel.size });
    $("#wordsPrompt").disabled = !wd.sel.size;
    $("#wordsPrompt").textContent = t("words.prompt", { n: wd.sel.size });
  });
  $("#wordsSearch").addEventListener("input", (e) => { wd.query = e.target.value; wordsRender(); });
  $("#wordsViewWords").addEventListener("click", () => { wd.view = "words"; wordsRender(); });
  $("#wordsViewPhrases").addEventListener("click", () => { wd.view = "phrases"; wordsRender(); });
  $("#wordsSort").addEventListener("change", (e) => { wd.sort = e.target.value; wordsRender(); });
  $("#wordsSelOnly").addEventListener("change", (e) => { wd.selOnly = e.target.checked; wordsRender(); });
  $("#wordsHideKnown").addEventListener("change", (e) => { wd.hideKnown = e.target.checked; wordsRender(); });
  $("#wordsSelectTop").addEventListener("click", () => { // the most frequent words still shown and not yet in the vocabulary
    const n = Math.max(1, Number($("#wordsTopN").value) || 30);
    for (const r of wordsVisible().filter((r) => !r.known).slice(0, n)) wd.sel.add(r.key);
    wordsRender();
  });
  $("#wordsSelectNone").addEventListener("click", () => { wd.sel.clear(); wordsRender(); });
  $("#wordsPrompt").addEventListener("click", () => {
    if (!wd.sel.size) { toast(t("words.selectFirst"), "error"); return; }
    copyText(wordsPromptText(), t("words.promptCopied", { n: wd.sel.size }));
  });
  $("#wordsImport").addEventListener("click", wordsImport);
  $("#wordsAnswer").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); wordsImport(); } });
  $("#wordsCards").addEventListener("click", () => kwSetMode("cards"));
}
