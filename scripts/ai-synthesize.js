#!/usr/bin/env node
/**
 * Culture Tracker — AI synthesis via Claude.
 *
 * Leest data/latest-raw.json + archief en produceert data/latest.json met:
 *   - daily:    top 3 trends per categorie           (Haiku — goedkoop, snel)
 *   - megaTrends: cross-categorie mega-trends        (Haiku — één extra call)
 *   - weekly:   opkomende patronen over 7 dagen      (Sonnet — beter redeneren)
 *   - monthly:  macro-verschuivingen over 30 dagen   (Sonnet — alleen als stale)
 *
 * Caching: weekly wordt alleen herberekend als >6 dagen oud.
 *          monthly wordt alleen herberekend als >25 dagen oud.
 *
 * Kosten: daily+cross ≈ $0.006 · weekly ≈ $0.03 · monthly ≈ $0.05
 *         Maandelijks totaal: ~$0.50
 *
 * Vereist: ANTHROPIC_API_KEY
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// --- Paths ---
const ROOT          = path.resolve(__dirname, "..");
const DATA_DIR      = path.join(ROOT, "data");
const ARCHIVE_DIR   = path.join(DATA_DIR, "archive");
const RAW_PATH      = path.join(DATA_DIR, "latest-raw.json");
const LATEST_PATH   = path.join(DATA_DIR, "latest.json");
const ARCHIVE_INDEX = path.join(ARCHIVE_DIR, "index.json");

// --- Models ---
const HAIKU  = "claude-haiku-4-5-20251001";   // snel + goedkoop → daily
const SONNET = "claude-sonnet-4-6";            // beter redeneren → weekly/monthly

// --- Config ---
const MAX_INSIGHTS      = 3;
const MAX_CLUSTERS_SENT = 6;   // clusters per cat die we naar API sturen
const MAX_TITLES_SENT   = 5;   // titels per cluster

const CATEGORIES_ORDER = [
  "lokaal", "culture", "music", "fashion", "film", "art",
  "internet", "gaming", "trends", "marketing",
];

const CATEGORY_LABELS = {
  music:      "Muziek",
  fashion:    "Fashion",
  film:       "Film & TV",
  internet:   "Internet",
  gaming:     "Gaming",
  art:        "Art & Design",
  culture:    "Cultuur",
  trends:     "Trends",
  marketing:  "Marketing",
  lokaal:     "Lokaal",
};

// --- Helpers ---
function readJSON(p)       { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
function todayISO()        { return new Date().toISOString().slice(0, 10); }
function catLabel(id)      { return CATEGORY_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1); }

function sortCats(cats) {
  return cats.slice().sort(function (a, b) {
    const ai = CATEGORIES_ORDER.indexOf(a.id);
    const bi = CATEGORIES_ORDER.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function ageDays(isoDate) {
  if (!isoDate) return 999;
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

function parseAIJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

function updateArchiveIndex(date) {
  let entries = [];
  if (fs.existsSync(ARCHIVE_INDEX)) {
    try { entries = readJSON(ARCHIVE_INDEX); } catch (e) { entries = []; }
  }
  if (!entries.includes(date)) {
    entries.push(date);
    entries.sort(function (a, b) { return b.localeCompare(a); });
    writeJSON(ARCHIVE_INDEX, entries);
  }
}

// ── Trend-continuïteit: laad recente trend-namen uit archief ──────────────
// Leest de laatste `daysBack` archief-bestanden en verzamelt alle trend-titels.
// Resultaat: [{daysAgo: 1, date: "2026-05-06", trends: ["Trend A", "Trend B"]}, ...]

function loadRecentTrends(daysBack) {
  const result = [];
  const today = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const p = path.join(ARCHIVE_DIR, iso + ".json");
    if (!fs.existsSync(p)) continue;
    try {
      const data = readJSON(p);
      const cats = (data.daily && data.daily.categories) || [];
      const trends = [];
      for (const cat of cats) {
        for (const ins of (cat.insights || [])) {
          if (ins.trend) trends.push(ins.trend);
        }
      }
      if (trends.length > 0) result.push({ daysAgo: i, date: iso, trends });
    } catch (e) { /* skip corrupt file */ }
  }
  return result;
}

