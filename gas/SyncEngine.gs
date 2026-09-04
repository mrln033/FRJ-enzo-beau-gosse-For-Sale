function frjRunIntegrityAudit_(reason) {
  try {
    var summary = frjRunSync_(true);
    frjAcknowledgeGasOutbox_(summary);
    var changed = summary.some(function(item) { return item.action !== "identique"; });
    if (changed) {
      var completedAt = Date.now();
      PropertiesService.getScriptProperties().setProperty("FRJ_SYNC_LAST_RUN_AT", String(completedAt));
      // L'audit vient d'effectuer une correction : cette correction est une synchronisation,
      // donc elle doit obligatoirement être vérifiée par un nouvel audit à +30 minutes.
      frjScheduleIntegrityAudit_(completedAt);
    }
    frjReportAudit_("_system", "integrity-audit-completed", "", "", { reason: reason, changed: changed });
    return summary;
  } catch (error) {
    // Une erreur technique ne doit jamais casser définitivement la chaîne de vérification.
    frjScheduleOneShot_("frjDeferredAuditTrigger", Date.now() + FRJ_SYNC_CONFIG.auditDelayMs, "FRJ_AUDIT_TRIGGER_AT");
    throw error;
  }
}

function frjRequestSynchronization_(reason, dataset, changedAt, skipRemoteEvent) {
  var properties = PropertiesService.getScriptProperties();
  var now = Date.now();
  properties.setProperties({
    FRJ_SYNC_DIRTY_AT: String(now),
    FRJ_SYNC_DIRTY_REASON: JSON.stringify({ reason: String(reason || "modification"), dataset: String(dataset || ""), at: new Date(now).toISOString() })
  });
  var parsedChangedAt = Date.parse(String(changedAt || ""));
  var sourceChangedAt = isFinite(parsedChangedAt) ? parsedChangedAt : now;
  var runAt = frjComputeSyncRunAt_(sourceChangedAt, now);
  frjScheduleOneShot_("frjDeferredSyncTrigger", runAt, "FRJ_SYNC_TRIGGER_AT", true);
  if (!skipRemoteEvent) {
    frjReportAudit_("_system", "sync-requested", "", "", { reason: reason, dataset: dataset, scheduledAt: new Date(runAt).toISOString() });
  }
  return { ok: true, scheduledAt: new Date(runAt).toISOString() };
}

function frjDatasetKeys_() {
  return Object.keys(FRJ_SYNC_CONFIG.inventorySheets).map(function(avatar) {
    return "inventory:" + avatar;
  }).concat(["mu", "catalog", "containers", "discounts", "discount-config"]);
}

function frjReadGasOutbox_() {
  var raw = PropertiesService.getScriptProperties().getProperty(FRJ_SYNC_CONFIG.outboxProperty) || "[]";
  try {
    var entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    console.error(JSON.stringify({ message: "Outbox GAS illisible, réinitialisation", error: error.message }));
    return [];
  }
}

function frjWriteGasOutbox_(entries) {
  var properties = PropertiesService.getScriptProperties();
  if (!entries.length) {
    properties.deleteProperty(FRJ_SYNC_CONFIG.outboxProperty);
    return;
  }
  properties.setProperty(FRJ_SYNC_CONFIG.outboxProperty, JSON.stringify(entries));
}

function frjCaptureGasOutbox_() {
  var existing = frjReadGasOutbox_();
  var byDataset = {};
  existing.forEach(function(entry) { byDataset[entry.dataset] = entry; });
  var now = new Date().toISOString();

  frjDatasetKeys_().forEach(function(dataset) {
    var local = frjReadLocalDataset_(dataset);
    var baseHash = frjGetBaseHash_(dataset);
    if (baseHash && local.hash === baseHash) {
      delete byDataset[dataset];
      return;
    }
    var previous = byDataset[dataset];
    if (!previous || previous.hash !== local.hash) {
      byDataset[dataset] = {
        id: Utilities.getUuid(),
        dataset: dataset,
        hash: local.hash,
        rowCount: local.rows.length,
        updatedAt: local.updatedAt,
        detectedAt: now
      };
    }
  });

  var entries = frjDatasetKeys_().filter(function(dataset) {
    return Boolean(byDataset[dataset]);
  }).map(function(dataset) {
    return byDataset[dataset];
  });
  frjWriteGasOutbox_(entries);
  return entries;
}

