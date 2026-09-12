/**
 * appliances.js — pure classification logic for the owner appliance monitor
 * upgrade (server.js exposes it over /api/appliances, db.js persists the
 * registry).
 *
 * There is no per-appliance sub-metering hardware — this is a software-only
 * estimate built from two things the platform already has: the appliance's
 * rated wattage (owner-entered, or a typical value for its category when the
 * owner doesn't know it) and the device's own historical average total
 * consumption (from energy_readings). An appliance is flagged "heavy" when
 * its rated draw would account for an outsized share of that average, or
 * when it's simply large in absolute terms — either signal alone is enough,
 * since a big appliance in a small system and a merely-large share of a big
 * system are both worth an owner's attention.
 *
 * Kept free of I/O so the thresholds are trivially unit-testable.
 */

/* Typical running wattage by category — used only as a fallback when the
   owner hasn't entered a rated_wattage for an appliance. Deliberately a
   short, explainable table (same spirit as weather-alerts.js's tip rules),
   not a learned model. */
const CATEGORY_TYPICAL_WATTAGE = {
  pump:     750,
  heater:   2000,
  fridge:   150,
  lighting: 60,
  fan:      75,
  tv:       120,
  other:    200
};

const APPLIANCE_CATEGORIES = Object.keys(CATEGORY_TYPICAL_WATTAGE);

/* An appliance whose rated/typical draw is at least this share of the
   device's average total consumption is flagged, regardless of its absolute
   size (catches "your biggest single load" even in a modest system). */
const HEAVY_SHARE_THRESHOLD = 0.35;

/* An appliance at or above this absolute wattage is flagged regardless of
   share (catches a genuinely large load — a heater, a big pump — even in a
   system whose average consumption is already high). */
const HEAVY_ABSOLUTE_WATTS = 1000;

function normalizeCategory(category) {
  return APPLIANCE_CATEGORIES.includes(category) ? category : 'other';
}

/** The wattage figure used for flagging: the owner's own number when given,
 *  else the category's typical value. */
function effectiveWattage(appliance) {
  const rated = Number(appliance.rated_wattage);
  if (Number.isFinite(rated) && rated > 0) return rated;
  return CATEGORY_TYPICAL_WATTAGE[normalizeCategory(appliance.category)];
}

/** Annotates each appliance with its effective wattage, estimated share of
 *  the device's average load, and whether it's flagged heavy — with a short
 *  human-readable reason. avgConsumption may be null (no readings yet), in
 *  which case only the absolute-wattage check applies. */
function classifyApplianceUsage(appliances, avgConsumption) {
  const avg = Number(avgConsumption) > 0 ? Number(avgConsumption) : null;

  return appliances.map(appliance => {
    const watts        = effectiveWattage(appliance);
    const estimated     = appliance.rated_wattage == null;
    const sharePct      = avg ? Math.round((watts / avg) * 100) : null;
    const heavyByShare   = sharePct !== null && sharePct >= HEAVY_SHARE_THRESHOLD * 100;
    const heavyByAbsolute = watts >= HEAVY_ABSOLUTE_WATTS;
    const heavy          = heavyByShare || heavyByAbsolute;

    let reason = null;
    if (heavy) {
      reason = heavyByShare
        ? `${estimated ? '~' : ''}${watts}W — about ${sharePct}% of your typical total load`
        : `${estimated ? '~' : ''}${watts}W — a large load on its own`;
    }

    return {
      ...appliance,
      effectiveWattage: watts,
      isEstimatedWattage: estimated,
      estimatedSharePct: sharePct,
      heavy,
      reason
    };
  });
}

module.exports = {
  CATEGORY_TYPICAL_WATTAGE,
  APPLIANCE_CATEGORIES,
  HEAVY_SHARE_THRESHOLD,
  HEAVY_ABSOLUTE_WATTS,
  normalizeCategory,
  effectiveWattage,
  classifyApplianceUsage
};
