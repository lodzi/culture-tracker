#!/usr/bin/env node
/**
 * Culture Tracker — fetch & group (RSS-only, no LLM).
 *
 * 1. Reads /config/sources.json
 * 2. Fetches each RSS feed and keeps items from the last LOOKBACK_HOURS
 * 3. Dedupes by URL and (case-insensitive) title
 * 4. Groups items by category and sorts newest-first within each category
 * 5. Writes /data/archive/YYYY-MM-DD.json and /data/latest.json
 * 6. Maintains /data/archive/index.json for the frontend
 *
 * No API keys required. No external services beyond the RSS feeds themselves.
 *
 * Optional env:
 *   LOOKBACK_HOURS     (default: 24)
 *   MAX_ITEMS_PER_FEED (default: 10)
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
async function fetchSource(parser, source) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = (feed.items || [])
      .filter(function (i) { return within(LOOKBACK_HOURS, i.isoDate || i.pubDate); })
      .slice(0, MAX_ITEMS_PER_FEED)
      .map(function (i) {
        return {
          source: source.name,
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

// --- Group by category ---
function groupByCategory(items) {
  const groups = {};
  for (const it of items) {
    const cat = it.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  }

  // Sort items inside each group: newest first, fallback to title.
  for (const cat of Object.keys(groups)) {
    groups[cat].sort(function (a, b) {
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (a.title || "").localeCompare(b.title || "");
    });
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

  const parser = new Parser({ timeout: 15000 });

  let allItems = [];
  let usedSources = 0;
  for (const source of sources) {
    if (source.type !== "rss") {
      console.warn("  · " + source.name + ": skipped (type '" + source.type + "', only 'rss' is supported)");
      continue;
    }
    const items = await fetchSource(parser, source);
    if (items.length) usedSources++;
    allItems = allItems.concat(items);
  }

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

  const themes = groupByCategory(allItems);
  const date = todayISO();

  const intro = allItems.length + " items from " + usedSources +
    " sources across " + themes.length +
    (themes.length === 1 ? " category" : " categories") +
    ", last " + LOOKBACK_HOURS + " hours.";

  // Same outer shape as the original LLM-driven brief, so the frontend and
  // email renderer keep working without changes. weekly_hypes / monthly_trends
  // are intentionally left empty — those layers needed AI synthesis.
  const brief = {
    date: date,
    daily: {
      title: "Culture Brief",
      intro: intro,
      themes: themes,
    },
    weekly_hypes: [],
    monthly_trends: [],
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
