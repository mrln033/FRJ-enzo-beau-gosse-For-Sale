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

		cartHelpPageTitle: "Cart help — FRJ For Sale",
		cartHelpContent: `
			<header class="cart-help-intro">
				<span class="cart-help-kicker">FRJ For Sale</span>
				<h1>How does the cart work?</h1>
				<p>The cart lets you set items aside and group them into a purchase request.</p>
			</header>
			<section>
				<h2>1. Add an item</h2>
				<p>Each item card with an MU has a calculator in its bottom-right corner. Use it to select the quantity you want and calculate the price, including MU.</p>
				<p>Inside the calculator, the icon becomes a cart: click it to add the selected quantity.</p>
				<aside class="cart-help-note"><strong>Good to know</strong><span>The cart icon in the top-right corner shows the total quantity and estimated amount. A cart can contain up to 10 item lines.</span></aside>
			</section>
			<section>
				<h2>2. Prepare your request</h2>
				<p>At this stage, the cart is stored only on your device: nothing has been sent to <strong>enzo beau gosse</strong> yet. The MU or FRJ MU values used are those displayed on the website.</p>
				<div class="cart-help-options">
					<article><h3>Copy my list</h3><p>Copies the complete request to your clipboard so you can send it through in-game mail or a private Discord message.</p></article>
					<article><h3>Send to Enzo</h3><p>Sends the request to the server and notifies the enzoboys through Discord. Your full avatar name is required so that you can be contacted in game. You may also add an optional comment.</p></article>
				</div>
			</section>
			<section>
				<h2>3. Track your request</h2>
				<p>Once sent, a tracking link appears in the cart. Keep it so you can view the request even if you later remove it from the local list.</p>
				<ol class="cart-help-statuses">
					<li><strong>Submitted</strong><span>The request has been recorded and is waiting to be processed.</span></li>
					<li><strong>Viewed</strong><span>The request has been read and is being handled.</span></li>
					<li><strong>Approval required</strong><span>Enzo proposed a quantity or MU change. You must approve it before the request can continue.</span></li>
					<li><strong>Being prepared</strong><span>The items can now be gathered.</span></li>
					<li><strong>Ready</strong><span>Everything has been gathered and is ready for collection.</span></li>
					<li><strong>Completed</strong><span>The order has been collected and paid for.</span></li>
					<li><strong>Cancelled</strong><span>During the early stages, you can cancel the request from the cart or the tracking page.</span></li>
					<li><strong>Expired</strong><span>A proposal that is not approved within the allowed time becomes invalid.</span></li>
				</ol>
				<p>Whenever the status changes, the Discord message for the enzoboys is updated.</p>
			</section>
			<section>
				<h2>4. Local request list</h2>
				<p>Submitted requests are stored locally in the cart. For completed, cancelled or expired requests, the <strong>Hide from list</strong> button removes them from this device.</p>
				<p>The tracking link remains usable if you kept a copy of it.</p>
			</section>
		`,
			
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

		cartHelpPageTitle: "Aide du panier — FRJ For Sale",
		cartHelpContent: `
			<header class="cart-help-intro">
				<span class="cart-help-kicker">FRJ For Sale</span>
				<h1>Comment fonctionne le panier&nbsp;?</h1>
				<p>Le panier permet de mettre de côté et de rassembler des articles en vue d’une demande d’achat.</p>
			</header>
			<section>
				<h2>1. Ajouter un article</h2>
				<p>Chaque fiche d’article comportant un MU possède une calculatrice dans son coin inférieur droit. Elle permet de choisir la quantité désirée et d’en calculer le prix, MU compris.</p>
				<p>Dans la calculatrice, l’icône est remplacée par un chariot&nbsp;: cliquez dessus pour ajouter au panier la quantité indiquée.</p>
				<aside class="cart-help-note"><strong>À savoir</strong><span>L’icône du panier, en haut à droite de l’écran, indique la quantité totale et le montant estimé. Un panier peut contenir jusqu’à 10 lignes d’articles.</span></aside>
			</section>
			<section>
				<h2>2. Préparer la demande</h2>
				<p>À ce stade, le panier reste enregistré uniquement sur votre appareil&nbsp;: rien n’est encore envoyé à <strong>enzo beau gosse</strong>. Les MU ou MU FRJ utilisés sont ceux affichés sur le site.</p>
				<div class="cart-help-options">
					<article><h3>Copier ma liste</h3><p>Copie la demande complète dans le presse-papiers, afin de l’envoyer par message en jeu ou par message privé Discord.</p></article>
					<article><h3>Transmettre à Enzo</h3><p>Envoie la demande au serveur et avertit les enzoboys via Discord. Votre nom d’avatar complet est obligatoire pour pouvoir vous contacter en jeu. Un commentaire facultatif peut être ajouté.</p></article>
				</div>
			</section>
			<section>
				<h2>3. Suivre la demande</h2>
				<p>Après transmission, un lien de suivi apparaît dans le panier. Conservez-le pour consulter la demande, même si elle est ensuite retirée de la liste locale.</p>
				<ol class="cart-help-statuses">
					<li><strong>Transmise</strong><span>La demande est enregistrée et attend son traitement.</span></li>
					<li><strong>Vue</strong><span>La demande a été lue et prise en charge.</span></li>
					<li><strong>À valider</strong><span>Enzo a proposé une modification de quantité ou de MU. Vous devez l’approuver pour que la demande reprenne son parcours.</span></li>
					<li><strong>À préparer</strong><span>Les articles peuvent commencer à être rassemblés.</span></li>
					<li><strong>Prête</strong><span>Tout est rassemblé et prêt à être retiré.</span></li>
					<li><strong>Terminée</strong><span>La commande a été retirée et payée.</span></li>
					<li><strong>Annulée</strong><span>Pendant les premières phases, vous pouvez annuler la demande depuis le panier ou la page de suivi.</span></li>
					<li><strong>Expirée</strong><span>Une proposition non validée dans le délai prévu devient invalide.</span></li>
				</ol>
				<p>À chaque changement de statut, le message Discord destiné aux enzoboys est mis à jour.</p>
			</section>
			<section>
				<h2>4. Liste locale des demandes</h2>
				<p>Les demandes transmises sont mémorisées localement dans le panier. Pour les demandes terminées, annulées ou expirées, le bouton <strong>Masquer dans la liste</strong> permet de les retirer de cet appareil.</p>
				<p>Le lien de suivi reste utilisable si vous l’avez conservé.</p>
			</section>
		`,
			
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

