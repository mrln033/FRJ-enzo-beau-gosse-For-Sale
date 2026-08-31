import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../promotions.html", import.meta.url), "utf8");
const controller = fs.readFileSync(new URL("../js/pages/promotions.js", import.meta.url), "utf8");
const menu = fs.readFileSync(new URL("../js/admin-menu.js", import.meta.url), "utf8");
const catalog = fs.readFileSync(new URL("../js/pages/index.js", import.meta.url), "utf8");
const cart = fs.readFileSync(new URL("../js/cart.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../css/site.css", import.meta.url), "utf8");

test("d.9 fournit une page Admin séparée pour promotions et soldes", () => {
  assert.match(html, /id="discountConfigForm"/);
  assert.match(html, /id="dailyPromotionForm"/);
  assert.match(html, /id="saleForm"/);
  assert.match(html, /js\/pages\/promotions\.js/);
  assert.doesNotMatch(html, /<script>(?:.|\n)*<\/script>/);
  assert.match(controller, /\/admin\/discounts\/generate/);
  assert.match(controller, /\/admin\/discounts\/campaigns/);
  assert.match(controller, /campaign\.editable === true/);
  assert.match(controller, /campaign\.editMode === "rate-only"/);
  assert.match(controller, /aujourd’hui — taux uniquement/);
  assert.match(controller, /seul le taux reste modifiable/);
  assert.match(controller, /terminée — lecture seule/);
  assert.match(html, /Compléter aujourd’hui et préparer demain/);
  assert.match(controller, /result\.today && result\.tomorrow/);
  assert.match(menu, /section: "discounts"/);
  assert.match(menu, /pathname\.includes\("promotions"\)/);
});

test("d.9 affiche la remise et la transmet avec le panier", () => {
  assert.match(styles, /Sticker Promo - FR\.png/);
  assert.match(styles, /Sticker Promo - EN\.png/);
  assert.match(styles, /Sticker Solde - FR\.png/);
  assert.match(styles, /Sticker Solde - EN\.png/);
  assert.match(catalog, /promo-sticker \$\{item\.REMISE_TYPE === "sale" \? "sale" : "daily-promo"\} \$\{currentLang === "FR" \? "fr" : "en"\}/);
  assert.match(styles, /\.card-front,\s*\r?\n\.card-back\s*{\s*\r?\n\s*position:\s*absolute/);
  assert.doesNotMatch(styles, /\.card-front\s*{\s*position:\s*relative/);
  assert.match(catalog, /applyItemDiscountToMU/);
  assert.match(cart, /discountCampaignId/);
  assert.match(cart, /discountRate/);
  assert.match(cart, /effectiveMarkup/);
});
