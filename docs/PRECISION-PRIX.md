# Précision des prix — T-027

## Règles (07/10/2026)

- Prix TT unitaires, prix de vente unitaires et MU : conserver la précision numérique disponible ; au moins deux décimales à l'affichage, sans zéros inutiles au-delà. Exemple : 0,024 PED, 2,00 PED, 1,20 PED.
- Quantité entière ; saisie de MU en PED ou en pourcentage sans plafond arbitraire de deux ou six décimales. Les bornes métier et contrôles de nombres finis restent actifs.
- Calculer quantité, profil et promotion sans arrondi monétaire intermédiaire. Conserver aussi les montants de ligne précis, puis arrondir le total de la demande à deux décimales.
- Afficher les totaux TT, MU et vente à deux décimales (ligne, demande, suivi, Discord). La somme des lignes affichées peut donc différer d'un centime du total : celui-ci additionne les valeurs non arrondies.
- Exemple de contrôle : 0,024 × 2 100 = 50,40 PED ; deux lignes de 0,024 donnent 0,05 PED au total, et non 0,04.
- Le noyau utilise des entiers décimaux internes pour éviter les artefacts des opérations binaires usuelles. Les contrats JSON, D1 et Sheets restent numériques : ce n'est pas une conversion de la base vers une précision arbitraire illimitée. Aucune précision déjà perdue dans la donnée source ne peut être reconstruite.

## Périmètre

Catalogue, calculatrice, panier et texte copié ; saisie, ajout, modification et duplication Admin ; suivi client ; création de secours GAS ; révision, actualisation des MU et calculs D1 ; miroir COMMANDES_LIGNES et éditions Sheets. Le catalogue D1 expose le MU numérique disponible, sans repartir de weighted_display arrondi ; les valeurs de calcul GAS sont celles réellement fournies par BDD_APP. Aucun changement des formules de pondération ou des règles de promotion.

Le noyau canonique est dans cloudflare/for-sale-api/src/ped-math.js. Ses copies sans modules sont embarquées dans js/common/order-ui.js et gas/PurchaseOrders.gs, pour respecter le chargement historique du navigateur et de GAS ; un test vérifie leur identité. Tous les contrôleurs frontend utilisent ce même noyau via FRJ_ORDER_UI. Les entiers internes ne sont jamais envoyés par JSON.

GAS utilise BigInt(...) plutôt que les littéraux BigInt, refusés par son analyseur de publication. Les cellules MU_SAISI et TT_UNITAIRE ont un format à décimales variables ; les totaux des feuilles de demandes ont deux décimales. Cette mise en forme est appliquée une seule fois au prochain cycle habituel (propriété FRJ_ORDER_PRECISION_FORMAT), sans changer les valeurs.

## Préservation de l'existant

Aucune migration D1, aucune reconstruction des demandes anciennes, aucun recalcul automatique des commandes terminées, aucune republication en masse des messages Discord. Les montants et prix mémorisés restent conservés, y compris dans l'aperçu Admin à l'ouverture et après annulation d'une saisie locale. Modifier explicitement une demande encore éditable suit son circuit normal ; une ancienne valeur unitaire déjà tronquée n'est pas remplacée silencieusement par celle du catalogue actuel.

Un ancien miroir Sheets dont seule la représentation MU_SAISI était arrondie à six décimales n'est pas interprété comme une édition automatique. Les conflits, confirmations client et verrouillages des demandes restent actifs.

Les inventaires MindArk (six colonnes, valeurs texte à quatre décimales et date en B1), leurs imports et leurs formules externes ne changent pas. Aucun nouveau trigger, aucune Queue et aucun polling ajouté.

## Contrôles et publication

294 tests automatisés (dont affichage Admin des anciennes demandes, sans recalcul à l'ouverture) : précision, petites valeurs, scientifique, MU PED/%, Public/FRJ, promotions, saisie, miroir, conservation historique, non-régression. Test d'intégration SQLite/D1 : création à 0,024 × 2 100, édition Sheets à 2 101, maintien de 0,024 et total 50,42. Contrôle Chromium du catalogue, de la calculette et du panier : 50,40 PED, aucune erreur JavaScript.

Sources GAS distantes comparées aux 17 fichiers de HEAD avant publication ; seuls PurchaseOrders et OrderEditing sont modifiés. Les 17 fichiers ont été relus identiques après publication. Worker 66cd4039-09b4-4a80-a46d-9091e3aa9e10 et GAS 49 publiés le 07/10/2026, même Web App (49 conserve aussi les quantités Discord entières). Contrôles réels D1/GAS avec Basic Auxiliary Socket à 0,0136 PED : calcul exécuté, puis refus volontaire grâce à une seconde ligne inexistante, avant toute écriture de demande ou notification Discord. Frontend publié avec 1e225f8 puis 4d52730 et complément de préservation de l'affichage historique. GitHub Pages vérifié après son attente initiale. Contrôles Chromium en production avec D1 et GAS : prix 0,0136 visible dans catalogue/panier, aucune erreur JavaScript ; statistiques neutralisées. Validation utilisateur en production attendue.

## Retour arrière ciblé

Vérification finale : commit applicatif d5fc5a0 publié, build GitHub Pages terminé. Les trois pages HTML et cinq scripts concernés sont servis identiques au dépôt. Le contrôleur Admin publié a aussi été testé dans Chromium avec une réponse API simulée : une ancienne demande Terminée à 50,40 reste à 50,40 malgré un prix unitaire ancien tronqué, et ses champs restent verrouillés. Aucun accès Admin réel ni écriture de demande pour ce contrôle.

Référence Git préalable : d9ef406. Rétablir uniquement les fichiers du lot T-027, en préservant tout changement ultérieur, puis republier le frontend GitHub Pages. Pour les backends : Worker bfd78af1-20f5-456a-9acc-dfaa803f5369 et Web App GAS version 47 (même déploiement). Rétablir aussi les sources HEAD GAS des deux modules, car les triggers utilisent HEAD.

Aucune restauration de base ni de classeur. Les demandes enregistrées entre-temps doivent être conservées. Attention : revenir à l'ancien code réintroduit les arrondis unitaires lors de créations/modifications ; ne pas recalculer en masse les demandes pendant un retour arrière. Les formats visuels Sheets à deux décimales/variables peuvent rester sans risque, car ils ne changent aucune valeur.
