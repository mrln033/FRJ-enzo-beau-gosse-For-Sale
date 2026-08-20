# Architecture du projet

## Principes

1. Le frontend GitHub Pages ne dépend pas d'un moteur de rendu GAS ou D1.
2. GAS et Cloudflare D1 exposent chacun leur API et peuvent servir de repli selon l'opération.
3. Les pages publiques conservent leurs chemins afin de ne pas casser les liens clients, Discord et les favoris.
4. Le JavaScript propre à une page porte le même nom que son fichier HTML.
5. Les fonctions partagées sont placées dans des modules communs et ne sont pas recopiées entre les pages.
6. Les commentaires expliquent les règles métier, les choix de repli et les effets secondaires plutôt que la syntaxe évidente.

## Flux principaux

### Catalogue

`index.html` appelle `js/api-client.js`. GAS est actuellement prioritaire pour une URL normale et D1 devient prioritaire avec `?backend=d1`. Une lecture peut se replier vers l'autre backend.

### Panier et demandes

Le panier reste dans le stockage local jusqu'à sa transmission. D1 reçoit la demande en priorité ; GAS sert de secours en cas d'indisponibilité serveur. Les demandes GAS sont ensuite transférées vers D1 par la synchronisation.

### Administration

`?admin=1` est seulement l'entrée discrète du menu. `js/admin-session.js` mémorise ce mode dans `sessionStorage` pour l'onglet courant et nettoie immédiatement le paramètre dans l'URL. Les liens du menu n'ajoutent jamais ce paramètre.

Le booléen de session ne donne aucun droit supplémentaire. Les routes D1 `/admin/*` exigent toujours le jeton administrateur et les routes `/sync/*` leur jeton de synchronisation.

### Synchronisation GAS ↔ D1

`gas/SyncD1.gs` et les routes `/sync/*` du Worker échangent catalogue, MU, inventaires et demandes. Les détails opérationnels sont documentés dans `cloudflare/for-sale-api/README.md`.

## Organisation du frontend

```text
js/
├── common/       API, traduction, formats et règles partagées
├── components/   panier et menu Admin
└── pages/        un fichier JavaScript par page HTML
```

Cette arborescence est en place. Les chemins des pages publiques restent stables pour préserver les liens clients, Discord et les favoris.

## Ordre de migration d.3

1. Rangement documentaire et suppression des copies inutilisées. **Terminé (d.3.1).**
2. Extraction des scripts des pages d'import. **Terminé (d.3.2).**
3. Extraction du rapport de synchronisation. **Terminé (d.3.3).**
4. Extraction et mutualisation de la console des demandes et du suivi client. **Terminé (d.3.4).**
5. Extraction du catalogue principal. **Terminé (d.3.5).**
6. Rangement des feuilles de style. **Terminé (d.3.6).**
7. Découpage interne du Worker D1, sans modifier son URL ni ses contrats HTTP. **Terminé (d.3.7).**
8. Découpage des fichiers GAS, sans modifier `doGet` et `doPost`. **Terminé (d.3.8).**
9. Revue finale de la documentation et des commentaires. **Terminé (d.3.9).**

Les pages d'import chargent désormais leur contrôleur homonyme depuis `js/pages/`.
Le rendu partagé des bilans GAS/D1 se trouve dans `js/common/import-feedback.js`.
Le contrôleur du rapport D1 se trouve dans `js/pages/rapport-sync.js` ; la page HTML ne contient plus de logique intégrée.
Les contrôleurs des demandes sont `js/pages/commandes.js` et `js/pages/suivi-commande.js`.
Leurs statuts, règles d'action et formats communs sont centralisés dans `js/common/order-ui.js` ; leurs textes et parcours propres restent séparés.
Le catalogue conserve `index.html` comme point d'entrée stable et charge sa logique depuis `js/pages/index.js`, avant le composant panier.

## Organisation du Worker D1

Le point d'entrée Cloudflare reste `cloudflare/for-sale-api/src/index.js`. Il se limite désormais au routage HTTP, à l'authentification, au contrôle des origines et à la conversion uniforme des erreurs.

Les traitements applicatifs sont regroupés dans `application.js`. La configuration statique et les limites sont centralisées dans `config.js`, tandis que `http.js` porte les réponses, CORS, lecture bornée des corps, empreintes et comparaisons de jetons. Les modules métier existants `domain.js`, `orders.js`, `sync.js` et `discord.js` restent indépendants. Cette séparation ne change ni le nom du Worker, ni ses routes, ni ses formats de réponse.

## Organisation du backend GAS

Les points d'entrée restent stables : `doGet` et le répartiteur `frjMainDoPost_` sont dans `Code.gs`, tandis que `doPost` reste dans `WebApp.gs`. Apps Script charge tous les fichiers `.gs` du projet dans le même espace global.

```text
gas/
├── Code.gs             entrées HTTP GAS
├── Catalog.gs          lecture du catalogue et des catégories
├── Imports.gs          imports MU et inventaires
├── PurchaseOrders.gs   demandes, miroir et publication Discord
├── SyncD1.gs           configuration, installation et déclencheurs
├── SyncEngine.gs       planification, audit, fusion et orchestration
├── SyncOrders.gs       transfert des demandes GAS ↔ D1
├── SyncSheets.gs       lecture, écriture et empreintes des feuilles
├── SyncTransport.gs    appels D1, jeton et utilitaires communs
└── WebApp.gs           point d'entrée `doPost`
```

Ce rangement ne change aucune fonction publique appelée par le frontend ou par les déclencheurs déjà installés.
Il est publié dans le projet Apps Script de production sur la version 15 du déploiement Web App existant ; l'URL `/exec` reste inchangée.
Comme ce projet GAS est autonome, les routes de catalogue ouvrent explicitement le classeur BDD_APP par son identifiant et ne dépendent pas de `SpreadsheetApp.getActiveSpreadsheet()`.

## Organisation des styles

```text
css/
├── site.css             base partagée et navigation Admin
├── components/
│   └── cart.css         panier et aide
└── pages/
    ├── commandes.css
    ├── imports.css
    ├── suivi-commande.css
    └── sync-report.css
```

Les pages HTML ne contiennent plus de bloc `<style>`. Chaque référence utilise un chemin relatif depuis la racine du site.