function frjAcknowledgeGasOutbox_(summary) {
  var completed = {};
  (summary || []).forEach(function(item) { completed[item.dataset] = true; });
  var remaining = frjReadGasOutbox_().filter(function(entry) {
    return !completed[entry.dataset];
  });
  frjWriteGasOutbox_(remaining);
  return remaining;
}

function frjPublishGasObservations_(entries) {
  if (!entries || !entries.length) return true;
  try {
    frjD1Request_("/sync/observations", {
      method: "post",
      payload: JSON.stringify({
        observations: entries.map(function(entry) {
          return {
            dataset: entry.dataset,
            hash: entry.hash,
            rowCount: entry.rowCount,
            updatedAt: entry.updatedAt,
            observedAt: entry.detectedAt || new Date().toISOString(),
            eventId: entry.id,
            provisional: false
          };
        })
      })
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ message: "Observations GAS conservées dans l'outbox", error: error.message }));
    return false;
  }
}

function frjPublishSyncSummary_(summary, observedAt) {
  var entries = (summary || []).map(function(item) {
    return {
      id: Utilities.getUuid(),
      dataset: item.dataset,
      hash: item.hash,
      rowCount: item.rows,
      updatedAt: item.updatedAt || observedAt,
      detectedAt: observedAt
    };
  });
  return frjPublishGasObservations_(entries);
}

function frjScheduleIntegrityAudit_(lastRunAt) {
  frjScheduleOneShot_("frjDeferredAuditTrigger", lastRunAt + FRJ_SYNC_CONFIG.auditDelayMs, "FRJ_AUDIT_TRIGGER_AT");
}

function frjComputeSyncRunAt_(changedAt, now) {
  return Math.max(now + 1000, changedAt + FRJ_SYNC_CONFIG.syncDelayMs);
}

function frjEnsureSchedulerVersion_() {
  var installedVersion = PropertiesService.getScriptProperties().getProperty("FRJ_SYNC_SCHEDULER_VERSION") || "";
  if (installedVersion === FRJ_SYNC_CONFIG.schedulerVersion) return false;
  installFrjBidirectionalSync();
  return true;
}

function frjScheduleOneShot_(handler, runAt, propertyName, keepEarlier) {
  var properties = PropertiesService.getScriptProperties();
  var existingAt = Number(properties.getProperty(propertyName) || 0);
  if (keepEarlier && existingAt && existingAt <= runAt + 30000) return;
  if (existingAt && Math.abs(existingAt - runAt) < 30000) return;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handler).timeBased().after(Math.max(1000, runAt - Date.now())).create();
  properties.setProperty(propertyName, String(runAt));
}

function runFrjSyncNow() {
  var summary = frjRunSync_(false);
  frjAcknowledgeGasOutbox_(summary);
  var completedAt = Date.now();
  PropertiesService.getScriptProperties().setProperty("FRJ_SYNC_LAST_RUN_AT", String(completedAt));
  frjScheduleIntegrityAudit_(completedAt);
  return summary;
}

function runFrjSyncAuditNow() {
  return frjRunIntegrityAudit_("audit-manuel");
}

/**
 * Point d'entrée privé utilisé par le Worker pour lancer un audit sans attendre
 * le poll D1 ni les contraintes temporelles des triggers ordinaires.
 */
function frjHandleImmediateAuditPost_(e) {
  try {
    var payload = JSON.parse(String(e && e.postData ? e.postData.contents : "{}"));
    var suppliedToken = String(payload.token || "");
    if (!frjTimingSafeEqual_(suppliedToken, frjRequireSyncToken_())) {
      throw new Error("Accès refusé");
    }

    var reason = String(payload.reason || "audit-force-rapport").trim() || "audit-force-rapport";
    var summary = frjRunIntegrityAudit_(reason);
    return frjJsonOutput_({ ok: true, reason: reason, summary: summary });
  } catch (error) {
    console.error(JSON.stringify({ message: "Audit forcé refusé ou échoué", error: error.message }));
    return frjJsonOutput_({ ok: false, error: error.message });
  }
}

