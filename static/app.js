"use strict";

const $ = (sel) => document.querySelector(sel);
const LS_LAST = "pdftr:last";
const lsKey = (id) => `pdftr:tr:${id}`;

const state = {
  doc: null,          // payload from /api/documents
  translations: {},   // id -> text
  variant: "original",
  zoom: 1,
  activeId: null,
  built: false,
  buildNo: 0,
  shrunk: new Set(),
};

/* ------------------------------------------------------------------ utils */

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 4500);
}

function busy(text) {
  $("#busyText").textContent = text || "";
  $("#busy").hidden = !text;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = (await res.json()).error || message; } catch (_) { /* not JSON */ }
    throw new Error(message);
  }
  return res;
}

function postJSON(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function filenameFrom(res, fallback) {
  const cd = res.headers.get("Content-Disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(lsKey(state.doc.id), JSON.stringify(state.translations)); } catch (_) { /* quota / private mode */ }
  }, 300);
}

const hasTr = (id) => Boolean((state.translations[id] || "").trim());

/* ------------------------------------------------------------- loading */

async function uploadPdf(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    toast("Please choose a PDF file.", "error");
    return;
  }
  $("#uploadProgress").hidden = false;
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await api("/api/documents", { method: "POST", body: form });
    openDocument(await res.json());
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#uploadProgress").hidden = true;
    $("#fileInput").value = "";
  }
}

function openDocument(doc) {
  state.doc = doc;
  state.variant = "original";
  state.activeId = null;
  state.built = doc.has_translated;
  state.buildNo = Date.now();
  state.shrunk = new Set();
  try {
    state.translations = JSON.parse(localStorage.getItem(lsKey(doc.id)) || "{}");
    localStorage.setItem(LS_LAST, doc.id);
  } catch (_) {
    state.translations = {};
  }
  $("#uploadView").hidden = true;
  $("#workView").hidden = false;
  $("#btnNew").hidden = false;
  $("#docName").textContent = doc.name;
  $("#docName").title = doc.name;
  document.title = `${doc.name} · PDF Translate`;

  const pageSel = $("#filterPage");
  pageSel.innerHTML = '<option value="all">All pages</option>' +
    doc.pages.map((_, i) => `<option value="${i}">Page ${i + 1}</option>`).join("");

  state.zoom = fitZoom();
  renderPages();
  renderSegments();
  setBuilt(state.built);
  setVariant("original");
  updateProgress();
  if (!doc.segments.length) {
    toast("No selectable text was found. Scanned PDFs need OCR before they can be translated.", "error");
  }
}

function closeDocument() {
  state.doc = null;
  try { localStorage.removeItem(LS_LAST); } catch (_) { /* ignore */ }
  $("#workView").hidden = true;
  $("#uploadView").hidden = false;
  $("#btnNew").hidden = true;
  $("#docName").textContent = "";
  document.title = "PDF Translate";
  updateSteps();
}

/* --------------------------------------------------------------- viewer */

function fitZoom() {
  const avail = $("#pages").clientWidth - 48;
  const widest = Math.max(...state.doc.pages.map((p) => p.width));
  const z = Math.floor((avail / (widest * 1.25)) * 10) / 10;
  return Math.min(1.5, Math.max(0.4, z || 1));
}

function pageCssWidth(page) {
  return Math.round(page.width * 1.25 * state.zoom);
}

function imageZoom(page) {
  const px = pageCssWidth(page) * (window.devicePixelRatio || 1);
  return Math.min(4, Math.max(0.5, Math.ceil((px / page.width) * 4) / 4));
}

function pageSrc(index) {
  const page = state.doc.pages[index];
  const z = imageZoom(page);
  const extra = state.variant === "translated" ? `&v=${state.buildNo}` : "";
  return `/api/documents/${state.doc.id}/pages/${index}.png?variant=${state.variant}&zoom=${z}${extra}`;
}

