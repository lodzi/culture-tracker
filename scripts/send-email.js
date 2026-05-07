#!/usr/bin/env node
/**
 * Culture Tracker — dagelijkse HTML-maildigest
 *
 * Leest data/latest.json en stuurt een volledig opgemaakte HTML-mail met:
 *   - Culture Radar (cross-categorie mega-trends)
 *   - Daily trends per categorie (AI-formaat met trajectory/streak)
 *   - Weekly patronen (indien beschikbaar)
 *
 * Vereiste env-vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO
 *
 * Optioneel:
 *   SMTP_SECURE   "true" voor directe TLS (port 465). Default: auto.
 *   PUBLIC_URL    bv. https://lodzi.github.io/culture-tracker
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

function formatDate(iso) {
  try {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("nl-BE", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  } catch (e) { return iso; }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("Ontbrekende env-var: " + name);
  return v;
}

// ─── HTML-bouwstenen ──────────────────────────────────────────────────────────

function sectionLabel(text) {
  return `
<tr><td style="padding:28px 0 10px;">
  <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;
     letter-spacing:0.1em;color:#6b6b6b;border-bottom:1px solid #e5e5e0;
     padding-bottom:8px;">${esc(text)}</p>
</td></tr>`;
}

function trajectoryBadge(t) {
  const map = {
    "opkomend":  { icon: "▲", color: "#1a7a46", bg: "#e6f7ef" },
    "piekend":   { icon: "●", color: "#c05800", bg: "#fff3e0" },
    "afbouwend": { icon: "▼", color: "#6b6b6b", bg: "#f1f1ec" },
  };
  const m = t && map[t];
  if (!m) return "";
  return `<span style="display:inline-block;background:${m.bg};color:${m.color};
    padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
    margin-right:4px;">${m.icon} ${esc(t)}</span>`;
}

function continuityBadge(insight) {
  if (insight.isNew !== false) {
    // isNew=true of niet ingevuld → nieuw vandaag
    return `<span style="display:inline-block;background:#e0f7f7;color:#0b6b6b;
      padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">✦ Nieuw vandaag</span>`;
  }
  if (insight.daysActive && insight.daysActive > 1) {
    return `<span style="display:inline-block;background:#ede9ff;color:#4a2eb5;
      padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;">↻ ${insight.daysActive} dagen actief</span>`;
  }
  return "";
}

function sourcePillsHTML(sources) {
  if (!sources || !sources.length) return "";
  const pills = sources.slice(0, 5).map(function (s) {
    return `<span style="display:inline-block;border:1px solid #e5e5e0;color:#6b6b6b;
      padding:2px 8px;border-radius:999px;font-size:11px;margin:2px 2px 0 0;">${esc(s)}</span>`;
  }).join("");
  return `<p style="margin:8px 0 0;">${pills}</p>`;
}

function articleLinksHTML(articles) {
  if (!articles || !articles.length) return "";
  const items = articles.slice(0, 3).map(function (a) {
    const title = esc(a.title || "Artikel");
    const src   = a.source ? ` <span style="color:#9a9a94;font-size:12px;">(${esc(a.source)})</span>` : "";
    return a.url
      ? `<li style="margin-bottom:5px;"><a href="${esc(a.url)}" style="color:#111;font-size:13px;line-height:1.45;">${title}</a>${src}</li>`
      : `<li style="margin-bottom:5px;font-size:13px;">${title}${src}</li>`;
  }).join("");
  return `<ul style="margin:10px 0 0;padding-left:18px;line-height:1.5;">${items}</ul>`;
}

function insightCard(insight) {
  const badgeCount   = (insight.sources || []).length;
  const leftBorder   = insight.trending ? "border-left:3px solid #d4600a;" : "border-left:3px solid #e5e5e0;";
  const sourceBadge  = insight.trending
    ? `<span style="display:inline-block;background:#fff0e6;color:#c05000;
        padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;">🔥 ${badgeCount} bronnen</span>`
    : (badgeCount >= 2
        ? `<span style="display:inline-block;background:#f1f1ec;color:#6b6b6b;
            padding:2px 8px;border-radius:999px;font-size:11px;white-space:nowrap;">${badgeCount} bronnen</span>`
        : "");

  const metaBadges = [
    trajectoryBadge(insight.trajectory),
    continuityBadge(insight),
  ].filter(Boolean).join(" ");

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 14px;background:#ffffff;border:1px solid #e5e5e0;border-radius:6px;${leftBorder}">
  <tr><td style="padding:16px 18px 16px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;
          line-height:1.3;color:#111;letter-spacing:-0.01em;">${esc(insight.trend)}</td>
      ${sourceBadge ? `<td align="right" valign="top" style="padding-left:10px;">${sourceBadge}</td>` : ""}
    </tr></table>
    ${metaBadges ? `<p style="margin:8px 0 0;">${metaBadges}</p>` : ""}
    ${insight.summary
      ? `<p style="margin:10px 0 0;font-size:15px;color:#111;line-height:1.65;">${esc(insight.summary)}</p>`
      : ""}
    ${insight.why_it_matters
      ? `<p style="margin:10px 0 0;padding:8px 12px;border-left:2px solid #e5e5e0;
           font-size:13px;color:#6b6b6b;font-style:italic;line-height:1.55;">
           <strong style="font-style:normal;color:#6b6b6b;">Waarom relevant:</strong>
           ${esc(insight.why_it_matters)}</p>`
      : ""}
    ${sourcePillsHTML(insight.sources)}
    ${articleLinksHTML(insight.articles)}
  </td></tr>
</table>`;
}

// ─── Culture Radar (cross-categorie) ──────────────────────────────────────────

function renderCultureRadar(crossCat) {
  const mega = (crossCat && Array.isArray(crossCat.megaTrends))
    ? crossCat.megaTrends.filter(function (m) { return m.trend; })
    : [];
  if (mega.length === 0) return "";

  const cards = mega.map(function (mt) {
    const strengthBadge = mt.strength === "sterk"
      ? `<span style="display:inline-block;background:#ede9ff;color:#4a2eb5;
          padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
          white-space:nowrap;">⚡ Sterk signaal</span>`
      : `<span style="display:inline-block;background:#ede9ff;color:#4a2eb5;
          padding:2px 8px;border-radius:999px;font-size:11px;white-space:nowrap;">Cross-categorie</span>`;
    const catPills = (mt.categories || []).map(function (c) {
      return `<span style="display:inline-block;background:#ede9ff;color:#4a2eb5;
        padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;
        text-transform:uppercase;letter-spacing:0.05em;margin:2px 2px 0 0;">${esc(c)}</span>`;
    }).join("");

    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 14px;background:#faf8ff;border:1px solid #d8d0ff;border-radius:6px;border-left:4px solid #6c47ff;">
  <tr><td style="padding:16px 18px 16px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;
          line-height:1.3;color:#111;">${esc(mt.trend)}</td>
      <td align="right" valign="top" style="padding-left:10px;">${strengthBadge}</td>
    </tr></table>
    ${mt.summary
      ? `<p style="margin:10px 0 0;font-size:15px;color:#111;line-height:1.65;">${esc(mt.summary)}</p>`
      : ""}
    ${mt.why_it_matters
      ? `<p style="margin:10px 0 0;padding:8px 12px;border-left:2px solid #6c47ff;
           font-size:13px;color:#6b6b6b;font-style:italic;line-height:1.55;">
           <strong style="font-style:normal;color:#6b6b6b;">Waarom:</strong>
           ${esc(mt.why_it_matters)}</p>`
      : ""}
    ${catPills ? `<p style="margin:10px 0 0;">${catPills}</p>` : ""}
  </td></tr>
</table>`;
  }).join("\n");

  return `
${sectionLabel("⚡ Culture Radar — mega-trends van vandaag")}
<tr><td style="padding:0 0 4px;">${cards}</td></tr>`;
}

// ─── Daily (AI-formaat: categories + insights) ────────────────────────────────

function renderDailyAI(daily) {
  const cats = Array.isArray(daily.categories) ? daily.categories : [];
  if (cats.length === 0) return "";

  return cats.map(function (cat) {
    const insights = cat.insights || [];
    if (insights.length === 0) return "";
    const cards = insights.map(insightCard).join("\n");
    return `
${sectionLabel(cat.label || cat.id)}
<tr><td style="padding:0 0 4px;">${cards}</td></tr>`;
  }).filter(Boolean).join("\n");
}

// ─── Fallback: raw topics (vóór AI synthesis) ─────────────────────────────────

function renderDailyRaw(daily) {
  const topics = Array.isArray(daily.topics) ? daily.topics : [];
  if (topics.length === 0) return "";

  const cards = topics.slice(0, 8).map(function (topic) {
    const badge = topic.trending
      ? `<span style="display:inline-block;background:#fff0e6;color:#c05000;
          padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;">🔥 ${topic.sourceCount} bronnen</span>`
      : "";
    const items = (topic.items || []).slice(0, 3).map(function (a) {
      const t = esc(a.title || "");
      return a.url
        ? `<li style="margin-bottom:5px;"><a href="${esc(a.url)}" style="color:#111;font-size:13px;">${t}</a></li>`
        : `<li style="margin-bottom:5px;font-size:13px;">${t}</li>`;
    }).join("");
    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 14px;background:#fff;border:1px solid #e5e5e0;border-radius:6px;">
  <tr><td style="padding:14px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#111;">${esc(topic.label)}</td>
      ${badge ? `<td align="right" valign="top" style="padding-left:10px;">${badge}</td>` : ""}
    </tr></table>
    ${items ? `<ul style="margin:8px 0 0;padding-left:18px;line-height:1.5;">${items}</ul>` : ""}
  </td></tr>
</table>`;
  }).join("\n");

  return `
${sectionLabel("Daily trends")}
<tr><td style="padding:0 0 4px;">${cards}</td></tr>`;
}

// ─── Weekly ───────────────────────────────────────────────────────────────────

function renderWeekly(weekly) {
  const cats = (weekly && Array.isArray(weekly.categories)) ? weekly.categories : [];
  if (cats.length === 0) return "";

  const intro = weekly.intro || ("Opkomende patronen van de afgelopen " + (weekly.daysAnalyzed || 7) + " dagen.");

  const sections = cats.map(function (cat) {
    const insights = (cat.insights || []).slice(0, 2);
    if (insights.length === 0) return "";
    const cards = insights.map(function (ins) {
      const momentumBadge = ins.momentum
        ? `<span style="display:inline-block;background:#e6f7ef;color:#1a7a46;
            padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
            white-space:nowrap;">${esc(ins.momentum)}</span>`
        : "";
      return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin:0 0 12px;background:#fff;border:1px solid #e5e5e0;border-radius:6px;">
  <tr><td style="padding:14px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-family:Georgia,serif;font-size:17px;font-weight:700;color:#111;
          line-height:1.3;">${esc(ins.trend)}</td>
      ${momentumBadge ? `<td align="right" valign="top" style="padding-left:10px;">${momentumBadge}</td>` : ""}
    </tr></table>
    ${ins.summary
      ? `<p style="margin:8px 0 0;font-size:14px;color:#111;line-height:1.6;">${esc(ins.summary)}</p>`
      : ""}
    ${ins.why_it_matters
      ? `<p style="margin:8px 0 0;padding:8px 12px;border-left:2px solid #e5e5e0;
           font-size:13px;color:#6b6b6b;font-style:italic;line-height:1.55;">
           <strong style="font-style:normal;">Culturele verschuiving:</strong>
           ${esc(ins.why_it_matters)}</p>`
      : ""}
  </td></tr>
</table>`;
    }).join("\n");
    return `${sectionLabel("Weekly · " + (cat.label || cat.id))}<tr><td style="padding:0 0 4px;">${cards}</td></tr>`;
  }).filter(Boolean).join("\n");

  if (!sections) return "";

  return `
<tr><td style="padding:32px 0 0;border-top:2px solid #e5e5e0;">
  <h2 style="font-family:Georgia,serif;font-size:20px;margin:0;color:#111;">Weekly patronen</h2>
  <p style="margin:4px 0 0;font-size:13px;color:#6b6b6b;font-style:italic;">${esc(intro)}</p>
</td></tr>
${sections}`;
}

// ─── Volledige HTML-mail ───────────────────────────────────────────────────────

function buildHTML(brief) {
  const publicUrl  = process.env.PUBLIC_URL || "";
  const dateLabel  = brief.date ? formatDate(brief.date) : "";
  const daily      = brief.daily || {};
  const dailyIntro = daily.intro || "";

  const dailyContent = (Array.isArray(daily.categories) && daily.categories.length > 0)
    ? renderDailyAI(daily)
    : renderDailyRaw(daily);

  return [
    `<!doctype html>`,
    `<html lang="nl"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>Culture Tracker — ${esc(dateLabel)}</title>`,
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
    `<tr><td style="padding:0 0 20px;border-bottom:2px solid #111;">`,
    `  <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;`,
    `      margin:0;letter-spacing:-0.02em;color:#111;">Culture Tracker</h1>`,
    dateLabel
      ? `  <p style="margin:6px 0 0;color:#6b6b6b;font-size:13px;">${esc(dateLabel)} &middot; dagelijkse trendsignalen</p>`
      : "",
    `</td></tr>`,

    // Intro
    dailyIntro
      ? `<tr><td style="padding:18px 0 0;"><p style="margin:0;font-size:15px;color:#6b6b6b;line-height:1.6;font-style:italic;">${esc(dailyIntro)}</p></td></tr>`
      : "",

    // Culture Radar
    renderCultureRadar(brief.crossCategory),

    // Daily
    dailyContent,

    // Weekly
    renderWeekly(brief.weekly),

    // Footer
    `<tr><td style="padding:32px 0 0;border-top:1px solid #e5e5e0;">`,
    `  <p style="margin:0;font-size:11px;color:#9a9a94;">`,
    `    Culture Tracker &middot; automatisch gegenereerd via Claude AI`,
    publicUrl ? ` &middot; <a href="${esc(publicUrl)}" style="color:#9a9a94;">Bekijk online &rarr;</a>` : "",
    `  </p>`,
    `</td></tr>`,

    `</table></td></tr></table>`,
    `</body></html>`,
  ].filter(Boolean).join("\n");
}

// ─── Plain-text fallback ──────────────────────────────────────────────────────

function buildText(brief) {
  const lines = [];
  const daily  = brief.daily || {};

  lines.push("CULTURE TRACKER — " + (brief.date || ""));
  lines.push("=".repeat(50));
  if (daily.intro) { lines.push(""); lines.push(daily.intro); }

  // Culture Radar
  const mega = brief.crossCategory && Array.isArray(brief.crossCategory.megaTrends)
    ? brief.crossCategory.megaTrends.filter(function (m) { return m.trend; }) : [];
  if (mega.length > 0) {
    lines.push(""); lines.push("⚡ CULTURE RADAR"); lines.push("-".repeat(30));
    mega.forEach(function (mt) {
      lines.push("");
      lines.push("# " + mt.trend);
      if (mt.summary)        lines.push(mt.summary);
      if (mt.why_it_matters) lines.push("Waarom: " + mt.why_it_matters);
      if (mt.categories)     lines.push("Categorieën: " + mt.categories.join(", "));
    });
  }

  // Daily
  const cats = Array.isArray(daily.categories) ? daily.categories : [];
  cats.forEach(function (cat) {
    lines.push(""); lines.push("── " + (cat.label || cat.id).toUpperCase());
    (cat.insights || []).forEach(function (ins) {
      lines.push("");
      const traj   = ins.trajectory ? " [" + ins.trajectory + "]" : "";
      const streak = ins.daysActive > 1
        ? " [" + ins.daysActive + " dagen]"
        : (ins.isNew !== false ? " [NIEUW]" : "");
      lines.push("• " + (ins.trend || "") + traj + streak);
      if (ins.summary)        lines.push("  " + ins.summary);
      if (ins.why_it_matters) lines.push("  → " + ins.why_it_matters);
      if (ins.sources)        lines.push("  Bronnen: " + ins.sources.join(", "));
      (ins.articles || []).slice(0, 2).forEach(function (a) {
        if (a.title) lines.push("  - " + a.title + (a.url ? "\n    " + a.url : ""));
      });
    });
  });

  // Weekly
  const weeklyCats = (brief.weekly && Array.isArray(brief.weekly.categories))
    ? brief.weekly.categories : [];
  if (weeklyCats.length > 0) {
    lines.push(""); lines.push(""); lines.push("WEEKLY PATRONEN");
    lines.push("=".repeat(30));
    weeklyCats.forEach(function (cat) {
      lines.push(""); lines.push("── " + (cat.label || cat.id).toUpperCase());
      (cat.insights || []).slice(0, 2).forEach(function (ins) {
        lines.push("• " + (ins.trend || ""));
        if (ins.summary) lines.push("  " + ins.summary);
      });
    });
  }

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

  const dateLabel = brief.date
    ? new Date(brief.date + "T00:00:00").toLocaleDateString("nl-BE", {
        weekday: "long", day: "numeric", month: "long",
      })
    : "";
  const subject = "Culture Tracker" + (dateLabel ? " — " + dateLabel : "");

  console.log("→ Stuur mail naar " + to + " via " + host + ":" + port + " (secure=" + secure + ")");

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
