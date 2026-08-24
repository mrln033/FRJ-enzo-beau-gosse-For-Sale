# Backend Google Apps Script

Ce dossier contient la totalité du projet Apps Script autonome. Apps Script charge tous les fichiers `.gs` dans un espace global commun ; leur séparation sert donc à clarifier les responsabilités, sans changer les noms des fonctions publiques.

## Points d'entrée et modules

- `Code.gs` : `doGet` et répartition des écritures ;
- `WebApp.gs` : `doPost` ;
- `Catalog.gs` : catalogue, catégories et date d'inventaire ;
- `Containers.gs` : configuration multi-avatar des conteneurs et formules de quantité ;
- `Imports.gs` : imports MU et inventaires ;
- `PurchaseOrders.gs` : demandes de secours et Discord ;
- `SyncD1.gs` : configuration, installation et déclencheurs ;
- `SyncEngine.gs`, `SyncOrders.gs`, `SyncSheets.gs`, `SyncTransport.gs` : orchestration, demandes, feuilles et transport D1.

Les secrets `FRJ_D1_SYNC_TOKEN`, `FRJ_DISCORD_ORDER_WEBHOOK_URL` et les options comme `FRJ_CART_ENABLED` restent dans les propriétés du script. Ils ne doivent jamais être ajoutés au dépôt.

## Migration d.8.5 des conteneurs

Au premier cycle de synchronisation suivant la publication, l'initialisation versionnée exécute automatiquement et une seule fois la préparation des conteneurs. La fonction `prepareFrjContainerConfiguration` reste disponible pour une reprise manuelle contrôlée. Cette préparation :

- transforme sans remise à zéro `CONFIG_CONTAINER` de `Container | Enabled` vers `Avatar | Container | Enabled` ;
- conserve les choix Enzo existants, y compris les anciens conteneurs absents de l'inventaire courant ;
- ajoute les conteneurs inconnus des quatre inventaires avec `Enabled = FALSE` ;
- remplace les formules de `BDD_APP!QUANTITE` par un calcul piloté par les choix Enzo de `CONFIG_CONTAINER`.

Les imports suivants entretiennent automatiquement la liste uniquement par ajout. La variante appelée depuis le moteur de synchronisation réutilise son verrou global afin d'éviter un verrou imbriqué.

Le dataset `containers` fait ensuite partie de la synchronisation bidirectionnelle ordinaire. Une modification manuelle des cases dans Google Sheets est détectée par les triggers existants ; une modification effectuée dans l'interface D1 est signalée au prochain contrôle. Les lignes ajoutées indépendamment de chaque côté sont réunies et ne sont jamais supprimées par la fusion.

## Publication avec clasp

1. Activer l'API Google Apps Script dans les paramètres du compte Google.
2. Installer `@google/clasp` et exécuter `clasp login` avec un compte autorisé à modifier le projet.
3. Cloner d'abord le projet distant dans un dossier temporaire et comparer sa liste de fichiers. `clasp push` remplace tout le contenu distant, pas seulement les fichiers modifiés.
4. Préparer un dossier ne contenant que `appsscript.json`, les fichiers `.gs` de ce dossier et le `.clasp.json` associé au bon `scriptId`.
5. Contrôler la sélection avec `clasp show-file-status`, puis publier avec `clasp push --force` après validation de la comparaison.
6. Mettre à jour le déploiement Web App existant avec son `deploymentId`, afin de conserver la même URL `/exec`.
7. Cloner à nouveau le projet et comparer les empreintes des fichiers, puis tester les routes publiques sans écriture métier.

Le déploiement de production actuel est la version 21. Son URL est référencée par `js/api-client.js` pour le secours des demandes et par le Worker pour la synchronisation ; elle doit rester stable.
