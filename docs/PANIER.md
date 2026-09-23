# Panier d'achat — fonctionnement et retour arrière

T-024 (23/09/2026) : catalogue D1 par défaut avec secours GAS automatique des lectures. Les liens du panier, de la console et du suivi n'ajoutent plus de paramètre backend hors choix manuel explicite. Les anciens liens restent valides ; une ancienne demande reçue par GAS ne force plus le catalogue à GAS. Transmission D1 puis secours GAS, imports doubles, suivi D1 et messages d'attente conservent leurs règles. Retour arrière limité au commit frontend T-024 puis GitHub Pages, sans restauration de données (référence préalable 13d5bff).

T-022 (13/09/2026) : l'origine visible dans la liste Admin et Discord est **Client** (d1 ou gas-fallback) ou **Admin** (d1-admin, saisie manuelle et duplication). Le backend technique reste conservé dans source_backend/sourceBackend pour l'historique et la synchronisation. Aucun changement de données ou de statut ; convertir une demande en Devis Admin conserve l'origine de sa saisie initiale.

T-021 : bouton de suppression définitive réservé aux Devis Admin, avec confirmation. Cascade D1, purge ciblée des trois feuilles de demandes au poll GAS existant et suppression Discord avec reprise. Copies conservées ; marqueurs techniques sans contenu contre les résurrections. Voir [Devis Admin](DEVIS-ADMIN.md) pour les délais, tests et limites du retour arrière.

T-020 : demandes Terminées définitivement en lecture seule, conversion Devis Admin interdite depuis À préparer / Prête / Terminée. Avatar facultatif pour un modèle (Public ou Membre Soc selon profil obligatoire). Ces gardes couvrent aussi les éditions Sheets ; GAS reste en version 44. Voir les règles, tests et le retour ciblé dans [Devis Admin](DEVIS-ADMIN.md).

## Fonctionnement

- Le panier est enregistré uniquement dans le `localStorage` du navigateur tant qu'il n'est pas transmis.
- « Copier ma liste » ne transmet rien : il copie un message prêt à coller dans le jeu.
- « Transmettre à Enzo » tente D1 en priorité. Si D1 est indisponible, GAS conserve la demande dans la feuille `COMMANDES_APP`, puis le projet de synchronisation la transfère vers D1.
- Une transmission n'enlève et ne réserve aucun stock. Elle crée une demande à traiter dans `commandes.html`, accessible après activation du mode Admin pour l'onglet courant.
- Le prix de base est toujours `PRIX_UNITAIRE`, c'est-à-dire le prix TT affiché sur la tuile. Le MU affiché est ajouté à ce prix. En français, si « Je suis membre FRJ » est coché, seul le MU est réduit de 50 %.
- Avant l'enregistrement, D1 ou GAS relit stock, prix affiché et MU. En cas d'écart, le panier est actualisé et une nouvelle confirmation est requise.
- Les prix restent indiqués comme estimés, ou à confirmer lorsqu'une ligne n'a pas de MU exploitable, tant que la demande n'a pas atteint la préparation. Le passage à `preparing`, `ready` ou `completed` confirme définitivement le prix global et toutes les lignes ; une annulation ou une expiration ultérieure ne retire pas cette confirmation. La Console Admin et le suivi client FR/EN affichent ce statut sous forme de badge.
- Après transmission, un lien privé vers `suivi-commande.html` est affiché et conservé dans le `localStorage`. Le client peut l'ouvrir ou le copier pour consulter le statut mis à jour par l'administration. La page se réactualise automatiquement toutes les cinq minutes.
- Si D1 était indisponible lors de l'envoi, le lien signale l'attente du transfert GAS → D1, puis devient opérationnel après ce transfert.
- Chaque transmission publie un message Discord. Son identifiant est stocké avec la demande afin que chaque changement d'état dans la console admin mette à jour ce même message. Si le message a été supprimé sur Discord, il est recréé au prochain changement d'état.
- Le webhook reste un secret serveur : `DISCORD_ORDER_WEBHOOK_URL` dans Cloudflare et `FRJ_DISCORD_ORDER_WEBHOOK_URL` dans les propriétés du script GAS. Une panne Discord ne bloque jamais l'enregistrement de la demande.
- D1 limite les rafales à 8 nouvelles demandes par heure et par adresse anonymisée. Les doublons techniques ne sont pas réenregistrés.

