(function initInventoryImportPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const inventories = {
    enzo: { name: "enzo beau gosse", sheet: "Inventaire Enzo" },
    arkaman: { name: "FRJ enzo ArkaMan", sheet: "Inventaire ArkaMan" },
    kenza: { name: "kenza la belle", sheet: "Inventaire Kenza" },
    nocturnal: { name: "Nocturnal enzo FRJ", sheet: "Inventaire Nocturnal" }
  };
  const params = new URLSearchParams(global.location.search);
  const requestedAvatar = params.get("avatar");
  const csvInput = document.getElementById("csvInput");
  const sendButton = document.getElementById("sendButton");
  let avatar = Object.prototype.hasOwnProperty.call(inventories, requestedAvatar)
    ? requestedAvatar
    : null;
  let avatarConfig = avatar ? inventories[avatar] : null;

  sendButton.addEventListener("click", sendData);
  renderInventorySelection();

  async function sendData() {
    const csv = csvInput.value;

    if (!avatar || !avatarConfig) {
      alert("Choisis d'abord l'inventaire à mettre à jour.");
      return;
    }

    if (!csv.trim()) {
      alert("Vide !");
      return;
    }

    sendButton.disabled = true;
    sendButton.innerText = "Envoi en cours...";

    try {
      const cacheBust = Date.now();
      const outcome = await global.FRJ_API.importToBoth(
        `?type=inventory&avatar=${encodeURIComponent(avatar)}&_=${cacheBust}`,
        {
          method: "POST",
          cache: "no-store",
          body: csv
        },
        {
          dataset: `inventory:${avatar}`,
          beforeGas: async () => {
            // Ce contrôle protège contre une ancienne publication GAS qui viserait la mauvaise feuille.
            // Son échec ne bloque pas l'import D1, géré indépendamment par importToBoth.
            const targetResponse = await global.FRJ_API.fetchGas(
              `?action=inventoryTarget&avatar=${encodeURIComponent(avatar)}&_=${cacheBust}`,
              { cache: "no-store" }
            );
            const target = await targetResponse.json();
            if (target.avatar !== avatar || target.sheet !== avatarConfig.sheet) {
              throw new Error(`Le script Google Apps Script ne cible pas ${avatarConfig.sheet}.`);
            }
          }
        }
      );

      alert(global.FRJ_IMPORTS.formatOutcome(outcome));
      if (outcome.ok) {
        csvInput.value = "";
        resetInventorySelection();
      }
    } catch (error) {
      alert(`❌ ${error}`);
    } finally {
      sendButton.disabled = !avatar;
      sendButton.innerText = "Envoi";
    }
  }

  function renderInventorySelection() {
    document.querySelectorAll(".inventory-link").forEach((link) => link.classList.remove("active"));

    if (!avatar || !avatarConfig) {
      document.title = "MAJ Inventaire — choix requis";
      document.getElementById("title").innerText = "Choisis l'inventaire à mettre à jour";
      document.getElementById("subtitle").innerText = "Aucun inventaire sélectionné — GAS + D1";
      csvInput.placeholder = "Sélectionne d'abord l'un des quatre inventaires ci-dessus...";
      sendButton.disabled = true;
      return;
    }

    const avatarName = avatarConfig.name;
    document.title = `MAJ Inventaire ${avatarName}`;
    document.getElementById("title").innerText = `[${avatarName}] = A VENDRE`;
    document.getElementById("subtitle").innerText = `MAJ Inventaire ${avatarName} (Admin) — GAS + D1`;
    csvInput.placeholder = `Colle ici le CSV de l'inventaire de : [${avatarName}] uniquement, issu du site de MA, non groupé par container...`;
    document.getElementById(`btnINV-${avatar}`).classList.add("active");
    sendButton.disabled = false;
  }

  function resetInventorySelection() {
    avatar = null;
    avatarConfig = null;
    const url = new URL(global.location.href);
    url.searchParams.delete("avatar");
    global.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    renderInventorySelection();
  }
})(window);
