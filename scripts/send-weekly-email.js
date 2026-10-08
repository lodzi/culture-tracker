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
const ARCHIVE_DIR  = path.join(ROOT, "data", "archive");

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
  const branding   = loadBranding();
  const signals    = (brief.weeklyBrandSignals && Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals : [];
  const week       = weekLabel();
  const brand      = branding.brandName || "Zeitfeed Weekly";
  const logoUrl    = branding.logoUrl || "";
  const defiantUrl = branding.footerLinkUrl || "https://www.thisisdefiant.com";
  const footerTxt  = branding.footerButton || "Defiant — Ignite The Culture";
  const SERIF = "'Source Serif 4',Georgia,'Times New Roman',serif";
  const SANS  = "'Helvetica Neue',Helvetica,Arial,sans-serif";

  const head = ''
    + '<!doctype html>\n<html lang="en" xmlns="http://www.w3.org/1999/xhtml">\n<head>\n'
    + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta http-equiv="X-UA-Compatible" content="IE=edge">\n<meta name="x-apple-disable-message-reformatting">\n'
    + '<title>' + esc(brand) + '</title>\n'
    + '<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">\n'
    + '<style>\nbody{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}\n'
    + 'table{border-collapse:collapse;}\nimg{border:0;outline:none;text-decoration:none;}\na{text-decoration:none;}\n'
    + '@media only screen and (max-width:480px){h2{font-size:25px !important;}.c{padding-bottom:44px !important;padding-right:22px !important;}}\n'
    + '</style>\n</head>\n<body style="margin:0;padding:0;background:#fafaf7;" bgcolor="#fafaf7">\n'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fafaf7" style="background:#fafaf7;">\n'
    + '<tr><td align="center" style="padding:0 0 0 0;">\n'
    + '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->\n'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">\n'
    + '<tr><td colspan="2" style="padding:30px 28px 0 12px;">'
    + (logoUrl ? '<img src="'+esc(logoUrl)+'" width="400" alt="'+esc(brand)+'" style="display:block;width:400px;max-width:100%;height:auto;">'
               : '<span style="font-family:'+SERIF+';font-size:26px;font-weight:700;color:#111111;">'+esc(brand)+'</span>')
    + '</td></tr>\n'
    + '<tr><td colspan="2" style="padding:26px 28px 46px 28px;">\n'
    + '  <p style="margin:0;font-family:'+SERIF+';font-size:21px;line-height:1.5;color:#111111;">Three trends from different cultural domains, each with concrete actions for marketers and brand builders.</p>\n'
    + '  <p style="margin:10px 0 0;font-family:'+SANS+';font-size:13px;line-height:1.5;color:#6b6b66;">Zeitfeed Weekly, a free service from Defiant.</p>\n'
    + '</td></tr>\n';

  function block(s, first){
    const spacer = first ? '<tr><td height="4" style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>' : '';
    const actions = (s.what_brands_can_do||[]).map(function(a){
      return `<tr><td valign="top" width="18" style="padding:9px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="7" height="7" bgcolor="#fc000d" style="width:7px;height:7px;background:#fc000d;margin-top:9px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td>\n<td style="padding:0 0 8px;font-family:${SERIF};font-size:16px;line-height:1.55;color:#111111;">${esc(a)}</td></tr>`;
    }).join('');
    return `<tr><td style="padding:0 0 0 14px;"><!--[if !mso]><!--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${spacer}<tr><td valign="top" class="c" style="border-left:2px solid #fc000d;padding:0 28px 54px 22px;"><!--<![endif]--><!--[if !mso]><!--><div style="width:14px;height:14px;background:#fc000d;border-radius:50%;margin:4px 0 -18px -30px;font-size:0;line-height:0;">&nbsp;</div><!--<![endif]--><!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td colspan="3" width="14" valign="top" style="width:14px;height:14px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="14" height="14" bgcolor="#fc000d" style="width:14px;height:14px;background:#fc000d;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table></td><td valign="top" style="padding:0 28px 0 10px;"><![endif]--><p style="margin:0;padding-top:2px;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:700;color:#999999;">${esc(s.category||'')}</p><!--[if mso]></td></tr><tr><td width="6" style="width:6px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td width="2" bgcolor="#fc000d" style="width:2px;background:#fc000d;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td width="6" style="width:6px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td valign="top" style="padding:0 28px 54px 10px;"><![endif]--><h2 style="margin:8px 0 16px;font-family:${SERIF};font-size:29px;line-height:1.16;font-weight:700;letter-spacing:-0.012em;color:#111111;">${esc(s.trend||'')}</h2>
  <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.66;color:#26262a;">${esc(s.what_is_happening||'')}</p>
  <p style="margin:24px 0 0;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:700;color:#fc000d;">Why it matters for brands</p>
  <p style="margin:6px 0 0;font-family:${SERIF};font-size:17px;line-height:1.6;font-style:italic;color:#111111;">${esc(s.why_it_matters_for_brands||'')}</p>
  <p style="margin:24px 0 10px;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:700;color:#111111;">What brands can do</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${actions}</table><!--[if !mso]><!--></td></tr></table><!--<![endif]--><!--[if mso]></td></tr></table><![endif]--></td></tr>`;
  }

  const bodyBlocks = signals.map(function(s,i){ return block(s, i===0); }).join('\n');

  const footer = `<tr><td style="padding:0 0 0 14px;"><!--[if !mso]><!--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" class="c" style="padding:0 28px 60px 24px;"><!--<![endif]--><!--[if !mso]><!--><div style="width:18px;height:18px;background:#fc000d;border-radius:50%;margin:4px 0 -22px -32px;font-size:0;line-height:0;">&nbsp;</div><!--<![endif]--><!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td colspan="3" width="18" valign="top" style="width:18px;height:18px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="18" height="18" bgcolor="#fc000d" style="width:18px;height:18px;background:#fc000d;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table></td><td valign="top" style="padding:0 28px 0 6px;"><![endif]--><p style="margin:0 0 16px;padding-top:4px;font-family:${SANS};font-size:12px;line-height:1.6;color:#8a8a84;">This is ${esc(brand)} from ${esc(week)}</p><!--[if mso]></td></tr><tr><td width="8" style="width:8px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td width="2" style="width:2px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td width="8" style="width:8px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td><td valign="top" style="padding:0 28px 60px 6px;"><![endif]--><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#fc000d" style="background:#fc000d;padding:15px 24px;"><a href="${esc(defiantUrl)}" style="font-family:${SANS};font-size:15px;line-height:1.3;font-weight:700;color:#ffffff;text-decoration:none;">${esc(footerTxt)}</a></td></tr></table><!--[if !mso]><!--></td></tr></table><!--<![endif]--><!--[if mso]></td></tr></table><![endif]--></td></tr>`;

  const tail = '\n</table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr>\n</table>\n</body>\n</html>';

  if (signals.length === 0) {
    return head + '<tr><td colspan="2" style="padding:0 28px 54px 28px;font-family:'+SERIF+';font-size:17px;color:#111111;">No weekly brand signals available yet. Run ai-synthesize.js first.</td></tr>' + footer + tail;
  }
  return head + bodyBlocks + '\n' + footer + tail;
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

// ─── Signals-bron met fallback ────────────────────────────────────────────────
// Haalt de brand-signals uit een brief-object (latest.json of archief-snapshot).
function extractSignals(brief) {
  return (brief && brief.weeklyBrandSignals &&
          Array.isArray(brief.weeklyBrandSignals.weeklyBrandSignals))
    ? brief.weeklyBrandSignals.weeklyBrandSignals
    : [];
}

// Kies de te versturen brief. Voorkeur: latest.json. Als die (uitzonderlijk)
// geen signals bevat, val terug op de meest recente archief-snapshot die ze
// wél heeft. Zo ontvangt de live lijst nooit de lege fallback-tekst.
function loadBriefWithSignals() {
  if (!fs.existsSync(LATEST_PATH)) {
    throw new Error("Kan " + LATEST_PATH + " niet vinden. Run eerst ai-synthesize.js.");
  }
  const latest = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));
  if (extractSignals(latest).length > 0) return latest;

  console.warn("Waarschuwing: latest.json bevat geen brand signals — zoek in archief…");
  let files = [];
  try {
    files = fs.readdirSync(ARCHIVE_DIR)
      .filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); })
      .sort()
      .reverse();
  } catch (e) { /* geen archief */ }

  for (const f of files) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf8"));
      if (extractSignals(snap).length > 0) {
        console.warn("  ↩ Gebruik archief-snapshot " + f + " (" +
          extractSignals(snap).length + " signals).");
        return snap;
      }
    } catch (e) { /* skip corrupt */ }
  }
  return null; // nergens signals gevonden
}