function frjTimingSafeEqual_(left, right) {
  var leftHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(left), Utilities.Charset.UTF_8);
  var rightHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(right), Utilities.Charset.UTF_8);
  var different = 0;
  for (var i = 0; i < leftHash.length; i++) different |= leftHash[i] ^ rightHash[i];
  return different === 0;
}

function frjJsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getFrjSyncStatus() {
  var properties = PropertiesService.getScriptProperties();
  var triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return frjOwnedTriggerHandlers_().indexOf(trigger.getHandlerFunction()) !== -1;
  }).map(function(trigger) {
    return { handler: trigger.getHandlerFunction(), id: trigger.getUniqueId() };
  });

  return {
    configured: Boolean(properties.getProperty(FRJ_SYNC_CONFIG.tokenProperty)),
    installedAt: properties.getProperty("FRJ_SYNC_INSTALLED_AT") || "",
    lastSuccess: properties.getProperty("FRJ_SYNC_LAST_SUCCESS") || "",
    lastError: properties.getProperty("FRJ_SYNC_LAST_ERROR") || "",
    lastSummary: properties.getProperty("FRJ_SYNC_LAST_SUMMARY") || "",
    dirtyAt: properties.getProperty("FRJ_SYNC_DIRTY_AT") || "",
    dirtyReason: properties.getProperty("FRJ_SYNC_DIRTY_REASON") || "",
    lastRunAt: properties.getProperty("FRJ_SYNC_LAST_RUN_AT") || "",
    schedulerVersion: properties.getProperty("FRJ_SYNC_SCHEDULER_VERSION") || "",
    gasOutbox: frjReadGasOutbox_(),
    d1PollLastError: properties.getProperty("FRJ_D1_POLL_LAST_ERROR") || "",
    triggers: triggers
  };
}

function withFrjDataLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Une autre importation ou synchronisation est déjà en cours");
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function frjRunSync_(forceAudit) {
  return withFrjDataLock_(function() {
    var properties = PropertiesService.getScriptProperties();
    var summary = [];
    try {
      // Déploiement sûr : la première synchronisation d'une nouvelle version
      // prépare CONFIG_CONTAINER et les formules, puis mémorise cette étape.
      frjEnsureContainerConfigurationReady_();
      var remoteStates = frjD1Request_("/sync/state").datasets || {};
      Object.keys(FRJ_SYNC_CONFIG.inventorySheets).forEach(function(avatar) {
        var dataset = "inventory:" + avatar;
        summary.push(frjSynchronizeDataset_(dataset, remoteStates[dataset], forceAudit, 0));
      });
      summary.push(frjSynchronizeDataset_("mu", remoteStates.mu, forceAudit, 0));
      summary.push(frjSynchronizeDataset_("catalog", remoteStates.catalog, forceAudit, 0));
      summary.push(frjSynchronizeDataset_("containers", remoteStates.containers, forceAudit, 0));
      summary.push(frjSynchronizeDataset_("discounts", remoteStates.discounts, forceAudit, 0));
      summary.push(frjSynchronizeDataset_("discount-config", remoteStates["discount-config"], forceAudit, 0));

      var completedAt = new Date().toISOString();
      frjPublishSyncSummary_(summary, completedAt);
      properties.setProperties({
        FRJ_SYNC_LAST_SUCCESS: completedAt,
        FRJ_SYNC_LAST_ERROR: "",
        FRJ_SYNC_LAST_SUMMARY: JSON.stringify(summary)
      });
      frjReportAudit_("_system", "sync-run-completed", "", "", {
        audit: Boolean(forceAudit),
        completedAt: completedAt,
        datasets: summary
      });
      console.log(JSON.stringify({ message: "Synchronisation FRJ terminée", audit: forceAudit, summary: summary }));
      return summary;
    } catch (error) {
      properties.setProperty("FRJ_SYNC_LAST_ERROR", new Date().toISOString() + " — " + error.message);
      frjReportAudit_("_system", "sync-run-failed", "", "", {
        audit: Boolean(forceAudit),
        error: error.message
      });
      console.error(JSON.stringify({ message: "Synchronisation FRJ échouée", error: error.message }));
      throw error;
    }
  });
}

