# FRJ For Sale API — Cloudflare Worker + D1

Ce projet est volontairement séparé de `../worker.js`, qui gère Discord pour une autre application.

## Organisation du code

- `src/index.js` : point d'entrée et routage HTTP, authentification et CORS ;
- `src/application.js` : traitements catalogue, imports, synchronisation et demandes ;
- `src/config.js` : limites, origines autorisées et constantes D1 ;
- `src/http.js` : réponses HTTP, lecture bornée, empreintes et erreurs API ;
- `src/domain.js`, `src/orders.js`, `src/sync.js`, `src/discord.js` : règles métier spécialisées.

Le point d'entrée déclaré dans `wrangler.jsonc` et tous les contrats HTTP restent inchangés.

## État actuel

- Worker déployé : <https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev>
- D1 distant : `frj-for-sale` (`6afa102c-94a4-4b40-a61b-0fdc2e0a2b86`), région WEUR.
- La volumétrie évolue avec les imports ; `GET /health` fournit les compteurs catalogue courants.
- Le front GitHub Pages peut utiliser GAS ou D1 sans changer son adresse publique.
- Les lectures D1 sont publiques ; `ADMIN_TOKEN`, `SYNC_TOKEN` et `DISCORD_ORDER_WEBHOOK_URL` sont configurés dans les secrets Cloudflare.
- Le frontend publié permet de choisir D1 avec `?backend=d1`, tout en conservant GAS comme secours de lecture.

## Contrat HTTP conservé

- `GET /?action=categories`
- `GET /?action=inventoryDate`
- `GET /?action=inventoryTarget&avatar=enzo`
- `GET /?category=ARMORS`
- `POST /?type=inventory&avatar=enzo`
- `POST /?type=mu`

Les lectures restent publiques. Les écritures exigent `Authorization: Bearer <ADMIN_TOKEN>`.

## Bascule progressive du frontend

- URL normale : GAS reste prioritaire et D1 sert de repli en lecture seule.
- URL avec `?backend=d1` : D1 devient prioritaire et GAS sert de repli en lecture seule.
- Après activation du mode Admin dans l'onglet, les pages ouvertes avec `?backend=d1` utilisent D1 comme backend explicite ; les imports jumelés continuent de cibler GAS et D1 selon leur action dédiée.
- Le jeton est demandé au premier import D1 et conservé dans `sessionStorage` jusqu'à la fermeture de l'onglet.
- Une écriture ne bascule jamais automatiquement vers l'autre backend, afin d'éviter les doubles imports.

Le secret n'est jamais enregistré dans le code ni dans `localStorage`. Conserver sa valeur dans un gestionnaire
de mots de passe ; Cloudflare ne permet pas de la relire ensuite.

## Recréation locale

1. Installer les dépendances avec `pnpm install`.
2. Si nécessaire, créer la base : `pnpm wrangler d1 create frj-for-sale`.
3. Copier le `database_id` retourné dans `wrangler.jsonc`.
4. Appliquer le schéma : `pnpm db:migrate:local`.
5. Générer le snapshot privé : `pnpm db:build-seed`.
6. Charger le snapshot : `pnpm db:seed:local`.
7. Lancer l’API : `pnpm dev`.

## Préparation de la production

1. Appliquer le schéma distant : `pnpm db:migrate:remote`.
2. Charger le snapshot distant : `pnpm db:seed:remote`.
3. Créer les secrets nécessaires : `pnpm wrangler secret put ADMIN_TOKEN`, `SYNC_TOKEN` et `DISCORD_ORDER_WEBHOOK_URL`.
4. Déployer : `pnpm deploy`.
5. Contrôler l’API distante : `pnpm smoke`.

Pour vérifier un jeton sans écrire en base, définir temporairement `FRJ_ADMIN_TOKEN` dans le terminal puis lancer
`node tools/auth-smoke.mjs https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev`.

Le fichier `seed/initial.sql` et les classeurs du dossier `save/` sont ignorés par Git, car ils
contiennent les inventaires complets. Ne pas les forcer dans le dépôt public.

