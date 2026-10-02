/* ------------------------------------------------------------- the app's colour */
// Kameleon changes colour: at every start one of these accents is chosen at random. Each entry
// has the colour for the light theme and a lighter one for the dark theme (both checked for
// contrast). Rare ones have a `rate`: Black turns up once in about 500 starts, the Rainbow once
// in about 1000. A colour can be forced for a look with ?accent=Name or #accent=7 in the address.
const ACCENTS = [
  { name: "Forest", light: "#287130", dark: "#92d399" },
  { name: "Emerald", light: "#0f7a5a", dark: "#7de8c8" },
  { name: "Petrol", light: "#11627e", dark: "#7ecce7" },
  { name: "Ocean", light: "#1c5fa8", dark: "#81b0e4" },
  { name: "Royal", light: "#2a4fc2", dark: "#869cdf" },
  { name: "Indigo", light: "#4138a6", dark: "#9690d5" },
  { name: "Violet", light: "#6b2fa8", dark: "#b28cd9" },
  { name: "Plum", light: "#8a2e8e", dark: "#d38fd6" },
  { name: "Magenta", light: "#a8257a", dark: "#de87c0" },
  { name: "Raspberry", light: "#b4245b", dark: "#e085a8" },
  { name: "Crimson", light: "#b12a37", dark: "#dd8890" },
  { name: "Brick", light: "#b7401f", dark: "#e39782" },
  { name: "Rust", light: "#a7501a", dark: "#e5a780" },
  { name: "Copper", light: "#955a12", dark: "#e9b87c" },
  { name: "Bronze", light: "#7d6414", dark: "#e4cd81" },
  { name: "Lemon", light: "#6e6800", dark: "#fbf36a" },
  { name: "Mustard", light: "#806200", dark: "#fbd96a" },
  { name: "Saffron", light: "#a05a00", dark: "#fbbc6a" },
  { name: "Olive", light: "#5f6b14", dark: "#d5e283" },
  { name: "Moss", light: "#46741c", dark: "#b1dd88" },
  { name: "Pine", light: "#1f6b4a", dark: "#8dd8b7" },
  { name: "Chocolate", light: "#6b4327", dark: "#d3ad92" },
  { name: "Burgundy", light: "#7a1f3d", dark: "#db8aa5" },
  { name: "Black", light: "#111111", dark: "#e4e4e4", rate: 500 },
  { name: "Rainbow", light: "#6a3fa0", dark: "#b28cd9", rate: 1000, rainbow: true },
];

/** One accent for this start: the rare ones by their rate, else one of the ordinary ones. */
function pickAccent() {
  let r = Math.random();
  for (const [i, a] of ACCENTS.entries()) {
    if (!a.rate) continue;
    if (r < 1 / a.rate) return i;
    r -= 1 / a.rate;
  }
  const ordinary = ACCENTS.map((a, i) => (a.rate ? -1 : i)).filter((i) => i >= 0);
  return ordinary[Math.floor(Math.random() * ordinary.length)];
}

const RAINBOW_STOPS = ["#c1121f", "#e36414", "#c99a06", "#2d8f4e", "#1e6fb8", "#6a3fa0"];

function applyAccent(i) {
  const a = ACCENTS[((i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
  const root = document.documentElement;
  root.style.setProperty("--accent-base", a.light);
  root.style.setProperty("--accent-dark-base", a.dark);
  root.dataset.accent = a.name;
  // the favicon is the icon with the colour swapped in (the rainbow: a gradient)
  const link = document.querySelector('link[rel="icon"]');
  if (link) {
    if (!link.dataset.template) link.dataset.template = link.href;
    let href = link.dataset.template;
    if (a.rainbow) {
      const defs = encodeURIComponent(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${RAINBOW_STOPS.map((c, k) => `<stop offset="${k / (RAINBOW_STOPS.length - 1)}" stop-color="${c}"/>`).join("")}</linearGradient></defs>`);
      const open = href.indexOf("%3E", href.indexOf("%3Csvg")) + 3; // after the <svg …> tag
      href = href.slice(0, open) + defs + href.slice(open).split("%23287130").join("url(%23g)");
    } else href = href.split("%23287130").join(encodeURIComponent(a.light));
    link.href = href;
  }
  return a;
}

// (for tests and the console)
window.Kameleon = Object.assign(window.Kameleon || {}, { ACCENTS, pickAccent, applyAccent });

function initTheme() {
  const m = /[?#&]accent=([^&#]+)/.exec(location.href);
  let i = -1;
  if (m) {
    const v = decodeURIComponent(m[1]);
    i = /^\d+$/.test(v) ? Number(v) - 1 : ACCENTS.findIndex((a) => a.name.toLowerCase() === v.toLowerCase());
  }
  if (i < 0) i = pickAccent();
  applyAccent(i);
}
