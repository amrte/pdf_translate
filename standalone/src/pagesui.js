/* ------------------------------------------------------------- page manager (PDF, PPTX) */
// Pages (slides) of the open file can be reordered, swapped, removed, and blank pages or the
// pages of other files inserted. "Apply" has the engine put the file together anew; the new file
// is opened and the translations of the kept pages are carried over.

const pm = { items: [], extras: [], thumbs: new Map(), swapFrom: null, slides: null, insertAt: null };

const pagesSupported = () => Boolean(state.doc && !state.doc.image && (state.doc.kind === "pdf" || state.doc.kind === "pptx"));
const pmSlides = () => pm.slides !== null;
const pmUnit = (n) => t(pmSlides() ? "pages.countSlides" : "pages.count", { n });

/** Size of the page an item stands for ({width, height} in points). */
function pmPageSize(it) {
  if (it.from < 0) return { width: it.w, height: it.h };
  if (it.from === 0) { const p = state.doc.pages[pmSlides() ? pm.slides[it.page] : it.page]; return p || { width: 595, height: 842 }; }
  const ex = pm.extras.find((e) => e.index === it.from);
  return (ex && ex.pages[it.page]) || { width: 595, height: 842 };
}

async function openPagesDialog() {
  if (!pagesSupported()) return;
  const info = await pool.workers[0].call("pagesInfo");
  pm.slides = info && info.slides ? info.slides : null;
  pm.extras = []; pm.swapFrom = null; pm.insertAt = null;
  for (const url of pm.thumbs.values()) URL.revokeObjectURL(url);
  pm.thumbs.clear();
  await pool.workers[0].call("extraClear").catch(() => {});
  const n = pmSlides() ? pm.slides.length : state.doc.pages.length;
  pm.items = Array.from({ length: n }, (_, i) => ({ from: 0, page: i }));
  $("#pagesTitle").textContent = t(pmSlides() ? "pages.titleSlides" : "pages.title");
  renderPagesGrid();
  openModal($("#pagesDialog"));
}

function renderPagesGrid() {
  const grid = $("#pagesGrid");
  grid.innerHTML = pm.items.map((it, i) => {
    const size = pmPageSize(it);
    let badge = "";
    if (it.from < 0) badge = t("pages.blankLabel");
    else if (it.from > 0) { const ex = pm.extras.find((e) => e.index === it.from); badge = `${ex ? ex.name : ""} · ${it.page + 1}`; }
    else if (it.page !== i) badge = t("pages.origin", { n: it.page + 1 });
    const btn = (act, key, label) => `<button type="button" data-act="${act}" title="${t(key)}" aria-label="${t(key)}">${label}</button>`;
    return `<div class="pg-card${pm.swapFrom === i ? " swap" : ""}" draggable="true" data-i="${i}">
      <div class="pg-thumb" style="aspect-ratio: ${size.width} / ${size.height}">${it.from < 0 ? `<span>${t("pages.blankLabel")}</span>` : '<img alt="">'}</div>
      <div class="pg-label"><b>${i + 1}</b><span class="pg-badge" title="${badge.replace(/"/g, "&quot;")}">${badge}</span></div>
      <div class="pg-btns">${btn("left", "pages.left", "‹")}${btn("right", "pages.right", "›")}${btn("swap", "pages.swap", "⇄")}${btn("blank", "pages.insertBlank", "+")}${btn("file", "pages.insertFile", "+⎙")}${btn("remove", "pages.remove", "✕")}</div>
    </div>`;
  }).join("");
  $("#pagesCount").textContent = pmUnit(pm.items.length);
  grid.querySelectorAll(".pg-card img").forEach((img) => loadThumb(img));
}

/** Thumbnails come from the workers (the open file) or from worker 0 (extra files). */
function loadThumb(img) {
  const card = img.closest(".pg-card"), it = pm.items[Number(card.dataset.i)];
  if (!it || it.from < 0) return;
  const key = `${it.from}:${it.page}`;
  const cached = pm.thumbs.get(key);
  if (cached) { img.src = cached; return; }
  const size = pmPageSize(it), zoom = Math.max(0.15, Math.min(1.5, 170 / size.width));
  const req = it.from === 0
    ? pool.leastBusy(null).call("render", { page: pmSlides() ? pm.slides[it.page] : it.page, zoom, variant: "original" })
    : pool.workers[0].call("extraRender", { index: it.from, page: it.page, zoom });
  req.then((buf) => {
    const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    pm.thumbs.set(key, url);
    const cur = $("#pagesGrid").querySelector(`.pg-card[data-i="${pm.items.indexOf(it)}"] img`);
    if (cur) cur.src = url;
  }).catch((err) => console.warn("thumbnail failed", err));
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
      const items = r.pages.map((_, p) => ({ from: r.index, page: p }));
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
  const plan = pm.items.map((it) => ({ from: it.from, page: it.page, w: it.w, h: it.h }));
  const n = pmSlides() ? pm.slides.length : state.doc.pages.length;
  if (plan.length === n && plan.every((p, i) => p.from === 0 && p.page === i)) { toast(t("pages.unchanged")); return; }
  const name = state.doc.name.replace(/\.ppt$/i, ".pptx");
  const kind = state.doc.kind;
  busy(t("pages.working"));
  try {
    const bytes = await pool.workers[0].call("rearrange", { plan });
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
    if (!b || !card) return;
    const i = Number(card.dataset.i), act = b.dataset.act;
    if (act === "left") pmMove(i, i - 1);
    else if (act === "right") pmMove(i, i + 1);
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
  });
  $("#pagesAddBlank").addEventListener("click", () => {
    const size = pm.items.length ? pmPageSize(pm.items[pm.items.length - 1]) : { width: 595, height: 842 };
    pm.items.push({ from: -1, w: size.width, h: size.height }); renderPagesGrid();
  });
  $("#pagesAddFile").addEventListener("click", () => { pm.insertAt = pm.items.length; $("#pagesFile").click(); });
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