function frjSynchronizeDataset_(dataset, remoteState, forceAudit, retryCount) {
  if (!remoteState) throw new Error("État D1 absent pour " + dataset);

  var local = frjReadLocalDataset_(dataset);
  var remoteSnapshot = forceAudit ? frjReadRemoteDataset_(dataset) : null;
  if (remoteSnapshot) {
    var verifiedRemoteHash = frjHashDataset_(dataset, remoteSnapshot.rows);
    if (verifiedRemoteHash !== remoteState.hash) {
      throw new Error("Empreinte D1 incohérente pour " + dataset);
    }
  }

  var inventoryMetadataUpgrade = dataset.indexOf("inventory:") === 0
    && !frjInventoryMetadataSchemaIsCurrent_(dataset);
  if (local.hash === remoteState.hash) {
    frjSetBaseHash_(dataset, local.hash);
    if (inventoryMetadataUpgrade) frjMarkInventoryMetadataSchemaCurrent_(dataset);
    if (forceAudit) frjReportAudit_(dataset, "verified", local.hash, remoteState.hash, { rows: local.rows.length });
    return {
      dataset: dataset,
      action: "identique",
      rows: local.rows.length,
      hash: local.hash,
      updatedAt: local.updatedAt
    };
  }

  var baseHash = frjGetBaseHash_(dataset);
  var localChanged = !baseHash || local.hash !== baseHash;
  var remoteChanged = !baseHash || remoteState.hash !== baseHash;
  var direction;
  var mergeCandidate = null;

  if (dataset === "catalog") {
    // BDD_APP reste pour l'instant le référentiel maître : ses colonnes E:G sont des formules IMPORTRANGE.
    direction = "gas-to-d1";
  } else if (inventoryMetadataUpgrade) {
    // L'ancienne empreinte supprimait Id, Value(PED) et ContainerRefId.
    // D1 ayant conservé l'import brut, il répare une seule fois la feuille GAS,
    // puis les synchronisations suivantes redeviennent strictement bidirectionnelles.
    direction = "d1-to-gas";
  } else if (dataset === "containers" && !baseHash) {
    // Premier raccordement : la feuille CONFIG_CONTAINER contient les choix
    // historiques explicites (18 activés) et initialise la base commune.
    direction = "gas-to-d1";
  } else if (localChanged && !remoteChanged) {
    direction = "gas-to-d1";
  } else if (remoteChanged && !localChanged) {
    direction = "d1-to-gas";
  } else if (baseHash) {
    remoteSnapshot = remoteSnapshot || frjReadRemoteDataset_(dataset);
    try {
      var baseSnapshot = frjReadRemoteDatasetByHash_(dataset, baseHash);
      var mergedRows = frjThreeWayMerge_(
        dataset,
        baseSnapshot.rows,
        local.rows,
        remoteSnapshot.rows,
        frjCompareDates_(local.updatedAt, remoteState.updatedAt) >= 0 ? "local" : "remote"
      );
      mergeCandidate = {
        rows: mergedRows,
        hash: frjHashDataset_(dataset, mergedRows),
        updatedAt: frjCompareDates_(local.updatedAt, remoteState.updatedAt) >= 0
          ? local.updatedAt
          : remoteState.updatedAt
      };
      direction = "fusion-gas-d1";
    } catch (error) {
      if (error.frjStatus !== 404) throw error;
      direction = frjCompareDates_(local.updatedAt, remoteState.updatedAt) > 0 ? "gas-to-d1" : "d1-to-gas";
    }
  } else {
    direction = frjCompareDates_(local.updatedAt, remoteState.updatedAt) > 0 ? "gas-to-d1" : "d1-to-gas";
  }

  try {
    if (direction === "fusion-gas-d1") {
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      var mergedResult = frjPushDataset_(dataset, mergeCandidate, remoteState.hash);
      frjWriteLocalDataset_(dataset, { state: mergedResult.state, rows: mergeCandidate.rows });
      frjSetBaseHash_(dataset, mergedResult.state.hash);
    } else if (direction === "gas-to-d1") {
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      var pushed = frjPushDataset_(dataset, local, remoteState.hash);
      if (dataset === "containers" && pushed.state.hash !== local.hash) {
        // D1 conserve lui aussi les anciennes lignes : récupérer l'éventuelle
        // union retournée avant d'enregistrer la nouvelle base commune.
        remoteSnapshot = frjReadRemoteDataset_(dataset);
        frjWriteLocalDataset_(dataset, remoteSnapshot);
        var unitedLocal = frjReadLocalDataset_(dataset);
        frjSetBaseHash_(dataset, unitedLocal.hash);
      } else {
        frjSetBaseHash_(dataset, pushed.state.hash);
      }
    } else {
      remoteSnapshot = remoteSnapshot || frjReadRemoteDataset_(dataset);
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      frjWriteLocalDataset_(dataset, remoteSnapshot);
      var reloaded = frjReadLocalDataset_(dataset);
      if (reloaded.hash !== remoteSnapshot.state.hash) {
        throw new Error("Échec de vérification après écriture GAS pour " + dataset);
      }
      frjSetBaseHash_(dataset, reloaded.hash);
    }
  } catch (error) {
    if (error.frjStatus === 409 && retryCount < 1) {
      var refreshedStates = frjD1Request_("/sync/state").datasets || {};
      return frjSynchronizeDataset_(dataset, refreshedStates[dataset], forceAudit, retryCount + 1);
    }
    throw error;
  }

  var finalLocal = frjReadLocalDataset_(dataset);
  var finalRemote = frjReadRemoteDataset_(dataset);
  var finalRemoteHash = frjHashDataset_(dataset, finalRemote.rows);
  if (finalLocal.hash !== finalRemote.state.hash || finalRemoteHash !== finalRemote.state.hash) {
    throw new Error("Réconciliation incomplète pour " + dataset);
  }
  if (inventoryMetadataUpgrade) frjMarkInventoryMetadataSchemaCurrent_(dataset);

  frjReportAudit_(dataset, "reconciled", finalLocal.hash, finalRemote.state.hash, {
    direction: direction,
    rows: finalLocal.rows.length,
    conflict: localChanged && remoteChanged
  });
  frjClearCatalogCache_();
  return {
    dataset: dataset,
    action: direction,
    conflict: localChanged && remoteChanged,
    rows: finalLocal.rows.length,
    hash: finalLocal.hash,
    updatedAt: finalLocal.updatedAt
  };
}

