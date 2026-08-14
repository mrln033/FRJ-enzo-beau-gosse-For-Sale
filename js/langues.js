const TRANSLATIONS = {
	EN: {
		title: "[FRJ] - enzo beau gosse = FOR SALE",
		subtitleStart: "PM Offer InGame @ ",
		subtitleEnd: "  |  -=> New Oxford Storage <=-",
		copyPlayerTooltip: "Click to copy, then paste in the in-game chat",
		copyPlayerSuccess: "Copied!",
		copyPlayerCommand: "/w enzo beau gosse PM from FRJ - For Sale",
		
		img_storage: "storage/00_EnTete-Storage-EN.png",
			
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
				<li>All (L) items are Full TT! un(L) items may need repairs, but the displayed value always corresponds to Full TT. Feel free to ask me.</li>
				<li>MU values are updated regularly (hover to see the last update date): they gradually fade and disappear after 7 days.<br>They are calculated automatically based on MU and daily/weekly/monthly/annual sales. Feel free to make an offer.</li>
			</ul>

			<p>
			<strong>Tip:</strong> you can click again on a category to reset your selection.
			</p>
		`
	},

	FR: {
		title: "[FRJ] - enzo beau gosse = A VENDRE",
		subtitleStart: "Faites une offre en jeu @ ",
		subtitleEnd: "  |  -=> New Oxford Storage <=-",
		copyPlayerTooltip: "Cliquez pour copier puis coller dans le chat IG",
		copyPlayerSuccess: "Copié !",
		copyPlayerCommand: "/w enzo beau gosse Msg depuis FRJ - For Sale",
		
		img_storage: "storage/00_EnTete-Storage-FR.png",
			
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
				<li>Tous les items (L) sont Full TT !! Concernant les items non-(L), ils peuvent être à réparer, mais c'est toujours la valeur Full TT qui est affichée. N'hésitez pas à me demander.</li>
				<li>Les MU sont actualisés régulièrement (survolez la ligne pour afficher la date de mise à jour) : ils s'effacent progressivement pour disparaitre après 7 jours.<br>Ils sont calculés automatiquement en fonction des MU et ventes jour/semaine/mois/année. N'hésitez pas à faire une offre.<br><i><b>Membres FRJ =</b> remise de 50% du MU pour tous les membres</i></li>
			</ul>

			<label class="frj-member-toggle">
				<input type="checkbox" id="frjMemberCheckbox">
				<span>Je suis membre FRJ</span>
			</label>


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
	window.FRJ_CART?.refresh();
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