## Stockage séparé

D1 utilise exclusivement :

- `purchase_orders` ;
- `purchase_order_items` ;
- `purchase_order_events`.

GAS utilise la feuille `COMMANDES_APP` pour le miroir des demandes et `COMMANDES_HISTORIQUE` pour leur chronologie bidirectionnelle. Les clés d'événement évitent les doublons entre GAS et D1 ; les colonnes de synchronisation conservent les erreurs à retenter. `DISCORD_MESSAGE_ID` et `DISCORD_ERROR` assurent la reprise des notifications. Aucun schéma d'inventaire, de catalogue ou de MU n'est modifié.

## Modification des demandes depuis Google Sheets — 12/09/2026

Les demandes existantes peuvent être corrigées dans le classeur applicatif, sans toucher au classeur des inventaires :

- COMMANDES_APP, colonnes C à H : avatar, contact, commentaire, langue FR/EN, profil MEMBRE_FRJ (TRUE/FALSE), statut.
- COMMANDES_LIGNES : article, catégorie, rayon, quantité, MU et retrait d'une ligne. MU_TYPE vaut percent, ped, none ou auto. MU_SAISI est la valeur finale appliquée au client : 120 pour 120 %, ou 1,25 pour +1,25 PED. Avec auto, le serveur utilise le MU catalogue actuel et applique le profil FRJ et la campagne ; la valeur saisie est ignorée.
- COMMANDES_HISTORIQUE : le commentaire reste modifiable.

L'onglet COMMANDES_LIGNES est ajouté automatiquement au premier poll après publication. La colonne ACTION_EDITION (X) de COMMANDES_APP propose SYNCHRONISER, AJOUTER ARTICLE, RECHARGER D1 (ABANDON LOCAL) ou REAPPLIQUER SHEETS SUR D1. Choisir une action sur la ligne de la demande ; elle est traitée par le déclencheur d'édition, ou au prochain poll si ce déclencheur a été manqué. Compléter les trois champs Article/Catégorie/Rayon d'une nouvelle ligne avant synchronisation. Cocher RETIRER pour supprimer un article ; une demande doit conserver au moins un article.

Les identifiants, références, dates techniques, JSON de synchronisation, TT unitaires et totaux ne sont pas des champs de saisie métier. Ne pas modifier les colonnes grisées/techniques ni supprimer la ligne d'une demande entière. Les totaux sont recalculés côté serveur. Le profil, les quantités et les prix d'une demande verrouillée ne sont pas modifiables : la rouvrir dans l'application avant de les corriger. Un changement des conditions commerciales crée une nouvelle version à valider par le client. Enregistrer séparément le changement de statut qui confirme les prix. Une correction d'avatar/contact ne change ni prix, ni version de proposition.

### Synchronisation et conflits

Le poll existant traite au plus dix demandes modifiées toutes les cinq minutes. Les changements de l'interface reviennent par le miroir D1 vers GAS. La comparaison locale ne contacte pas D1 si aucune édition n'est détectée ; elle détecte aussi les collages et changements de cellules effectués hors onEdit.

EDITION_JSON conserve l'envoi en attente, EDITION_ERREUR explique un rejet et D1_CONFLIT_JSON conserve la version distante en cas de conflit. Une saisie locale en attente n'est pas écrasée par le miroir. Si les deux côtés ont changé, aucune priorité silencieuse : choisir dans ACTION_EDITION soit RECHARGER D1 (ABANDON LOCAL), soit REAPPLIQUER SHEETS SUR D1 (réapplication explicite, toujours soumise aux règles métier).

