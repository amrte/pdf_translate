/* ---------------------------------------------------------------- straightening by hand
 * One editor for an opened picture (from the picture tools) and for a PDF page (from "Arrange
 * pages"): the page is shown large and can be turned by dragging it like a dial, turned so that a
 * line drawn along a text line or an edge becomes level (or upright), measured automatically, or
 * flattened from its four corners dragged onto the page's corners (a photographed page seen at a
 * slant), and its text lines bent straight where the page is curved (a book photographed open):
 * found automatically, or traced by hand along a line. The angle is in degrees, clockwise; the
 * corners and the traced lines are fractions of the straightened page.
 */
const st = { open: false, angle: 0, quad: null, tracks: [], mode: "turn", ratio: 1, onApply: null, measure: null, drag: null, line: null, src: null, preview: false, previewTimer: 0 };
const ST_MODES = ["turn", "line", "corners", "lines"];

const ST_DEFAULT_QUAD = () => [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
const stRound = (a) => Math.round(Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, a)) * 10) / 10;

/**
 * Opens the editor. `image`: the page as a picture (Blob) and its size; `angle`/`quad`: the
 * current setting; `measure()`: the measured tilt ({angle, confidence}); `onApply(angle, quad)`.
 */
async function openStraighten({ image, width, height, angle = 0, quad = null, tracks = null, measure, onApply, title }) {
  st.angle = stRound(angle || 0);
  st.quad = quad ? quad.map((p) => p.slice()) : null;
  st.tracks = tracks ? tracks.map((t) => t.map((p) => p.slice())) : [];
  st.mode = st.tracks.length ? "lines" : st.quad ? "corners" : "turn";
  st.preview = false;
  st.src = null;
  // (the picture's pixels, for finding the lines and for the preview of the bending)
  createImageBitmap(image).then((bmp) => {
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    st.src = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  }).catch((err) => console.warn("straighten", err));
  st.ratio = width / height;
  st.onApply = onApply;
  st.measure = measure;
  st.line = null;
  const img = $("#stImg");
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(image);
  $("#stTitle").textContent = title || t("st2.title");
  openModal($("#straightDialog"));
  st.open = true;
  stLayout();
  stSync();
}

/** The stage as large as the dialog allows, in the page's proportions. */
function stLayout() {
  const box = $("#stArea"), stage = $("#stStage");
  const aw = box.clientWidth - 4, ah = Math.max(200, box.clientHeight - 4);
  let w = aw, h = w / st.ratio;
  if (h > ah) { h = ah; w = h * st.ratio; }
  stage.style.width = `${Math.round(w)}px`;
  stage.style.height = `${Math.round(h)}px`;
  $("#stSvg").setAttribute("viewBox", `0 0 ${Math.round(w)} ${Math.round(h)}`);
  stDraw();
}

function stSync() {
  $("#stAngle").value = String(st.angle);
  $("#stAngleOut").textContent = pmDeg(st.angle, true);
  $("#stImg").style.transform = `rotate(${st.angle}deg)`;
  // The bent result is shown while choosing the corners (they belong to it) or when asked for.
  const showBent = st.tracks.length > 0 && (st.preview || st.mode === "corners");
  $("#stPreview").hidden = !showBent;
  if (showBent) stQueuePreview();
  $("#stLinesTools").hidden = st.mode !== "lines";
  $("#stPreviewOn").checked = st.preview;
  $("#stLinesCount").textContent = st.tracks.length ? t("st2.linesCount", { n: st.tracks.length }) : "";
  for (const m of ST_MODES) {
    $(`#stMode_${m}`).classList.toggle("primary", st.mode === m);
    $("#straightDialog").classList.toggle(`mode-${m}`, st.mode === m);
  }
  $("#stHint").textContent = t(`st2.hint_${st.mode}`);
  $("#stCornersReset").hidden = !st.quad;
  stDraw();
}

/** Guides, the drawn line, and the page outline with its four handles. */
function stDraw() {
  const svg = $("#stSvg"), stage = $("#stStage");
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  let html = "";
  if (st.mode !== "corners") for (let k = 1; k < 10; k++) html += `<line class="st-guide" x1="0" y1="${(k * h) / 10}" x2="${w}" y2="${(k * h) / 10}"/>`;
  if (st.mode !== "corners") for (let k = 1; k < 6; k++) html += `<line class="st-guide" x1="${(k * w) / 6}" y1="0" x2="${(k * w) / 6}" y2="${h}"/>`;
  if (st.line) html += `<line class="st-line" x1="${st.line[0]}" y1="${st.line[1]}" x2="${st.line[2]}" y2="${st.line[3]}"/>`;
  // traced lines (on the picture before bending; hidden while the bent preview is shown)
  if (st.mode === "lines" && !st.preview) st.tracks.forEach((tr, k) => {
    html += `<polyline class="st-track" data-k="${k}" points="${tr.map(([x, y]) => `${x * w},${y * h}`).join(" ")}"/>`;
  });
  if (st.drag && st.drag.kind === "trace") html += `<polyline class="st-track new" points="${st.drag.pts.map((p) => p.join(",")).join(" ")}"/>`;
  if (st.quad) {
    const pts = st.quad.map(([x, y]) => [x * w, y * h]);
    const poly = pts.map((p) => p.join(",")).join(" ");
    html += `<path class="st-shade" fill-rule="evenodd" d="M0,0H${w}V${h}H0Z M${pts.map((p) => p.join(",")).join(" L")} Z"/>`;
    html += `<polygon class="st-quad" points="${poly}"/>`;
    if (st.mode === "corners") pts.forEach(([x, y], i) => { html += `<circle class="st-handle" data-k="${i}" cx="${x}" cy="${y}" r="9"/>`; });
  }
  svg.innerHTML = html;
}

