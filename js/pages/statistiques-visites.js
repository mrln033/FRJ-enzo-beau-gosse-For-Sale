(function initVisitStatisticsPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const PAGE_LABELS = Object.freeze({
    __TOTAL__: "Toutes les pages",
    catalog: "Catalogue",
    "cart-help": "Aide du panier",
    "order-tracking": "Suivi de demande",
    "admin-orders": "Demandes d'achat",
    "admin-containers": "Conteneurs D1",
    "admin-discounts": "Promotions et soldes",
    "sync-report": "Rapport de synchronisation",
    "inventory-import": "Mise à jour inventaire",
    "markup-import": "Mise à jour MU",
    "visit-statistics": "Statistiques des visites"
  });

  function toInputDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function setDefaultDates() {
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    document.getElementById("visitStartDate").value = toInputDate(start);
    document.getElementById("visitEndDate").value = toInputDate(end);
  }

  function number(value) {
    return Number(value || 0).toLocaleString("fr-FR");
  }

  function dateLabel(value) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString("fr-FR", { timeZone: "UTC" });
  }

  function appendCell(row, value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }

  function render(report) {
    const totals = report.totals || {};
    document.getElementById("visitPublicTotal").textContent = number(report.publicCounter?.visits);
    document.getElementById("visitPeriodVisits").textContent = number(totals.visits);
    document.getElementById("visitPageViews").textContent = number(totals.pageViews);
    document.getElementById("visitUniqueVisitors").textContent = number(totals.uniqueVisitors);

    const body = document.getElementById("visitStatisticsRows");
    const rows = report.rows || [];
    renderCategories(report);
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "visit-statistics-empty";
      cell.textContent = "Aucune visite sur cette période.";
      row.appendChild(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...rows.map((item) => {
      const row = document.createElement("tr");
      if (item.page === "__TOTAL__") row.className = "visit-statistics-total-row";
      appendCell(row, dateLabel(item.date));
      appendCell(row, PAGE_LABELS[item.page] || item.page);
      appendCell(row, item.audience === "PUBLIC" ? "Public" : "Administrateur");
      appendCell(row, number(item.pageViews));
      appendCell(row, number(item.visits));
      appendCell(row, number(item.uniqueVisitors));
      return row;
    }));
  }

  function renderCategories(report) {
    const panel = document.getElementById("visitCategoryPanel");
    const body = document.getElementById("visitCategoryRows");
    const selectedPage = report.filters?.page || "ALL";
    panel.hidden = selectedPage !== "ALL" && selectedPage !== "catalog";
    if (panel.hidden) return;
    const rows = report.categoryRows || [];
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "visit-statistics-empty";
      cell.textContent = "Aucune catégorie enregistrée sur cette période.";
      row.appendChild(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...rows.map((item, index) => {
      const row = document.createElement("tr");
      appendCell(row, number(index + 1));
      appendCell(row, item.category);
      appendCell(row, number(item.views));
      appendCell(row, number(item.visits));
      appendCell(row, number(item.uniqueVisitors));
      return row;
    }));
  }

  async function load() {
    const loading = document.getElementById("visitStatisticsLoading");
    const error = document.getElementById("visitStatisticsError");
    const content = document.getElementById("visitStatisticsContent");
    loading.hidden = false;
    error.hidden = true;
    try {
      const query = new URLSearchParams({
        startDate: document.getElementById("visitStartDate").value,
        endDate: document.getElementById("visitEndDate").value,
        audience: document.getElementById("visitAudience").value,
        page: document.getElementById("visitPage").value
      });
      const response = await global.FRJ_API.fetchD1Admin(`/admin/visit-statistics?${query}`, {
        cache: "no-store"
      });
      render(await response.json());
      content.hidden = false;
    } catch (loadError) {
      content.hidden = true;
      error.textContent = loadError.message;
      error.hidden = false;
    } finally {
      loading.hidden = true;
    }
  }

  document.getElementById("visitStatisticsFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    load();
  });
  document.getElementById("clearVisitStatsToken").addEventListener("click", () => {
    global.FRJ_API.clearAdminToken();
    global.location.reload();
  });
  setDefaultDates();
  load();
})(window);
