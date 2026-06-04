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
 * Vereiste env-variabelen:
 *   MAILCHIMP_API_KEY   bv. abc123...–us21
 *   MAILCHIMP_LIST_ID   audience/list ID in Mailchimp
 *   EMAIL_FROM_NAME     bv. "Zeitfeed Weekly"
 *   EMAIL_FROM_EMAIL    bv. zeitfeed@thisisdefiant.com
 *
 * Optioneel:
 *   PUBLIC_URL    bv. https://tracker.thisisdefiant.com
 *
 * Aanbevolen cadans: vrijdagochtend 08:00 (zie weekly-email.yml).
 */

"use strict";

const fs         = require("fs");
const path       = require("path");
const mailchimp  = require("@mailchimp/mailchimp_marketing");

const ROOT          = path.resolve(__dirname, "..");
const LATEST_PATH   = path.join(ROOT, "data", "latest.json");
const BRANDING_PATH = path.join(ROOT, "config", "email-branding.json");

// ─── Branding laden ───────────────────────────────────────────────────────────

function loadBranding() {
  const defaults = {
    brandName:        "Zeitfeed Weekly",
    tagline:          "Cultural trends for brand strategists",
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
    footerText:       "Weekly synthesis via Claude AI",
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

// Haal de datacenter-suffix uit de API key (bv. "abc123–us21" → "us21")
function datacenterFromKey(apiKey) {
  const parts = apiKey.split("-");
  if (parts.length < 2) throw new Error("Ongeldige MAILCHIMP_API_KEY — verwacht formaat: key-dc (bv. abc123-us21)");
  return parts[parts.length - 1];
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
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
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

      <!-- Number + category button -->
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

      <!-- Trend title -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <h2 style="font-family:${hFont};font-size:22px;
              font-weight:700;line-height:1.25;color:${accent};margin:0;
              letter-spacing:-0.02em;">${esc(signal.trend)}</h2>
          </td>
        </tr>
      </table>

      <!-- What is happening -->
      ${signal.what_is_happening ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:12px 20px 0;">
            <p style="margin:0;font-size:15px;color:${accent};line-height:1.65;">
              ${esc(signal.what_is_happening)}</p>
          </td>
        </tr>
      </table>` : ""}

      <!-- Why it matters for brands -->
      ${signal.why_it_matters_for_brands ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 20px 0;">
            <p style="margin:0;padding:10px 14px;background:${bgPage};
              border-left:3px solid #fc000d;font-size:13px;color:${accent};
              font-style:italic;line-height:1.55;">
              <strong style="font-style:normal;">Why it matters for brands:</strong>
              ${esc(signal.why_it_matters_for_brands)}</p>
          </td>
        </tr>
      </table>` : ""}

      <!-- What brands can do -->
      ${actions ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:14px 20px 0;">
            <p style="margin:0 0 10px;font-size:11px;font-weight:700;
              text-transform:uppercase;letter-spacing:0.1em;color:#6b6b6b;">
              What brands can do</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${actions}
            </table>
          </td>
        </tr>
      </table>` : ""}

      <!-- Spacer below -->
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
  const defiantUrl = branding.footerLinkUrl || "https://www.thisisdefiant.com";

  // ── Logo of merknaam ──────────────────────────────────────────────────────
  const logoBlock = branding.logoUrl
    ? `<img src="${esc(branding.logoUrl)}" width="${esc(branding.logoWidth)}" alt="${esc(branding.logoAlt || brand)}"
         style="display:block;max-width:${esc(branding.logoWidth)}px;height:auto;">`
    : `<h1 style="font-family:${hFont};font-size:26px;margin:0;
         letter-spacing:-0.02em;color:${accent};line-height:1.2;">${esc(brand)}</h1>`;

  // Fallback: geen brand signals beschikbaar
  if (signals.length === 0) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:${bFont};padding:40px;color:${accent};">
<h1>${esc(brand)}</h1>
<p>No weekly brand signals available yet. Run <code>ai-synthesize.js</code> first so the weekly synthesis is ready.</p>
${publicUrl ? `<p><a href="${esc(publicUrl)}">View the full tracker online →</a></p>` : ""}
</body></html>`;
  }

  const cards = signals.map(function (s, i) { return brandSignalCard(s, i, branding); }).join("\n");

  return [
    `<!doctype html>`,
    `<html lang="en"><head>`,
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

    // Header — alleen het logo
    `<tr><td style="padding:0 0 20px;">`,
    `  ${logoBlock}`,
    `</td></tr>`,

    // Intro — volledige breedte, zwarte achtergrond, witte tekst
    `<tr><td style="padding:0 0 24px;">`,
    `  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `    style="background:${accent};border-radius:8px;">`,
    `  <tr><td style="padding:24px 28px;">`,
    `    <p style="margin:0;font-size:15px;color:#ffffff;line-height:1.65;">`,
    `      Three trends from different cultural domains, each with concrete actions for marketers and brand builders. Zeitfeed Weekly, a free service from Defiant.`,
    `    </p>`,
    `  </td></tr>`,
    `  </table>`,
    `</td></tr>`,

    // Signal cards
    `<tr><td>${cards}</td></tr>`,

    // Footer
    `<tr><td style="padding:24px 0 0;border-top:1px solid ${cardBd};">`,
    `  <p style="margin:0;font-size:11px;color:#9a9a94;line-height:1.6;">This is ${esc(brand)} from ${esc(week)}</p>`,
    `</td></tr>`,

    // Red sign-off block — centered white text
    `<tr><td style="padding:16px 0 0;">`,
    `  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`,
    `    style="background:#fc000d;border-radius:8px;">`,
    `  <tr><td align="center" style="padding:16px 20px;">`,
    `    <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#ffffff;line-height:1.5;">`,
    `      <a href="${esc(defiantUrl)}" style="color:#ffffff;text-decoration:none;">Defiant &mdash; Ignite The Culture</a>`,
    `    </p>`,
    `  </td></tr>`,
    `  </table>`,
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
  lines.push("Week of " + weekLabel());
  lines.push("=".repeat(50));

  if (signals.length === 0) {
    lines.push("");
    lines.push("No weekly brand signals available yet.");
    lines.push("Run ai-synthesize.js first.");
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
      lines.push("Why it matters: " + s.why_it_matters_for_brands);
    }
    if (s.what_brands_can_do && s.what_brands_can_do.length) {
      lines.push("");
      lines.push("What brands can do:");
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

  const apiKey    = required("MAILCHIMP_API_KEY");
  const listId    = required("MAILCHIMP_LIST_ID");
  const fromName  = required("EMAIL_FROM_NAME");
  const fromEmail = required("EMAIL_FROM_EMAIL");

  mailchimp.setConfig({
    apiKey,
    server: datacenterFromKey(apiKey),
  });

  const branding = loadBranding();
  const subject  = (branding.brandName || "Zeitfeed Weekly") + " · " + weekLabel();

  // 1. Campagne aanmaken
  console.log("→ Mailchimp campagne aanmaken…");
  const campaign = await mailchimp.campaigns.create({
    type: "regular",
    recipients: { list_id: listId },
    settings: {
      subject_line: subject,
      from_name:    fromName,
      reply_to:     fromEmail,
    },
  });
  const campaignId = campaign.id;
  console.log("  Campagne ID: " + campaignId);

  // 2. HTML-inhoud instellen
  console.log("→ Content instellen…");
  await mailchimp.campaigns.setContent(campaignId, {
    html:       buildHTML(brief),
    plain_text: buildText(brief),
  });

  // 3. Versturen
  console.log("→ Versturen naar lijst " + listId + "…");
  await mailchimp.campaigns.send(campaignId);

  console.log("✓ Weekly email verstuurd via Mailchimp. Campagne ID: " + campaignId);
}

if (require.main === module) {
  main().catch(function (err) {
    // Mailchimp API-fouten bevatten soms extra detail in err.response.text
    const detail = err.response && err.response.text ? " — " + err.response.text : "";
    console.error("Fatal:", (err.message || err) + detail);
    process.exit(1);
  });
}

module.exports = { buildHTML, buildText };
