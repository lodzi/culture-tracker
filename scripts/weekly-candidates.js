"use strict";

// Algoritme v2 voor Zeitfeed Weekly.
//
// Wat dit doet (alleen als config/pipeline.json -> weeklyV2 aan staat):
//   1. Bouwt een pool van alle dagelijkse insights van de laatste 7 dagen.
//   2. Laat het (sterkere) weekly-model de pool clusteren tot ~16-20 kandidaten,
//      met thema-tags, een pitch van 1 zin en een sterkte-score.
//   3. Scoort in CODE: sterkte + aanhoudendheid + bronbreedte + cross-categorie
//      minus een straf voor thema's die de laatste 8 weken al verstuurd zijn
//      (data/sent.json). Past quota toe (max. 2 per categorie, minstens 1 lokaal).
//   4. Bewaart de top 10 als `weeklyCandidates`, met 2-3 bronlinks per kandidaat.
//      Die links komen uit de data (articles van de dagelijkse insights), nooit
//      uit het model.
//   5. Schrijft als vangnet een standaard-3 (3 verschillende categorieën) naar
//      `weeklyBrandSignals`, tenzij Lode zijn eigen keuze al heeft vergrendeld.
//
// Regeneratie gebeurt alleen op donderdag (of met FORCE_WEEKLY=1), niet meer via
// een 6-daagse cache. Een vergrendelde keuze (locked + zelfde sendDate) wordt
// door de pipeline nooit overschreven.

const fs   = require("fs");
const path = require("path");
const { sendDateFor } = require("./pipeline-config");

const ROOT      = path.resolve(__dirname, "..");
const SENT_PATH = path.join(ROOT, "data", "sent.json");
const DAY_MS    = 86400000;

const SENSITIVE_KINDS = ["politics", "violence", "death", "health", "drugs"];
const BUZZWORDS = ["game-changer", "disruptive", "innovative", "authentic", "next-level",
  "cutting-edge", "purpose-driven", "paradigm"];

// ── Kleine helpers ─────────────────────────────────────────────────────────

function normalizeCategory(id) {
  const c = String(id || "").toLowerCase().trim();
  return c === "local" ? "lokaal" : c;
}

// De mail en de projectinstructies gebruiken "local"; de data gebruikt "lokaal".
function mailCategory(id) {
  const c = normalizeCategory(id);
  return c === "lokaal" ? "local" : c;
}

function normalizeTheme(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function clamp(n, lo, hi, dflt) {
  const x = Number(n);
  if (!isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, x));
}

// Veiligheidsnet voor de huisstijl: geen em-dashes in lopende tekst.
function cleanStyle(text) {
  return String(text || "").replace(/\s*—\s*/g, ", ").trim();
}

function readSent(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p || SENT_PATH, "utf8"));
    return Array.isArray(j.sent) ? j.sent : [];
  } catch (e) {
    return [];
  }
}

function weeksBetween(now, isoDate) {
  const t = Date.parse(isoDate + "T00:00:00Z");
  if (isNaN(t)) return 999;
  return Math.max(0, (now.getTime() - t) / (7 * DAY_MS));
}

// ── Pool ───────────────────────────────────────────────────────────────────

// days: [{date, categories:[{id, insights:[...]}]}]. Dubbele datums: de laatste wint
// (zo overschrijft de run van vandaag een eventueel oudere snapshot van vandaag).
function buildPool(days, poolDays) {
  const byDate = new Map();
  for (const d of days || []) {
    if (d && d.date && Array.isArray(d.categories)) byDate.set(d.date, d);
  }
  const dates = Array.from(byDate.keys()).sort().reverse().slice(0, poolDays);
  const signals = [];
  let n = 0;
  for (const date of dates) {
    for (const cat of byDate.get(date).categories) {
      for (const ins of (cat.insights || [])) {
        if (!ins || !ins.trend) continue;
        n++;
        signals.push({
          id:         "s" + String(n).padStart(3, "0"),
          date:       date,
          category:   normalizeCategory(cat.id),
          trend:      ins.trend,
          summary:    ins.summary || "",
          daysActive: typeof ins.daysActive === "number" ? ins.daysActive : null,
          confidence: ins.confidence || null,
          sources:    Array.isArray(ins.sources) ? ins.sources : [],
          articles:   Array.isArray(ins.articles) ? ins.articles : [],
        });
      }
    }
  }
  return { dates, signals };
}

