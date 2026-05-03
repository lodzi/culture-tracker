# Culture Tracker

A lightweight daily brief of what's happening in popular culture. The frontend is a static HTML/CSS/JS site you can host anywhere. A Node.js script (run locally or via GitHub Actions) fetches RSS feeds, asks Claude to cluster and summarize them, writes a fresh JSON file every day, and emails the result to you.

## How it works

```
RSS feeds  →  fetch-and-summarize.js  →  Claude  →  data/latest.json
                                                 →  data/archive/YYYY-MM-DD.json
                                                 →  data/archive/index.json
                                                       ↓
                                              static frontend (index.html)
```

The frontend only ever reads JSON files from `/data/`. There is no backend at runtime — the "backend" is a daily cron job that updates the JSON files.

## Project structure

```
/index.html
/style.css
/app.js
/package.json
/data
  /latest.json              # what the frontend renders
  /archive
    /index.json             # ["2026-05-01", ...]
    /2026-05-01.json        # one snapshot per day
/config
  /sources.json             # add/remove RSS feeds here
/scripts
  /fetch-and-summarize.js   # the daily update job
  /send-email.js            # emails the brief
/.github/workflows
  /daily-update.yml         # runs both scripts every morning
```

## 1. Run it locally

You need Node.js 18 or newer.

```bash
# install deps
npm install

# set your API key (in this shell session)
export ANTHROPIC_API_KEY=sk-ant-...

# generate today's brief (writes data/latest.json + an archive file)
npm run update

# serve the static site at http://localhost:8080
npm run serve
```

Open http://localhost:8080 and you should see the brief.

If you don't want to run the update yet, the repo ships with an example `data/latest.json` so the frontend works out of the box.

> **Note on `file://`** — Some browsers block `fetch()` for `file://` URLs. Always serve the site over HTTP (e.g. `npm run serve`, `python3 -m http.server`, or any static host) for local development.

## 2. Set your Anthropic API key

The script reads it from the `ANTHROPIC_API_KEY` environment variable.

**Locally:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or create a `.env` file (already gitignored) and source it:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
set -a && source .env && set +a
npm run update
```

**On GitHub Actions:** add it as a repository secret named `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions → New repository secret). The workflow already wires it up.

Get a key at https://console.anthropic.com/.

### Optional environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Override the model. Use `claude-opus-4-6` for higher-quality synthesis (more expensive). |
| `LOOKBACK_HOURS` | `24` | How far back to keep RSS items as "today's new articles". |
| `MAX_ITEMS_PER_FEED` | `10` | Cap per source so the prompt stays small. |
| `HISTORY_DAYS` | `30` | How many past archived briefs to include as historical context for weekly/monthly pattern detection. Set to `0` to disable history. |
| `HISTORY_ITEMS_PER_DAY` | `20` | Max items per past day included in the historical context block. |

## 3. Add new sources

Open `config/sources.json` and add an entry:

```json
{
  "name": "Dazed",
  "type": "rss",
  "url": "https://www.dazeddigital.com/rss",
  "category": "fashion"
}
```

- `name` — shown in the UI and in the source filter.
- `type` — only `"rss"` is supported today. Adding other types (e.g. `"json"` or `"sitemap"`) is the natural extension point: handle it in `fetchSource()` inside `scripts/fetch-and-summarize.js`.
- `url` — the RSS/Atom feed URL.
- `category` — a default category hint. Claude is allowed to override this per item.

The script picks up changes on the next run — no other code changes needed.

## 4. Hosting

The recommended setup is **GitHub Pages with a custom domain**, because every commit from the hourly workflow auto-redeploys the site without you doing anything. No FTP, no manual uploads, no cache headaches.

### Option A — GitHub Pages (recommended)

**Step 1: Enable Pages on the repo**

1. Push the repo to GitHub.
2. Go to repo → **Settings** → **Pages**.
3. Under "Build and deployment":
   - Source: **Deploy from a branch**
   - Branch: **main** · Folder: **/ (root)**
4. Click **Save**.

GitHub will start building. After ~1 minute your site is live at `https://<your-username>.github.io/CultureTracker/`.

**Step 2: Set the custom domain**

The repo already includes a `CNAME` file pointing to `tracker.thisisdefiant.com`. If you want a different domain, edit that file.

In GitHub: Settings → Pages → "Custom domain" → enter `tracker.thisisdefiant.com` → Save. (It probably already shows up because of the CNAME file in the repo.)

**Step 3: DNS records**

In your DNS provider for `thisisdefiant.com`, set the following on the `tracker` subdomain:

```
Type:   CNAME
Name:   tracker
Value:  <your-username>.github.io
TTL:    3600
```

