"use strict";
const fs = require("fs");
const TZ = "Europe/Brussels";
const MARKER = "data/.weekly-send-marker";
function brussels(now) {
  const s = now.toLocaleString("sv-SE", { timeZone: TZ });
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function isoWeek(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return dt.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}
const b = brussels(new Date());
const wk = isoWeek(b.y, b.m, b.d);
fs.writeFileSync(MARKER, wk + "\n");
console.log("marker gezet op " + wk);