Chaque opération possède un identifiant stable et un reçu atomique dans l'historique : une reprise après panne réseau n'applique pas deux fois les prix ou la version. Les confirmations restent possibles après vente du stock et conservent le TT enregistré, comme dans l'Admin ; seules les remises encore applicables sont actualisées avant gel. Discord est actualisé après acceptation, sans bloquer la demande en cas de panne.

### Coût et contrôle

Contrôle direct du 12/09/2026 après rétablissement du connecteur Google : 35 demandes et 177 lignes d'articles présentes, sans doublon de clé demande/ligne ni écart entre les articles visibles et leur JSON miroir. Quatre anciens commentaires "101%" avaient été convertis par Sheets en nombre 1,01, ce qui provoquait de faux conflits lors de l'initialisation. La version GAS 42 écrit désormais avatar/contact/commentaire/langue en texte brut avant stockage, conserve les zéros initiaux et neutralise les textes commençant par "=". Les quatre commentaires sont restaurés sans changer leur contenu visible ni les prix ; les colonnes C:F existantes sont typées texte, sans modification des inventaires.

La version GAS 43 rattache aussi chaque événement d'historique à l'identifiant de sa demande parente et conserve ce lien lors de l'accusé d'une modification de commentaire. Un rattrapage unique, marqué par la propriété FRJ_HISTORY_ORDER_IDS_VERSION=1, rejoue le miroir depuis le curseur zéro ; les commentaires locaux en attente restent protégés. Ensuite, les lectures redeviennent incrémentales. Il ne faut pas supprimer cette propriété en exploitation normale. Rattrapage constaté en production : 229 événements, tous rattachés à une demande existante, sans erreur ni commentaire en attente.

Test réel du 12/09 : commentaire temporaire sur le devis Public FRJ-20260910-7F2CD6, reçu dans le miroir après synchronisation avec D1 (révision 469), puis retiré et confirmé vide (révision 471). Prix, quantités, profil et statut inchangés ; les deux événements de test restent dans l'historique pour traçabilité. Les 35 demandes ne présentent ensuite ni édition en attente ni conflit ni erreur. 245 tests automatisés réussis ; sources GAS publiées relues identiques au code local.

Aucune migration D1, aucun scan périodique complet supplémentaire des demandes dans D1. Une relecture initiale de l'historique fournit les révisions aux anciens miroirs ; la version 43 ajoute le rattrapage unique des liens décrit ci-dessus. Les contrôles utilisent les index existants ; les lectures catalogue/stock lors d'un changement de prix ciblent les noms d'articles concernés. Le contrôle de révision mesuré sur une demande réelle a lu 2 lignes et écrit 0 ligne ; le plan du stock utilise idx_inventory_current_avatar_item.

Les tests SQLite comptent 2 changements métier pour une correction d'entête (demande + événement), et 3 pour une seule ligne modifiée (demande + événement + ligne). Ce ne sont pas des devis de facturation D1 : les écritures d'index, les lectures de contrôle et le suivi Discord s'ajoutent. Un envoi strictement inchangé et une reprise déjà appliquée ne produisent aucune écriture métier supplémentaire.

Retour arrière : conserver les saisies encore en attente avant toute restauration, puis annuler uniquement le commit de cette évolution. Restaurer le Worker 35239112-3a59-4656-9eca-05438a36ce59 et les sources GAS de référence 3b3997e (version Web App 38). Restaurer aussi les sources HEAD Apps Script, car les triggers les exécutent indépendamment de la version Web App. Retirer la propriété FRJ_ORDER_EDITING_VERSION en cas de retour durable. Ne supprimer ni l'onglet ni les demandes modifiées : le retour du code n'annule pas les données déjà acceptées.

## Désactivation immédiate et réversible

