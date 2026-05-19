#!/usr/bin/env node
/**
 * Culture Tracker — wekelijkse brand signals e-mail
 *
 * Leest data/latest.json en stuurt een gefocuste weekly HTML-mail met:
 *   - Top 3 culturele trends die relevant zijn voor merken
 *   - Per trend: wat er speelt, waarom het telt, wat merken kunnen doen
 *   - Urgentie-badges (nu / binnenkort / op de radar)
 *
 * Zelfde SMTP-variabelen als send-email.js:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO
 *
 * Optioneel:
 *   SMTP_SECURE   "true" voor directe TLS (port 465). Default: auto.
 *   PUBLIC_URL    bv. https://tracker.thisisdefiant.com
 *
 * Aanbevolen cadans: vrijdagochtend 08:00 (zie weekly-email.yml).
 */

"use strict";

const fs         = require("fs");
const path       = require("path");
const nodemailer = require("nodemailer");

const ROOT        = path.resolve(__dirname, "..");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("Ontbrekende env-var: " + name);
  return v;
}

function weekLabel() {
  const now = new Date();
  const day = now.getDay(); // 0=zo, 1=ma, ...5=vr, 6=za
  // Bereken maandag van deze week
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = function (d) {
    return d.toLocaleDateString("nl-BE", { day: "numeric", month: "long" });
  };
  return fmt(monday) + " – " + fmt(sunday) + " " + sunday.getFullYear();
}

// ─── Urgentie-badge ───────────────────────────────────────────────────────────

function urgencyBadge(urgency) {
  const map = {
    "nu":           { label: "⚡ Nu actie",      bg: "#fff0e0", color: "#b54a00", border: "#f5a623" },
    "binnenkort":   { label: "→ Binnenkort",     bg: "#e6f7ef", color: "#1a6b40", border: "#3dba7c" },
    "op de radar":  { label: "◎ Op de radar",    bg: "#f1f1ec", color: "#555",    border: "#bbb"    },
  };
  const m = urgency && map[urgency.toLowerCase()];
  if (!m) return "";
  return `<span style="display:inline-block;background:${m.bg};color:${m.color};
    border:1px solid ${m.border};padding:3px 10px;border-radius:999px;
    font-size:12px;font-weight:700;letter-spacing:0.02em;">${esc(m.label)}</span>`;
}

// ─── Categorie-pill ───────────────────────────────────────────────────────────

function categoryPill(cat) {
  if (!cat) return "";
  return `<span style="display:inline-block;background:#ede9ff;color:#4a2eb5;
    padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:0.07em;margin-left:6px;">${esc(cat)}</span>`;
}

// ─── Brand signal card ────────────────────────────────────────────────────────

