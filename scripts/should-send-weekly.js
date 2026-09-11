"use strict";
// Guard voor de wekelijkse Mailchimp-mail.
// Verstuurt alleen op of NA 10:30 Brussel (DST-proof) en max. 1x per ISO-week.
// workflow_dispatch negeert de tijd-gate; FORCE_SEND=true negeert ook de marker.
// Schrijft "proceed=true|false" naar $GITHUB_OUTPUT.
const fs = require("fs");
const TZ = "Europe/Brussels";
const TARGET_MIN = 10 * 60 + 30; // 10:30 lokaal
const MARKER = "data/.weekly-send-marker";
const event = process.env.GITHUB_EVENT_NAME || "";
const force = String(process.env.FORCE_SEND || "").toLowerCase() === "true";

function brussels(now) {
  const s = now.toLocaleString("sv-SE", { timeZone: TZ }); // "2026-09-11 09:15:32"
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/);
  if (!m) throw new Error("kon Brusselse tijd niet parsen: " + s);
  return { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5] };
}
function isoWeek(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return dt.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}
function proceed(v, reason) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "proceed=" + v + "\n");
  console.log((v === "true" ? "PROCEED" : "SKIP") + ": " + reason);
}
const b = brussels(new Date());
const wk = isoWeek(b.y, b.m, b.d);
const hhmm = String(b.h).padStart(2, "0") + ":" + String(b.min).padStart(2, "0");
let sent = "";
try { sent = fs.readFileSync(MARKER, "utf8").trim(); } catch (e) {}
if (sent === wk && !force) { proceed("false", "al verzonden voor " + wk); process.exit(0); }
if (event !== "workflow_dispatch" && (b.h * 60 + b.min) < TARGET_MIN) {
  proceed("false", "nu " + hhmm + " Brussel, wacht tot 10:30"); process.exit(0);
}
proceed("true", wk + " @ " + hhmm + " Brussel" + (event === "workflow_dispatch" ? " (handmatig)" : "") + (force ? " (force)" : ""));
