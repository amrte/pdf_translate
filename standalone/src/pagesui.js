/* ------------------------------------------------------------- page manager (PDF, PPTX) */
// Pages (slides) of the open file can be reordered, swapped, removed, turned (PDF), and blank
// pages or the pages of other files inserted. "Apply" has the engine put the file together anew;
// the new file is opened and the translations of the kept pages are carried over. Selected pages
// can be turned, removed or saved together as a file of their own, without touching the open one.

const pm = { items: [], extras: [], thumbs: new Map(), swapFrom: null, slides: null, hidden: null, notes: null, showHidden: false, insertAt: null, sel: new Set(), lastSel: null };
const pmNotesItem = (it) => Boolean(it.from === 0 && pm.notes && pm.notes[it.page]);
const pmHiddenItem = (it) => Boolean(it.from === 0 && pm.hidden && pm.hidden[it.page]);
const pmShown = (it) => pm.showHidden || !pmHiddenItem(it);

const pagesSupported = () => Boolean(state.doc && !state.doc.image && (state.doc.kind === "pdf" || state.doc.kind === "pptx"));
const pmSlides = () => pm.slides !== null;
const pmUnit = (n) => t(n === 1 ? (pmSlides() ? "pages.countSlide" : "pages.countOne") : pmSlides() ? "pages.countSlides" : "pages.count", { n });

/** Size of the page an item stands for as it is shown, turned ({width, height} in points). */
function pmPageSize(it) {
  const s = pmBaseSize(it);
  return (it.rot || 0) % 180 ? { width: s.height, height: s.width } : s;
}

/** Size of the page an item stands for, unturned. */
function pmBaseSize(it) {
  if (it.from < 0) return { width: it.w, height: it.h };
  if (it.from === 0) { const p = state.doc.pages[pmSlides() ? pm.slides[it.page] : it.page]; return p || { width: 595, height: 842 }; }
  const ex = pm.extras.find((e) => e.index === it.from);
  return (ex && ex.pages[it.page]) || { width: 595, height: 842 };
}

async function openPagesDialog() {
  if (!pagesSupported()) return;
  const info = await pool.workers[0].call("pagesInfo");
  pm.slides = info && info.slides ? info.slides : null;
  pm.hidden = info && info.hidden ? info.hidden : null;
  pm.notes = info && info.notes ? info.notes : null;
  pm.showHidden = $("#pagesShowHidden").checked;
  $("#pagesHiddenWrap").hidden = !(pm.hidden && pm.hidden.some(Boolean));
  const withNotes = pm.notes ? pm.notes.filter(Boolean).length : 0;
  $("#pagesNotesWrap").hidden = !withNotes;
  $("#pagesDropNotes").checked = false;
  $("#pagesDropNotesText").textContent = t("pages.dropNotes", { n: withNotes });
  pm.extras = []; pm.swapFrom = null; pm.insertAt = null; pm.sel.clear(); pm.lastSel = null;
  for (const url of pm.thumbs.values()) URL.revokeObjectURL(url);
  pm.thumbs.clear();
  await pool.workers[0].call("extraClear").catch(() => {});
  const n = pmSlides() ? pm.slides.length : state.doc.pages.length;
  pm.items = Array.from({ length: n }, (_, i) => ({ from: 0, page: i, rot: 0, skew: 0 }));
  $("#pagesTitle").textContent = t(pmSlides() ? "pages.titleSlides" : "pages.title");
  $("#pagesText").textContent = t(pmSlides() ? "pages.textSlides" : "pages.text");
  renderPagesGrid();
  openModal($("#pagesDialog"));
}

