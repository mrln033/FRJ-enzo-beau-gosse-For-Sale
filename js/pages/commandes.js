(function initOrdersAdminPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const ui = global.FRJ_ORDER_UI;
  const STATUS_FILTER_KEY = "FRJ_ADMIN_ORDER_STATUS_FILTER_V1";
  const STATUS_KEYS = ui.statusKeys;
  const HISTORY_ACTOR_LABELS = Object.freeze({
    admin: "Administrateur",
    client: "Client",
    gas: "Google Sheets / GAS",
    system: "Système"
  });
  let selectedStatuses = readSelectedStatuses();
  let orderCatalog = [];
  let lastOrdersReport = null;
  let lastOrders = [];
  let newOrderEditors = [];
  let directOrderListSequence = 0;

  function hasAtMostDecimals(value, decimals) {
    const factor = 10 ** decimals;
    return Math.abs(Number(value) - (Math.round(Number(value) * factor) / factor)) <= 1e-9;
  }

  function editableMarkupAmount(item) {
    if (item.markupKind === "none") return "";
    const amount = item.markupKind === "percent"
      ? Number(item.markupValue || 0) * 100
      : Number(item.markupValue || 0);
    return amount.toFixed(6).replace(/\.?0+$/, "");
  }

  function compareCatalogItems(left, right) {
    const options = { sensitivity: "base", numeric: true };
    const byName = String(left?.itemName || "").localeCompare(String(right?.itemName || ""), "fr", options);
    if (byName) return byName;
    const byStorage = String(left?.storage || "").localeCompare(String(right?.storage || ""), "fr", options);
    if (byStorage) return byStorage;
    return String(left?.aisle || "").localeCompare(String(right?.aisle || ""), "fr", options);
  }

  function catalogItemChoiceLabel(item) {
    return `${item.itemName} — ${item.storage} / ${item.aisle} — stock ${ui.formatQuantity(item.availableStock)}`;
  }

  function readSelectedStatuses() {
    try {
      const raw = global.localStorage.getItem(STATUS_FILTER_KEY);
      if (raw === null) return new Set(STATUS_KEYS);
      const stored = JSON.parse(raw);
      return new Set(Array.isArray(stored) ? stored.filter((status) => STATUS_KEYS.includes(status)) : STATUS_KEYS);
    } catch {
      return new Set(STATUS_KEYS);
    }
  }

  function saveSelectedStatuses() {
    global.localStorage.setItem(
      STATUS_FILTER_KEY,
      JSON.stringify(STATUS_KEYS.filter((status) => selectedStatuses.has(status)))
    );
  }

  async function loadOrders() {
    const list = document.getElementById("ordersList");
    const summary = document.getElementById("ordersSummary");
    const error = document.getElementById("ordersError");
    summary.textContent = "Chargement…";
    error.hidden = true;

    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/orders", { cache: "no-store" });
      const report = await response.json();
      const orders = report.orders || [];
      lastOrdersReport = report;
      lastOrders = orders;
      renderStatusFilters(orders, () => renderOrderResults(report, orders));
      renderOrderResults(report, orders);
    } catch (loadError) {
      list.replaceChildren();
      summary.textContent = "Chargement impossible";
      error.textContent = loadError.message;
      error.hidden = false;
    }
  }

  async function loadOrderCatalog() {
    const toggle = document.getElementById("newOrderToggle");
    if (!toggle) return;
    toggle.disabled = true;
    toggle.textContent = "Chargement du catalogue…";
    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/orders/catalog", { cache: "no-store" });
      const result = await response.json();
      orderCatalog = Array.isArray(result.items) ? [...result.items].sort(compareCatalogItems) : [];
      if (!orderCatalog.length) throw new Error("Aucun article avec un stock positif n’est disponible.");
      toggle.disabled = false;
      toggle.textContent = "Ajouter une nouvelle demande";
      if (lastOrdersReport) renderOrderResults(lastOrdersReport, lastOrders);
    } catch (error) {
      toggle.textContent = "Création directe indisponible";
      const feedback = document.getElementById("newOrderFeedback");
      if (feedback) {
        feedback.className = "new-order-feedback error";
        feedback.textContent = error.message;
      }
    }
  }

  function renderStatusFilters(orders, onChange) {
    const filters = document.getElementById("ordersFilters");
    const counts = Object.fromEntries(STATUS_KEYS.map((status) => [status, 0]));
    orders.forEach((order) => {
      if (Object.hasOwn(counts, order.status)) counts[order.status] += 1;
    });

    const heading = document.createElement("span");
    heading.className = "orders-filters-label";
    heading.textContent = "Statuts affichés :";
    const controls = STATUS_KEYS.map((status) => {
      const label = document.createElement("label");
      label.className = "orders-filter";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = status;
      checkbox.checked = selectedStatuses.has(status);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedStatuses.add(status);
        else selectedStatuses.delete(status);
        saveSelectedStatuses();
        onChange();
      });
      const caption = document.createElement("span");
      caption.textContent = `${ui.statusLabel(status, "FR", "admin")} (${counts[status]})`;
      label.append(checkbox, caption);
      return label;
    });
    filters.replaceChildren(heading, ...controls);
  }

  function renderOrderResults(report, orders) {
    const list = document.getElementById("ordersList");
    const summary = document.getElementById("ordersSummary");
    const displayed = orders.filter((order) => selectedStatuses.has(order.status));
    summary.textContent = report.enabled === false
      ? `Fonction panier désactivée — ${displayed.length} demande(s) affichée(s) sur ${orders.length} — actualisé ${ui.formatDate(report.generatedAt)}`
      : `${displayed.length} demande(s) affichée(s) sur ${orders.length} — actualisé ${ui.formatDate(report.generatedAt)}`;
    list.replaceChildren(...displayed.map(renderOrder));

    if (!displayed.length && report.enabled !== false) {
      const empty = document.createElement("p");
      empty.textContent = orders.length
        ? "Aucune demande ne correspond aux statuts sélectionnés."
        : "Aucune demande transmise.";
      list.appendChild(empty);
    }
  }

  function renderOrder(order) {
    const proposalEditable = ui.canEditProposal(order.status);
    const article = document.createElement("article");
    article.className = `order-card${order.status === "awaiting_approval" ? " awaiting-approval" : ""}`;
    const header = document.createElement("header");
    const identity = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = `${order.publicReference} — ${order.buyerAvatar}`;
    const meta = document.createElement("div");
    meta.className = "order-meta";
    [
      ui.formatDate(order.createdAt),
      order.sourceBackend === "gas-fallback"
        ? "Reçue par secours GAS"
        : (order.sourceBackend === "d1-admin" ? "Demande directe" : "Reçue par D1"),
      order.frjMember ? "Membre FRJ" : "Public",
      order.buyerContact || "Pas de contact"
    ].forEach((value) => {
      const span = document.createElement("span");
      span.textContent = value;
      meta.appendChild(span);
    });
    const pricingStatus = order.pricingStatus || "estimated";
    const pricing = document.createElement("span");
    pricing.className = `order-price-status ${pricingStatus}`;
    pricing.textContent = ui.pricingLabel(pricingStatus, "FR", "admin");
    meta.appendChild(pricing);
    identity.append(title, meta);

    const select = document.createElement("select");
    select.className = "order-status";
    STATUS_KEYS.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = ui.statusLabel(value, "FR", "admin");
      option.selected = order.status === value;
      option.disabled = value === "awaiting_approval";
      select.appendChild(option);
    });
    select.addEventListener("change", () => updateStatus(order.id, select));
    const headerActions = document.createElement("div");
    headerActions.className = "order-header-actions";
    headerActions.append(select, createTrackingControl(order));
    header.append(identity, headerActions);
    article.appendChild(header);

    if (order.status === "awaiting_approval") {
      const hint = document.createElement("p");
      hint.className = "approval-hint";
      hint.textContent = `Proposition n°${order.proposalVersion} en attente d’acceptation par le client.`;
      article.appendChild(hint);
    }

    const table = document.createElement("table");
    const saleHeading = pricingStatus === "confirmed" ? "Prix de vente" : "Estimation vente";
    table.innerHTML = `<thead><tr><th>Article</th><th>Qté proposée</th><th>Prix affiché</th><th>MU ponctuel</th><th>${saleHeading}</th></tr></thead>`;
    const body = document.createElement("tbody");
    const editors = [];
    (order.items || []).forEach((item) => {
      const row = document.createElement("tr");
      const itemCell = document.createElement("td");
      itemCell.append(document.createTextNode(`${item.itemName} (${item.storage} · ${item.aisle})`));
      appendDiscountMarker(itemCell, item);
      row.appendChild(itemCell);

      const quantityCell = document.createElement("td");
      const quantity = document.createElement("input");
      quantity.type = "number";
      quantity.min = "1";
      quantity.max = "1000000";
      quantity.step = "1";
      quantity.value = item.quantity;
      quantity.disabled = !proposalEditable;
      quantity.setAttribute("aria-label", `Quantité ${item.itemName}`);
      quantityCell.appendChild(quantity);

      const priceCell = document.createElement("td");
      priceCell.textContent = `${ui.formatPed(item.unitTtPed)} PED`;
      const markupCell = document.createElement("td");
      markupCell.className = "line-editor";
      const kind = document.createElement("select");
      kind.setAttribute("aria-label", `Type de MU ${item.itemName}`);
      [["percent", "%"], ["ped", "PED"], ["none", "Aucun"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = item.markupKind === value;
        kind.appendChild(option);
      });
      kind.disabled = !proposalEditable;

      const amount = document.createElement("input");
      amount.className = "markup-amount";
      amount.type = "number";
      amount.min = "0";
      amount.max = "1000000";
      amount.step = "0.000001";
      amount.value = editableMarkupAmount(item);
      amount.disabled = !proposalEditable || item.markupKind === "none";
      amount.setAttribute("aria-label", `Valeur du MU ${item.itemName}`);
      kind.addEventListener("change", () => {
        amount.disabled = !proposalEditable || kind.value === "none";
        if (kind.value === "none") amount.value = "";
      });
      markupCell.append(kind, amount);

      const estimateCell = document.createElement("td");
      estimateCell.textContent = `${ui.formatPed(item.lineSalePed)} PED`;
      row.append(quantityCell, priceCell, markupCell, estimateCell);
      body.appendChild(row);
      editors.push({ item, quantity, kind, amount, estimateCell, row });
    });
    table.appendChild(body);
    article.appendChild(table);
    const addItemControl = createAddItemControl(order);
    if (addItemControl) article.appendChild(addItemControl);

    const total = document.createElement("p");
    total.className = "order-total";
    total.textContent = `Estimation totale : ${ui.formatPed(order.totalSalePed)} PED`;
    article.appendChild(total);
    const saveRow = document.createElement("div");
    saveRow.className = "order-save-row";
    const dirtyLabel = document.createElement("span");
    dirtyLabel.className = "order-dirty";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Enregistrer les modifications";
    save.disabled = true;
    saveRow.append(dirtyLabel, save);
    article.appendChild(saveRow);

    if (!proposalEditable) {
      save.hidden = true;
      saveRow.classList.add("is-locked");
      dirtyLabel.textContent = "Quantités et MU verrouillés à partir du statut À préparer.";
    }

    const readEditor = (editor) => {
      const quantity = Number(editor.quantity.value);
      const markupKind = editor.kind.value;
      const markupAmount = markupKind === "none" ? null : Number(editor.amount.value);
      const unitTt = Number(editor.item.unitTtPed || 0);
      const valid = Number.isInteger(quantity) && quantity > 0 && quantity <= 1_000_000
        && (markupKind === "none" || (
          Number.isFinite(markupAmount) && markupAmount >= 0 && markupAmount <= 1_000_000
          && hasAtMostDecimals(markupAmount, 6)
        ));
      let unitSale = unitTt;
      if (valid && markupKind === "percent") unitSale = unitTt * (markupAmount / 100);
      if (valid && markupKind === "ped") unitSale = unitTt + markupAmount;
      const lineSale = valid ? ui.roundPed(unitSale * quantity) : null;
      const originalAmount = editor.item.markupKind === "percent"
        ? Number(editor.item.markupValue || 0) * 100
        : (editor.item.markupKind === "ped" ? Number(editor.item.markupValue || 0) : null);
      const dirty = valid && (
        quantity !== Number(editor.item.quantity)
        || markupKind !== editor.item.markupKind
        || (markupKind !== "none" && Math.abs(markupAmount - originalAmount) > 1e-7)
      );
      return { lineNo: editor.item.lineNo, quantity, markupKind, markupAmount, lineSale, valid, dirty };
    };

    const recalculate = () => {
      const values = editors.map(readEditor);
      editors.forEach((editor, index) => {
        editor.estimateCell.textContent = values[index].valid
          ? `${ui.formatPed(values[index].lineSale)} PED`
          : "—";
        editor.row.classList.toggle("is-dirty", values[index].dirty);
      });
      const valid = values.every((value) => value.valid);
      const dirtyCount = values.filter((value) => value.dirty).length;
      const totalValue = valid ? ui.roundPed(values.reduce((sum, value) => sum + value.lineSale, 0)) : null;
      total.textContent = valid ? `Estimation totale : ${ui.formatPed(totalValue)} PED` : "Estimation totale : —";
      if (proposalEditable) dirtyLabel.textContent = dirtyCount ? `${dirtyCount} ligne(s) modifiée(s)` : "";
      save.disabled = !proposalEditable || !valid || dirtyCount === 0;
      return values;
    };

    editors.forEach((editor) => {
      editor.quantity.addEventListener("input", recalculate);
      editor.amount.addEventListener("input", recalculate);
      editor.kind.addEventListener("change", recalculate);
    });
    if (proposalEditable) {
      save.addEventListener("click", () => updateProposal(order.id, recalculate(), save));
    }
    recalculate();

    if (order.buyerComment) {
      const comment = document.createElement("p");
      comment.className = "order-comment";
      comment.textContent = order.buyerComment;
      article.appendChild(comment);
    }
    article.appendChild(createHistoryPanel(order));
    return article;
  }

  function createDirectLineEditor(catalogItems, options = {}) {
    const sortedCatalogItems = [...catalogItems].sort(compareCatalogItems);
    const root = document.createElement("div");
    root.className = options.sharedHeadings
      ? "direct-order-line has-shared-headings"
      : "direct-order-line";
    const articleLabel = document.createElement("label");
    articleLabel.className = "direct-order-field";
    const articleHeading = document.createElement("span");
    articleHeading.className = "direct-order-field-label";
    articleHeading.textContent = "Article";
    const article = document.createElement("input");
    article.type = "search";
    article.required = true;
    article.placeholder = "Choisissez un article dans la liste…";
    article.setAttribute("autocomplete", "off");
    article.setAttribute("spellcheck", "false");
    article.setAttribute("aria-label", "Article de la demande directe");
    directOrderListSequence += 1;
    const listId = `direct-order-articles-${directOrderListSequence}`;
    const choices = new Map();
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    article.setAttribute("list", listId);
    sortedCatalogItems.forEach((item) => {
      const label = catalogItemChoiceLabel(item);
      choices.set(label, item);
    });
    const normalizeSearch = (value) => String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr");
    const renderSuggestions = () => {
      const query = normalizeSearch(article.value);
      const options = [];
      choices.forEach((_item, label) => {
        if (query && !normalizeSearch(label).includes(query)) return;
        const option = document.createElement("option");
        option.value = label;
        options.push(option);
      });
      datalist.replaceChildren(...options);
    };
    renderSuggestions();
    article.value = "";
    articleLabel.append(articleHeading, article, datalist);

    const quantityLabel = document.createElement("label");
    quantityLabel.className = "direct-order-field";
    const quantityHeading = document.createElement("span");
    quantityHeading.className = "direct-order-field-label";
    quantityHeading.textContent = "Quantité";
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.min = "1";
    quantity.step = "1";
    quantity.value = "1";
    quantity.required = true;
    quantity.setAttribute("aria-label", "Quantité de la demande directe");
    quantityLabel.append(quantityHeading, quantity);

    const markupLabel = document.createElement("label");
    markupLabel.className = "direct-order-field";
    const markupHeading = document.createElement("span");
    markupHeading.className = "direct-order-field-label";
    markupHeading.textContent = "MU";
    const markupFields = document.createElement("span");
    markupFields.className = "direct-markup-fields";
    const kind = document.createElement("select");
    [["percent", "%"], ["ped", "PED"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      kind.appendChild(option);
    });
    kind.value = "percent";
    kind.setAttribute("aria-label", "Type de MU de la demande directe");
    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "0";
    amount.max = "1000000";
    amount.step = "0.01";
    amount.value = "";
    amount.required = true;
    amount.setAttribute("aria-label", "Valeur de MU de la demande directe");
    markupFields.append(kind, amount);
    markupLabel.append(markupHeading, markupFields);

    const output = document.createElement("div");
    output.className = "direct-order-line-output";
    const stock = document.createElement("span");
    const discount = document.createElement("small");
    discount.className = "order-discount-marker";
    const discountEmphasis = document.createElement("em");
    discount.appendChild(discountEmphasis);
    const displayedPrice = document.createElement("span");
    const estimate = document.createElement("strong");
    output.append(stock, discount, displayedPrice, estimate);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "direct-order-remove";
    remove.textContent = "Retirer";

    const selectedItem = () => choices.get(article.value) || null;
    const applyCatalogMarkup = (frjMember = options.frjMember === true) => {
      const item = selectedItem();
      if (!item) {
        kind.value = "percent";
        amount.value = "";
        return;
      }
      const itemKind = item?.markupKind === "ped" || item?.markupKind === "percent"
        ? item.markupKind
        : "percent";
      const storedValue = Number(item?.markupValue);
      let displayedAmount = itemKind === "percent" ? 100 : 0;
      if (item?.markupValue !== null && item?.markupValue !== "" && Number.isFinite(storedValue)) {
        const profileFactor = frjMember ? 0.5 : 1;
        const rate = Number(item?.discountRate);
        const campaignFactor = Number.isFinite(rate) && rate > 0 && rate <= 1 ? 1 - rate : 1;
        displayedAmount = itemKind === "percent"
          ? (1 + ((storedValue - 1) * profileFactor * campaignFactor)) * 100
          : storedValue * profileFactor * campaignFactor;
      }
      kind.value = itemKind;
      amount.value = ui.roundPed(displayedAmount).toFixed(2);
    };

    const read = () => {
      const item = selectedItem();
      const itemQuantity = Number(quantity.value);
      const markupAmount = Number(amount.value);
      const valid = Boolean(item)
        && Number.isInteger(itemQuantity)
        && itemQuantity > 0
        && itemQuantity <= Number(item.availableStock || 0)
        && Number.isFinite(markupAmount)
        && markupAmount >= 0
        && markupAmount <= 1_000_000
        && hasAtMostDecimals(markupAmount, 2);
      let unitSale = Number(item?.unitTtPed || 0);
      if (valid && kind.value === "percent") unitSale *= markupAmount / 100;
      if (valid && kind.value === "ped") unitSale += markupAmount;
      const lineSale = valid ? ui.roundPed(unitSale * itemQuantity) : null;
      return {
        valid,
        lineSale,
        key: item ? `${item.itemName}\u001f${item.storage}\u001f${item.aisle}`.toLocaleLowerCase("en-US") : "",
        payload: item ? {
          itemName: item.itemName,
          storage: item.storage,
          aisle: item.aisle,
          quantity: itemQuantity,
          markupKind: kind.value,
          markupAmount,
          discountKind: item.discountKind || null,
          discountCampaignId: item.discountCampaignId || null,
          discountRate: item.discountRate ?? null
        } : null
      };
    };
    const refresh = () => {
      const item = selectedItem();
      quantity.max = item ? String(item.availableStock) : "";
      const value = read();
      stock.textContent = item ? `Stock : ${ui.formatQuantity(item.availableStock)}` : "Stock : —";
      const discountLabel = item ? ui.discountMarker(item) : "";
      discountEmphasis.textContent = discountLabel ? `(${discountLabel})` : "";
      discount.hidden = !discountLabel;
      displayedPrice.textContent = item ? `Prix affiché : ${ui.formatPed(item.unitTtPed)} PED` : "Prix affiché : —";
      estimate.textContent = value.valid ? `Estimation : ${ui.formatPed(value.lineSale)} PED` : "Estimation : —";
      options.onChange?.();
      return value;
    };
    const refreshSelectedItem = () => {
      renderSuggestions();
      applyCatalogMarkup();
      refresh();
    };
    article.addEventListener("input", refreshSelectedItem);
    article.addEventListener("change", refreshSelectedItem);
    quantity.addEventListener("input", refresh);
    amount.addEventListener("input", refresh);
    kind.addEventListener("change", () => {
      amount.value = kind.value === "percent" ? "100.00" : "0.00";
      refresh();
    });
    root.append(articleLabel, quantityLabel, markupLabel, output, remove);
    const editor = {
      root,
      read,
      refresh,
      remove,
      setProfile(frjMember) {
        options.frjMember = frjMember === true;
        applyCatalogMarkup(options.frjMember);
        refresh();
      }
    };
    remove.addEventListener("click", () => options.onRemove?.(editor));
    refresh();
    return editor;
  }

  function appendDiscountMarker(parent, item) {
    const label = ui.discountMarker(item);
    if (!label) return;
    const marker = document.createElement("small");
    marker.className = "order-discount-marker";
    const emphasis = document.createElement("em");
    emphasis.textContent = `(${label})`;
    marker.appendChild(emphasis);
    parent.append(" ", marker);
  }

  function initializeNewOrderForm() {
    const toggle = document.getElementById("newOrderToggle");
    const panel = document.getElementById("newOrderPanel");
    const form = document.getElementById("newOrderForm");
    if (!toggle || !panel || !form) return;
    toggle.addEventListener("click", () => {
      clearNewOrderResult();
      panel.hidden = !panel.hidden;
      toggle.textContent = panel.hidden ? "Ajouter une nouvelle demande" : "Masquer le formulaire";
      if (!panel.hidden && !newOrderEditors.length) addNewOrderLine();
    });
    document.getElementById("newOrderAddLine").addEventListener("click", addNewOrderLine);
    document.getElementById("newOrderProfile").addEventListener("change", (event) => {
      const frjMember = event.target.value === "frj";
      newOrderEditors.forEach((editor) => editor.setProfile(frjMember));
      updateNewOrderForm();
    });
    document.getElementById("newOrderCancel").addEventListener("click", () => {
      resetNewOrderForm();
      clearNewOrderResult();
      panel.hidden = true;
      toggle.textContent = "Ajouter une nouvelle demande";
    });
    form.addEventListener("submit", submitNewOrder);
  }

  function addNewOrderLine() {
    if (!orderCatalog.length || newOrderEditors.length >= 10) return;
    let editor;
    editor = createDirectLineEditor(orderCatalog, {
      frjMember: document.getElementById("newOrderProfile").value === "frj",
      sharedHeadings: true,
      onChange: updateNewOrderForm,
      onRemove: () => {
        newOrderEditors = newOrderEditors.filter((candidate) => candidate !== editor);
        renderNewOrderLines();
      }
    });
    newOrderEditors.push(editor);
    renderNewOrderLines();
  }

  function createDirectLinesHeader() {
    const header = document.createElement("div");
    header.className = "direct-order-lines-header";
    header.setAttribute("aria-hidden", "true");
    ["Article", "Quantité", "MU", "Détails de la ligne", ""].forEach((heading) => {
      const cell = document.createElement("span");
      cell.textContent = heading;
      header.appendChild(cell);
    });
    return header;
  }

  function renderNewOrderLines() {
    const container = document.getElementById("newOrderLines");
    if (!container) return;
    const lines = newOrderEditors.map((editor) => editor.root);
    container.replaceChildren(...(lines.length ? [createDirectLinesHeader(), ...lines] : []));
    newOrderEditors.forEach((editor) => { editor.remove.hidden = newOrderEditors.length === 1; });
    updateNewOrderForm();
  }

  function updateNewOrderForm() {
    const total = document.getElementById("newOrderTotal");
    const save = document.getElementById("newOrderSave");
    const add = document.getElementById("newOrderAddLine");
    if (!total || !save || !add) return [];
    const values = newOrderEditors.map((editor) => editor.read());
    const keys = values.map((value) => value.key).filter(Boolean);
    const duplicates = new Set(keys).size !== keys.length;
    const valid = values.length > 0 && values.every((value) => value.valid) && !duplicates;
    total.textContent = valid
      ? `Estimation totale : ${ui.formatPed(values.reduce((sum, value) => sum + value.lineSale, 0))} PED`
      : (duplicates ? "Un même article ne peut pas être ajouté deux fois." : "Estimation totale : —");
    save.disabled = !valid;
    add.disabled = newOrderEditors.length >= 10;
    return values;
  }

  function resetNewOrderForm() {
    document.getElementById("newOrderForm")?.reset();
    newOrderEditors = [];
    document.getElementById("newOrderLines")?.replaceChildren();
    const feedback = document.getElementById("newOrderFeedback");
    if (feedback) {
      feedback.textContent = "";
      feedback.className = "new-order-feedback";
    }
  }

  function clearNewOrderResult() {
    const resultPanel = document.getElementById("newOrderResult");
    if (!resultPanel) return;
    resultPanel.replaceChildren();
    resultPanel.hidden = true;
  }

  async function submitNewOrder(event) {
    event.preventDefault();
    const values = updateNewOrderForm();
    const save = document.getElementById("newOrderSave");
    const feedback = document.getElementById("newOrderFeedback");
    const resultPanel = document.getElementById("newOrderResult");
    if (!values.length || values.some((value) => !value.valid)) return;
    save.disabled = true;
    save.textContent = "Enregistrement…";
    feedback.className = "new-order-feedback";
    feedback.textContent = "Création de la demande et publication Discord…";
    resultPanel.hidden = true;
    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerAvatar: document.getElementById("newOrderAvatar").value,
          frjMember: document.getElementById("newOrderProfile").value === "frj",
          items: values.map((value) => value.payload)
        })
      });
      const result = await response.json();
      const trackingUrl = new URL(result.trackingPath, global.location.href).href;
      const copied = await copyTrackingUrl(trackingUrl);
      const message = document.createElement("p");
      message.textContent = `${result.order.publicReference} créée au statut À valider.${copied ? " Lien copié." : ""}`;
      const link = document.createElement("a");
      link.href = trackingUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Ouvrir le suivi client";
      resultPanel.replaceChildren(message, link);
      resultPanel.hidden = false;
      feedback.textContent = "Demande enregistrée.";
      resetNewOrderForm();
      await loadOrders();
    } catch (error) {
      feedback.className = "new-order-feedback error";
      feedback.textContent = error.message;
    } finally {
      save.textContent = "Enregistrer la demande";
      updateNewOrderForm();
    }
  }

  function createAddItemControl(order) {
    if (!ui.canEditProposal(order.status) || (order.items || []).length >= 10) return null;
    const section = document.createElement("section");
    section.className = "order-add-item";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "order-add-item-toggle";
    toggle.textContent = orderCatalog.length ? "Ajouter un article" : "Chargement du catalogue…";
    toggle.disabled = !orderCatalog.length;
    const form = document.createElement("div");
    form.className = "order-add-item-form";
    form.hidden = true;
    toggle.addEventListener("click", () => {
      form.hidden = !form.hidden;
      toggle.textContent = form.hidden ? "Ajouter un article" : "Masquer l’ajout";
      if (form.children.length) return;
      const existing = new Set((order.items || []).map((item) => (
        `${item.itemName}\u001f${item.storage}\u001f${item.aisle}`.toLocaleLowerCase("en-US")
      )));
      const available = orderCatalog.filter((item) => !existing.has(
        `${item.itemName}\u001f${item.storage}\u001f${item.aisle}`.toLocaleLowerCase("en-US")
      ));
      const feedback = document.createElement("p");
      feedback.className = "new-order-feedback";
      if (!available.length) {
        feedback.textContent = "Tous les articles disponibles sont déjà présents dans cette demande.";
        form.appendChild(feedback);
        return;
      }
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Ajouter à la proposition";
      save.disabled = true;
      let editor;
      editor = createDirectLineEditor(available, {
        frjMember: order.frjMember === true,
        onChange: () => { if (editor) save.disabled = !editor.read().valid; }
      });
      editor.remove.hidden = true;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Annuler";
      cancel.addEventListener("click", () => {
        form.hidden = true;
        toggle.textContent = "Ajouter un article";
      });
      const actions = document.createElement("div");
      actions.className = "order-add-item-actions";
      actions.append(cancel, save);
      save.addEventListener("click", async () => {
        const value = editor.read();
        if (!value.valid) return;
        save.disabled = true;
        save.textContent = "Ajout…";
        feedback.textContent = "";
        try {
          await global.FRJ_API.fetchD1Admin(`/admin/orders/${encodeURIComponent(order.id)}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(value.payload)
          });
          await loadOrders();
        } catch (error) {
          feedback.className = "new-order-feedback error";
          feedback.textContent = error.message;
          save.disabled = false;
          save.textContent = "Ajouter à la proposition";
        }
      });
      form.append(editor.root, actions, feedback);
    });
    section.append(toggle, form);
    return section;
  }

  function createTrackingControl(order) {
    const control = document.createElement("div");
    control.className = "order-tracking-control";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "order-tracking-button";
    button.textContent = "Suivre la demande";
    const feedback = document.createElement("p");
    feedback.className = "order-tracking-feedback";
    feedback.hidden = true;
    let trackingUrl = "";

    button.addEventListener("click", async () => {
      const trackingWindow = openTrackingWindow();
      button.disabled = true;
      button.textContent = trackingUrl ? "Ouverture…" : "Création du lien…";
      feedback.hidden = true;
      try {
        if (!trackingUrl) {
          const response = await global.FRJ_API.fetchD1Admin(
            `/admin/orders/${encodeURIComponent(order.id)}/tracking-link`,
            { method: "POST", cache: "no-store" }
          );
          const result = await response.json();
          if (!result.trackingPath || !result.accessToken) {
            throw new Error("Le Worker n’a pas renvoyé de lien de suivi valide.");
          }
          trackingUrl = new URL(result.trackingPath, global.location.href).href;
        }

        const copied = await copyTrackingUrl(trackingUrl);
        if (trackingWindow) {
          trackingWindow.opener = null;
          trackingWindow.location.href = trackingUrl;
        }
        const message = document.createElement("span");
        message.textContent = trackingWindow && copied
          ? "Lien ouvert et copié. "
          : (trackingWindow
            ? "Lien ouvert ; copie automatique indisponible. "
            : (copied ? "Lien copié. " : "Lien prêt. "));
        const link = document.createElement("a");
        link.href = trackingUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Ouvrir le suivi client";
        feedback.className = "order-tracking-feedback success";
        feedback.replaceChildren(message, link);
        feedback.hidden = false;
        button.textContent = "Ouvrir à nouveau";
      } catch (error) {
        if (trackingWindow && typeof trackingWindow.close === "function") trackingWindow.close();
        feedback.className = "order-tracking-feedback error";
        feedback.textContent = `Lien indisponible : ${error.message}`;
        feedback.hidden = false;
        button.textContent = "Suivre la demande";
      } finally {
        button.disabled = false;
      }
    });

    control.append(button, feedback);
    return control;
  }

  function openTrackingWindow() {
    try {
      return typeof global.open === "function" ? global.open("about:blank", "_blank") : null;
    } catch {
      return null;
    }
  }

  async function copyTrackingUrl(trackingUrl) {
    try {
      if (typeof global.navigator?.clipboard?.writeText !== "function") return false;
      await global.navigator.clipboard.writeText(trackingUrl);
      return true;
    } catch {
      return false;
    }
  }

  function createHistoryPanel(order) {
    const section = document.createElement("section");
    section.className = "order-history";
    const panelId = `order-history-${order.id}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "order-history-toggle";
    toggle.textContent = "Afficher l’historique";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", panelId);

    const panel = document.createElement("div");
    panel.id = panelId;
    panel.className = "order-history-panel";
    panel.hidden = true;
    let loaded = false;
    let loading = false;

    toggle.addEventListener("click", async () => {
      const shouldOpen = panel.hidden;
      panel.hidden = !shouldOpen;
      toggle.setAttribute("aria-expanded", String(shouldOpen));
      toggle.textContent = shouldOpen ? "Masquer l’historique" : "Afficher l’historique";
      if (!shouldOpen || loaded || loading) return;

      loading = true;
      toggle.disabled = true;
      const pending = document.createElement("p");
      pending.className = "order-history-message";
      pending.textContent = "Chargement de l’historique…";
      panel.replaceChildren(pending);
      try {
        const response = await global.FRJ_API.fetchD1Admin(
          `/admin/orders/${encodeURIComponent(order.id)}/history`,
          { cache: "no-store" }
        );
        const history = await response.json();
        renderOrderHistory(order, panel, history.events || []);
        loaded = true;
      } catch (error) {
        pending.className = "order-history-message error";
        pending.textContent = `Historique indisponible : ${error.message}`;
      } finally {
        loading = false;
        toggle.disabled = false;
      }
    });

    section.append(toggle, panel);
    return section;
  }

  function renderOrderHistory(order, panel, events) {
    if (!events.length) {
      const empty = document.createElement("p");
      empty.className = "order-history-message";
      empty.textContent = "Aucun événement d’historique.";
      panel.replaceChildren(empty);
      return;
    }

    const title = document.createElement("h3");
    title.textContent = "Vie de la demande";
    const list = document.createElement("ol");
    list.className = "order-history-list";
    list.reversed = true;
    list.start = events.length;
    [...events].reverse().forEach((historyEvent) => {
      list.appendChild(renderOrderHistoryEvent(order, historyEvent));
    });
    panel.replaceChildren(title, list);
  }

  function renderOrderHistoryEvent(order, historyEvent) {
    const item = document.createElement("li");
    item.className = "order-history-event";
    const meta = document.createElement("p");
    meta.className = "order-history-meta";
    const parts = [
      ui.formatDate(historyEvent.createdAt),
      HISTORY_ACTOR_LABELS[historyEvent.actor] || historyEvent.actor || "Système"
    ];
    if (historyEvent.newStatus) {
      parts.push(`Nouveau statut : ${ui.statusLabel(historyEvent.newStatus, "FR", "admin")}`);
    }
    meta.textContent = parts.join(" · ");

    const editor = document.createElement("div");
    editor.className = "order-history-editor";
    const textarea = document.createElement("textarea");
    textarea.rows = 2;
    textarea.maxLength = 500;
    textarea.value = historyEvent.comment || "";
    textarea.setAttribute("aria-label", `Commentaire historique du ${ui.formatDate(historyEvent.createdAt)}`);
    const controls = document.createElement("div");
    controls.className = "order-history-controls";
    const feedback = document.createElement("span");
    feedback.className = "order-history-feedback";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Enregistrer le commentaire";
    save.disabled = true;
    let savedComment = textarea.value.trim();

    textarea.addEventListener("input", () => {
      save.disabled = textarea.value.trim() === savedComment;
      feedback.textContent = "";
      feedback.className = "order-history-feedback";
    });
    save.addEventListener("click", async () => {
      save.disabled = true;
      textarea.disabled = true;
      feedback.textContent = "Enregistrement…";
      feedback.className = "order-history-feedback";
      try {
        const response = await global.FRJ_API.fetchD1Admin(
          `/admin/orders/${encodeURIComponent(order.id)}/history/${encodeURIComponent(historyEvent.id)}/comment`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ comment: textarea.value })
          }
        );
        const result = await response.json();
        textarea.value = result.event?.comment || textarea.value;
        savedComment = textarea.value.trim();
        feedback.textContent = "Commentaire enregistré.";
        feedback.className = "order-history-feedback success";
      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = "order-history-feedback error";
        save.disabled = false;
      } finally {
        textarea.disabled = false;
      }
    });

    controls.append(feedback, save);
    editor.append(textarea, controls);
    item.append(meta, editor);
    return item;
  }

  async function updateStatus(id, select) {
    select.disabled = true;
    try {
      await global.FRJ_API.fetchD1Admin(`/admin/orders/${encodeURIComponent(id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: select.value })
      });
      await loadOrders();
    } catch (error) {
      global.alert(error.message);
      await loadOrders();
    } finally {
      select.disabled = false;
    }
  }

  async function updateProposal(orderId, items, save) {
    save.disabled = true;
    save.textContent = "Enregistrement…";
    try {
      await global.FRJ_API.fetchD1Admin(`/admin/orders/${encodeURIComponent(orderId)}/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map(({ lineNo, quantity, markupKind, markupAmount }) => ({
            lineNo,
            quantity,
            markupKind,
            markupAmount
          }))
        })
      });
      await loadOrders();
    } catch (error) {
      global.alert(error.message);
      save.disabled = false;
      save.textContent = "Enregistrer les modifications";
    }
  }

  document.getElementById("refreshOrders").addEventListener("click", loadOrders);
  initializeNewOrderForm();
  loadOrders().then(loadOrderCatalog);
})(window);
