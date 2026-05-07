#!/usr/bin/env node
/**
 * Culture Tracker — AI synthesis via Claude Haiku.
 *
 * Reads data/latest-raw.json (output van fetch-and-summarize.js) en de
 * laatste 7 archieven voor weekly synthesis.
 *
 * Stappen:
 *   1. Daily: stuurt gegroepeerde cluster-titels naar Haiku in één call.
 *      Haiku valideert semantische coherentie + schrijft per categorie
 *      max. 3 trend-insights.
 *   2. Weekly: stuurt geaggregeerde dagelijkse inzichten van de afgelopen
 *      7 dagen naar Haiku voor patroonherkenning.
 *   3. Schrijft data/latest.json (AI-verrijkt) + data/archive/YYYY-MM-DD.json.
 *
 * Kosten (Claude Haiku):
 *   Daily call  ≈ $0.005 · Weekly call ≈ $0.002 → < $0.20/maand bij dagelijks gebruik.
 *
 * Vereist: ANTHROPIC_API_KEY omgevingsvariabele.
 *
 * Dependencies: @anthropic-ai/sdk
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// --- Paths ---
const ROOT             = path.resolve(__dirname, "..");
const DATA_DIR         = path.join(ROOT, "data");
const ARCHIVE_DIR      = path.join(DATA_DIR, "archive");
const RAW_PATH         = path.join(DATA_DIR, "latest-raw.json");
const LATEST_PATH      = path.join(DATA_DIR, "latest.json");
const ARCHIVE_INDEX    = path.join(ARCHIVE_DIR, "index.json");

// --- Config ---
const MAX_INSIGHTS   = 3;   // max trends per categorie per tijdsframe
const MAX_CLUSTERS   = 6;   // max clusters per categorie die we naar de API sturen
const MAX_TITLES     = 5;   // max artikel-titels per cluster in de prompt (houdt tokens laag)
const LOOKBACK_DAYS  = 7;   // voor weekly synthesis

const CATEGORIES_ORDER = [
  "culture", "music", "fashion", "film", "art",
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
};

// --- Helpers ---
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function categoryLabel(id) {
  return CATEGORY_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1));
}

function sortCategories(categories) {
  return categories.slice().sort(function (a, b) {
    const ai = CATEGORIES_ORDER.indexOf(a.id);
    const bi = CATEGORIES_ORDER.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
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

// ── Daily synthesis ────────────────────────────────────────────────────────

async function synthesizeDaily(client, rawData) {
  const topics = (rawData.daily && rawData.daily.topics) || [];

  if (topics.length === 0) {
    console.warn("  Geen topics in raw data.");
    return { categories: [], intro: "Geen data beschikbaar." };
  }

  // Groepeer clusters per categorie; neem de top MAX_CLUSTERS per categorie
  const byCategory = {};
  for (const topic of topics) {
    for (const cat of (topic.categories || [])) {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(topic);
    }
  }

  // Bouw compacte promptdata: alleen titels (geen summaries) om tokens laag te houden.
  // Structuur: { categoryId: [ { idx, sources, titles } ] }
  const promptData = {};
  for (const [cat, catTopics] of Object.entries(byCategory)) {
    promptData[cat] = catTopics.slice(0, MAX_CLUSTERS).map(function (t, idx) {
      return {
        idx:     idx,
        sources: t.sources.slice(0, 4),
        titles:  t.items.slice(0, MAX_TITLES).map(function (a) { return a.title; }),
      };
    });
  }

  const prompt = `Je bent een cultureel trendanalist. Analyseer deze artikel-clusters per categorie.

Elke cluster bevat artikels die hetzelfde keyword delen, maar dat betekent NIET dat ze over hetzelfde gaan.
Jouw taak: bepaal welke clusters écht over hetzelfde culturele onderwerp gaan (coherent), en schrijf daarvoor een trend-insight.

Geef maximaal ${MAX_INSIGHTS} echte trends per categorie. Een echte trend:
- Heeft artikels van 2+ verschillende bronnen over hetzelfde specifieke onderwerp
- Is cultureel significant (niet enkel een random nieuwsfeit)

Antwoord ALLEEN met geldige JSON, geen uitleg erbuiten:
{
  "categories": [
    {
      "id": "categoryId",
      "insights": [
        {
          "idx": 0,
          "coherent": true,
          "trend": "Trendsamenvatting in 4-6 woorden",
          "summary": "2 zinnen: wat er precies gebeurt en wie erbij betrokken is.",
          "why_it_matters": "1 zin over bredere culturele betekenis."
        }
      ]
    }
  ]
}

Zet coherent: false als de artikels van een cluster niet écht over hetzelfde gaan.
Geef enkel de ${MAX_INSIGHTS} meest significante trends per categorie.

Clusters per categorie:
${JSON.stringify(promptData, null, 2)}`;

  console.log("  Haiku aanroepen voor daily synthesis…");
  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text;
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  let aiResult;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    aiResult = JSON.parse(match ? match[0] : text);
  } catch (e) {
    console.error("  Kon AI-antwoord niet parsen:", text.slice(0, 300));
    throw e;
  }

  // Combineer AI-insights met de originele clusterdata (bronnen, artikels)
  const categories = [];
  let totalInsights = 0;

  for (const catResult of (aiResult.categories || [])) {
    const catId     = catResult.id;
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
        sources:        topic.sources,
        trending:       topic.trending || false,
        articles:       topic.items.slice(0, 4).map(function (a) {
          return { title: a.title, url: a.url, source: a.source, published: a.published };
        }),
      });
    }

    if (insights.length > 0) {
      categories.push({ id: catId, label: categoryLabel(catId), insights: insights });
      totalInsights += insights.length;
    }
  }

  const sorted = sortCategories(categories);
  const intro  = sorted.length + " categorieën · " + totalInsights +
    " trends · laatste 24u";

  return {
    generatedAt: new Date().toISOString(),
    intro:       intro,
    categories:  sorted,
  };
}

// ── Weekly synthesis ───────────────────────────────────────────────────────

function loadLastNDays(n) {
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
      // Accepteer zowel AI-formaat (daily.categories) als raw (daily.topics)
      const cats = (data.daily && data.daily.categories) || null;
      const topics = (data.daily && data.daily.topics) || null;
      if (cats && cats.length > 0) {
        days.push({ date: iso, categories: cats });
      } else if (topics && topics.length > 0) {
        // Converteer raw topics naar compacte vorm
        const byCat = {};
        for (const t of topics) {
          for (const cat of (t.categories || [])) {
            if (!byCat[cat]) byCat[cat] = [];
            byCat[cat].push({ trend: t.label });
          }
        }
        const fakeCats = Object.entries(byCat).map(function (pair) {
          return { id: pair[0], insights: pair[1].slice(0, 3) };
        });
        if (fakeCats.length > 0) days.push({ date: iso, categories: fakeCats });
      }
    } catch (e) { /* skip */ }
  }

  return days;
}

