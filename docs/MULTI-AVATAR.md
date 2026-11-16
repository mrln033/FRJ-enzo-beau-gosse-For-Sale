# Multi-avatar & Sélecteurs de Catalogue (T-029.1)

Ce document détaille l'architecture et le fonctionnement du mode multi-avatar introduit dans le cadre de la tâche T-029 (lot T-029.1).

---

## 1. Contexte & Objectifs

La boutique FRJ proposait historiquement les articles et stocks liés à l'avatar principal **enzo beau gosse**.
Avec la réactivation de l'avatar **Nocturnal enzo FRJ**, le système supporte désormais la consultation multi-avatar :
- Référentiel catalogue commun dans un premier temps (`catalog_items` et `catalog_listings` partagés).
- Filtrage strict des stocks vendables par avatar (`avatar_id = 'enzo'` ou `'nocturnal'`).
- Synthèses de catégories et compteurs distincts par avatar.
- Dates de synchronisation d'inventaire distinctes (`inventory:enzo`, `inventory:nocturnal`).
- Sélecteur d'avatar discret dans l'en-tête du catalogue (`#avatarSelect`).
- Commande whisper InGame adaptée dynamiquement à l'avatar sélectionné.
- Traçabilité de l'avatar vendeur (`seller_avatar`) dans les commandes d'achat Cloudflare D1.

---

## 2. Architecture Backend (Cloudflare D1 & Worker)

### Normalisation de l'avatar
Dans `cloudflare/for-sale-api/src/application.js` :
- Helper `normalizeCatalogAvatar(requested)` : valide l'avatar demandé contre `AVATAR_SHEETS` (`enzo`, `nocturnal`, `arkaman`, `kenza`). En cas d'inconnu ou d'absence, repli systématique et sécurisé sur `"enzo"`.

### Routes publiques paramétrées
- `GET /?action=categorySummary&avatar=<id>` : compteurs d'articles en stock et catégories disponibles pour cet avatar.
- `GET /?action=categories&avatar=<id>` : liste simple des catégories disponibles avec stock > 0 pour cet avatar.
- `GET /?action=inventoryDate&avatar=<id>` : date de dernière importation de l'inventaire spécifique à cet avatar (`dataset_key = 'inventory:<avatar>'`).
- `GET /?category=<nom>&avatar=<id>` : liste des articles de la catégorie avec le stock spécifique à l'avatar.
- `readOrderCatalogRows(env, items, requestedAvatar)` : vérification des stocks lors de la soumission de commande filtrée sur `saleable_inventory` de l'avatar vendeur.

### Traçabilité des commandes (`purchase_orders`)
- Migration SQL `0027_seller_avatar.sql` :
  ```sql
  ALTER TABLE purchase_orders ADD COLUMN seller_avatar TEXT NOT NULL DEFAULT 'enzo';
  ```
- `orders.js` : extraction et nettoyage de `sellerAvatar` dans `normalizeOrderSubmission(payload)`.
- `application.js` : insertion de `seller_avatar` lors du `storePurchaseOrder` et exposition dans `mapPublicOrder`.

---

## 3. Frontend (`index.html`, `site.css`, `index.js`, `cart.js`)

### Sélecteur dans l'interface
- Placé dans `#inventoryHeaderControls`, symétrique au sélecteur de design V19 / Ancien.
- Élément `<select id="avatarSelect">` avec options :
  - `enzo beau gosse` (`value="enzo"`)
  - `Nocturnal enzo FRJ` (`value="nocturnal"`)
- Style unifié avec `.inventory-avatar-control` reprenant les dimensions et la charte graphique sombre discrète.

### Gestion d'état et persistance
- Clé `localStorage` : `FRJ_ACTIVE_AVATAR`.
- Variable globale synchronisée : `window.FRJ_ACTIVE_AVATAR`.
- Lors du changement d'avatar via `switchAvatar(newAvatar)` :
  - Mise à jour du titre (`[FRJ] - enzo beau gosse = A VENDRE` ou `[FRJ] - Nocturnal enzo FRJ = A VENDRE`).
  - Réinitialisation de la catégorie sélectionnée (pour éviter d'afficher des données de l'ancien inventaire).
  - Rechargement de la synthèse de catégories (`loadCategorySummary`).
  - Rechargement de la date d'inventaire (`loadInventoryDate`).
  - Mise à jour du bouton whisper du sous-titre (`/w enzo beau gosse ...` ou `/w Nocturnal enzo FRJ ...`).

### Panier & Demandes d'achat (`cart.js`)
- Le payload de soumission transmis à `FRJ_API.submitOrder(payload)` contient automatiquement `sellerAvatar: window.FRJ_ACTIVE_AVATAR || "enzo"`.

---

## 4. Procédure de Déploiement en Production

1. **Frontend (GitHub Pages)** :
   - Commiter et pusher les modifications sur `main`.
   - Le build GitHub Pages se déclenche automatiquement.

2. **Backend (Cloudflare Worker & D1)** :
   - Exécuter la reconnexion Wrangler hors sandbox :
     ```bash
     cd "cloudflare/for-sale-api"
     npx wrangler login
     ```
   - Appliquer la migration SQL D1 sur l'environnement distant :
     ```bash
     npx wrangler d1 migrations apply frj-for-sale --remote
     ```
   - Déployer la nouvelle version du Worker :
     ```bash
     npx wrangler deploy
     ```

---

## 5. Non-régression & Tests

La suite complète de tests automatisés couvre l'ensemble des cas :
- `test/d1-public-catalog-optimization.test.js` :
  - Synthèse nocturnal filtrée sur ses conteneurs et stocks propres.
  - Synthèse enzo et repli enzo sur avatar inconnu.
  - Date d'inventaire ciblée par avatar.
- `test/catalog-page.test.js` :
  - Sélecteur d'avatar frontend, titre et whisper dynamique.
  - Bascule d'avatar et rechargement.
- `cloudflare/for-sale-api/test/orders.test.js` :
  - Normalisation de `sellerAvatar` dans la soumission de commande.
- **Résultat : 298 tests réussis (0 échec).**