function renderPagesGrid() {
  const grid = $("#pagesGrid");
  grid.innerHTML = pm.items.map((it, i) => {
    if (!pmShown(it)) return "";
    const size = pmPageSize(it);
    let badge = "";
    if (pmHiddenItem(it)) badge = t("pages.hiddenLabel") + " · ";
    if (it.from < 0) badge = t("pages.blankLabel");
    else if (it.from > 0) { const ex = pm.extras.find((e) => e.index === it.from); badge = `${ex ? ex.name : ""} · ${it.page + 1}`; }
    else if (it.page !== i) badge += t("pages.origin", { n: it.page + 1 });
    else badge = badge.replace(/ · $/, "");
    if (pmNotesItem(it)) badge = badge ? `${badge} · ${t("pages.notesLabel")}` : t("pages.notesLabel");
    if (it.rot) badge = badge ? `${badge} · ↻${it.rot}°` : `↻${it.rot}°`;
    const fix = `${it.tracks ? "〰" : ""}${it.quad ? "▱" : it.tracks ? "" : "⟂"}${it.skew ? ` ${pmDeg(-it.skew, true)}` : ""}`; // (the correction: + clockwise)
    if (it.skew || it.quad || it.tracks) badge = badge ? `${badge} · ${fix}` : fix;
    const btn = (act, key, label, vars) => `<button type="button" data-act="${act}" title="${t(key, vars)}" aria-label="${t(key, vars)}">${label}</button>`;
    const sel = pm.sel.has(it);
    const turn = pmSlides() ? "" : btn("rotate", "pages.rotate", "↻");
    return `<div class="pg-card${pm.swapFrom === i ? " swap" : ""}${pmHiddenItem(it) ? " hidden-slide" : ""}${sel ? " selected" : ""}" draggable="true" data-i="${i}">
      <div class="pg-thumb" style="aspect-ratio: ${size.width} / ${size.height}" title="${t("pages.selectHint")}" role="checkbox" aria-checked="${sel}" aria-label="${t("pages.selectHint")}" tabindex="0">${it.from < 0 ? `<span>${t("pages.blankLabel")}</span>` : '<img alt="">'}${badge && it.from >= 0 ? `<span class="pg-badge" title="${badge.replace(/"/g, "&quot;")}">${badge}</span>` : ""}</div>
      <div class="pg-btns"><b class="pg-num">${i + 1}</b>${btn("left", "pages.left", "‹")}${btn("right", "pages.right", "›")}${btn("swap", "pages.swap", "⇄")}${turn}${btn("blank", "pages.insertBlank", "+")}${btn("file", "pages.insertFile", "+⎙")}${btn("save", pmSlides() ? "pages.saveOneSlide" : "pages.saveOne", "⤓", { fmt: pmFormat() })}${btn("remove", "pages.remove", "✕")}</div>
    </div>`;
  }).join("");
  $("#pagesCount").textContent = pmUnit(pm.items.length);
  grid.querySelectorAll(".pg-card img").forEach((img) => loadThumb(img));
  pmSelectionBar();
}

const pmFormat = () => (pmSlides() ? "PPTX" : "PDF");
/** An angle as shown: "1,4°" (German) or "1.4°". */
const pmDeg = (d, sign = false) => `${sign && d > 0 ? "+" : ""}${(Math.round(d * 10) / 10).toLocaleString(LANG === "de" ? "de-DE" : "en-GB")}°`;

/** The tools for the selected pages: count, select all/none, turn, remove, save. */
function pmSelectionBar() {
  for (const it of [...pm.sel]) if (!pm.items.includes(it)) pm.sel.delete(it);
  const n = pm.sel.size, shown = pm.items.filter(pmShown).length;
  $("#pagesSelCount").textContent = n ? t("pages.selected", { n }) : t("pages.selectNone");
  const all = $("#pagesSelAll");
  all.textContent = t(n && n >= shown ? "pages.unselectAll" : "pages.selectAll");
  for (const id of ["pagesSelLeft", "pagesSelRight", "pagesSelRemove", "pagesSelSave"]) $(`#${id}`).disabled = !n;
  $("#pagesSelLeft").hidden = $("#pagesSelRight").hidden = $("#pagesStraightWrap").hidden = pmSlides();
  $("#pagesSelStraight").disabled = $("#pagesSkew").disabled = !n;
  $("#pagesSelHand").disabled = n !== 1 || [...pm.sel][0].from < 0;
  // The tilt of the selection: shown when all selected pages share it.
  const tilts = [...new Set([...pm.sel].map((it) => Math.round((it.skew || 0) * 10) / 10))];
  if (document.activeElement !== $("#pagesSkew")) $("#pagesSkew").value = n && tilts.length === 1 ? (0 - tilts[0] || 0).toLocaleString(LANG === "de" ? "de-DE" : "en-GB") : "";
  $("#pagesSelSave").textContent = t("pages.saveSel", { fmt: pmFormat() });
}

