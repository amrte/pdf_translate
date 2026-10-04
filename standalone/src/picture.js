// ======================================================================
// Picture tools. For an opened picture the left rail gets a button that opens a small panel:
// brightness, contrast and greyscale (shown live in the preview), straightening (measured, or
// turned by hand in tenths of a degree), rotation in steps of 90° and a crop area dragged on the
// page. "Apply" renders the edited picture and opens it again, which
// starts the text recognition afresh (the recognised text of the old picture would not fit).
// ======================================================================

const PIC_DEFAULT = { bright: 100, contrast: 100, gray: false, rotate: 0, fine: 0, quad: null, crop: null }; // crop: page fractions [x0, y0, x1, y1]; fine: degrees, clockwise; quad: the page's corners (see straighten.js)
const picEdit = { ...PIC_DEFAULT };
let picCropMode = false;

const picFilter = () => `brightness(${picEdit.bright / 100}) contrast(${picEdit.contrast / 100})${picEdit.gray ? " grayscale(1)" : ""}`;
const picIsDefault = () => picEdit.bright === 100 && picEdit.contrast === 100 && !picEdit.gray && !picEdit.rotate && !picEdit.fine && !picEdit.quad && !picEdit.crop;

/** Show the edit state in the panel and in the preview. */
function picSync() {
  $("#picBright").value = picEdit.bright; $("#picBrightOut").textContent = `${picEdit.bright}%`;
  $("#picContrast").value = picEdit.contrast; $("#picContrastOut").textContent = `${picEdit.contrast}%`;
  $("#picGray").checked = picEdit.gray;
  $("#picRotOut").textContent = picEdit.rotate ? `${picEdit.rotate}°` : "";
  $("#picFine").value = picEdit.fine;
  $("#picFineOut").textContent = (picEdit.quad ? "▱ " : "") + (picEdit.fine ? pmDeg(picEdit.fine, true) : "");
  // (the straightening is shown live: the crop area is chosen on the straightened picture)
  document.documentElement.style.setProperty("--pic-turn", `${picEdit.fine}deg`);
  $("#picCropOut").textContent = picEdit.crop ? t("pic.cropSet") : "";
  $("#picCrop").classList.toggle("primary", picCropMode);
  $("#picHint").textContent = picCropMode ? t("pic.cropActive") : t("pic.hint");
  $("#picApply").disabled = picIsDefault();
  document.documentElement.style.setProperty("--pic-filter", picIsDefault() || picFilter() === "brightness(1) contrast(1)" ? "none" : picFilter());
  picDrawCrop();
}

/** The crop layer over the (single) page: catches the drag in crop mode and shows the chosen area. */
function picLayer(create) {
  const page = document.querySelector("#pages .page");
  if (!page) return null;
  let layer = page.querySelector(".pic-crop-layer");
  if (!layer && create) {
    layer = document.createElement("div");
    layer.className = "pic-crop-layer";
    page.append(layer);
  }
  return layer;
}

function picDrawCrop() {
  const layer = picLayer(picCropMode || Boolean(picEdit.crop));
  if (!layer) return;
  layer.classList.toggle("active", picCropMode);
  layer.style.pointerEvents = picCropMode ? "auto" : "none";
  let rect = layer.querySelector(".pic-crop-rect");
  if (!picEdit.crop) { rect && rect.remove(); if (!picCropMode) layer.remove(); return; }
  if (!rect) { rect = document.createElement("div"); rect.className = "pic-crop-rect"; layer.append(rect); }
  const [x0, y0, x1, y1] = picEdit.crop;
  Object.assign(rect.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
}

// (registered on the document in the capture phase: the markup tools catch pointer events on
// the pages before they reach the layer)
function picCropStart(e) {
  if (!picCropMode || e.button !== 0) return;
  const layer = e.target.closest && e.target.closest(".pic-crop-layer");
  if (!layer) return;
  const box = layer.getBoundingClientRect();
  const frac = (ev) => [Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height))];
  const start = frac(e);
  e.preventDefault(); e.stopPropagation();
  layer.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const [x, y] = frac(ev);
    picEdit.crop = [Math.min(start[0], x), Math.min(start[1], y), Math.max(start[0], x), Math.max(start[1], y)];
    picDrawCrop();
  };
  const up = (ev) => {
    layer.removeEventListener("pointermove", move); layer.removeEventListener("pointerup", up); layer.removeEventListener("pointercancel", up);
    move(ev);
    const c = picEdit.crop;
    if (!c || c[2] - c[0] < 0.02 || c[3] - c[1] < 0.02) picEdit.crop = null; // a click or a sliver: no crop
    picCropMode = false;
    picSync();
  };
  layer.addEventListener("pointermove", move); layer.addEventListener("pointerup", up); layer.addEventListener("pointercancel", up);
}