function renderPages() {
  const wrap = $("#pages");
  wrap.innerHTML = "";
  const byPage = new Map();
  for (const s of state.doc.segments) {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page).push(s);
  }
  state.doc.pages.forEach((page, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = i;
    el.style.width = `${pageCssWidth(page)}px`;
    el.style.aspectRatio = `${page.width} / ${page.height}`;
    el.innerHTML = `<span class="page-label">Page ${i + 1}</span>`;
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `Page ${i + 1}`;
    img.src = pageSrc(i);
    el.appendChild(img);
    for (const s of byPage.get(i) || []) {
      const box = document.createElement("div");
      box.className = "box" + (hasTr(s.id) ? " done" : "");
      box.dataset.id = s.id;
      const [x0, y0, x1, y1] = s.view;
      Object.assign(box.style, {
        left: `${x0 * 100}%`, top: `${y0 * 100}%`,
        width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%`,
      });
      box.title = `#${s.id}: ${s.text.slice(0, 120)}`;
      el.appendChild(box);
    }
    wrap.appendChild(el);
  });
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

function refreshImages() {
  document.querySelectorAll(".page").forEach((el) => {
    const i = Number(el.dataset.page);
    el.style.width = `${pageCssWidth(state.doc.pages[i])}px`;
    el.querySelector("img").src = pageSrc(i);
  });
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setVariant(variant) {
  state.variant = variant;
  $("#viewOriginal").classList.toggle("active", variant === "original");
  $("#viewTranslated").classList.toggle("active", variant === "translated");
  $("#pages").classList.toggle("translated", variant === "translated");
  refreshImages();
}

function setZoom(z) {
  const pages = $("#pages");
  const ratio = pages.scrollTop / Math.max(1, pages.scrollHeight);
  state.zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  refreshImages();
  pages.scrollTop = ratio * pages.scrollHeight;
}

/* -------------------------------------------------------------- editor */

function segMeta(s) {
  const style = [s.bold && "bold", s.italic && "italic"].filter(Boolean).join(" ");
  const rot = s.rotation ? ` · rotated ${s.rotation}°` : "";
  return `p.${s.page + 1} · ${s.size}pt${style ? " " + style : ""} · ${s.align}${rot}`;
}

function renderSegments() {
  const list = $("#segments");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const s of state.doc.segments) {
    const card = document.createElement("div");
    card.className = "seg" + (hasTr(s.id) ? " done" : "");
    card.dataset.id = s.id;
    card.dataset.page = s.page;
    card.innerHTML = `
      <div class="seg-head">
        <span class="seg-status"></span>
        <span class="seg-id">#${s.id}</span>
        <span class="seg-meta"></span>
        <button type="button" class="mini" data-act="copy" title="Copy source text">copy</button>
        <button type="button" class="mini" data-act="same" title="Keep the original text (use it as the translation)">keep</button>
      </div>
      <div class="seg-src"></div>
      <textarea rows="1" spellcheck="true" placeholder="Translation…"></textarea>`;
    card.querySelector(".seg-meta").textContent = segMeta(s);
    card.querySelector(".seg-src").textContent = s.text;
    const ta = card.querySelector("textarea");
    ta.value = state.translations[s.id] || "";
    frag.appendChild(card);
  }
  list.appendChild(frag);
  if (!state.doc.segments.length) {
    list.innerHTML = '<div class="empty">No text segments found in this PDF.</div>';
  }
  requestAnimationFrame(() => list.querySelectorAll("textarea").forEach(autoGrow));
  applyFilter();
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`;
}

function markDone(id) {
  const done = hasTr(id);
  document.querySelector(`.seg[data-id="${id}"]`)?.classList.toggle("done", done);
  document.querySelector(`.box[data-id="${id}"]`)?.classList.toggle("done", done);
}

function updateProgress() {
  const total = state.doc ? state.doc.segments.length : 0;
  const done = state.doc ? state.doc.segments.filter((s) => hasTr(s.id)).length : 0;
  $("#progressText").textContent = `${done} / ${total} translated`;
  $("#progressBar").style.width = total ? `${(done / total) * 100}%` : "0";
  updateSteps();
}

function updateSteps() {
  const steps = [...document.querySelectorAll("#steps li")];
  steps.forEach((li) => li.classList.remove("active", "done"));
  if (!state.doc) { steps[0].classList.add("active"); return; }
  const any = state.doc.segments.some((s) => hasTr(s.id));
  steps[0].classList.add("done");
  if (state.built) {
    steps[1].classList.add("done");
    steps[2].classList.add("done");
  } else {
    steps[1].classList.add(any ? "done" : "active");
    if (any) steps[2].classList.add("active");
  }
}

function applyFilter() {
  const q = $("#search").value.trim().toLowerCase();
  const status = $("#filterStatus").value;
  const page = $("#filterPage").value;
  let shown = 0;
  for (const card of document.querySelectorAll(".seg")) {
    const id = Number(card.dataset.id);
    const s = segById(id);
    let ok = page === "all" || String(s.page) === page;
    if (ok && status !== "all") ok = (status === "done") === hasTr(id);
    if (ok && q) ok = s.text.toLowerCase().includes(q) || (state.translations[id] || "").toLowerCase().includes(q);
    card.hidden = !ok;
    if (ok) shown++;
  }
  let empty = $("#segments .empty.filter");
  if (!shown && state.doc.segments.length) {
    if (!empty) {
      empty = Object.assign(document.createElement("div"), { className: "empty filter", textContent: "No segments match the filter." });
      $("#segments").appendChild(empty);
    }
  } else if (empty) empty.remove();
}

const segIndex = new Map();
function segById(id) {
  if (segIndex.get("doc") !== state.doc) {
    segIndex.clear();
    segIndex.set("doc", state.doc);
    for (const s of state.doc.segments) segIndex.set(s.id, s);
  }
  return segIndex.get(id);
}

function setActive(id, { scrollList = false, scrollViewer = false, focus = false } = {}) {
  document.querySelectorAll(".seg.active, .box.active").forEach((el) => el.classList.remove("active"));
  state.activeId = id;
  const card = document.querySelector(`.seg[data-id="${id}"]`);
  const box = document.querySelector(`.box[data-id="${id}"]`);
  card?.classList.add("active");
  box?.classList.add("active");
  if (scrollList && card) {
    if (card.hidden) { $("#search").value = ""; $("#filterStatus").value = "all"; $("#filterPage").value = "all"; applyFilter(); }
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (scrollViewer && box) box.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  if (focus && card) card.querySelector("textarea").focus({ preventScroll: true });
}

function setTranslation(id, value) {
  if (value && value.trim()) state.translations[id] = value;
  else delete state.translations[id];
  markDone(id);
  persist();
  updateProgress();
}

/* -------------------------------------------------------- export/import */

function markedText(useTranslations = false) {
  return state.doc.segments
    .map((s) => `[[${s.id}]]\n${(useTranslations && state.translations[s.id]) || s.text}\n`)
    .join("\n");
}

async function copyAll() {
  const text = markedText(false);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${state.doc.segments.length} segments. Paste them into your translator, keeping the [[n]] markers.`, "ok");
  } catch (_) {
    $("#pasteArea").value = text;
    $("#importDialog").showModal();
    $("#pasteArea").select();
    toast("Clipboard is not available. The text is selected below, so copy it with Ctrl+C.");
  }
}