/** The pointer in stage pixels. */
function stPoint(e) {
  const r = $("#stStage").getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function stPointerDown(e) {
  if (!st.open || e.button !== 0) return;
  const stage = $("#stStage"), [x, y] = stPoint(e), w = stage.clientWidth, h = stage.clientHeight;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  if (st.mode === "corners") {
    if (!st.quad) st.quad = ST_DEFAULT_QUAD();
    // the nearest corner follows the pointer
    let k = 0, best = Infinity;
    st.quad.forEach(([qx, qy], i) => { const d = Math.hypot(qx * w - x, qy * h - y); if (d < best) { best = d; k = i; } });
    st.drag = { kind: "corner", k };
    st.quad[k] = [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))];
  } else if (st.mode === "line") {
    st.drag = { kind: "line" };
    st.line = [x, y, x, y];
  } else if (st.mode === "lines") {
    if (st.preview) { st.preview = false; stSync(); }
    st.drag = { kind: "trace", pts: [[x, y]] };
  } else {
    st.drag = { kind: "turn", from: Math.atan2(y - h / 2, x - w / 2), angle: st.angle };
  }
  stSync();
}

function stPointerMove(e) {
  if (!st.drag) return;
  const stage = $("#stStage"), [x, y] = stPoint(e), w = stage.clientWidth, h = stage.clientHeight;
  if (st.drag.kind === "trace") {
    const last = st.drag.pts[st.drag.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 6) st.drag.pts.push([x, y]);
    stDraw();
    return;
  }
  if (st.drag.kind === "corner") st.quad[st.drag.k] = [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))];
  else if (st.drag.kind === "line") { st.line[2] = x; st.line[3] = y; } else {
    // like a dial: the page follows the pointer's angle around its middle
    const now = Math.atan2(y - h / 2, x - w / 2);
    let d = ((now - st.drag.from) * 180) / Math.PI;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    st.angle = stRound(st.drag.angle + d);
  }
  stSync();
}

function stPointerUp(e) {
  if (!st.drag) return;
  if (st.drag.kind === "trace") {
    const stage = $("#stStage"), w = stage.clientWidth, h = stage.clientHeight, pts = st.drag.pts;
    st.drag = null;
    const span = pts.length > 1 ? Math.abs(pts[pts.length - 1][0] - pts[0][0]) : 0;
    if (span > 30) {
      // a line traced along a text line (from either side)
      const tr = pts.map(([x, y]) => [Math.round((x / w) * 1e4) / 1e4, Math.round((y / h) * 1e4) / 1e4]).sort((a, b) => a[0] - b[0]);
      st.tracks.push(tr);
    } else if (pts.length) {
      // a click on a traced line removes it
      const [px, py] = pts[0];
      let best = -1, bestD = 8;
      st.tracks.forEach((tr, k) => {
        for (let i = 1; i < tr.length; i++) {
          const ax = tr[i - 1][0] * w, ay = tr[i - 1][1] * h, bx = tr[i][0] * w, by = tr[i][1] * h;
          const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, f = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2));
          const d = Math.hypot(px - (ax + f * (bx - ax)), py - (ay + f * (by - ay)));
          if (d < bestD) { bestD = d; best = k; }
        }
      });
      if (best >= 0) st.tracks.splice(best, 1);
    }
    stSync();
    return;
  }
  if (st.drag.kind === "line" && st.line) {
    const [x0, y0, x1, y1] = st.line;
    if (Math.hypot(x1 - x0, y1 - y0) > 12) {
      // The line drawn on the page as shown (already turned by st.angle) becomes level or upright.
      let a = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      while (a > 45) a -= 90;
      while (a < -45) a += 90;
      if (Math.abs(st.angle - a) > SKEW_LIMIT) toast(t("st2.tooSteep"), "error");
      else st.angle = stRound(st.angle - a);
    }
    st.line = null;
  }
  st.drag = null;
  stSync();
}

