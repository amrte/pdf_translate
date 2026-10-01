// Start-up (runs after ui.js and markup.js have defined everything).
document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
document.addEventListener("languagechange", onLanguageChange);
initMarkup();
init();
