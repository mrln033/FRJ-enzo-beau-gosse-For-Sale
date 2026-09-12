# Backend Google Apps Script

Ce dossier contient la totalité du projet Apps Script autonome. Apps Script charge tous les fichiers `.gs` dans un espace global commun ; leur séparation sert donc à clarifier les responsabilités, sans changer les noms des fonctions publiques.

## Points d'entrée et modules

- `Code.gs` : `doGet` et répartition des écritures ;
- `WebApp.gs` : `doPost` ;
- `Catalog.gs` : catalogue, catégories et date d'inventaire ;
- `Discounts.gs` et `DiscountSheets.gs` : règles, feuilles, génération et synchronisation des promotions et soldes ;
- `Containers.gs` : configuration multi-avatar des conteneurs et formules de quantité ;
- `Imports.gs` : imports MU et inventaires ;
- `OrderHistory.gs` : modèle, capture et miroir de l'historique des demandes ;
- `OrderEditing.gs` : éditions différentielles des entêtes/lignes, conflits et actions Sheets ;
- `PurchaseOrders.gs` : demandes de secours et Discord ;
- `SyncD1.gs` : configuration, installation et déclencheurs ;
- `SyncEngine.gs`, `SyncOrders.gs`, `SyncSheets.gs`, `SyncTransport.gs` : orchestration, demandes, feuilles et transport D1.

Les secrets `FRJ_D1_SYNC_TOKEN`, `FRJ_DISCORD_ORDER_WEBHOOK_URL` et les options comme `FRJ_CART_ENABLED` restent dans les propriétés du script. Ils ne doivent jamais être ajoutés au dépôt.

## Historique des demandes

La feuille `COMMANDES_HISTORIQUE` est créée de façon idempotente lors de l'installation de la synchronisation. Chaque événement possède une clé stable commune à GAS et D1. Une création ou annulation reçue par le secours GAS ajoute une ligne non synchronisée, ensuite répliquée dans D1. Depuis le 12/09/2026, les éditions manuelles des entêtes/statuts de COMMANDES_APP et des articles de COMMANDES_LIGNES passent par /sync/order-edit : le serveur valide et applique la demande atomiquement avec son événement sheet-order-edited, puis le miroir rapatrie son historique.

Le projet est autonome : les commandes ne reposent pas sur un menu de script lié. La colonne ACTION_EDITION de COMMANDES_APP sert à synchroniser, ajouter un article et résoudre explicitement un conflit. Le poll traite au maximum dix éditions par passage. Le JSON miroir reste la base de comparaison ; EDITION_JSON conserve l'envoi idempotent en attente, EDITION_ERREUR son erreur, D1_CONFLIT_JSON la version distante éventuelle. Le guide complet et le retour arrière figurent dans docs/PANIER.md. Aucune modification du contrat des inventaires.

Pour une ligne d'historique déjà créée, seule la colonne `COMMENTAIRE` est destinée à être modifiée manuellement. Sa date de modification départage deux changements concurrents : la version la plus récente est conservée puis renvoyée à l'autre côté. Les colonnes `SYNCED_D1_AT` et `SYNC_ERROR` indiquent respectivement la dernière convergence et l'éventuel échec à retenter.

## Migration d.8.5 des conteneurs

Au premier cycle de synchronisation suivant la publication, l'initialisation versionnée exécute automatiquement et une seule fois la préparation des conteneurs. La fonction `prepareFrjContainerConfiguration` reste disponible pour une reprise manuelle contrôlée. Cette préparation :

- transforme sans remise à zéro `CONFIG_CONTAINER` de `Container | Enabled` vers `Avatar | Container | Enabled` ;
- conserve les choix Enzo existants, y compris les anciens conteneurs absents de l'inventaire courant ;
- ajoute les conteneurs inconnus des quatre inventaires avec `Enabled = FALSE` ;
- remplace les formules de `BDD_APP!QUANTITE` par un calcul piloté par les choix Enzo de `CONFIG_CONTAINER`.

Les imports suivants entretiennent automatiquement la liste uniquement par ajout. La variante appelée depuis le moteur de synchronisation réutilise son verrou global afin d'éviter un verrou imbriqué.

Le dataset `containers` fait ensuite partie de la synchronisation bidirectionnelle ordinaire. Une modification manuelle des cases dans Google Sheets est détectée par les triggers existants ; une modification effectuée dans l'interface D1 est signalée au prochain contrôle. Les lignes ajoutées indépendamment de chaque côté sont réunies et ne sont jamais supprimées par la fusion.

## Contrat des feuilles d'inventaire MindArk

Les feuilles d'inventaire sont un contrat externe historique, utilisé par plusieurs autres classeurs Google Sheets. Elles reproduisent donc chaque ligne du TSV MindArk, sans regroupement ni tri, dans les six colonnes `Id | article/date | Quantity | Value(PED) | Container | ContainerRefId`.

