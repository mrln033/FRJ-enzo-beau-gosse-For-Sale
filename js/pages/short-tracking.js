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
  destination.searchParams.set(
    "backend",
    new URLSearchParams(global.location.search).get("backend") === "gas" ? "gas" : "d1"
  );
  global.location.replace(destination.toString());
})(window);
