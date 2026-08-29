(function initOrderTrackingPage(global) {
  "use strict";

  const COPY = {
    FR: {
      title: "Suivi de votre demande", subtitle: "Ce lien est privé : conservez-le pour consulter l’avancement.",
      back: "Retour au catalogue", refresh: "Actualiser", copy: "Copier le lien", copied: "Lien copié",
      reference: "Référence", avatar: "Avatar", created: "Transmise le", updated: "Dernière mise à jour",
      item: "Article", quantity: "Qté", price: "Prix affiché", markup: "MU appliqué", estimate: "Estimation", salePrice: "Prix de vente",
      total: "Estimation totale", totalSale: "Prix de Vente total", member: "MU FRJ", public: "MU", pending: "à confirmer",
      proposal: "Enzo a modifié une ou plusieurs quantités ou MU. Vérifiez les nouvelles conditions affichées ci-dessous, puis acceptez-les pour retransmettre la demande.",
      accept: "Accepter les modifications", accepting: "Validation…",
      acceptError: "La validation a échoué. Actualisez la page et réessayez.",
      cancel: "Annuler la demande", cancelConfirm: "Confirmer l’annulation de cette demande ?",
      cancelling: "Annulation…", cancelError: "L’annulation a échoué. Actualisez la page et réessayez.",
      hide: "Masquer dans la liste", hidden: "Cette demande a été masquée de la liste de votre panier sur cette machine.",
      estimatedNote: "Prix indicatif, à confirmer avec Enzo. Le stock n’est pas réservé par cette demande.",
      confirmedNote: "Les prix de cette demande sont confirmés. Le stock n’est pas réservé par cette demande.",
      loading: "Actualisation…", missing: "Lien de suivi invalide ou incomplet.",
      gasPending: "Votre demande a été reçue par le secours GAS. Elle apparaîtra ici après son transfert automatique vers D1 (généralement sous cinq minutes).",
      notFound: "Cette demande est introuvable. Vérifiez que le lien est complet.",
      unavailable: "Le suivi est momentanément indisponible. Réessayez dans quelques minutes."
    },
    EN: {
      title: "Track your request", subtitle: "This link is private: keep it to check progress.",
      back: "Back to catalogue", refresh: "Refresh", copy: "Copy link", copied: "Link copied",
      reference: "Reference", avatar: "Avatar", created: "Submitted", updated: "Last update",
      item: "Item", quantity: "Qty", price: "Displayed price", markup: "Applied MU", estimate: "Estimate", salePrice: "Sale price",
      total: "Total estimate", totalSale: "Total sale price", member: "FRJ MU", public: "MU", pending: "to confirm",
      proposal: "Enzo changed one or more quantities or MUs. Review the new terms below, then accept them to resubmit the request.",
      accept: "Accept changes", accepting: "Accepting…",
      acceptError: "Acceptance failed. Refresh the page and try again.",
      cancel: "Cancel request", cancelConfirm: "Confirm cancellation of this request?",
      cancelling: "Cancelling…", cancelError: "Cancellation failed. Refresh the page and try again.",
      hide: "Hide from list", hidden: "This request has been hidden from your cart list on this device.",
      estimatedNote: "Indicative price, to be confirmed with Enzo. Stock is not reserved by this request.",
      confirmedNote: "The prices in this request are confirmed. Stock is not reserved by this request.",
      loading: "Refreshing…", missing: "Invalid or incomplete tracking link.",
      gasPending: "Your request was received by the GAS fallback. It will appear here after its automatic transfer to D1 (usually within five minutes).",
      notFound: "This request could not be found. Check that the link is complete.",
      unavailable: "Tracking is temporarily unavailable. Try again in a few minutes."
    }
  };
  const REQUESTS_KEY = "FRJ_PURCHASE_REQUESTS_V1";
  const HIDDEN_REQUESTS_KEY = "FRJ_HIDDEN_PURCHASE_REQUESTS_V1";
  const searchParams = new URLSearchParams(global.location.search);
  const token = searchParams.get("token") || "";
  const catalogBackend = searchParams.get("backend") === "d1" ? "d1" : "gas";
  const ui = global.FRJ_ORDER_UI;
  let lang = global.localStorage.getItem("lang") === "FR" ? "FR" : "EN";
  let refreshing = false;

  document.getElementById("catalogReturnLink").href = `./?backend=${catalogBackend}`;

  function text(key) {
    return COPY[lang][key] || key;
  }

  function applyLanguage() {
    document.documentElement.lang = lang.toLowerCase();
    document.title = `[FRJ] — ${text("title")}`;
    document.getElementById("pageTitle").textContent = text("title");
    document.getElementById("pageSubtitle").textContent = text("subtitle");
    document.getElementById("catalogLink").textContent = text("back");
  }

  function isPendingGasRequest() {
    try {
      const last = JSON.parse(global.localStorage.getItem("FRJ_LAST_PURCHASE_REQUEST") || "null");
      const requests = JSON.parse(global.localStorage.getItem(REQUESTS_KEY) || "[]");
      return (last?.backend === "gas" && last?.accessToken === token)
        || (Array.isArray(requests)
          && requests.some((request) => request?.backend === "gas" && request?.accessToken === token));
    } catch {
      return false;
    }
  }

  function rememberOrder(order) {
    try {
      const hiddenTokens = readHiddenTokens().filter((hiddenToken) => hiddenToken !== token);
      if (hiddenTokens.length) {
        global.localStorage.setItem(HIDDEN_REQUESTS_KEY, JSON.stringify(hiddenTokens));
      } else {
        global.localStorage.removeItem(HIDDEN_REQUESTS_KEY);
      }
      const stored = JSON.parse(global.localStorage.getItem(REQUESTS_KEY) || "[]");
      const requests = Array.isArray(stored) ? stored : [];
      const current = {
        reference: String(order.publicReference || ""),
        accessToken: token,
        backend: "d1",
        submittedAt: String(order.createdAt || ""),
        updatedAt: String(order.updatedAt || ""),
        status: String(order.status || "submitted")
      };
      const currentReference = current.reference.trim().toLocaleUpperCase("en-US");
      global.localStorage.setItem(REQUESTS_KEY, JSON.stringify([
        current,
        ...requests.filter((request) => {
          if (request?.accessToken === token) return false;
          const reference = String(request?.reference || "").trim().toLocaleUpperCase("en-US");
          return !currentReference || reference !== currentReference;
        })
      ]));
      global.localStorage.setItem("FRJ_LAST_PURCHASE_REQUEST", JSON.stringify(current));
    } catch {
      // Le suivi reste utilisable même si le stockage local est bloqué.
    }
  }

  function readHiddenTokens() {
    try {
      const stored = JSON.parse(global.localStorage.getItem(HIDDEN_REQUESTS_KEY) || "[]");
      return Array.isArray(stored) ? stored.map(String) : [];
    } catch {
      return [];
    }
  }

  function rememberHiddenToken() {
    const tokens = [...new Set([...readHiddenTokens(), token])].slice(-100);
    global.localStorage.setItem(HIDDEN_REQUESTS_KEY, JSON.stringify(tokens));
  }

  function showMessage(message, type = "") {
    const content = document.getElementById("trackingContent");
    content.className = `tracking-message${type ? ` ${type}` : ""}`;
    content.textContent = message;
  }

  async function loadOrder() {
    if (refreshing) return;
    if (!/^[a-f0-9-]{70,80}$/i.test(token)) {
      applyLanguage();
      showMessage(text("missing"), "error");
      return;
    }

    refreshing = true;
    showMessage(text("loading"));
    try {
      const order = await global.FRJ_API.getOrderStatus(token);
      lang = order.language === "FR" ? "FR" : "EN";
      global.localStorage.setItem("lang", lang);
      applyLanguage();
      rememberOrder(order);
      renderOrder(order);
    } catch (error) {
      applyLanguage();
      if (error.status === 404 && isPendingGasRequest()) showMessage(text("gasPending"));
      else if (error.status === 404) showMessage(text("notFound"), "error");
      else showMessage(text("unavailable"), "error");
    } finally {
      refreshing = false;
    }
  }

  function renderOrder(order) {
    const content = document.getElementById("trackingContent");
    content.className = "tracking-body";
    content.replaceChildren();

    const statusRow = document.createElement("div");
    statusRow.className = "tracking-status-row";
    const status = document.createElement("span");
    status.className = `tracking-status ${order.status}`;
    status.textContent = ui.statusLabel(order.status, lang);
    const pricingStatus = order.pricingStatus || "estimated";
    const pricing = document.createElement("span");
    pricing.className = `tracking-price-status ${pricingStatus}`;
    pricing.textContent = ui.pricingLabel(pricingStatus, lang);
    const statuses = document.createElement("div");
    statuses.className = "tracking-statuses";
    statuses.append(status, pricing);
    const actions = document.createElement("div");
    actions.className = "tracking-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = text("refresh");
    refresh.addEventListener("click", loadOrder);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = text("copy");
    copy.addEventListener("click", async () => {
      await global.navigator.clipboard.writeText(global.location.href);
      copy.textContent = text("copied");
    });
    actions.append(refresh, copy);

    if (ui.canCancel(order.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "tracking-action-danger";
      cancel.textContent = text("cancel");
      cancel.addEventListener("click", () => cancelOrder(order, cancel));
      actions.appendChild(cancel);
    } else if (ui.canHide(order.status)) {
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "tracking-action-muted";
      hide.textContent = text("hide");
      hide.addEventListener("click", hideOrder);
      actions.appendChild(hide);
    }
    statusRow.append(statuses, actions);
    content.appendChild(statusRow);

    if (order.status === "awaiting_approval") {
      const proposal = document.createElement("section");
      proposal.className = "tracking-proposal";
      const message = document.createElement("p");
      message.textContent = text("proposal");
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = text("accept");
      accept.addEventListener("click", () => acceptProposal(order, accept));
      proposal.append(message, accept);
      content.appendChild(proposal);
    }

    const meta = document.createElement("dl");
    meta.className = "tracking-meta";
    [
      [text("reference"), order.publicReference],
      [text("avatar"), order.buyerAvatar],
      [text("created"), ui.formatDate(order.createdAt, lang)],
      [text("updated"), ui.formatDate(order.updatedAt, lang)]
    ].forEach(([label, value]) => {
      const wrapper = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value || "—";
      wrapper.append(dt, dd);
      meta.appendChild(wrapper);
    });
    content.appendChild(meta);

    const tableWrap = document.createElement("div");
    tableWrap.className = "tracking-table-wrap";
    const table = document.createElement("table");
    const saleHeading = pricingStatus === "confirmed" ? text("salePrice") : text("estimate");
    table.innerHTML = `<thead><tr><th>${text("item")}</th><th>${text("quantity")}</th><th>${text("price")}</th><th>${text("markup")}</th><th>${saleHeading}</th></tr></thead>`;
    const body = document.createElement("tbody");
    (order.items || []).forEach((item) => {
      const row = document.createElement("tr");
      const markupLabel = order.frjMember ? text("member") : text("public");
      [
        `${item.itemName} (${item.storage} · ${item.aisle})`,
        ui.formatQuantity(item.quantity, lang),
        `${ui.formatPed(item.unitTtPed, lang)} PED`,
        `${markupLabel} : ${item.markupDisplay || text("pending")}`,
        `${ui.formatPed(item.lineSalePed, lang)} PED`
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    tableWrap.appendChild(table);
    content.appendChild(tableWrap);

    const total = document.createElement("p");
    total.className = "tracking-total";
    const totalLabel = document.createElement("span");
    const totalValue = document.createElement("strong");
    totalLabel.textContent = text(pricingStatus === "confirmed" ? "totalSale" : "total");
    totalValue.textContent = `${ui.formatPed(order.totalSalePed, lang)} PED`;
    total.append(totalLabel, totalValue);
    content.appendChild(total);
    const note = document.createElement("p");
    note.className = "tracking-note";
    note.textContent = text(pricingStatus === "confirmed" ? "confirmedNote" : "estimatedNote");
    content.appendChild(note);
  }

  async function acceptProposal(order, button) {
    button.disabled = true;
    button.textContent = text("accepting");
    try {
      await global.FRJ_API.acceptOrderProposal(token, order.proposalVersion);
      await loadOrder();
    } catch (error) {
      global.alert(error.message || text("acceptError"));
      button.disabled = false;
      button.textContent = text("accept");
    }
  }

  async function cancelOrder(order, button) {
    if (!global.confirm(text("cancelConfirm"))) return;
    button.disabled = true;
    button.textContent = text("cancelling");
    try {
      await global.FRJ_API.cancelOrder(token, "d1");
      await loadOrder();
    } catch (error) {
      global.alert(error.message || text("cancelError"));
      button.disabled = false;
      button.textContent = text("cancel");
    }
  }

  function hideOrder() {
    try {
      rememberHiddenToken();
      const stored = JSON.parse(global.localStorage.getItem(REQUESTS_KEY) || "[]");
      const remaining = Array.isArray(stored)
        ? stored.filter((request) => request?.accessToken !== token)
        : [];
      global.localStorage.setItem(REQUESTS_KEY, JSON.stringify(remaining));
      const legacy = JSON.parse(global.localStorage.getItem("FRJ_LAST_PURCHASE_REQUEST") || "null");
      if (legacy?.accessToken === token) {
        if (remaining[0]) {
          global.localStorage.setItem("FRJ_LAST_PURCHASE_REQUEST", JSON.stringify(remaining[0]));
        } else {
          global.localStorage.removeItem("FRJ_LAST_PURCHASE_REQUEST");
        }
      }
    } catch {
      // Le suivi reste utilisable même si le stockage local est bloqué.
    }
    showMessage(text("hidden"), "success");
  }

  applyLanguage();
  loadOrder();
  global.setInterval(() => {
    if (!document.hidden) loadOrder();
  }, 5 * 60 * 1000);
})(window);