La seule exception volontaire au fichier source se trouve en `B1` : l'en-tête `Name` y est remplacé par la date et l'heure d'import, au format `dd/MM/yyyy - HH:mm:ss`. Les noms d'articles occupent la colonne B à partir de la ligne 2. La colonne `Value(PED)` est volontairement stockée comme texte brut sur quatre décimales (`0.1000`) afin de conserver le point décimal indépendamment de la locale Google Sheets et de préserver les `IMPORTRANGE` historiques. L'import direct et une restauration depuis D1 appliquent exactement ce même contrat. Aucun contenu technique ne subsiste en dehors des six colonnes contractuelles.

### Validation et diagnostic des imports

Le 05/09/2026, l'utilisateur a confirmé les imports des quatre inventaires et les contrôles finaux de synchronisation et de format. Enzo compte 1 943 lignes avec l'en-tête, soit 1 942 articles. Un bilan D1 « déjà traité, 0 écriture » est normal lorsque les données sont identiques.

Le défaut observé dans l'export de `Umbranoid "Medicine"` était un guillemet enveloppant final manquant. Un parseur CSV multiligne pouvait alors absorber les articles suivants. GAS et D1 lisent désormais chaque ligne physique MindArk séparément, contrôlent ses six champs et décodent les guillemets dans chaque champ. Cette règle doit rester cohérente entre les deux moteurs.

En cas d'incident, conserver le TSV exact et comparer le nombre d'articles au bilan, même s'il indique un succès. Le code public `INV-OPEN`, `INV-DATA`, `INV-WRITE` ou `INV-CONTAINERS` indique la phase en échec ; la référence permet de retrouver le détail dans les journaux privés GAS. Ne pas modifier la locale du classeur pour réparer le séparateur décimal : le contrat de la colonne D est le texte brut avec point.

## Promotion préparée pour le lendemain

Après chaque synchronisation différée susceptible de modifier le stock, le catalogue, les conteneurs ou les MU, GAS contrôle uniquement le couple de la promotion de J+1. S'il n'est plus éligible, il est remplacé en conservant sa date, son taux et son identifiant. Le couple de J n'est jamais remplacé automatiquement ; dans l'Admin, seul son taux demeure modifiable. Un trigger quotidien supplémentaire effectue un dernier contrôle de J+1 vers 23 h 55 dans le fuseau `Europe/Paris`.

## Publication avec clasp

1. Activer l'API Google Apps Script dans les paramètres du compte Google.
2. Installer `@google/clasp` et exécuter `clasp login` avec un compte autorisé à modifier le projet.
3. Cloner d'abord le projet distant dans un dossier temporaire et comparer sa liste de fichiers. `clasp push` remplace tout le contenu distant, pas seulement les fichiers modifiés.
4. Préparer un dossier ne contenant que `appsscript.json`, les fichiers `.gs` de ce dossier et le `.clasp.json` associé au bon `scriptId`.
5. Contrôler la sélection avec `clasp show-file-status`, puis publier avec `clasp push --force` après validation de la comparaison.
6. Mettre à jour le déploiement Web App existant avec son `deploymentId`, afin de conserver la même URL `/exec`.
7. Cloner à nouveau le projet et comparer les empreintes des fichiers, puis tester les routes publiques sans écriture métier.

Le déploiement de production actuel est la version 38. Son URL est référencée par `js/api-client.js` pour les imports et le secours des demandes et par le Worker pour la synchronisation ; elle doit rester stable. Les imports MindArk lisent une ligne physique par article avec six champs, ignorent les lignes entièrement vides et décodent les guillemets champ par champ pour empêcher toute fusion d'articles. Les erreurs renvoient une phase contrôlée et une référence ; leur détail reste dans les journaux privés GAS.

T-017 (11/09/2026) : le titre Discord ouvre s.html#FRJ-AAAAMMJJ-XXXXXX, lien court de suivi T-012 commun à D1 et GAS. La référence est normalisée et validée ; si elle manque ou est invalide, le lien général Admin reste utilisé. Aucun paramètre admin ni jeton ajouté. Les liens de 31 messages existants ont été actualisés et vérifiés ; 3 messages introuvables n'ont pas été recréés. Aucune modification des données métier.

T-016 (11/09/2026) : ordre des champs Discord commun à GAS et D1 : Avatar / Statut / Contact, Total TT / Total MU / Total Estimé ou Confirmé, Origine / Profil tarifaire, puis Articles. La disposition en colonnes reste adaptée par Discord à la largeur d'écran. Actualisation ponctuelle réalisée : 31 messages modifiés et vérifiés, 3 identifiants introuvables (HTTP 404) non recréés ; aucune écriture métier D1/GAS. Le secret local est exclu de Git.

## Totaux Discord (T-015, 11/09/2026)

Le message affiche le total TT et le MU global (vente moins TT), en PED et en pourcentage du TT ; pour un TT nul, le pourcentage vaut zéro. Le libellé de vente suit le statut courant : « Total Confirmé » pour preparing/ready/completed, « Total Estimé » sinon, y compris après retour à awaiting_approval/submitted/viewed. Le champ pricingStatus ne doit pas empêcher ce retour. D1 applique la même règle. Les anciens messages sont enrichis lors de leur prochaine actualisation normale.
