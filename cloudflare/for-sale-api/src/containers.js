const MAX_CONTAINER_CHANGES = 500;
const MAX_CONTAINER_KEY_LENGTH = 240;

export function normalizeContainerConfigPayload(payload, avatarSheets) {
  const avatar = String(payload?.avatar || "").trim().toLowerCase();
  if (!avatarSheets[avatar]) throw new Error(`Avatar inconnu : ${avatar || "absent"}`);

  const containers = payload?.containers;
  if (!Array.isArray(containers) || containers.length < 1 || containers.length > MAX_CONTAINER_CHANGES) {
    throw new Error(`La configuration doit contenir entre 1 et ${MAX_CONTAINER_CHANGES} conteneurs`);
  }

  const seen = new Set();
  const changes = containers.map((entry) => {
    const containerKey = String(entry?.containerKey || "").trim().toLowerCase();
    if (!containerKey || containerKey.length > MAX_CONTAINER_KEY_LENGTH) {
      throw new Error("Clé de conteneur invalide");
    }
    if (typeof entry?.enabled !== "boolean") {
      throw new Error(`État invalide pour le conteneur : ${containerKey}`);
    }
    if (seen.has(containerKey)) throw new Error(`Conteneur dupliqué : ${containerKey}`);
    seen.add(containerKey);
    return { containerKey, enabled: entry.enabled };
  });

  return { avatar, changes };
}

export function mapContainerConfigRow(row) {
  return {
    containerKey: String(row.container_key || ""),
    container: String(row.container || ""),
    enabled: Number(row.enabled || 0) === 1,
    updatedAt: row.updated_at || null
  };
}

export function diffContainerConfig(changes, existingRows) {
  const existing = new Map(existingRows.map((row) => [
    String(row.container_key),
    Number(row.enabled || 0) === 1
  ]));
  return {
    missing: changes.filter((entry) => !existing.has(entry.containerKey)).map((entry) => entry.containerKey),
    changed: changes.filter((entry) => existing.has(entry.containerKey) && existing.get(entry.containerKey) !== entry.enabled)
  };
}
