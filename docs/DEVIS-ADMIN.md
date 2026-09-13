# Devis Admin — T-019 / T-020 / T-021

T-022 (13/09/2026) : l'origine visible dans la liste Admin et Discord est **Client** (d1 ou gas-fallback) ou **Admin** (d1-admin, saisie manuelle et duplication). Le backend technique reste conservé dans source_backend/sourceBackend pour l'historique et la synchronisation. Aucun changement de données ou de statut ; convertir une demande en Devis Admin conserve l'origine de sa saisie initiale.

## T-021 : supprimer un modèle

Le bouton **Supprimer définitivement** est réservé aux Devis Admin. Une confirmation explicite affiche la référence et explique l'effacement. L'obsolescence des articles n'est pas évaluée automatiquement : l'Admin décide, même si certains articles sont encore en stock. Annuler la confirmation n'envoie aucune requête.

D1 efface le modèle, ses articles, événements d'historique et jetons de suivi dans une transaction. Les demandes déjà créées par duplication, leurs lignes, leurs liens et leur historique restent intacts. Aucun changement de statut ne simule une suppression ; aucune demande normale, y compris Terminée, n'est supprimable par ce bouton. L'ancienne d.4 reste en attente de cadrage.

Le message Discord du modèle est supprimé ; une réponse 404 signifie déjà absent, sans recréation. Si Discord est indisponible, l'identifiant du message reste en attente pour réessayer.

Google Sheets est nettoyé au prochain poll existant (~5 minutes si accessible), avant les envois de demandes : suppression ciblée des lignes portant ORDER_ID dans COMMANDES_APP, COMMANDES_LIGNES et COMMANDES_HISTORIQUE, y compris les JSON, conflits et éditions en attente sur ces lignes. En-têtes, autres demandes et inventaires ne sont pas touchés. Les opérations de transfert et de suppression sont sérialisées par le verrou de script. Si le nettoyage échoue ou l'accusé réseau est perdu, il sera rejoué.

Migration additive **0026_delete_admin_quotes.sql** : registre technique purchase_order_deletions et gardes anti-résurrection. Seuls l'identifiant du modèle, la date et les accusés techniques sont conservés ; aucun avatar, article, prix, historique ou jeton de suivi. L'identifiant Discord temporaire est effacé après succès. GAS conserve également un marqueur FRJ_DELETED_ORDER_<id>=1 ; les anciens miroirs ne peuvent pas recréer le modèle. Ce marqueur n'est pas un devis archivé. Les sauvegardes privées antérieures, hors tables actives, ne sont pas purgées par le bouton.

API Admin authentifiée : DELETE /admin/orders/<id>/admin-quote?confirm=<référence>. Refus sans confirmation ou si le statut n'est pas un modèle ; répétition idempotente. GET /sync/order-deletions expose un lot borné de 20 identifiants en attente, avec index partiel ; POST /sync/order-deletions/ack acquitte le nettoyage GAS et reprend Discord. Ces deux routes utilisent l'authentification de synchronisation existante. Pas de nouveau trigger, pas de scan D1 complet des demandes, pas de suppression automatique sans décision Admin.

### Publication T-021

Worker **5fd49ad4-abaa-49b1-a52f-175ab6cda0a2**, GAS **45** (Web App et sources HEAD), migration **0026**. Sauvegarde privée préalable : **save/20260912-before-quote-deletion.sql**, 12 945 988 octets, exclue de Git. Interface publiée via le commit T-021 ; validation utilisateur attendue.

### Tests et retour ciblé T-021

255 tests automatisés réussis : confirmation annulée, refus des demandes normales, cascade D1, conservation des copies, ancien import bloqué, trois feuilles purgées précisément, ancien miroir ignoré, en-têtes invalides interrompant l'opération, panne/reprise et absence Discord. Aucun devis réel supprimé pendant les contrôles de publication.

Référence avant T-021 : Git **43beb04**, Worker **6b8fdab9-13ea-48a8-a873-df1d89d2283a**, GAS **44**.
En cas de non-validation, masquer le bouton par un revert ciblé. Terminer d'abord les nettoyages déjà demandés. Si aucune suppression n'a été effectuée, Worker/GAS peuvent revenir aux versions de référence. Sinon, conserver 0026, les marqueurs et les gardes GAS anti-résurrection : ne pas restaurer aveuglément GAS 44 qui ignore ces gardes. Ne pas restaurer intégralement une sauvegarde après de nouveaux achats. Le retour du code ne recrée ni les devis ni leurs messages supprimés : une récupération de données depuis une sauvegarde privée éventuelle exige une décision explicite et une restauration sélective accompagnée. Ne pas supprimer 0024/0025.