function picReset() {
  Object.assign(picEdit, PIC_DEFAULT);
  picCropMode = false;
  picSync();
}

function picOpenPanel(open) {
  $("#picPanel").hidden = !open;
  if (!open) { picCropMode = false; picSync(); }
}

/** Called when a document is opened or closed: the edits belong to one picture. */
function picDocumentChanged() {
  Object.assign(picEdit, PIC_DEFAULT);
  picCropMode = false;
  const panel = $("#picPanel");
  if (panel) { panel.hidden = true; picSync(); }
}

/** Brightness, contrast and greyscale on raw pixels (for browsers without canvas filters). */
function picFilterPixels(data) {
  const b = picEdit.bright / 100, c = picEdit.contrast / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * b, g = data[i + 1] * b, bl = data[i + 2] * b;
    r = (r - 128) * c + 128; g = (g - 128) * c + 128; bl = (bl - 128) * c + 128;
    if (picEdit.gray) { const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl; r = g = bl = y; }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r; data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; data[i + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
  }
}

/** Measures the picture's tilt and sets the straightening; true when there was one to set. */
async function picMeasure() {
  if (!state.doc || !state.doc.image) return false;
  busy(t("pic.measuring"));
  try {
    const r = await pool.workers[0].call("skewDetect", { page: 0 });
    if (!r || r.confidence < 0.15) { toast(t("pic.unclear"), "error"); return false; }
    picEdit.fine = Math.abs(r.angle) < 0.1 ? 0 : -Math.round(r.angle * 10) / 10;
    picSync();
    toast(picEdit.fine ? t("pic.measured", { deg: pmDeg(picEdit.fine, true) }) : t("pic.alreadyStraight"), "ok");
    return Boolean(picEdit.fine);
  } catch (err) {
    toast(t("pic.failed", { err: userError(err) }), "error");
    return false;
  } finally {
    busy("");
  }
}

