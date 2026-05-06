#!/usr/bin/env node
/**
 * Culture Tracker — test proposed new sources.
 * Tests every candidate source for reachability + valid RSS.
 * Saves results to data/source-test-results.json for review.
 *
 * Usage:  node scripts/test-proposed-sources.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const TIMEOUT_MS = 10000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── All proposed candidate sources ────────────────────────────────────────────
const CANDIDATES = [
  // Fashion & Streetwear
  { name: "Sneaker News",       category: "fashion", weight: 8, url: "https://sneakernews.com/feed/" },
  { name: "Sole Collector",     category: "fashion", weight: 7, url: "https://solecollector.com/rss" },
  { name: "Complex",            category: "culture", weight: 8, url: "https://www.complex.com/rss" },
  { name: "Vogue Business",     category: "fashion", weight: 8, url: "https://www.voguebusiness.com/rss" },
  { name: "GQ",                 category: "fashion", weight: 7, url: "https://www.gq.com/feed/rss" },
  { name: "Dapper Lou",         category: "fashion", weight: 6, url: "https://dapperlou.com/feed/" },

  // Music
  { name: "Billboard",          category: "music",   weight: 9, url: "https://www.billboard.com/feed/" },
  { name: "NME",                category: "music",   weight: 8, url: "https://www.nme.com/feed" },
  { name: "The FADER",          category: "music",   weight: 8, url: "https://www.thefader.com/rss" },
  { name: "Resident Advisor",   category: "music",   weight: 7, url: "https://ra.co/feed.xml" },
  { name: "Mixmag",             category: "music",   weight: 7, url: "https://mixmag.net/feed" },
  { name: "Crack Magazine",     category: "music",   weight: 7, url: "https://crackmagazine.net/feed/" },
  { name: "DIY Magazine",       category: "music",   weight: 7, url: "https://diymag.com/feed" },
  { name: "Pitchfork Best New", category: "music",   weight: 9, url: "https://pitchfork.com/feed/feed-best/rss" },
  { name: "The Quietus",        category: "music",   weight: 7, url: "https://thequietus.com/feed" },
  { name: "Pitchfork Reviews",  category: "music",   weight: 8, url: "https://pitchfork.com/feed/feed-reviews/rss" },

  // Internet & Pop culture
  { name: "The Cut",            category: "culture", weight: 8, url: "https://www.thecut.com/feed/rss" },
  { name: "The Ringer",         category: "culture", weight: 8, url: "https://www.theringer.com/rss/index.xml" },
  { name: "Input Mag",          category: "internet",weight: 7, url: "https://www.inputmag.com/rss" },
  { name: "Gizmodo",            category: "internet",weight: 7, url: "https://gizmodo.com/rss" },
  { name: "Mel Magazine",       category: "culture", weight: 6, url: "https://melmagazine.com/feed" },
  { name: "Vice Tech",          category: "internet",weight: 6, url: "https://www.vice.com/en/section/tech/rss" },

  // Art & Design
  { name: "Design Boom",        category: "art",     weight: 8, url: "https://www.designboom.com/feed/" },
  { name: "Colossal",           category: "art",     weight: 8, url: "https://www.thisiscolossal.com/feed/" },
  { name: "Ignant",             category: "art",     weight: 7, url: "https://www.ignant.com/feed/" },
  { name: "Core77",             category: "art",     weight: 7, url: "https://www.core77.com/rss.xml" },
  { name: "Domus",              category: "art",     weight: 7, url: "https://www.domusweb.it/en/rss/all.rss.html" },
  { name: "Sight Unseen",       category: "art",     weight: 6, url: "https://www.sightunseen.com/feed/" },
  { name: "Yanko Design",       category: "art",     weight: 7, url: "https://www.yankodesign.com/feed/" },

  // Film & TV
  { name: "Deadline",           category: "film",    weight: 9, url: "https://deadline.com/feed/" },
  { name: "Screen Daily",       category: "film",    weight: 7, url: "https://www.screendaily.com/rss" },
  { name: "Little White Lies",  category: "film",    weight: 7, url: "https://lwlies.com/feed/" },
  { name: "Film Comment",       category: "film",    weight: 7, url: "https://www.filmcomment.com/feed/" },

  // Culture & Society
  { name: "The Atlantic",       category: "culture", weight: 8, url: "https://www.theatlantic.com/feed/channel/entertainment/" },
  { name: "Document Journal",   category: "culture", weight: 7, url: "https://documentjournal.com/feed/" },
  { name: "AnOther Magazine",   category: "culture", weight: 7, url: "https://www.anothermag.com/feed" },
  { name: "The Baffler",        category: "culture", weight: 6, url: "https://thebaffler.com/feed" },

  // BE/NL
  { name: "VRT NWS Cultuur",    category: "culture", weight: 7, url: "https://www.vrt.be/vrtnws/nl/rss/cultuur.rss" },
  { name: "De Morgen Cultuur",  category: "culture", weight: 7, url: "https://www.demorgen.be/cultuur/rss.xml" },
  { name: "Knack",              category: "culture", weight: 7, url: "https://www.knack.be/rss/" },
  { name: "HUMO",               category: "culture", weight: 7, url: "https://www.humo.be/rss" },
  { name: "3voor12",            category: "music",   weight: 8, url: "https://3voor12.vpro.nl/artikelen.rss" },
  { name: "OOR Magazine",       category: "music",   weight: 7, url: "https://www.oor.nl/feed/" },

  // Trends & Innovation
  { name: "Fast Company",       category: "trends",  weight: 8, url: "https://www.fastcompany.com/latest/rss" },
  { name: "Quartz",             category: "trends",  weight: 7, url: "https://qz.com/rss" },
  { name: "MIT Tech Review",    category: "internet",weight: 8, url: "https://www.technologyreview.com/feed/" },
  { name: "Springwise",         category: "trends",  weight: 7, url: "https://www.springwise.com/feed/" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function looksLikeRss(body) {
  return /<rss|<feed|<channel|<atom/i.test(body);
}

function countRecentItems(body, hoursBack) {
  const cutoff = Date.now() - hoursBack * 3600000;
  const dateMatches = body.match(/<(pubDate|published|updated|dc:date)[^>]*>([^<]+)<\//gi) || [];
  let recent = 0;
  for (const m of dateMatches) {
    const raw = m.replace(/<[^>]+>/g, "").trim();
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && d.getTime() >= cutoff) recent++;
  }
  return recent;
}

async function testSource(candidate) {
  const start = Date.now();
  const result = {
    name:     candidate.name,
    category: candidate.category,
    weight:   candidate.weight,
    url:      candidate.url,
    ok:       false,
    status:   null,
    ms:       null,
    recentItems: 0,
    note:     "",
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    const res = await fetch(candidate.url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    result.ms     = Date.now() - start;
    result.status = res.status;

    if (res.status >= 400) {
      result.note = "HTTP " + res.status;
      return result;
    }

    const body = await res.text();

    if (!looksLikeRss(body)) {
      result.note = "200 maar geen RSS/Atom in body";
      return result;
    }

    const recent24h = countRecentItems(body, 24);
    const recent7d  = countRecentItems(body, 168);
    result.recentItems = recent24h;
    result.ok   = true;
    result.note = recent24h + " items (24h) · " + recent7d + " items (7d)";

  } catch (err) {
    result.ms   = Date.now() - start;
    result.note = err.name === "AbortError"
      ? "Timeout na " + TIMEOUT_MS + "ms"
      : "Fout: " + err.message;
  }

  return result;
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Culture Tracker — testing " + CANDIDATES.length + " proposed sources\n");

  // Run in parallel, cap at 8 concurrent to avoid hammering
  const results = new Array(CANDIDATES.length);
  let idx = 0;
  async function worker() {
    while (idx < CANDIDATES.length) {
      const i = idx++;
      results[i] = await testSource(CANDIDATES[i]);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  // Print table
  console.log(
    pad("NAAM", 22) +
    pad("STATUS", 8) +
    pad("MS", 7) +
    "NOTE"
  );
  console.log("-".repeat(70));

  let okCount = 0, failCount = 0;
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    console.log(
      icon + " " + pad(r.name, 20) +
      pad(r.status ?? "ERR", 8) +
      pad((r.ms ?? 0) + "ms", 7) +
      r.note
    );
    if (r.ok) okCount++; else failCount++;
  }

  console.log("\n" + okCount + " werken · " + failCount + " falen\n");

  // Save full results to file so Claude can read them
  const outPath = path.resolve(__dirname, "..", "data", "source-test-results.json");
  fs.writeFileSync(outPath, JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2) + "\n");
  console.log("✓ Resultaten opgeslagen in data/source-test-results.json");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
