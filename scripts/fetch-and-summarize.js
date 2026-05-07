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
 *   MAX_ITEMS_PER_CATEGORY   (default: 6)
 *   VELOCITY_WINDOW_HOURS    (default: 6)  — items this fresh get a velocity bonus if cross-source
 *
 * Dependencies:
 *   - rss-parser — robust RSS/Atom parsing.
 */

"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const Parser = require("rss-parser");

// --- Paths ---
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "config", "sources.json");
const DATA_DIR = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
// latest-raw.json = output van fetch (geen AI). ai-synthesize.js leest dit
// en schrijft het AI-verrijkte latest.json + archief.
const RAW_PATH    = path.join(DATA_DIR, "latest-raw.json");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");   // fallback voor als synthesis nog niet gedraaid heeft
const ARCHIVE_INDEX_PATH = path.join(ARCHIVE_DIR, "index.json");

// --- Config ---
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || "24", 10);
const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || "10", 10);
const MAX_ITEMS_PER_CATEGORY = parseInt(process.env.MAX_ITEMS_PER_CATEGORY || "6", 10);
// Hard cap on a single fetch. We use both a socket-level timeout (in the parser)
// AND a Promise.race wrapper so slow-dripping feeds can never block the run.
// 8 s is plenty for well-behaved feeds; anything slower is not worth waiting for.
const PER_SOURCE_TIMEOUT_MS = parseInt(process.env.PER_SOURCE_TIMEOUT_MS || "5000", 10);
// Items published within this window get a velocity bonus when they also have
// cross-source keyword overlap — signal that something is blowing up right now.
const VELOCITY_WINDOW_HOURS = parseInt(process.env.VELOCITY_WINDOW_HOURS || "6", 10);
// Maximum number of topic clusters to surface in the daily brief.
// After clustering and scoring, only the top N most culturally relevant topics
// (= highest cross-source coverage + item density + trending signal) are kept.
const MAX_TOPICS = parseInt(process.env.MAX_TOPICS || "10", 10);

// Human-readable labels for category buckets in the brief.
// Anything not in this map falls back to a Title-Cased version of the category key.
const CATEGORY_LABELS = {
  music:      "Muziek",
  fashion:    "Fashion",
  film:       "Film & TV",
  internet:   "Internet",
  sport:      "Sport",
  gaming:     "Gaming",
  art:        "Art & Design",
  brands:     "Brands",
  social:     "Social",
  marketing:  "Marketing",
  culture:    "Cultuur",
  trends:     "Trends",
  lokaal:     "Lokaal",
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
  // Domain-specific generic words — too broad to signal a real topic
  "music","fashion","gaming","culture","design","brands","media","series",
  "season","album","films","games","shows","trend","trends","report",
  "podcast","interview","review","release","debut","launch","announce",
  "feature","story","style","looks","brand","video","watch","reads",
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

// --- Helpers ---
function formatNumber(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
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

// --- Fetch Wikipedia Trending ---
// Uses the Wikimedia Pageviews API to get yesterday's most-viewed articles.
// No API key required. Returns cultural articles filtered from utility pages.
const WIKI_SKIP_PREFIXES = [
  "Wikipedia:", "Bestand:", "Portal:", "Gebruiker:", "Overleg:", "Help:",
  "Sjabloon:", "Categorie:", "Special:", "File:", "Template:", "Category:",
  "User:", "Talk:", "Project:",
];
const WIKI_SKIP_REGEX = /^(Hoofdpagina|Main_Page|Lijst_van|Index_van|Wikimedia|MediaWiki|\d{4}$)/;

async function fetchWikipediaTrending(source) {
  const d = new Date();
  d.setDate(d.getDate() - 1); // gebruik gisteren (vandaag is nog niet compleet)
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  const lang = source.language || "nl";
  const limit = Math.min(source.limit || 25, MAX_ITEMS_PER_FEED * 3);
  const url = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/" +
    lang + ".wikipedia.org/all-access/" + yyyy + "/" + mm + "/" + dd;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, PER_SOURCE_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      console.warn("  ✗ " + source.name + ": HTTP " + res.status);
      return [];
    }

    const json   = await res.json();
    const arts   = (json.items && json.items[0] && json.items[0].articles) || [];
    const now    = new Date().toISOString();

    const items = arts
      .filter(function (a) {
        const name = a.article || "";
        if (WIKI_SKIP_REGEX.test(name)) return false;
        if (WIKI_SKIP_PREFIXES.some(function (p) { return name.startsWith(p); })) return false;
        return true;
      })
      .slice(0, limit)
      .map(function (a) {
        const title = a.article.replace(/_/g, " ");
        const views = a.views ? a.views.toLocaleString("nl-BE") : "?";
        return {
          source:        source.name,
          source_weight: source.weight || 9,
          category:      source.category || "trends",
          title:         title,
          url:           "https://" + lang + ".wikipedia.org/wiki/" + a.article,
          published:     now,
          summary:       views + " views op " + lang + ".wikipedia — rang #" + a.rank + ".",
        };
      });

    console.log("  ✓ " + source.name + ": " + items.length + " trending artikels");
    return items;
  } catch (err) {
    console.warn("  ✗ " + source.name + ": " + err.message);
    return [];
  }
}

