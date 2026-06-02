# Zeitfeed Weekly (Culture Tracker)

A daily/weekly brief of what's moving in popular culture, written for brand strategists and creatives. A set of Node.js scripts fetch dozens of sources, cluster them into real cross-source topics, and use Claude to synthesise daily trends, cross-category mega-trends, weekly patterns, monthly macro-shifts and a weekly "brand signals" digest. The output is plain JSON rendered by a static frontend and emailed as HTML.

> **Heads-up — this needs API keys.** Earlier versions of this project were RSS-only with no LLM. That is no longer true. The synthesis pipeline **requires `ANTHROPIC_API_KEY`**, and semantic clustering optionally uses **`VOYAGE_API_KEY`**. See [Requirements](#requirements).

## How it works

```
sources.json
   │  RSS · Wikipedia pageviews · Reddit (upvotes) · TikTok hashtags
   ▼
fetch-and-summarize.js
   • fetch + dedupe + score (authority · recency · cross-source · engagement)
   • cluster into topics:
       – semantic via Voyage embeddings   (if VOYAGE_API_KEY set)   ← preferred
       – keyword overlap                  (fallback)
   ▼  data/latest-raw.json   (no LLM yet)
ai-synthesize.js   (Claude)
   • daily        – top trends per category            (Haiku)
   • crossCategory – mega-trends across categories      (Haiku)
   • weekly       – emerging patterns over 7 days       (Sonnet, cached 6d)
   • monthly      – macro-shifts over 30 days           (Sonnet, cached 25d)
   • weeklyBrandSignals – 3 brand-ready trends          (Sonnet, cached 6d)
   • spell-check  – Dutch proofread of all generated text (Haiku)
   ▼  data/latest.json  +  data/archive/YYYY-MM-DD.json
static frontend (index.html)  ·  HTML emails (send-email.js / send-weekly-email.js)

synthesize-reports.js   (Claude, run occasionally)
   • reads "Trend rapport/" (PDF/DOCX) → data/report-synthesis.json
   • feeds macro-trends into the monthly layer + a "trend reports" UI section
```

The frontend only ever reads JSON from `/data/`. There is no runtime backend — the "backend" is a scheduled job that regenerates the JSON.

## Project structure

```
index.html · style.css · app.js          # static frontend
config/
  sources.json                           # feeds + per-source weights
  email-branding.json                    # weekly-email styling
scripts/
  fetch-and-summarize.js                 # fetch → score → cluster → latest-raw.json
  ai-synthesize.js                       # Claude synthesis + spell-check → latest.json
  synthesize-reports.js                  # PDF/DOCX reports → report-synthesis.json
  send-email.js                          # daily HTML digest
  send-weekly-email.js                   # weekly brand-signals email
  check-sources.js                       # source health check (no LLM)
data/
  latest.json                            # what the frontend renders
  latest-raw.json                        # fetch output, pre-LLM
  report-synthesis.json                  # macro-trends from the report corpus
  archive/index.json + YYYY-MM-DD.json   # daily snapshots
.github/workflows/
  ai-synthesis.yml                       # daily: fetch + synthesize + daily email
  weekly-email.yml                       # Friday: weekly brand-signals email
  report-synthesis.yml                   # manual: (re)build report-synthesis.json
Trend rapport/                           # curated PDF/DOCX trend reports
```

## Requirements

- **Node.js 18+** (the workflows use Node 24).
- **`ANTHROPIC_API_KEY`** — required for `ai-synthesize.js` and `synthesize-reports.js`.
- **`VOYAGE_API_KEY`** — *optional.* When set, topics are clustered semantically (by meaning) instead of by keyword overlap. Without it the pipeline falls back to keyword clustering automatically. Get one at [voyageai.com](https://www.voyageai.com/).

## Run it locally

```bash
npm install

# 1. fetch + cluster  → data/latest-raw.json   (no API key needed for keyword clustering)
export VOYAGE_API_KEY=...        # optional: enables semantic clustering
npm run update

# 2. Claude synthesis + spell-check → data/latest.json
export ANTHROPIC_API_KEY=...
npm run synthesize

# 3. serve the static site at http://localhost:8080
npm run serve
```

`npm run daily` chains update → synthesize → email. Serve over HTTP (not `file://`) — browsers block `fetch()` for `file://`.

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run update` | Fetch sources, score, cluster → `data/latest-raw.json` (+ fallback `latest.json`). |
| `npm run synthesize` | Claude synthesis + Dutch spell-check → `data/latest.json` + archive. |
| `npm run synthesize-reports` | Process `Trend rapport/` PDFs/DOCX → `data/report-synthesis.json`. Add `-- --force` to ignore the 30-day cache. |
| `npm run email` | Send the daily HTML digest from `latest.json`. |
| `npm run weekly-email` | Send the weekly brand-signals email. |
| `npm run daily` | `update` → `synthesize` → `email`. |
| `npm run check-sources` | Validate every feed in `sources.json` (no LLM). |
| `npm run serve` | Static server on `:8080`. |

### Tunable environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | **Required** for synthesis. |
| `VOYAGE_API_KEY` | — | Optional; enables semantic (embeddings) clustering. |
| `VOYAGE_MODEL` | `voyage-3.5` | Embedding model. |
| `EMBED_SIM_THRESHOLD` | `0.55` | Cosine similarity above which two items are the same topic. Lower = bigger/looser clusters. |
| `ENABLE_REDDIT_ENGAGEMENT` | `true` | Fetch Reddit upvotes/comments as a real engagement signal (`false` to disable). |
| `LOOKBACK_HOURS` | `24` | Keep items newer than this. |
| `MAX_ITEMS_PER_FEED` | `10` | Cap per source. |
| `MAX_TOPICS` | `10` | Topics surfaced in the daily brief. |
| `MIN_CATEGORIES` | `3` | Below this, the synthesis logs a quality warning. |

## Sources

Add a feed in `config/sources.json`:

```json
{ "name": "Dazed", "type": "rss", "url": "https://www.dazeddigital.com/rss", "category": "culture", "weight": 7 }
```

- `type` — `rss`, `wikipedia-trending`, or `tiktok-trends`. Unknown types are skipped.
- `weight` — 1–10 authority weight (higher = stronger base score).
- `category` — the bucket; sources sharing a category are grouped. Each topic is assigned to its **dominant** category so it appears once, not smeared across every category.

Reddit feeds work as `rss`; when `ENABLE_REDDIT_ENGAGEMENT` is on, the fetcher also pulls each subreddit's JSON listing once to attach real upvotes. Reddit aggressively rate-limits datacenter IPs, so this is best-effort — failures are logged and ignored.

## Automation (GitHub Actions)

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ai-synthesis.yml` | daily 06:00 UTC | fetch → synthesize → commit `latest.json` + archive → send daily email |
| `weekly-email.yml` | Friday 06:00 UTC | send weekly brand-signals email |
| `report-synthesis.yml` | manual | rebuild `data/report-synthesis.json` from the report corpus |

> **DST note.** GitHub cron is UTC-only. 06:00 UTC = 08:00 Brussels in summer (CEST), 07:00 in winter (CET).

> **Report synthesis is manual on purpose.** The `Trend rapport/` corpus is large, so we don't want a heavy checkout on every scheduled run. Trigger `report-synthesis.yml` when you add/replace reports, or run `npm run synthesize-reports` locally and commit `data/report-synthesis.json`. The daily synthesis picks it up automatically.

### Required secrets

Settings → Secrets and variables → Actions:

| Secret | Example | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Claude synthesis (required). |
| `VOYAGE_API_KEY` | `pa-...` | Semantic clustering (optional). |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server. |
| `SMTP_PORT` | `587` | 587 STARTTLS / 465 SSL. |
| `SMTP_USER` | `you@domain.com` | SMTP username. |
| `SMTP_PASS` | app password | Not your normal password — see below. |
| `EMAIL_FROM` | `Zeitfeed Weekly <you@domain.com>` | From header. |
| `EMAIL_TO` | `you@domain.com` | Recipient(s), comma-separated. |
| `PUBLIC_URL` | `https://tracker.thisisdefiant.com` | Optional "view online" link. |

**Gmail / Workspace:** enable 2-Step Verification, then create an App Password at <https://myaccount.google.com/apppasswords>. Use `smtp.gmail.com` / port `587`. The most common error, `Invalid login`, means you used your normal password instead of an app password.

## Hosting (GitHub Pages)

1. Push to GitHub → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
2. The repo ships a `CNAME` (`tracker.thisisdefiant.com`); edit it for your own domain and set the matching DNS `CNAME` to `<username>.github.io`.
3. Tick **Enforce HTTPS** once the certificate is issued.

Every commit from the daily workflow auto-redeploys, so the live site stays fresh. The site is plain HTML/CSS/JS + JSON, so it also works on Netlify, Vercel, Cloudflare Pages or any static host (no build step; publish dir `.`).

## Data structure

`data/latest.json` (and each archive file):

```json
{
  "date": "2026-05-25",
  "aiModel": { "daily": "claude-haiku-4-5-20251001", "weekly": "claude-sonnet-4-6", "monthly": "claude-sonnet-4-6" },
  "daily":   { "intro": "...", "categories": [ { "id": "music", "label": "Muziek",
                 "insights": [ { "trend": "...", "summary": "...", "why_it_matters": "...",
                                 "strategic_signal": "...", "trajectory": "opkomend",
                                 "daysActive": 1, "isNew": true, "sources": [...], "articles": [...] } ] } ] },
  "crossCategory":      { "megaTrends": [ { "trend": "...", "categories": ["music","fashion"], "strength": "sterk" } ] },
  "weekly":             { "categories": [ ... ] },
  "monthly":            { "categories": [ ... ] },
  "weeklyBrandSignals": { "weeklyBrandSignals": [ { "trend": "...", "category": "...", "what_brands_can_do": ["..."] } ] },
  "reportInsights":     { "macroTrends": [ { "trend": "...", "horizon": "6 maanden", "strategic_action": "..." } ] }
}
```

`weekly`, `monthly`, `crossCategory` and `reportInsights` only appear once there's enough data for them to be meaningful.

## Spell-check

All Claude-generated Dutch text (daily/weekly/monthly insights, mega-trends and brand signals) passes a final Haiku proofread inside `ai-synthesize.js` before `latest.json` is written. It fixes spelling/typo/grammar only — it does not rewrite — and a length guard rejects any "correction" that looks like a rewrite. Because the website and both emails read `latest.json`, the corrected text flows everywhere, including cached brand signals.

## Troubleshooting

- **"Could not load the brief"** → ensure `data/latest.json` exists and you serve over HTTP.
- **Empty / thin brief** → check the fetch logs; feeds rate-limit or rename often. Run `npm run check-sources`. A "quality warning" in the synthesis log means fewer than `MIN_CATEGORIES` categories came through.
- **Weekly/monthly missing** → they read the archive **index** (`data/archive/index.json`), so they survive gaps in the daily cron. If the index is empty they won't generate until a few days have accumulated.
- **Semantic clustering not happening** → confirm `VOYAGE_API_KEY` is set; the fetch log prints which strategy it used. On any Voyage error it falls back to keyword clustering.
- **`report-synthesis.json` never appears** → run `report-synthesis.yml` (manual) or `npm run synthesize-reports` locally and commit the file.

