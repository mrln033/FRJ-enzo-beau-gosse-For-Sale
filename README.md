# FRJ For Sale

T-022 (13/09/2026) : l'origine visible dans la liste Admin et Discord est **Client** (d1 ou gas-fallback) ou **Admin** (d1-admin, saisie manuelle et duplication). Le backend technique reste conservé dans source_backend/sourceBackend pour l'historique et la synchronisation. Aucun changement de données ou de statut ; convertir une demande en Devis Admin conserve l'origine de sa saisie initiale.

T-021 : bouton de suppression définitive réservé aux Devis Admin, avec confirmation. Cascade D1, purge ciblée des trois feuilles de demandes au poll GAS existant et suppression Discord avec reprise. Copies conservées ; marqueurs techniques sans contenu contre les résurrections. Voir [Devis Admin](docs/DEVIS-ADMIN.md) pour les délais, tests et limites du retour arrière.

T-020 : demandes Terminées définitivement en lecture seule, conversion Devis Admin interdite depuis À préparer / Prête / Terminée. Avatar facultatif pour un modèle (Public ou Membre Soc selon profil obligatoire). Ces gardes couvrent aussi les éditions Sheets ; GAS reste en version 44. Voir les règles, tests et le retour ciblé dans [Devis Admin](docs/DEVIS-ADMIN.md).

Catalogue bilingue d'articles, panier et suivi de demandes d'achat pour **enzo beau gosse**.

Le frontend statique est publié par GitHub Pages. Il peut lire les données depuis Google Apps Script (GAS) ou Cloudflare D1 et possède des mécanismes de repli documentés. Les deux backends restent des API indépendantes du frontend.

## Points d'entrée

- `index.html` : catalogue public et panier.
- `aide-panier.html` : aide bilingue affichée dans le panier.
- `suivi-commande.html` : suivi client par référence de demande.
- `commandes.html` : console des demandes d'achat.
- `conteneurs.html` : configuration D1 des conteneurs inclus dans les quantités.
- `promotions.html` : gestion des promotions quotidiennes et des soldes.
- `maj_mu.html` et `maj_inventaire-enzo.html` : imports administrateur.
- `rapport-sync.html` : rapport de synchronisation GAS ↔ D1.
- `statistiques-visites.html` : statistiques de fréquentation réservées à l'administration.

Les noms et emplacements de ces pages restent stables, car certains liens sont enregistrés dans les demandes, Discord ou les outils d'administration.

## Organisation

- `js/` : code frontend partagé et scripts des pages.
- `css/` : styles partagés, composants et feuilles propres aux pages.
- `img/` : images publiques du catalogue. Pour un nom de fichier, le catalogue essaie la racine puis `img/CATEGORIE/` (champ `STORAGE` en majuscules). Nom vide, `-`, `--` ou échec final : `No image`. Les URL complètes et chemins déjà classés restent acceptés ; conserver les noms exacts, casse comprise.
- `gas/` : backend et synchronisation Google Apps Script, rangés par catalogue, imports, demandes et synchronisation ; voir son [guide de déploiement](gas/README.md).
- `cloudflare/for-sale-api/` : Worker Cloudflare, schéma D1, tests et outils.
- `docs/` : documentation fonctionnelle et technique.
- `archive/legacy/` : anciennes copies conservées à titre historique, non utilisées par le site.
- `A Faire.txt` : demandes, avancement et historique du projet.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour les flux et les règles de rangement.

## Mode Admin

Le paramètre d'entrée `?admin=1` active le menu Admin dans l'onglet courant, puis disparaît immédiatement de l'URL. Les liens internes ne le propagent pas. Cette session d'affichage n'est pas un mécanisme de sécurité : les opérations sensibles restent protégées par le jeton administrateur D1.

## Liens directs du catalogue

Le paramètre public `category` ouvre directement une catégorie du catalogue, par exemple `?category=WEAPONS`. D1 est prioritaire sans paramètre ; les lectures se replient automatiquement sur GAS en cas d'échec, sans changer l'URL. Pour les contrôles, `?backend=gas` ou `?backend=d1` choisit explicitement la priorité, tout en conservant le secours. Ce choix ne remplace pas les circuits spécialisés (imports GAS + D1, suivi et administration D1). Les liens ordinaires n'ajoutent plus `backend` ; seuls les choix explicites peuvent être transmis. Le paramètre `admin` et les droits restent inchangés.

## Liens courts de suivi

Le panier, la Console Admin et la page de suivi copient une adresse courte sur le domaine habituel, fondée sur la référence publique, par exemple `https://mrln033.github.io/FRJ-enzo-beau-gosse-For-Sale/s.html#FRJ-20260910-ABC123`. La page relais ouvre le suivi correspondant. Les anciens liens contenant un jeton restent compatibles.

## Devis Admin

Les modèles de devis possèdent leur statut **Devis Admin**, indépendant du nom d'avatar et de l'origine. Ils se dupliquent en demandes normales sans suivre eux-mêmes le parcours client. Voir [utilisation, synchronisation et retour arrière](docs/DEVIS-ADMIN.md).

## Vérifications locales

Depuis la racine du dépôt :

```powershell
node --test
```

Depuis `cloudflare/for-sale-api`, les commandes Wrangler et D1 sont décrites dans son propre README.
