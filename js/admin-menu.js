(function initAdminMenu(global) {
  "use strict";

  const params = new URLSearchParams(global.location.search);
  if (params.get("admin") !== "1") return;

  const items = [
    { section: "catalog", backend: "gas", label: "Catalogue (GAS)", href: "./?admin=1&backend=gas" },
    { section: "catalog", backend: "d1", label: "Catalogue (D1)", href: "./?admin=1&backend=d1" },
    {
      section: "update",
      backend: "gas",
      label: "MàJ Inventaire / MU (GAS)",
      href: "maj_inventaire-enzo.html?admin=1&backend=gas&avatar=enzo"
    },
    {
      section: "update",
      backend: "d1",
      label: "MàJ Inventaire / MU (D1)",
      href: "maj_inventaire-enzo.html?admin=1&backend=d1&avatar=enzo"
    },
    { section: "report", backend: "", label: "Rapport de synchronisation", href: "rapport-sync.html?admin=1" }
  ];

  function render() {
    if (document.querySelector(".admin-menu")) return;
    const pathname = global.location.pathname.toLowerCase();
    const section = pathname.includes("rapport-sync")
      ? "report"
      : (pathname.includes("maj_") ? "update" : "catalog");
    const backend = params.get("backend") === "d1" ? "d1" : "gas";
    const nav = document.createElement("nav");
    nav.className = "admin-menu";
    nav.setAttribute("aria-label", "Navigation administrateur");

    items.forEach((item) => {
      const link = document.createElement("a");
      link.href = item.href;
      link.target = "_self";
      link.textContent = item.label;
      if (item.section === section && (!item.backend || item.backend === backend)) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
      nav.appendChild(link);
    });

    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})(window);
