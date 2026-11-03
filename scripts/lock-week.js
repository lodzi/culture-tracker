#!/usr/bin/env node
/**
 * Zeitfeed Weekly — keuze vergrendelen en loggen.
 *
 * Draai dit nadat de gekozen 3 topics in data/latest.json -> weeklyBrandSignals staan:
 *   npm run lock-week            (schrijft latest.json en data/sent.json)
 *   npm run lock-week -- --dry   (toont wat er zou gebeuren, schrijft niets)
 *
 * Wat het doet:
 *   1. Zet op weeklyBrandSignals: sendDate (de vrijdag van deze week), locked: true,
 *      selection: "manual". De pipeline overschrijft een vergrendelde set nooit.
 *   2. Voegt de 3 topics toe aan data/sent.json (status "queued"), met de thema-tags
 *      van de bijbehorende kandidaat (via candidateId, anders via gelijke titel).
 *      Een bestaande regel voor dezelfde sendDate wordt vervangen (idempotent).
 *
 * Optioneel: --send-date=YYYY-MM-DD om de verzenddatum te forceren.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { sendDateFor, toISODate } = require("./pipeline-config");

const ROOT        = path.resolve(__dirname, "..");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");
const SENT_PATH   = path.join(ROOT, "data", "sent.json");

function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJSON(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8"); }
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function run(argv, now) {
  const dry = argv.includes("--dry");
  const forced = (argv.find(function (a) { return a.indexOf("--send-date=") === 0; }) || "").split("=")[1];
  const sendDate = forced || sendDateFor(now);

  const latest = readJSON(LATEST_PATH);
  const sig = latest.weeklyBrandSignals;
  if (!sig || !Array.isArray(sig.weeklyBrandSignals) || sig.weeklyBrandSignals.length === 0) {
    throw new Error("Geen weeklyBrandSignals in latest.json om te vergrendelen.");
  }
  if (sig.weeklyBrandSignals.length !== 3) {
    console.warn("⚠ " + sig.weeklyBrandSignals.length + " topics i.p.v. 3.");
  }
  const cats = new Set(sig.weeklyBrandSignals.map(function (s) { return s.category; }));
  if (cats.size !== sig.weeklyBrandSignals.length) {
    console.warn("⚠ Niet alle topics hebben een andere categorie.");
  }

  const cands = (latest.weeklyCandidates && latest.weeklyCandidates.candidates) || [];
  const topics = sig.weeklyBrandSignals.map(function (s) {
    let c = s.candidateId ? cands.find(function (x) { return x.id === s.candidateId; }) : null;
    if (!c) c = cands.find(function (x) { return norm(x.trend) === norm(s.trend); }) || null;
    if (!c) console.warn("⚠ Geen kandidaat gevonden voor '" + s.trend + "' — thema-tags blijven leeg.");
    return { trend: s.trend, category: s.category, themes: c ? c.themes : [] };
  });

  sig.sendDate = sendDate;
  sig.locked = true;
  sig.selection = "manual";
  sig.lockedAt = now.toISOString();

  const sentFile = fs.existsSync(SENT_PATH) ? readJSON(SENT_PATH) : { sent: [] };
  sentFile.sent = (sentFile.sent || []).filter(function (e) { return e.sendDate !== sendDate; });
  sentFile.sent.push({ sendDate, status: "queued", topics });
  sentFile.sent.sort(function (a, b) { return a.sendDate < b.sendDate ? 1 : -1; });

  console.log("Verzenddatum " + sendDate + " · " + topics.length + " topics vergrendeld:");
  topics.forEach(function (t) {
    console.log("  - [" + t.category + "] " + t.trend + "  (thema's: " + (t.themes.join(", ") || "geen") + ")");
  });

  if (dry) { console.log("(dry-run: niets geschreven)"); return { latest, sentFile }; }
  writeJSON(LATEST_PATH, latest);
  writeJSON(SENT_PATH, sentFile);
  console.log("✓ latest.json en sent.json bijgewerkt.");
  return { latest, sentFile };
}

if (require.main === module) {
  try { run(process.argv.slice(2), new Date()); }
  catch (e) { console.error("Fatal:", e.message); process.exit(1); }
}

module.exports = { run };