// --- Fetch TikTok Trends ---
// Uses the TikTok Creative Center API for trending hashtags.
// No API key required, but TikTok may return 4xx if they tighten access.
// Endpoint: https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list
async function fetchTikTokTrends(source) {
  const countryCode = source.country_code || "US";
  const period = source.period || 7;
  const limit = Math.min(source.limit || 20, MAX_ITEMS_PER_FEED);

  const url = source.url +
    "?period=" + period +
    "&page=1" +
    "&limit=" + limit +
    "&country_code=" + countryCode +
    "&language=en";

  try {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, PER_SOURCE_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://ads.tiktok.com/business/creativecenter/trends/hashtag/pc/en",
        "Origin": "https://ads.tiktok.com",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      console.warn("  ✗ " + source.name + ": HTTP " + res.status + " from TikTok Creative Center");
      return [];
    }

    const json = await res.json();

    if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.list)) {
      console.warn("  ✗ " + source.name + ": unexpected response (code=" + (json && json.code) + ")");
      return [];
    }

    const now = new Date().toISOString();
    const items = json.data.list
      .slice(0, MAX_ITEMS_PER_FEED)
      .map(function (h) {
        const tag = h.hashtag_name || h.hashtag || "";
        const posts = h.publish_cnt ? formatNumber(h.publish_cnt) + " posts" : "";
        const views = h.video_views ? formatNumber(h.video_views) + " views" : "";
        const trend = h.trend ? "Trending: " + h.trend : "";
        const parts = [posts, views, trend].filter(Boolean).join(" · ");

        return {
          source: source.name,
          source_weight: typeof source.weight === "number" ? source.weight : 6,
          category: source.category || "trends",
          title: "#" + tag,
          url: "https://www.tiktok.com/tag/" + encodeURIComponent(tag),
          published: now,
          summary: parts || ("Trending TikTok hashtag in " + countryCode + "."),
        };
      })
      .filter(function (i) { return i.title && i.title.length > 1; });

    console.log("  ✓ " + source.name + ": " + items.length + " trending hashtags (country=" + countryCode + ")");
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
//
//   final = round( clamp(1..10, source*0.6 + recency + trending + velocity + 1) )
//
// Components:
//   source   ∈ [1..10]  — per-source weight from sources.json (default 6)
//   recency  ∈ [0..1.5] — fresher items score higher within the lookback window
//   trending ∈ [0..2.5] — cross-source keyword overlap: how many other items
//                          discuss the same topic (≥3 items → "shared", ≥5 → "strong")
//   velocity ∈ [0..1.0] — bonus for items < VELOCITY_WINDOW_HOURS old that are
//                          already showing cross-source overlap; signals something
//                          blowing up *right now* vs. just popular yesterday
//
// Items with trending > 1.0 are flagged `trending: true` so the UI can highlight them.
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
  const velocityWindowMs = VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;

  for (const it of items) {
    const sourceWeight = typeof it.source_weight === "number" ? it.source_weight : 6;

    // Recency 0..1.5 — linear decay over the full lookback window.
    let recency = 0;
    let ageHours = maxAgeHours;
    if (it.published) {
      const ageMs = now - new Date(it.published).getTime();
      ageHours = Math.max(0, ageMs / (1000 * 60 * 60));
      recency = Math.max(0, 1.5 * (1 - Math.min(1, ageHours / maxAgeHours)));
    }

    // Trending 0..2.5 — tokens that appear in ≥3 items = "shared", ≥5 = "strong".
    // Raised from ≥2/≥4 to filter out coincidental single-word overlaps.
    const tokens = itemTokens.get(it) || new Set();
    let shared = 0;
    let strong = 0;
    for (const t of tokens) {
      const cnt = tokenCount.get(t) || 0;
      if (cnt >= 3) shared++;
      if (cnt >= 5) strong++;
    }
    const trending = Math.min(2.5, shared * 0.3 + strong * 0.6);

    // Velocity 0..1.0 — extra reward for items that are both fresh AND already
    // showing cross-source overlap. This surfaces things exploding right now.
    const isVelocityWindow = it.published &&
      (now - new Date(it.published).getTime()) <= velocityWindowMs;
    const velocity = (isVelocityWindow && shared >= 2) ? Math.min(1.0, shared * 0.2) : 0;

    const raw = sourceWeight * 0.6 + recency + trending + velocity + 1;
    const score = Math.max(1, Math.min(10, Math.round(raw)));
    it.score = score;

    // Flag items with meaningful cross-source momentum so the UI can highlight them.
    if (trending > 1.0) it.trending = true;

    // Strip the helper field — we don't want it in the public JSON.
    delete it.source_weight;
  }
}

