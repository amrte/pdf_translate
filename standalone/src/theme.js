/* ------------------------------------------------------------- the app's colour */
// Kameleon changes colour: at every start one of these accents is chosen at random. Each entry
// has the colour for the light theme and a lighter one for the dark theme (both checked for
// contrast). A colour can be forced for a look with ?accent=Name or #accent=7 in the address.
const ACCENTS = [
  { name: "Forest", light: "#287130", dark: "#92d399" },
  { name: "Emerald", light: "#0f7a5a", dark: "#7de8c8" },
  { name: "Teal", light: "#0e6f74", dark: "#7ce3e9" },
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
  { name: "Olive", light: "#5f6b14", dark: "#d5e283" },
  { name: "Moss", light: "#46741c", dark: "#b1dd88" },
  { name: "Pine", light: "#1f6b4a", dark: "#8dd8b7" },
  { name: "Slate", light: "#3f5b8a", dark: "#99accc" },
  { name: "Steel", light: "#4a6174", dark: "#a3b4c2" },
  { name: "Graphite", light: "#4b5351", dark: "#afb6b4" },
  { name: "Chocolate", light: "#6b4327", dark: "#d3ad92" },
  { name: "Burgundy", light: "#7a1f3d", dark: "#db8aa5" },
  { name: "Aubergine", light: "#5a2a6b", dark: "#c194d1" },
];

function applyAccent(i) {
  const a = ACCENTS[((i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
  const root = document.documentElement;
  root.style.setProperty("--accent-base", a.light);
  root.style.setProperty("--accent-dark-base", a.dark);
  root.dataset.accent = a.name;
  // the favicon is the icon with the colour swapped in
  const link = document.querySelector('link[rel="icon"]');
  if (link) {
    if (!link.dataset.template) link.dataset.template = link.href;
    link.href = link.dataset.template.split("%23287130").join(encodeURIComponent(a.light));
  }
  return a;
}

function initTheme() {
  const m = /[?#&]accent=([^&#]+)/.exec(location.href);
  let i = -1;
  if (m) {
    const v = decodeURIComponent(m[1]);
    i = /^\d+$/.test(v) ? Number(v) - 1 : ACCENTS.findIndex((a) => a.name.toLowerCase() === v.toLowerCase());
  }
  if (i < 0) i = Math.floor(Math.random() * ACCENTS.length);
  applyAccent(i);
}
