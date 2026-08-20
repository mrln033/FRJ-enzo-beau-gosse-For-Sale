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

## Arborescence frontend cible

```text
js/
├── common/       API, traduction, formats et règles partagées
├── components/   panier et menu Admin
└── pages/        un fichier JavaScript par page HTML
```

Cette arborescence sera mise en place progressivement. Les chemins actuels restent valides tant que la page concernée n'a pas été migrée et testée.

## Ordre de migration d.3

1. Rangement documentaire et suppression des copies inutilisées. **Terminé (d.3.1).**
2. Extraction des scripts des pages d'import. **Terminé (d.3.2).**
3. Extraction du rapport de synchronisation.
4. Extraction et mutualisation de la console des demandes et du suivi client.
5. Extraction du catalogue principal.
6. Rangement des feuilles de style.
7. Découpage interne du Worker D1, sans modifier son URL ni ses contrats HTTP.
8. Découpage des fichiers GAS, sans modifier `doGet` et `doPost`.
9. Revue finale de la documentation et des commentaires.

Les pages d'import chargent désormais leur contrôleur homonyme depuis `js/pages/`.
Le rendu partagé des bilans GAS/D1 se trouve dans `js/common/import-feedback.js`.