async function synthesizeWeekly(client) {
  const days = loadLastNDays(LOOKBACK_DAYS);

  if (days.length < 2) {
    console.log("  Te weinig archiefdagen voor weekly synthesis (" + days.length + " gevonden).");
    return null;
  }

  // Bouw super-compact promptdata: alleen trend-titels per categorie per dag
  // Bijv. { music: [ { date: "2026-05-06", trends: ["Titel A", "Titel B"] } ] }
  const byCat = {};
  for (const day of days) {
    for (const cat of (day.categories || [])) {
      if (!byCat[cat.id]) byCat[cat.id] = [];
      const trendTitles = (cat.insights || []).map(function (i) {
        return i.trend || i.label || "";
      }).filter(Boolean);
      if (trendTitles.length > 0) {
        byCat[cat.id].push({ date: day.date, trends: trendTitles });
      }
    }
  }

  if (Object.keys(byCat).length === 0) return null;

  const prompt = `Je bent een cultureel trendanalist. Hieronder staan dagelijkse trend-signalen van de afgelopen ${days.length} dagen, per categorie.

Identificeer de ${MAX_INSIGHTS} meest significante OPKOMENDE PATRONEN per categorie — thema's die over meerdere dagen terugkomen of momentum opbouwen.

Antwoord ALLEEN met geldige JSON:
{
  "categories": [
    {
      "id": "categoryId",
      "insights": [
        {
          "trend": "Patroon in 4-6 woorden",
          "summary": "2 zinnen: welk patroon is aan het opkomen en waarom.",
          "why_it_matters": "1 zin over de bredere culturele verschuiving."
        }
      ]
    }
  ]
}

Dagelijkse signalen per categorie:
${JSON.stringify(byCat, null, 2)}`;

  console.log("  Haiku aanroepen voor weekly synthesis…");
  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 1536,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text;
  console.log("  Tokens: " + msg.usage.input_tokens + " in + " + msg.usage.output_tokens + " out");

  let aiResult;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    aiResult = JSON.parse(match ? match[0] : text);
  } catch (e) {
    console.error("  Kon weekly AI-antwoord niet parsen.");
    return null;
  }

  const categories = (aiResult.categories || [])
    .filter(function (c) { return c.insights && c.insights.length > 0; })
    .map(function (c) {
      return { id: c.id, label: categoryLabel(c.id), insights: c.insights };
    });

  const sorted = sortCategories(categories);
  const totalInsights = sorted.reduce(function (s, c) { return s + c.insights.length; }, 0);

  return {
    generatedAt:  new Date().toISOString(),
    daysAnalyzed: days.length,
    intro:        sorted.length + " categorieën · " + totalInsights +
      " patronen · laatste " + days.length + " dagen",
    categories:   sorted,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Culture Tracker — AI synthesis");
  console.log("Datum: " + todayISO());

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY niet ingesteld. Zie README voor instructies.");
    process.exit(1);
  }

  if (!fs.existsSync(RAW_PATH)) {
    console.error("latest-raw.json niet gevonden. Voer eerst fetch-and-summarize uit.");
    process.exit(1);
  }

  const client  = new Anthropic();
  const rawData = readJSON(RAW_PATH);

  console.log("\n[Daily synthesis]");
  let daily;
  try {
    daily = await synthesizeDaily(client, rawData);
    console.log("  ✓ " + daily.categories.length + " categorieën, " +
      daily.categories.reduce(function (s, c) { return s + c.insights.length; }, 0) + " insights");
  } catch (e) {
    console.error("  Daily synthesis mislukt:", e.message);
    // Fallback: gebruik raw topics uit latest.json
    daily = (rawData.daily) || { topics: [], intro: "Geen AI-synthesis beschikbaar." };
  }

  console.log("\n[Weekly synthesis]");
  let weekly = null;
  try {
    weekly = await synthesizeWeekly(client);
    if (weekly) {
      console.log("  ✓ " + weekly.categories.length + " categorieën over " +
        weekly.daysAnalyzed + " dagen");
    }
  } catch (e) {
    console.error("  Weekly synthesis mislukt:", e.message);
  }

  const date  = todayISO();
  const brief = {
    date:    date,
    aiModel: "claude-haiku-4-5-20251001",
    daily:   daily,
    ...(weekly ? { weekly: weekly } : {}),
  };

  // Schrijf AI-verrijkt latest.json + archief
  writeJSON(LATEST_PATH, brief);
  const archivePath = path.join(ARCHIVE_DIR, date + ".json");
  writeJSON(archivePath, brief);
  updateArchiveIndex(date);

  console.log("\n✓ Schreef " + LATEST_PATH);
  console.log("✓ Schreef " + archivePath);
  console.log("✓ Updated " + ARCHIVE_INDEX);
}

main().catch(function (err) {
  console.error("Fatal:", err);
  process.exit(1);
});
