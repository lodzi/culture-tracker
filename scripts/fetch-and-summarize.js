#!/usr/bin/env node
/**
 * Culture Tracker — fetch & summarize
 *
 * 1. Reads /config/sources.json
 * 2. Fetches each RSS feed and keeps items from the last 24 hours
 * 3. Sends those items to Claude with a structured prompt
 * 4. Writes the result to /data/archive/YYYY-MM-DD.json
 * 5. Copies the same file to /data/latest.json
 * 6. Maintains /data/archive/index.json (list of dates) for the frontend
 *
 * Required env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *
 * Optional env:
 *   ANTHROPIC_MODEL    (default: claude-sonnet-4-6)
 *   LOOKBACK_HOURS     (default: 24)
 *   MAX_ITEMS_PER_FEED (default: 10)
 *
 * Dependencies:
 *   - rss-parser           — robust RSS/Atom parsing (handles edge cases we don't want to write)
 *   - @anthropic-ai/sdk    — official Claude SDK
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");

// --- Paths ---
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "config", "sources.json");
const DATA_DIR = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const ARCHIVE_INDEX_PATH = path.join(ARCHIVE_DIR, "index.json");

// --- Config ---
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || "24", 10);
const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || "10", 10);
// How many days of archive to include as historical context for weekly/monthly pattern detection.
const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || "30", 10);
// Hard cap on archive items per past day in the prompt (keeps token cost bounded).
const HISTORY_ITEMS_PER_DAY = parseInt(process.env.HISTORY_ITEMS_PER_DAY || "20", 10);

// --- Helpers ---
function todayISO() {
  // YYYY-MM-DD in UTC
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
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// --- History (past archives) ---
// Reads the last N days of archive briefs and returns a compact representation
// for use as context in the Claude prompt. We deliberately keep this small:
// just titles + sources + categories, plus past weekly/monthly titles so Claude
// can avoid repetition.
function loadHistory(days) {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];

  const today = todayISO();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const dateFiles = fs.readdirSync(ARCHIVE_DIR)
    .filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); })
    .map(function (f) { return f.replace(/\.json$/, ""); })
    .filter(function (d) { return d < today && d >= cutoffISO; })
    .sort();

  return dateFiles.map(function (date) {
    try {
      const data = readJSON(path.join(ARCHIVE_DIR, date + ".json"));
      // Support both new shape ({daily:{themes:[]}}) and legacy ({themes:[]}).
      const themes = (data.daily && Array.isArray(data.daily.themes))
        ? data.daily.themes
        : (Array.isArray(data.themes) ? data.themes : []);
      const items = [];
      themes.forEach(function (t) {
        (t.items || []).forEach(function (i) {
          items.push({
            title: i.title || "",
            source: i.source || "",
            category: i.category || "",
          });
        });
      });
      return {
        date: date,
        items: items.slice(0, HISTORY_ITEMS_PER_DAY),
        weekly_titles: (data.weekly_hypes || []).map(function (h) { return h.title || ""; }).filter(Boolean),
        monthly_titles: (data.monthly_trends || []).map(function (t) { return t.title || ""; }).filter(Boolean),
      };
    } catch (e) {
      console.warn("  ! could not read archive " + date + ": " + e.message);
      return null;
    }
  }).filter(Boolean);
}

function compactHistory(history) {
  if (!history || history.length === 0) {
    return "(no historical archive yet — first run, or fewer than HISTORY_DAYS days of data)";
  }
  return history.map(function (day) {
    const itemLines = day.items.map(function (i) {
      const title = truncate(i.title, 120);
      const meta = [i.source, i.category].filter(Boolean).join(", ");
      return "  - \"" + title + "\"" + (meta ? " (" + meta + ")" : "");
    }).join("\n");
    let s = day.date + ":\n" + (itemLines || "  (no items)");
    if (day.weekly_titles.length) {
      s += "\n  weekly hypes flagged that day: " + day.weekly_titles.join("; ");
    }
    if (day.monthly_titles.length) {
      s += "\n  monthly trends flagged that day: " + day.monthly_titles.join("; ");
    }
    return s;
  }).join("\n\n");
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
          source_category: source.category || null,
          title: stripHtml(i.title || ""),
          url: i.link || "",
          published: i.isoDate || i.pubDate || null,
          summary: truncate(stripHtml(i.contentSnippet || i.content || i.summary || ""), 500),
        };
      });
    console.log("  ✓ " + source.name + ": " + items.length + " recent items");
    return items;
  } catch (err) {
    console.warn("  ✗ " + source.name + ": " + err.message);
    return [];
  }
}

// --- Claude prompt ---
// The prompt below is intentionally embedded verbatim so it's easy to tune
// without having to read JS string concatenation. If you change the schema here,
// also update the renderers in app.js and scripts/send-email.js.
function buildPrompt(date, items, history) {
  const promptHeader = [
    "You are a cultural intelligence analyst.",
    "Your task is to transform a list of recent articles and signals into a structured multi-layer culture report with three levels:",
    "",
    "1. DAILY SIGNALS (fast, new, emerging)",
    "2. WEEKLY HYPES (patterns gaining traction)",
    "3. MONTHLY TRENDS (macro cultural shifts)",
    "",
    "INPUT: You will receive a list of articles with titles, sources, and short descriptions.",
    "",
    "OUTPUT: Return ONLY valid JSON in the following structure:",
    "{",
    '  "date": "' + date + '",',
    '  "daily": {',
    '    "title": "Daily Culture Brief",',
    '    "intro": "Short summary of today\'s cultural landscape",',
    '    "themes": [',
    "      {",
    '        "title": "<theme title, max 8 words>",',
    '        "summary": "<1–2 sentences: why this theme matters today>",',
    '        "items": [',
    "          {",
    '            "title": "<item title>",',
    '            "summary": "<1–2 sentences: what happened>",',
    '            "cultural_relevance": "<1–2 sentences: why this matters for popular culture>",',
    '            "source": "<source name from the input>",',
    '            "url": "<original article url>",',
    '            "category": "<one of: music, fashion, film, internet, sport, gaming, art, brands, social, marketing, culture, trends, community>",',
    '            "score": <integer 1–10>',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  },",
    '  "weekly_hypes": [',
    "    {",
    '      "title": "...",',
    '      "description": "...",',
    '      "why_it_matters": "...",',
    '      "signals": ["example signal 1", "example signal 2"],',
    '      "categories": ["fashion", "music"],',
    '      "score": 1-10',
    "    }",
    "  ],",
    '  "monthly_trends": [',
    "    {",
    '      "title": "...",',
    '      "description": "...",',
    '      "cultural_shift": "...",',
    '      "evidence": ["pattern 1", "pattern 2"],',
    '      "implications": "What does this mean for brands, creators or culture?",',
    '      "score": 1-10',
    "    }",
    "  ]",
    "}",
    "",
    "DEFINITIONS (VERY IMPORTANT):",
    "",
    "DAILY SIGNALS:",
    "- New events, drops, releases, announcements",
    "- Short lifecycle (1–3 days)",
    "- Highly specific",
    "- Example: \"Brand X drops AI-generated campaign\"",
    "",
    "WEEKLY HYPES:",
    "- Clusters of repeated signals across multiple sources",
    "- Growing attention over several days",
    "- Often driven by creators, communities, or platforms",
    "- Example: \"Streetwear brands adopting gaming aesthetics\"",
    "",
    "MONTHLY TRENDS:",
    "- Deeper behavioral or aesthetic shifts",
    "- Longer-term cultural movement (weeks/months)",
    "- Not tied to one event, but a pattern",
    "- Example: \"Blurring between digital and physical identity in fashion\"",
    "",
    "RULES:",
    "- DO NOT repeat the same idea across levels",
    "- DAILY = specific (only from TODAY'S NEW ARTICLES)",
    "- WEEKLY = patterns visible across the LAST ~7 DAYS of historical context",
    "- MONTHLY = macro shifts visible across the FULL HISTORICAL WINDOW",
    "- Weekly hypes must be derived from multiple signals across multiple days",
    "- Monthly trends must be supported by patterns over weeks, not single events",
    "- Avoid restating weekly/monthly themes that were already flagged on prior days unless the evidence has materially expanded — instead evolve them or replace them with sharper reads",
    "- Be concise but insightful",
    "- Avoid generic statements",
    "- Focus on popular culture: fashion, music, internet, gaming, sports, brands, youth culture",
    "- Scores: 1–3 = niche  4–6 = emerging  7–8 = gaining traction  9–10 = mainstream / breakout",
    "",
    "EXTRA:",
    "Think like a mix of:",
    "- trend forecaster",
    "- cultural strategist",
    "- editor of a high-end culture report",
    "",
    "The output should feel like something a creative agency or brand strategist would use.",
    "",
    "IMPORTANT: Return ONLY JSON. No explanation. No extra text.",
    "",
    "Today's date: " + date,
    "",
    "=== TODAY'S NEW ARTICLES (use these for daily signals) ===",
    "",
  ].join("\n");

  const historyBlock = [
    "",
    "",
    "=== HISTORICAL CONTEXT (use this for weekly hypes and monthly trends) ===",
    "",
    "The block below contains the last " + HISTORY_DAYS + " days of archived signals in compact form (titles + source + category per item, plus weekly/monthly themes that were already flagged on each day). Use these to detect REAL patterns over time. Do not repeat themes that have already been flagged unless new evidence materially extends them.",
    "",
    compactHistory(history),
  ].join("\n");

  return promptHeader + JSON.stringify(items, null, 2) + historyBlock;
}

function extractJSON(text) {
  // Claude is told to return raw JSON, but be defensive: strip any code fences.
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  // Find the first `{` and last `}` as a fallback.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

// --- Claude call ---
async function summarize(items, history) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const date = todayISO();
  const prompt = buildPrompt(date, items, history);

  const historyItems = history.reduce(function (s, d) { return s + d.items.length; }, 0);
  console.log("→ Sending " + items.length + " new items + " + historyItems + " historical items across " + history.length + " past days to Claude (" + MODEL + ")…");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = (response.content || []).find(function (b) { return b.type === "text"; });
  if (!textBlock) throw new Error("Claude returned no text content.");

  const parsed = extractJSON(textBlock.text);

  // Force the date and normalize the shape so renderers can rely on it.
  parsed.date = date;
  if (!parsed.daily || typeof parsed.daily !== "object") parsed.daily = {};
  if (!parsed.daily.title) parsed.daily.title = "Daily Culture Brief";
  if (!Array.isArray(parsed.daily.themes)) parsed.daily.themes = [];
  if (!Array.isArray(parsed.weekly_hypes)) parsed.weekly_hypes = [];
  if (!Array.isArray(parsed.monthly_trends)) parsed.monthly_trends = [];

  return parsed;
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
  console.log("Culture Tracker — fetch & summarize");
  console.log("Date: " + todayISO());

  ensureDir(DATA_DIR);
  ensureDir(ARCHIVE_DIR);

  const sources = readJSON(SOURCES_PATH);
  console.log("Loaded " + sources.length + " sources.");

  const parser = new Parser({ timeout: 15000 });

  let allItems = [];
  for (const source of sources) {
    if (source.type !== "rss") {
      console.warn("  ✗ " + source.name + ": unsupported type '" + source.type + "' (only 'rss' is supported today)");
      continue;
    }
    const items = await fetchSource(parser, source);
    allItems = allItems.concat(items);
  }

  console.log("Total items in window: " + allItems.length);
  if (allItems.length === 0) {
    console.error("No items fetched. Aborting (will not overwrite latest.json).");
    process.exit(1);
  }

  console.log("Loading historical context (last " + HISTORY_DAYS + " days)…");
  const history = loadHistory(HISTORY_DAYS);
  console.log("  → " + history.length + " past days available.");

  const brief = await summarize(allItems, history);

  const date = brief.date || todayISO();
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
