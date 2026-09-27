# Inventaire : designs V19 et Ancien (T-026)

## Fonctionnement

Depuis le 27/09/2026, **V19** est le choix par défaut. La petite liste sombre **Design**, juste à droite de l'en-tête centré (juste dessous sur écran étroit), permet de choisir **Ancien / Old**. Le choix est conservé dans le navigateur (`FRJ_INVENTORY_DESIGN`), indépendamment de la langue et du profil. Une valeur absente ou inconnue revient à V19.

Changer de design ne recharge pas les données, ne modifie pas l'URL, la catégorie, le rayon, le panier ou le profil et n'enregistre pas une nouvelle visite de catégorie.

Chaque design possède son ordre :
- V19 : Money And Deeds, Clothes, Armors, Weapons, Tools, Materials, Resources, Blueprints, Vehicles, Miscellaneous, Mindforce.
- Ancien : Money And Deeds, Clothes, Armors, Weapons, Tools, Mindforce, Materials, Resources, Blueprints, Vehicles, Miscellaneous.

Les catégories sans stock publiable restent masquées. Les noms internes STORAGE et les tris du catalogue ne changent pas. Les infobulles FR/EN utilisent `js/langues.js`, capitalisées en V19, en majuscules pour Ancien. Les trois états des images restent distincts ; la navigation est également accessible au clavier.

## Dimensions et ressources

Précision finale validée en conversation : conserver l'**emplacement historique de 60 × 60 px**, en largeur comme en hauteur, sans étirement ni élargissement du bandeau. Les PNG V19 de 52 × 38 px sont affichés à environ **60 × 43,85 px**, centrés dans cet emplacement. Les PNG anciens restent à 60 × 60 px. L'espacement de 10 px et les retours à la ligne sont conservés.

La hauteur réservée à l'en-tête reste celle de la boîte historique de ratio 453/35, limitée à 400 px de large. Depuis le complément demandé le 27/09/2026, l'image V19 est affichée dans une fenêtre de **540 px maximum** (environ +35 %), en utilisant l'espace libre existant avant les boutons, sans agrandir le bandeau. Sur un conteneur de 760 px ou moins, la fenêtre est limitée à 400 px et à la largeur disponible ; le sélecteur passe dessous dans l'espacement déjà réservé. Le centrage de l'en-tête est indépendant de la largeur du sélecteur. Couleurs sombres, contours discrets et focus clavier visible.

Les PNG sources restent intacts : le cadrage CSS masque leur marge blanche et compense le décalage de six pixels entre EN et FR. Fenêtre source commune 2099 × 152 px : x=2, y=6 en EN / y=12 en FR (source 2101 × 164). L'image conserve ses proportions. Ce cadrage dépend des fichiers fournis : le réévaluer si les PNG sont remplacés. Les tuiles d'articles, calculatrices, stickers et prix ne changent pas.

Les 35 nouveaux PNG utilisés sont dans `img/storage/V19_*.png` (deux en-têtes et onze boutons à trois états). La capture de référence `V19_Visuel_Compteurs_d_Items.png` et les archives ZIP de préparation ne sont pas nécessaires au site et restent locales.

## Compteurs

Les chiffres verts sont affichés **uniquement en V19**, en bas à droite du bouton :
- catégorie non sélectionnée : total de références distinctes disponibles dans cette catégorie ;
- catégorie sélectionnée : références distinctes correspondant au rayon actif ;
- quantité de 200 pour un même article : compte pour 1 ;
- un article présent dans plusieurs rayons d'une catégorie : compte pour 1 dans son total ;
- MU absent ou périmé : ne retire pas un article du compteur ;
- une catégorie chargée actualise son total ; la désélection réaffiche ce total.

Le filtre agit uniquement sur le compteur de l'onglet actif. Les changements de profil ne changent pas le stock ni le décompte.

## API, coût et secours

`?action=categorySummary` renvoie `{categories: [...], counts: {ARMORS: 85, ...}}`.

- D1 : une seule requête SELECT, avec COUNT DISTINCT, listings actifs et stock Enzo issu des conteneurs autorisés ; aucune écriture, aucune migration. Elle remplace l'appel initial aux catégories, sans charger les articles des onze onglets. Cache HTTP public habituel (60 secondes navigateur, 300 secondes partagé).
- GAS : lecture groupée des colonnes STORAGE/RAYON/ITEM/QUANTITE de BDD_APP, noms distincts et quantités positives ; cache de 300 secondes. Aucun changement des feuilles ou formules.
- Le client utilise D1 par défaut et le secours GAS habituel. **Seule cette nouvelle action GAS vise la Web App applicative maintenue**, via GAS_APP_URL ; les articles, catégories historiques, imports et autres routes gardent leurs adresses existantes.
- Si la synthèse est indisponible ou si un ancien backend renvoie un contrat incompatible, les catégories historiques sont chargées. Un compteur inconnu affiche « — », jamais un zéro inventé ; une catégorie consultée retrouve son compteur depuis ses articles.
- Aucun polling supplémentaire, aucun message Queues et aucun appel réseau lors d'un changement de design, de langue ou de filtre.
- Les réponses d'une ancienne sélection ne peuvent plus écraser une catégorie sélectionnée entre-temps.

## Vérifications et publication

Tests automatisés : contrats D1/GAS, unicité, stock/visibilité, cache, traduction, ressources aux dimensions attendues, préférence V19/Ancien, total/filtre, secours et réponses tardives. Vérifications Chromium à 1280, 768 et 375 px : proportions, hauteur stable, ordre propre, filtres conservés, compteurs, langue et préférence après rechargement.

Publication backend du 27/09/2026 :
- Worker `bfd78af1-20f5-456a-9acc-dfaa803f5369` ;
- GAS **47**, même URL Web App, sources HEAD relues et vérifiées (17 fichiers) ;
- synthèses publiques D1 et GAS vérifiées identiques sur les dix catégories disponibles.

Frontend : commit `c7be91c` publié sur GitHub Pages le 27/09/2026 (build terminé). Les cinq fichiers frontend et les 35 PNG servis ont été vérifiés identiques. Contrôles Chromium sur le site public avec D1 puis `backend=gas` : dix catégories, compteurs concordants, sélection directe, FR/EN et V19/Ancien, aucune erreur JavaScript. Les appels de statistiques ont été neutralisés pendant ces contrôles pour ne pas gonfler les visites. 283 tests automatisés réussis. Validation finale utilisateur attendue en production.

## Retour arrière ciblé

1. Pour un retour visuel individuel immédiat, sélectionner **Ancien / Old**.
2. Pour retirer l'évolution, rétablir les fichiers frontend du lot depuis le commit préalable `5e63d65`, puis republier GitHub Pages. Ne pas annuler les changements ultérieurs ni supprimer les fichiers utilisateur non suivis.
3. La nouvelle route backend est additive : elle peut rester publiée après retrait du frontend. Si son retrait est nécessaire, revenir au Worker `6c85c57b-3dbf-4df8-8d9d-53843b8887ff` et à la Web App GAS **46** ; rétablir également les seules sources HEAD Catalog/Code concernées, après comparaison avec les modifications ultérieures.
4. **Ne restaurer aucune base, aucune feuille, aucun inventaire ou demande.** T-026 n'écrit aucune donnée métier. Aucun trigger ni secret n'a été ajouté ou modifié.

