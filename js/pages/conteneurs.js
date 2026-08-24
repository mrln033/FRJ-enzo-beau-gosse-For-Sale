(function initContainersPage(global) {
  "use strict";

  if (!global.FRJ_ADMIN.require()) return;

  const elements = {
    avatar: document.getElementById("containerAvatar"),
    search: document.getElementById("containerSearch"),
    filter: document.getElementById("containerFilter"),
    reload: document.getElementById("reloadContainers"),
    clearToken: document.getElementById("clearContainersToken"),
    loading: document.getElementById("containersLoading"),
    error: document.getElementById("containersError"),
    content: document.getElementById("containersContent"),
    summary: document.getElementById("containersSummary"),
    saveStatus: document.getElementById("containersSaveStatus"),
    save: document.getElementById("saveContainers"),
    list: document.getElementById("containersList")
  };
  let avatar = "enzo";
  let containers = [];
  let baseline = new Map();
  let busy = false;

  elements.avatar.addEventListener("change", handleAvatarChange);
  elements.search.addEventListener("input", render);
  elements.filter.addEventListener("change", render);
  elements.reload.addEventListener("click", handleReload);
  elements.clearToken.addEventListener("click", () => {
    global.FRJ_API.clearAdminToken();
    loadContainers(avatar);
  });
  elements.save.addEventListener("click", saveChanges);
  global.addEventListener("beforeunload", (event) => {
    if (!countChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  function countChanges() {
    return containers.reduce(
      (count, container) => count + (baseline.get(container.containerKey) !== container.enabled ? 1 : 0),
      0
    );
  }

  function setBusy(value) {
    busy = value;
    elements.avatar.disabled = value;
    elements.reload.disabled = value;
    elements.clearToken.disabled = value;
    elements.save.disabled = value || countChanges() === 0;
  }

  function populateAvatars(avatars) {
    const options = (avatars || []).map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.sheet;
      return option;
    });
    elements.avatar.replaceChildren(...options);
    elements.avatar.value = avatar;
  }

  async function loadContainers(requestedAvatar) {
    setBusy(true);
    elements.loading.hidden = false;
    elements.error.hidden = true;
    elements.saveStatus.textContent = "";
    try {
      const response = await global.FRJ_API.fetchD1Admin(
        `/admin/containers?avatar=${encodeURIComponent(requestedAvatar)}`,
        { cache: "no-store" }
      );
      const result = await response.json();
      avatar = result.avatar;
      containers = (result.containers || []).map((container) => ({ ...container }));
      baseline = new Map(containers.map((container) => [container.containerKey, container.enabled]));
      populateAvatars(result.avatars);
      elements.content.hidden = false;
      render();
    } catch (error) {
      elements.content.hidden = true;
      elements.error.textContent = error.message;
      elements.error.hidden = false;
      elements.avatar.value = avatar;
    } finally {
      elements.loading.hidden = true;
      setBusy(false);
    }
  }

  function filteredContainers() {
    const search = elements.search.value.trim().toLocaleLowerCase("fr-FR");
    const filter = elements.filter.value;
    return containers.filter((container) => {
      if (search && !container.container.toLocaleLowerCase("fr-FR").includes(search)) return false;
      if (filter === "enabled" && !container.enabled) return false;
      if (filter === "disabled" && container.enabled) return false;
      return true;
    });
  }

  function render() {
    const visible = filteredContainers();
    const enabledCount = containers.filter((container) => container.enabled).length;
    const changes = countChanges();
    elements.summary.textContent = `${enabledCount} activé${enabledCount > 1 ? "s" : ""} sur ${containers.length} — ${visible.length} affiché${visible.length > 1 ? "s" : ""}`;
    elements.saveStatus.textContent = changes
      ? `${changes} modification${changes > 1 ? "s" : ""} non enregistrée${changes > 1 ? "s" : ""}`
      : "Aucune modification en attente";
    elements.save.disabled = busy || changes === 0;

    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "containers-empty";
      empty.textContent = "Aucun conteneur ne correspond aux filtres.";
      elements.list.replaceChildren(empty);
      return;
    }

    const rows = visible.map((container) => {
      const row = document.createElement("label");
      const changed = baseline.get(container.containerKey) !== container.enabled;
      row.className = `container-row${container.enabled ? " enabled" : ""}${changed ? " changed" : ""}`;
      if (container.updatedAt) row.title = `Dernière modification D1 : ${container.updatedAt}`;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = container.enabled;
      checkbox.addEventListener("change", () => {
        container.enabled = checkbox.checked;
        render();
      });

      const name = document.createElement("span");
      name.className = "container-name";
      name.textContent = container.container;
      const state = document.createElement("span");
      state.className = "container-state";
      state.textContent = container.enabled ? "Inclus" : "Exclu";
      row.append(checkbox, name, state);
      return row;
    });
    elements.list.replaceChildren(...rows);
  }

  async function handleAvatarChange() {
    const requestedAvatar = elements.avatar.value;
    if (countChanges() && !global.confirm("Abandonner les modifications non enregistrées ?")) {
      elements.avatar.value = avatar;
      return;
    }
    await loadContainers(requestedAvatar);
  }

  async function handleReload() {
    if (countChanges() && !global.confirm("Abandonner les modifications non enregistrées ?")) return;
    await loadContainers(avatar);
  }

  async function saveChanges() {
    const changes = containers
      .filter((container) => baseline.get(container.containerKey) !== container.enabled)
      .map((container) => ({ containerKey: container.containerKey, enabled: container.enabled }));
    if (!changes.length) return;

    setBusy(true);
    elements.error.hidden = true;
    elements.saveStatus.textContent = "Enregistrement en cours…";
    try {
      const response = await global.FRJ_API.fetchD1Admin("/admin/containers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar, containers: changes })
      });
      const result = await response.json();
      baseline = new Map(containers.map((container) => [container.containerKey, container.enabled]));
      render();
      elements.saveStatus.textContent = `${result.changed} modification${result.changed > 1 ? "s" : ""} enregistrée${result.changed > 1 ? "s" : ""} dans D1.`;
    } catch (error) {
      elements.error.textContent = error.status === 409
        ? `${error.message} Utilisez « Recharger » pour récupérer la nouvelle liste.`
        : error.message;
      elements.error.hidden = false;
    } finally {
      setBusy(false);
    }
  }

  loadContainers(avatar);
})(window);
