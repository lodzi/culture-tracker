#!/usr/bin/env node
/**
 * CultureTracker — TESTFASE, stap 2 (vrijdag)
 *
 * Leest de meest recente test/topics-YYYY-MM-DD.md (de donderdag-selectie),
 * haalt de SELECTION-regel eruit, valideert de 3 gekozen nummers en schrijft
 * exact die 3 signalen in data/latest.json. Daarna kan `npm run weekly-email`
 * ze via Mailchimp naar de audience sturen.
 *
 * Dit script VERSTUURT NIETS. Het bepaalt alleen wat er verstuurd wordt.
 *
 * Exit codes (belangrijk voor de scheduled task):
 *   0  = geldige selectie toegepast, klaar om te versturen.
 *   2  = geen/ongeldige selectie -> NIET versturen, waarschuw Lode.
 *   1  = onverwachte fout.
 *
 * Gebruik in de vrijdag-taak:
 *   node scripts/test-apply-selection.js && npm run weekly-email
 * (Door de `&&` stuurt Mailchimp alleen bij exit 0.)
 *
 * Optioneel: EXPECT_SELECTION_COUNT (default 3).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const TEST_DIR    = path.join(ROOT, "test");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");
const EXPECT      = Math.max(1, parseInt(process.env.EXPECT_SELECTION_COUNT || "3", 10));

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(2);
}

// Zoek het meest recente topics-YYYY-MM-DD.md bestand (op datum in bestandsnaam).
function findLatestTopicsFile() {
  if (!fs.existsSync(TEST_DIR)) return null;
  const files = fs.readdirSync(TEST_DIR)
    .filter(function (f) { return /^topics-\d{4}-\d{2}-\d{2}\.md$/.test(f); })
    .sort()
    .reverse();
  return files.length ? files[0] : null;
}

function parseSelection(mdText) {
  const m = mdText.match(/^SELECTION:\s*(.*)$/m);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return [];
  return raw.split(/[^0-9]+/).filter(Boolean).map(Number);
}

function main() {
  const mdName = findLatestTopicsFile();
  if (!mdName) fail("Geen test/topics-*.md gevonden. Draaide de donderdag-taak?");

  const date     = mdName.replace(/^topics-|\.md$/g, "");
  const mdPath   = path.join(TEST_DIR, mdName);
  const jsonPath = path.join(TEST_DIR, "topics-" + date + ".json");

  if (!fs.existsSync(jsonPath)) fail("Snapshot ontbreekt: " + jsonPath);

  const snapshot = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const signals  = Array.isArray(snapshot.signals) ? snapshot.signals : [];
  if (signals.length === 0) fail("Snapshot bevat geen signalen: " + jsonPath);

  const picks = parseSelection(fs.readFileSync(mdPath, "utf8"));
  if (picks === null) fail("Geen SELECTION-regel gevonden in " + mdName + ".");
  if (picks.length === 0) fail("SELECTION-regel is leeg in " + mdName + " — niets geselecteerd.");

  // Validatie
  const uniq = Array.from(new Set(picks));
  if (uniq.length !== picks.length) fail("SELECTION bevat dubbele nummers: " + picks.join(", "));
  if (picks.length !== EXPECT) fail("SELECTION bevat " + picks.length + " nummers, verwacht " + EXPECT + ": " + picks.join(", "));
  const bad = picks.filter(function (n) { return !Number.isInteger(n) || n < 1 || n > signals.length; });
  if (bad.length) fail("Ongeldige nummers (buiten 1-" + signals.length + "): " + bad.join(", "));

  // Kies de signalen (1-based -> 0-based), in de volgorde die Lode koos
  const chosen = picks.map(function (n) { return signals[n - 1]; });

  // Schrijf in latest.json zodat send-weekly-email ze oppikt
  if (!fs.existsSync(LATEST_PATH)) fail("Kan " + LATEST_PATH + " niet vinden.");
  const brief = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));
  brief.weeklyBrandSignals = {
    generatedAt: new Date().toISOString(),
    weeklyBrandSignals: chosen,
  };
  fs.writeFileSync(LATEST_PATH, JSON.stringify(brief, null, 2));

  console.log("✓ Selectie " + picks.join(", ") + " toegepast op latest.json (bron: " + mdName + ").");
  chosen.forEach(function (s, i) {
    console.log("  " + (i + 1) + ". " + (s.trend || "(zonder titel)") +
      (s.category ? " [" + s.category + "]" : ""));
  });
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error("✗ Onverwachte fout:", e.message || e);
  process.exit(1);
}