function poolHealth(pool, cfg) {
  const cats = new Set(pool.signals.map(function (s) { return s.category; }));
  return {
    ok: pool.signals.length >= cfg.minPoolSignals && cats.size >= cfg.minPoolCategories,
    signals: pool.signals.length,
    categories: cats.size,
  };
}

// ── Beslissen of er opnieuw gegenereerd moet worden ────────────────────────

function isLocked(existingSignals, sendDate) {
  return !!(existingSignals && existingSignals.locked === true && existingSignals.sendDate === sendDate);
}

function hasSignals(s) {
  return !!(s && Array.isArray(s.weeklyBrandSignals) && s.weeklyBrandSignals.length > 0);
}

function hasCandidates(c) {
  return !!(c && Array.isArray(c.candidates) && c.candidates.length > 0);
}

function decide({ now, cfg, existingCandidates, existingSignals, force }) {
  const sendDate = sendDateFor(now);
  const thursday = now.getUTCDay() === cfg.regenerateWeekday;
  const locked   = isLocked(existingSignals, sendDate);

  const needCandidates = !!force || thursday || !hasCandidates(existingCandidates);
  let needSignals = !!force || thursday || !hasSignals(existingSignals);
  if (locked) needSignals = false; // Lodes keuze is heilig

  return { sendDate, thursday, locked, needCandidates, needSignals };
}

// ── Prompt voor de kandidaten ──────────────────────────────────────────────

function sentForPrompt(sent, now, cfg) {
  const rows = [];
  for (const entry of sent) {
    const w = weeksBetween(now, entry.sendDate);
    if (w > cfg.sentLookbackWeeks) continue;
    for (const t of (entry.topics || [])) {
      rows.push({ weeksAgo: Math.round(w), trend: t.trend, category: t.category, themes: t.themes || [] });
    }
  }
  return rows;
}

function themeVocabulary(sent) {
  const set = new Set();
  for (const entry of sent) for (const t of (entry.topics || [])) {
    for (const th of (t.themes || [])) set.add(normalizeTheme(th));
  }
  return Array.from(set).sort();
}

