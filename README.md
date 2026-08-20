# FRJ For Sale

Catalogue bilingue d'articles, panier et suivi de demandes d'achat pour **enzo beau gosse**.

Le frontend statique est publié par GitHub Pages. Il peut lire les données depuis Google Apps Script (GAS) ou Cloudflare D1 et possède des mécanismes de repli documentés. Les deux backends restent des API indépendantes du frontend.

## Points d'entrée

- `index.html` : catalogue public et panier.
- `aide-panier.html` : aide bilingue affichée dans le panier.
- `suivi-commande.html` : suivi client par lien privé.
- `commandes.html` : console des demandes d'achat.
- `maj_mu.html` et `maj_inventaire-enzo.html` : imports administrateur.
- `rapport-sync.html` : rapport de synchronisation GAS ↔ D1.

Les noms et emplacements de ces pages restent stables, car certains liens sont enregistrés dans les demandes, Discord ou les outils d'administration.

## Organisation

- `js/` : code frontend partagé et scripts des pages.
- `img/` : images publiques du catalogue ; conserver ce chemin stable.
- `gas/` : backend et synchronisation Google Apps Script.
- `cloudflare/for-sale-api/` : Worker Cloudflare, schéma D1, tests et outils.
- `docs/` : documentation fonctionnelle et technique.
- `archive/legacy/` : anciennes copies conservées à titre historique, non utilisées par le site.
- `A Faire.txt` : demandes, avancement et historique du projet.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour les flux et les règles de rangement.

## Mode Admin

Le paramètre d'entrée `?admin=1` active le menu Admin dans l'onglet courant, puis disparaît immédiatement de l'URL. Les liens internes ne le propagent pas. Cette session d'affichage n'est pas un mécanisme de sécurité : les opérations sensibles restent protégées par le jeton administrateur D1.

## Vérifications locales

Depuis la racine du dépôt :

```powershell
node --test
```

Depuis `cloudflare/for-sale-api`, les commandes Wrangler et D1 sont décrites dans son propre README.