function frjInventoryMetadataSchemaProperty_(dataset) {
  return "FRJ_INVENTORY_METADATA_SCHEMA_" + dataset.slice("inventory:".length).toUpperCase();
}

function frjInventoryMetadataSchemaIsCurrent_(dataset) {
  return PropertiesService.getScriptProperties().getProperty(frjInventoryMetadataSchemaProperty_(dataset)) === "3";
}

function frjMarkInventoryMetadataSchemaCurrent_(dataset) {
  PropertiesService.getScriptProperties().setProperty(frjInventoryMetadataSchemaProperty_(dataset), "3");
}

function frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount) {
  if (retryCount >= 1) {
    throw new Error("Le dataset GAS a changé pendant la synchronisation : " + dataset);
  }
  var refreshedStates = frjD1Request_("/sync/state").datasets || {};
  return frjSynchronizeDataset_(dataset, refreshedStates[dataset], forceAudit, retryCount + 1);
}

function frjReadLocalDataset_(dataset) {
  if (dataset === "catalog") return frjReadLocalCatalog_();
  if (dataset === "mu") return frjReadLocalMarket_();
  if (dataset === "containers") return frjReadLocalContainerConfig_();
  if (dataset === "discounts") return frjReadLocalDiscountCampaigns_();
  if (dataset === "discount-config") return frjReadLocalDiscountConfig_();
  return frjReadLocalInventory_(dataset.slice("inventory:".length));
}

