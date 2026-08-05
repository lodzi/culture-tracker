#!/usr/bin/env node
/**
 * CultureTracker — TESTFASE, stap 1 (donderdag)
 *
 * Leest data/latest.json (de weekly brand signals die net met
 * WEEKLY_SIGNAL_COUNT=6 zijn gegenereerd) en schrijft twee bestanden in test/:
 *
 *   test/topics-YYYY-MM-DD.md    — leesbaar overzicht van de 6 topics met een
 *                                  SELECTION-regel bovenaan die Lode invult.
 *   test/topics-YYYY-MM-DD.json  — machine-snapshot van dezelfde 6 signalen,
 *                                  zodat de vrijdag-taak niet afhankelijk is van
 *                                  latest.json (dat wordt vrijdagochtend
 *                                  overschreven door de dagelijkse taak).
 *
 * Gebruik:  node scripts/test-generate-topics.js
 * Vooraf:   WEEKLY_SIGNAL_COUNT=6 WEEKLY_SIGNALS_FORCE=1 npm run update && npm run synthesize
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");
const TEST_DIR    = path.join(ROOT, "test");

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    throw new Error("Kan " + LATEST_PATH + " niet vinden. Run eerst ai-synthesize.js.");
  }

  const brief = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));
  const signals = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];

  if (signals.length === 0) {
    throw new Error("Geen weekly brand signals in latest.json. Draaide de synthese met WEEKLY_SIGNAL_COUNT=6?");
  }

  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

  const date = todayISO();
  const jsonPath = path.join(TEST_DIR, "topics-" + date + ".json");
  const mdPath   = path.join(TEST_DIR, "topics-" + date + ".md");

  // 1. Machine-snapshot
  fs.writeFileSync(jsonPath, JSON.stringify({
    date,
    generatedAt: new Date().toISOString(),
    count: signals.length,
    signals,
  }, null, 2));

  // 2. Leesbaar overzicht met SELECTION-regel
  const lines = [];
  lines.push("# CultureTracker — topic-keuze " + date);
  lines.push("");
  lines.push("Kies 3 topics door hun nummers hieronder in te vullen (komma-gescheiden).");
  lines.push("De vrijdag-taak leest exact deze regel. Voorbeeld: `SELECTION: 1, 3, 5`");
  lines.push("");
  lines.push("SELECTION: ");
  lines.push("");
  lines.push("---");
  lines.push("");

  signals.forEach(function (s, i) {
    const n = i + 1;
    lines.push("## " + n + ". " + (s.trend || "(zonder titel)") +
      (s.category ? "  _(" + s.category + ")_" : ""));
    lines.push("");
    if (s.what_is_happening) {
      lines.push(s.what_is_happening);
      lines.push("");
    }
    if (s.why_it_matters_for_brands) {
      lines.push("**Why it matters for brands:** " + s.why_it_matters_for_brands);
      lines.push("");
    }
    if (Array.isArray(s.what_brands_can_do) && s.what_brands_can_do.length) {
      lines.push("**What brands can do:**");
      s.what_brands_can_do.forEach(function (a) { lines.push("- " + a); });
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  });

  fs.writeFileSync(mdPath, lines.join("\n"));

  console.log("✓ " + signals.length + " topics weggeschreven:");
  console.log("  " + mdPath);
  console.log("  " + jsonPath);
}

main();