/** The picture as shown in the editor (turned by the angle), as grey pixels. */
function stTurnedGray() {
  const { data, w, h } = st.src;
  const res = Engine.warpPixels(data, w, h, 4, { angle: st.angle });
  const gray = new Uint8Array(res.width * res.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (res.data[i * 4] * 30 + res.data[i * 4 + 1] * 59 + res.data[i * 4 + 2] * 11) / 100;
  return { gray, w: res.width, h: res.height };
}

/** Finds the text lines (within the corners, when set) and traces them. */
async function stFindLines() {
  if (!st.src) { toast(t("pic.preparing")); return; }
  busy(t("st2.finding"));
  await new Promise((res) => setTimeout(res, 30));
  try {
    const { gray, w, h } = stTurnedGray();
    let region = null;
    if (st.quad) {
      const xs = st.quad.map((p) => p[0] * w), ys = st.quad.map((p) => p[1] * h);
      region = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(w, Math.max(...xs)), Math.min(h, Math.max(...ys))];
    }
    const found = Engine.findTextLines(gray, w, h, region);
    st.tracks = found.map((tr) => tr.map(([x, y]) => [Math.round((x / w) * 1e4) / 1e4, Math.round((y / h) * 1e4) / 1e4]));
    st.preview = false;
    toast(found.length ? t("st2.linesFound", { n: found.length }) : t("st2.noLines"), found.length ? "ok" : "error");
    stSync();
  } finally {
    busy("");
  }
}

/** The bent picture, shown instead of the original (computed shortly after a change). */
function stQueuePreview() {
  clearTimeout(st.previewTimer);
  st.previewTimer = setTimeout(() => {
    if (!st.src || !st.tracks.length) return;
    const { data, w, h } = st.src;
    const res = Engine.warpPixels(data, w, h, 4, { angle: st.angle, tracks: st.tracks });
    const c = document.createElement("canvas");
    c.width = res.width; c.height = res.height;
    c.getContext("2d").putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      const img = $("#stPreview");
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(b);
    }, "image/jpeg", 0.85);
  }, 120);
}

async function stAuto() {
  if (!st.measure) return;
  busy(t("pic.measuring"));
  try {
    const r = await st.measure();
    if (!r || r.confidence < 0.15) { toast(t("pic.unclear"), "error"); return; }
    st.angle = Math.abs(r.angle) < 0.1 ? 0 : stRound(-r.angle);
    toast(st.angle ? t("st2.measured", { deg: pmDeg(st.angle, true) }) : t("pic.alreadyStraight"), "ok");
    stSync();
  } catch (err) {
    toast(t("pic.failed", { err: userError(err) }), "error");
  } finally {
    busy("");
  }
}

function initStraighten() {
  const stage = $("#stStage");
  stage.addEventListener("pointerdown", stPointerDown);
  stage.addEventListener("pointermove", stPointerMove);
  stage.addEventListener("pointerup", stPointerUp);
  stage.addEventListener("pointercancel", stPointerUp);
  $("#stAngle").addEventListener("input", (e) => { st.angle = stRound(Number(e.target.value)); stSync(); });
  $("#stMinus").addEventListener("click", () => { st.angle = stRound(st.angle - 0.1); stSync(); });
  $("#stPlus").addEventListener("click", () => { st.angle = stRound(st.angle + 0.1); stSync(); });
  $("#stAuto").addEventListener("click", stAuto);
  $("#stFindLines").addEventListener("click", stFindLines);
  $("#stClearLines").addEventListener("click", () => { st.tracks = []; st.preview = false; stSync(); });
  $("#stPreviewOn").addEventListener("change", (e) => { st.preview = e.target.checked && st.tracks.length > 0; stSync(); });
  for (const m of ST_MODES) $(`#stMode_${m}`).addEventListener("click", () => {
    st.mode = m;
    if (m === "corners" && !st.quad) st.quad = ST_DEFAULT_QUAD();
    stSync();
  });
  $("#stCornersReset").addEventListener("click", () => { st.quad = null; if (st.mode === "corners") st.mode = "turn"; stSync(); });
  $("#stReset").addEventListener("click", () => { st.angle = 0; st.quad = null; st.tracks = []; st.preview = false; st.mode = "turn"; stSync(); });
  $("#stApply").addEventListener("click", (e) => {
    e.preventDefault();
    const done = st.onApply;
    $("#straightDialog").close("ok");
    if (done) done(st.angle, st.quad, st.tracks.length ? st.tracks : null);
  });
  $("#straightDialog").addEventListener("close", () => { st.open = false; st.drag = null; });
  window.addEventListener("resize", () => { if (st.open) stLayout(); });
  // Arrow keys turn by a tenth of a degree (Shift: a whole degree).
  $("#straightDialog").addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    st.angle = stRound(st.angle + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
    stSync();
  });
}