function buildCandidatePrompt({ pool, sent, now, cfg }) {
  const sentRows = sentForPrompt(sent, now, cfg);
  const vocab    = themeVocabulary(sent);
  const target   = Math.min(20, Math.max(cfg.top + 6, 16), pool.signals.length);

  const compact = pool.signals.map(function (s) {
    return { id: s.id, date: s.date, category: s.category, title: s.trend,
             summary: s.summary, sources: s.sources.length };
  });

  return `You are a senior cultural strategist at a Belgian agency. You prepare the Thursday shortlist for Zeitfeed Weekly, a newsletter for marketers and brand builders (3 cultural trends per week, each with actions for brands).

Below are ${pool.signals.length} trend signals from the last ${pool.dates.length} days. Each has an id, date, category, title, summary and number of sources. The same story often appears on several days under different titles. Signals may be written in Dutch. Write ALL of your output in English (British spelling).

TASK
1. Merge signals that cover the same story or theme into one cluster. A signal id may appear in at most one cluster.
2. Return ${target} clusters (fewer only if the pool is smaller). Prefer a spread over categories; do not let one category dominate.
3. For every cluster return:
   - signalIds: the ids you merged
   - category: one of the categories of those signals
   - trend: 4 to 6 words, concrete and compelling
   - pitch: ONE sentence saying what is happening and who is involved
   - strength: integer 1 to 10 (cultural momentum plus usefulness for brands; 10 = unmissable)
   - themes: 1 to 3 lowercase kebab-case tags for the underlying theme. Reuse a tag from this vocabulary when it fits, create a new one only when none does: ${JSON.stringify(vocab)}
   - repeatOf: the exact title of a topic from the "already sent" list below if this cluster is essentially the same story or angle, otherwise null. A recurring theme with a genuinely new angle is NOT a repeat.
   - sensitive: null, or one of ${JSON.stringify(SENSITIVE_KINDS)} when the topic touches that area

FACT RULES (strict)
- Use ONLY facts that appear in the signal titles and summaries. Never add nationality, origin, location, dates, figures, titles or names that are not in those texts. If something is unclear, leave it out.
- Very politically charged topics are NOT candidates. Mention them neutrally in "skippedPolitical" (max 3, one short neutral phrase each).

STYLE RULES
- No em-dashes. Use a comma or full stop.
- No buzzwords such as ${BUZZWORDS.join(", ")}.

Respond ONLY with JSON:
{
  "candidates": [
    { "signalIds": ["s001"], "category": "music", "trend": "...", "pitch": "...", "strength": 7,
      "themes": ["..."], "repeatOf": null, "sensitive": null }
  ],
  "skippedPolitical": []
}

ALREADY SENT in the last ${cfg.sentLookbackWeeks} weeks (do not recycle):
${JSON.stringify(sentRows)}

SIGNALS:
${JSON.stringify(compact)}`;
}

// ── Scoren, bronnen, quota ─────────────────────────────────────────────────

// Straf voor thema's die recent al verstuurd zijn. Recentere weken wegen zwaarder;
// "zware" thema's (AI, nostalgie, legacy/overlijden, prestige) wegen extra.
function repetitionPenalty(themes, repeatOf, sent, now, cfg) {
  const heavy = new Set((cfg.heavyThemes || []).map(normalizeTheme));
  let pen = 0;
  const hits = [];
  for (const entry of sent) {
    const w = weeksBetween(now, entry.sendDate);
    if (w > cfg.sentLookbackWeeks) continue;
    const weight = 1 - w / (cfg.sentLookbackWeeks + 2);
    for (const t of (entry.topics || [])) {
      const theirs = new Set((t.themes || []).map(normalizeTheme));
      for (const th of themes) {
        if (theirs.has(th)) {
          pen += weight * (heavy.has(th) ? cfg.heavyMultiplier : 1);
          hits.push({ theme: th, sendDate: entry.sendDate });
        }
      }
    }
  }
  pen = Math.min(cfg.penaltyCap, pen);
  if (repeatOf) pen += cfg.repeatPenalty;
  return { penalty: Math.round(pen * 100) / 100, hits };
}

// 2-3 bronlinks per kandidaat, uit de data. Eerst uit verschillende bronnen,
// nieuwste eerst.
function pickSources(sigs, max) {
  const arts = [];
  const seenUrl = new Set();
  const ordered = sigs.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  for (const s of ordered) {
    for (const a of s.articles) {
      if (!a || !a.url || seenUrl.has(a.url)) continue;
      seenUrl.add(a.url);
      arts.push({ title: a.title || "", url: a.url, source: a.source || "", published: a.published || null });
    }
  }
  arts.sort(function (a, b) { return String(b.published || "").localeCompare(String(a.published || "")); });
  const out = [];
  const seenSource = new Set();
  for (const a of arts) {
    if (out.length >= max) break;
    if (a.source && seenSource.has(a.source)) continue;
    seenSource.add(a.source);
    out.push(a);
  }
  for (const a of arts) {
    if (out.length >= max) break;
    if (out.indexOf(a) === -1) out.push(a);
  }
  return out;
}

