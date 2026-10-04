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
  pm.items = Array.from({ length: n }, (_, i) => ({ from: 0, page: i, rot: 0 }));
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
    const btn = (act, key, label, vars) => `<button type="button" data-act="${act}" title="${t(key, vars)}" aria-label="${t(key, vars)}">${label}</button>`;
    const sel = pm.sel.has(it);
    const turn = pmSlides() ? "" : btn("rotate", "pages.rotate", "↻");
    return `<div class="pg-card${pm.swapFrom === i ? " swap" : ""}${pmHiddenItem(it) ? " hidden-slide" : ""}${sel ? " selected" : ""}" draggable="true" data-i="${i}">
      <div class="pg-thumb" style="aspect-ratio: ${size.width} / ${size.height}" title="${t("pages.selectHint")}" role="checkbox" aria-checked="${sel}" aria-label="${t("pages.selectHint")}" tabindex="0">${it.from < 0 ? `<span>${t("pages.blankLabel")}</span>` : '<img alt="">'}</div>
      <div class="pg-label"><b>${i + 1}</b><span class="pg-badge" title="${badge.replace(/"/g, "&quot;")}">${badge}</span></div>
      <div class="pg-btns">${btn("left", "pages.left", "‹")}${btn("right", "pages.right", "›")}${btn("swap", "pages.swap", "⇄")}${turn}${btn("blank", "pages.insertBlank", "+")}${btn("file", "pages.insertFile", "+⎙")}${btn("save", pmSlides() ? "pages.saveOneSlide" : "pages.saveOne", "⤓", { fmt: pmFormat() })}${btn("remove", "pages.remove", "✕")}</div>
    </div>`;
  }).join("");
  $("#pagesCount").textContent = pmUnit(pm.items.length);
  grid.querySelectorAll(".pg-card img").forEach((img) => loadThumb(img));
  pmSelectionBar();
}

const pmFormat = () => (pmSlides() ? "PPTX" : "PDF");

/** The tools for the selected pages: count, select all/none, turn, remove, save. */
function pmSelectionBar() {
  for (const it of [...pm.sel]) if (!pm.items.includes(it)) pm.sel.delete(it);
  const n = pm.sel.size, shown = pm.items.filter(pmShown).length;
  $("#pagesSelCount").textContent = n ? t("pages.selected", { n }) : t("pages.selectNone");
  const all = $("#pagesSelAll");
  all.textContent = t(n && n >= shown ? "pages.unselectAll" : "pages.selectAll");
  for (const id of ["pagesSelLeft", "pagesSelRight", "pagesSelRemove", "pagesSelSave"]) $(`#${id}`).disabled = !n;
  $("#pagesSelLeft").hidden = $("#pagesSelRight").hidden = pmSlides();
  $("#pagesSelSave").textContent = t("pages.saveSel", { fmt: pmFormat() });
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
  const plan = pm.items.filter((it) => items.includes(it)).map((it) => ({ from: it.from, page: it.page, w: it.w, h: it.h, rot: it.rot || 0 }));
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
  const rot = it.rot || 0;
  const turned = pm.thumbs.get(`${key}@${rot}`);
  if (rot && turned) { img.src = turned; return; }
  const show = (url) => {
    const cur = $("#pagesGrid").querySelector(`.pg-card[data-i="${pm.items.indexOf(it)}"] img`);
    if (cur) cur.src = url;
  };
  const cached = pm.thumbs.get(key);
  if (cached) { pmTurnedThumb(key, cached, rot).then(show); return; }
  const size = pmBaseSize(it), zoom = Math.max(0.15, Math.min(1.5, 170 / Math.max(size.width, size.height) * 1.3));
  const req = it.from === 0
    ? pool.leastBusy(null).call("render", { page: pmSlides() ? pm.slides[it.page] : it.page, zoom, variant: "original" })
    : pool.workers[0].call("extraRender", { index: it.from, page: it.page, zoom });
  req.then((buf) => {
    const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    pm.thumbs.set(key, url);
    return pmTurnedThumb(key, url, it.rot || 0).then(show);
  }).catch((err) => console.warn("thumbnail failed", err));
}

/** The thumbnail `url` turned clockwise by `rot` degrees (cached). */
function pmTurnedThumb(key, url, rot) {
  if (!rot) return Promise.resolve(url);
  const done = pm.thumbs.get(`${key}@${rot}`);
  if (done) return Promise.resolve(done);
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas"), side = rot % 180 !== 0;
      c.width = side ? im.height : im.width; c.height = side ? im.width : im.height;
      const g = c.getContext("2d");
      g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180); g.drawImage(im, -im.width / 2, -im.height / 2);
      c.toBlob((b) => { const u = b ? URL.createObjectURL(b) : url; if (b) pm.thumbs.set(`${key}@${rot}`, u); resolve(u); }, "image/png");
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
        const src = ["jpeg", "png", "gif", "bmp", "tiff"].includes(fmt) ? bytes : await transcodeImage(bytes);
        bytes = (await pool.workers[0].call("imageToPdf", { bytes: src })).bytes; kind = "pdf";
      } else if (want === "pptx" && kind === "ppt") {
        const c = await pool.workers[0].call("convert", { bytes, kind }); bytes = c.bytes; kind = c.kind;
      }
      if (kind !== want) { toast(t("pages.badFile", { name: file.name }), "error"); continue; }
      const r = await pool.workers[0].call("extraOpen", { bytes, kind });
      pm.extras.push({ index: r.index, name: file.name.replace(/\.[^.]+$/, ""), pages: r.pages });
      const items = r.pages.map((_, p) => ({ from: r.index, page: p, rot: 0 }));
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
  const plan = pm.items.map((it) => ({ from: it.from, page: it.page, w: it.w, h: it.h, rot: it.rot || 0 }));
  const n = pmSlides() ? pm.slides.length : state.doc.pages.length;
  const dropNotes = pmSlides() && !$("#pagesNotesWrap").hidden && $("#pagesDropNotes").checked;
  if (!dropNotes && plan.length === n && plan.every((p, i) => p.from === 0 && p.page === i && !p.rot)) { toast(t("pages.unchanged")); return; }
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
      // a click on the picture selects (Shift+click: the pages in between too)
      if (e.target.closest(".pg-thumb")) pmToggle(Number(card.dataset.i), e.shiftKey);
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
