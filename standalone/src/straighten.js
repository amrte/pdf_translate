/* ---------------------------------------------------------------- straightening by hand
 * One editor for an opened picture (from the picture tools) and for a PDF page (from "Arrange
 * pages"): the page is shown large and can be turned by dragging it like a dial, turned so that a
 * line drawn along a text line or an edge becomes level (or upright), measured automatically, or
 * flattened from its four corners dragged onto the page's corners (a photographed page seen at a
 * slant). The angle is in degrees, clockwise; the corners are fractions of the straightened page.
 */
const st = { open: false, angle: 0, quad: null, mode: "turn", ratio: 1, onApply: null, measure: null, drag: null, line: null };

const ST_DEFAULT_QUAD = () => [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
const stRound = (a) => Math.round(Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, a)) * 10) / 10;

/**
 * Opens the editor. `image`: the page as a picture (Blob) and its size; `angle`/`quad`: the
 * current setting; `measure()`: the measured tilt ({angle, confidence}); `onApply(angle, quad)`.
 */
async function openStraighten({ image, width, height, angle = 0, quad = null, measure, onApply, title }) {
  st.angle = stRound(angle || 0);
  st.quad = quad ? quad.map((p) => p.slice()) : null;
  st.mode = st.quad ? "corners" : "turn";
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
  for (const m of ["turn", "line", "corners"]) {
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
  } else {
    st.drag = { kind: "turn", from: Math.atan2(y - h / 2, x - w / 2), angle: st.angle };
  }
  stSync();
}

function stPointerMove(e) {
  if (!st.drag) return;
  const stage = $("#stStage"), [x, y] = stPoint(e), w = stage.clientWidth, h = stage.clientHeight;
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

function stPointerUp() {
  if (!st.drag) return;
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
  for (const m of ["turn", "line", "corners"]) $(`#stMode_${m}`).addEventListener("click", () => {
    st.mode = m;
    if (m === "corners" && !st.quad) st.quad = ST_DEFAULT_QUAD();
    stSync();
  });
  $("#stCornersReset").addEventListener("click", () => { st.quad = null; if (st.mode === "corners") st.mode = "turn"; stSync(); });
  $("#stReset").addEventListener("click", () => { st.angle = 0; st.quad = null; st.mode = "turn"; stSync(); });
  $("#stApply").addEventListener("click", (e) => {
    e.preventDefault();
    const done = st.onApply;
    $("#straightDialog").close("ok");
    if (done) done(st.angle, st.quad);
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