async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    throw new Error("Kan " + LATEST_PATH + " niet vinden. Run eerst ai-synthesize.js.");
  }

  const brief = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));

  // Testmodus: stuur enkel een Mailchimp-testmail naar vaste adressen i.p.v.
  // een echte campagne naar de hele lijst. Activeer met `--test` of TEST_MODE=1.
  const isTest = process.argv.includes("--test") || process.env.TEST_MODE === "1";

  const apiKey    = required("MAILCHIMP_API_KEY");
  const listId    = required("MAILCHIMP_LIST_ID");
  const fromName  = required("EMAIL_FROM_NAME");
  const fromEmail = required("EMAIL_FROM_EMAIL");

  mailchimp.setConfig({
    apiKey,
    server: datacenterFromKey(apiKey),
  });

  const branding = loadBranding();
  const subject  = (isTest ? "[TEST] " : "") +
                   (branding.brandName || "Zeitfeed Weekly") + " · " + weekLabel();

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

  if (isTest) {
    // 3a. Testmail: enkel naar vaste ontvangers (override via TEST_EMAIL_TO,
    //     komma-gescheiden). Raakt de lijst niet.
    const recipients = (process.env.TEST_EMAIL_TO ||
        "lode@thisisdefiant.com,maarten@thisisdefiant.com")
      .split(",").map(function (e) { return e.trim(); }).filter(Boolean);

    console.log("→ Testmail versturen naar: " + recipients.join(", ") + "…");
    await mailchimp.campaigns.sendTestEmail(campaignId, {
      test_emails: recipients,
      send_type:   "html",
    });

    // Draft-campagne opruimen zodat er geen testcampagnes opstapelen.
    try {
      await mailchimp.campaigns.remove(campaignId);
      console.log("  Test-draft verwijderd.");
    } catch (e) {
      console.warn("  Kon test-draft niet verwijderen: " + (e.message || e));
    }

    console.log("✓ Testmail verstuurd via Mailchimp (lijst ongemoeid).");
    return;
  }

  // 3b. Versturen naar de volledige lijst
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