function scoreCandidates(raw, pool, sent, now, cfg) {
  const byId = new Map(pool.signals.map(function (s) { return [s.id, s]; }));
  const used = new Set();
  const out  = [];

  for (const c of (raw || [])) {
    if (!c || !c.trend) continue;
    const ids = (Array.isArray(c.signalIds) ? c.signalIds : [])
      .filter(function (id) { return byId.has(id) && !used.has(id); });
    if (ids.length === 0) continue;
    ids.forEach(function (id) { used.add(id); });
    const sigs = ids.map(function (id) { return byId.get(id); });

    const catCount = {};
    sigs.forEach(function (s) { catCount[s.category] = (catCount[s.category] || 0) + 1; });
    let category = normalizeCategory(c.category);
    if (!catCount[category]) {
      category = Object.entries(catCount).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    }

    const dates = new Set(sigs.map(function (s) { return s.date; }));
    const srcNames = new Set();
    sigs.forEach(function (s) {
      s.sources.forEach(function (n) { srcNames.add(n); });
      s.articles.forEach(function (a) { if (a && a.source) srcNames.add(a.source); });
    });
    const cross   = Object.keys(catCount).length >= 2;
    const lowConf = category !== "lokaal" && sigs.every(function (s) { return s.confidence === "laag"; });

    const themes = (Array.isArray(c.themes) ? c.themes : [])
      .map(normalizeTheme).filter(Boolean).slice(0, 3);
    const strength = Math.round(clamp(c.strength, 1, 10, 5));
    const repeatOf = typeof c.repeatOf === "string" && c.repeatOf.trim() ? c.repeatOf.trim() : null;
    const sensitive = SENSITIVE_KINDS.indexOf(c.sensitive) >= 0 ? c.sensitive : null;

    const rep = repetitionPenalty(themes, repeatOf, sent, now, cfg);
    const parts = {
      strength,
      daysSeen: 0.5 * Math.min(dates.size, 4),
      sources:  0.25 * Math.min(srcNames.size, 4),
      cross:    cross ? 1 : 0,
      lowConfidence: lowConf ? -1 : 0,
      penalty:  rep.penalty ? -rep.penalty : 0,
    };
    const score = Math.round((parts.strength + parts.daysSeen + parts.sources + parts.cross +
                              parts.lowConfidence + parts.penalty) * 100) / 100;

    const evidence = sigs.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })
      .slice(0, 3).map(function (s) {
        return { date: s.date, category: s.category, trend: s.trend, summary: s.summary };
      });

    out.push({
      trend:     cleanStyle(c.trend),
      category,
      pitch:     cleanStyle(c.pitch),
      themes,
      sensitive,
      repeatOf,
      score,
      scoreBreakdown: parts,
      repeatedThemes: rep.hits,
      daysSeen:  dates.size,
      signalCount: sigs.length,
      sourceCount: srcNames.size,
      sources:   pickSources(sigs, 3),
      evidence,
    });
  }
  return out;
}

function selectTop(scored, cfg) {
  const sorted = scored.slice().sort(function (a, b) { return b.score - a.score; });
  const perCat = {};
  const picked = [];
  for (const c of sorted) {
    if (picked.length >= cfg.top) break;
    const max = (cfg.categoryMax && cfg.categoryMax[c.category] != null)
      ? cfg.categoryMax[c.category] : cfg.maxPerCategory;
    if ((perCat[c.category] || 0) >= max) continue;
    picked.push(c);
    perCat[c.category] = (perCat[c.category] || 0) + 1;
  }

  // Minimaal aantal lokale kandidaten: haal de beste lokale erbij als er geen is.
  const quota = { lokaalAvailable: sorted.filter(function (c) { return c.category === "lokaal"; }).length,
                  lokaalPicked: 0, missing: [] };
  let lokaalPicked = picked.filter(function (c) { return c.category === "lokaal"; }).length;
  while (lokaalPicked < cfg.minLokaal) {
    const best = sorted.find(function (c) { return c.category === "lokaal" && picked.indexOf(c) === -1; });
    if (!best) { quota.missing.push("lokaal"); break; }
    best.quotaPick = true;
    if (picked.length >= cfg.top) {
      // vervang de zwakste niet-lokale kandidaat
      let idx = -1;
      for (let i = picked.length - 1; i >= 0; i--) {
        if (picked[i].category !== "lokaal") { idx = i; break; }
      }
      if (idx === -1) break;
      picked.splice(idx, 1);
    }
    picked.push(best);
    lokaalPicked++;
  }
  quota.lokaalPicked = lokaalPicked;

  picked.sort(function (a, b) { return b.score - a.score; });
  picked.forEach(function (c, i) {
    c.rank = i + 1;
    c.id   = "c" + String(i + 1).padStart(2, "0");
  });
  return { picked, quota };
}

