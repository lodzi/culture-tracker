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

// --- Semantic clustering (Voyage AI embeddings) ---
// When VOYAGE_API_KEY is set, items are clustered by meaning (cosine similarity
// of their embeddings) instead of by raw keyword overlap. This fixes the old
// failure mode where unrelated articles sharing one token landed in the same
// "topic". If the key is absent or the API errors, we fall back to the keyword
// clustering automatically — the pipeline never hard-depends on embeddings.
const VOYAGE_API_KEY      = process.env.VOYAGE_API_KEY || "";
const VOYAGE_MODEL        = process.env.VOYAGE_MODEL || "voyage-3.5";
const VOYAGE_ENDPOINT     = "https://api.voyageai.com/v1/embeddings";
// Cosine-similarity threshold above which two items are considered the same topic.
// Tuned conservatively: 0.55 groups genuine same-story coverage without merging
// merely-related articles. Override via env when calibrating.
const EMBED_SIM_THRESHOLD = parseFloat(process.env.EMBED_SIM_THRESHOLD || "0.55");
const EMBED_BATCH         = parseInt(process.env.EMBED_BATCH || "128", 10);

// --- Engagement enrichment (real popularity signals) ---
// Reddit exposes upvotes/comments via its public JSON; Wikipedia exposes
// pageviews. Both feed a real "engagement" component in the score, replacing
// part of the keyword-overlap proxy. Enrichment is best-effort: any failure is
// logged and ignored so the brief still builds.
const ENABLE_REDDIT_ENGAGEMENT = (process.env.ENABLE_REDDIT_ENGAGEMENT || "true") !== "false";

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

// Browser-like User-Agent — used in both the RSS parser and the Wikipedia fetch.
// Defined at module scope so all functions can access it.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
          // Real engagement signal: actual pageviews from the Wikimedia API.
          engagement:    typeof a.views === "number" ? a.views : 0,
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
          // Real engagement signal: video views (or post count as fallback).
          engagement: (typeof h.video_views === "number" ? h.video_views : 0) ||
                      (typeof h.publish_cnt === "number" ? h.publish_cnt : 0),
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

