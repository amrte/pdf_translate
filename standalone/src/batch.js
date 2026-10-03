/* ---------------------------------------------------------------- batch: several files at once
 * Files added to the batch are read by a worker of their own (the open document keeps the pool):
 * their translatable segments are stored, so one prompt covers all files, part by part, with
 * markers numbered across the files. The answers pasted here are sorted back into each file's
 * translations (the same storage the editor uses), so a file opened from the batch is translated
 * already and only needs its build and download. The list lives in localStorage, the files and
 * their segments in IndexedDB.
 */
const LS_BATCH = "pdftr:batch";
const bt = { list: [], segs: new Map(), worker: null, busy: false, copied: new Set(), status: "" };

function batchRead() { try { bt.list = JSON.parse(localStorage.getItem(LS_BATCH) || "[]"); } catch (_) { bt.list = []; } if (!Array.isArray(bt.list)) bt.list = []; }
function batchWrite() { try { localStorage.setItem(LS_BATCH, JSON.stringify(bt.list)); } catch (_) { /* storage blocked */ } batchRefreshButton(); }

/** The translations stored for a file (the editor's own key), as {id: text}. */
function batchTranslations(id) { try { return JSON.parse(localStorage.getItem(lsKey(id)) || "{}"); } catch (_) { return {}; } }
function batchDoneCount(f, segs) {
  const tr = state.doc && state.doc.id === f.id ? state.translations : batchTranslations(f.id);
  return segs.filter((s) => (tr[s.id] || "").trim()).length;
}
async function batchSegs(id) {
  if (!bt.segs.has(id)) bt.segs.set(id, (await idbGet(`batchsegs:${id}`)) || []);
  return bt.segs.get(id);
}

/** A worker for the batch alone, started when the first file is read. */
async function batchWorker() {
  if (bt.worker && !bt.worker.dead) return bt.worker;
  await pool.start();
  const w = pool.local ? new LocalWorker() : new RemoteWorker(WORKER_URL);
  w.onDeadBatch = true;
  await w.call("init", { mupdfUrl: (pool.libs && pool.libs.mupdfUrl) || null });
  bt.worker = w;
  return w;
}

/** Add files: each is stored, read and its segments kept. */
async function batchAdd(files) {
  const list = [...files].filter((f) => /\.(pdf|epub|fb2|fbz|zip|docx|pptx|xlsx|doc|xls|ppt|srt|vtt|md|markdown|txt|text)$/i.test(f.name));
  if (!list.length) { toast(t("batch.noFiles"), "error"); return; }
  openModal($("#batchDialog"));
  for (const file of list) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await sha256(bytes);
    if (bt.list.some((f) => f.id === id)) continue; // (the same file twice)
    const entry = { id, name: file.name, size: bytes.length, kind: Engine.detectKind(bytes, file.name), total: 0, maxId: 0, state: "reading", added: Date.now() };
    bt.list.push(entry);
    batchWrite();
    batchRender();
    await idbPut({ name: file.name, bytes, id }, `batch:${id}`);
    try {
      const segs = await batchExtract(entry, bytes);
      await idbPut(segs, `batchsegs:${id}`);
      bt.segs.set(id, segs);
      entry.total = segs.length;
      entry.maxId = segs.reduce((m, s) => Math.max(m, s.id), 0);
      entry.state = segs.length ? "ready" : "empty";
    } catch (err) {
      console.error(err);
      entry.state = "failed";
      entry.error = userError(err);
    }
    delete entry.progress;
    batchWrite();
    batchRender();
  }
}

