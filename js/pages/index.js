// Démarrage du catalogue : traductions, état du backend et catégories réellement disponibles.
document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("frj:backendchange", renderBackendStatusDot);
  document.getElementById("btnEN").addEventListener("click", () => setLanguage("EN"));
  document.getElementById("btnFR").addEventListener("click", () => setLanguage("FR"));
  document.getElementById("rayonFilter").addEventListener("change", applyFilter);
  updateLanguageButtons();
  applyTranslations();
  loadInventoryDate();
  updateFilterVisibility();

  const container = document.getElementById("rayonImages");
  container.innerHTML = "";

  // Le backend décide quelles catégories possèdent réellement du stock publiable.
  FRJ_API.fetch("?action=categories")
    .then(res => res.json())
    .then(categories => {

      Object.keys(CATEGORY_IMAGES).forEach(cat => {

        // Ignorer une catégorie vide évite de créer un onglet inutilisable.
        if (!categories.includes(cat)) return;

        const img = document.createElement("img");
        const config = CATEGORY_IMAGES[cat];

        img.src = IMG_URL + config.normal;
        img.className = "rayon-img";
        img.dataset.category = cat;
        img.title = cat;

        img.onmouseenter = () => {
          if (selectedCategory !== cat) {
            img.src = IMG_URL + config.hover;
          }
        };

        img.onmouseleave = () => {
          if (selectedCategory !== cat) {
            img.src = IMG_URL + config.normal;
          }
        };

		img.onclick = () => {

		  if (selectedCategory === cat) {
			selectedCategory = null;
			updateCategoryUrl("");
			resetCategories();
            resetRayonFilter();
            updateFilterVisibility();
            renderCards([]);
            return;
          }

		  selectCategory(cat);
		};

        container.appendChild(img);
      });

      isLoading = false;
	  document.getElementById("loadingState").style.display = "none";

	  renderCards([]);

	  const requestedCategory = getCategoryFromUrl();
	  if (requestedCategory && categories.includes(requestedCategory)) {
		selectCategory(requestedCategory, false);
	  }
    })
    .catch(err => {
      console.error("Erreur chargement catégories:", err);
    });
});


	// Ce chemin public est stable : les données du catalogue ne contiennent que le chemin relatif de l'image.
	const IMG_URL = "https://mrln033.github.io/FRJ-enzo-beau-gosse-For-Sale/img/";
		
	let data = [];
	let selectedCategory = null;
	let isLoading = true;
	let lastRenderedItems = [];
	let inventoryDate = "";
	const FRJ_MEMBER_SESSION_KEY = "FRJ";
	const PLAYER_NAME = "enzo beau gosse";
	
		
	const CATEGORY_IMAGES = {
		"MONEY AND DEEDS": {
			normal: "storage/01_Money-and-Deeds.png",
			hover: "storage/01_Money-and-Deeds_Hover.png",
			selected: "storage/01_Money-and-Deeds_Select.png"
		},
		"CLOTHES": {
			normal: "storage/02_Clothes.png",
			hover: "storage/02_Clothes_Hover.png",
			selected: "storage/02_Clothes_Select.png"
		},
		"ARMORS": {
			normal: "storage/03_Armors.png",
			hover: "storage/03_Armors_Hover.png",
			selected: "storage/03_Armors_Select.png"
		},
		"WEAPONS": {
			normal: "storage/04_Weapons.png",
			hover: "storage/04_Weapons_Hover.png",
			selected: "storage/04_Weapons_Select.png"
		},
		"TOOLS": {
			normal: "storage/05_Tools.png",
			hover: "storage/05_Tools_Hover.png",
			selected: "storage/05_Tools_Select.png"
		},
		"MINDFORCE": {
			normal: "storage/06_Mindforce.png",
			hover: "storage/06_Mindforce_Hover.png",
			selected: "storage/06_Mindforce_Select.png"
		},
		"MATERIALS": {
			normal: "storage/07_Materials.png",
			hover: "storage/07_Materials_Hover.png",
			selected: "storage/07_Materials_Select.png"
		},
		"RESOURCES": {
			normal: "storage/08_Resources.png",
			hover: "storage/08_Resources_Hover.png",
			selected: "storage/08_Resources_Select.png"
		},
		"BLUEPRINTS": {
			normal: "storage/09_Blueprints.png",
			hover: "storage/09_Blueprints_Hover.png",
			selected: "storage/09_Blueprints_Select.png"
		},
		"VEHICLES": {
			normal: "storage/10_Vehicles.png",
			hover: "storage/10_Vehicles_Hover.png",
			selected: "storage/10_Vehicles_Select.png"
		},
		"MISCELLANEOUS": {
			normal: "storage/11_Miscellaneous.png",
			hover: "storage/11_Miscellaneous_Hover.png",
			selected: "storage/11_Miscellaneous_Select.png"
		}
	};

	function getCategoryFromUrl() {
		const params = new URLSearchParams(window.location.search);
		const category = String(params.get("category") || "").trim().toUpperCase();
		return Object.prototype.hasOwnProperty.call(CATEGORY_IMAGES, category) ? category : "";
	}

	function updateCategoryUrl(category) {
		const url = new URL(window.location.href);
		if (category) {
			url.searchParams.set("category", category);
		} else {
			url.searchParams.delete("category");
		}
		window.history.replaceState(null, "", url);
	}

	function selectCategory(category, updateUrl = true) {
		selectedCategory = category;
		updateCategoryImages();
		updateFilterVisibility();
		if (updateUrl) updateCategoryUrl(category);
		loadCategoryData(category);
	}
	
	
	// En-tête et préférences visibles du catalogue.
	function renderSubtitle() {
		const subtitle = document.getElementById("subtitle");
		subtitle.innerHTML = "";

		const playerButton = document.createElement("button");
		playerButton.type = "button";
		playerButton.className = "copy-player-name";
		playerButton.innerHTML = `${PLAYER_NAME} <span class="copy-player-icon" aria-hidden="true">⧉</span>`;
		playerButton.title = t("copyPlayerTooltip");
		playerButton.setAttribute("aria-label", t("copyPlayerTooltip"));
		playerButton.addEventListener("click", () => copyWhisperCommand(playerButton));

		subtitle.append(
			document.createTextNode(t("subtitleStart")),
			playerButton,
			document.createTextNode(t("subtitleEnd") + (inventoryDate ? ` | ${inventoryDate}` : ""))
		);
	}

	function copyWhisperCommand(button) {
		const markCopied = () => {
			button.title = t("copyPlayerSuccess");
			button.setAttribute("aria-label", t("copyPlayerSuccess"));
			setTimeout(() => {
				button.title = t("copyPlayerTooltip");
				button.setAttribute("aria-label", t("copyPlayerTooltip"));
			}, 1500);
		};

		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(t("copyPlayerCommand")).then(markCopied).catch(() => {
				copyWhisperCommandFallback();
				markCopied();
			});
			return;
		}

		copyWhisperCommandFallback();
		markCopied();
	}

	function copyWhisperCommandFallback() {
		const input = document.createElement("textarea");
		input.value = t("copyPlayerCommand");
		input.setAttribute("readonly", "");
		input.style.position = "fixed";
		input.style.opacity = "0";
		document.body.appendChild(input);
		input.select();
		document.execCommand("copy");
		document.body.removeChild(input);
	}

	function loadInventoryDate() {
		FRJ_API.fetch("?action=inventoryDate")
			.then(res => res.json())
			.then(response => {
				inventoryDate = response.inventoryDate || "";
				renderSubtitle();
			})
			.catch(err => {
				console.error("Erreur chargement date inventaire:", err);
			});
	}

	function applyTranslations() {
		document.getElementById("title").innerText = t("title");
		renderSubtitle();
		document.getElementById("loadingState").innerText = t("loadingState");

		renderFilterLabel();
		renderBackendStatusDot();

		const select = document.getElementById("rayonFilter");

		if (!selectedCategory) {
			select.innerHTML = `<option value="">${t("selectCategory")}</option>`;
		}
		const headerImg = document.getElementById("storageHeader");
		if (headerImg && typeof IMG_URL !== "undefined") {
			headerImg.src = IMG_URL + t("img_storage");
		}
	}

	function renderFilterLabel() {
		document.getElementById("filterLabel").innerHTML =
			`<span class="label-italic">${t("filterLabel")}</span>:`;
	}

	function renderBackendStatusDot() {
		const dot = document.getElementById("backendStatusDot");
		if (!dot) return;
		const backend = FRJ_API.activeBackend === "d1" ? "d1" : "gas";
		dot.className = `backend-status-dot backend-${backend}`;
		dot.title = backend.toUpperCase();
		dot.setAttribute("aria-label", currentLang === "FR"
			? `Base interrogée : ${backend.toUpperCase()}`
			: `Active database: ${backend.toUpperCase()}`);
	}

	function isFRJMember() {
		return localStorage.getItem(FRJ_MEMBER_SESSION_KEY) === "TRUE";
	}

	function setFRJMember(value) {
		localStorage.setItem(FRJ_MEMBER_SESSION_KEY, value ? "TRUE" : "FALSE");
		window.dispatchEvent(new CustomEvent("frj:memberchange", { detail: { member: value } }));
	}

	function initFRJMemberCheckbox() {
		const checkbox = document.getElementById("frjMemberCheckbox");
		if (!checkbox) return;

		checkbox.checked = isFRJMember();
		checkbox.addEventListener("change", () => {
			setFRJMember(checkbox.checked);
			renderCards(lastRenderedItems);
		});
	}

	function formatRayon(rayon) {
		if (!rayon) return "";

		return rayon
			.toLowerCase()
			.split(" ")
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
		}

