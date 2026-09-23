(function redirectShortTrackingLink(global) {
  "use strict";

  let reference = "";
  try {
    reference = decodeURIComponent(global.location.hash.slice(1)).trim().toUpperCase();
  } catch {
    reference = "";
  }

  const status = global.document.getElementById("shortTrackingStatus");
  if (!/^FRJ-\d{8}-[A-F0-9]{6}$/.test(reference)) {
    status.textContent = "Lien de suivi invalide ou incomplet.";
    return;
  }

  const destination = new URL("./suivi-commande.html", global.location.href);
  destination.searchParams.set("ref", reference);
  const backend = new URLSearchParams(global.location.search).get("backend");
  if (backend === "gas" || backend === "d1") destination.searchParams.set("backend", backend);
  global.location.replace(destination.toString());
})(window);