## Compléments T-020 : clôture et identité

- **Terminée** signifie livrée et payée : statut, coordonnées, profil, articles, prix et commentaires d'historique sont définitivement en lecture seule. Impossible de rouvrir ou de convertir cette demande, y compris par l'API ou l'édition Sheets.
- **À préparer** et **Prête** interdisent également la conversion directe en Devis Admin. Les autres transitions existantes sont conservées.
- La case Devis Admin est alignée devant son texte. Le profil reste obligatoire ; l'avatar devient facultatif pour un modèle seulement. Si vide à l'enregistrement : **Public** pour le profil public, **Membre Soc** pour le profil FRJ. Un avatar personnalisé est conservé. Une duplication normale exige toujours l'avatar.
- Sheets reste un miroir éditable physiquement : une saisie interdite est refusée par D1, ne modifie pas la demande et doit être abandonnée/restaurée depuis la version D1 via le mécanisme d'édition existant. Aucun changement du format des inventaires.
- Migration additive **0025_completed_order_lock.sql** : huit gardes SQL, aucune réécriture de données. Les confirmations de prix sont effectuées avant le verrouillage terminal dans la même transaction. Les accusés Discord et de synchronisation restent permis ; l'historique métier déjà enregistré ne peut pas être réécrit.
- Aucun nouveau déclencheur ou audit complet. GAS 44 reste inchangé. Tests locaux de clôture et de refus ; ne pas terminer une demande réelle uniquement pour tester.

### Publication T-020 du 12/09/2026

250 tests réussis. Worker **6b8fdab9-13ea-48a8-a873-df1d89d2283a** publié avant application de 0025 pour préserver les clôtures pendant le déploiement. Les huit gardes sont présentes en production ; contrôle en lecture seule : 35 demandes, dont 21 Terminées. Sauvegarde privée **save/20260912-before-completed-lock.sql**, 12 937 891 octets, exclue de Git. Frontend publié par le commit T-020 ; validation utilisateur attendue.

### Retour ciblé de T-020

Référence préalable : Git **d1feec7**, Worker **1501b9a8-f3bd-4301-b67d-8731f2f06977**, GAS **44** inchangé. Sauvegarder D1 avant publication et conserver les achats ultérieurs.
En cas de non-validation, sous pause des éditions : retirer uniquement les huit déclencheurs de 0025 (purchase_advanced_quote_conversion, purchase_completed_header_update, purchase_completed_header_delete, purchase_completed_item_insert, purchase_completed_item_update, purchase_completed_item_delete, purchase_completed_history_update, purchase_completed_history_delete), puis revenir au Worker de référence et révoquer le commit T-020 par un revert ciblé. Garder 0024 et les Devis Admin. Ne pas restaurer toute la base ni effacer des demandes. Consigner le retrait et prévoir une nouvelle migration pour toute réactivation des gardes, puisque 0025 restera enregistrée comme appliquée.


## Utilisation

