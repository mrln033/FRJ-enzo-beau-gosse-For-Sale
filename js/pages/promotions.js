(function initDiscountsAdmin(global) {
  "use strict";
  if (!global.FRJ_ADMIN.require()) return;
  const $ = (selector) => document.querySelector(selector);
  const status = $("#discountStatus");
  let state = { campaigns: [], eligiblePairs: [], config: {} };

  $("#reloadDiscounts").addEventListener("click", load);
  $("#discountConfigForm").addEventListener("submit", saveConfig);
  $("#generateDiscountNow").addEventListener("click", generateNow);
  $("#dailyPromotionForm").addEventListener("submit", createDaily);
  $("#saleForm").addEventListener("submit", createSale);

  async function api(path, options = {}) {
    const response = await global.FRJ_API.fetchD1Admin(path, options);
    return response.json();
  }
  function body(value) { return { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(value) }; }
  function setStatus(message, error = false) { status.textContent = message; status.classList.toggle("error", error); }
  async function run(action, success) {
    try { setStatus("Traitement…"); await action(); setStatus(success); await load(false); }
    catch (error) { setStatus(error.message, true); }
  }
  async function load(show = true) {
    try {
      if (show) setStatus("Chargement…");
      state = await api("/admin/discounts", { cache:"no-store" });
      $("#automaticPromotionsEnabled").checked = state.config.automaticPromotionsEnabled;
      $("#defaultPromotionRate").value = state.config.defaultPromotionRate * 100;
      const select = $("#dailyPromotionForm select[name=pair]");
      select.replaceChildren(...state.eligiblePairs.map((pair, index) => {
        const option = document.createElement("option"); option.value = String(index);
        option.textContent = `${pair.storage} — ${pair.aisle} (${pair.promotableItems})`; return option;
      }));
      render(); if (show) setStatus("");
    } catch (error) { setStatus(error.message, true); }
  }
  async function saveConfig(event) { event.preventDefault(); await run(() => api("/admin/discounts/config", body({
    automaticPromotionsEnabled: $("#automaticPromotionsEnabled").checked,
    defaultPromotionRate: Number($("#defaultPromotionRate").value) / 100
  })), "Configuration enregistrée."); }
  async function generateNow() {
    const describe = (result, period) => ({
      GENERATED: `Promotion ${period} générée.`,
      ALREADY_GENERATED: `La promotion ${period} existe déjà.`,
      SALE_ACTIVE: `Aucune promotion ${period} : des soldes couvrent cette date.`,
      INSUFFICIENT_ELIGIBLE_PAIRS: `Aucune promotion ${period} : moins de 7 couples sont éligibles.`,
      NO_AVAILABLE_PAIR_AFTER_COOLDOWN: `Aucune promotion ${period} : tous les couples éligibles sont encore dans leur délai de 7 jours.`,
      AUTOMATION_DISABLED: "La génération automatique est désactivée."
    })[result?.reason] || `Génération ${period} contrôlée.`;
    let message = "Génération contrôlée.";
    await run(async () => {
      const result = await api("/admin/discounts/generate", body({}));
      message = result.reason === "AUTOMATION_DISABLED"
        ? "La génération automatique est désactivée."
        : (result.today && result.tomorrow
        ? `${describe(result.today, "du jour")} ${describe(result.tomorrow, "de demain")}`
        : describe(result, "du jour"));
    }, message);
    setStatus(message);
  }
  async function createDaily(event) {
    event.preventDefault(); const form = event.currentTarget; const pair = state.eligiblePairs[Number(form.pair.value)];
    await run(() => api("/admin/discounts/campaigns", body({ type:"daily_promo", date:form.date.value,
      storage:pair.storage, aisle:pair.aisle, discountRate:Number(form.rate.value)/100 })), "Promotion ajoutée.");
  }
  async function createSale(event) { event.preventDefault(); const form=event.currentTarget;
    await run(() => api("/admin/discounts/campaigns", body({ type:"sale", startsOn:form.startsOn.value,
      endsOn:form.endsOn.value, discountRate:Number(form.rate.value)/100 })), "Soldes ajoutés."); }
  function render() {
    const host = $("#discountCampaigns"); host.replaceChildren(...state.campaigns.map((campaign) => {
      const row=document.createElement("div"); row.className=`discount-row ${campaign.type}`;
      const editable=campaign.editable === true; row.classList.toggle("past", !editable);
      const type=document.createElement("strong"); type.textContent=campaign.type === "sale" ? "Soldes" : "Promotion";
      const first=document.createElement("input"); first.type="date"; first.value=campaign.startsOn;
      let second;
      if (campaign.type === "sale") { second=document.createElement("input"); second.type="date"; second.value=campaign.endsOn; }
      else {
        second=document.createElement("select");
        const selectablePairs=state.eligiblePairs.slice();
        if (!selectablePairs.some((pair) => pair.storage===campaign.storage&&pair.aisle===campaign.aisle)) {
          selectablePairs.unshift({ storage:campaign.storage, aisle:campaign.aisle, promotableItems:0 });
        }
        selectablePairs.forEach((pair,index) => { const option=document.createElement("option"); option.value=String(index);
          option.textContent=`${pair.storage} — ${pair.aisle}`; option.selected=pair.storage===campaign.storage&&pair.aisle===campaign.aisle; second.append(option); });
        second.frjPairs=selectablePairs;
      }
      const rate=document.createElement("input"); rate.type="number"; rate.step="0.01"; rate.min="0.01"; rate.max="100"; rate.value=campaign.discountRate*100;
      const enabled=document.createElement("input"); enabled.type="checkbox"; enabled.checked=campaign.enabled; enabled.title="Active";
      const save=document.createElement("button"); save.type="button"; save.textContent="Enregistrer";
      save.addEventListener("click", () => run(() => api(`/admin/discounts/campaigns/${campaign.id}`, body({
        startsOn:first.value, endsOn:campaign.type==="sale"?second.value:first.value, date:first.value,
        storage:campaign.type==="daily_promo"?second.frjPairs[Number(second.value)]?.storage:null,
        aisle:campaign.type==="daily_promo"?second.frjPairs[Number(second.value)]?.aisle:null,
        discountRate:Number(rate.value)/100, enabled:enabled.checked
      })), "Campagne modifiée."));
      const label=document.createElement("span"); label.append(type, document.createElement("br"));
      const meta=document.createElement("span"); meta.className="discount-origin";
      meta.textContent=(campaign.type==="daily_promo"?`${campaign.storage} — ${campaign.aisle} · ${campaign.origin}`:campaign.origin)
        + (editable ? "" : " · terminée — lecture seule"); label.append(meta);
      [first,second,rate,enabled,save].forEach((control) => { control.disabled=!editable; });
      if (!editable) { save.textContent="Lecture seule"; row.title="Cette campagne passée ne peut plus être modifiée"; }
      row.append(label,first,second,rate,enabled,save); return row;
    }));
  }
  load();
})(window);