function frjReadRemoteDataset_(dataset) {
  if (dataset === "catalog") return frjD1Request_("/sync/catalog");
  if (dataset === "mu") return frjD1Request_("/sync/mu");
  if (dataset === "containers") return frjD1Request_("/sync/containers");
  if (dataset === "discounts") return frjD1Request_("/sync/discounts");
  if (dataset === "discount-config") return frjD1Request_("/sync/discount-config");
  return frjD1Request_("/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length)));
}

function frjReadRemoteDatasetByHash_(dataset, hash) {
  if (dataset === "catalog") return frjD1Request_("/sync/catalog?hash=" + encodeURIComponent(hash));
  if (dataset === "mu") return frjD1Request_("/sync/mu?hash=" + encodeURIComponent(hash));
  if (dataset === "containers") return frjD1Request_("/sync/containers?hash=" + encodeURIComponent(hash));
  if (dataset === "discounts") return frjD1Request_("/sync/discounts?hash=" + encodeURIComponent(hash));
  if (dataset === "discount-config") return frjD1Request_("/sync/discount-config?hash=" + encodeURIComponent(hash));
  return frjD1Request_(
    "/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length)) +
    "&hash=" + encodeURIComponent(hash)
  );
}

function frjWriteLocalDataset_(dataset, snapshot) {
  if (dataset === "catalog") throw new Error("BDD_APP est actuellement le référentiel maître du catalogue");
  if (dataset === "mu") return frjWriteLocalMarket_(snapshot);
  if (dataset === "containers") return frjWriteLocalContainerConfig_(snapshot);
  if (dataset === "discounts") return frjWriteLocalDiscountCampaigns_(snapshot);
  if (dataset === "discount-config") return frjWriteLocalDiscountConfig_(snapshot);
  return frjWriteLocalInventory_(dataset.slice("inventory:".length), snapshot);
}

function frjPushDataset_(dataset, local, expectedHash) {
  var path = dataset === "catalog"
    ? "/sync/catalog"
    : (dataset === "mu"
      ? "/sync/mu"
      : (dataset === "containers"
        ? "/sync/containers"
        : (dataset === "discounts" ? "/sync/discounts"
          : (dataset === "discount-config" ? "/sync/discount-config"
            : "/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length))))));
  return frjD1Request_(path, {
    method: "post",
    expectedHash: expectedHash,
    payload: JSON.stringify({ rows: local.rows, updatedAt: local.updatedAt })
  });
}

function frjThreeWayMerge_(dataset, baseRows, localRows, remoteRows, conflictWinner) {
  var base = frjRowsByStableKey_(dataset, baseRows);
  var local = frjRowsByStableKey_(dataset, localRows);
  var remote = frjRowsByStableKey_(dataset, remoteRows);
  var keys = {};
  Object.keys(base).concat(Object.keys(local), Object.keys(remote)).forEach(function(key) { keys[key] = true; });

  return Object.keys(keys).sort().map(function(key) {
    var baseRow = base[key];
    var localRow = local[key];
    var remoteRow = remote[key];
    var baseSignature = frjRowSignature_(dataset, baseRow);
    var localSignature = frjRowSignature_(dataset, localRow);
    var remoteSignature = frjRowSignature_(dataset, remoteRow);

    // Une absence n'est jamais une demande de suppression pour ce référentiel.
    if (dataset === "containers" && !localRow) return remoteRow;
    if (dataset === "containers" && !remoteRow) return localRow;

    if (localSignature === remoteSignature) {
      if (dataset.indexOf("inventory:") === 0 && !baseRow && localRow && remoteRow) {
        return frjMergeInventoryQuantities_(baseRow, localRow, remoteRow, conflictWinner);
      }
      return localRow;
    }
    if (localSignature === baseSignature) return remoteRow;
    if (remoteSignature === baseSignature) return localRow;
    if (dataset.indexOf("inventory:") === 0 && localRow && remoteRow) {
      return frjMergeInventoryQuantities_(baseRow, localRow, remoteRow, conflictWinner);
    }
    return conflictWinner === "local" ? localRow : remoteRow;
  }).filter(function(row) { return row !== undefined; });
}

function frjMergeInventoryQuantities_(baseRow, localRow, remoteRow, conflictWinner) {
  var winner = conflictWinner === "local" ? localRow : remoteRow;
  var baseQuantity = baseRow ? Number(baseRow.quantity) || 0 : 0;
  var baseValue = baseRow && baseRow.valuePed !== null && baseRow.valuePed !== undefined
    ? Number(baseRow.valuePed) || 0
    : 0;
  var localHasValue = localRow.valuePed !== null && localRow.valuePed !== undefined;
  var remoteHasValue = remoteRow.valuePed !== null && remoteRow.valuePed !== undefined;
  var baseHasValue = Boolean(baseRow && baseRow.valuePed !== null && baseRow.valuePed !== undefined);
  return {
    sourceId: winner.sourceId || localRow.sourceId || remoteRow.sourceId || (baseRow && baseRow.sourceId) || null,
    itemName: winner.itemName,
    quantity: (Number(localRow.quantity) || 0) + (Number(remoteRow.quantity) || 0) - baseQuantity,
    valuePed: localHasValue || remoteHasValue || baseHasValue
      ? (Number(localRow.valuePed) || 0) + (Number(remoteRow.valuePed) || 0) - baseValue
      : null,
    container: winner.container || null,
    containerRefId: winner.containerRefId || localRow.containerRefId || remoteRow.containerRefId ||
      (baseRow && baseRow.containerRefId) || null
  };
}

function frjRowsByStableKey_(dataset, rows) {
  var result = {};
  var occurrences = {};
  rows.forEach(function(row) {
    var baseKey;
    if (dataset === "mu") {
      baseKey = "item:" + frjText_(row.itemName).toLowerCase();
    } else if (dataset === "catalog") {
      baseKey = "listing:" + [
        frjText_(row.itemName).toLowerCase(),
        frjText_(row.storage).toLowerCase(),
        frjText_(row.aisle).toLowerCase()
      ].join("|");
    } else if (dataset === "containers") {
      baseKey = "container:" + [
        frjText_(row.avatar).toLowerCase(),
        frjText_(row.containerKey || row.container).toLowerCase()
      ].join("\u001f");
    } else if (dataset === "discounts" || dataset === "discount-config") {
      baseKey = dataset + ":" + frjText_(row.id);
    } else {
      baseKey = row.sourceId
        ? "inventory:id:" + frjText_(row.sourceId).toLowerCase()
        : "inventory:" + [
          frjText_(row.itemName).toLowerCase(),
          frjText_(row.container).toLowerCase()
        ].join("\u001f");
    }
    occurrences[baseKey] = (occurrences[baseKey] || 0) + 1;
    result[baseKey + "#" + occurrences[baseKey]] = row;
  });
  return result;
}

function frjRowSignature_(dataset, row) {
  if (row === undefined) return "__ABSENT__";
  if (dataset === "mu") {
    return JSON.stringify([
      frjText_(row.itemName), frjText_(row.tier),
      frjText_(row.dayMarkup), frjText_(row.daySales),
      frjText_(row.weekMarkup), frjText_(row.weekSales),
      frjText_(row.monthMarkup), frjText_(row.monthSales),
      frjText_(row.yearMarkup), frjText_(row.yearSales),
      frjText_(row.decadeMarkup), frjText_(row.decadeSales),
      frjToIso_(row.observedAt, "")
    ]);
  }
  if (dataset === "catalog") {
    return JSON.stringify([
      frjText_(row.itemName), frjText_(row.storage).toUpperCase(), frjText_(row.aisle).toUpperCase(),
      frjNullableNumberText_(row.unitPricePed), frjText_(row.image), frjText_(row.wikiUrl),
      Number(row.enabled) === 0 ? "0" : "1"
    ]);
  }
  if (dataset === "containers") {
    return JSON.stringify([
      frjText_(row.avatar).toLowerCase(),
      frjText_(row.containerKey || row.container).toLowerCase(),
      frjText_(row.container),
      row.enabled === true || Number(row.enabled) === 1 ? "1" : "0"
    ]);
  }
  if (dataset === "discounts") return JSON.stringify([
    row.id, row.type, row.startsOn, row.endsOn, row.storage || "", row.aisle || "",
    String(Number(row.discountRate)), row.enabled === true ? "1" : "0", row.origin || "manual",
    row.eligiblePairCount == null ? "" : String(row.eligiblePairCount),
    row.candidatePairCount == null ? "" : String(row.candidatePairCount), frjToIso_(row.updatedAt, "")
  ]);
  if (dataset === "discount-config") return JSON.stringify([
    row.id, row.automaticPromotionsEnabled === true ? "1" : "0", String(Number(row.defaultPromotionRate)),
    row.selectionSeed || "frj-daily-promo", frjToIso_(row.updatedAt, "")
  ]);
  return JSON.stringify([
    frjText_(row.sourceId), frjText_(row.itemName), frjNumber_(row.quantity),
    frjNullableNumberText_(row.valuePed), frjText_(row.container), frjText_(row.containerRefId)
  ]);
}
