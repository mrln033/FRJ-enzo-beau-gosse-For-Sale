(function initImportFeedback(global) {
  "use strict";

  /**
   * Construit le message commun aux imports MU et inventaires.
   * Un succès partiel reste signalé comme exploitable : la synchronisation
   * se chargera de réparer le backend momentanément indisponible.
   */
  function formatOutcome(outcome) {
    const lines = outcome.results.map((result) => {
      const label = result.backend === "gas" ? "GAS" : "D1";
      const warning = result.warning ? `\n   ⚠️ ${result.warning}` : "";
      return `${result.ok ? "✅" : "❌"} ${label} : ${result.message}${warning}`;
    });

    if (outcome.partial) {
      lines.unshift("⚠️ Import partiel : la base disponible a été mise à jour.");
      lines.push("La synchronisation contrôlera et réparera l'autre base dès qu'elle sera accessible.");
    } else if (!outcome.ok) {
      lines.unshift("❌ L'import a échoué sur les deux bases. Le CSV est conservé.");
    }

    return lines.join("\n");
  }

  global.FRJ_IMPORTS = Object.freeze({ formatOutcome });
})(window);