/** The picture shown large: turned by hand, along a drawn line, or flattened from its corners. */
async function picHand() {
  const doc = state.doc;
  if (!doc || !doc.image) return;
  busy(t("pic.preparing"));
  try {
    const page = doc.pages[0], zoom = Math.min(4, 1800 / Math.max(page.width, page.height));
    const png = await pool.workers[0].call("render", { page: 0, zoom, variant: "original" });
    busy("");
    await openStraighten({
      image: new Blob([png], { type: "image/png" }), width: page.width, height: page.height,
      angle: picEdit.fine, quad: picEdit.quad, title: t("pic.handTitleShort"),
      measure: () => pool.workers[0].call("skewDetect", { page: 0 }),
      onApply: (angle, quad) => {
        picEdit.fine = angle; picEdit.quad = quad;
        if (quad) picEdit.crop = null; // (the corners take the place of a crop)
        picSync();
        if (!picIsDefault()) picApply();
      },
    });
  } catch (err) {
    toast(t("pic.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

/** Render the edited picture and open it as the document (same name, new content). */
async function picApply(quiet = false) {
  const doc = state.doc, img = doc && doc.image;
  if (!img || picIsDefault()) return;
  if (!quiet && doc.segments.length && !window.confirm(t("pic.confirm"))) return;
  busy(t("pic.working"));
  try {
    const page = doc.pages[0];
    const png = await pool.workers[0].call("render", { page: 0, zoom: img.width / page.width, variant: "original" });
    let bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
    try {
      if (picEdit.fine || picEdit.quad) {
        // Straightened (and flattened from its corners) first; a turn keeps the size, the corners
        // turned in are white.
        const src = new OffscreenCanvas(bmp.width, bmp.height), sx = src.getContext("2d", { willReadFrequently: true });
        sx.drawImage(bmp, 0, 0);
        const px = sx.getImageData(0, 0, bmp.width, bmp.height);
        const res = Engine.warpPixels(px.data, bmp.width, bmp.height, 4, { angle: picEdit.fine, quad: picEdit.quad });
        const st2 = new OffscreenCanvas(res.width, res.height);
        st2.getContext("2d").putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
        bmp.close && bmp.close();
        bmp = st2;
      }
      const c = (!picEdit.quad && picEdit.crop) || [0, 0, 1, 1];
      const sx = Math.round(c[0] * bmp.width), sy = Math.round(c[1] * bmp.height);
      const sw = Math.max(1, Math.round((c[2] - c[0]) * bmp.width)), sh = Math.max(1, Math.round((c[3] - c[1]) * bmp.height));
      const rot = ((picEdit.rotate % 360) + 360) % 360, swap = rot === 90 || rot === 270;
      const canvas = new OffscreenCanvas(swap ? sh : sw, swap ? sw : sh), ctx = canvas.getContext("2d");
      const hasFilter = "filter" in ctx;
      if (hasFilter) ctx.filter = picFilter();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(bmp, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
      if (!hasFilter) { ctx.setTransform(1, 0, 0, 1, 0, 0); const d = ctx.getImageData(0, 0, canvas.width, canvas.height); picFilterPixels(d.data); ctx.putImageData(d, 0, 0); }
      const blob = await canvas.convertToBlob(img.format === "jpeg" ? { type: "image/jpeg", quality: 0.95 } : { type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      picOpenPanel(false);
      await loadBytes(bytes, doc.name, true);
    } finally {
      bmp.close && bmp.close();
    }
  } catch (err) {
    console.error(err);
    toast(t("pic.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

function initPicture() {
  $("#btnPicture").addEventListener("click", () => picOpenPanel($("#picPanel").hidden));
  $("#picClose").addEventListener("click", () => picOpenPanel(false));
  $("#picBright").addEventListener("input", (e) => { picEdit.bright = Number(e.target.value); picSync(); });
  $("#picContrast").addEventListener("input", (e) => { picEdit.contrast = Number(e.target.value); picSync(); });
  $("#picGray").addEventListener("change", (e) => { picEdit.gray = e.target.checked; picSync(); });
  $("#picRotL").addEventListener("click", () => { picEdit.rotate = (picEdit.rotate + 270) % 360; picSync(); });
  $("#picRotR").addEventListener("click", () => { picEdit.rotate = (picEdit.rotate + 90) % 360; picSync(); });
  $("#picFine").addEventListener("input", (e) => { picEdit.fine = Math.round(Number(e.target.value) * 10) / 10; picSync(); });
  $("#picAuto").addEventListener("click", picMeasure);
  $("#picHand").addEventListener("click", picHand);
  $("#picCrop").addEventListener("click", () => { picCropMode = !picCropMode; if (picCropMode) picEdit.crop = null; picSync(); });
  $("#picReset").addEventListener("click", picReset);
  $("#picApply").addEventListener("click", picApply);
  document.addEventListener("pointerdown", picCropStart, true);
  // Zooming redraws the pages: put the crop layer back when it is needed.
  new MutationObserver(() => { if (document.body.classList.contains("is-image") && (picCropMode || picEdit.crop) && !picLayer(false)) picDrawCrop(); })
    .observe($("#pages"), { childList: true });
}
