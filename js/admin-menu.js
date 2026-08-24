(function initAdminMenu(global) {
  "use strict";

  if (global.FRJ_ADMIN?.active !== true) return;

  const params = new URLSearchParams(global.location.search);

  const items = [
    { section: "catalog", backend: "gas", label: "Catalogue (GAS)", href: "./?backend=gas" },
    { section: "catalog", backend: "d1", label: "Catalogue (D1)", href: "./?backend=d1" },
    {
      section: "update",
      backend: "",
      label: "MàJ Inventaire / MU (GAS + D1)",
      href: "maj_inventaire-enzo.html"
    },
    { section: "containers", backend: "", label: "Conteneurs D1", href: "conteneurs.html" },
    { section: "report", backend: "", label: "Rapport de synchronisation", href: "rapport-sync.html" },
    { section: "orders", backend: "", label: "Demandes d'achat", href: "commandes.html" }
  ];

  function render() {
    if (document.querySelector(".admin-menu-drawer")) return;
    const pathname = global.location.pathname.toLowerCase();
    const section = pathname.includes("commandes")
      ? "orders"
      : pathname.includes("conteneurs")
      ? "containers"
      : pathname.includes("rapport-sync")
      ? "report"
      : (pathname.includes("maj_") ? "update" : "catalog");
    const backend = params.get("backend") === "d1" ? "d1" : "gas";
    const drawer = document.createElement("div");
    drawer.className = "admin-menu-drawer";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "admin-menu-toggle";
    toggle.setAttribute("aria-controls", "adminMenuPanel");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Afficher le menu administrateur");
    toggle.title = "Afficher le menu administrateur";

    const toggleIcon = document.createElement("span");
    toggleIcon.className = "admin-menu-toggle-icon";
    toggleIcon.setAttribute("aria-hidden", "true");
    toggleIcon.textContent = "\u25be";
    toggle.appendChild(toggleIcon);

    const nav = document.createElement("nav");
    nav.id = "adminMenuPanel";
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

    drawer.appendChild(toggle);
    drawer.appendChild(nav);
    document.body.insertBefore(drawer, document.body.firstChild);

    let pinned = false;
    let hovered = false;
    let focused = false;

    function updateDrawer() {
      const open = pinned || hovered || focused;
      drawer.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute(
        "aria-label",
        open ? "Masquer le menu administrateur" : "Afficher le menu administrateur"
      );
      toggle.title = open ? "Masquer le menu administrateur" : "Afficher le menu administrateur";
    }

    drawer.addEventListener("mouseenter", () => {
      hovered = true;
      updateDrawer();
    });

    drawer.addEventListener("mouseleave", () => {
      hovered = false;
      updateDrawer();
    });

    drawer.addEventListener("focusin", () => {
      focused = true;
      updateDrawer();
    });

    drawer.addEventListener("focusout", () => {
      global.setTimeout(() => {
        focused = drawer.contains(document.activeElement);
        updateDrawer();
      }, 0);
    });

    toggle.addEventListener("click", () => {
      pinned = !pinned;
      updateDrawer();
    });

    document.addEventListener("click", (event) => {
      if (pinned && !drawer.contains(event.target)) {
        pinned = false;
        updateDrawer();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && (pinned || hovered || focused)) {
        pinned = false;
        hovered = false;
        focused = false;
        updateDrawer();
        toggle.focus();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})(window);