/** The translatable segments of a file, read the way the editor reads them. */
async function batchExtract(entry, bytes) {
  const w = await batchWorker();
  let kind = entry.kind;
  if (kind === "image") throw new Error(t("batch.imageSkipped"));
  if (LEGACY_KINDS.has(kind)) { const c = await w.call("convert", { bytes, kind }); bytes = c.bytes; kind = c.kind; entry.kind = kind; }
  if (kind === "pdf") {
    const u = await w.call("unlock", { bytes, password: "" });
    if (u.status === "unlocked") bytes = u.bytes;
    else if (u.status !== "plain") throw new Error(t("batch.protected"));
  }
  const pageCount = await w.call("open", { bytes, kind });
  let segments;
  if (kind === "pdf") {
    const raw = [];
    const size = 8;
    for (let p = 0; p < pageCount; p += size) {
      const pages = Array.from({ length: Math.min(size, pageCount - p) }, (_, i) => p + i);
      const r = await w.call("extract", { pages });
      raw.push(...r.segments);
      entry.progress = t("batch.reading", { i: Math.min(p + size, pageCount), n: pageCount });
      batchRender();
    }
    raw.sort((a, b) => a.page - b.page || a.id - b.id);
    raw.forEach((s, i) => { s.id = i + 1; });
    segments = raw;
  } else {
    segments = (await w.call("extractBook")).segments;
  }
  entry.pages = pageCount;
  return segments.filter((s) => !s.skip && !s.hiddenSlide && !s.notes).map((s) => ({ id: s.id, text: s.text }));
}

async function batchRemove(id) {
  bt.list = bt.list.filter((f) => f.id !== id);
  bt.segs.delete(id);
  bt.copied.clear();
  batchWrite();
  await idbDel(`batch:${id}`); await idbDel(`batchsegs:${id}`);
  batchRender();
}

async function batchOpen(id) {
  const saved = await idbGet(`batch:${id}`);
  if (!saved || !saved.bytes) { toast(t("recent.gone"), "error"); return; }
  $("#batchDialog").close();
  if (state.doc) closeFind();
  await loadBytes(saved.bytes, saved.name, true, saved.id);
}

/** The next file that still has work: untranslated segments first, then not yet downloaded. */
async function batchNext() {
  const current = state.doc ? state.doc.id : null;
  const order = [...bt.list];
  const i = order.findIndex((f) => f.id === current);
  if (i >= 0) order.push(...order.splice(0, i + 1)); // start after the open file
  for (const f of order) {
    if (f.id === current || f.state !== "ready") continue;
    const segs = await batchSegs(f.id);
    if (!f.done || batchDoneCount(f, segs) < segs.length) { await batchOpen(f.id); return; }
  }
  toast(t("batch.allDone"), "ok");
}

