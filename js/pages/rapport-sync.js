(function initSyncReportPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const AUTO_REFRESH_DELAY = 5 * 60 * 1000;
  const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Europe/Paris"
  });
  let autoRefreshTimer = null;
  let lastReportLoadAt = 0;

  document.getElementById("refreshReport").addEventListener("click", () => {
    loadSyncReport().finally(scheduleAutoRefresh);
  });
  document.getElementById("clearReportToken").addEventListener("click", () => {
    global.FRJ_API.clearAdminToken();
    loadSyncReport().finally(scheduleAutoRefresh);
  });
  document.getElementById("auditNow").addEventListener("click", runAuditNow);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
  }

  function actionLabel(action) {
    const labels = {
      verified: "Identique — vérifié",
      reconciled: "Réconcilié",
      "snapshot-imported": "Snapshot enregistré",
      "sync-run-completed": "Synchronisation terminée",
      "sync-run-failed": "Échec de synchronisation",
      "gas-state-observed": "État GAS observé",
      "manual-audit-requested": "Audit immédiat demandé",
      "manual-audit-completed": "Audit immédiat terminé",
      "manual-audit-failed": "Échec de l’audit immédiat",
      "integrity-audit-completed": "Audit d’intégrité terminé"
    };
    return labels[action] || action || "—";
  }

  function datasetLabel(dataset) {
    const labels = {
      catalog: "Catalogue",
      mu: "MU",
      containers: "Configuration des conteneurs",
      discounts: "Promotions et soldes",
      "discount-config": "Configuration des promotions",
      "inventory:enzo": "Inventaire Enzo",
      "inventory:arkaman": "Inventaire ArkaMan",
      "inventory:kenza": "Inventaire Kenza",
      "inventory:nocturnal": "Inventaire Nocturnal"
    };
    return labels[dataset] || dataset;
  }

  function concordanceLabel(status) {
    const labels = {
      verified: "Identique — vérifié",
      "pending-audit": "Identique — audit attendu",
      different: "Différent — synchronisation requise",
      "change-observed": "Modification GAS observée — synchronisation programmée",
      unknown: "État GAS non encore observé"
    };
    return labels[status] || status || "—";
  }

  function appendCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value;
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function appendHashCell(row, value, className = "") {
    const hash = String(value || "");
    const cell = document.createElement("td");
    cell.textContent = hash ? hash.slice(0, 12) : "—";
    cell.title = hash;
    cell.className = `hash-cell${className ? ` ${className}` : ""}`;
    row.appendChild(cell);
  }

  function renderSummary(report) {
    const summary = document.getElementById("syncSummary");
    summary.replaceChildren();
    const cards = [
      [
        "État global",
        report.status === "error"
          ? "Erreur"
          : (report.status === "pending" ? "En attente du prochain trigger" : "Opérationnel"),
        report.status
      ],
      ["Paires suivies", `${report.datasets.length} paires / ${report.datasets.length * 2} états`, ""],
      ["Dernière observation GAS", formatDate(report.lastGasRunAt), ""],
      ["Rapport généré", formatDate(report.generatedAt), ""]
    ];

    cards.forEach(([label, value, status]) => {
      const card = document.createElement("article");
      card.className = `summary-card${status ? ` ${status}` : ""}`;
      const title = document.createElement("span");
      title.textContent = label;
      const content = document.createElement("strong");
      content.textContent = value;
      card.append(title, content);
      summary.appendChild(card);
    });
  }

  function renderDatasets(datasets) {
    const body = document.getElementById("datasetRows");
    body.replaceChildren();
    datasets.forEach((dataset) => {
      const row = document.createElement("tr");
      appendCell(row, datasetLabel(dataset.dataset), "dataset-name");
      appendCell(row, dataset.gas ? String(dataset.gas.rowCount) : "—", "gas-cell");
      appendCell(row, formatDate(dataset.gas?.updatedAt), "gas-cell");
      appendHashCell(row, dataset.gas?.hash, "gas-cell");
      appendCell(row, dataset.d1 ? String(dataset.d1.rowCount) : "—", "d1-cell");
      appendCell(row, formatDate(dataset.d1?.updatedAt), "d1-cell");
      appendHashCell(row, dataset.d1?.hash, "d1-cell");
      appendCell(row, concordanceLabel(dataset.concordance), `status-${dataset.concordance}`);
      appendCell(row, formatDate(dataset.lastAudit?.createdAt));
      body.appendChild(row);
    });
  }

  function renderEvents(events) {
    const body = document.getElementById("eventRows");
    body.replaceChildren();
    events.forEach((event) => {
      const row = document.createElement("tr");
      appendCell(row, formatDate(event.createdAt));
      appendCell(row, event.dataset);
      appendCell(row, event.direction || "—");
      appendCell(row, actionLabel(event.action), event.action === "sync-run-failed" ? "status-error" : "");
      appendCell(row, event.details ? JSON.stringify(event.details) : "—", "event-details");
      body.appendChild(row);
    });
  }

  async function loadSyncReport() {
    lastReportLoadAt = Date.now();
    const loading = document.getElementById("reportLoading");
    const error = document.getElementById("reportError");
    const content = document.getElementById("reportContent");
    loading.hidden = false;
    error.hidden = true;

    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/sync-report?limit=100", {
        cache: "no-store"
      });
      const report = await response.json();
      // Le rapport est rendu avec textContent : les détails d'audit restent du texte, jamais du HTML injecté.
      renderSummary({ ...report, datasets: report.datasets || [] });
      renderDatasets(report.datasets || []);
      renderEvents(report.events || []);
      content.hidden = false;
    } catch (loadError) {
      content.hidden = true;
      error.textContent = loadError.message;
      error.hidden = false;
    } finally {
      loading.hidden = true;
    }
  }

  async function runAuditNow() {
    const button = document.getElementById("auditNow");
    const status = document.getElementById("auditNowStatus");
    button.disabled = true;
    button.textContent = "Audit en cours…";
    status.textContent = "Comparaison complète de GAS et D1…";

    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/sync-audit-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "audit-force-rapport" })
      });
      const result = await response.json();
      const changed = (result.summary || []).some((item) => item.action !== "identique");
      status.textContent = changed
        ? "Audit terminé : écarts corrigés, nouvel audit programmé à +30 min."
        : "Audit terminé : bases identiques et vérifiées.";
      await loadSyncReport();
    } catch (auditError) {
      status.textContent = `Échec : ${auditError.message}`;
    } finally {
      button.disabled = false;
      button.textContent = "Auditer maintenant";
      scheduleAutoRefresh();
    }
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) global.clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;

    // Aucun minuteur ne tourne en arrière-plan ; le retour sur l'onglet déclenche le rattrapage nécessaire.
    if (document.hidden) return;
    const elapsed = Date.now() - lastReportLoadAt;
    const delay = Math.max(0, AUTO_REFRESH_DELAY - elapsed);
    autoRefreshTimer = global.setTimeout(async () => {
      if (!document.hidden) await loadSyncReport();
      scheduleAutoRefresh();
    }, delay);
  }

  function handleVisibilityChange() {
    if (!document.hidden && Date.now() - lastReportLoadAt >= AUTO_REFRESH_DELAY) {
      loadSyncReport().finally(scheduleAutoRefresh);
    } else {
      scheduleAutoRefresh();
    }
  }

  loadSyncReport().finally(scheduleAutoRefresh);
})(window);