async function doExport() {
  const format = document.querySelector('input[name="fmt"]:checked').value;
  const body = {
    format,
    include_translations: $("#includeTranslations").checked,
    translations: state.translations,
    source_lang: $("#srcLang").value.trim(),
    target_lang: $("#tgtLang").value.trim(),
  };
  try {
    const res = await postJSON(`/api/documents/${state.doc.id}/export`, body);
    saveBlob(await res.blob(), filenameFrom(res, `segments.${format}`));
  } catch (err) {
    toast(err.message, "error");
  }
}

function mergeImported(result) {
  const overwrite = $("#importOverwrite").checked;
  let applied = 0;
  for (const [id, text] of Object.entries(result.translations)) {
    if (!overwrite && hasTr(id)) continue;
    state.translations[id] = text;
    applied++;
  }
  persist();
  renderSegments();
  document.querySelectorAll(".box").forEach((b) => b.classList.toggle("done", hasTr(b.dataset.id)));
  updateProgress();
  let msg = `Imported ${applied} translation${applied === 1 ? "" : "s"}.`;
  if (result.unknown.length) msg += ` ${result.unknown.length} unknown marker(s) ignored.`;
  if (result.missing) msg += ` ${result.missing} segment(s) had no translation in the file.`;
  toast(msg, applied ? "ok" : "error");
  if (!applied && !result.matched) {
    toast("No [[n]] markers or segment ids were recognised. Keep the markers when translating.", "error");
  }
}

