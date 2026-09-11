# Panier d'achat — fonctionnement et retour arrière

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

## Désactivation immédiate et réversible

1. Interface publique : passer `cart` à `false` dans `js/features.js`, puis republier GitHub Pages. Les paniers déjà présents sur les machines restent conservés localement.
2. Worker : passer `CART_ENABLED` à `"false"` dans `cloudflare/for-sale-api/wrangler.jsonc`, puis redéployer. Les routes publiques refusent alors les nouvelles transmissions, sans effacer les demandes existantes.
3. Secours GAS : définir la propriété de script `FRJ_CART_ENABLED` à `false` dans le projet Apps Script principal.

Pour désactiver uniquement Discord, supprimer le secret `DISCORD_ORDER_WEBHOOK_URL` du Worker et la propriété `FRJ_DISCORD_ORDER_WEBHOOK_URL` du projet GAS, puis redéployer le Worker.

La suppression des trois tables D1 ou de la feuille GAS n'est pas nécessaire pour revenir en arrière. Le commit Git dédié peut aussi être annulé sans toucher aux données historiques.

## T-018 — Dupliquer un devis (11/09/2026)

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

