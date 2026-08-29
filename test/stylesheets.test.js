import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const htmlFiles = (await readdir(root)).filter((name) => name.endsWith(".html"));
const commandesCss = await readFile(path.join(root, "css/pages/commandes.css"), "utf8");

test("toutes les feuilles référencées par les pages existent", async () => {
  for (const name of htmlFiles) {
    const html = await readFile(path.join(root, name), "utf8");
    const references = [...html.matchAll(/href="(\.\/[^"?]+\.css)(?:\?[^\"]*)?"/g)];
    for (const [, reference] of references) {
      await assert.doesNotReject(
        access(path.join(root, reference.slice(2))),
        `${name} référence une feuille absente : ${reference}`
      );
    }
  }
});

test("les pages HTML ne contiennent plus de bloc de styles intégré", async () => {
  for (const name of htmlFiles) {
    const html = await readFile(path.join(root, name), "utf8");
    assert.doesNotMatch(html, /<style(?:\s[^>]*)?>/i, `${name} contient encore un bloc <style>`);
  }
});

test("les anciennes feuilles racine ont été remplacées par css/", async () => {
  for (const name of ["style.css", "cart.css", "maj_css.css"]) {
    await assert.rejects(access(path.join(root, name)));
  }
  for (const name of [
    "css/site.css",
    "css/components/cart.css",
    "css/pages/imports.css",
    "css/pages/sync-report.css",
    "css/pages/commandes.css",
    "css/pages/conteneurs.css",
    "css/pages/suivi-commande.css"
  ]) {
    await assert.doesNotReject(access(path.join(root, name)));
  }
});

test("le formulaire d'ajout d'article respecte son attribut hidden", () => {
  assert.match(commandesCss, /\.order-add-item-form\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});