// --- Cluster by topic ---
// Groups items into trending topic clusters based on cross-source keyword overlap.
// Only clusters whose articles come from ≥2 different sources are surfaced.
// Items that don't fit any cross-source topic are silently discarded — they're
// not trending, just recent.
//
// Algorithm:
//   1. Tokenize every article title → build keyword→{items,sources} maps
//   2. Hot keywords = appear in ≥2 sources AND cover ≤30% of all items (not generic)
//   3. Score keywords: sourceCount*4 + itemCount + velocity bonus
//   4. Greedy assign: process keywords best-first; each article assigned once
//   5. Name each cluster by its top 2 most-frequent title tokens
//   6. Sort clusters by source count desc
const MAX_ITEMS_PER_TOPIC = parseInt(process.env.MAX_ITEMS_PER_TOPIC || "8", 10);

function clusterByTopic(items) {
  const now = Date.now();
  const velocityWindowMs = VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;
  const totalItems = items.length;

  // 1. Tokenize titles; build keyword maps.
  const itemTitleTokens = new Map(); // item → Set<token>  (title only, for naming)
  const kwToItems   = new Map();     // token → [item]
  const kwToSources = new Map();     // token → Set<sourceName>

  for (const it of items) {
    const tokens = new Set(tokenize(it.title || ""));
    itemTitleTokens.set(it, tokens);
    for (const t of tokens) {
      if (!kwToItems.has(t))   kwToItems.set(t, []);
      if (!kwToSources.has(t)) kwToSources.set(t, new Set());
      kwToItems.get(t).push(it);
      kwToSources.get(t).add(it.source);
    }
  }

  // 2. Score and filter keywords → candidates.
  const candidates = [];
  for (const [kw, sources] of kwToSources) {
    if (sources.size < 2) continue;                        // must span ≥2 sources
    const kwItems = kwToItems.get(kw);
    if (kwItems.length / totalItems > 0.30) continue;     // too generic (>30% coverage)

    const freshCount = kwItems.filter(function (i) {
      return i.published && (now - new Date(i.published).getTime()) <= velocityWindowMs;
    }).length;

    const score = sources.size * 4 + kwItems.length + (freshCount > 0 ? 1.5 : 0);
    candidates.push({ kw, sources, items: kwItems, score });
  }

  candidates.sort(function (a, b) { return b.score - a.score; });

  // 3. Greedy clustering — each article assigned to its highest-scoring keyword.
  const assignedItems = new Set();
  const rawClusters   = [];

  for (const cand of candidates) {
    const unassigned = cand.items.filter(function (i) { return !assignedItems.has(i); });
    if (unassigned.length === 0) continue;

    const remainingSources = new Set(unassigned.map(function (i) { return i.source; }));
    if (remainingSources.size < 2) continue; // lost multi-source property after assignment

    for (const it of unassigned) assignedItems.add(it);
    rawClusters.push({ seedKw: cand.kw, items: unassigned, sources: remainingSources });

    if (rawClusters.length >= 25) break;
  }

  // 4. Coherence filter — remove articles that don't share ≥1 title token
  //    with at least half of the other cluster members. This weeds out articles
  //    that landed in a cluster only because of an incidental keyword match
  //    (e.g. "apple" in a tech story and a food story).
  function filterCoherent(clItems) {
    if (clItems.length <= 2) return clItems;
    const tokSets = clItems.map(function (it) {
      return new Set(tokenize(it.title || ""));
    });
    return clItems.filter(function (it, idx) {
      var myToks = tokSets[idx];
      var threshold = Math.ceil((clItems.length - 1) / 2);
      var matches = 0;
      for (var j = 0; j < clItems.length; j++) {
        if (j === idx) continue;
        var other = tokSets[j];
        var shared = false;
        myToks.forEach(function (t) { if (other.has(t)) shared = true; });
        if (shared) matches++;
      }
      return matches >= threshold;
    });
  }

  // 5. Name each cluster and format output.
  return rawClusters.map(function (cluster) {
    // Re-run coherence filter on this cluster's articles
    var coherent = filterCoherent(cluster.items);
    // Re-check: must still span ≥2 sources after filtering
    var coherentSources = new Set(coherent.map(function (i) { return i.source; }));
    if (coherentSources.size < 2) return null;
    cluster.items   = coherent;
    cluster.sources = coherentSources;
    const clItems = cluster.items;
    const clSrcs  = cluster.sources;

    // Count title-token frequency within this cluster.
    const titleTokenFreq = new Map();
    for (const it of clItems) {
      const tt = itemTitleTokens.get(it) || new Set();
      for (const t of tt) titleTokenFreq.set(t, (titleTokenFreq.get(t) || 0) + 1);
    }

    // Top 2 tokens by frequency = cluster label.
    const topTokens = Array.from(titleTokenFreq.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 2)
      .map(function (pair) {
        const t = pair[0];
        return t.charAt(0).toUpperCase() + t.slice(1);
      });

    const label = topTokens.length > 0
      ? topTokens.join(" · ")
      : cluster.seedKw.charAt(0).toUpperCase() + cluster.seedKw.slice(1);

    const categories = Array.from(
      new Set(clItems.map(function (i) { return i.category; }).filter(Boolean))
    );

    // Sort items: highest score first, then most recent.
    clItems.sort(function (a, b) {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      return tb - ta;
    });

    const trending = clSrcs.size >= 3;
    const fresh    = clItems.some(function (i) {
      return i.published && (now - new Date(i.published).getTime()) <= velocityWindowMs;
    });

    return {
      label:       label,
      keywords:    topTokens.map(function (t) { return t.toLowerCase(); }),
      sourceCount: clSrcs.size,
      sources:     Array.from(clSrcs).sort(),
      categories:  categories,
      trending:    trending,
      fresh:       fresh,
      items:       clItems.slice(0, MAX_ITEMS_PER_TOPIC),
    };
  }).filter(Boolean).sort(function (a, b) {
    // Cultural relevance score:
    //   sourceCount × 5  — cross-source breadth is the strongest signal
    //   + avg item score  — authority/recency/trending of constituent articles
    //   + trending bonus  — 3+ sources = confirmed multi-outlet story
    //   + fresh bonus     — something blowing up right now
    function topicScore(t) {
      const avgScore = t.items.length
        ? t.items.reduce(function (s, i) { return s + (i.score || 0); }, 0) / t.items.length
        : 0;
      return t.sourceCount * 5 + avgScore * 1.5 + (t.trending ? 4 : 0) + (t.fresh ? 2 : 0);
    }
    return topicScore(b) - topicScore(a);
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

  // Default parser — includes a browser-like User-Agent so sites that block
  // bots (e.g. Marketing Week, Trend Hunter) are more likely to respond.
  // requestOptions.timeout sets the socket-level inactivity timeout so slow-
  // dripping feeds (ones that send data byte-by-byte) are killed too, not just
  // stalled connections. The outer withTimeout() wrapper covers the full wall time.
  const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const parserOpts = {
    timeout: PER_SOURCE_TIMEOUT_MS - 1000,
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    requestOptions: {
      timeout: PER_SOURCE_TIMEOUT_MS - 1000,
    },
  };
  const parser = new Parser(parserOpts);

  // SSL-permissive parser — used only for sources that set skipSslVerify:true
  // (e.g. Eye on Design whose intermediate cert is missing server-side).
  const sslParser = new Parser(Object.assign({}, parserOpts, {
    requestOptions: {
      timeout: PER_SOURCE_TIMEOUT_MS - 1000,
      agent: new https.Agent({ rejectUnauthorized: false }),
    },
  }));

  // Fetch all RSS sources in parallel. One slow feed no longer holds up the
  // others, and total wall time is bounded by PER_SOURCE_TIMEOUT_MS.
  const rssSources     = sources.filter(function (s) { return s.type === "rss"; });
  const tiktokSources  = sources.filter(function (s) { return s.type === "tiktok-trends"; });
  const wikiSources    = sources.filter(function (s) { return s.type === "wikipedia-trending"; });
  sources.filter(function (s) {
    return s.type !== "rss" && s.type !== "tiktok-trends" && s.type !== "wikipedia-trending";
  }).forEach(function (s) {
    console.warn("  · " + s.name + ": skipped (type '" + s.type + "')");
  });

  console.log("Fetching " + rssSources.length + " RSS + " + wikiSources.length +
    " Wikipedia + " + tiktokSources.length + " TikTok sources in parallel…");
  const t0 = Date.now();
  const [rssResults, tiktokResults, wikiResults] = await Promise.all([
    Promise.all(rssSources.map(function (s) {
      return fetchSource(s.skipSslVerify ? sslParser : parser, s);
    })),
    Promise.all(tiktokSources.map(function (s) { return fetchTikTokTrends(s); })),
    Promise.all(wikiSources.map(function (s) { return fetchWikipediaTrending(s); })),
  ]);
  const results = rssResults.concat(tiktokResults).concat(wikiResults);
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

  // Score every item first, then cluster into cross-source topics.
  scoreItems(allItems);

  const topics = clusterByTopic(allItems).slice(0, MAX_TOPICS);
  const totalShown  = topics.reduce(function (sum, t) { return sum + t.items.length; }, 0);
  const hotTopics   = topics.filter(function (t) { return t.trending; }).length;
  const date = todayISO();

  const intro = "Top " + topics.length + " culturele topics" +
    " · " + totalShown + " artikels van " + usedSources + " bronnen" +
    (hotTopics > 0 ? " · " + hotTopics + " door 3+ bronnen" : "") +
    " · laatste " + LOOKBACK_HOURS + "u.";

  const brief = {
    date: date,
    daily: {
      title: "Culture Tracker",
      intro: intro,
      topics: topics,
    },
  };

  // Write raw data for ai-synthesize.js to consume.
  // Also write latest.json as a raw fallback (overwritten by synthesis when it runs).
  ensureDir(DATA_DIR);
  ensureDir(ARCHIVE_DIR);
  writeJSON(RAW_PATH, brief);
  writeJSON(LATEST_PATH, brief);
  updateArchiveIndex(date);

  console.log("✓ Schreef " + RAW_PATH + " (" + topics.length + " topics)");
  console.log("✓ Schreef " + LATEST_PATH);
  console.log("✓ Updated " + ARCHIVE_INDEX_PATH);
  // Bevestig dat het bestand echt bestaat (diagnose voor CI-omgeving)
  console.log("  Bestand bestaat: " + fs.existsSync(RAW_PATH));
}

// Force exit zodat hangende HTTP-sockets (chunked feeds die nooit afsluiten)
// de Node.js event loop niet blokkeren na afloop van het script.
main().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error("Fatal:", err);
  process.exit(1);
});
