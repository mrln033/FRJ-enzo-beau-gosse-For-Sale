const TRANSLATIONS = {
	EN: {
		title: "[FRJ] - enzo beau gosse = FOR SALE",
		subtitle: "PM Offer InGame @ enzo beau gosse  |  -=> New Oxford Storage <=-",
			
		loadingState: "Loading in progress...",

		filterLabel: "Filter by RAYON",
		selectCategory: "First, select Inventory Category",
		all: "All",

		quantity: "Quantity",
		unitPrice: "Unit TT Price",
		total: "Total TT",
		calcSell: "Selling Price",
			
		close: "Close",
			
		empty: `
			<h2>Welcome to the FRJ Inventory</h2>

			<p>
			This page allows you to browse all items currently available for sale.
			</p>
			<p>
			To get started, <strong>select an inventory category</strong> above.
			</p>

			<ul>
				<li>Browse items by inventory category</li>
				<li>Filter by "Rayon"</li>
				<li>Click on an item's name to open the wiki</li>
				<li>All (L) items are Full TT! un(L) items may need repairs, but the displayed value always corresponds to Full TT</li>
				<li>MU values are updated regularly (hover to see the last update date): they gradually fade and disappear after 7 days</li>
			</ul>

			<p>
			<strong>Tip:</strong> you can click again on a category to reset your selection.
			</p>
		`
	},

	FR: {
		title: "[FRJ] - enzo beau gosse = A VENDRE",
		subtitle: "Faites une offre en jeu @ enzo beau gosse  |  -=> New Oxford Storage <=-",
			
		loadingState: "Chargement en cours...",

		filterLabel: "Filtrer par RAYON ",
		selectCategory: "Sélectionnez une catégorie d'inventaire",
		all: "Tous",

		quantity: "Quantité ",
		unitPrice: "Prix unitaire TT ",
		total: "Total TT ",
		calcSell: "Prix de Vente ",
			
		close: "Fermer",
			
		empty: `
			<h2>Bienvenue dans l'Inventaire FRJ</h2>

			<p>
			Cette page vous permet de consulter tous les objets actuellement en vente.
			</p>

			<p>
			Pour commencer, <strong>sélectionnez une catégorie d'inventaire</strong> ci-dessus.
			</p>

			<ul>
				<li>Parcourez les objets par catégorie d'inventaire</li>
				<li>Filtrez par "Rayon"</li>
				<li>Cliquez sur le nom d'un objet pour ouvrir le wiki</li>
				<li>Tous les items (L) sont Full TT !! Concernant les items non-(L), ils peuvent être à réparer, mais c'est bien la valeur Full TT qui est affichée.</li>
				<li>Les MU sont actualisés régulièrement (survolez la ligne pour afficher la date de mise à jour) : ils s'effacent progressivement pour disparaitre après 7 jours<br><i><b>Membres FRJ =</b> remise de 50% du MU pour tous les membres</i></li>
			</ul>

			<p>
			<strong>Astuce :</strong> vous pouvez recliquer sur la catégorie sélectionnée pour afficher ce message à nouveau.
			</p>
		`
	}
};

let currentLang = localStorage.getItem("lang");

if (!currentLang) {
	currentLang = "EN";
	localStorage.setItem("lang", currentLang);
}

function setLanguage(lang) {
	currentLang = lang;

	// sauvegarde
	localStorage.setItem("lang", lang);

	// mise à jour UI
	updateLanguageButtons();
	applyTranslations();
	renderCards(lastRenderedItems);
}



function updateLanguageButtons() {
	document.getElementById("btnEN").classList.remove("active");
	document.getElementById("btnFR").classList.remove("active");

	if (currentLang === "EN") {
		document.getElementById("btnEN").classList.add("active");
	} else {
		document.getElementById("btnFR").classList.add("active");
	}
}
	
function t(key) {
	return TRANSLATIONS[currentLang][key] || key;
}

