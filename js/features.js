(function defineFrjFeatures(global) {
  "use strict";

  // Retour arrière immédiat : passer cart à false retire entièrement le panier du front.
  global.FRJ_FEATURES = Object.freeze({
    cart: true
  });
})(window);
