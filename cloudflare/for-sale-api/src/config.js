export const MAX_IMPORT_BYTES = 1_800_000;
export const MAX_OBSERVATION_BYTES = 2_200_000;
export const MAX_ORDER_BYTES = 80_000;
export const SYNC_AUDIT_RETENTION_COUNT = 500;

export const PUBLIC_ORIGINS = new Set([
  "https://mrln033.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

export const AVATAR_SHEETS = {
  enzo: "Inventaire Enzo",
  arkaman: "Inventaire ArkaMan",
  kenza: "Inventaire Kenza",
  nocturnal: "Inventaire Nocturnal"
};

export const SYNC_DATASETS = new Set([
  "catalog",
  "mu",
  "containers",
  ...Object.keys(AVATAR_SHEETS).map((avatar) => `inventory:${avatar}`)
]);
