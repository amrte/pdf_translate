// Start-up (runs after ui.js, markup.js and tools.js have defined everything).
initTheme(); // the colour of this start, before anything is drawn
initThemeMode();
document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
document.addEventListener("languagechange", onLanguageChange);
initMarkup();
initTools();
initPicture();
initOffline();
initPagesManager();
init();