/* ---- the prompt: parts of one file each, markers numbered across the files */
function batchOffsets() {
  const off = new Map();
  let n = 0;
  for (const f of bt.list) { off.set(f.id, n); n += f.maxId || 0; }
  return off;
}
async function batchParts() {
  const size = Math.max(20, Number($("#batchPartSize").value) || 500);
  const off = batchOffsets(), parts = [];
  for (const f of bt.list) {
    if (f.state !== "ready") continue;
    const segs = await batchSegs(f.id);
    const todo = $("#batchOnlyTodo").checked ? (() => { const tr = state.doc && state.doc.id === f.id ? state.translations : batchTranslations(f.id); return segs.filter((s) => !(tr[s.id] || "").trim()); })() : segs;
    for (let i = 0; i < todo.length; i += size) parts.push({ file: f, offset: off.get(f.id), segs: todo.slice(i, i + size) });
  }
  return parts;
}
function batchPromptText(part, k, total) {
  const P = AI_PROMPT[LANG] || AI_PROMPT.en;
  const target = $("#batchTarget").value.trim() || P.target;
  const context = $("#batchContext").value.trim();
  const glossary = $("#aiGlossary") ? $("#aiGlossary").value.trim() : "";
  const kind = part.file.kind;
  const rules = ["docx", "pptx", "xlsx"].includes(kind) ? P.officeRules : ["epub", "fb2", "srt", "vtt", "md", "txt"].includes(kind) ? P.bookRules : P.rules;
  const a = part.segs[0].id + part.offset, b = part.segs[part.segs.length - 1].id + part.offset;
  const lines = [P.intro(target), "", ...rules];
  if (context) lines.push("", P.context(context.replace(/\.$/, "")));
  if (glossary) lines.push("", P.glossary, ...glossary.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`));
  if (total > 1) lines.push("", P.part(k, total, a, b));
  lines.push("", P.segments, "", Engine.exportTxt(part.segs.map((s) => ({ id: s.id + part.offset, text: s.text }))));
  return lines.join("\n");
}
async function batchCopyPart(i) {
  const parts = await batchParts();
  const p = parts[i];
  if (!p) return;
  await copyText(batchPromptText(p, i + 1, parts.length), t("batch.partCopied", { k: i + 1, total: parts.length, n: p.segs.length, file: p.file.name }));
  bt.copied.add(i);
  batchRender();
}

/* ---- the answers: sorted back into the files */
async function batchImportText(text) {
  if (!text.trim()) { toast(t("msg.pasteFirst"), "error"); return; }
  const parsed = Engine.parseMarkedText(text);
  const ids = Object.keys(parsed).map(Number);
  const off = batchOffsets(), overwrite = $("#batchOverwrite").checked;
  let applied = 0, unknown = 0;
  const files = new Set();
  const perFile = new Map();
  for (const f of bt.list) perFile.set(f.id, { f, from: off.get(f.id) + 1, to: off.get(f.id) + (f.maxId || 0), rows: {} });
  for (const id of ids) {
    const slot = [...perFile.values()].find((p) => id >= p.from && id <= p.to);
    if (!slot) { unknown++; continue; }
    slot.rows[id - off.get(slot.f.id)] = parsed[id];
  }
  for (const { f, rows } of perFile.values()) {
    const n = Object.keys(rows).length;
    if (!n) continue;
    files.add(f.id);
    if (state.doc && state.doc.id === f.id) { applied += mergeImported(rows, overwrite) || 0; continue; }
    const tr = batchTranslations(f.id);
    for (const [id, v] of Object.entries(rows)) { if (!overwrite && (tr[id] || "").trim()) continue; tr[id] = v; applied++; }
    try { localStorage.setItem(lsKey(f.id), JSON.stringify(tr)); } catch (_) { toast(t("msg.storageFull"), "error"); }
  }
  let msg = t("batch.imported", { n: applied, files: files.size });
  if (unknown) msg += t("msg.unknownMarkers", { n: unknown });
  bt.status = msg;
  toast(msg, applied ? "ok" : "error");
  if (!ids.length) toast(t("msg.noMarkers"), "error");
  batchRender();
}
async function batchImportFile(file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = /\.txt$/i.test(file.name) ? new TextDecoder().decode(bytes) : Engine.exportTxt(Object.entries(await Engine.parseImport(file.name, bytes)).map(([id, text]) => ({ id, text })));
    await batchImportText(text);
  } catch (err) {
    toast(t("msg.readFailed", { file: file.name, err: err.message }), "error");
  } finally {
    $("#batchImportFile").value = "";
  }
}

/* ---- the dialog */
function batchRefreshButton() {
  const b = $("#btnBatch");
  if (!b) return;
  b.hidden = !bt.list.length && !$("#uploadView").hidden ? false : !bt.list.length; // on the start screen always, later while the batch has files
  b.querySelector(".kw-count").textContent = bt.list.length ? String(bt.list.length) : "";
}
async function batchRender() {
  const dlg = $("#batchDialog");
  if (!dlg.open) { batchRefreshButton(); return; }
  const list = $("#batchList");
  const rows = [];
  let totalSegs = 0, totalDone = 0;
  for (const f of bt.list) {
    const segs = f.state === "ready" ? await batchSegs(f.id) : [];
    const done = segs.length ? batchDoneCount(f, segs) : 0;
    totalSegs += segs.length; totalDone += done;
    const open = state.doc && state.doc.id === f.id;
    const status = f.state === "reading" ? `<span class="batch-chip busy">${escapeHtml(f.progress || t("batch.readingFile"))}</span>`
      : f.state === "failed" ? `<span class="batch-chip bad" title="${escapeHtml(f.error || "")}">${escapeHtml(t("batch.failed"))}</span>`
      : f.state === "empty" ? `<span class="batch-chip bad">${escapeHtml(t("batch.empty"))}</span>`
      : `<span class="batch-chip${done === segs.length ? " ok" : ""}">${escapeHtml(t("batch.progress", { done, n: segs.length }))}</span>${f.done ? `<span class="batch-chip ok">${escapeHtml(t("batch.downloaded"))}</span>` : ""}`;
    rows.push(`<div class="batch-row${open ? " open" : ""}" data-id="${f.id}">
      <div class="batch-name"><b>${escapeHtml(f.name)}</b> <span class="muted small">${escapeHtml(FORMAT_LABEL[f.kind] || f.kind.toUpperCase())}${f.pages ? ` · ${escapeHtml(t("batch.pages", { n: f.pages }))}` : ""}</span></div>
      <div class="batch-status">${status}${open ? `<span class="batch-chip open">${escapeHtml(t("batch.open"))}</span>` : ""}</div>
      <div class="batch-btns">
        <button type="button" class="btn" data-act="open"${f.state === "reading" ? " disabled" : ""}>${escapeHtml(t("batch.openBtn"))}</button>
        <button type="button" class="mini" data-act="del" title="${escapeHtml(t("batch.remove"))}" aria-label="${escapeHtml(t("batch.remove"))}">✕</button>
      </div>
    </div>`);
  }
  list.innerHTML = rows.join("") || `<p class="muted small">${escapeHtml(t("batch.none"))}</p>`;
  $("#batchSummary").textContent = bt.list.length ? t("batch.summary", { files: bt.list.length, done: totalDone, n: totalSegs }) : "";
  const parts = await batchParts();
  $("#batchParts").innerHTML = parts.map((p, i) => {
    const a = p.segs[0].id + p.offset, b = p.segs[p.segs.length - 1].id + p.offset;
    const cls = bt.copied.has(i) ? " copied" : i === 0 || bt.copied.has(i - 1) ? " primary" : "";
    return `<button type="button" class="btn${cls}" data-part="${i}">${bt.copied.has(i) ? "✓ " : ""}${escapeHtml(t("batch.partBtn", { k: i + 1, total: parts.length, file: p.file.name, a, b, n: p.segs.length }))}</button>`;
  }).join("") || `<p class="muted small">${escapeHtml(t("batch.noParts"))}</p>`;
  $("#batchImportStatus").textContent = bt.status;
  $("#batchClear").disabled = !bt.list.length;
  $("#batchNext").disabled = !bt.list.some((f) => f.state === "ready");
  batchRefreshButton();
}
function openBatchDialog() {
  if (!$("#batchTarget").value.trim()) $("#batchTarget").value = ($("#aiTarget") && $("#aiTarget").value.trim()) || "";
  if (!$("#batchContext").value.trim()) $("#batchContext").value = ($("#aiContext") && $("#aiContext").value.trim()) || "";
  openModal($("#batchDialog"));
  batchRender();
}

function initBatch() {
  batchRead();
  batchRefreshButton();
  $("#btnBatch").addEventListener("click", openBatchDialog);
  $("#batchAdd").addEventListener("click", () => $("#batchFile").click());
  $("#batchFile").addEventListener("change", (e) => { batchAdd(e.target.files); e.target.value = ""; });
  setupDropzone($("#batchDrop"), (file, files) => batchAdd(files || [file]));
  $("#batchList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.closest(".batch-row").dataset.id;
    if (b.dataset.act === "open") batchOpen(id);
    else if (b.dataset.act === "del") batchRemove(id);
  });
  $("#batchClear").addEventListener("click", async () => {
    if (!confirm(t("batch.clearConfirm", { n: bt.list.length }))) return;
    for (const f of [...bt.list]) await batchRemove(f.id);
  });
  $("#batchParts").addEventListener("click", (e) => { const b = e.target.closest("[data-part]"); if (b) batchCopyPart(Number(b.dataset.part)); });
  for (const id of ["#batchPartSize", "#batchOnlyTodo"]) $(id).addEventListener("input", () => { bt.copied.clear(); batchRender(); });
  $("#batchImportGo").addEventListener("click", async () => { await batchImportText($("#batchPaste").value); $("#batchPaste").value = ""; });
  $("#batchPaste").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#batchImportGo").click(); } });
  setupDropzone($("#batchImportDrop"), batchImportFile);
  $("#batchImportFile").addEventListener("change", (e) => batchImportFile(e.target.files[0]));
  $("#batchNext").addEventListener("click", batchNext);
  $("#batchDialog").addEventListener("close", () => { bt.status = ""; });
  // A download of the open document marks its batch entry as done.
  $("#btnDownload").addEventListener("click", () => {
    if (!state.doc) return;
    const f = bt.list.find((x) => x.id === state.doc.id);
    if (f && !f.done) { f.done = true; batchWrite(); }
  });
  document.addEventListener("kameleon:document", batchRefreshButton);
}