const SKEW_LIMIT = 15;

/**
 * Measures the tilt of the given pages and straightens them (blank pages are skipped). A page
 * without clear text lines keeps its angle; one tilted by less than 0.1° counts as straight.
 */
async function pmStraighten(items) {
  const todo = items.filter((it) => it.from >= 0);
  if (!todo.length) return;
  let fixed = 0, straight = 0, unclear = 0, turned = 0;
  for (const [k, it] of todo.entries()) {
    if (it.quad || it.tracks) { straight++; continue; } // (corners and lines traced by hand keep their own angle)
    busy(t("pages.measuring", { i: k + 1, n: todo.length }));
    try {
      // (which way up too: a page lying on its side or upside down gets its quarter turn)
      const r = await pool.workers[0].call("orientDetect", { page: pmSlides() ? pm.slides[it.page] : it.page, index: it.from });
      if (!r || !r.confidence && !r.turn && !r.tilt) { unclear++; continue; }
      if ((it.rot || 0) !== r.turn) { it.rot = r.turn; turned++; }
      if (Math.abs(r.tilt) < 0.1) { it.skew = 0; straight++; continue; }
      it.skew = r.tilt; fixed++;
    } catch (err) {
      console.warn("skew", err); unclear++;
    }
  }
  busy("");
  renderPagesGrid();
  toast(t("pages.straightened", { n: fixed, s: straight, u: unclear, o: turned }), fixed || turned ? "ok" : undefined);
}

