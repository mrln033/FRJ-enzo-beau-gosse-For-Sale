(function initMarkupImportPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const sendButton = document.getElementById("sendButton");
  const csvInput = document.getElementById("csvInput");

  document.getElementById("btnMU").classList.add("active");
  document.getElementById("subtitle").innerText += " — GAS + D1";
  sendButton.addEventListener("click", sendData);

  async function sendData() {
    const csv = csvInput.value;

    if (!csv.trim()) {
      alert("Vide !");
      return;
    }

    sendButton.disabled = true;
    sendButton.innerText = "Envoi en cours...";

    try {
      const outcome = await global.FRJ_API.importToBoth("?type=mu", {
        method: "POST",
        body: csv
      }, {
        dataset: "mu"
      });
      alert(global.FRJ_IMPORTS.formatOutcome(outcome));
      if (outcome.ok) csvInput.value = "";
    } catch (error) {
      alert(`❌ ${error}`);
    } finally {
      sendButton.disabled = false;
      sendButton.innerText = "Envoi";
    }
  }
})(window);
