#!/usr/bin/env node
/**
 * Culture Tracker — source health check
 *
 * Fetches each source in /config/sources.json and reports:
 *   - HTTP status
 *   - Whether the body looks like a valid RSS/Atom feed
 *   - Recent item count (last 7 days)
 *   - For "website" sources: whether the URL accidentally serves a feed too
 *
 * No Claude API calls. Run any time to validate your config:
 *   npm run check-sources
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

const SOURCES_PATH = path.resolve(__dirname, "..", "config", "sources.json");
const UA = "Mozilla/5.0 (compatible; CultureTrackerBot/1.0)";
const TIMEOUT_MS = 12000;

const parser = new Parser({
  timeout: TIMEOUT_MS,
  headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
});

function pad(s, n) {
  s = String(s == null ? "" : s);
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

async function fetchHead(url) {
  // Use Node 18+ fetch.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, "Accept": "*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const ctype = res.headers.get("content-type") || "";
    const body = await res.text();
    return { status: res.status, ctype: ctype, body: body.slice(0, 4000) };
  } catch (e) {
    return { status: 0, ctype: "", body: "", error: e.message };
  }
}

function looksLikeFeed(body) {
  return /<rss|<feed|<channel/i.test(body);
}

async function checkOne(s) {
  const result = { name: s.name, type: s.type, url: s.url, ok: false, note: "" };

  const h = await fetchHead(s.url);
  if (h.error) {
    result.note = "fetch failed: " + h.error;
    return result;
  }
  result.status = h.status;
  result.ctype = h.ctype.split(";")[0];

  if (h.status >= 400) {
    result.note = "HTTP " + h.status;
    return result;
  }

  const isFeed = looksLikeFeed(h.body);

  if (s.type === "rss") {
    if (!isFeed) {
      result.note = "URL responds 200 but body is not RSS/Atom";
      return result;
    }
    // Try parsing it for real and count recent items
    try {
      const feed = await parser.parseURL(s.url);
      const items = feed.items || [];
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = items.filter(function (i) {
        const d = new Date(i.isoDate || i.pubDate || 0);
        return !isNaN(d.getTime()) && d.getTime() >= sevenDaysAgo;
      });
      result.ok = true;
      result.note = items.length + " items total, " + recent.length + " in last 7d";
    } catch (e) {
      result.note = "rss-parser error: " + e.message;
    }
  } else if (s.type === "website") {
    if (isFeed) {
      result.note = "site responds — and looks like a feed! consider type='rss'";
      result.ok = true; // Reachable, just wrong type.
    } else {
      result.note = "reachable but not a feed (script skips this source)";
    }
  } else if (s.type === "tiktok-trends") {
    // Probe the Creative Center API and confirm it returns valid JSON.
    const apiUrl = s.url +
      "?period=" + (s.period || 7) +
      "&page=1&limit=5" +
      "&country_code=" + (s.country_code || "US") +
      "&language=en";
    const th = await fetchHead(apiUrl);
    if (th.error) {
      result.note = "fetch failed: " + th.error;
      return result;
    }
    result.status = th.status;
    result.ctype = th.ctype.split(";")[0];
    if (th.status >= 400) {
      result.note = "HTTP " + th.status + " (TikTok may block server-side requests)";
      return result;
    }
    try {
      const json = JSON.parse(th.body);
      const count = (json && json.data && Array.isArray(json.data.list)) ? json.data.list.length : 0;
      result.ok = count > 0;
      result.note = result.ok
        ? count + " hashtags returned (code=" + json.code + ")"
        : "response OK but no hashtags in list (code=" + (json && json.code) + ")";
    } catch (e) {
      result.note = "response is not valid JSON (" + e.message + ")";
    }
  } else {
    result.note = "unknown type '" + s.type + "'";
  }
  return result;
}

async function main() {
  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  console.log("Checking " + sources.length + " sources from " + SOURCES_PATH);
  console.log("");
  console.log(pad("NAME", 26) + pad("TYPE", 10) + pad("STATUS", 8) + "NOTE");
  console.log(pad("----", 26) + pad("----", 10) + pad("------", 8) + "----");

  let okCount = 0, failCount = 0;
  const results = [];

  // Run in parallel but cap concurrency at 6 to avoid hammering.
  const concurrency = 6;
  let idx = 0;
  async function worker() {
    while (idx < sources.length) {
      const my = idx++;
      const r = await checkOne(sources[my]);
      results[my] = r;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  results.forEach(function (r) {
    const mark = r.ok ? "✓" : "✗";
    const status = r.status ? String(r.status) : "ERR";
    console.log(pad(r.name, 26) + pad(r.type, 10) + pad(mark + " " + status, 8) + r.note);
    if (r.ok) okCount++; else failCount++;
  });

  console.log("");
  console.log("Summary: " + okCount + " ok, " + failCount + " problem(s).");
  if (failCount > 0) process.exitCode = 1;
}

main().catch(function (e) {
  console.error("Fatal:", e);
  process.exit(1);
});