// ── Daily synthesis ────────────────────────────────────────────────────────
// Stuurt cluster-titels naar Haiku. Haiku valideert coherentie + schrijft
// per categorie max. 3 trend-insights met samenvatting en culturele duiding.

async function synthesizeDaily(client, rawData) {
  const topics = (rawData.daily && rawData.daily.topics) || [];
  if (topics.length === 0) {
    return { categories: [], intro: "Geen data beschikbaar.", generatedAt: new Date().toISOString() };
  }

  // Groepeer per categorie, sorteer op sourceCount
  const byCategory = {};
  for (const t of topics) {
    for (const cat of (t.categories || [])) {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(t);
    }
  }

  const promptData = {};
  for (const [cat, catTopics] of Object.entries(byCategory)) {
    promptData[cat] = catTopics.slice(0, MAX_CLUSTERS_SENT).map(function (t, idx) {
      return {
        idx:     idx,
        bronnen: t.sources.slice(0, 4),
        titels:  t.items.slice(0, MAX_TITLES_SENT).map(function (a) { return a.title; }),
      };
    });
  }

  // Laad recente trend-geschiedenis voor continuïteit-context
  const recentHistory = loadRecentTrends(3);
  const historyContext = recentHistory.length > 0
    ? recentHistory.map(function (h) {
        const label = h.daysAgo === 1 ? "Gisteren" : h.daysAgo + " dagen geleden";
        return label + " (" + h.date + "): " + h.trends.join(", ");
      }).join("\n")
    : "Geen archief beschikbaar (eerste run).";

  const prompt = `Je bent een scherpe culturele trendwatcher. Analyseer deze nieuwsclusters per categorie.

KRITISCH: een cluster = artikels die hetzelfde keyword delen, maar dat betekent NIET dat ze over hetzelfde gaan.
Bepaal of de artikels echt over hetzelfde specifieke onderwerp gaan (coherent = true/false).

Schrijf per categorie maximaal ${MAX_INSIGHTS} ECHTE culturele trends. Een echte trend:
- Wordt gedekt door 2+ onafhankelijke bronnen over precies hetzelfde onderwerp
- Heeft culturele relevantie, niet alleen nieuwswaarde
- Is specifiek (niet "muziek is populair" maar "de comeback van neo-soul in mainstream pop")

TREND-CONTINUÏTEIT — recent archief (gebruik dit voor daysActive en isNew):
${historyContext}

Geef voor elke insight:
- trend: pakkende titel van 4-6 woorden (Nederlands of Engels, wat het best past)
- summary: 2 zinnen — wat er precies gebeurt, wie/wat erbij betrokken is
- why_it_matters: 1 zin — de bredere culturele betekenis of wat dit voorspelt
- trajectory: "opkomend" | "piekend" | "afbouwend" (gebaseerd op bronnen + context)
- daysActive: hoeveel dagen dit thema al actief is (1 = nieuw vandaag, 2 = ook gisteren aanwezig, 3+ = al meerdere dagen — maak een eerlijke schatting op basis van het archief)
- isNew: true als het thema gisteren NIET aanwezig was, false als het een voortzetting is

Antwoord ALLEEN met JSON:
{
  "categories": [
    {
      "id": "categoryId",
      "insights": [
        {
          "idx": 0,
          "coherent": true,
          "trend": "...",
          "summary": "...",
          "why_it_matters": "...",
          "trajectory": "opkomend",
          "daysActive": 1,
          "isNew": true
        }
      ]
    }
  ]
}

Clusters per categorie:
${JSON.stringify(promptData, null, 2)}`;

  console.log("  [Haiku] Daily synthesis…");
  const msg = await client.messages.create({
    model: HAIKU, max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  let aiResult;
  try { aiResult = parseAIJson(msg.content[0].text); }
  catch (e) {
    console.error("  Parse mislukt:", msg.content[0].text.slice(0, 200));
    throw e;
  }

  const categories = [];
  let totalInsights = 0;

  for (const catResult of (aiResult.categories || [])) {
    const catId    = catResult.id;
    const catTopics = byCategory[catId] || [];
    const insights  = [];

    for (const ins of (catResult.insights || [])) {
      if (!ins.coherent) continue;
      const topic = catTopics[ins.idx];
      if (!topic) continue;
      insights.push({
        trend:          ins.trend,
        summary:        ins.summary,
        why_it_matters: ins.why_it_matters,
        trajectory:     ins.trajectory || null,
        daysActive:     typeof ins.daysActive === "number" ? ins.daysActive : 1,
        isNew:          ins.isNew !== false,   // default true (nieuw) als AI het niet invult
        sources:        topic.sources,
        trending:       topic.trending || false,
        articles:       topic.items.slice(0, 4).map(function (a) {
          return { title: a.title, url: a.url, source: a.source, published: a.published };
        }),
      });
    }

    if (insights.length > 0) {
      categories.push({ id: catId, label: catLabel(catId), insights });
      totalInsights += insights.length;
    }
  }

  const sorted = sortCats(categories);
  return {
    generatedAt: new Date().toISOString(),
    intro: sorted.length + " categorieën · " + totalInsights + " trends · laatste 24u",
    categories: sorted,
  };
}

// ── Cross-categorie mega-trends ────────────────────────────────────────────
// Één goedkope Haiku-call die detecteert welke thema's over categoriegrenzen heen gaan.
// Input: alleen de trend-titels van de daily synthesis (compacte call).

async function synthesizeCrossCategory(client, dailyCategories) {
  if (!dailyCategories || dailyCategories.length < 3) return null;

  const compact = {};
  for (const cat of dailyCategories) {
    compact[cat.id] = (cat.insights || []).map(function (i) { return i.trend; });
  }

  const prompt = `Je bent een culturele trendanalist. Hieronder staan de trends van vandaag per categorie.

Identificeer 1 tot 3 MEGA TRENDS: thema's, personen, merken of bewegingen die in MEERDERE categorieën (2+) tegelijk opduiken. Dit zijn de meest cultureel significante signalen.

Wees specifiek: niet "technologie beïnvloedt cultuur" maar "AI-gegenereerde esthetiek verspreidt zich van internet naar fashion en muziekproductie".

Geef alleen verbindingen die echt in de data zichtbaar zijn.

Antwoord ALLEEN met JSON:
{
  "megaTrends": [
    {
      "trend": "Pakkende naam (4-6 woorden)",
      "summary": "2 zinnen: wat verbindt deze categorieën en hoe uit zich dat?",
      "why_it_matters": "1 zin: wat zegt dit over de bredere cultuur?",
      "categories": ["music", "fashion"],
      "strength": "sterk" | "matig"
    }
  ]
}

Als er geen echte cross-categorie verbindingen zijn, geef dan {"megaTrends": []}.

Trends per categorie:
${JSON.stringify(compact, null, 2)}`;

  console.log("  [Haiku] Cross-categorie detectie…");
  const msg = await client.messages.create({
    model: HAIKU, max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  try {
    const result = parseAIJson(msg.content[0].text);
    const mega = (result.megaTrends || []).filter(function (m) {
      return m.categories && m.categories.length >= 2 && m.trend;
    });
    return mega.length > 0 ? { generatedAt: new Date().toISOString(), megaTrends: mega } : null;
  } catch (e) {
    console.error("  Cross-categorie parse mislukt.");
    return null;
  }
}

// ── Weekly synthesis ───────────────────────────────────────────────────────
// Leest de laatste 7 archieven. Gebruikt Sonnet voor betere patroonherkenning.
// Wordt alleen herberekend als >6 dagen oud (kostenbesparing).

function loadArchiveDays(n) {
  const days = [];
  const today = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const p   = path.join(ARCHIVE_DIR, iso + ".json");
    if (!fs.existsSync(p)) continue;
    try {
      const data = readJSON(p);
      const cats = (data.daily && data.daily.categories) || null;
      const topics = (data.daily && data.daily.topics) || null;
      if (cats && cats.length > 0) {
        days.push({ date: iso, categories: cats });
      } else if (topics && topics.length > 0) {
        const byCat = {};
        for (const t of topics) {
          for (const cat of (t.categories || [])) {
            if (!byCat[cat]) byCat[cat] = [];
            byCat[cat].push({ trend: t.label });
          }
        }
        const fakeCats = Object.entries(byCat).map(function ([id, ins]) {
          return { id, insights: ins.slice(0, 3) };
        });
        if (fakeCats.length) days.push({ date: iso, categories: fakeCats });
      }
    } catch (e) { /* skip corrupt */ }
  }
  return days;
}

async function synthesizeWeekly(client, existingWeekly) {
  if (existingWeekly && ageDays(existingWeekly.generatedAt) < 6) {
    console.log("  Weekly is nog vers (" + ageDays(existingWeekly.generatedAt).toFixed(1) + " dagen oud) — hergebruik.");
    return existingWeekly;
  }

  const days = loadArchiveDays(7);
  if (days.length < 2) {
    console.log("  Te weinig archiefdagen (" + days.length + ") voor weekly synthesis.");
    return null;
  }

  // Compacte input: alleen trend-titels + trajectories per dag per categorie
  const byCat = {};
  for (const day of days) {
    for (const cat of (day.categories || [])) {
      if (!byCat[cat.id]) byCat[cat.id] = [];
      const trends = (cat.insights || []).map(function (i) {
        return i.trajectory ? i.trend + " [" + i.trajectory + "]" : i.trend;
      });
      if (trends.length) byCat[cat.id].push({ datum: day.date, trends });
    }
  }
  if (!Object.keys(byCat).length) return null;

  const prompt = `Je bent een senior cultureel strateeg. Hieronder staan ${days.length} dagen aan dagelijkse trendsignalen per categorie, met trajectories (opkomend/piekend/afbouwend).

Identificeer de ${MAX_INSIGHTS} meest significante OPKOMENDE PATRONEN per categorie:
- Thema's die meermaals opduiken of momentum opbouwen
- Bewegingen die van niche naar mainstream gaan
- Culturele verschuivingen met strategische betekenis voor merken

Vermijd: louter herhalende nieuwsfeiten zonder diepere betekenis.

Geef per pattern:
- trend: naam van het opkomende patroon (4-6 woorden)
- summary: 2 zinnen — wat bouwt op en hoe manifesteert het zich?
- why_it_matters: 1 zin — strategische of culturele betekenis
- momentum: "versnellend" | "stabiel" | "afvlakkend"

Antwoord ALLEEN met JSON:
{
  "categories": [
    {
      "id": "categoryId",
      "insights": [
        {
          "trend": "...",
          "summary": "...",
          "why_it_matters": "...",
          "momentum": "versnellend"
        }
      ]
    }
  ]
}

Dagelijkse signalen per categorie (${days.length} dagen):
${JSON.stringify(byCat, null, 2)}`;

  console.log("  [Sonnet] Weekly synthesis (" + days.length + " dagen)…");
  const msg = await client.messages.create({
    model: SONNET, max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  let aiResult;
  try { aiResult = parseAIJson(msg.content[0].text); }
  catch (e) { console.error("  Weekly parse mislukt."); return null; }

  const categories = sortCats(
    (aiResult.categories || [])
      .filter(function (c) { return c.insights && c.insights.length > 0; })
      .map(function (c) { return { id: c.id, label: catLabel(c.id), insights: c.insights }; })
  );

  const total = categories.reduce(function (s, c) { return s + c.insights.length; }, 0);
  return {
    generatedAt:  new Date().toISOString(),
    daysAnalyzed: days.length,
    intro:        categories.length + " categorieën · " + total + " patronen · laatste " + days.length + " dagen",
    categories,
  };
}

// ── Monthly synthesis ──────────────────────────────────────────────────────
// Leest max. 30 archieven. Gebruikt Sonnet voor macro-verschuivingen.
// Wordt alleen herberekend als >25 dagen oud of niet aanwezig.

async function synthesizeMonthly(client, existingMonthly) {
  if (existingMonthly && ageDays(existingMonthly.generatedAt) < 25) {
    console.log("  Monthly is nog vers (" + Math.round(ageDays(existingMonthly.generatedAt)) + " dagen oud) — hergebruik.");
    return existingMonthly;
  }

  const days = loadArchiveDays(30);
  if (days.length < 7) {
    console.log("  Te weinig archiefdagen (" + days.length + ") voor monthly synthesis — minimum 7 nodig.");
    return null;
  }

  // Extreem compact: enkel trend-titels per categorie, geen datums
  const byCat = {};
  for (const day of days) {
    for (const cat of (day.categories || [])) {
      if (!byCat[cat.id]) byCat[cat.id] = [];
      (cat.insights || []).forEach(function (i) {
        if (i.trend) byCat[cat.id].push(i.trend);
      });
    }
  }
  if (!Object.keys(byCat).length) return null;

  const prompt = `Je bent een cultureel futurist. Hieronder staan trendsignalen van de afgelopen ${days.length} dagen per categorie.

Identificeer de ${MAX_INSIGHTS} grootste MACRO-VERSCHUIVINGEN per categorie:
- Trage, structurele veranderingen in smaak, gedrag of waarden
- Dingen die in 6-12 maanden mainstream worden
- Signalen die de toekomst van die categorie voorspellen

Dit zijn GEEN korte hypes maar fundamentele culturele bewegingen.

Geef per macro-trend:
- trend: naam van de verschuiving (4-6 woorden)
- summary: 2 zinnen — wat verandert er structureel en hoe zien we dat?
- why_it_matters: 1 zin — wat betekent dit voor de komende 6-12 maanden?
- horizon: "3 maanden" | "6 maanden" | "12 maanden" (wanneer bereikt dit mainstream?)

Antwoord ALLEEN met JSON:
{
  "categories": [
    {
      "id": "categoryId",
      "insights": [
        {
          "trend": "...",
          "summary": "...",
          "why_it_matters": "...",
          "horizon": "6 maanden"
        }
      ]
    }
  ]
}

Trendsignalen per categorie (${days.length} dagen):
${JSON.stringify(byCat, null, 2)}`;

  console.log("  [Sonnet] Monthly synthesis (" + days.length + " dagen)…");
  const msg = await client.messages.create({
    model: SONNET, max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  let aiResult;
  try { aiResult = parseAIJson(msg.content[0].text); }
  catch (e) { console.error("  Monthly parse mislukt."); return null; }

  const categories = sortCats(
    (aiResult.categories || [])
      .filter(function (c) { return c.insights && c.insights.length > 0; })
      .map(function (c) { return { id: c.id, label: catLabel(c.id), insights: c.insights }; })
  );

  const total = categories.reduce(function (s, c) { return s + c.insights.length; }, 0);
  return {
    generatedAt:  new Date().toISOString(),
    daysAnalyzed: days.length,
    intro:        categories.length + " categorieën · " + total + " macro-trends · laatste " + days.length + " dagen",
    categories,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Culture Tracker — AI synthesis");
  console.log("Datum: " + todayISO());

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY niet ingesteld.");
    process.exit(1);
  }

  // Laad brondata
  let sourcePath = RAW_PATH;
  if (!fs.existsSync(RAW_PATH)) {
    if (fs.existsSync(LATEST_PATH)) {
      console.warn("latest-raw.json niet gevonden — gebruik latest.json als fallback.");
      sourcePath = LATEST_PATH;
    } else {
      console.error("Geen brondata gevonden.");
      process.exit(1);
    }
  }

  // Laad bestaande latest.json voor caching van weekly/monthly
  let existing = {};
  if (fs.existsSync(LATEST_PATH)) {
    try { existing = readJSON(LATEST_PATH); } catch (e) { existing = {}; }
  }

  const client  = new Anthropic();
  const rawData = readJSON(sourcePath);

  // 1. Daily
  console.log("\n[Daily synthesis]");
  let daily;
  try {
    daily = await synthesizeDaily(client, rawData);
    const nCats     = daily.categories ? daily.categories.length : 0;
    const nInsights = daily.categories
      ? daily.categories.reduce(function (s, c) { return s + c.insights.length; }, 0) : 0;
    console.log("  ✓ " + nCats + " categorieën, " + nInsights + " insights");
    if (nCats === 0) {
      // API call slaagde maar leverde niks op — waarschuw en stop
      throw new Error("Synthesis gaf 0 categorieën terug. Controleer de API-sleutel en modelnaam.");
    }
  } catch (e) {
    // Schrijf de foutmelding naar latest.json zodat die zichtbaar is in de frontend
    const errBrief = {
      date:       todayISO(),
      synthError: e.message,
      aiModel:    { daily: HAIKU, weekly: SONNET, monthly: SONNET },
      daily:      rawData.daily || { topics: [], intro: "AI synthesis mislukt: " + e.message },
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJSON(LATEST_PATH, errBrief);
    console.error("\n✗ DAILY SYNTHESIS MISLUKT");
    console.error("  Fout:", e.message);
    console.error("  Status: controleer ANTHROPIC_API_KEY secret en modelnaam (" + HAIKU + ")");
    console.error("  Foutmelding geschreven naar latest.json (veld: synthError)");
    process.exit(1);   // laat de GitHub Actions workflow zichtbaar falen
  }

  // 2. Cross-categorie mega-trends
  console.log("\n[Cross-categorie detectie]");
  let crossCategory = null;
  try {
    crossCategory = await synthesizeCrossCategory(client, daily.categories || []);
    if (crossCategory) {
      console.log("  ✓ " + crossCategory.megaTrends.length + " mega-trends gevonden");
    } else {
      console.log("  Geen cross-categorie verbindingen gevonden.");
    }
  } catch (e) {
    console.error("  Cross-categorie mislukt:", e.message);
  }

  // 3. Weekly (Sonnet, gecached)
  console.log("\n[Weekly synthesis]");
  let weekly = null;
  try {
    weekly = await synthesizeWeekly(client, existing.weekly || null);
    if (weekly) console.log("  ✓ " + weekly.categories.length + " categorieën");
  } catch (e) {
    console.error("  Weekly mislukt:", e.message);
  }

  // 4. Monthly (Sonnet, gecached)
  console.log("\n[Monthly synthesis]");
  let monthly = null;
  try {
    monthly = await synthesizeMonthly(client, existing.monthly || null);
    if (monthly) console.log("  ✓ " + monthly.categories.length + " categorieën");
  } catch (e) {
    console.error("  Monthly mislukt:", e.message);
  }

  // Schrijf latest.json
  const date  = todayISO();
  const brief = {
    date,
    aiModel: { daily: HAIKU, weekly: SONNET, monthly: SONNET },
    daily,
    ...(crossCategory ? { crossCategory } : {}),
    ...(weekly        ? { weekly }        : {}),
    ...(monthly       ? { monthly }       : {}),
  };

  fs.mkdirSync(DATA_DIR,    { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeJSON(LATEST_PATH, brief);
  const archivePath = path.join(ARCHIVE_DIR, date + ".json");
  writeJSON(archivePath, brief);
  updateArchiveIndex(date);

  console.log("\n✓ Schreef " + LATEST_PATH);
  console.log("✓ Schreef " + archivePath);
}

main().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error("Fatal:", err);
  process.exit(1);
});