async function importFile(file) {
  if (!file) return;
  $("#importDialog").close();
  busy("Reading translation…");
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await api(`/api/documents/${state.doc.id}/import`, { method: "POST", body: form });
    mergeImported(await res.json());
  } catch (err) {
    toast(err.message, "error");
  } finally {
    busy("");
    $("#importFile").value = "";
  }
}

async function importPasted() {
  const text = $("#pasteArea").value;
  if (!text.trim()) { toast("Paste some translated text first.", "error"); return; }
  busy("Reading translation…");
  try {
    const res = await postJSON(`/api/documents/${state.doc.id}/import`, { text });
    mergeImported(await res.json());
    $("#pasteArea").value = "";
  } catch (err) {
    toast(err.message, "error");
  } finally {
    busy("");
  }
}

/* ---------------------------------------------------------------- build */

function setBuilt(built) {
  state.built = built;
  $("#viewTranslated").disabled = !built;
  const dl = $("#btnDownload");
  dl.hidden = !built;
  if (built) {
    dl.href = `/api/documents/${state.doc.id}/translated.pdf?v=${state.buildNo}`;
  }
  updateSteps();
}

async function doBuild() {
  const count = Object.keys(state.translations).filter(hasTr).length;
  if (!count) {
    toast("There are no translations yet. Type, paste or import some first.", "error");
    return;
  }
  busy(`Rebuilding PDF with ${count} translated segment${count === 1 ? "" : "s"}…`);
  try {
    const res = await postJSON(`/api/documents/${state.doc.id}/build`, {
      translations: state.translations,
      options: {
        font_mode: $("#fontMode").value,
        expand: $("#optExpand").checked,
        min_scale: Number($("#minScale").value),
      },
    });
    const stats = await res.json();
    state.buildNo = Date.now();
    state.shrunk = new Set(stats.shrunk.map((x) => x.id));
    document.querySelectorAll(".seg").forEach((c) => c.classList.toggle("shrunk", state.shrunk.has(Number(c.dataset.id))));
    setBuilt(true);
    setVariant("translated");
    const kb = Math.round(stats.bytes / 1024);
    let msg = `Done: ${stats.replaced} segments replaced in ${stats.seconds}s (${kb} KB).`;
    if (stats.shrunk.length) msg += ` ${stats.shrunk.length} had their text reduced to fit.`;
    toast(msg, "ok");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    busy("");
  }
}

async function uploadFont(file) {
  if (!file) return;
  $("#fontStatus").textContent = "Uploading…";
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await api(`/api/documents/${state.doc.id}/font`, { method: "POST", body: form });
    const data = await res.json();
    $("#fontStatus").textContent = `Using ${data.name}`;
    state.doc.has_font = true;
  } catch (err) {
    $("#fontStatus").textContent = err.message;
    toast(err.message, "error");
  }
}

/* --------------------------------------------------------------- wiring */

function setupDropzone(zone, onFile) {
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.remove("over");
  }));
  zone.addEventListener("drop", (e) => onFile(e.dataTransfer.files[0]));
}