/** One page shown large, to be turned or flattened by hand (see straighten.js). */
async function pmHand(it) {
  busy(t("pic.preparing"));
  try {
    const base = pmBaseSize(it), zoom = Math.min(4, 1800 / Math.max(base.width, base.height));
    const page = it.from === 0 && pmSlides() ? pm.slides[it.page] : it.page;
    const buf = it.from === 0
      ? await pool.leastBusy(null).call("render", { page, zoom, variant: "original" })
      : await pool.workers[0].call("extraRender", { index: it.from, page, zoom });
    // As the page is shown: with its quarter turn.
    const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }));
    const side = (it.rot || 0) % 180 !== 0;
    const c = document.createElement("canvas");
    c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate(((it.rot || 0) * Math.PI) / 180); g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    bmp.close && bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const size = pmPageSize(it);
    busy("");
    await openStraighten({
      image: blob, width: size.width, height: size.height, angle: -(it.skew || 0), quad: it.quad || null, tracks: it.tracks || null,
      title: t("pages.handTitleShort", { n: pm.items.indexOf(it) + 1 }),
      measure: () => pool.workers[0].call("skewDetect", { page, index: it.from }),
      onApply: (angle, quad, tracks) => { it.skew = angle ? -angle : 0; it.quad = quad; it.tracks = tracks; renderPagesGrid(); },
    });
  } catch (err) {
    console.error(err);
    toast(t("pages.saveFailed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

/** Turns an item by `deg` (a blank page swaps its sides instead). */
function pmTurn(it, deg) {
  if (it.from < 0) { if (deg % 180) [it.w, it.h] = [it.h, it.w]; return; }
  it.rot = ((((it.rot || 0) + deg) % 360) + 360) % 360;
}

function pmToggle(i, range) {
  const it = pm.items[i];
  if (!it) return;
  if (range && pm.lastSel !== null && pm.items.includes(pm.lastSel)) {
    const a = pm.items.indexOf(pm.lastSel);
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) if (pmShown(pm.items[k])) pm.sel.add(pm.items[k]);
  } else if (pm.sel.has(it)) pm.sel.delete(it);
  else pm.sel.add(it);
  pm.lastSel = it;
  renderPagesGrid();
}

/** Ranges of page numbers for a file name: [1, 2, 3, 5] → "1-3,5". */
function pmRanges(nums) {
  const out = [];
  for (let k = 0; k < nums.length; k++) {
    let j = k;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > k ? `${nums[k]}-${nums[j]}` : `${nums[k]}`);
    k = j;
  }
  return out.join(",");
}

/** Saves the given items, in the order of the grid, as a file of their own. */
async function pmSave(items) {
  if (!items.length) return;
  const plan = pm.items.filter((it) => items.includes(it)).map((it) => ({ from: it.from, page: it.page, w: it.w, h: it.h, rot: it.rot || 0, skew: pmSlides() ? 0 : it.skew || 0, quad: pmSlides() ? null : it.quad || null, tracks: pmSlides() ? null : it.tracks || null }));
  const ext = pmSlides() ? "pptx" : "pdf";
  const base = state.doc.name.replace(/\.[^.]+$/, "");
  // Numbered by the open file's own pages when all come from it, else by their place in the grid.
  const own = plan.every((p) => p.from === 0);
  const nums = own ? plan.map((p) => p.page + 1) : pm.items.map((it, i) => (items.includes(it) ? i + 1 : 0)).filter(Boolean);
  const sorted = own && nums.every((v, k) => k === 0 || v > nums[k - 1]);
  const label = t(pmSlides() ? "pages.fileSlides" : "pages.filePages");
  const name = `${base}_${label}_${sorted || !own ? pmRanges(nums) : nums.join(",")}`.slice(0, 120) + `.${ext}`;
  busy(t("pages.saving"));
  try {
    const bytes = await pool.workers[0].call("rearrange", { plan, dropNotes: false });
    const mime = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    saveBlob(new Blob([bytes], { type: mime }), name);
    toast(t("pages.saved", { n: pmUnit(plan.length), name }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("pages.saveFailed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

/** Thumbnails come from the workers (the open file) or from worker 0 (extra files). */
function loadThumb(img) {
  const card = img.closest(".pg-card"), it = pm.items[Number(card.dataset.i)];
  if (!it || it.from < 0) return;
  const key = `${it.from}:${it.page}`;
  const rot = it.rot || 0, skew = it.skew || 0, quad = it.quad || null, tracks = it.tracks || null;
  const turned = pm.thumbs.get(`${key}@${rot}@${skew}@${quad}@${tracks ? tracks.length + ":" + tracks[0][0] : ""}`);
  if ((rot || skew || quad || tracks) && turned) { img.src = turned; return; }
  const show = (url) => {
    const cur = $("#pagesGrid").querySelector(`.pg-card[data-i="${pm.items.indexOf(it)}"] img`);
    if (cur) cur.src = url;
  };
  const cached = pm.thumbs.get(key);
  if (cached) { pmTurnedThumb(key, cached, rot, skew, quad, tracks).then(show); return; }
  const size = pmBaseSize(it), zoom = Math.max(0.15, Math.min(1.5, 170 / Math.max(size.width, size.height) * 1.3));
  const req = it.from === 0
    ? pool.leastBusy(null).call("render", { page: pmSlides() ? pm.slides[it.page] : it.page, zoom, variant: "original" })
    : pool.workers[0].call("extraRender", { index: it.from, page: it.page, zoom });
  req.then((buf) => {
    const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    pm.thumbs.set(key, url);
    return pmTurnedThumb(key, url, it.rot || 0, it.skew || 0, it.quad || null, it.tracks || null).then(show);
  }).catch((err) => console.warn("thumbnail failed", err));
}

/** The thumbnail `url` turned clockwise by `rot` degrees, straightened and flattened (cached). */
function pmTurnedThumb(key, url, rot, skew = 0, quad = null, tracks = null) {
  if (!rot && !skew && !quad && !tracks) return Promise.resolve(url);
  const id = `${key}@${rot}@${skew}@${quad}@${tracks ? tracks.length + ":" + tracks[0][0] : ""}`, done = pm.thumbs.get(id);
  if (done) return Promise.resolve(done);
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const a = document.createElement("canvas");
      a.width = im.width; a.height = im.height;
      const ga = a.getContext("2d", { willReadFrequently: true });
      ga.drawImage(im, 0, 0);
      const px = ga.getImageData(0, 0, a.width, a.height);
      const res = Engine.warpPixels(px.data, a.width, a.height, 4, { turn: rot, angle: -skew, quad, tracks });
      const c = document.createElement("canvas");
      c.width = res.width; c.height = res.height;
      c.getContext("2d").putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
      c.toBlob((b) => { const u = b ? URL.createObjectURL(b) : url; if (b) pm.thumbs.set(id, u); resolve(u); }, "image/png");
    };
    im.onerror = () => resolve(url);
    im.src = url;
  });
}

function pmMove(from, to) {
  if (to < 0 || to >= pm.items.length || from === to) return;
  const [it] = pm.items.splice(from, 1);
  pm.items.splice(to, 0, it);
  pm.swapFrom = null;
  renderPagesGrid();
}

/** Files added to the plan: PDFs and pictures for a PDF, PPTX/PPT decks for a presentation. */
async function addPagesFromFiles(files, at) {
  const want = state.doc.kind; // "pdf" | "pptx"
  for (const file of files) {
    busy(t("pages.reading", { name: file.name }));
    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let kind = Engine.detectKind(bytes, file.name);
      if (want === "pdf" && kind === "image") {
        const fmt = Engine.imageKindOf(bytes);
        const src = ENGINE_IMAGES.includes(fmt) ? bytes : await transcodeImage(bytes);
        bytes = (await pool.workers[0].call("imageToPdf", { bytes: src })).bytes; kind = "pdf";
      } else if (want === "pptx" && kind === "ppt") {
        const c = await pool.workers[0].call("convert", { bytes, kind }); bytes = c.bytes; kind = c.kind;
      }
      if (kind !== want) { toast(t("pages.badFile", { name: file.name }), "error"); continue; }
      const r = await pool.workers[0].call("extraOpen", { bytes, kind });
      pm.extras.push({ index: r.index, name: file.name.replace(/\.[^.]+$/, ""), pages: r.pages });
      const items = r.pages.map((_, p) => ({ from: r.index, page: p, rot: 0, skew: 0 }));
      pm.items.splice(at, 0, ...items);
      at += items.length;
    } catch (err) {
      console.error(err);
      toast(t("pages.badFile", { name: file.name }) + ` (${userError(err)})`, "error");
    } finally {
      busy("");
    }
  }
  pm.swapFrom = null;
  renderPagesGrid();
}

/** The translations of the kept pages, found again on the new file by page (slide) and text. */
function pmCaptureTranslations() {
  const unitOf = (s) => (state.doc.kind === "pptx" ? s.slide || 0 : s.page);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const map = new Map();
  for (const s of state.doc.segments) {
    const tr = (state.translations[s.id] || "").trim();
    if (!tr) continue;
    const key = `${unitOf(s)}|${norm(s.text)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tr);
  }
  return { map, norm, unitOf };
}
function pmRestoreTranslations(cap, plan) {
  let n = 0;
  for (const s of state.doc.segments) {
    const it = plan[cap.unitOf(s)];
    if (!it || it.from !== 0 || hasTr(s.id)) continue;
    const q = cap.map.get(`${it.page}|${cap.norm(s.text)}`);
    if (q && q.length) { state.translations[s.id] = q.shift(); n++; }
  }
  if (n) { storeTranslations(); refreshCards(); updateProgress(); }
  return n;
}

async function applyPages() {
  const plan = pm.items.map((it) => ({ from: it.from, page: it.page, w: it.w, h: it.h, rot: it.rot || 0, skew: pmSlides() ? 0 : it.skew || 0, quad: pmSlides() ? null : it.quad || null, tracks: pmSlides() ? null : it.tracks || null }));
  const n = pmSlides() ? pm.slides.length : state.doc.pages.length;
  const dropNotes = pmSlides() && !$("#pagesNotesWrap").hidden && $("#pagesDropNotes").checked;
  if (!dropNotes && plan.length === n && plan.every((p, i) => p.from === 0 && p.page === i && !p.rot && !p.skew && !p.quad && !p.tracks)) { toast(t("pages.unchanged")); return; }
  const name = state.doc.name.replace(/\.ppt$/i, ".pptx");
  const kind = state.doc.kind;
  busy(t("pages.working"));
  try {
    const bytes = await pool.workers[0].call("rearrange", { plan, dropNotes });
    const cap = pmCaptureTranslations();
    await loadBytes(new Uint8Array(bytes), name, true);
    if (!state.doc || state.doc.kind !== kind) return;
    const k = pmRestoreTranslations(cap, plan);
    toast(t("pages.done", { n: pmUnit(plan.length), k }), "ok");
  } catch (err) {
    console.error(err);
    toast(t("pages.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
    pool.workers[0].call("extraClear").catch(() => {});
  }
}

function initPagesManager() {
  $("#btnPages").addEventListener("click", openPagesDialog);
  const dlg = $("#pagesDialog"), grid = $("#pagesGrid");
  dlg.addEventListener("close", () => { if (dlg.returnValue === "ok") applyPages(); });
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"), card = e.target.closest(".pg-card");
    if (!card) return;
    if (!b) {
      // a click on the picture selects (Shift+click: the pages in between too); a double click
      // opens it for straightening by hand (the grid is drawn anew on each click, so the browser's
      // own dblclick never arrives)
      if (e.target.closest(".pg-thumb")) {
        const i = Number(card.dataset.i), now = Date.now(), it = pm.items[i];
        if (pm.lastClick && pm.lastClick.it === it && now - pm.lastClick.t < 450 && !e.shiftKey) {
          pm.lastClick = null;
          if (!pm.sel.has(it)) pmToggle(i, false);
          if (it.from >= 0 && !pmSlides()) pmHand(it);
          return;
        }
        pm.lastClick = { it, t: now };
        pmToggle(i, e.shiftKey);
      }
      return;
    }
    const i = Number(card.dataset.i), act = b.dataset.act;
    const neighbour = (dir) => { let j = i + dir; while (j >= 0 && j < pm.items.length && !pmShown(pm.items[j])) j += dir; return j; };
    if (act === "left") pmMove(i, neighbour(-1));
    else if (act === "right") pmMove(i, neighbour(1));
    else if (act === "remove") {
      if (pm.items.length <= 1) { toast(t("pages.none"), "error"); return; }
      pm.items.splice(i, 1); pm.swapFrom = null; renderPagesGrid();
    } else if (act === "swap") {
      if (pm.swapFrom === null || pm.swapFrom === i) { pm.swapFrom = pm.swapFrom === i ? null : i; renderPagesGrid(); return; }
      const a = pm.swapFrom; [pm.items[a], pm.items[i]] = [pm.items[i], pm.items[a]];
      pm.swapFrom = null; renderPagesGrid();
    } else if (act === "blank") {
      const size = pmPageSize(pm.items[i]);
      pm.items.splice(i + 1, 0, { from: -1, w: size.width, h: size.height }); pm.swapFrom = null; renderPagesGrid();
    } else if (act === "file") { pm.insertAt = i + 1; $("#pagesFile").click(); }
    else if (act === "rotate") { pmTurn(pm.items[i], 90); renderPagesGrid(); }
    else if (act === "save") pmSave([pm.items[i]]);
  });
  grid.addEventListener("keydown", (e) => { // (the picture is focusable: Space or Enter selects it)
    const th = e.target.closest(".pg-thumb");
    if (!th || (e.key !== " " && e.key !== "Enter")) return;
    e.preventDefault();
    const i = Number(th.closest(".pg-card").dataset.i);
    pmToggle(i, e.shiftKey);
    grid.querySelector(`.pg-card[data-i="${i}"] .pg-thumb`)?.focus();
  });
  // (a click anywhere else in between: the next click on a page is a single one again)
  dlg.addEventListener("click", (e) => { if (!e.target.closest(".pg-thumb")) pm.lastClick = null; }, true);
  $("#pagesSelAll").addEventListener("click", () => {
    const shown = pm.items.filter(pmShown);
    if (pm.sel.size >= shown.length) pm.sel.clear(); else shown.forEach((it) => pm.sel.add(it));
    renderPagesGrid();
  });
  $("#pagesSelLeft").addEventListener("click", () => { pm.sel.forEach((it) => pmTurn(it, -90)); renderPagesGrid(); });
  $("#pagesSelRight").addEventListener("click", () => { pm.sel.forEach((it) => pmTurn(it, 90)); renderPagesGrid(); });
  $("#pagesSelRemove").addEventListener("click", () => {
    const left = pm.items.filter((it) => !pm.sel.has(it));
    if (!left.length) { toast(t("pages.none"), "error"); return; }
    pm.items = left; pm.sel.clear(); pm.swapFrom = null; renderPagesGrid();
  });
  $("#pagesSelSave").addEventListener("click", () => pmSave([...pm.sel]));
  $("#pagesSelStraight").addEventListener("click", () => pmStraighten([...pm.sel]));
  $("#pagesSelHand").addEventListener("click", () => { const it = [...pm.sel][0]; if (pm.sel.size === 1 && it.from >= 0) pmHand(it); });

  $("#pagesSkew").addEventListener("keydown", (e) => { // (Enter sets the angle; it must not close the dialog)
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.target.dispatchEvent(new Event("change"));
  });
  $("#pagesSkew").addEventListener("change", (e) => {
    const v = Number(String(e.target.value).replace(",", "."));
    if (!Number.isFinite(v)) return;
    const tilt = -Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, Math.round(v * 10) / 10)); // (the field shows the correction: turned this far)
    pm.sel.forEach((it) => { if (it.from >= 0) it.skew = tilt; });
    renderPagesGrid();
  });
  $("#pagesAddBlank").addEventListener("click", () => {
    const size = pm.items.length ? pmPageSize(pm.items[pm.items.length - 1]) : { width: 595, height: 842 };
    pm.items.push({ from: -1, w: size.width, h: size.height }); renderPagesGrid();
  });
  $("#pagesAddFile").addEventListener("click", () => { pm.insertAt = pm.items.length; $("#pagesFile").click(); });
  $("#pagesShowHidden").addEventListener("change", (e) => { pm.showHidden = e.target.checked; pm.swapFrom = null; renderPagesGrid(); });
  $("#pagesFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await addPagesFromFiles(files, pm.insertAt === null ? pm.items.length : pm.insertAt);
  });
  // drag and drop: a card dropped on another one moves there
  let dragFrom = null;
  grid.addEventListener("dragstart", (e) => { const c = e.target.closest(".pg-card"); if (!c) return; dragFrom = Number(c.dataset.i); c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(dragFrom)); });
  grid.addEventListener("dragend", () => { dragFrom = null; grid.querySelectorAll(".dragging, .over").forEach((c) => c.classList.remove("dragging", "over")); });
  grid.addEventListener("dragover", (e) => { const c = e.target.closest(".pg-card"); if (!c || dragFrom === null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; grid.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); c.classList.add("over"); });
  grid.addEventListener("drop", (e) => { const c = e.target.closest(".pg-card"); if (!c || dragFrom === null) return; e.preventDefault(); pmMove(dragFrom, Number(c.dataset.i)); dragFrom = null; });
}
