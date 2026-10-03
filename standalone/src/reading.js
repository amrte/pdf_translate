/* ------------------------------------------------------------- reading mode */
// Reading mode: the segment boxes stay out of sight, and a click on a text shows its translation
// in a bubble over the segment (on the translated view: the original text). Works wherever the
// pages carry boxes – PDFs, pictures, e-books, Office previews.

const LS_READING = "pdftr:reading";
const rd = { on: false, id: null, el: null };

function setReading(on) {
  rd.on = on;
  document.body.classList.toggle("reading", on);
  const btn = $("#btnReading");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  try { localStorage.setItem(LS_READING, on ? "1" : "0"); } catch (_) { /* storage blocked */ }
  if (!on) hideBubble();
}

/** A text as the reader sees it: formatting markers <1>…</1> gone, <2/> replaced by what it stands for. */
function readable(text, tags) {
  let out = text.replace(/<(\d+)\/>/g, (m, n) => (tags && tags[n] && tags[n].text) || "").replace(/<\/?\d+>/g, "");
  if (out.includes("‹")) out = out.replace(/‹(\/?\d+\/?)›/g, "<$1>"); // an escaped marker is text that really reads "<1>"
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** What the bubble says for a segment: its translation, or on the translated view its original. */
function bubbleContent(s) {
  if (state.variant === "translated") return { text: readable(s.text, s.tags), kind: "orig" };
  const tr = (state.translations[s.id] || "").trim();
  return tr ? { text: readable(tr, s.tags), kind: "tr" } : { text: t("read.none"), kind: "none" };
}

function hideBubble() {
  if (rd.el) rd.el.remove();
  document.querySelectorAll(".box.read").forEach((b) => b.classList.remove("read"));
  rd.el = null; rd.id = null;
}

/** The bubble over (or, near the top of the page, under) a segment's box. */
function showBubble(box) {
  const id = Number(box.dataset.id), s = segById(id);
  if (!s) return;
  if (rd.id === id && rd.el && rd.el.isConnected) { hideBubble(); return; } // the same text again: closes it
  hideBubble();
  const body = box.closest(".page-body") || box.parentElement;
  const { text, kind } = bubbleContent(s);
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.setAttribute("role", "status");
  const inner = document.createElement("div");
  inner.className = "bubble-text";
  inner.textContent = text;
  el.appendChild(inner);
  body.appendChild(el);
  const W = body.offsetWidth, H = body.offsetHeight;
  const bx = box.offsetLeft, by = box.offsetTop, bw = box.offsetWidth, bh = box.offsetHeight;
  const width = Math.min(W - 16, Math.max(Math.min(240, W - 16), bw * 1.15));
  el.style.width = `${Math.round(width)}px`;
  const left = Math.max(8, Math.min(W - width - 8, bx + bw / 2 - width / 2));
  el.style.left = `${Math.round(left)}px`;
  const h = el.offsetHeight;
  let top = by - h - 10, below = false;
  if (top < 4) { top = by + bh + 10; below = true; }
  if (top + h > H - 4) top = Math.max(4, H - h - 4);
  el.style.top = `${Math.round(top)}px`;
  el.classList.toggle("below", below);
  el.style.setProperty("--arrow-x", `${Math.round(Math.max(14, Math.min(width - 14, bx + bw / 2 - left)))}px`);
  rd.id = id; rd.el = el;
  box.classList.add("read");
}

function initReading() {
  $("#btnReading").addEventListener("click", () => setReading(!rd.on));
  let saved = false;
  try { saved = localStorage.getItem(LS_READING) === "1"; } catch (_) { /* storage blocked */ }
  if (saved) setReading(true);
  // Before the viewer's own click handling (which selects the segment): in reading mode a click
  // on a text opens its bubble and nothing else; a click elsewhere closes it.
  $("#pages").addEventListener("click", (e) => {
    if (!rd.on) return;
    const box = e.target.closest(".box");
    if (box) { e.stopPropagation(); e.preventDefault(); showBubble(box); }
    else if (!e.target.closest(".bubble")) hideBubble();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && rd.el) hideBubble(); });
}