// --- Reddit engagement enrichment ---
// Reddit RSS gives us article links but no scores. The public JSON listing does.
// For every subreddit we already pulled items from, we fetch its hot listing ONCE
// and attach real upvotes/comments (`engagement`) to the matching items by post id.
// Best-effort: if Reddit blocks the request (it often rate-limits datacenter IPs),
// we log and move on — items simply keep engagement 0.
function redditPostId(url) {
  // https://www.reddit.com/r/sub/comments/<id>/slug/ → "<id>"
  const m = String(url || "").match(/\/comments\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}
function subredditOf(url) {
  const m = String(url || "").match(/reddit\.com\/(r\/[^/]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function enrichRedditEngagement(items) {
  if (!ENABLE_REDDIT_ENGAGEMENT) return;
  // Group reddit items by subreddit.
  const bySub = new Map();
  for (const it of items) {
    const sub = subredditOf(it.url);
    if (!sub) continue;
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(it);
  }
  if (bySub.size === 0) return;

  let enriched = 0;
  await Promise.all(Array.from(bySub.keys()).map(async function (sub) {
    const url = "https://www.reddit.com/" + sub + "/hot.json?limit=75&raw_json=1";
    try {
      const ctrl = new AbortController();
      const t = setTimeout(function () { ctrl.abort(); }, PER_SOURCE_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) { console.warn("  · reddit engagement " + sub + ": HTTP " + res.status); return; }
      const json = await res.json();
      const children = (json && json.data && json.data.children) || [];
      const scoreById = new Map();
      for (const c of children) {
        const d = c.data || {};
        if (d.id) scoreById.set(d.id, { ups: d.ups || d.score || 0, comments: d.num_comments || 0 });
      }
      for (const it of bySub.get(sub)) {
        const id = redditPostId(it.url);
        const hit = id && scoreById.get(id);
        if (hit) {
          // Weight upvotes plus a smaller weight for comments (discussion depth).
          it.engagement = (hit.ups || 0) + (hit.comments || 0) * 2;
          enriched++;
        }
      }
    } catch (err) {
      console.warn("  · reddit engagement " + sub + ": " + err.message);
    }
  }));
  if (enriched > 0) console.log("  ✓ Reddit engagement toegevoegd aan " + enriched + " items");
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

  // Engagement is log-scaled and normalised to the run's maximum so that
  // Reddit upvotes (~10^3), Wikipedia views (~10^6) and TikTok views (~10^9)
  // become comparable instead of one platform dominating.
  let maxLogEng = 0;
  for (const it of items) {
    const e = typeof it.engagement === "number" ? it.engagement : 0;
    if (e > 0) maxLogEng = Math.max(maxLogEng, Math.log10(e + 1));
  }

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

    // Engagement 0..2.0 — real popularity where we have it, normalised per run.
    let engagement = 0;
    if (maxLogEng > 0 && typeof it.engagement === "number" && it.engagement > 0) {
      engagement = Math.min(2.0, 2.0 * (Math.log10(it.engagement + 1) / maxLogEng));
    }

    const raw = sourceWeight * 0.6 + recency + trending + velocity + engagement + 1;
    const score = Math.max(1, Math.min(10, Math.round(raw)));
    it.score = score;

    // Flag items with meaningful cross-source momentum so the UI can highlight them.
    if (trending > 1.0) it.trending = true;

    // Strip the helper field — we don't want it in the public JSON.
    delete it.source_weight;
  }
}

// --- Cluster by topic ---
// Two strategies share one output format (`finalizeClusters`):
//   • clusterByEmbeddings — semantic, via Voyage. Preferred when VOYAGE_API_KEY
//     is set. Groups articles that are actually *about the same thing*.
//   • clusterByTopic — keyword-overlap fallback. Used when embeddings are
//     unavailable or error out.
// In both cases a cluster only survives if it spans ≥2 independent sources, and
// each cluster carries a `primaryCategory` (its dominant category) so the daily
// synthesis can group it once instead of smearing it across every category.
const MAX_ITEMS_PER_TOPIC = parseInt(process.env.MAX_ITEMS_PER_TOPIC || "8", 10);

// --- Vector helpers ---
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
function meanVec(vecs) {
  const d = vecs[0].length;
  const m = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i++) m[i] += v[i];
  for (let i = 0; i < d; i++) m[i] /= vecs.length;
  return m;
}

// --- Voyage embeddings ---
// Returns one embedding vector per text, or null on any failure so the caller
// can fall back to keyword clustering. Batched to respect payload limits.
async function embedTexts(texts) {
  if (!VOYAGE_API_KEY) return null;
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH);
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, 20000);
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": "Bearer " + VOYAGE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ input: slice, model: VOYAGE_MODEL, input_type: "document" }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error("Voyage HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
    const json = await res.json();
    for (const d of (json.data || [])) out[i + d.index] = d.embedding;
  }
  return out;
}

// --- Shared cluster finalizer ---
// Input: array of { items: [...] }. Names each cluster, computes its sources,
// categories, primaryCategory and trending/fresh flags, sorts member items,
// drops clusters that don't span ≥2 sources, and ranks by cultural relevance.
function finalizeClusters(clusters) {
  const now = Date.now();
  const velocityWindowMs = VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;

  const formatted = clusters.map(function (cluster) {
    const clItems = cluster.items || [];
    const clSrcs = new Set(clItems.map(function (i) { return i.source; }).filter(Boolean));
    if (clSrcs.size < 2) return null; // a "trend" needs ≥2 independent sources

    // Name the cluster by its two most frequent title tokens.
    const titleTokenFreq = new Map();
    for (const it of clItems) {
      for (const tk of new Set(tokenize(it.title || ""))) {
        titleTokenFreq.set(tk, (titleTokenFreq.get(tk) || 0) + 1);
      }
    }
    const topTokens = Array.from(titleTokenFreq.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 2)
      .map(function (p) { return p[0].charAt(0).toUpperCase() + p[0].slice(1); });
    const label = topTokens.length
      ? topTokens.join(" · ")
      : ((clItems[0] && clItems[0].title) || "Topic").slice(0, 48);

    // Category frequency → keep the full list, but mark the dominant one.
    const catFreq = new Map();
    for (const it of clItems) {
      if (it.category) catFreq.set(it.category, (catFreq.get(it.category) || 0) + 1);
    }
    const categories = Array.from(catFreq.keys());
    const primaryCategory = Array.from(catFreq.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (p) { return p[0]; })[0] || null;

    // Sort items: highest score first, then most recent.
    clItems.sort(function (a, b) {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      return tb - ta;
    });

    const trending = clSrcs.size >= 3;
    const fresh = clItems.some(function (i) {
      return i.published && (now - new Date(i.published).getTime()) <= velocityWindowMs;
    });

    return {
      label:           label,
      keywords:        topTokens.map(function (t) { return t.toLowerCase(); }),
      sourceCount:     clSrcs.size,
      sources:         Array.from(clSrcs).sort(),
      categories:      categories,
      primaryCategory: primaryCategory,
      trending:        trending,
      fresh:           fresh,
      items:           clItems.slice(0, MAX_ITEMS_PER_TOPIC),
    };
  }).filter(Boolean);

  // Cultural relevance ranking:
  //   sourceCount × 5  — cross-source breadth is the strongest signal
  //   + avg item score — authority/recency/trending/engagement of articles
  //   + trending bonus — 3+ sources = confirmed multi-outlet story
  //   + fresh bonus    — something blowing up right now
  return formatted.sort(function (a, b) {
    function topicScore(t) {
      const avgScore = t.items.length
        ? t.items.reduce(function (s, i) { return s + (i.score || 0); }, 0) / t.items.length
        : 0;
      return t.sourceCount * 5 + avgScore * 1.5 + (t.trending ? 4 : 0) + (t.fresh ? 2 : 0);
    }
    return topicScore(b) - topicScore(a);
  });
}

