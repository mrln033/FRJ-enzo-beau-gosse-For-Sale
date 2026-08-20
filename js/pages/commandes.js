(function initOrdersAdminPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const ui = global.FRJ_ORDER_UI;
  const STATUS_FILTER_KEY = "FRJ_ADMIN_ORDER_STATUS_FILTER_V1";
  const STATUS_KEYS = ui.statusKeys;
  let selectedStatuses = readSelectedStatuses();

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
      renderStatusFilters(orders, () => renderOrderResults(report, orders));
      renderOrderResults(report, orders);
    } catch (loadError) {
      list.replaceChildren();
      summary.textContent = "Chargement impossible";
      error.textContent = loadError.message;
      error.hidden = false;
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
      order.sourceBackend === "gas-fallback" ? "Reçue par secours GAS" : "Reçue par D1",
      order.frjMember ? "Membre FRJ" : "Public",
      order.buyerContact || "Pas de contact"
    ].forEach((value) => {
      const span = document.createElement("span");
      span.textContent = value;
      meta.appendChild(span);
    });
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
    header.append(identity, select);
    article.appendChild(header);

    if (order.status === "awaiting_approval") {
      const hint = document.createElement("p");
      hint.className = "approval-hint";
      hint.textContent = `Proposition n°${order.proposalVersion} en attente d’acceptation par le client.`;
      article.appendChild(hint);
    }

    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Article</th><th>Qté proposée</th><th>Prix affiché</th><th>MU ponctuel</th><th>Estimation vente</th></tr></thead>";
    const body = document.createElement("tbody");
    const editors = [];
    (order.items || []).forEach((item) => {
      const row = document.createElement("tr");
      const itemCell = document.createElement("td");
      itemCell.textContent = `${item.itemName} (${item.storage} · ${item.aisle})`;
      row.appendChild(itemCell);

      const quantityCell = document.createElement("td");
      const quantity = document.createElement("input");
      quantity.type = "number";
      quantity.min = "0.0001";
      quantity.max = "1000000";
      quantity.step = "0.0001";
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
      amount.step = "0.01";
      amount.value = item.markupKind === "percent"
        ? Number(item.markupValue || 0) * 100
        : (item.markupKind === "ped" ? Number(item.markupValue || 0) : "");
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
      const valid = Number.isFinite(quantity) && quantity > 0
        && (markupKind === "none" || (Number.isFinite(markupAmount) && markupAmount >= 0));
      let unitSale = unitTt;
      if (valid && markupKind === "percent") unitSale = unitTt * (markupAmount / 100);
      if (valid && markupKind === "ped") unitSale = unitTt + markupAmount;
      const lineSale = valid ? ui.roundPed(unitSale * quantity) : null;
      const originalAmount = editor.item.markupKind === "percent"
        ? Number(editor.item.markupValue || 0) * 100
        : (editor.item.markupKind === "ped" ? Number(editor.item.markupValue || 0) : null);
      const dirty = valid && (
        Math.abs(quantity - Number(editor.item.quantity)) > 0.0001
        || markupKind !== editor.item.markupKind
        || (markupKind !== "none" && Math.abs(markupAmount - originalAmount) > 0.0001)
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
    return article;
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
  loadOrders();
})(window);