// Chargement et filtrage des articles de la catégorie sélectionnée.
function loadCategoryData(category) {
  isLoading = true;

  // Masquer les filtres pendant le chargement évite d'agir sur l'ancienne catégorie.
  document.querySelector(".filter").style.display = "none";

  document.getElementById("loadingState").style.display = "block";

  renderCards([]);

  FRJ_API.fetch("?category=" + encodeURIComponent(category))
    .then(res => res.json())
    .then(response => {
      data = response;

      isLoading = false;

      document.getElementById("loadingState").style.display = "none";

      updateFilterVisibility();

      updateRayonFilter();
      applyFilter();
    })
    .catch(err => {
      console.error("Erreur chargement data:", err);
      isLoading = false;
    });
}
	function updateCategoryImages() {
		document.querySelectorAll(".rayon-img").forEach(img => {
			const cat = img.dataset.category;
			const config = CATEGORY_IMAGES[cat];

			if (cat === selectedCategory) {
				img.src = IMG_URL + config.selected;
			} else {
				img.src = IMG_URL + config.normal;
			}
		});
	}

	function resetCategories() {
		document.querySelectorAll(".rayon-img").forEach(img => {
			const cat = img.dataset.category;
			img.src = IMG_URL + CATEGORY_IMAGES[cat].normal;
		});
	}

	function updateRayonFilter() {
		const select = document.getElementById('rayonFilter');

		// reset
		select.innerHTML = '';
		select.disabled = false;

		// option ALL
		const allOption = document.createElement('option');
		allOption.value = "";
		allOption.textContent = t("all");
		select.appendChild(allOption);

		// filtrer data par catégorie
		const filtered = data.filter(item => item.STORAGE === selectedCategory);

		const rayons = [...new Set(filtered.map(item => item.RAYON))].sort();

		rayons.forEach(rayon => {
			const option = document.createElement('option');
			option.value = rayon;
			option.textContent = formatRayon(rayon);
			select.appendChild(option);
		});

		// valeur par défaut = ALL
		select.value = "";
	}

	function resetRayonFilter() {
		const select = document.getElementById('rayonFilter');

		select.innerHTML = '<option value="">${t("selectCategory")}</option>';
		select.disabled = true;
	}

	// Filtre par rayon et quantité
	function applyFilter() {
		if (isLoading) return;
		updateFilterVisibility();
		
		const selectedRayon = document.getElementById('rayonFilter').value;

		let filtered = data;

		if (!selectedCategory) {
			renderCards([]);
			scrollToTop();
			return;
		}

		if (selectedCategory) {
			filtered = filtered.filter(item => item.STORAGE === selectedCategory);
		}

		if (selectedRayon) {
			filtered = filtered.filter(item => item.RAYON === selectedRayon);
		}

		filtered = filtered.filter(item => item.QUANTITE && item.QUANTITE > 0);

		renderCards(filtered);
		scrollToTop();
	}

	function selectRayon(rayon) {
        // Met à jour le select
        const select = document.getElementById('rayonFilter');
        select.value = rayon;

        // Applique le filtre
        applyFilter();
	}
	