// Standaard-3 als vangnet: hoogste scores, 3 verschillende categorieën. Gevoelige
// topics en kandidaten met één bron komen pas aan bod als er niets anders is.
function pickDefaultThree(picked) {
  const chosen = [];
  const cats = new Set();
  function take(filter) {
    for (const c of picked) {
      if (chosen.length >= 3) return;
      if (cats.has(c.category) || chosen.indexOf(c) >= 0) continue;
      if (!filter(c)) continue;
      chosen.push(c);
      cats.add(c.category);
    }
  }
  take(function (c) { return !c.sensitive && c.sourceCount >= 2; });
  take(function (c) { return !c.sensitive; });
  take(function () { return true; });
  return chosen;
}

// ── Model-aanroep met fallback ─────────────────────────────────────────────

async function callModel(client, cfg, params) {
  const models = [];
  [cfg.models.weekly, cfg.models.weeklyFallback].forEach(function (m) {
    if (m && models.indexOf(m) === -1) models.push(m);
  });
  let lastErr = null;
  for (const model of models) {
    try {
      const msg = await client.messages.create(Object.assign({ model }, params));
      return { msg, model };
    } catch (e) {
      lastErr = e;
      console.warn("  ⚠ Model " + model + " mislukt: " + (e && e.message ? e.message : e));
    }
  }
  throw lastErr || new Error("Geen model beschikbaar.");
}

// ── Kandidaten genereren ───────────────────────────────────────────────────