(If your DNS provider doesn't allow CNAME on subdomains, use these four A records instead, pointing `tracker` to GitHub's Pages IPs:
`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.)

**Step 4: Wait + verify**

- DNS propagation: usually 5–30 minutes, sometimes up to a few hours.
- Once propagated, GitHub will auto-issue a free Let's Encrypt SSL certificate. Tick "Enforce HTTPS" in Settings → Pages.
- Visit `https://tracker.thisisdefiant.com/data/latest.json` — if it shows the freshest brief, you're done.

**Why this just works:**

The hourly GitHub Action commits `data/latest.json` and `data/archive/...` to the main branch. GitHub Pages auto-rebuilds on every push to main. So your site stays in sync with the script automatically.

The repo also includes a `.nojekyll` file. This tells Pages to skip Jekyll processing — faster builds and no surprises with files starting with `_`.

### Option B — Other static hosts

The site is plain HTML/CSS/JS with JSON files, so it works anywhere:

- **Netlify / Vercel / Cloudflare Pages** — connect the repo. No build command. Publish dir: `.` (root).
- **Shared hosting via FTP** — works but you have to manually re-upload `data/*.json` after each update, OR add an FTP deploy step to the GitHub Action. Not recommended at hourly cadence.
- **S3 / R2 / static buckets** — sync the files; serve via the bucket's website endpoint or a CDN.

Files you need to upload (if doing it manually):

```
index.html
style.css
app.js
CNAME           (only on GitHub Pages with custom domain)
.nojekyll       (only on GitHub Pages)
data/           (the whole folder, including archive/)
```

You do **not** need `node_modules/`, `scripts/`, `config/`, `package.json`, or `.github/` on the host — those only matter for running the update job.

## 5. GitHub Actions for automation

There are two separate workflows so you can update the data more often than you email yourself:

### `daily-update.yml` — Hourly culture update

- Runs at the top of every hour (`0 * * * *` UTC).
- Fetches feeds, asks Claude to summarize, commits `data/latest.json` and `data/archive/...` to the repo.
- **Does not send email** on scheduled runs. Email is opt-in for manual triggers via the dropdown.

### `daily-email.yml` — Daily email digest

- Runs once a day at 06:00 UTC (= 08:00 Brussels in summer / CEST, 07:00 in winter / CET).
- Reads whatever is currently in `data/latest.json` (kept fresh by the hourly workflow) and emails it.
- No Claude calls — the brief is already generated.

This split means you can change cadence on each side independently. Want updates every 3h instead? Change the cron in `daily-update.yml` to `0 */3 * * *`. Want a second email at the end of the day? Add a cron entry in `daily-email.yml`.

> **A note on Claude API cost.** Hourly updates = 24 API calls/day. With Sonnet 4.6 and a typical prompt (~10k input + 4k output tokens) that's roughly $1–1.50/day, ~$30–45/month. With Opus, multiply by 4–5. If that's too much, change the cron to every 3h or every 6h.

> **A note on archives.** Each hourly run for the same day overwrites `data/archive/YYYY-MM-DD.json`. So an "archive entry" is the latest snapshot for that day, not the morning version.

> **A note on DST.** GitHub Actions cron is UTC-only and does not track Daylight Saving Time. If you need exactly 08:00 Brussels year-round for the email, add a second cron entry to switch by season.

**To enable:**

1. Push the repo to GitHub.
2. Add `ANTHROPIC_API_KEY` as a repository secret.
3. Add the SMTP secrets (see next section).
4. (Optional) Trigger each workflow once manually via Actions → "Run workflow" to verify.

If you host on Netlify/Vercel/Pages from the same repo, every commit triggers a redeploy automatically — that means up to 24 redeploys/day at this cadence. If your host has a redeploy quota, drop the cron to every few hours. If you host elsewhere (e.g. FTP), add a deploy step at the end of the update workflow or run a separate sync job.

## 6. Daily email

The `scripts/send-email.js` script reads `data/latest.json` and emails it as a clean HTML digest. It runs as the last step of the daily workflow, so you get the brief in your inbox right after it's generated.

### Required GitHub secrets

Add these under Settings → Secrets and variables → Actions:

| Secret | Example | Purpose |
| --- | --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server |
| `SMTP_PORT` | `587` | Use 587 for STARTTLS, 465 for SSL/TLS |
| `SMTP_USER` | `lode@thisisdefiant.com` | SMTP username (usually your full email) |
| `SMTP_PASS` | `xxxx xxxx xxxx xxxx` | App password — see below |
| `EMAIL_FROM` | `Culture Tracker <lode@thisisdefiant.com>` | The "From" header |
| `EMAIL_TO` | `lode@thisisdefiant.com` | Recipient. Can be comma-separated. |
| `PUBLIC_URL` (optional) | `https://culture.thisisdefiant.com` | Shown as a "View online" link |

### Provider-specific setup

**Google Workspace / Gmail (recommended for `@thisisdefiant.com` if it's on Workspace):**

1. Enable 2-Step Verification on your Google account.
2. Go to https://myaccount.google.com/apppasswords and create an App Password named "Culture Tracker".
3. Use these values:
   - `SMTP_HOST = smtp.gmail.com`
   - `SMTP_PORT = 587`
   - `SMTP_USER = lode@thisisdefiant.com`
   - `SMTP_PASS = ` the 16-character app password (with or without spaces)
   - `EMAIL_FROM = Culture Tracker <lode@thisisdefiant.com>`
   - `EMAIL_TO = lode@thisisdefiant.com`

**Microsoft 365 / Outlook:**

- `SMTP_HOST = smtp.office365.com`
- `SMTP_PORT = 587`
- Authentication varies; you may need OAuth2 or to enable SMTP AUTH on the mailbox.

**Resend / SendGrid / Mailgun / Postmark / any SMTP relay:**

- Use whatever host/port/credentials they give you. Nodemailer speaks plain SMTP so anything works.

### Test it locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=lode@thisisdefiant.com
export SMTP_PASS="your-app-password"
export EMAIL_FROM="Culture Tracker <lode@thisisdefiant.com>"
export EMAIL_TO=lode@thisisdefiant.com
export PUBLIC_URL=https://culture.thisisdefiant.com   # optional

npm run daily   # runs update + email in one go
# or just:
npm run email   # if you only want to test the email with the existing latest.json
```

If something goes wrong, the script prints the SMTP error directly. The most common one is `Invalid login` — that means you're using your normal password instead of an app password.

## Why these dependencies?

The project has only two runtime dependencies, both for the update script:

- **`rss-parser`** — RSS and Atom have a lot of edge cases (CDATA, namespaces, malformed dates, etc.). Writing a correct parser is more code than it's worth; this one is widely used and well-maintained.
- **`@anthropic-ai/sdk`** — official SDK for the Claude API. We use it to keep request/response handling and error handling clean.

The frontend has **zero** dependencies — pure HTML/CSS/JS, no framework, no build step.

## Data structure

`data/latest.json` (and every file in `data/archive/`) is a three-layer report:

```json
{
  "date": "2026-05-01",
  "daily": {
    "title": "Daily Culture Brief",
    "intro": "Short summary of today's cultural landscape.",
    "themes": [
      {
        "title": "Theme title",
        "summary": "Why this theme stands out today.",
        "items": [
          {
            "title": "Item title",
            "summary": "What happened?",
            "cultural_relevance": "Why does this matter for popular culture?",
            "source": "Source name",
            "url": "https://example.com",
            "category": "fashion",
            "score": 8
          }
        ]
      }
    ]
  },
  "weekly_hypes": [
    {
      "title": "Pattern title",
      "description": "What's happening across multiple sources.",
      "why_it_matters": "Strategic angle for brands/creators.",
      "signals": ["signal 1", "signal 2"],
      "categories": ["fashion", "music"],
      "score": 7
    }
  ],
  "monthly_trends": [
    {
      "title": "Macro trend title",
      "description": "Longer-term cultural movement.",
      "cultural_shift": "What's actually shifting underneath.",
      "evidence": ["pattern 1", "pattern 2"],
      "implications": "What this means for brands, creators or culture.",
      "score": 8
    }
  ]
}
```

**The three layers:**

- **Daily signals** — specific events, drops, releases, announcements (1–3 day lifecycle).
- **Weekly hypes** — clusters of repeated signals across multiple sources, gaining attention.
- **Monthly trends** — deeper behavioural or aesthetic shifts across weeks/months.

`score` is an integer from 1 to 10: 1–3 = niche, 4–6 = emerging, 7–8 = gaining traction, 9–10 = mainstream / breakout.

Allowed daily categories: `music`, `fashion`, `film`, `internet`, `sport`, `gaming`, `art`, `brands`, `social`, `marketing`, `culture`, `trends`, `community`. Edit the prompt in `scripts/fetch-and-summarize.js` to add more.

**How the three layers actually get generated:**

- The script sends Claude two blocks: today's fresh articles (last 24h) and a compact "historical context" block covering the last `HISTORY_DAYS` (default 30) of archived briefs.
- **Daily signals** are generated only from today's fresh articles.
- **Weekly hypes** are detected as patterns visible across roughly the last 7 days of historical context (Claude scopes itself based on the prompt's instructions).
- **Monthly trends** are derived from patterns spanning the full historical window.

The historical block is intentionally compact — it includes only titles, sources, categories, and previously-flagged weekly/monthly themes per day — to keep token cost bounded. With default settings, the historical block adds roughly 8–10k input tokens to each call, costing ~$0.03 extra per call with Sonnet (~$0.70/day at hourly cadence).

On the very first run there's no archive, so weekly/monthly will be Claude's best educated guess from today only. After a few days of running, the layers become genuinely pattern-driven.

## Troubleshooting

- **"Could not load today's brief"** in the UI → make sure `data/latest.json` exists and you're serving the site over HTTP, not `file://`.
- **Empty brief / "No items fetched"** → one or more feeds may be down or rate-limiting. Check the script's console output; it logs each source.
- **Claude returned invalid JSON** → the script tries to recover by stripping code fences and slicing between the first `{` and last `}`. If it still fails, rerun; results are non-deterministic. You can also lower `MAX_ITEMS_PER_FEED` to keep the prompt smaller.
- **GitHub Action runs but nothing commits** → that means the diff was empty (nothing changed). Check the run logs to confirm the script actually wrote files.