// Normalisation et vieillissement visuel des MarkUps.
function parseMUDate(dateStr) {
  if (!dateStr) return null;

  const parts = dateStr.split(" ");
  if (parts.length < 2) return null;

  const d = parts[0].split("/");
  const t = parts[1].split(":");

  // Les dates GAS historiques sont toujours reçues au format français dd/MM/yyyy.
  return new Date(
    parseInt(d[2]),      // year
    parseInt(d[1]) - 1,  // month
    parseInt(d[0]),      // day
    parseInt(t[0]),
    parseInt(t[1] || 0),
    parseInt(t[2] || 0)
  );
}
	  
	function formatDateMU(dateStr) {
		if (!dateStr) return { display: "", full: "" };

		const d = parseMUDate(dateStr);
		if (!d || isNaN(d.getTime())) return { display: "", full: "" };
		const now = new Date();

		const diffMs = now - d;
		const diffHours = diffMs / (1000 * 60 * 60);
		const diffMinutes = diffMs / (1000 * 60);

		// Tooltip complet
		const full = d.toLocaleString("fr-FR", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		});

		let display = "";

		if (diffHours < 24) {
			if (diffHours >= 1) {
				display = `il y a ${Math.floor(diffHours)}h`;
			} else {
				const mins = Math.max(1, Math.floor(diffMinutes));
			display = `il y a ${mins} min`;
			}
		} else {
			display = d.toLocaleString("fr-FR", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit"
			});
		}

		return { display };
	}
	
