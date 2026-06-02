#!/usr/bin/env node
/**
 * Culture Tracker — Trend Report Synthesis
 *
 * Verwerkt PDFs en DOCX-bestanden uit de "Trend rapport/" map naar een
 * gesynthetiseerde macro-trend laag in data/report-synthesis.json.
 *
 * Workflow:
 *   1. Scan "Trend rapport/" recursief voor .pdf en .docx bestanden
 *   2. Extraheer tekst per bestand (PDF: eerste 6 pagina's; DOCX: volledige tekst)
 *   3. Stuur in batches naar Haiku voor per-rapport thema-extractie
 *   4. Synthetiseer alle thema's met Sonnet tot macro-trends
 *   5. Schrijf naar data/report-synthesis.json
 *
 * Caching: overgeslagen als report-synthesis.json < 30 dagen oud is
 *          én het aantal rapporten gelijk is (gebruik --force om te overschrijven).
 *
 * Gebruik:
 *   node scripts/synthesize-reports.js
 *   node scripts/synthesize-reports.js --force
 *
 * Vereist: ANTHROPIC_API_KEY
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

// ── Paden ──────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "Trend rapport");
const DATA_DIR    = path.join(ROOT, "data");
const OUTPUT_PATH = path.join(DATA_DIR, "report-synthesis.json");

// ── Modellen ───────────────────────────────────────────────────────────────
const HAIKU  = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// ── Config ─────────────────────────────────────────────────────────────────
const MAX_CHARS_PER_REPORT = 5000;   // tekst per rapport naar AI
const BATCH_SIZE           = 6;      // rapporten per Haiku-call
const CACHE_DAYS           = 30;     // herbereken na 30 dagen of bij --force
const FORCE                = process.argv.includes("--force");

// ── Helpers ────────────────────────────────────────────────────────────────
function readJSON(p)       { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

function ageDays(isoDate) {
  if (!isoDate) return 999;
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

function parseAIJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Geen JSON gevonden in AI respons");
  return JSON.parse(match[0]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Afhankelijkheden installeren ───────────────────────────────────────────
function ensureDep(pkg) {
  try {
    require.resolve(pkg);
  } catch (e) {
    console.log(`  Installeer ${pkg}…`);
    execSync(`npm install ${pkg} --no-save`, { cwd: ROOT, stdio: "inherit" });
    // Reset require cache voor net geïnstalleerde modules
    Object.keys(require.cache).forEach(k => {
      if (k.includes(pkg)) delete require.cache[k];
    });
  }
}

// ── Bestand scan ───────────────────────────────────────────────────────────
function scanReports(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanReports(fullPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".pdf" || ext === ".docx") {
        const stats = fs.statSync(fullPath);
        results.push({
          fullPath,
          name: path.basename(entry.name, ext).replace(/_/g, " ").trim(),
          ext,
          size: stats.size,
        });
      }
    }
  }
  return results;
}

// ── Tekst extractie ────────────────────────────────────────────────────────
async function extractText(file) {
  try {
    if (file.ext === ".pdf") {
      const pdfParse = require("pdf-parse");
      const buffer = fs.readFileSync(file.fullPath);
      // max: 6 = eerste 6 pagina's (genoeg voor samenvatting/inleiding)
      const data = await pdfParse(buffer, { max: 6 });
      const text = data.text
        .replace(/\s{3,}/g, "  ")   // comprimeer overbodige witruimte
        .trim()
        .slice(0, MAX_CHARS_PER_REPORT);
      return text.length > 100 ? text : null;
    }

    if (file.ext === ".docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ path: file.fullPath });
      const text = result.value.trim().slice(0, MAX_CHARS_PER_REPORT);
      return text.length > 100 ? text : null;
    }
  } catch (e) {
    // Geef null terug zodat het rapport overgeslagen wordt
    return null;
  }
  return null;
}

// ── Per-batch thema-extractie (Haiku) ──────────────────────────────────────
async function extractThemesBatch(client, batch) {
  const reportsJson = batch.map((r, i) => ({
    id:   i,
    naam: r.name,
    tekst: r.text,
  }));

  const prompt = `Je analyseert marketing- en cultuurtrend-rapporten voor een Belgisch cultureel strategiebureau (ACIG/Defiant). De lezers zijn merkstrategen, creative directors en communicatieprofessionals.

Hieronder staan ${batch.length} rapporten met hun naam en een tekstuittreksel.

Extraheer per rapport de 3-5 MEEST SIGNIFICANTE trends, inzichten of culturele verschuivingen.

Focus op:
- Concrete gedragsveranderingen bij consumenten
- Opkomende culturele bewegingen of esthetische verschuivingen
- Strategische kansen of bedreigingen voor merken
- Macro-economische of sociale verschuivingen met merkimpact

Geef per rapport een array van scherpe, specifieke inzichten (max. 20 woorden elk). Wees concreet, niet generiek.

Antwoord ALLEEN met dit JSON-formaat:
{
  "rapporten": [
    {
      "id": 0,
      "naam": "naam van het rapport",
      "categorie": "fashion|music|culture|marketing|trends|internet|film|art|gaming|lokaal",
      "themas": [
        "Inzicht 1 — kort maar specifiek",
        "Inzicht 2 — kort maar specifiek"
      ]
    }
  ]
}

Rapporten om te analyseren:
${JSON.stringify(reportsJson, null, 2)}`;

  const msg = await client.messages.create({
    model: HAIKU,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const result = parseAIJson(msg.content[0].text);
    return result.rapporten || [];
  } catch (e) {
    console.warn(`    ⚠ Batch parse mislukt: ${e.message}`);
    return [];
  }
}

// ── Macro-trend synthese (Sonnet) ──────────────────────────────────────────
async function synthesizeMacroTrends(client, allThemes) {
  const prompt = `Je bent een senior cultureel strateeg en trend forecaster voor een Belgisch strategiebureau dat merken adviseert over cultuur, communicatie en positionering.

Hieronder staan de sleutelthema's uit ${allThemes.length} toonaangevende marketing- en cultuurtrend-rapporten (McKinsey, Edelman, WGSN, GWI, Business of Fashion, Highsnobiety, Contagious, etc.).

Taak: synthetiseer deze inzichten tot de 6-8 meest dominante MACRO TRENDS.

Een sterke macro-trend:
- Wordt bevestigd door meerdere onafhankelijke bronnen
- Heeft een tijdshorizon van 6-18 maanden
- Is strategisch relevant voor merken die in cultuur willen opereren
- Gaat verder dan oppervlakkige hype — het is een structurele verschuiving

Geef per macro-trend:
- trend: pakkende naam (4-7 woorden, Nederlands of Engels naar gelang)
- summary: 3 zinnen — wat is de trend, hoe manifesteert ze zich concreet, wie drijft haar?
- why_it_matters: 1 zin — strategische betekenis voor merken
- strategic_action: 1 concrete zin — wat kunnen merken nu al doen of leren?
- horizon: "3 maanden" | "6 maanden" | "12 maanden" | "18 maanden"
- strength: "sterk" (3+ rapporten) | "matig" (2 rapporten)
- categories: array van relevante categorieën (gebruik: fashion, music, culture, marketing, trends, internet, film, art, gaming, lokaal)
- bronnen: array van rapport-namen die dit onderbouwen (max. 5)

Geef ook een overkoepelende intro (2 zinnen over de grote rode draad van dit rapport-corpus).

Antwoord ALLEEN met JSON:
{
  "intro": "2 zinnen over de grote lijn.",
  "macroTrends": [
    {
      "trend": "...",
      "summary": "...",
      "why_it_matters": "...",
      "strategic_action": "...",
      "horizon": "...",
      "strength": "sterk",
      "categories": ["..."],
      "bronnen": ["..."]
    }
  ]
}

Thema's per rapport:
${JSON.stringify(allThemes, null, 2)}`;

  console.log(`\n[Macro-trend synthese — Sonnet]`);
  console.log(`  ${allThemes.length} rapporten als input…`);
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  console.log(`  Tokens: ${msg.usage.input_tokens} in + ${msg.usage.output_tokens} out`);

  const result = parseAIJson(msg.content[0].text);
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Culture Tracker — Trend Report Synthesis");
  console.log(`  Datum: ${new Date().toISOString().slice(0, 10)}`);
  console.log("═══════════════════════════════════════════════");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\n✗ ANTHROPIC_API_KEY niet ingesteld.");
    process.exit(1);
  }

  // 1. Scan rapporten
  console.log(`\n[Scan] ${REPORTS_DIR}`);
  const files = scanReports(REPORTS_DIR);
  const pdfCount  = files.filter(f => f.ext === ".pdf").length;
  const docxCount = files.filter(f => f.ext === ".docx").length;
  console.log(`  Gevonden: ${files.length} bestanden (${pdfCount} PDF, ${docxCount} DOCX)`);

  if (files.length === 0) {
    console.error(`\n✗ Geen bestanden gevonden in "${REPORTS_DIR}"`);
    console.error("  Zorg dat de map PDF of DOCX bestanden bevat.");
    process.exit(1);
  }

  // 2. Cache check
  if (!FORCE && fs.existsSync(OUTPUT_PATH)) {
    try {
      const existing = readJSON(OUTPUT_PATH);
      const age = ageDays(existing.generatedAt);
      if (age < CACHE_DAYS && existing.reportCount === files.length) {
        console.log(`\n✓ Cache is vers (${age.toFixed(0)} dagen oud, ${existing.reportCount} rapporten).`);
        console.log("  Gebruik --force om te herberekenen.");
        process.exit(0);
      }
      const reason = age >= CACHE_DAYS
        ? `cache is ${age.toFixed(0)} dagen oud`
        : `rapportenaantal gewijzigd (${existing.reportCount} → ${files.length})`;
      console.log(`\n  Cache verouderd (${reason}) — herberekenen.`);
    } catch (e) { /* corrupt cache, gewoon herberekenen */ }
  }

  // 3. Installeer afhankelijkheden
  console.log("\n[Afhankelijkheden]");
  ensureDep("pdf-parse");
  ensureDep("mammoth");
  console.log("  ✓ pdf-parse en mammoth beschikbaar");

  const client = new Anthropic();

  // 4. Tekst extractie
  console.log("\n[Tekst extractie]");
  const extracted = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const label = `${i + 1}/${files.length}`.padStart(7);
    const nameTrunc = file.name.slice(0, 55).padEnd(55);
    process.stdout.write(`  ${label}  ${nameTrunc}`);
    const text = await extractText(file);
    if (text) {
      extracted.push({ name: file.name, ext: file.ext, text });
      process.stdout.write(" ✓\n");
    } else {
      process.stdout.write(" ✗\n");
    }
  }
  console.log(`\n  Resultaat: ${extracted.length}/${files.length} bestanden succesvol geëxtraheerd`);

  if (extracted.length === 0) {
    console.error("\n✗ Geen tekst geëxtraheerd. Controleer of de bestanden leesbare tekst bevatten.");
    process.exit(1);
  }

  // 5. Thema-extractie per batch (Haiku)
  const totalBatches = Math.ceil(extracted.length / BATCH_SIZE);
  console.log(`\n[Thema-extractie — Haiku] ${extracted.length} rapporten in ${totalBatches} batches`);
  const allThemes = [];

  for (let i = 0; i < extracted.length; i += BATCH_SIZE) {
    const batch     = extracted.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} rapporten)…`);
    const themes = await extractThemesBatch(client, batch);
    allThemes.push(...themes);
    process.stdout.write(` ${themes.length} analyses\n`);
    if (i + BATCH_SIZE < extracted.length) await sleep(800);
  }
  console.log(`  ✓ ${allThemes.length} rapport-analyses verzameld`);

  // 6. Macro-trend synthese (Sonnet)
  const synthesis = await synthesizeMacroTrends(client, allThemes);

  // 7. Sla op
  const output = {
    generatedAt:    new Date().toISOString(),
    reportCount:    files.length,
    processedCount: extracted.length,
    intro:          synthesis.intro || "",
    macroTrends:    synthesis.macroTrends || [],
    reportIndex:    files.map(f => ({ name: f.name, ext: f.ext })),
    themesByReport: allThemes,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJSON(OUTPUT_PATH, output);

  const trendCount = output.macroTrends.length;
  console.log(`\n✓ Schreef data/report-synthesis.json`);
  console.log(`  ${trendCount} macro-trends gesynthetiseerd uit ${extracted.length} rapporten`);
  if (trendCount > 0) {
    console.log("\nMacro-trends:");
    output.macroTrends.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.trend} [${t.horizon}] (${t.strength})`);
    });
  }
  console.log("\n✓ Klaar. Voeg nu ANTHROPIC_API_KEY toe en run:");
  console.log("  npm run synthesize-reports");
  console.log("  npm run synthesize   ← gebruikt voortaan ook de rapporten als context");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\n✗ Fatal:", err.message || err);
    process.exit(1);
  });