- Nouvelle demande : cocher **Créer un Devis Admin** avant l'enregistrement. Profil obligatoire, avatar facultatif selon les règles T-020 ci-dessus.
- Demande existante hors À préparer / Prête / Terminée : choisir **Devis Admin** et confirmer la conversion. Son ancien lien client devient indisponible. Les prix, lignes, coordonnées et l'origine sont conservés.
- Le modèle reste Devis Admin : le sélecteur de progression et le suivi client ne sont plus proposés. Les articles, quantités et MU restent éditables avec les validations existantes. Coordonnées et profil sont également éditables dans Sheets.
- **Dupliquer ce devis** prépare une demande indépendante ; modifier avatar/contact/profil avant enregistrement. La copie commence **À valider**, même si un appel tente de la créer en Devis Admin. Le modèle et son historique ne changent pas.
- Le stock courant plafonne les quantités proposées ; article absent, sans stock ou MU inexploitable est signalé. TT, MU, profil et promotion du moment sont relus et revérifiés à l'enregistrement. Le modèle n'est pas recalculé automatiquement lors d'un changement de promotion.
- Filtre et compteur Devis Admin séparés dans la console. Un ancien filtre enregistré reçoit ce nouveau statut une seule fois.
- Discord affiche Devis Admin ; son titre renvoie à la console Admin (sans paramètre d'activation). Chaque copie enregistrée a son propre message et lien client.

Le nom Public/Soc/Membre FRJ ne suffit plus à rendre une demande duplicable. Seuls les modèles explicitement convertis le sont ; aucune conversion globale des anciens noms.

## Sheets et stockage

Dans COMMANDES_APP, STATUT accepte **admin_quote**. Enregistrer la conversion séparément d'un changement de prix. L'édition différentielle existante assure le transfert Sheets → D1 ; le miroir restitue admin_quote dans Sheets. Le poll reste toutes les cinq minutes, sans nouveau déclencheur. Les conflits et reprises idempotentes sont inchangés.

Migration additive **0024_admin_quotes.sql** : colonne admin_quote, 0 par défaut, et deux gardes SQL. Aucune table reconstruite, aucun inventaire modifié. Le statut commercial interne du modèle reste submitted, avec approval_required=0 ; l'état métier exposé prioritaire est admin_quote. Les gardes refusent toute progression accidentelle du modèle. Ne pas modifier directement ces colonnes D1 en exploitation normale.

La propriété GAS FRJ_ADMIN_QUOTES_VERSION=1 marque l'installation unique de la validation de STATUT. La propriété de synchronisation des demandes et son curseur ne sont pas réinitialisés.

Les accès publics par référence, jeton initial ou ancien jeton supplémentaire sont refusés pour un modèle, ainsi que l'acceptation, l'annulation et la génération d'un lien client. Les copies normales conservent tous leurs accès habituels.

## Vérifications

Tests automatisés : création privée, conversion indépendante de l'avatar et de l'origine, absence de modification des lignes lors de la conversion, blocage des transitions, modification/ajout/retrait de lignes sans sortie du statut, exclusion des promotions automatiques, synchronisation Sheets bidirectionnelle et reprise idempotente, duplication avec contrôle du catalogue et copie normale, refus des anciens accès clients, libellés et bouton dans l'interface.

En production, tester sur FRJ-20260904-D37391 : présence de Dupliquer, modification libre des coordonnées de la copie, contrôles des lignes et copie au statut À valider. Vérifier aussi une demande normale et le miroir Sheets. La validation finale appartient à l'utilisateur.

## Publication et contrôles du 12/09/2026

Worker **1501b9a8-f3bd-4301-b67d-8731f2f06977**, GAS **44**, migration 0024 appliquée. 247 tests automatisés réussis ; sources GAS publiées relues identiques.

FRJ-20260904-D37391 convertie via COMMANDES_APP!H29, puis miroir reçu en révision 477 sans conflit. Vérification D1 indépendante : admin_quote=1, approval_required=0, origine d1 conservée. Articles/profil inchangés, TT 210 PED et vente 231 PED conservés. Un seul modèle parmi 35 demandes. Ancien suivi du modèle refusé (404), suivi témoin normal opérationnel (200), message Discord relu conforme. Aucune demande de test créée en production ; la duplication finale reste à valider par l'utilisateur.

## Retour arrière ciblé

Références avant T-019 :
- Git : f8485d7.
- Worker : 24930711-fdab-411f-99c9-38cd62840fb0.
- GAS : version Web App 43 ; restaurer aussi les sources HEAD utilisées par les déclencheurs.
- Sauvegarde privée : save/20260912-before-admin-quotes.sql, exclue de Git.

Ne pas restaurer intégralement cette sauvegarde en production après de nouveaux achats : cela supprimerait les modifications postérieures.

Procédure accompagnée :
1. Mettre les éditions de demandes en pause et relever toute saisie Sheets en attente. Sauvegarder les modèles et leurs événements actuels.
2. Examiner chaque ligne admin_quote=1. Pour les demandes converties, l'événement de conversion conserve le statut précédent et previousApprovalRequired ; restaurer uniquement ces champs et mettre admin_quote=0, sans toucher aux articles ni aux modifications ultérieures. Les modèles créés pendant T-019 n'ont pas d'état précédent : décider explicitement de leur état de repli, sans les supprimer.
3. Consigner les restaurations dans l'historique, vérifier le miroir et les messages Discord. Attention : l'ancien code ne connaît pas les modèles privés ; après retour arrière, les anciens liens redeviennent utilisables selon les règles historiques.
4. Annuler le commit T-019 par un commit de revert (pas de reset), pousser le frontend, restaurer le Worker de référence et GAS 43 + ses sources HEAD. Vérifier qu'aucune évolution postérieure n'est annulée.
5. La colonne additive peut rester en place avec tous les indicateurs à 0 : le code précédent l'ignore et les gardes deviennent inactives. Ne pas supprimer de tables. Retirer la validation admin_quote de STATUT et la propriété FRJ_ADMIN_QUOTES_VERSION seulement si le retrait est durable.

Les demandes créées par duplication, leurs liens et leurs historiques sont conservés. Le retour du code n'annule pas leurs ventes ni leurs données.