function getMUColor(dateStr) {
  if (!dateStr) return "#000";

  const d = parseMUDate(dateStr);
  if (!d || isNaN(d.getTime())) return "#000";

  const now = new Date();

  const diffMs = now - d;
  const days = diffMs / (1000 * 60 * 60 * 24);

  // Une horloge source légèrement en avance ne doit pas masquer un MU récent.
  const safeDays = Math.max(0, days);

  // Les MU âgés de plus de sept jours ne sont plus considérés comme fiables.
  if (safeDays > 7) return null;

  // Un MU de moins d'un jour conserve la couleur la plus lisible.
  if (safeDays <= 1) return "#000000";

  // Le dégradé signale progressivement l'ancienneté jusqu'à expiration.
  const ratio = (safeDays - 1) / 7;
  const gray = Math.round(ratio * 200);

  return `rgb(${gray}, ${gray}, ${gray})`;
}

function formatMUValue(value) {
  return value.toFixed(2).replace(".", ",");
}

function getEffectiveMU(muStr) {
  const mu = parseMU(muStr);

  if (currentLang !== "FR" || !isFRJMember()) {
    return muStr;
  }

  if (mu.type === "ped") {
    return `${formatMUValue(mu.value / 2)} PED`;
  }

  if (mu.type === "percent") {
    const adjustedPercent = (1 + ((mu.value - 1) / 2)) * 100;
    return `${formatMUValue(adjustedPercent)} %`;
  }

  return muStr;
}

	// Génère les cartes et branche leurs interactions après création du HTML.
	function renderCards(items) {
        const container = document.getElementById('cardContainer');
		const emptyState = document.getElementById('emptyState');
		const loadingState = document.getElementById('loadingState');

		lastRenderedItems = items;
		container.innerHTML = '';
		
		// Pendant le chargement, aucun état vide intermédiaire ne doit apparaître.
		if (isLoading) {
			loadingState.style.display = "block";

			emptyState.style.display = "none";

			return;
		}
		
		// L'état initial explique explicitement qu'une catégorie doit être choisie.
		if (!selectedCategory || items.length === 0) {

			document.getElementById("emptyText").innerHTML = t("empty");
			initFRJMemberCheckbox();
	
			emptyState.style.display = "block";
			return;

		} else {
			emptyState.style.display = "none";
		}

        // Tri alphabétique par ITEM
        items.sort((a,b) => a.ITEM.localeCompare(b.ITEM));

        items.forEach(item => {
			const card = document.createElement('div');
			card.className = 'card';

			// Image ou placeholder
			let imageSrc = "";

			// Vérifie si IMAGE est valide
			if (item.IMAGE && item.IMAGE !== '--') {

				// Si ce n'est PAS une URL complète → on préfixe avec IMG_URL
				if (!item.IMAGE.startsWith("http")) {
					imageSrc = IMG_URL + item.IMAGE;
				} else {
					imageSrc = item.IMAGE;
				}
			}

			const imgHTML = imageSrc
				? `<div class="image-container">
					<img src="${imageSrc}" alt="${item.ITEM}">
				</div>`
				: `<div class="image-container" style="background:#eee;">No image</div>`;

			// Affichage prix et total avec 2 décimales + monnaie "peds"
			let prixUnitaire = "--";
			let total = "--";

			if (item.PRIX_UNITAIRE !== "" && item.PRIX_UNITAIRE != null) {
				prixUnitaire = formatNumber(item.PRIX_UNITAIRE);          // dynamique
				total = (parseFloat(item.TOTAL) || 0).toFixed(2);         // toujours 2 décimales
			}

			// Génération du titre ITEM
			let itemTitle = "";
			if (item.LIEN_WIKI && item.LIEN_WIKI.trim() !== "") {
				itemTitle = `<a href="${item.LIEN_WIKI}" target="_blank">${item.ITEM}</a>`;
			} else {
				itemTitle = `${item.ITEM}`;
			}

			let rayonHTML = "";
			const selectedRayon = document.getElementById('rayonFilter').value;
			if (!selectedRayon) { 
				// Affiche Rayon avec lien cliquable
				rayonHTML = `<p><span class="label-italic">Rayon</span>: 
					<a href="#" class="rayon-link">
                          ${item.RAYON}
                    </a>
                    </p>`;
			}

			let muHTML = "";
			let calculatorHTML = "";

			// Afficher uniquement si MU existe et n'est pas vide
			

			if (item.MU != null && item.MU !== "") {

				const color = getMUColor(item.DATE_MU);

				const dateFormatted = formatDateMU(item.DATE_MU);
				const effectiveMU = getEffectiveMU(item.MU);
				const muLabel = currentLang === "FR" && isFRJMember() ? "MU FRJ" : "MU";

				muHTML = `
					<p title="${dateFormatted?.display || ""}">
					<span class="MU-style" style="color:${color}">
						${muLabel}: ${effectiveMU}
					</span>
					</p>
				`;
			}
				
			// Le calculateur n'est pertinent qu'avec un prix et un MU exploitable.
			const hasPrice = item.PRIX_UNITAIRE !== "" && item.PRIX_UNITAIRE != null && !isNaN(item.PRIX_UNITAIRE);
			const hasMU = item.MU !== "" && item.MU != null;
			const isPercentMU = typeof item.MU === "string" && item.MU.includes("%");
			const isPedMU = typeof item.MU === "string" && item.MU.trim().endsWith(" PED");

			if (hasPrice && hasMU && (isPercentMU || isPedMU)) {
				calculatorHTML = `
					<div class="calc-icon" role="button" tabindex="0">
    
						<svg viewBox="0 0 24 24" width="20" height="20"
							fill="none" stroke="currentColor" stroke-width="2"
							style="pointer-events: none;">
         
							<rect x="4" y="2" width="16" height="20" rx="3"/>
							<rect x="7" y="6" width="10" height="3"/>
      
							<circle cx="8" cy="12" r="1"/>
							<circle cx="12" cy="12" r="1"/>
							<circle cx="16" cy="12" r="1"/>
      
							<circle cx="8" cy="16" r="1"/>
							<circle cx="12" cy="16" r="1"/>
							<circle cx="16" cy="16" r="1"/>
						</svg>
					</div>
				`;
			}
			
			card.innerHTML = `
				<div class="card-front">
					${imgHTML}
					<h3>${itemTitle}</h3>
					${rayonHTML}
					<p><span class="label-italic">${t("quantity")}</span>: ${item.QUANTITE}</p>
					<p><span class="label-italic">${t("unitPrice")}</span>: ${prixUnitaire} peds</p>
					<p><span class="label-italic">${t("total")}</span>: ${total} peds</p>
					${muHTML}

					${calculatorHTML}
				</div>

				<div class="card-back"></div>
			`;
			const rayonLink = card.querySelector(".rayon-link");
			if (rayonLink) {
				rayonLink.addEventListener("click", (event) => {
					event.preventDefault();
					selectRayon(item.RAYON);
				});
			}
			const calculator = card.querySelector(".calc-icon");
			if (calculator) {
				const open = (event) => openCalculator(event, calculator, item);
				calculator.addEventListener("click", open);
				calculator.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open(event);
					}
				});
			}
			container.appendChild(card);
		});
	}
	
	function formatNumber(value) {
        if (value === "" || value == null) return "";
        const str = value.toString();
        if (!str.includes(".")) return str + ".00";
        const decimals = str.split(".")[1].length;
        if (decimals === 1) return str + "0";
        return str; // 2 décimales ou + → on garde tel quel
	}
	  
	function scrollToTop() {
		const topAnchor = document.querySelector('a[name="top"]');
		if (topAnchor) {
			topAnchor.scrollIntoView({ behavior: "smooth" });
		}
	}
	  
	function updateFilterVisibility() {
		const filter = document.querySelector(".filter");

		if (selectedCategory) {
			filter.style.display = "flex";
		} else {
			filter.style.display = "none";
		}
	}

