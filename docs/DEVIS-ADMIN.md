# Devis Admin — T-019

## Utilisation

- Nouvelle demande : cocher **Créer un Devis Admin** avant l'enregistrement. Avatar et profil sont indépendants.
- Demande existante : choisir **Devis Admin** dans son statut et confirmer la conversion. Son ancien lien client devient indisponible. Les prix, lignes, coordonnées et l'origine sont conservés.
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
