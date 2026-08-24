import assert from "node:assert/strict";
import test from "node:test";
import {
  diffContainerConfig,
  mapContainerConfigRow,
  normalizeContainerConfigPayload
} from "../src/containers.js";

const avatars = {
  enzo: "Inventaire Enzo",
  arkaman: "Inventaire ArkaMan",
  kenza: "Inventaire Kenza",
  nocturnal: "Inventaire Nocturnal"
};

test("normalise une configuration de conteneurs D1", () => {
  assert.deepEqual(normalizeContainerConfigPayload({
    avatar: " EnZo ",
    containers: [
      { containerKey: " CARRIED ", enabled: true },
      { containerKey: "NI Armors", enabled: false }
    ]
  }, avatars), {
    avatar: "enzo",
    changes: [
      { containerKey: "carried", enabled: true },
      { containerKey: "ni armors", enabled: false }
    ]
  });
});

test("refuse les avatars, doublons et états invalides", () => {
  assert.throws(
    () => normalizeContainerConfigPayload({ avatar: "inconnu", containers: [{ containerKey: "A", enabled: true }] }, avatars),
    /Avatar inconnu/
  );
  assert.throws(
    () => normalizeContainerConfigPayload({
      avatar: "enzo",
      containers: [
        { containerKey: "CARRIED", enabled: true },
        { containerKey: " carried ", enabled: false }
      ]
    }, avatars),
    /dupliqué/
  );
  assert.throws(
    () => normalizeContainerConfigPayload({ avatar: "enzo", containers: [{ containerKey: "CARRIED", enabled: 1 }] }, avatars),
    /État invalide/
  );
});

test("convertit une ligne D1 sans exposer les entiers SQLite", () => {
  assert.deepEqual(mapContainerConfigRow({
    container_key: "carried",
    container: "CARRIED",
    enabled: 1,
    updated_at: "2026-08-24 10:00:00"
  }), {
    containerKey: "carried",
    container: "CARRIED",
    enabled: true,
    updatedAt: "2026-08-24 10:00:00"
  });
});

test("n'écrit que les choix modifiés et détecte une liste périmée", () => {
  const result = diffContainerConfig([
    { containerKey: "carried", enabled: true },
    { containerKey: "ni armors", enabled: true },
    { containerKey: "inconnu", enabled: false }
  ], [
    { container_key: "carried", enabled: 1 },
    { container_key: "ni armors", enabled: 0 }
  ]);
  assert.deepEqual(result, {
    missing: ["inconnu"],
    changed: [{ containerKey: "ni armors", enabled: true }]
  });
});
