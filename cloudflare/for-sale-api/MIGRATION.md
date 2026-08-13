# Migration Google Sheets / GAS vers Cloudflare D1

## État constaté

- Le front GitHub Pages lit un Apps Script public avec une constante `API_URL`.
- `BDD_APP` réserve 3 255 lignes et contient 1 113 articles renseignés.
- Les prix, images et liens wiki viennent du classeur externe `Referentiel!A:G`.
- Les quantités viennent de l’inventaire Enzo et sont agrégées selon une liste de conteneurs autorisés.
- Les MU sont importés puis pondérés sur les périodes jour, semaine, mois et année.
- Les quatre inventaires bruts contiennent 3 097 lignes actives au total.
- Le fichier `../worker.js` appartient à un autre usage : Discord et relais vers le GAS de la Caisse.
  Il ne doit pas être modifié ou redéployé pour cette migration.

## Architecture retenue

- GitHub Pages reste l’hébergement public du front.
- Un nouveau Worker `frj-for-sale-api` fournit l’API HTTP.
- Une base D1 `frj-for-sale` conserve le catalogue, l’état courant consolidé des inventaires, les MU et les promotions.
- Les lectures sont publiques et acceptent l’origine `https://mrln033.github.io`.
- Les imports exigent un secret Worker `ADMIN_TOKEN`, envoyé en Bearer token.
- Les imports utilisent des écritures différentielles et un garde-fou sans écriture lorsque l’empreinte est identique.
- Les inventaires fusionnent les lignes de même triplet `avatar + item + container`, en additionnant quantité
  et valeur PED.
- Une base commune unique par dataset permet le merge à trois voies sans conserver chaque import.
- Une modification programme la synchronisation sous cinq minutes et chaque correction est contrôlée par un
  audit 30 minutes plus tard ; un audit quotidien s’exécute vers 02 h 00.
- Inventaires et MU sont fusionnés dans les deux sens à partir de la dernière base commune. `BDD_APP` reste
  provisoirement maître du catalogue tant que ses colonnes de référentiel utilisent `IMPORTRANGE`.

Un domaine Cloudflare n’est pas nécessaire : le front GitHub Pages peut appeler l’URL `workers.dev` du
nouveau Worker grâce aux en-têtes CORS.

## Parité connue

Le snapshot SQL reproduit exactement les quantités publiées dans neuf catégories. Dans `BLUEPRINTS`,
trois références `Ferguson's …` deviennent visibles : l’apostrophe casse actuellement la chaîne de la
formule Google `QUERY`, tandis que SQL utilise une jointure sûre. Cet écart est une correction métier connue.

## Déploiement progressif

1. [x] Tester le schéma, le seed et les endpoints en D1 local.
2. [x] Créer la base D1 distante et appliquer `migrations/0001_initial.sql`.
3. [x] Charger le seed privé construit depuis les XLSX.
4. [x] Déployer le nouveau Worker sans changer le front.
5. [ ] Comparer les réponses GAS et Worker pour chaque catégorie. Le script
   `tools/compare-gas-d1.mjs` est prêt, mais GAS renvoie actuellement des 404 intermittentes depuis
   l’environnement de contrôle.
6. [x] Ajouter localement au front une bascule `?backend=d1`, GAS restant le secours en lecture. Le frontend
   publié n'est pas encore modifié.
7. [x] Créer `ADMIN_TOKEN` et adapter localement les pages d'import : jeton en `sessionStorage`, aucune écriture
   de secours automatique, contrôle authentifié sans mutation réussi.
8. [ ] Déployer la synchronisation privée, installer les triggers 15/30 minutes et réussir l’audit initial.
9. [ ] Retirer le secours GAS seulement après validation des imports réels et d’un exercice de retour arrière.

## Données privées

`save/` et `seed/initial.sql` contiennent les inventaires complets. Ils sont exclus par `.gitignore` et ne
doivent jamais être ajoutés de force au dépôt GitHub public.
