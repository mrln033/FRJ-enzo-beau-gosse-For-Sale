(function renderCartHelp() {
  "use strict";

  const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
  if (requestedLanguage === "FR" || requestedLanguage === "EN") currentLang = requestedLanguage;

  document.documentElement.lang = currentLang.toLowerCase();
  document.title = t("cartHelpPageTitle");
  document.getElementById("cartHelpContent").innerHTML = t("cartHelpContent");
})();