Conserver les URLs GAS et D1 stables : les mécanismes de repli et les liens de suivi en dépendent.

## Stockage différentiel et retour arrière

Les imports ne créent plus de versions complètes. Un import identique ne modifie aucune ligne métier ; sinon,
seules les lignes ajoutées, modifiées ou supprimées sont écrites. Les inventaires sont consolidés sur le triplet
`avatar + item + container` : quantité et valeur PED sont additionnées. Les MU sont identifiées par item et le
catalogue conserve toutes les lignes BDD_APP, y compris ses doublons, tout en gardant ses tables publiques
normalisées.

Depuis d.8.1, `container_config` prépare un choix indépendant par avatar. La migration reprend le filtre D1
historique pour Enzo, désactive les autres avatars par défaut et découvre les nouveaux conteneurs par ajout
uniquement. Les suppressions d'inventaire ne retirent jamais une configuration existante. Depuis d.8.2, la vue
`saleable_inventory` joint ce référentiel à l'inventaire courant : le catalogue, les contrôles de stock et les
révisions de demandes utilisent tous les mêmes choix, sans liste de conteneurs dans le code du Worker.

Une seule base commune par dataset remplace les anciens snapshots pour la fusion GAS ↔ D1. Le journal de
synchronisation conserve les 500 dernières opérations par dataset et indique le nombre réel de lignes D1
écrites. Les anciennes tables versionnées restent temporairement en lecture seule pour permettre un retour
arrière du code ; D1 Time Travel reste disponible pour une restauration de la base.

## Synchronisation GAS ↔ D1

Les modules `../../gas/Sync*.gs` synchronisent six datasets : catalogue, MU et les quatre inventaires.
Une modification demande une synchronisation dans un délai maximal de cinq minutes. Toute synchronisation
ayant corrigé des données programme un audit d’intégrité 30 minutes plus tard. Un audit quotidien est aussi
exécuté vers 02 h 00, et le signal D1 est contrôlé toutes les cinq minutes.

Les inventaires et les MU sont bidirectionnels. Une modification indépendante de chaque côté est fusionnée
à partir de la dernière base commune ; une suppression fait partie de l’état courant et est donc
propagée. En cas de modification concurrente pendant le transfert, l’écriture est refusée puis retentée après
relecture.

Le catalogue est inclus afin de garantir la même liste d’articles vendables, mais `BDD_APP` reste
provisoirement sa source maîtresse : les colonnes prix/image/wiki dépendent encore de formules
`IMPORTRANGE`. D1 en reçoit un miroir complet sans écraser ces formules Google Sheets.

Installation et publication : suivre `../../gas/README.md`, configurer le même secret `SYNC_TOKEN` dans
Cloudflare et les propriétés du script, puis exécuter `installFrjBidirectionalSync()` et un audit initial.

## Administration et rapport

L'entrée discrète `?admin=1` active le menu commun dans `sessionStorage` pour l'onglet courant, puis le paramètre
est immédiatement retiré de l'URL. Le menu permet d’ouvrir explicitement les catalogues et les pages d’import
GAS ou D1 sans propager ce paramètre. La page `rapport-sync.html` affiche l’état des six datasets et les 100
derniers événements du journal croisé GAS ↔ D1 lorsque la session Admin est active.

Le bouton « Auditer maintenant » appelle `POST /admin/sync-audit-now`. Le Worker authentifie le jeton
administrateur, puis appelle la web app privée de synchronisation GAS avec `SYNC_TOKEN`. Ce premier audit
ignore les délais ordinaires ; une correction déclenche immédiatement la synchronisation puis conserve le
cycle normal de vérification à +30 minutes.

La session activée par `admin=1` contrôle seulement l’affichage du menu et l'accès aux pages frontend. Le rapport appelle
`GET /admin/sync-report`, protégé par `ADMIN_TOKEN`; aucune donnée de synchronisation n’est exposée sans ce
jeton. GAS remonte dans `sync_audit` le résultat global de chaque exécution, tandis que D1 conserve les 500
derniers événements par dataset.
