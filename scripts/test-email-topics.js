#!/usr/bin/env node
/**
 * CultureTracker — TESTFASE, stap 1b (donderdag)
 *
 * Mailt de 6 gegenereerde topics naar het testteam (Maarten + Lode), zodat
 * zij kunnen meelezen. De eigenlijke keuze maakt Lode in het lokale bestand
 * test/topics-YYYY-MM-DD.md (SELECTION-regel).
 *
 * Verstuurt via SMTP (zelfde env-variabelen als de dagelijkse mail):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
 * Ontvangers:
 *   TEST_TOPICS_TO   komma-gescheiden lijst (bv. "maarten@x.be, lode@y.be").
 *                    Valt terug op EMAIL_TO als niet gezet.
 *
 * Gebruik: node scripts/test-email-topics.js
 */

"use strict";

const fs         = require("fs");
const path       = require("path");
const nodemailer = require("nodemailer");

const ROOT     = path.resolve(__dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("Ontbrekende env-var: " + name);
  return v;
}

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function findLatestSnapshot() {
  if (!fs.existsSync(TEST_DIR)) return null;
  const files = fs.readdirSync(TEST_DIR)
    .filter(function (f) { return /^topics-\d{4}-\d{2}-\d{2}\.json$/.test(f); })
    .sort().reverse();
  return files.length ? path.join(TEST_DIR, files[0]) : null;
}

function buildHtml(signals, date) {
  const cards = signals.map(function (s, i) {
    const actions = (s.what_brands_can_do || []).map(function (a) {
      return "<li style=\"margin:0 0 4px;\">" + esc(a) + "</li>";
    }).join("");
    return `
    <div style="border:1px solid #e5e5e0;border-left:4px solid #111;border-radius:8px;padding:16px 20px;margin:0 0 18px;">
      <div style="font-size:12px;font-weight:700;color:#9a9a94;text-transform:uppercase;letter-spacing:.08em;">
        Topic ${i + 1}${s.category ? " · " + esc(s.category) : ""}
      </div>
      <h2 style="font-family:Georgia,serif;font-size:20px;margin:6px 0 10px;color:#111;">${esc(s.trend)}</h2>
      ${s.what_is_happening ? `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#222;">${esc(s.what_is_happening)}</p>` : ""}
      ${s.why_it_matters_for_brands ? `<p style="margin:0 0 10px;padding:8px 12px;background:#fafaf7;border-left:3px solid #fc000d;font-size:13px;font-style:italic;color:#222;"><strong style="font-style:normal;">Why it matters for brands:</strong> ${esc(s.why_it_matters_for_brands)}</p>` : ""}
      ${(s.what_brands_can_do || []).length ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b6b6b;">What brands can do</p><ul style="margin:0;padding-left:20px;font-size:14px;color:#222;line-height:1.5;">${actions}</ul>` : ""}
    </div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#fafaf7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;">
  <div style="max-width:640px;margin:0 auto;">
    <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 6px;">CultureTracker — 6 topics ter keuze</h1>
    <p style="font-size:14px;color:#555;margin:0 0 18px;">${esc(date)} · testfase</p>
    <div style="background:#111;color:#fff;border-radius:8px;padding:16px 20px;margin:0 0 22px;font-size:14px;line-height:1.6;">
      Kies 3 van de 6 topics hieronder. Open <code style="background:#333;padding:1px 5px;border-radius:3px;">test/topics-${esc(date)}.md</code>
      en vul de <strong>SELECTION</strong>-regel in met 3 nummers (bv. <code style="background:#333;padding:1px 5px;border-radius:3px;">SELECTION: 1, 3, 5</code>).
      Vrijdag stuurt Mailchimp de 3 gekozen topics naar de audience.
    </div>
    ${cards}
    <p style="font-size:12px;color:#9a9a94;margin:24px 0 0;">CultureTracker testfase · brought to you by Defiant</p>
  </div>
</body></html>`;
}

function buildText(signals, date) {
  const lines = ["CultureTracker — 6 topics ter keuze (" + date + ")", ""];
  lines.push("Kies 3 topics: open test/topics-" + date + ".md en vul de SELECTION-regel in (bv. SELECTION: 1, 3, 5).");
  lines.push("");
  signals.forEach(function (s, i) {
    lines.push((i + 1) + ". " + (s.trend || "") + (s.category ? " [" + s.category + "]" : ""));
    if (s.what_is_happening) lines.push("   " + s.what_is_happening);
    if (s.why_it_matters_for_brands) lines.push("   Why it matters for brands: " + s.why_it_matters_for_brands);
    (s.what_brands_can_do || []).forEach(function (a) { lines.push("   - " + a); });
    lines.push("");
  });
  return lines.join("\n");
}

async function main() {
  const snapPath = findLatestSnapshot();
  if (!snapPath) throw new Error("Geen test/topics-*.json snapshot gevonden. Run eerst test-generate-topics.js.");

  const snapshot = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  const signals  = Array.isArray(snapshot.signals) ? snapshot.signals : [];
  const date     = snapshot.date || "";
  if (signals.length === 0) throw new Error("Snapshot bevat geen signalen.");

  const host   = required("SMTP_HOST");
  const port   = parseInt(process.env.SMTP_PORT || "587", 10);
  const user   = required("SMTP_USER");
  const pass   = required("SMTP_PASS");
  const from   = required("EMAIL_FROM");
  const to     = (process.env.TEST_TOPICS_TO || process.env.EMAIL_TO || "").trim();
  if (!to) throw new Error("Geen ontvangers: zet TEST_TOPICS_TO of EMAIL_TO.");
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  console.log("→ Stuur 6 topics naar " + to + " via " + host + ":" + port);
  const info = await transporter.sendMail({
    from: '"CultureTracker Test" <' + from + ">",
    to,
    subject: "CultureTracker — 6 topics ter keuze (" + date + ")",
    text: buildText(signals, date),
    html: buildHtml(signals, date),
  });
  console.log("✓ Verzonden. Message ID: " + info.messageId);
}

main().catch(function (err) {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