// --- Semantic clustering via embeddings (preferred) ---
// Greedy online clustering: process items strongest-first; attach each to the
// most-similar existing cluster above EMBED_SIM_THRESHOLD, else open a new one.
// Returns finalized clusters, or null if embeddings are unavailable.
async function clusterByEmbeddings(items) {
  const texts = items.map(function (it) {
    return (it.title || "") + (it.summary ? ". " + it.summary : "");
  });
  let embs;
  try {
    embs = await embedTexts(texts);
  } catch (err) {
    console.warn("  Voyage embeddings mislukt (" + err.message + ") — fallback naar keyword-clustering.");
    return null;
  }
  if (!embs) return null;

  // Seed clusters with the strongest items first to stabilise assignment order.
  const order = items.map(function (_, i) { return i; })
    .sort(function (a, b) { return (items[b].score || 0) - (items[a].score || 0); });

  const clusters = []; // { centroid, embs:[], items:[] }
  for (const i of order) {
    const e = embs[i];
    if (!e) continue;
    let best = -1, bestSim = 0;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(e, clusters[c].centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best >= 0 && bestSim >= EMBED_SIM_THRESHOLD) {
      clusters[best].items.push(items[i]);
      clusters[best].embs.push(e);
      clusters[best].centroid = meanVec(clusters[best].embs);
    } else {
      clusters.push({ centroid: e.slice(), embs: [e], items: [items[i]] });
    }
  }

  return finalizeClusters(clusters);
}