async function generateCandidates({ client, cfg, pool, sent, now, parseAIJson }) {
  const prompt = buildCandidatePrompt({ pool, sent, now, cfg: cfg.weekly });
  console.log("  [weekly] Kandidaten uit " + pool.signals.length + " signalen over " +
    pool.dates.length + " dagen…");
  const { msg, model } = await callModel(client, cfg, {
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("  Model: " + model + " · tokens: " + msg.usage.input_tokens + " in + " +
    msg.usage.output_tokens + " out");

  const parsed  = parseAIJson(msg.content[0].text);
  const scored  = scoreCandidates(parsed.candidates, pool, sent, now, cfg.weekly);
  if (scored.length === 0) throw new Error("Model gaf geen bruikbare kandidaten terug.");
  const { picked, quota } = selectTop(scored, cfg.weekly);

  if (quota.missing.length) {
    console.warn("  ⚠ Quota niet gehaald: geen " + quota.missing.join(", ") +
      " kandidaat in de pool van deze week.");
  }
  const skipped = (Array.isArray(parsed.skippedPolitical) ? parsed.skippedPolitical : [])
    .map(function (s) { return cleanStyle(s); }).filter(Boolean).slice(0, 3);

  return { candidates: picked, quota, skippedPolitical: skipped, model, poolSize: scored.length };
}

// ── Standaard-3 uitschrijven (alleen vangnet, Lode kiest zelf) ─────────────

function buildSignalsPrompt(chosen) {
  const input = chosen.map(function (c) {
    return {
      candidateId: c.id,
      category:    mailCategory(c.category),
      workingTitle: c.trend,
      pitch:       c.pitch,
      evidence:    c.evidence.map(function (e) { return { trend: e.trend, summary: e.summary }; }),
    };
  });
  return `You are a senior brand strategist and cultural consultant at a Belgian agency. Turn the ${chosen.length} cultural trends below into newsletter items for brand strategists, creative directors and communications professionals. The evidence may be written in Dutch; write ALL output in English (British spelling).

For each trend provide:
- candidateId: copy it exactly
- trend: the name (4-6 words, compelling and specific)
- what_is_happening: 2 sentences, naming the artists, brands or makers that appear in the evidence
- why_it_matters_for_brands: 1 sharp sentence
- what_brands_can_do: array of exactly 3 concrete actions, each max. 25 words, each starting with a verb

FACT RULES (strict): use ONLY facts that appear in the evidence. Never add nationality, origin, location, dates, figures or names that are not in it. If something is unclear, leave it out. If a topic is political or sensitive, stay strictly neutral and write about how brands deal with it, not about the issue itself.

STYLE RULES: no em-dashes (use a comma or full stop); no buzzwords such as ${BUZZWORDS.join(", ")}; British spelling; standard sentence capitalisation.

Respond ONLY with JSON:
{ "weeklyBrandSignals": [ { "candidateId": "c01", "trend": "...", "what_is_happening": "...", "why_it_matters_for_brands": "...", "what_brands_can_do": ["...", "...", "..."] } ] }

TRENDS:
${JSON.stringify(input, null, 2)}`;
}

async function writeBrandSignals({ client, cfg, chosen, parseAIJson }) {
  if (!chosen.length) throw new Error("Geen kandidaten om uit te schrijven.");
  console.log("  [weekly] Standaard-3 uitschrijven (" + chosen.length + " kandidaten)…");
  const { msg, model } = await callModel(client, cfg, {
    max_tokens: 3500,
    messages: [{ role: "user", content: buildSignalsPrompt(chosen) }],
  });
  console.log("  Model: " + model + " · tokens: " + msg.usage.input_tokens + " in + " +
    msg.usage.output_tokens + " out");

  const parsed = parseAIJson(msg.content[0].text);
  const byId = new Map(chosen.map(function (c) { return [c.id, c]; }));
  const signals = [];
  for (const s of (parsed.weeklyBrandSignals || [])) {
    const cand = byId.get(s.candidateId);
    if (!cand || !s.what_is_happening || !Array.isArray(s.what_brands_can_do)) continue;
    const actions = s.what_brands_can_do.map(cleanStyle).filter(Boolean);
    if (actions.length < 3) continue;
    const text = [s.trend, s.what_is_happening, s.why_it_matters_for_brands].concat(actions).join(" ").toLowerCase();
    BUZZWORDS.forEach(function (b) {
      if (text.indexOf(b) >= 0) console.warn("  ⚠ Buzzword '" + b + "' in " + cand.id + " — controleer.");
    });
    signals.push({
      trend:    cleanStyle(s.trend || cand.trend),
      category: mailCategory(cand.category),
      what_is_happening:         cleanStyle(s.what_is_happening),
      why_it_matters_for_brands: cleanStyle(s.why_it_matters_for_brands),
      what_brands_can_do:        actions.slice(0, 3),
      candidateId: cand.id,
      sources:     cand.sources,
    });
    byId.delete(s.candidateId);
  }
  if (signals.length === 0) throw new Error("Geen bruikbare brand signals uitgeschreven.");
  return { signals, model };
}

// ── Orkestratie ────────────────────────────────────────────────────────────

// Geeft { weeklyCandidates, weeklyBrandSignals, regenerated:{candidates,signals}, models }
// terug. Bij elke fout blijft de bestaande waarde staan (nooit leegmaken).
async function runWeeklyV2({ client, cfg, now, daily, archiveDays, todayDate, existing, force, parseAIJson, sentPath }) {
  now = now || new Date();
  const existingCandidates = existing && existing.weeklyCandidates || null;
  const existingSignals    = existing && existing.weeklyBrandSignals || null;

  const d = decide({ now, cfg: cfg.weekly, existingCandidates, existingSignals, force });
  console.log("  Week: verzenddatum " + d.sendDate + " · donderdag: " + (d.thursday ? "ja" : "nee") +
    " · vergrendeld: " + (d.locked ? "ja" : "nee") +
    " · nieuwe kandidaten: " + (d.needCandidates ? "ja" : "nee") +
    " · nieuwe standaard-3: " + (d.needSignals ? "ja" : "nee"));

  const result = {
    weeklyCandidates:   existingCandidates,
    weeklyBrandSignals: existingSignals,
    regenerated:        { candidates: false, signals: false },
    models:             [],
    decision:           d,
  };
  if (!d.needCandidates && !d.needSignals) {
    console.log("  Geen nieuwe weekly nodig — hergebruik bestaande data.");
    return result;
  }

  const sent = readSent(sentPath);

  if (d.needCandidates) {
    const days = (archiveDays || []).slice();
    if (daily && Array.isArray(daily.categories) && daily.categories.length) {
      days.push({ date: todayDate, categories: daily.categories });
    }
    const pool   = buildPool(days, cfg.weekly.poolDays);
    const health = poolHealth(pool, cfg.weekly);
    if (!health.ok) {
      console.warn("  ⚠ Pool te dun (" + health.signals + " signalen, " + health.categories +
        " categorieën; drempel " + cfg.weekly.minPoolSignals + "/" + cfg.weekly.minPoolCategories +
        ") — bestaande kandidaten blijven staan.");
    } else {
      try {
        const gen = await generateCandidates({ client, cfg, pool, sent, now, parseAIJson });
        result.weeklyCandidates = {
          generatedAt: now.toISOString(),
          sendDate:    d.sendDate,
          model:       gen.model,
          poolDays:    pool.dates.length,
          poolSignals: pool.signals.length,
          quota:       gen.quota,
          skippedPolitical: gen.skippedPolitical,
          candidates:  gen.candidates,
        };
        result.regenerated.candidates = true;
        result.models.push(gen.model);
        console.log("  ✓ " + gen.candidates.length + " kandidaten (top: " +
          gen.candidates.slice(0, 3).map(function (c) { return c.trend; }).join(" | ") + ")");
      } catch (e) {
        console.error("  Kandidaten mislukt: " + e.message + " — bestaande blijven staan.");
      }
    }
  }

  // Een standaard-3 mag alleen uit kandidaten van DEZE week komen. Mislukte de
  // generatie en staat er nog een lijst van vorige week, dan blijft de bestaande
  // set staan (en houdt de stale-guard in het mailscript de verzending tegen).
  const candidatesFresh = hasCandidates(result.weeklyCandidates) &&
    result.weeklyCandidates.sendDate === d.sendDate;
  if (d.needSignals && !candidatesFresh) {
    console.warn("  ⚠ Geen kandidaten voor verzenddatum " + d.sendDate +
      " — standaard-3 niet bijgewerkt.");
  }
  if (d.needSignals && candidatesFresh) {
    try {
      const chosen = pickDefaultThree(result.weeklyCandidates.candidates);
      const out = await writeBrandSignals({ client, cfg, chosen, parseAIJson });
      result.weeklyBrandSignals = {
        generatedAt: now.toISOString(),
        sendDate:    d.sendDate,
        selection:   "auto",
        locked:      false,
        weeklyBrandSignals: out.signals,
      };
      result.regenerated.signals = true;
      result.models.push(out.model);
      console.log("  ✓ Standaard-3 klaargezet (selection: auto, nog niet vergrendeld)");
    } catch (e) {
      console.error("  Standaard-3 mislukt: " + e.message + " — bestaande blijft staan.");
    }
  }
  return result;
}

module.exports = {
  normalizeCategory, mailCategory, normalizeTheme, cleanStyle, readSent,
  buildPool, poolHealth, decide, isLocked, hasSignals, hasCandidates,
  buildCandidatePrompt, repetitionPenalty, pickSources, scoreCandidates, selectTop,
  pickDefaultThree, callModel, generateCandidates, buildSignalsPrompt, writeBrandSignals,
  runWeeklyV2,
};
