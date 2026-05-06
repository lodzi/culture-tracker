#!/usr/bin/env node
/**
 * Culture Tracker — send daily email
 *
 * Reads /data/latest.json and emails it as a clean editorial HTML digest
 * with three sections: Daily Signals, Weekly Hypes, Monthly Trends.
 *
 * Required env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO
 *
 * Optional env:
 *   SMTP_SECURE   "true" to force TLS on connect (port 465). Default: auto.
 *   PUBLIC_URL    e.g. https://culture.yourdomain.com — used for the "view online" link.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const ROOT = path.resolve(__dirname, "..");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");

// --- Helpers ---
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  try {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  } catch (e) { return iso; }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing required env var: " + name);
  return v;
}

function scoreBadge(score) {
  if (typeof score !== "number") return "";
  return '<span style="display:inline-block;background:#f1f1ec;color:#333;padding:2px 8px;border-radius:999px;font-size:11px;font-variant-numeric:tabular-nums;">★ ' + score + '/10</span>';
}

function sectionHeader(label) {
  return [
    '<tr><td style="padding:28px 4px 8px;">',
    '  <p style="margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b6b;">' + escapeHtml(label) + '</p>',
    '</td></tr>',
  ].join("\n");
}

// --- Daily ---
function renderDailyHTML(daily) {
  const themes = (daily && daily.themes) || [];
  if (themes.length === 0) return "";

  const themesHtml = themes.map(function (theme) {
    const itemsHtml = (theme.items || []).map(function (item) {
      const titleHtml = item.url
        ? '<a href="' + escapeHtml(item.url) + '" style="color:#111;text-decoration:none;">' + escapeHtml(item.title || "Untitled") + '</a>'
        : escapeHtml(item.title || "Untitled");
      const sourceLine = item.source
        ? (item.url
            ? '<a href="' + escapeHtml(item.url) + '" style="color:#6b6b6b;text-decoration:none;">' + escapeHtml(item.source) + '</a>'
            : escapeHtml(item.source))
        : "";
      const meta = [item.category ? escapeHtml(item.category) : "", sourceLine].filter(Boolean).join(" &middot; ");

      return [
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;background:#ffffff;border:1px solid #e5e5e0;border-radius:6px;">',
        '  <tr><td style="padding:14px 16px;">',
        '    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">',
        '      <tr>',
        '        <td style="font-size:15px;font-weight:600;line-height:1.35;color:#111;">' + titleHtml + '</td>',
        scoreBadge(item.score) ? '        <td align="right" style="padding-left:10px;white-space:nowrap;">' + scoreBadge(item.score) + '</td>' : '',
        '      </tr>',
        '    </table>',
        item.summary ? '    <p style="margin:8px 0 0;font-size:14px;color:#111;line-height:1.55;">' + escapeHtml(item.summary) + '</p>' : '',
        item.cultural_relevance ? '    <p style="margin:8px 0 0;padding-left:10px;border-left:2px solid #e5e5e0;font-size:13px;color:#6b6b6b;font-style:italic;line-height:1.55;">' + escapeHtml(item.cultural_relevance) + '</p>' : '',
        meta ? '    <p style="margin:10px 0 0;font-size:12px;color:#6b6b6b;">' + meta + '</p>' : '',
        '  </td></tr>',
        '</table>',
      ].filter(Boolean).join("\n");
    }).join("\n");

    return [
      '<div style="margin:0 0 24px;">',
      '  <h3 style="font-family:Georgia,serif;font-size:19px;margin:0 0 4px;color:#111;letter-spacing:-0.01em;">' + escapeHtml(theme.title || "Untitled theme") + '</h3>',
      theme.summary ? '  <p style="margin:0 0 10px;color:#6b6b6b;font-size:14px;">' + escapeHtml(theme.summary) + '</p>' : '',
      itemsHtml,
      '</div>',
    ].filter(Boolean).join("\n");
  }).join("\n");

  return [
    sectionHeader("Daily signals"),
    '<tr><td style="padding:0 4px;">' + themesHtml + '</td></tr>',
  ].join("\n");
}

// --- Weekly ---
function renderHypeHTML(h) {
  const cats = (h.categories || []).map(function (c) {
    return '<span style="display:inline-block;background:#f1f1ec;color:#333;padding:3px 8px;border-radius:999px;font-size:11px;text-transform:lowercase;margin-right:4px;">' + escapeHtml(c) + '</span>';
  }).join("");
  const signalsList = (h.signals || []).map(function (s) {
    return '<li style="margin-bottom:4px;">' + escapeHtml(s) + '</li>';
  }).join("");

  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;background:#ffffff;border:1px solid #e5e5e0;border-radius:6px;">',
    '  <tr><td style="padding:16px 18px;">',
    '    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">',
    '      <tr>',
    '        <td style="font-family:Georgia,serif;font-size:18px;font-weight:600;line-height:1.3;color:#111;letter-spacing:-0.01em;">' + escapeHtml(h.title || "Untitled hype") + '</td>',
    scoreBadge(h.score) ? '        <td align="right" style="padding-left:10px;white-space:nowrap;">' + scoreBadge(h.score) + '</td>' : '',
    '      </tr>',
    '    </table>',
    h.description ? '    <p style="margin:8px 0 0;font-size:14px;color:#111;line-height:1.55;">' + escapeHtml(h.description) + '</p>' : '',
    h.why_it_matters ? '    <p style="margin:10px 0 0;padding:10px 12px;background:#f1f1ec;border-radius:6px;font-size:13px;color:#111;line-height:1.55;"><strong>Why it matters:</strong> ' + escapeHtml(h.why_it_matters) + '</p>' : '',
    signalsList ? '    <p style="margin:12px 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b6b;">Signals</p><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:#111;">' + signalsList + '</ul>' : '',
    cats ? '    <p style="margin:12px 0 0;">' + cats + '</p>' : '',
    '  </td></tr>',
    '</table>',
  ].filter(Boolean).join("\n");
}

function renderWeeklyHTML(hypes) {
  if (!hypes || hypes.length === 0) return "";
  return [
    sectionHeader("Weekly hypes"),
    '<tr><td style="padding:0 4px 4px;"><p style="margin:0 0 12px;color:#6b6b6b;font-size:13px;font-style:italic;">Patterns gaining traction across multiple sources this week.</p>' + hypes.map(renderHypeHTML).join("\n") + '</td></tr>',
  ].join("\n");
}

// --- Monthly ---
function renderTrendHTML(t) {
  const evidenceList = (t.evidence || []).map(function (s) {
    return '<li style="margin-bottom:4px;">' + escapeHtml(s) + '</li>';
  }).join("");

  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;background:#ffffff;border:1px solid #e5e5e0;border-radius:6px;">',
    '  <tr><td style="padding:16px 18px;">',
    '    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">',
    '      <tr>',
    '        <td style="font-family:Georgia,serif;font-size:18px;font-weight:600;line-height:1.3;color:#111;letter-spacing:-0.01em;">' + escapeHtml(t.title || "Untitled trend") + '</td>',
    scoreBadge(t.score) ? '        <td align="right" style="padding-left:10px;white-space:nowrap;">' + scoreBadge(t.score) + '</td>' : '',
    '      </tr>',
    '    </table>',
    t.description ? '    <p style="margin:8px 0 0;font-size:14px;color:#111;line-height:1.55;">' + escapeHtml(t.description) + '</p>' : '',
    t.cultural_shift ? '    <p style="margin:10px 0 0;padding:10px 12px;background:#f1f1ec;border-radius:6px;font-size:13px;color:#111;line-height:1.55;"><strong>Cultural shift:</strong> ' + escapeHtml(t.cultural_shift) + '</p>' : '',
    evidenceList ? '    <p style="margin:12px 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b6b;">Evidence</p><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:#111;">' + evidenceList + '</ul>' : '',
    t.implications ? '    <p style="margin:12px 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b6b;">Implications</p><p style="margin:0;font-size:13px;line-height:1.55;color:#111;">' + escapeHtml(t.implications) + '</p>' : '',
    '  </td></tr>',
    '</table>',
  ].filter(Boolean).join("\n");
}

function renderMonthlyHTML(trends) {
  if (!trends || trends.length === 0) return "";
  return [
    sectionHeader("Monthly trends"),
    '<tr><td style="padding:0 4px 4px;"><p style="margin:0 0 12px;color:#6b6b6b;font-size:13px;font-style:italic;">Macro shifts spanning weeks or months.</p>' + trends.map(renderTrendHTML).join("\n") + '</td></tr>',
  ].join("\n");
}

// --- Full HTML ---
function renderHTML(brief) {
  const publicUrl = process.env.PUBLIC_URL || "";
  const dateLabel = brief.date ? formatDate(brief.date) : "";
  const daily = brief.daily || {};
  const dailyTitle = daily.title || "Daily Culture Brief";
  const dailyIntro = daily.intro || "";

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>' + escapeHtml(dailyTitle) + '</title></head>',
    '<body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafaf7;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;">',
    '  <tr><td style="padding:0 4px 16px;border-bottom:1px solid #e5e5e0;">',
    '    <h1 style="font-family:Georgia,serif;font-size:26px;margin:0;letter-spacing:-0.02em;color:#111;">Culture Tracker</h1>',
    dateLabel ? '    <p style="margin:4px 0 0;color:#6b6b6b;font-size:13px;">' + escapeHtml(dateLabel) + ' &middot; daily signals</p>' : '',
    '  </td></tr>',
    dailyIntro ? '  <tr><td style="padding:20px 4px 4px;"><h2 style="font-family:Georgia,serif;font-size:20px;margin:0 0 8px;color:#111;">' + escapeHtml(dailyTitle) + '</h2><p style="margin:0;color:#333;font-size:15px;line-height:1.6;">' + escapeHtml(dailyIntro) + '</p></td></tr>' : '',
    renderDailyHTML(daily),
    publicUrl ? '  <tr><td style="padding:24px 4px 0;border-top:1px solid #e5e5e0;"><p style="margin:12px 0 0;font-size:12px;color:#6b6b6b;"><a href="' + escapeHtml(publicUrl) + '" style="color:#6b6b6b;">View online &rarr;</a></p></td></tr>' : '',
    '  <tr><td style="padding:16px 4px 8px;"><p style="margin:0;font-size:11px;color:#9a9a94;">Culture Tracker &middot; auto-generated.</p></td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].filter(Boolean).join("\n");
}

// --- Plain-text fallback ---
function renderText(brief) {
  const lines = [];
  const daily = brief.daily || {};
  lines.push(daily.title || "Daily Culture Brief");
  if (brief.date) lines.push(formatDate(brief.date));
  lines.push("");
  if (daily.intro) { lines.push(daily.intro); lines.push(""); }

  if ((daily.themes || []).length) {
    lines.push("=== DAILY SIGNALS ===");
    (daily.themes || []).forEach(function (theme) {
      lines.push("");
      lines.push("# " + (theme.title || "Untitled theme"));
      if (theme.summary) lines.push(theme.summary);
      lines.push("");
      (theme.items || []).forEach(function (item) {
        const score = typeof item.score === "number" ? " [" + item.score + "/10]" : "";
        lines.push("- " + (item.title || "Untitled") + score);
        if (item.summary) lines.push("  " + item.summary);
        if (item.cultural_relevance) lines.push("  Why: " + item.cultural_relevance);
        const meta = [item.source, item.category].filter(Boolean).join(" / ");
        if (meta) lines.push("  " + meta);
        if (item.url) lines.push("  " + item.url);
        lines.push("");
      });
    });
  }

  return lines.join("\n");
}

// --- Main ---
async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    throw new Error("Cannot find " + LATEST_PATH + ". Run fetch-and-summarize.js first.");
  }
  const brief = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));

  const host = required("SMTP_HOST");
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = required("SMTP_USER");
  const pass = required("SMTP_PASS");
  const from = required("EMAIL_FROM");
  const to = required("EMAIL_TO");
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;

  const transporter = nodemailer.createTransport({
    host: host, port: port, secure: secure,
    auth: { user: user, pass: pass },
  });

  const dailyTitle = (brief.daily && brief.daily.title) || "Daily Culture Brief";
  const subject = dailyTitle + (brief.date ? " — " + brief.date : "");

  console.log("→ Sending email to " + to + " via " + host + ":" + port + " (secure=" + secure + ")");

  const info = await transporter.sendMail({
    from: from, to: to, subject: subject,
    text: renderText(brief),
    html: renderHTML(brief),
  });

  console.log("✓ Sent. Message ID: " + info.messageId);
}

main().catch(function (err) {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