// --- Keyword clustering (fallback) ---
// Groups items by cross-source title-keyword overlap. Only clusters spanning
// ≥2 sources survive; a coherence filter drops incidental keyword collisions.
function clusterByTopic(items) {
  const now = Date.now();
  const velocityWindowMs = VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;
  const totalItems = items.length;

  const kwToItems   = new Map(); // token → [item]
  const kwToSources = new Map(); // token → Set<sourceName>
  for (const it of items) {
    for (const t of new Set(tokenize(it.title || ""))) {
      if (!kwToItems.has(t))   kwToItems.set(t, []);
      if (!kwToSources.has(t)) kwToSources.set(t, new Set());
      kwToItems.get(t).push(it);
      kwToSources.get(t).add(it.source);
    }
  }

  const candidates = [];
  for (const [kw, sources] of kwToSources) {
    if (sources.size < 2) continue;                    // must span ≥2 sources
    const kwItems = kwToItems.get(kw);
    if (kwItems.length / totalItems > 0.30) continue;  // too generic (>30% coverage)
    const freshCount = kwItems.filter(function (i) {
      return i.published && (now - new Date(i.published).getTime()) <= velocityWindowMs;
    }).length;
    const score = sources.size * 4 + kwItems.length + (freshCount > 0 ? 1.5 : 0);
    candidates.push({ kw, items: kwItems, score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });

  // Greedy assignment — each article goes to its highest-scoring keyword once.
  const assignedItems = new Set();
  const rawClusters   = [];
  for (const cand of candidates) {
    const unassigned = cand.items.filter(function (i) { return !assignedItems.has(i); });
    if (unassigned.length === 0) continue;
    const remainingSources = new Set(unassigned.map(function (i) { return i.source; }));
    if (remainingSources.size < 2) continue;
    for (const it of unassigned) assignedItems.add(it);
    rawClusters.push({ items: unassigned });
    if (rawClusters.length >= 25) break;
  }

  // Coherence filter — drop articles not sharing ≥1 title token with at least
  // half the other members (weeds out incidental keyword collisions).
  function filterCoherent(clItems) {
    if (clItems.length <= 2) return clItems;
    const tokSets = clItems.map(function (it) { return new Set(tokenize(it.title || "")); });
    return clItems.filter(function (it, idx) {
      const myToks = tokSets[idx];
      const threshold = Math.ceil((clItems.length - 1) / 2);
      let matches = 0;
      for (let j = 0; j < clItems.length; j++) {
        if (j === idx) continue;
        let shared = false;
        myToks.forEach(function (t) { if (tokSets[j].has(t)) shared = true; });
        if (shared) matches++;
      }
      return matches >= threshold;
    });
  }

  const coherent = rawClusters.map(function (c) { return { items: filterCoherent(c.items) }; });
  return finalizeClusters(coherent);
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

  // Enrich with real engagement signals (Reddit upvotes) before scoring.
  await enrichRedditEngagement(allItems);

  // Score every item first, then cluster into cross-source topics.
  scoreItems(allItems);

  // Prefer semantic (embeddings) clustering; fall back to keyword overlap.
  let topics = null;
  if (VOYAGE_API_KEY) {
    console.log("Clustering: semantisch via Voyage embeddings (" + VOYAGE_MODEL + ")…");
    topics = await clusterByEmbeddings(allItems);
  }
  if (!topics) {
    if (VOYAGE_API_KEY) console.log("Clustering: terugval op keyword-overlap.");
    else console.log("Clustering: keyword-overlap (zet VOYAGE_API_KEY voor semantische clustering).");
    topics = clusterByTopic(allItems);
  }
  topics = topics.slice(0, MAX_TOPICS);
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

  ensureDir(DATA_DIR);
  ensureDir(ARCHIVE_DIR);

  // Schrijf altijd latest-raw.json — dit is de input voor ai-synthesize.js.
  writeJSON(RAW_PATH, brief);
  console.log("✓ Schreef " + RAW_PATH + " (" + topics.length + " topics)");
  console.log("  Bestand bestaat: " + fs.existsSync(RAW_PATH));

  // Schrijf latest.json ALLEEN als fallback: als er nog geen AI-synthesis data in zit.
  // Dit voorkomt dat de hourly fetch de AI-verrijkte data van de ochtend overschrijft.
  let writeLatest = true;
  if (fs.existsSync(LATEST_PATH)) {
    try {
      const existing = readJSON(LATEST_PATH);
      if (Array.isArray(existing.daily && existing.daily.categories) &&
          existing.daily.categories.length > 0) {
        writeLatest = false; // AI-data bewaren, niet overschrijven
        console.log("✓ latest.json heeft AI-data — niet overschreven door fetch.");
      }
    } catch (e) { /* corrupt → overschrijven */ }
  }
  if (writeLatest) {
    writeJSON(LATEST_PATH, brief);
    console.log("✓ Schreef " + LATEST_PATH + " (fallback, nog geen AI-data).");
  }

  updateArchiveIndex(date);
  console.log("✓ Updated " + ARCHIVE_INDEX_PATH);
}

// Force exit zodat hangende HTTP-sockets (chunked feeds die nooit afsluiten)
// de Node.js event loop niet blokkeren na afloop van het script.
// Alleen draaien wanneer direct aangeroepen (node scripts/fetch-and-summarize.js),
// zodat de pure functies importeerbaar zijn voor tests.
if (require.main === module) {
  main().then(function () {
    process.exit(0);
  }).catch(function (err) {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = {
  cosine, meanVec, finalizeClusters, clusterByEmbeddings, clusterByTopic,
  scoreItems, dedupe, redditPostId, subredditOf, tokenize,
};