function brandSignalCard(signal, index) {
  const num = ["01", "02", "03"][index] || String(index + 1).padStart(2, "0");
  const actions = (signal.what_brands_can_do || []).map(function (action, i) {
    return `<tr>
      <td valign="top" style="padding:0 10px 10px 0;width:20px;">
        <span style="display:inline-block;background:#111;color:#fff;border-radius:50%;
          width:20px;height:20px;line-height:20px;text-align:center;
          font-size:11px;font-weight:700;">${i + 1}</span>
      </td>
      <td valign="top" style="padding:0 0 10px;">
        <span style="font-size:14px;color:#111;line-height:1.55;">${esc(action)}</span>
      </td>
    </tr>`;
  }).join("\n");

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 28px;background:#fff;border:1px solid #e5e5e0;border-radius:8px;
         overflow:hidden;border-left:4px solid #111;">
  <tr>
    <td style="padding:0;">

      <!-- Nummer + header -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:18px 20px 0;">
            <span style="font-size:11px;font-weight:700;color:#9a9a94;
              letter-spacing:0.12em;text-transform:uppercase;">Trend ${esc(num)}</span>
            ${categoryPill(signal.category)}
          </td>
          <td align="right" valign="top" style="padding:16px 20px 0;">
            ${urgencyBadge(signal.urgency)}
          </td>
        </tr>
      </table>

      <!-- Trend titel -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;
              font-weight:700;line-height:1.25;color:#111;margin:0;
              letter-spacing:-0.02em;">${esc(signal.trend)}</h2>
          </td>
        </tr>
      </table>

      <!-- Wat er speelt -->
      ${signal.what_is_happening ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:12px 20px 0;">
            <p style="margin:0;font-size:15px;color:#111;line-height:1.65;">
              ${esc(signal.what_is_happening)}</p>
          </td>
        </tr>
      </table>` : ""}

      <!-- Waarom het telt voor merken -->
      ${signal.why_it_matters_for_brands ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <p style="margin:0;padding:10px 14px;background:#fafaf7;
              border-left:3px solid #d4600a;font-size:13px;color:#4a2000;
              font-style:italic;line-height:1.55;">
              <strong style="font-style:normal;color:#4a2000;">Waarom het telt voor merken:</strong>
              ${esc(signal.why_it_matters_for_brands)}</p>
          </td>
        </tr>
      </table>` : ""}

      <!-- Wat merken kunnen doen -->
      ${actions ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:14px 20px 0;">
            <p style="margin:0 0 10px;font-size:11px;font-weight:700;
              text-transform:uppercase;letter-spacing:0.1em;color:#6b6b6b;">
              Wat merken kunnen doen</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${actions}
            </table>
          </td>
        </tr>
      </table>` : ""}

      <!-- Spacer onder -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="padding:14px 0 0;">&nbsp;</td></tr>
      </table>

    </td>
  </tr>
</table>`;
}

// ─── Volledige HTML-mail ───────────────────────────────────────────────────────

function buildHTML(brief) {
  const publicUrl = process.env.PUBLIC_URL || "";
  const signals   = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];

  const week = weekLabel();

  // Fallback: geen brand signals beschikbaar
  if (signals.length === 0) {
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;padding:40px;color:#111;">
<h1>Zeitfeed Weekly</h1>
<p>Nog geen weekly brand signals beschikbaar. Run eerst <code>ai-synthesize.js</code> zodat de wekelijkse synthese klaar is.</p>
${publicUrl ? `<p><a href="${esc(publicUrl)}">Bekijk de volledige tracker online →</a></p>` : ""}
</body></html>`;
  }

  const cards = signals.map(function (s, i) { return brandSignalCard(s, i); }).join("\n");

  return [
    `<!doctype html>`,
    `<html lang="nl"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>Zeitfeed Weekly</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:#fafaf7;`,
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`,
    `color:#111;-webkit-font-smoothing:antialiased;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `  style="background:#fafaf7;">`,
    `<tr><td align="center" style="padding:28px 12px 56px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `  style="max-width:600px;">`,

    // Header
    `<tr><td style="padding:0 0 20px;border-bottom:3px solid #111;">`,
    `  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">`,
    `  <tr>`,
    `    <td>`,
    `      <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;`,
    `         letter-spacing:0.12em;color:#9a9a94;">by Culture Tracker</p>`,
    `      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;`,
    `          margin:0;letter-spacing:-0.02em;color:#111;line-height:1.2;">`,
    `        Zeitfeed Weekly</h1>`,
    `      <p style="margin:6px 0 0;color:#6b6b6b;font-size:13px;">`,
    `        ${esc(week)}</p>`,
    `    </td>`,
    `    <td align="right" valign="bottom">`,
    `      <span style="display:inline-block;background:#111;color:#fff;`,
    `        padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;`,
    `        letter-spacing:0.05em;">3 TRENDS</span>`,
    `    </td>`,
    `  </tr>`,
    `  </table>`,
    `</td></tr>`,

    // Intro
    `<tr><td style="padding:20px 0 24px;">`,
    `  <p style="margin:0;font-size:15px;color:#555;line-height:1.65;">`,
    `    De drie culturele trends die deze week het meest relevant zijn voor merkstrategen —`,
    `    met concrete acties en lessen.`,
    `  </p>`,
    `</td></tr>`,

    // Signal cards
    `<tr><td>${cards}</td></tr>`,

    // Footer
    `<tr><td style="padding:24px 0 0;border-top:1px solid #e5e5e0;">`,
    `  <p style="margin:0;font-size:11px;color:#9a9a94;line-height:1.6;">`,
    `    Zeitfeed Weekly &middot; wekelijkse synthese via Claude AI &middot;`,
    `    gebaseerd op ${brief.daily && brief.daily.intro ? esc(brief.daily.intro) : "RSS + Wikipedia + TikTok"}`,
    publicUrl ? `    &middot; <a href="${esc(publicUrl)}" style="color:#9a9a94;">Bekijk online &rarr;</a>` : "",
    `  </p>`,
    `</td></tr>`,

    `</table></td></tr></table>`,
    `</body></html>`,
  ].filter(Boolean).join("\n");
}

// ─── Plain-text fallback ──────────────────────────────────────────────────────

function buildText(brief) {
  const lines   = [];
  const signals = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];

  lines.push("ZEITFEED WEEKLY");
  lines.push("Week van " + weekLabel());
  lines.push("=".repeat(50));

  if (signals.length === 0) {
    lines.push("");
    lines.push("Nog geen weekly brand signals beschikbaar.");
    lines.push("Run eerst ai-synthesize.js.");
    return lines.join("\n");
  }

  signals.forEach(function (s, i) {
    lines.push("");
    lines.push("TREND " + (i + 1) + (s.urgency ? " [" + s.urgency.toUpperCase() + "]" : ""));
    lines.push(s.trend || "");
    lines.push("-".repeat(40));
    if (s.what_is_happening)       lines.push(s.what_is_happening);
    if (s.why_it_matters_for_brands) {
      lines.push("");
      lines.push("Waarom het telt: " + s.why_it_matters_for_brands);
    }
    if (s.what_brands_can_do && s.what_brands_can_do.length) {
      lines.push("");
      lines.push("Wat merken kunnen doen:");
      s.what_brands_can_do.forEach(function (a, j) {
        lines.push("  " + (j + 1) + ". " + a);
      });
    }
  });

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    throw new Error("Kan " + LATEST_PATH + " niet vinden. Run eerst ai-synthesize.js.");
  }

  const brief = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));

  const host   = required("SMTP_HOST");
  const port   = parseInt(process.env.SMTP_PORT || "587", 10);
  const user   = required("SMTP_USER");
  const pass   = required("SMTP_PASS");
  const from   = required("EMAIL_FROM");
  const to     = required("EMAIL_TO");
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  const subject = "Zeitfeed Weekly · " + weekLabel();

  console.log("→ Stuur weekly mail naar " + to + " via " + host + ":" + port);

  const info = await transporter.sendMail({
    from, to, subject,
    text: buildText(brief),
    html: buildHTML(brief),
  });

  console.log("✓ Verzonden. Message ID: " + info.messageId);
}

main().catch(function (err) {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
