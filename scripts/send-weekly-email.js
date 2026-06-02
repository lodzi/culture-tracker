#!/usr/bin/env node
/**
 * Culture Tracker — wekelijkse brand signals e-mail
 *
 * Leest data/latest.json en stuurt een gefocuste weekly HTML-mail met:
 *   - Top 3 culturele trends (elk uit een andere categorie) voor merken
 *   - Per trend: wat er speelt, waarom het telt, wat merken kunnen doen
 *   - Categorie-badge rechts in de kaart-header
 *
 * Branding: pas config/email-branding.json aan voor je eigen stijl.
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

const ROOT          = path.resolve(__dirname, "..");
const LATEST_PATH   = path.join(ROOT, "data", "latest.json");
const BRANDING_PATH = path.join(ROOT, "config", "email-branding.json");

// ─── Branding laden ───────────────────────────────────────────────────────────

function loadBranding() {
  const defaults = {
    brandName:        "Zeitfeed Weekly",
    tagline:          "Culturele trends voor merkstrategen",
    accentColor:      "#111111",
    accentColorAlt:   "#d4600a",
    backgroundColor:  "#fafaf7",
    cardBackground:   "#ffffff",
    cardBorder:       "#e5e5e0",
    headingFont:      "Georgia, 'Times New Roman', serif",
    bodyFont:         "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    categoryPillBg:   "#ede9ff",
    categoryPillColor:"#4a2eb5",
    logoUrl:          "",
    logoWidth:        "120",
    logoAlt:          "",
    footerText:       "Wekelijkse synthese via Claude AI",
  };
  if (!fs.existsSync(BRANDING_PATH)) return defaults;
  try {
    const loaded = JSON.parse(fs.readFileSync(BRANDING_PATH, "utf8"));
    return Object.assign({}, defaults, loaded);
  } catch (e) {
    console.warn("Waarschuwing: kon email-branding.json niet laden, gebruik defaults.");
    return defaults;
  }
}

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

// ─── Categorie-button ─────────────────────────────────────────────────────────

function categoryButton(cat, branding) {
  if (!cat) return "";
  const bg    = branding.categoryPillBg    || "#ede9ff";
  const color = branding.categoryPillColor || "#4a2eb5";
  return `<span style="display:inline-block;background:${bg};color:${color};
    padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:0.07em;">${esc(cat)}</span>`;
}

// ─── Brand signal card ────────────────────────────────────────────────────────

function brandSignalCard(signal, index, branding) {
  const num    = ["01", "02", "03"][index] || String(index + 1).padStart(2, "0");
  const accent = branding.accentColor    || "#111";
  const altCol = branding.accentColorAlt || "#d4600a";
  const cardBg = branding.cardBackground || "#fff";
  const cardBd = branding.cardBorder     || "#e5e5e0";
  const hFont  = branding.headingFont    || "Georgia,'Times New Roman',serif";
  const bgPage = branding.backgroundColor || "#fafaf7";

  const actions = (signal.what_brands_can_do || []).map(function (action, i) {
    return `<tr>
      <td valign="top" style="padding:0 10px 10px 0;width:20px;">
        <span style="display:inline-block;background:${accent};color:#fff;border-radius:50%;
          width:20px;height:20px;line-height:20px;text-align:center;
          font-size:11px;font-weight:700;">${i + 1}</span>
      </td>
      <td valign="top" style="padding:0 0 10px;">
        <span style="font-size:14px;color:${accent};line-height:1.55;">${esc(action)}</span>
      </td>
    </tr>`;
  }).join("\n");

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 28px;background:${cardBg};border:1px solid ${cardBd};border-radius:8px;
         overflow:hidden;border-left:4px solid ${accent};">
  <tr>
    <td style="padding:0;">

      <!-- Nummer + categorie-button -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:18px 20px 0;">
            <span style="font-size:11px;font-weight:700;color:#9a9a94;
              letter-spacing:0.12em;text-transform:uppercase;">Trend ${esc(num)}</span>
          </td>
          <td align="right" valign="top" style="padding:16px 20px 0;">
            ${categoryButton(signal.category, branding)}
          </td>
        </tr>
      </table>

      <!-- Trend titel -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <h2 style="font-family:${hFont};font-size:22px;
              font-weight:700;line-height:1.25;color:${accent};margin:0;
              letter-spacing:-0.02em;">${esc(signal.trend)}</h2>
          </td>
        </tr>
      </table>

      <!-- Wat er speelt -->
      ${signal.what_is_happening ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:12px 20px 0;">
            <p style="margin:0;font-size:15px;color:${accent};line-height:1.65;">
              ${esc(signal.what_is_happening)}</p>
          </td>
        </tr>
      </table>` : ""}

      <!-- Waarom het telt voor merken -->
      ${signal.why_it_matters_for_brands ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <p style="margin:0;padding:10px 14px;background:${bgPage};
              border-left:3px solid ${altCol};font-size:13px;color:${accent};
              font-style:italic;line-height:1.55;">
              <strong style="font-style:normal;">Waarom het telt voor merken:</strong>
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
  const branding  = loadBranding();
  const publicUrl = process.env.PUBLIC_URL || "";
  const signals   = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];

  const week    = weekLabel();
  const accent  = branding.accentColor    || "#111";
  const bgPage  = branding.backgroundColor || "#fafaf7";
  const cardBd  = branding.cardBorder     || "#e5e5e0";
  const hFont   = branding.headingFont    || "Georgia,'Times New Roman',serif";
  const bFont   = branding.bodyFont       || "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const brand   = branding.brandName      || "Zeitfeed Weekly";
  const tagline = branding.tagline        || "";
  const footer  = branding.footerText     || "Wekelijkse synthese via Claude AI";

  // ── Logo of merknaam ──────────────────────────────────────────────────────
  const logoBlock = branding.logoUrl
    ? `<img src="${esc(branding.logoUrl)}" width="${esc(branding.logoWidth)}" alt="${esc(branding.logoAlt || brand)}"
         style="display:block;max-width:${esc(branding.logoWidth)}px;height:auto;">`
    : `<h1 style="font-family:${hFont};font-size:26px;margin:0;
         letter-spacing:-0.02em;color:${accent};line-height:1.2;">${esc(brand)}</h1>`;

  // Fallback: geen brand signals beschikbaar
  if (signals.length === 0) {
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head>
<body style="font-family:${bFont};padding:40px;color:${accent};">
<h1>${esc(brand)}</h1>
<p>Nog geen weekly brand signals beschikbaar. Run eerst <code>ai-synthesize.js</code> zodat de wekelijkse synthese klaar is.</p>
${publicUrl ? `<p><a href="${esc(publicUrl)}">Bekijk de volledige tracker online →</a></p>` : ""}
</body></html>`;
  }

  const cards = signals.map(function (s, i) { return brandSignalCard(s, i, branding); }).join("\n");

  return [
    `<!doctype html>`,
    `<html lang="nl"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${esc(brand)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:${bgPage};`,
    `font-family:${bFont};`,
    `color:${accent};-webkit-font-smoothing:antialiased;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `  style="background:${bgPage};">`,
    `<tr><td align="center" style="padding:28px 12px 56px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `  style="max-width:600px;">`,

    // Header
    `<tr><td style="padding:0 0 20px;border-bottom:3px solid ${accent};">`,
    `  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">`,
    `  <tr>`,
    `    <td>`,
    `      ${logoBlock}`,
    tagline ? `      <p style="margin:6px 0 0;color:#6b6b6b;font-size:13px;">${esc(tagline)}</p>` : "",
    `      <p style="margin:6px 0 0;color:#6b6b6b;font-size:13px;">${esc(week)}</p>`,
    `    </td>`,
    `    <td align="right" valign="bottom">`,
    `      <span style="display:inline-block;background:${accent};color:#fff;`,
    `        padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;`,
    `        letter-spacing:0.05em;">3 TRENDS</span>`,
    `    </td>`,
    `  </tr>`,
    `  </table>`,
    `</td></tr>`,

    // Intro
    `<tr><td style="padding:20px 0 24px;">`,
    `  <p style="margin:0;font-size:15px;color:#555;line-height:1.65;">`,
    `    Drie culturele trends uit verschillende domeinen — elk met concrete acties voor merkstrategen.`,
    `  </p>`,
    `</td></tr>`,

    // Signal cards
    `<tr><td>${cards}</td></tr>`,

    // Footer
    `<tr><td style="padding:24px 0 0;border-top:1px solid ${cardBd};">`,
    `  <p style="margin:0;font-size:11px;color:#9a9a94;line-height:1.6;">`,
    `    ${esc(brand)} &middot; ${esc(footer)} &middot;`,
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
  const branding = loadBranding();
  const lines   = [];
  const signals = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];

  lines.push((branding.brandName || "ZEITFEED WEEKLY").toUpperCase());
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
    lines.push("TREND " + (i + 1) + (s.category ? " [" + s.category.toUpperCase() + "]" : ""));
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

  const branding = loadBranding();
  const subject = (branding.brandName || "Zeitfeed Weekly") + " · " + weekLabel();

  console.log("→ Stuur weekly mail naar " + to + " via " + host + ":" + port);

  const info = await transporter.sendMail({
    from: '"Zeitfeed Weekly" <' + from + ">", to, subject,
    text: buildText(brief),
    html: buildHTML(brief),
  });

  console.log("✓ Verzonden. Message ID: " + info.messageId);
}

main().catch(function (err) {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
