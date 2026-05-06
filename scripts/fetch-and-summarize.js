#!/usr/bin/env node
/**
 * Culture Tracker — fetch & group (RSS-only, no LLM).
 *
 * 1. Reads /config/sources.json
 * 2. Fetches each RSS feed and keeps items from the last LOOKBACK_HOURS
 * 3. Dedupes by URL and (case-insensitive) title
 * 4. Scores every item on a popularity proxy:
 *      - source weight (well-known publication = higher base)
 *      - recency      (newer = higher)
 *      - trending     (keyword overlap with other items in the same window)
 *    RSS feeds don't expose actual read counts, so this approximates "most read"
 *    by combining authority, freshness and cross-source momentum.
 * 5. Groups items by category, sorts by score, keeps top MAX_ITEMS_PER_CATEGORY
 * 6. Writes /data/archive/YYYY-MM-DD.json and /data/latest.json
 * 7. Maintains /data/archive/index.json for the frontend
 *
 * No API keys required. No external services beyond the RSS feeds themselves.
 *
 * Optional env:
 *   LOOKBACK_HOURS           (default: 24)
 *   MAX_ITEMS_PER_FEED       (default: 10)
 *   MAX_ITEMS_PER_CATEGORY   (default: 5)
 *
 * Dependencies:
 *   - rss-parser — robust RSS/Atom parsing.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

// --- Paths ---
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "config", "sources.json");
const DATA_DIR = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const ARCHIVE_INDEX_PATH = path.join(ARCHIVE_DIR, "index.json");

// --- Config ---
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || "24", 10);
const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || "10", 10);
const MAX_ITEMS_PER_CATEGORY = parseInt(process.env.MAX_ITEMS_PER_CATEGORY || "5", 10);
// Hard cap on a single fetch. rss-parser has its own socket timeout, but some
// feeds redirect or stream slowly and can exceed it. We wrap every fetch in a
// Promise.race so the run can never hang on one bad source.
const PER_SOURCE_TIMEOUT_MS = parseInt(process.env.PER_SOURCE_TIMEOUT_MS || "12000", 10);

// Human-readable labels for category buckets in the brief.
// Anything not in this map falls back to a Title-Cased version of the category key.
const CATEGORY_LABELS = {
  music:      "Music",
  fashion:    "Fashion",
  film:       "Film",
  internet:   "Internet",
  sport:      "Sport",
  gaming:     "Gaming",
  art:        "Art & Design",
  brands:     "Brands",
  social:     "Social",
  marketing:  "Marketing",
  culture:    "Culture",
  trends:     "Trends",
  community:  "Community",
  innovation: "Innovation",
  creative:   "Creative",
  data:       "Data",
  video:      "Video",
};

// Order in which themes appear in the daily brief. Categories not listed
// are appended afterwards in alphabetical order.
const CATEGORY_ORDER = [
  "culture", "trends", "fashion", "music", "film", "gaming", "art",
  "internet", "social", "community", "marketing", "brands", "sport",
];

// Words that don't carry topical signal and should be ignored when computing
// cross-source keyword overlap.
const STOPWORDS = new Set([
  "this","that","with","from","have","been","what","when","where","they",
  "their","them","said","about","more","than","into","over","also","just",
  "will","would","could","should","after","before","because","while","were",
  "your","yours","ours","once","some","most","many","much","very","such",
  "still","first","last","next","year","week","month","day","days","says",
  "here","there","these","those","being","without","through","between",
  "another","other","every","each","both","again","like","only","even",
  "make","made","makes","take","takes","took","get","gets","got","goes",
  "going","gone","come","comes","came","know","known","new","old","best",
  "good","great","high","low","big","small","top","look","looks","looking",
  "back","front","up","down","right","left","really","actually","just",
  "want","wants","need","needs","says","say","told","see","seen","seeing",
  "een","het","een","een","van","voor","over","naar","door","met","door",
  "deze","dit","dat","wat","hoe","waar","welke","wordt","worden","heeft",
  "hebben","ook","maar","want","dus","echt","weer","altijd","nooit",
]);

// --- Helpers ---
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function within(hours, isoOrDate) {
  if (!isoOrDate) return false;
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return false;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
}

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categoryLabel(cat) {
  if (!cat) return "Other";
  return CATEGORY_LABELS[cat] || titleCase(cat);
}

// --- Fetch RSS ---
function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise(function (_, reject) {
    to = setTimeout(function () {
      reject(new Error("timed out after " + ms + "ms (" + label + ")"));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () { clearTimeout(to); });
}

async function fetchSource(parser, source) {
  try {
    const feed = await withTimeout(parser.parseURL(source.url), PER_SOURCE_TIMEOUT_MS, source.name);
    const items = (feed.items || [])
      .filter(function (i) { return within(LOOKBACK_HOURS, i.isoDate || i.pubDate); })
      .slice(0, MAX_ITEMS_PER_FEED)
      .map(function (i) {
        return {
          source: source.name,
          source_weight: typeof source.weight === "number" ? source.weight : 6,
          category: source.category || "other",
          title: stripHtml(i.title || ""),
          url: i.link || "",
          published: i.isoDate || i.pubDate || null,
          summary: truncate(stripHtml(i.contentSnippet || i.content || i.summary || ""), 280),
        };
      })
      .filter(function (i) { return i.title && i.url; });
    console.log("  ✓ " + source.name + ": " + items.length + " recent items");
    return items;
  } catch (err) {
    console.warn("  ✗ " + source.name + ": " + err.message);
    return [];
  }
}

// --- Dedupe ---
// Same URL or same normalised title across feeds — keep the first occurrence.
function dedupe(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const out = [];
  for (const it of items) {
    const urlKey = (it.url || "").split("#")[0].split("?")[0].toLowerCase();
    const titleKey = (it.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (urlKey && seenUrls.has(urlKey)) continue;
    if (titleKey && seenTitles.has(titleKey)) continue;
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    out.push(it);
  }
  return out;
}

// --- Scoring ---
// RSS doesn't expose read counts, so we score on a popularity proxy:
//   final = round( clamp(1..10, source*0.6 + recency + trending + 1) )
// where:
//   source   ∈ [1..10] — per-source weight from sources.json (default 6)
//   recency  ∈ [0..1.5] — fresher items score higher
//   trending ∈ [0..2.5] — overlap with other items' keywords (cross-source signal)
function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(function (t) { return t.length > 3 && !STOPWORDS.has(t); });
}

function scoreItems(items) {
  // Build a frequency table over title+summary tokens across all items.
  const tokenCount = new Map();
  const itemTokens = new Map();
  for (const it of items) {
    const tokens = new Set(tokenize((it.title || "") + " " + (it.summary || "")));
    itemTokens.set(it, tokens);
    for (const t of tokens) {
      tokenCount.set(t, (tokenCount.get(t) || 0) + 1);
    }
  }

  const now = Date.now();
  const maxAgeHours = Math.max(1, LOOKBACK_HOURS);

  for (const it of items) {
    const sourceWeight = typeof it.source_weight === "number" ? it.source_weight : 6;

    // Recency 0..1.5
    let recency = 0;
    if (it.published) {
      const ageMs = now - new Date(it.published).getTime();
      const ageHours = Math.max(0, ageMs / (1000 * 60 * 60));
      recency = Math.max(0, 1.5 * (1 - Math.min(1, ageHours / maxAgeHours)));
    }

    // Trending 0..2.5 — count tokens that appear in 2+ items overall.
    let trending = 0;
    const tokens = itemTokens.get(it) || new Set();
    let shared = 0;
    let strong = 0;
    for (const t of tokens) {
      const cnt = tokenCount.get(t) || 0;
      if (cnt >= 2) shared++;
      if (cnt >= 4) strong++;
    }
    trending = Math.min(2.5, shared * 0.25 + strong * 0.5);

    const raw = sourceWeight * 0.6 + recency + trending + 1;
    const score = Math.max(1, Math.min(10, Math.round(raw)));
    it.score = score;

    // Strip the helper field — we don't want it in the public JSON.
    delete it.source_weight;
  }
}

// --- Group by category ---
function groupByCategory(items) {
  const groups = {};
  for (const it of items) {
    const cat = it.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  }

  // Sort items inside each group: highest score first, then newest, then title.
  for (const cat of Object.keys(groups)) {
    groups[cat].sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (a.title || "").localeCompare(b.title || "");
    });
    // Cap to top N per category.
    if (groups[cat].length > MAX_ITEMS_PER_CATEGORY) {
      groups[cat] = groups[cat].slice(0, MAX_ITEMS_PER_CATEGORY);
    }
  }

  // Order categories: configured order first, then any remainder alphabetically.
  const remaining = Object.keys(groups)
    .filter(function (c) { return CATEGORY_ORDER.indexOf(c) === -1; })
    .sort();
  const ordered = CATEGORY_ORDER.filter(function (c) { return groups[c]; }).concat(remaining);

  return ordered.map(function (cat) {
    return {
      title: categoryLabel(cat),
      summary: "",
      items: groups[cat],
    };
  });
}

// --- Archive index ---
function updateArchiveIndex(date) {
  let entries = [];
  if (fs.existsSync(ARCHIVE_INDEX_PATH)) {
    try { entries = readJSON(ARCHIVE_INDEX_PATH); } catch (e) { entries = []; }
  }
  if (!entries.includes(date)) entries.push(date);
  entries.sort(function (a, b) { return b.localeCompare(a); });
  writeJSON(ARCHIVE_INDEX_PATH, entries);
}

// --- Main ---
async function main() {
  console.log("Culture Tracker — fetch (RSS-only)");
  console.log("Date: " + todayISO());

  ensureDir(DATA_DIR);
  ensureDir(ARCHIVE_DIR);

  const sources = readJSON(SOURCES_PATH);
  console.log("Loaded " + sources.length + " sources.");

  const parser = new Parser({ timeout: 10000 });

  // Fetch all RSS sources in parallel. One slow feed no longer holds up the
  // others, and total wall time is bounded by PER_SOURCE_TIMEOUT_MS.
  const rssSources = sources.filter(function (s) { return s.type === "rss"; });
  sources.filter(function (s) { return s.type !== "rss"; }).forEach(function (s) {
    console.warn("  · " + s.name + ": skipped (type '" + s.type + "', only 'rss' is supported)");
  });

  console.log("Fetching " + rssSources.length + " RSS sources in parallel (timeout: " + PER_SOURCE_TIMEOUT_MS + "ms each)…");
  const t0 = Date.now();
  const results = await Promise.all(rssSources.map(function (s) { return fetchSource(parser, s); }));
  console.log("Fetch round-trip: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  let allItems = [];
  let usedSources = 0;
  results.forEach(function (items) {
    if (items.length) usedSources++;
    allItems = allItems.concat(items);
  });

  console.log("Total items in window: " + allItems.length);
  if (allItems.length === 0) {
    console.error("No items fetched. Aborting (will not overwrite latest.json).");
    process.exit(1);
  }

  const before = allItems.length;
  allItems = dedupe(allItems);
  if (allItems.length !== before) {
    console.log("Deduped: " + before + " → " + allItems.length);
  }

  // Score every item, then group + cap to top MAX_ITEMS_PER_CATEGORY per topic.
  scoreItems(allItems);

  const themes = groupByCategory(allItems);
  const totalShown = themes.reduce(function (sum, t) { return sum + t.items.length; }, 0);
  const date = todayISO();

  const intro = "Top " + MAX_ITEMS_PER_CATEGORY + " per topic — " + totalShown +
    " articles from " + usedSources + " sources across " + themes.length +
    (themes.length === 1 ? " category" : " categories") +
    ", last " + LOOKBACK_HOURS + " hours.";

  // weekly_hypes / monthly_trends are intentionally omitted — those layers
  // needed AI synthesis and the UI no longer surfaces them.
  const brief = {
    date: date,
    daily: {
      title: "Culture Brief",
      intro: intro,
      themes: themes,
    },
  };

  const archivePath = path.join(ARCHIVE_DIR, date + ".json");
  writeJSON(archivePath, brief);
  writeJSON(LATEST_PATH, brief);
  updateArchiveIndex(date);

  console.log("✓ Wrote " + archivePath);
  console.log("✓ Wrote " + LATEST_PATH);
  console.log("✓ Updated " + ARCHIVE_INDEX_PATH);
}

main().catch(function (err) {
  console.error("Fatal:", err);
  process.exit(1);
});