// Calculateur au dos d'une carte, partagé avec l'ajout au panier lorsqu'il est activé.
function openCalculator(event, iconEl, item) {
  const card = iconEl.closest(".card");
  const back = card.querySelector(".card-back");

  // Empêcher le gestionnaire global de refermer immédiatement la carte.
  event.stopPropagation();

  // Une seule carte peut présenter son calculateur à la fois.
  if (openCard && openCard !== card) {
    openCard.classList.remove("open");
  }

  if (card === openCard) {
    card.classList.remove("open");
    openCard = null;
    return;
  }

  openCard = card;

  const prix = parseFloat(item.PRIX_UNITAIRE) || 0;
  const mu = getEffectiveMU(item.MU || "");
  const muParsed = parseMU(mu);
  const muLabel = currentLang === "FR" && isFRJMember() ? "MU FRJ" : "MU";
  const availableQuantity = Math.max(0, Math.floor(Number(item.QUANTITE) || 0));
  const defaultQty = (muParsed.type === "ped") ? Math.min(1, availableQuantity) : availableQuantity;

  back.innerHTML = `
    <div class="back-header">
      <h3>${item.ITEM}</h3>
    </div>

    <div class="back-content">
      <div class="qty-row">
        <span>${t("quantity")}</span>
        <input type="number" id="calcQty" value="${defaultQty}" min="1" max="${availableQuantity}" step="1">
      </div>

      <p>${t("unitPrice")}: ${prix.toFixed(2)} peds</p>
      <p>${t("total")}: <span id="calcTT"></span> peds</p>
      <p id="muLine"></p>
      <p><strong>${t("calcSell")}: <span id="calcSell"></span> peds</strong></p>
    </div>

    <button class="back-btn" type="button">←</button>
  `;

  back.querySelector(".back-btn").addEventListener("click", (closeEvent) => {
    closeEvent.stopPropagation();
    closeCalculator(closeEvent.currentTarget);
  });

  if (window.FRJ_CART?.enabled) {
    const cartButton = document.createElement("button");
    cartButton.type = "button";
    cartButton.className = "cart-back-icon";
    cartButton.title = currentLang === "FR" ? "Ajouter cette quantité au panier" : "Add this quantity to cart";
    cartButton.setAttribute("aria-label", cartButton.title);
    cartButton.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true">
        <circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/>
        <path d="M3 4h2l2.4 10.4a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6"/>
        <path d="M12 8V3m-2 2 2-2 2 2"/>
      </svg>`;
    cartButton.addEventListener("click", () => {
      const quantity = Math.floor(Number(back.querySelector("#calcQty")?.value) || 0);
      window.FRJ_CART.addItem(item, { quantity });
    });
    back.appendChild(cartButton);
  }

  card.classList.add("open");

  setTimeout(() => {
    const qtyInput = back.querySelector("#calcQty");
    qtyInput.addEventListener("input", () => {
      updateCalc(card, prix, mu, muLabel);
    });

    updateCalc(card, prix, mu, muLabel);
  }, 0);
}
function updateCalc(card, prix, muStr, muLabel = "MU") {
  const qty = Math.max(0, Math.floor(Number(card.querySelector("#calcQty").value) || 0));

  const tt = qty * prix;
  card.querySelector("#calcTT").innerText = tt.toFixed(2);

  const mu = parseMU(muStr);

  let sell = tt;
  let muDisplay = "";

  // Un MU en pourcentage s'applique à la valeur TT totale.
  if (mu.type === "percent") {
    sell = tt * mu.value;
    muDisplay = `${muLabel}: ${muStr}`;
  }

  // Un MU en PED s'applique par unité avant multiplication par la quantité.
  else if (mu.type === "ped") {
    const muTotal = qty * mu.value;
    sell = tt + muTotal;

    muDisplay = `Total ${muLabel}: ${formatMUValue(muTotal)} peds`;
  }

  // Sans MU exploitable, le prix de vente reste égal au TT.
  else {
    muDisplay = "";
  }

  card.querySelector("#calcSell").innerText = sell.toFixed(2);

  const muLineEl = card.querySelector("#muLine");
  if (muLineEl) {
    muLineEl.innerText = muDisplay;
  }
}

function parseMU(muStr) {
  if (!muStr) return { type: "none", value: 0 };

  // cas PED
  if (typeof muStr === "string" && muStr.trim().endsWith(" PED")) {
    const val = parseFloat(muStr.replace(" PED", "").replace(",", "."));
    return {
      type: "ped",
      value: isNaN(val) ? 0 : val
    };
  }

  // cas %
  if (typeof muStr === "string" && muStr.includes("%")) {
    const val = parseFloat(muStr.replace("%", "").replace(",", "."));
    return {
      type: "percent",
      value: isNaN(val) ? 0 : val / 100
    };
  }

  return { type: "none", value: 0 };
}

function closeCalculator(btn) {
  const card = btn.closest(".card");
  card.classList.remove("open");
  openCard = null;
}
	
	// Dans une iframe, la page parente fournit déjà sa propre navigation.
	if (window.self !== window.top) {
		const logo = document.getElementById("logoLink");
		if (logo) {
			logo.style.display = "none";
		}
	}

let openCard = null;

document.addEventListener("click", (e) => {
  if (!openCard) return;

  // si clic dans la card ouverte → on ne fait rien
  if (e.target.closest(".card") === openCard) return;

  // sinon → clic ailleurs → on ferme
  openCard.classList.remove("open");
  openCard = null;
});
