/* ---------------------------------------------------------------- the bookmark panel */
// A PDF's bookmarks (its outline) as a tree beside the page: a click goes to the place the
// bookmark points to, the chapter being read is marked while scrolling, branches fold. The titles
// are the original ones, or – on the translated view – their translations (bookmarks are
// segments of their own, `extra: "outline"`, `ref` their place in the outline).

const LS_OUTLINE = "pdftr:outline-open";
const ol = { items: [], doc: null, current: -1, folded: new Set(), jumped: null };

/** The open document's outline, from the engine ([{i, title, depth, page, y}]); the button shows when there is one. */
async function loadOutlinePanel() {
  const doc = state.doc;
  ol.items = []; ol.doc = doc; ol.current = -1; ol.folded = new Set();
  $("#btnOutline").hidden = true;
  $("#outlinePanel").hidden = true;
  if (!doc || isBook()) return;
  let items = [];
  try { items = (await pool.workers[0].call("outline")) || []; } catch (err) { console.warn("outline", err); }
  if (state.doc !== doc) return;
  ol.items = items;
  // (deeper levels start folded when the outline is long: the chapters first)
  if (items.length > 40) items.forEach((it, k) => { if (it.depth >= 1 && items[k + 1] && items[k + 1].depth > it.depth) ol.folded.add(it.i); });
  $("#btnOutline").hidden = !items.length;
  let open = false;
  try { open = localStorage.getItem(LS_OUTLINE) === "1"; } catch (_) { /* storage blocked */ }
  showOutline(open && items.length > 0, false);
}

function showOutline(on, remember = true) {
  if (on && !ol.items.length) on = false;
  $("#outlinePanel").hidden = !on;
  $("#btnOutline").classList.toggle("on", on);
  $("#btnOutline").setAttribute("aria-pressed", String(on));
  if (remember) { try { localStorage.setItem(LS_OUTLINE, on ? "1" : "0"); } catch (_) { /* storage blocked */ } }
  if (on) { renderOutline(); syncOutline(true); }
}

/** A bookmark's title as shown: its translation on the translated view, when it has one. */
function outlineTitle(it) {
  if (state.variant === "translated") {
    const s = state.doc.segments.find((x) => x.extra === "outline" && x.ref === it.i);
    const tr = s && (state.translations[s.id] || "").trim();
    if (tr) return tr;
  }
  return it.title || "–";
}

function renderOutline() {
  const box = $("#outlineTree");
  if (!box || $("#outlinePanel").hidden) return;
  const items = ol.items, out = [];
  // (a current bookmark inside a folded branch: the branch's visible entry is marked instead)
  let mark = ol.current;
  const ck = items.findIndex((it) => it.i === ol.current);
  if (ck >= 0) {
    let d = items[ck].depth;
    for (let j = ck - 1; j >= 0 && d > 0; j--) if (items[j].depth < d) { d = items[j].depth; if (ol.folded.has(items[j].i)) mark = items[j].i; }
  }
  let hideBelow = Infinity; // (the children of a folded entry)
  items.forEach((it, k) => {
    if (it.depth > hideBelow) return;
    hideBelow = Infinity;
    const kids = items[k + 1] && items[k + 1].depth > it.depth, folded = ol.folded.has(it.i);
    if (kids && folded) hideBelow = it.depth;
    const caret = kids ? `<button type="button" class="ol-caret${folded ? "" : " open"}" data-fold="${it.i}" aria-label="${escapeHtml(t(folded ? "outline.expand" : "outline.collapse"))}"><svg viewBox="0 0 10 10" width="9" height="9"><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : `<span class="ol-caret none"></span>`;
    const title = outlineTitle(it);
    out.push(`<div class="ol-item${it.i === mark ? " current" : ""}${it.depth ? "" : " top"}" data-i="${it.i}" style="--depth:${it.depth}" role="treeitem"${kids ? ` aria-expanded="${!folded}"` : ""}>${caret}<span class="ol-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="ol-page">${it.page >= 0 ? it.page + 1 : ""}</span></div>`);
  });
  box.innerHTML = out.join("");
}

/** Go to the place a bookmark points to: its page, and on it the height it names (when the page is upright). */
function goToBookmark(it) {
  if (!state.doc || it.page < 0) return;
  const el = pageElements()[it.page], box = $("#pages");
  if (!el) return;
  const page = viewPages()[it.page];
  let top = el.offsetTop - 22;
  if (it.y != null && isFinite(it.y) && page && !pageRotation(it.page)) {
    const f = Math.max(0, Math.min(1, (it.y - page.y0) / page.height));
    top = el.offsetTop + f * el.offsetHeight - 12;
  }
  box.scrollTop = Math.max(0, top);
  ol.current = it.i;
  ol.jumped = box.scrollTop; // (the bookmark clicked stays marked until the view is scrolled on)
  renderOutline();
  updatePageNav();
}

/** The bookmark of the place being read: the last one whose target lies above a line near the top of the view. */
function syncOutline(reveal = false) {
  if ($("#outlinePanel").hidden || !ol.items.length || !state.doc) return;
  const box = $("#pages");
  if (ol.jumped !== null) { if (Math.abs(box.scrollTop - ol.jumped) < 2) return; ol.jumped = null; }
  const yView = box.scrollTop + Math.min(120, box.clientHeight * 0.15), els = pageElements();
  let i = 0;
  for (let k = 0; k < els.length; k++) { if (els[k].offsetTop <= yView) i = k; else break; }
  const el = els[i], page = viewPages()[i];
  if (!el || !page) return;
  const at = i + Math.max(0, Math.min(0.999, (yView - el.offsetTop) / el.offsetHeight));
  let cur = -1;
  for (const it of ol.items) {
    if (it.page < 0) continue;
    const p = viewPages()[it.page];
    const pos = it.page + (it.y != null && isFinite(it.y) && p && !pageRotation(it.page) ? Math.max(0, Math.min(0.999, (it.y - p.y0) / p.height)) : 0);
    if (pos <= at + 1e-6) cur = it.i;
  }
  if (cur === ol.current && !reveal) return;
  ol.current = cur;
  // (a folded branch opens to show where one is)
  const k = ol.items.findIndex((it) => it.i === cur);
  if (k >= 0) {
    let d = ol.items[k].depth;
    for (let j = k - 1; j >= 0 && d > 0; j--) if (ol.items[j].depth < d) { if (reveal) ol.folded.delete(ol.items[j].i); d = ol.items[j].depth; }
  }
  renderOutline();
  const row = $("#outlineTree").querySelector(".ol-item.current");
  if (row) {
    const tree = $("#outlineTree"), r = row.offsetTop - tree.offsetTop;
    if (r < tree.scrollTop || r + row.offsetHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = r - tree.clientHeight / 3;
  }
}

(function initOutline() {
  if (!$("#outlinePanel")) return;
  $("#btnOutline").addEventListener("click", () => showOutline($("#outlinePanel").hidden));
  $("#outlineClose").addEventListener("click", () => showOutline(false));
  $("#outlineTree").addEventListener("click", (e) => {
    const fold = e.target.closest("[data-fold]");
    if (fold) {
      const i = Number(fold.dataset.fold);
      if (ol.folded.has(i)) ol.folded.delete(i); else ol.folded.add(i);
      renderOutline();
      return;
    }
    const row = e.target.closest(".ol-item");
    if (row) goToBookmark(ol.items.find((it) => it.i === Number(row.dataset.i)));
  });
  let raf = 0;
  $("#pages").addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; syncOutline(); }); }, { passive: true });
})();
