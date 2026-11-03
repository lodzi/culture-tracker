"use strict";

// Gedeelde instellingen voor de algoritme-v2. Leest config/pipeline.json en vult
// ontbrekende velden aan met veilige standaardwaarden. Zonder bestand (of met
// kapotte JSON) staan alle v2-schakelaars UIT, dus de pipeline draait dan zoals voorheen.

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "pipeline.json");

const DEFAULTS = {
  weeklyV2: false,
  dailyPoolV2: false,
  models: {
    daily: "claude-haiku-4-5-20251001",
    weekly: "claude-sonnet-4-6",
    weeklyFallback: "claude-sonnet-4-6",
  },
  daily: {
    fetchMaxTopics: 40,
    fetchClustersPerCategory: 5,
    singleSourceCategories: ["lokaal"],
    singleSourcePerCategory: 4,
    maxClustersSentPerCategory: 8,
    maxInsightsPerCategory: 5,
    maxTokens: 8192,
  },
  weekly: {
    regenerateWeekday: 4,
    poolDays: 7,
    top: 10,
    maxPerCategory: 2,
    categoryMax: { film: 2 },
    minLokaal: 1,
    minPoolSignals: 12,
    minPoolCategories: 4,
    sentLookbackWeeks: 8,
    heavyThemes: ["ai", "nostalgia", "legacy-death", "prestige"],
    heavyMultiplier: 1.5,
    penaltyCap: 4,
    repeatPenalty: 3,
  },
};

function mergeSection(base, over) {
  return Object.assign({}, base, over && typeof over === "object" ? over : {});
}

function loadPipelineConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    if (fs.existsSync(CONFIG_PATH)) {
      console.warn("⚠ config/pipeline.json onleesbaar (" + e.message + ") — v2 blijft uit.");
    }
    file = {};
  }
  return {
    weeklyV2:    file.weeklyV2 === true,
    dailyPoolV2: file.dailyPoolV2 === true,
    models: mergeSection(DEFAULTS.models, file.models),
    daily:  mergeSection(DEFAULTS.daily,  file.daily),
    weekly: mergeSection(DEFAULTS.weekly, file.weekly),
  };
}

function toISODate(d) { return d.toISOString().slice(0, 10); }

// De vrijdag van de huidige week (maandag = begin van de week, UTC).
// Zaterdag en zondag horen nog bij de vrijdag die net voorbij is.
// Dit is de "verzenddatum" waaraan een set weekly signals gekoppeld wordt.
function sendDateFor(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // ma = 0
  d.setUTCDate(d.getUTCDate() + (4 - dow));
  return toISODate(d);
}

module.exports = { loadPipelineConfig, sendDateFor, toISODate, DEFAULTS, CONFIG_PATH };
