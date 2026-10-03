// Start-up (runs after ui.js, markup.js and tools.js have defined everything).
initTheme(); // the colour of this start, before anything is drawn
initEgg();
initThemeMode();
document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
document.addEventListener("languagechange", onLanguageChange);
initMarkup();
initTools();
initPicture();
initReading();
initSegEdit();
initVocab();
initOffline();
initPagesManager();
initKeywords();
initWords();
initBatch();
init();