1. Interface publique : passer `cart` à `false` dans `js/features.js`, puis republier GitHub Pages. Les paniers déjà présents sur les machines restent conservés localement.
2. Worker : passer `CART_ENABLED` à `"false"` dans `cloudflare/for-sale-api/wrangler.jsonc`, puis redéployer. Les routes publiques refusent alors les nouvelles transmissions, sans effacer les demandes existantes.
3. Secours GAS : définir la propriété de script `FRJ_CART_ENABLED` à `false` dans le projet Apps Script principal.

Pour désactiver uniquement Discord, supprimer le secret `DISCORD_ORDER_WEBHOOK_URL` du Worker et la propriété `FRJ_DISCORD_ORDER_WEBHOOK_URL` du projet GAS, puis redéployer le Worker.

La suppression des trois tables D1 ou de la feuille GAS n'est pas nécessaire pour revenir en arrière. Le commit Git dédié peut aussi être annulé sans toucher aux données historiques.

## T-019 — Devis Admin (12/09/2026)

Le statut Devis Admin remplace la détection par avatar et origine décrite historiquement en T-018 ci-dessous. Voir [le guide Devis Admin et retour arrière](DEVIS-ADMIN.md). Les règles de contrôle du stock, des TT, MU, profils et campagnes lors de la duplication restent celles de T-018.

## T-018 — Dupliquer un devis (11/09/2026, critère remplacé par T-019)

Dans la Console Admin, « Dupliquer ce devis » apparaît uniquement pour les demandes directes (sourceBackend = d1-admin) dont l'avatar, après suppression des espaces autour et normalisation de casse, est Public, Soc ou Membre FRJ. Le profil réellement enregistré dans le modèle est repris ; son nom n'est pas utilisé pour déduire le tarif.

Le clic ouvre le formulaire de création prérempli, avec avatar, profil et contact modifiables. Le modèle et son historique ne sont pas modifiés. La route Admin protégée GET /admin/orders/:id/duplicate-preview lit le modèle et le catalogue courant sans déclencher de recalcul du modèle. Rien n'est créé et aucun message Discord n'est envoyé avant l'enregistrement.

- Les TT et MU proviennent du catalogue actuel, puis le profil et la campagne active sont appliqués avec les calculs existants ; les anciennes remises du modèle ne sont pas recopiées.
- Les quantités sont plafonnées au stock disponible et la réduction est signalée avec les quantités avant/après.
- Un article absent ou sans stock reste visible et bloquant ; il faut le remplacer ou retirer sa ligne.
- Un MU absent ou invalide laisse la saisie vide et bloquante ; l'Admin doit renseigner une valeur explicite. Changer de profil reprend les valeurs catalogue.
- Le serveur contrôle à nouveau le stock et compare TT, MU et campagne à l'instantané consulté. Si ces données ont changé, il refuse l'enregistrement avant toute écriture et demande de relancer la duplication.
- La nouvelle demande reçoit à l'enregistrement ses propres identifiants, un historique neuf, le statut « À valider », son message Discord et son lien court. La limite existante de dix articles reste applicable.

Le contact est désormais saisi et enregistré également pour les nouvelles demandes directes ordinaires. Le miroir GAS et les notifications réutilisent les colonnes et mécanismes existants : aucune migration ni publication GAS n'est nécessaire.

### Retour arrière T-018

Point de référence avant intervention : commit a47e5e5, Worker 0487003b-bc44-4516-84fb-1ac124042e7d, GAS version 38 (inchangée).

Si les tests utilisateur échouent, annuler le commit dédié T-018 avec un commit de retour (git revert, sans reset forcé), puis pousser pour republier le frontend. Restaurer aussi le Worker précédent avec Wrangler rollback, ou republier le Worker issu du code annulé. Vérifier les éventuelles modifications ultérieures avant l'annulation. Ne supprimer ni demandes créées pendant les tests, ni tables, ni messages Discord. Le retrait du code n'annule pas les demandes déjà enregistrées et ne détruit pas leurs contacts.