function init() {
  setupDropzone($("#dropzone"), uploadPdf);
  $("#fileInput").addEventListener("change", (e) => uploadPdf(e.target.files[0]));
  $("#btnNew").addEventListener("click", closeDocument);

  // Dropping a PDF anywhere on the workspace opens it.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.pdf$/i.test(file.name) && !document.querySelector("dialog[open]")) uploadPdf(file);
  });

  // Viewer
  $("#viewOriginal").addEventListener("click", () => setVariant("original"));
  $("#viewTranslated").addEventListener("click", () => setVariant("translated"));
  $("#zoomIn").addEventListener("click", () => setZoom(state.zoom + 0.2));
  $("#zoomOut").addEventListener("click", () => setZoom(state.zoom - 0.2));
  $("#showBoxes").addEventListener("change", (e) => $("#pages").classList.toggle("no-boxes", !e.target.checked));
  $("#pages").addEventListener("click", (e) => {
    const box = e.target.closest(".box");
    if (box) setActive(Number(box.dataset.id), { scrollList: true, focus: true });
  });

  // Editor
  const list = $("#segments");
  list.addEventListener("input", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    const id = Number(e.target.closest(".seg").dataset.id);
    setTranslation(id, e.target.value);
    autoGrow(e.target);
  });
  list.addEventListener("focusin", (e) => {
    const card = e.target.closest(".seg");
    if (card && Number(card.dataset.id) !== state.activeId) setActive(Number(card.dataset.id), { scrollViewer: true });
  });
  list.addEventListener("click", (e) => {
    const card = e.target.closest(".seg");
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = e.target.dataset.act;
    if (act === "copy") {
      navigator.clipboard?.writeText(segById(id).text).then(() => toast("Source text copied."));
    } else if (act === "same") {
      const ta = card.querySelector("textarea");
      ta.value = segById(id).text;
      setTranslation(id, ta.value);
      autoGrow(ta);
    } else if (e.target.classList.contains("seg-src")) {
      setActive(id, { scrollViewer: true, focus: true });
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    // Ctrl/Cmd+Enter or Alt+Down: next segment, Alt+Up: previous segment
    const down = (e.key === "Enter" && (e.ctrlKey || e.metaKey)) || (e.altKey && e.key === "ArrowDown");
    const up = e.altKey && e.key === "ArrowUp";
    if (!down && !up) return;
    e.preventDefault();
    const cards = [...list.querySelectorAll(".seg:not([hidden])")];
    const i = cards.indexOf(e.target.closest(".seg"));
    const next = cards[i + (down ? 1 : -1)];
    if (next) {
      next.querySelector("textarea").focus();
      next.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  $("#search").addEventListener("input", applyFilter);
  $("#filterStatus").addEventListener("change", applyFilter);
  $("#filterPage").addEventListener("change", (e) => {
    applyFilter();
    if (e.target.value !== "all") document.querySelector(`.page[data-page="${e.target.value}"]`)?.scrollIntoView({ behavior: "smooth" });
  });

  // Export
  $("#btnExport").addEventListener("click", () => $("#exportDialog").showModal());
  $("#exportDialog").addEventListener("close", () => {
    if ($("#exportDialog").returnValue === "ok") doExport();
  });
  document.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener("change", () => {
    $("#langRow").style.opacity = r.value === "xliff" && r.checked ? "1" : "";
  }));
  $("#btnCopy").addEventListener("click", copyAll);

  // Import
  $("#btnImport").addEventListener("click", () => $("#importDialog").showModal());
  setupDropzone($("#importDrop"), importFile);
  $("#importFile").addEventListener("change", (e) => importFile(e.target.files[0]));
  $("#importDialog").addEventListener("close", () => {
    if ($("#importDialog").returnValue === "ok") importPasted();
  });

  // Build
  $("#btnBuild").addEventListener("click", () => {
    $("#fontUploadRow").hidden = $("#fontMode").value !== "custom";
    $("#buildDialog").showModal();
  });
  $("#fontMode").addEventListener("change", (e) => {
    $("#fontUploadRow").hidden = e.target.value !== "custom";
    if (e.target.value === "custom" && state.doc.has_font) $("#fontStatus").textContent = "A font is already uploaded. Choose another file to replace it.";
  });
  $("#fontFile").addEventListener("change", (e) => uploadFont(e.target.files[0]));
  $("#buildDialog").addEventListener("close", () => {
    if ($("#buildDialog").returnValue === "ok") doBuild();
  });

  // Restore the last document after a reload.
  let last = null;
  try { last = localStorage.getItem(LS_LAST); } catch (_) { /* ignore */ }
  if (last) {
    api(`/api/documents/${last}`).then((r) => r.json()).then(openDocument).catch(() => {
      try { localStorage.removeItem(LS_LAST); } catch (_) { /* ignore */ }
      updateSteps();
    });
  } else {
    updateSteps();
  }
}

init();
