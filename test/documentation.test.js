import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const documentationFiles = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/PANIER.md",
  "gas/README.md",
  "cloudflare/for-sale-api/README.md",
  "cloudflare/for-sale-api/MIGRATION.md"
];

test("les liens locaux de la documentation ciblent des fichiers existants", async () => {
  for (const relativeFile of documentationFiles) {
    const absoluteFile = path.join(root, relativeFile);
    const markdown = await readFile(absoluteFile, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(absoluteFile), decodeURIComponent(target));
      await assert.doesNotReject(access(resolved), `${relativeFile} référence un fichier absent : ${target}`);
    }
  }
});

test("la documentation d.3 décrit l'architecture finale", async () => {
  const architecture = await readFile(path.join(root, "docs/ARCHITECTURE.md"), "utf8");
  assert.equal(architecture.match(/\*\*Terminé \(d\.3\.\d\)\.\*\*/g)?.length, 9);
  assert.doesNotMatch(architecture, /Cette arborescence sera mise en place progressivement/);
});

test("les guides de déploiement ne décrivent plus un frontend local non publié", async () => {
  const workerReadme = await readFile(path.join(root, "cloudflare/for-sale-api/README.md"), "utf8");
  const migration = await readFile(path.join(root, "cloudflare/for-sale-api/MIGRATION.md"), "utf8");
  assert.doesNotMatch(workerReadme, /modifications ne sont pas encore publiées/i);
  assert.doesNotMatch(migration, /frontend publié n'est pas encore modifié/i);
});
