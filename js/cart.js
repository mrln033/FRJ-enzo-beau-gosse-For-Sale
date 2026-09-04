(function initFrjCart(global) {
  "use strict";

  const enabled = global.FRJ_FEATURES?.cart === true;
  const orderUi = global.FRJ_ORDER_UI;
  const STORAGE_KEY = "FRJ_PURCHASE_CART_V1";
  const REQUESTS_KEY = "FRJ_PURCHASE_REQUESTS_V1";
  const HIDDEN_REQUESTS_KEY = "FRJ_HIDDEN_PURCHASE_REQUESTS_V1";
  const MAX_LINES = 10;
  const MAX_CLOSED_REQUEST_HISTORY = 20;
  const CLOSED_REQUEST_STATUSES = new Set(["completed", "cancelled", "expired"]);
  const CANCELLABLE_REQUEST_STATUSES = new Set(["awaiting_approval", "submitted", "viewed"]);
  const STATUS_SORT_ORDER = new Map([
    ["awaiting_approval", 0], ["ready", 1], ["submitted", 2], ["viewed", 3],
    ["preparing", 4], ["completed", 5], ["cancelled", 6], ["expired", 7]
  ]);
  const copyLabels = {
    FR: {
      cart: "Panier", empty: "Votre panier est vide.", add: "Ajouter au panier",
      added: "Ajouté", quantity: "Quantité", unitTt: "Prix affiché", tt: "Total TT",
      sale: "Estimation de vente", estimated: "Prix indicatif, à confirmer avec Enzo.",
      member: "Remise membre FRJ : 50 % du MU", remove: "Retirer", clear: "Vider",
      copy: "Copier ma liste", copied: "Liste copiée.", send: "Transmettre à Enzo",
      avatar: "Avatar en jeu", contact: "Contact (facultatif)", comment: "Commentaire (facultatif)",
      close: "Fermer", help: "Aide du panier", sending: "Transmission…", sent: "Demande transmise",
      fallback: "Demande reçue par le secours GAS ; elle sera transférée vers D1.",
      stockChanged: "Le stock, le prix affiché ou le MU a changé. Le panier a été actualisé ; vérifiez-le avant de renvoyer.",
      failure: "Transmission impossible. Le panier reste enregistré sur cette machine.",
      noPrice: "Prix à confirmer", markupPending: "à confirmer",
      maxLines: "Le panier est limité à 10 lignes d’articles. Transmettez cette demande avant d’en préparer une autre.", lastRequest: "Demandes transmises",
      trackRequest: "Suivre ma demande", copyTracking: "Copier le lien de suivi",
      trackingCopied: "Lien de suivi copié.", gasTrackingPending: "Le suivi apparaîtra dès le transfert du secours GAS vers D1.",
      approvalRequired: "Action requise : Enzo a proposé des modifications à accepter.",
      cancelRequest: "Annuler la demande", cancelConfirm: "Confirmer l’annulation de cette demande ?",
      cancelledRequest: "Demande annulée.", hideRequest: "Masquer dans la liste", hiddenRequest: "Demande masquée de cette liste.",
      statusAwaiting: "À valider",
      statusSubmitted: "Transmise", statusViewed: "Vue", statusPreparing: "À préparer",
      statusReady: "Prête", statusCompleted: "Terminée", statusCancelled: "Annulée", statusExpired: "Expirée"
    },
    EN: {
      cart: "Cart", empty: "Your cart is empty.", add: "Add to cart",
      added: "Added", quantity: "Quantity", unitTt: "Displayed price", tt: "TT total",
      sale: "Estimated selling price", estimated: "Indicative price, to be confirmed with Enzo.",
      member: "FRJ member discount: 50% off MU", remove: "Remove", clear: "Clear",
      copy: "Copy my list", copied: "List copied.", send: "Send to Enzo",
      avatar: "In-game avatar", contact: "Contact (optional)", comment: "Comment (optional)",
      close: "Close", help: "Cart help", sending: "Sending…", sent: "Request sent",
      fallback: "Request received by GAS fallback; it will be transferred to D1.",
      stockChanged: "Stock, displayed price or MU changed. The cart was updated; review it before sending again.",
      failure: "Unable to send. The cart remains saved on this device.",
      noPrice: "Price to confirm", markupPending: "to confirm",
      maxLines: "The cart is limited to 10 item lines. Send this request before preparing another one.", lastRequest: "Submitted requests",
      trackRequest: "Track my request", copyTracking: "Copy tracking link",
      trackingCopied: "Tracking link copied.", gasTrackingPending: "Tracking will appear once the GAS fallback has transferred the request to D1.",
      approvalRequired: "Action required: Enzo proposed changes that need your approval.",
      cancelRequest: "Cancel request", cancelConfirm: "Confirm cancellation of this request?",
      cancelledRequest: "Request cancelled.", hideRequest: "Hide from list", hiddenRequest: "Request hidden from this list.",
      statusAwaiting: "Approval required",
      statusSubmitted: "Submitted", statusViewed: "Viewed", statusPreparing: "Being prepared",
      statusReady: "Ready", statusCompleted: "Completed", statusCancelled: "Cancelled", statusExpired: "Expired"
    }
  };

  let cart = readCart();
  let requests = readRequests();
  let drawer;
  let launcher;
  let helpDialog;
  let helpTrigger;
  let statusNode;
  let statusMessage = "";
  let statusType = "";
  let trackingRefreshRunning = false;

  function language() {
    return global.currentLang === "FR" || global.localStorage.getItem("lang") === "FR" ? "FR" : "EN";
  }

  function label(key) {
    return copyLabels[language()][key] || key;
  }

  function isFrjMember() {
    return language() === "FR" && global.localStorage.getItem("FRJ") === "TRUE";
  }

  function itemKey(item) {
    return [item.itemName, item.storage, item.aisle]
      .map((value) => String(value || "").trim().toLocaleLowerCase("en-US"))
      .join("\u001f");
  }

  function addItem(rawItem, options = {}) {
    if (!enabled) return;
    const normalized = normalizeCatalogItem(rawItem);
    const requestedQuantity = clampQuantity(options.quantity ?? 1, normalized.stock);
    if (requestedQuantity <= 0) return;
    const key = itemKey(normalized);
    const existing = cart.items.find((item) => item.key === key);
    if (!existing && cart.items.length >= MAX_LINES) {
      open();
      setStatus(label("maxLines"), "error");
      return;
    }
    if (existing) {
      existing.stock = normalized.stock;
      existing.unitTtPed = normalized.unitTtPed;
      existing.markupKind = normalized.markupKind;
      existing.markupValue = normalized.markupValue;
      existing.markupDisplay = normalized.markupDisplay;
      existing.discountKind = normalized.discountKind;
      existing.discountCampaignId = normalized.discountCampaignId;
      existing.discountRate = normalized.discountRate;
      existing.quantity = clampQuantity(existing.quantity + requestedQuantity, existing.stock);
    } else {
      cart.items.push({ ...normalized, key, quantity: requestedQuantity });
    }
    saveCart();
    setStatus("");
    render();
    pulseLauncher();
  }

  function normalizeCatalogItem(item) {
    const parsedMarkup = parseMarkup(item.MU);
    return {
      itemName: String(item.ITEM || "").trim(),
      storage: String(item.STORAGE || "").trim().toUpperCase(),
      aisle: String(item.RAYON || "").trim().toUpperCase(),
      stock: Math.max(0, Number(item.QUANTITE) || 0),
      unitTtPed: Math.max(0, Number(item.PRIX_UNITAIRE) || 0),
      markupKind: parsedMarkup.kind,
      markupValue: parsedMarkup.value,
      markupDisplay: String(item.MU || "").trim() || null,
      discountKind: item.REMISE_TYPE === "sale" || item.REMISE_TYPE === "daily_promo" ? item.REMISE_TYPE : null,
      discountCampaignId: String(item.REMISE_ID || "").trim() || null,
      discountRate: Number(item.Remise_Promo) > 0 ? Number(item.Remise_Promo) : null,
      image: String(item.IMAGE || "").trim() || null,
      observedBackend: global.FRJ_API?.activeBackend || "gas"
    };
  }

  function parseMarkup(raw) {
    const text = String(raw || "").trim();
    if (/%$/.test(text)) {
      const value = Number(text.replace("%", "").replace(",", "."));
      return Number.isFinite(value) ? { kind: "percent", value: value / 100 } : { kind: "none", value: null };
    }
    if (/PED$/i.test(text)) {
      const value = Number(text.replace(/PED$/i, "").trim().replace(",", "."));
      return Number.isFinite(value) ? { kind: "ped", value } : { kind: "none", value: null };
    }
    return { kind: "none", value: null };
  }

  function effectiveMarkup(item) {
    if (!Number.isFinite(item.markupValue)) return { kind: item.markupKind, value: item.markupValue };
    const profileFactor = isFrjMember() ? 0.5 : 1;
    const campaignFactor = Number.isFinite(item.discountRate) ? 1 - item.discountRate : 1;
    return item.markupKind === "percent"
      ? { kind: "percent", value: 1 + ((item.markupValue - 1) * profileFactor * campaignFactor) }
      : (item.markupKind === "ped"
        ? { kind: "ped", value: item.markupValue * profileFactor * campaignFactor }
        : { kind: "none", value: null });
  }

  function linePrices(item) {
    const quantity = Number(item.quantity) || 0;
    const tt = roundPed(item.unitTtPed * quantity);
    const markup = effectiveMarkup(item);
    let sale = tt;
    if (markup.kind === "percent") sale = tt * markup.value;
    if (markup.kind === "ped") sale = tt + (quantity * markup.value);
    return { tt, sale: roundPed(sale), hasMarkup: markup.kind !== "none" };
  }

  function displayedMarkup(item) {
    const markup = effectiveMarkup(item);
    const prefix = isFrjMember() ? "MU FRJ" : "MU";
    if (markup.kind === "percent" && Number.isFinite(markup.value)) {
      const percent = (markup.value * 100).toLocaleString(language() === "FR" ? "fr-FR" : "en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return `${prefix} : ${percent} %`;
    }
    if (markup.kind === "ped" && Number.isFinite(markup.value)) {
      return `${prefix} : ${formatPed(markup.value)} PED`;
    }
    return `${prefix} : ${label("markupPending")}`;
  }

  function createUi() {
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "cart-launcher";
    launcher.addEventListener("click", open);

    drawer = document.createElement("aside");
    drawer.className = "cart-drawer";
    drawer.hidden = true;
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("role", "dialog");
    drawer.addEventListener("click", (event) => {
      if (event.target === drawer) close();
    });

    helpDialog = document.createElement("aside");
    helpDialog.className = "cart-help-overlay";
    helpDialog.hidden = true;
    helpDialog.setAttribute("aria-modal", "true");
    helpDialog.setAttribute("aria-labelledby", "cartHelpTitle");
    helpDialog.setAttribute("role", "dialog");
    helpDialog.innerHTML = `
      <div class="cart-help-dialog">
        <header>
          <h2 id="cartHelpTitle"></h2>
          <button type="button" class="cart-help-close" aria-label=""></button>
        </header>
        <iframe class="cart-help-frame" src="about:blank" title=""></iframe>
      </div>`;
    helpDialog.querySelector(".cart-help-close").addEventListener("click", closeHelp);
    helpDialog.addEventListener("click", (event) => {
      if (event.target === helpDialog) closeHelp();
    });
    global.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && helpDialog && !helpDialog.hidden) closeHelp();
    });

    document.body.append(launcher, drawer, helpDialog);
    global.addEventListener("storage", (event) => {
      if (event.key !== REQUESTS_KEY && event.key !== HIDDEN_REQUESTS_KEY && event.key !== "FRJ_LAST_PURCHASE_REQUEST") return;
      requests = readRequests();
      render();
      refreshRequestStatuses();
    });
    render();
    refreshRequestStatuses();
    global.setInterval(() => { if (!document.hidden) refreshRequestStatuses(); }, 5 * 60 * 1000);
  }

  function render() {
    if (!enabled || !launcher || !drawer) return;
    const count = cart.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const saleTotal = roundPed(cart.items.reduce((sum, item) => sum + linePrices(item).sale, 0));
    const approvalCount = requests.filter((request) => request.status === "awaiting_approval").length;
    const requiresApproval = approvalCount > 0;
    launcher.classList.toggle("action-required", requiresApproval);
    launcher.replaceChildren(document.createTextNode(`🛒 ${formatQuantity(count)} · ${formatPed(saleTotal)} PED`));
    if (requiresApproval) {
      const badge = document.createElement("span");
      badge.className = "cart-alert-badge";
      badge.textContent = String(approvalCount);
      badge.title = label("approvalRequired");
      launcher.appendChild(badge);
    }
    launcher.setAttribute("aria-label", `${label("cart")} — ${formatQuantity(count)}${requiresApproval ? ` — ${approvalCount} — ${label("approvalRequired")}` : ""}`);

    const content = document.createElement("div");
    content.className = "cart-panel";
    const header = document.createElement("header");
    header.innerHTML = `<h2>🛒 ${escapeHtml(label("cart"))}</h2>`;
    const headerActions = document.createElement("div");
    headerActions.className = "cart-header-actions";
    const helpButton = button("?", "cart-help-button", openHelp);
    helpButton.setAttribute("aria-label", label("help"));
    helpButton.title = label("help");
    const closeButton = button("×", "cart-close", close);
    closeButton.setAttribute("aria-label", label("close"));
    headerActions.append(helpButton, closeButton);
    header.appendChild(headerActions);
    content.appendChild(header);

    const list = document.createElement("div");
    list.className = "cart-lines";
    if (!cart.items.length) {
      list.innerHTML = `<p class="cart-empty">${escapeHtml(label("empty"))}</p>`;
    } else {
      cart.items.forEach((item) => list.appendChild(renderLine(item)));
    }
    content.appendChild(list);

    const totals = document.createElement("div");
    totals.className = "cart-totals";
    const ttTotal = roundPed(cart.items.reduce((sum, item) => sum + linePrices(item).tt, 0));
    totals.innerHTML = `
      <p><span>${escapeHtml(label("tt"))}</span><strong>${formatPed(ttTotal)} PED</strong></p>
      <p class="cart-sale-total"><span>${escapeHtml(label("sale"))}</span><strong>${formatPed(saleTotal)} PED</strong></p>
      ${isFrjMember() ? `<small>${escapeHtml(label("member"))}</small>` : ""}
      <small>${escapeHtml(label("estimated"))}</small>`;
    content.appendChild(totals);

    statusNode = document.createElement("p");
    statusNode.setAttribute("role", "status");
    statusNode.textContent = statusMessage;
    statusNode.className = `cart-status${statusType ? ` ${statusType}` : ""}`;
    content.appendChild(statusNode);

    if (cart.items.length) content.appendChild(renderActions());
    if (requests.length) content.appendChild(renderTracking());
    drawer.replaceChildren(content);
  }

  function renderLine(item) {
    const line = document.createElement("article");
    line.className = "cart-line";
    const prices = linePrices(item);
    line.innerHTML = `
      <div class="cart-line-title">
        <strong>${escapeHtml(item.itemName)}</strong>${orderUi?.discountMarker(item, language()) ? ` <small class="order-discount-marker"><em>(${escapeHtml(orderUi.discountMarker(item, language()))})</em></small>` : ""}
        <small>${escapeHtml(item.storage)} · ${escapeHtml(item.aisle)}</small>
      </div>
      <label>${escapeHtml(label("quantity"))}
        <input class="cart-quantity" type="number" min="1" max="${Math.floor(item.stock)}" step="1" value="${item.quantity}">
      </label>
      <div class="cart-line-prices">
        <span class="cart-line-price-detail">
          <span>${escapeHtml(label("unitTt"))}: ${formatPed(item.unitTtPed)} PED</span>
          <small>${escapeHtml(displayedMarkup(item))}</small>
        </span>
        <strong>${formatPed(prices.sale)} PED</strong>
      </div>`;
    const input = line.querySelector("input");
    input.addEventListener("change", () => {
      item.quantity = clampQuantity(input.value, item.stock);
      if (item.quantity <= 0) cart.items = cart.items.filter((entry) => entry.key !== item.key);
      saveCart();
      render();
    });
    const remove = button(label("remove"), "cart-remove", () => {
      cart.items = cart.items.filter((entry) => entry.key !== item.key);
      saveCart();
      render();
    });
    line.appendChild(remove);
    return line;
  }

  function renderActions() {
    const wrapper = document.createElement("div");
    wrapper.className = "cart-actions";
    const secondary = document.createElement("div");
    secondary.append(
      button(label("copy"), "cart-secondary", copyCart),
      button(label("clear"), "cart-secondary cart-danger", clearCart)
    );
    const form = document.createElement("form");
    form.className = "cart-submit-form";
    form.innerHTML = `
      <label>${escapeHtml(label("avatar"))}<input name="buyerAvatar" maxlength="80" required></label>
      <label>${escapeHtml(label("contact"))}<input name="buyerContact" maxlength="160"></label>
      <label>${escapeHtml(label("comment"))}<textarea name="buyerComment" maxlength="800" rows="3"></textarea></label>
      <label class="cart-honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <button type="submit" class="cart-primary">${escapeHtml(label("send"))}</button>`;
    form.addEventListener("submit", submitCart);
    wrapper.append(secondary, form);
    return wrapper;
  }

  function renderTracking() {
    const wrapper = document.createElement("section");
    wrapper.className = "cart-tracking-list";
    const title = document.createElement("strong");
    title.textContent = label("lastRequest");
    wrapper.appendChild(title);
    const orderedRequests = [...requests].sort((left, right) => {
      const statusDifference = (STATUS_SORT_ORDER.get(left.status) ?? 99) - (STATUS_SORT_ORDER.get(right.status) ?? 99);
      return statusDifference || Date.parse(right.submittedAt || 0) - Date.parse(left.submittedAt || 0);
    });
    orderedRequests.forEach((request) => {
      const section = document.createElement("article");
      section.className = `cart-tracking status-${request.status || "submitted"}${request.status === "awaiting_approval" ? " approval-required" : ""}`;
      const reference = document.createElement("span");
      reference.textContent = `${request.reference} — ${requestStatusLabel(request.status)}`;
      const link = document.createElement("a");
      link.href = trackingUrl(request.accessToken);
      link.target = "_self";
      link.textContent = label("trackRequest");
      const copy = button(label("copyTracking"), "cart-secondary", async () => {
        await navigator.clipboard.writeText(link.href);
        setStatus(label("trackingCopied"), "success");
      });
      section.append(reference, link, copy);
      if (CANCELLABLE_REQUEST_STATUSES.has(request.status)) {
        section.appendChild(button(label("cancelRequest"), "cart-secondary cart-cancel-request", () => cancelRequest(request)));
      } else if (CLOSED_REQUEST_STATUSES.has(request.status)) {
        section.appendChild(button(label("hideRequest"), "cart-secondary cart-hide-request", () => hideRequest(request.accessToken)));
      }
      if (request.status === "awaiting_approval") {
        const alert = document.createElement("strong");
        alert.className = "cart-tracking-alert";
        alert.textContent = label("approvalRequired");
        section.prepend(alert);
      } else if (request.backend === "gas") {
        const pending = document.createElement("small");
        pending.textContent = label("gasTrackingPending");
        section.appendChild(pending);
      }
      wrapper.appendChild(section);
    });
    return wrapper;
  }

  async function cancelRequest(request) {
    if (!global.confirm(label("cancelConfirm"))) return;
    setStatus("");
    try {
      const result = await global.FRJ_API.cancelOrder(request.accessToken, request.backend);
      request.status = "cancelled";
      request.backend = result.backend === "gas" ? "gas" : "d1";
      request.updatedAt = new Date().toISOString();
      requests = mergeRequests(requests, readRequests());
      saveRequests();
      setStatus(label("cancelledRequest"), "success");
      render();
    } catch (error) {
      await refreshRequestStatuses();
      setStatus(error.message, "error");
    }
  }

  function hideRequest(accessToken) {
    saveHiddenRequestTokens([...readHiddenRequestTokens(), accessToken]);
    requests = requests.filter((request) => request.accessToken !== accessToken);
    saveRequests();
    setStatus(label("hiddenRequest"), "success");
    render();
  }

  async function submitCart(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type=submit]");
    const data = new FormData(form);
    submit.disabled = true;
    submit.textContent = label("sending");
    setStatus("");
    const id = crypto.randomUUID();
    const date = new Date();
    const datePart = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
    const publicReference = `FRJ-${datePart}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const payload = {
      id,
      publicReference,
      accessToken: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
      buyerAvatar: data.get("buyerAvatar"),
      buyerContact: data.get("buyerContact"),
      buyerComment: data.get("buyerComment"),
      website: data.get("website"),
      language: language(),
      frjMember: isFrjMember(),
      clientCreatedAt: new Date().toISOString(),
      items: cart.items.map((item) => ({
        itemName: item.itemName,
        storage: item.storage,
        aisle: item.aisle,
        quantity: item.quantity,
        unitTtPed: item.unitTtPed,
        markupKind: item.markupKind,
        markupValue: item.markupValue,
        discountKind: item.discountKind,
        discountCampaignId: item.discountCampaignId,
        discountRate: item.discountRate
      }))
    };
    try {
      const result = await global.FRJ_API.submitOrder(payload);
      const reference = result.order?.publicReference || publicReference;
      setStatus(`${label("sent")} — ${reference}${result.backend === "gas" ? `\n${label("fallback")}` : ""}`, "success");
      const request = {
        reference,
        accessToken: payload.accessToken,
        backend: result.backend,
        submittedAt: new Date().toISOString(),
        status: result.order?.status || "submitted"
      };
      // Relire le stockage au dernier moment évite qu'une transmission effectuée
      // depuis un autre onglet soit écrasée par la copie mémoire de cette page.
      requests = mergeRequests([request], readRequests(), requests);
      saveRequests();
      cart.items = [];
      saveCart();
      form.reset();
      render();
    } catch (error) {
      if (error.status === 409 && Array.isArray(error.details?.discrepancies)) {
        applyDiscrepancies(error.details.discrepancies);
        render();
        open();
        setStatus(label("stockChanged"), "error");
      } else {
        setStatus(`${label("failure")}\n${error.message}`, "error");
      }
    } finally {
      submit.disabled = false;
      submit.textContent = label("send");
    }
  }

  function applyDiscrepancies(discrepancies) {
    discrepancies.forEach((difference) => {
      const key = itemKey(difference);
      const item = cart.items.find((entry) => entry.key === key);
      if (!item) return;
      item.stock = Math.max(0, Number(difference.availableQuantity) || 0);
      item.quantity = Math.min(item.quantity, item.stock);
      if (difference.reason === "price-changed") {
        item.unitTtPed = Math.max(0, Number(difference.unitTtPed) || 0);
        item.markupKind = difference.markupKind === "percent" || difference.markupKind === "ped"
          ? difference.markupKind
          : "none";
        item.markupValue = Number.isFinite(Number(difference.markupValue))
          ? Number(difference.markupValue)
          : null;
        item.markupDisplay = difference.markupDisplay || null;
        item.discountKind = difference.discountKind || null;
        item.discountCampaignId = difference.discountCampaignId || null;
        item.discountRate = Number(difference.discountRate) > 0 ? Number(difference.discountRate) : null;
      }
    });
    cart.items = cart.items.filter((item) => item.stock > 0 && item.quantity > 0);
    saveCart();
  }

  async function copyCart() {
    const lines = cart.items.map((item) => {
      const prices = linePrices(item);
      return `- ${formatQuantity(item.quantity)} × ${item.itemName} — ${formatPed(item.unitTtPed)} PED/u — ${displayedMarkup(item)} — ${formatPed(prices.sale)} PED`;
    });
    const total = roundPed(cart.items.reduce((sum, item) => sum + linePrices(item).sale, 0));
    const heading = language() === "FR" ? "Bonjour, je suis intéressé par :" : "Hello, I am interested in:";
    const footer = `${label("sale")} : ${formatPed(total)} PED\n${label("estimated")}`;
    await navigator.clipboard.writeText([heading, "", ...lines, "", footer].join("\n"));
    setStatus(label("copied"), "success");
  }

  function clearCart() {
    cart.items = [];
    saveCart();
    setStatus("");
    render();
  }

  function open() {
    if (!drawer) return;
    drawer.hidden = false;
    document.body.classList.add("cart-open");
    refreshRequestStatuses();
  }

  function openHelp() {
    if (!helpDialog) return;
    helpTrigger = document.activeElement;
    const title = label("help");
    helpDialog.querySelector("#cartHelpTitle").textContent = title;
    const closeButton = helpDialog.querySelector(".cart-help-close");
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", label("close"));
    const helpFrame = helpDialog.querySelector(".cart-help-frame");
    const helpSource = `./aide-panier.html?lang=${language()}`;
    if (helpFrame.getAttribute("src") !== helpSource) helpFrame.src = helpSource;
    helpFrame.title = title;
    helpDialog.hidden = false;
    closeButton.focus();
  }

  function closeHelp(restoreFocus = true) {
    if (!helpDialog || helpDialog.hidden) return;
    helpDialog.hidden = true;
    if (restoreFocus && helpTrigger instanceof HTMLElement) helpTrigger.focus();
    helpTrigger = null;
  }

  function close() {
    if (!drawer) return;
    closeHelp(false);
    drawer.hidden = true;
    document.body.classList.remove("cart-open");
  }

  function setStatus(message, type = "") {
    statusMessage = String(message || "");
    statusType = type;
    if (!statusNode) statusNode = drawer?.querySelector(".cart-status");
    if (!statusNode) return;
    statusNode.textContent = statusMessage;
    statusNode.className = `cart-status${type ? ` ${type}` : ""}`;
  }

  function pulseLauncher() {
    launcher?.classList.remove("pulse");
    requestAnimationFrame(() => launcher?.classList.add("pulse"));
  }

  function readCart() {
    try {
      const parsed = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "{}");
      const items = Array.isArray(parsed.items)
        ? parsed.items.slice(0, MAX_LINES).map((item) => ({
          ...item,
          quantity: clampQuantity(item.quantity, item.stock)
        })).filter((item) => item.quantity > 0)
        : [];
      return { version: 1, items };
    } catch {
      return { version: 1, items: [] };
    }
  }

  function readRequests() {
    try {
      const stored = JSON.parse(global.localStorage.getItem(REQUESTS_KEY) || "[]");
      const legacy = JSON.parse(global.localStorage.getItem("FRJ_LAST_PURCHASE_REQUEST") || "null");
      const hidden = new Set(readHiddenRequestTokens());
      return mergeRequests(Array.isArray(stored) ? stored : [], legacy ? [legacy] : [])
        .filter((request) => !hidden.has(request.accessToken));
    } catch {
      return [];
    }
  }

  function readHiddenRequestTokens() {
    try {
      const stored = JSON.parse(global.localStorage.getItem(HIDDEN_REQUESTS_KEY) || "[]");
      return Array.isArray(stored)
        ? stored.filter((value) => /^[a-f0-9-]{70,80}$/i.test(String(value || "")))
        : [];
    } catch {
      return [];
    }
  }

  function saveHiddenRequestTokens(tokens) {
    const unique = [...new Set(tokens.map((value) => String(value || "")))].slice(-100);
    global.localStorage.setItem(HIDDEN_REQUESTS_KEY, JSON.stringify(unique));
  }

  function mergeRequests(...groups) {
    const byRequest = new Map();
    groups.flat().forEach((request) => {
      const accessToken = String(request?.accessToken || "");
      if (!/^[a-f0-9-]{70,80}$/i.test(accessToken)) return;
      const normalized = {
        reference: String(request.reference || "").trim(),
        accessToken,
        backend: request.backend === "gas" ? "gas" : "d1",
        submittedAt: String(request.submittedAt || ""),
        updatedAt: String(request.updatedAt || ""),
        status: String(request.status || "")
      };
      const normalizedReference = normalized.reference.toLocaleUpperCase("en-US");
      const requestKey = normalizedReference ? `reference:${normalizedReference}` : `token:${accessToken}`;
      const existing = byRequest.get(requestKey);
      const normalizedTime = Date.parse(normalized.updatedAt || normalized.submittedAt || 0);
      const existingTime = Date.parse(existing?.updatedAt || existing?.submittedAt || 0);
      if (
        !existing
        || normalizedTime > existingTime
        || (normalizedTime === existingTime && existing.backend === "gas" && normalized.backend === "d1")
      ) {
        byRequest.set(requestKey, normalized);
      }
    });
    const sorted = [...byRequest.values()]
      .sort((left, right) => Date.parse(right.submittedAt || 0) - Date.parse(left.submittedAt || 0));
    const active = sorted.filter((request) => !CLOSED_REQUEST_STATUSES.has(request.status));
    const closed = sorted.filter((request) => CLOSED_REQUEST_STATUSES.has(request.status))
      .slice(0, MAX_CLOSED_REQUEST_HISTORY);
    return [...active, ...closed]
      .sort((left, right) => Date.parse(right.submittedAt || 0) - Date.parse(left.submittedAt || 0));
  }

  function saveRequests() {
    global.localStorage.setItem(REQUESTS_KEY, JSON.stringify(requests));
    if (requests[0]) global.localStorage.setItem("FRJ_LAST_PURCHASE_REQUEST", JSON.stringify(requests[0]));
    else global.localStorage.removeItem("FRJ_LAST_PURCHASE_REQUEST");
  }

  function requestStatusLabel(status) {
    const keys = {
      submitted: "statusSubmitted", viewed: "statusViewed", preparing: "statusPreparing",
      ready: "statusReady", completed: "statusCompleted", cancelled: "statusCancelled", expired: "statusExpired"
    };
    return status === "awaiting_approval" ? label("statusAwaiting") : (keys[status] ? label(keys[status]) : label("statusSubmitted"));
  }

  async function refreshRequestStatuses() {
    if (trackingRefreshRunning || !requests.length || !global.FRJ_API?.getOrderStatus) return;
    trackingRefreshRunning = true;
    let changed = false;
    await Promise.all(requests.map(async (request) => {
      try {
        const order = await global.FRJ_API.getOrderStatus(request.accessToken);
        if (request.status !== order.status || request.backend !== "d1") changed = true;
        request.status = order.status;
        request.backend = "d1";
        request.updatedAt = order.updatedAt || request.updatedAt || "";
      } catch (error) {
        if (error?.status !== 404) console.warn("Suivi de demande indisponible", error);
      }
    }));
    trackingRefreshRunning = false;
    if (changed) {
      requests = mergeRequests(requests, readRequests());
      saveRequests();
    }
    render();
  }

  function trackingUrl(accessToken) {
    const url = new URL("./suivi-commande.html", global.location.href);
    url.searchParams.set("token", accessToken);
    const backend = new URLSearchParams(global.location.search).get("backend") === "d1" ? "d1" : "gas";
    url.searchParams.set("backend", backend);
    return url.toString();
  }

  function saveCart() {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: cart.items }));
  }

  function clampQuantity(value, stock) {
    const quantity = Number(value);
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    return Math.min(Math.floor(quantity), Math.max(0, Math.floor(Number(stock) || 0)));
  }

  function formatPed(value) {
    return Number(value || 0).toLocaleString(language() === "FR" ? "fr-FR" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatQuantity(value) {
    return Number(value || 0).toLocaleString(language() === "FR" ? "fr-FR" : "en-GB", { maximumFractionDigits: 0 });
  }

  function roundPed(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function button(text, className, handler) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = text;
    element.addEventListener("click", handler);
    return element;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  global.FRJ_CART = Object.freeze({
    enabled,
    addItem,
    refresh: render,
    open
  });

  if (enabled) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", createUi);
    else createUi();
    global.addEventListener("frj:memberchange", render);
  }
})(window);
