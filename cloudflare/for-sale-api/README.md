# FRJ For Sale API — Cloudflare Worker + D1

Ce projet est volontairement séparé de `../worker.js`, qui gère Discord pour une autre application.

## État actuel

- Worker déployé : <https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev>
- D1 distant : `frj-for-sale` (`6afa102c-94a4-4b40-a61b-0fdc2e0a2b86`), région WEUR.
- Données chargées : 1 113 articles, 1 113 classements, 3 097 lignes d’inventaire et 802 observations MU.
- Le front GitHub Pages appelle encore GAS : la production existante n’a pas été basculée.
- Les lectures D1 sont publiques ; `ADMIN_TOKEN` est configuré dans les secrets Cloudflare.
- Le frontend local possède une bascule progressive, mais ces modifications ne sont pas encore publiées sur GitHub Pages.

## Contrat HTTP conservé

- `GET /?action=categories`
- `GET /?action=inventoryDate`
- `GET /?action=inventoryTarget&avatar=enzo`
- `GET /?category=ARMORS`
- `POST /?type=inventory&avatar=enzo`
- `POST /?type=mu`

Les lectures restent publiques. Les écritures exigent `Authorization: Bearer <ADMIN_TOKEN>`.

## Bascule progressive du frontend

- URL normale : GAS reste prioritaire et D1 sert de repli en lecture seule.
- URL avec `?backend=d1` : D1 devient prioritaire et GAS sert de repli en lecture seule.
- Pages administrateur avec `?admin=1&backend=d1` : les imports vont uniquement vers D1.
- Le jeton est demandé au premier import D1 et conservé dans `sessionStorage` jusqu'à la fermeture de l'onglet.
- Une écriture ne bascule jamais automatiquement vers l'autre backend, afin d'éviter les doubles imports.

Le secret n'est jamais enregistré dans le code ni dans `localStorage`. Conserver sa valeur dans un gestionnaire
de mots de passe ; Cloudflare ne permet pas de la relire ensuite.

## Recréation locale

1. Installer les dépendances avec `pnpm install`.
2. Si nécessaire, créer la base : `pnpm wrangler d1 create frj-for-sale`.
3. Copier le `database_id` retourné dans `wrangler.jsonc`.
4. Appliquer le schéma : `pnpm db:migrate:local`.
5. Générer le snapshot privé : `pnpm db:build-seed`.
6. Charger le snapshot : `pnpm db:seed:local`.
7. Lancer l’API : `pnpm dev`.

## Préparation de la production

1. Appliquer le schéma distant : `pnpm db:migrate:remote`.
2. Charger le snapshot distant : `pnpm db:seed:remote`.
3. Créer le secret d’administration : `pnpm wrangler secret put ADMIN_TOKEN`.
4. Déployer : `pnpm deploy`.
5. Contrôler l’API distante : `pnpm smoke`.

Pour vérifier un jeton sans écrire en base, définir temporairement `FRJ_ADMIN_TOKEN` dans le terminal puis lancer
`node tools/auth-smoke.mjs https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev`.

Le fichier `seed/initial.sql` et les classeurs du dossier `save/` sont ignorés par Git, car ils
contiennent les inventaires complets. Ne pas les forcer dans le dépôt public.

Ne pas remplacer l’URL GAS dans le front avant validation des réponses locales et distantes.

## Retour arrière

Chaque import crée une version immuable, puis change uniquement le pointeur `active_inventory` ou
`active_market_import`. Une version antérieure peut être réactivée sans réimporter les données.
