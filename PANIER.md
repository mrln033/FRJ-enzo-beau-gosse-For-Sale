# Panier d'achat — fonctionnement et retour arrière

## Fonctionnement

- Le panier est enregistré uniquement dans le `localStorage` du navigateur tant qu'il n'est pas transmis.
- « Copier ma liste » ne transmet rien : il copie un message prêt à coller dans le jeu.
- « Transmettre à Enzo » tente D1 en priorité. Si D1 est indisponible, GAS conserve la demande dans la feuille `COMMANDES_APP`, puis le projet de synchronisation la transfère vers D1.
- Une transmission n'enlève et ne réserve aucun stock. Elle crée une demande à traiter dans `commandes.html?admin=1`.
- Le prix de base est toujours `PRIX_UNITAIRE`, c'est-à-dire le prix TT affiché sur la tuile. Le MU affiché est ajouté à ce prix. En français, si « Je suis membre FRJ » est coché, seul le MU est réduit de 50 %.
- Avant l'enregistrement, D1 ou GAS relit stock, prix affiché et MU. En cas d'écart, le panier est actualisé et une nouvelle confirmation est requise.
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

GAS utilise exclusivement la feuille `COMMANDES_APP` pour les demandes reçues pendant une indisponibilité D1. Les colonnes `DISCORD_MESSAGE_ID` et `DISCORD_ERROR` assurent la reprise vers D1. Aucun schéma d'inventaire, de catalogue ou de MU n'est modifié.

## Désactivation immédiate et réversible

1. Interface publique : passer `cart` à `false` dans `js/features.js`, puis republier GitHub Pages. Les paniers déjà présents sur les machines restent conservés localement.
2. Worker : passer `CART_ENABLED` à `"false"` dans `cloudflare/for-sale-api/wrangler.jsonc`, puis redéployer. Les routes publiques refusent alors les nouvelles transmissions, sans effacer les demandes existantes.
3. Secours GAS : définir la propriété de script `FRJ_CART_ENABLED` à `false` dans le projet Apps Script principal.

Pour désactiver uniquement Discord, supprimer le secret `DISCORD_ORDER_WEBHOOK_URL` du Worker et la propriété `FRJ_DISCORD_ORDER_WEBHOOK_URL` du projet GAS, puis redéployer le Worker.

La suppression des trois tables D1 ou de la feuille GAS n'est pas nécessaire pour revenir en arrière. Le commit Git dédié peut aussi être annulé sans toucher aux données historiques.

