# Culture Tracker

A lightweight daily brief of what's happening in popular culture. The frontend is a static HTML/CSS/JS site you can host anywhere. A Node.js script (run locally or via GitHub Actions) fetches RSS feeds, groups them by category, writes a fresh JSON file every hour, and emails the result to you once a day.

**No API keys required.** No Claude, no OpenAI, no paid services. Just RSS in, JSON out.

## How it works

```
RSS feeds  →  fetch-and-summarize.js  →  data/latest.json
                                      →  data/archive/YYYY-MM-DD.json
                                      →  data/archive/index.json
                                            ↓
                                     static frontend (index.html)
```

The frontend only ever reads JSON files from `/data/`. There is no backend at runtime — the "backend" is a cron job that updates the JSON files.

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
  /fetch-and-summarize.js   # the update job (RSS → grouped JSON)
  /send-email.js            # emails the brief
/.github/workflows
  /daily-update.yml         # runs the fetch every hour
  /daily-email.yml          # emails once a day
```

## 1. Run it locally

You need Node.js 18 or newer.

```bash
# install deps (just rss-parser and nodemailer)
npm install

# generate today's brief (writes data/latest.json + an archive file)
npm run update

# serve the static site at http://localhost:8080
npm run serve
```

Open http://localhost:8080 and you should see the brief.

If you don't want to run the update yet, the repo ships with an example `data/latest.json` so the frontend works out of the box.

> **Note on `file://`** — Some browsers block `fetch()` for `file://` URLs. Always serve the site over HTTP (e.g. `npm run serve`, `python3 -m http.server`, or any static host) for local development.

### Optional environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `LOOKBACK_HOURS` | `24` | How far back to keep RSS items as "today's new articles". |
| `MAX_ITEMS_PER_FEED` | `10` | Cap per source to keep the brief readable. |

## 2. Add new sources

Open `config/sources.json` and add an entry:

```json
{
  "name": "Dazed",
  "type": "rss",
  "url": "https://www.dazeddigital.com/rss",
  "category": "fashion"
}
```

- `name` — shown in the UI and the source filter.
- `type` — only `"rss"` is supported. Entries with other types are skipped.
- `url` — the RSS/Atom feed URL.
- `category` — the bucket this source belongs to. Categories are the section headings in the brief; sources sharing a category are grouped together.

The script picks up changes on the next run — no other code changes needed.

Common categories: `music`, `fashion`, `film`, `internet`, `sport`, `gaming`, `art`, `brands`, `social`, `marketing`, `culture`, `trends`, `community`. Anything else is allowed; unknown categories appear with a Title-Cased label after the known ones.

## 3. Hosting

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

In GitHub: Settings → Pages → "Custom domain" → enter `tracker.thisisdefiant.com` → Save.

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

### Option B — Other static hosts

The site is plain HTML/CSS/JS with JSON files, so it works anywhere:

- **Netlify / Vercel / Cloudflare Pages** — connect the repo. No build command. Publish dir: `.` (root).
- **Shared hosting via FTP** — works but you have to manually re-upload `data/*.json` after each update, OR add an FTP deploy step to the GitHub Action.
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

## 4. GitHub Actions for automation

There are two separate workflows so you can update the data more often than you email yourself:

### `daily-update.yml` — Hourly culture update

- Runs at the top of every hour (`0 * * * *` UTC).
- Fetches feeds, groups by category, commits `data/latest.json` and `data/archive/...` to the repo.
- **Free.** No external API calls beyond the RSS feeds.
- **Does not send email** on scheduled runs. Email is opt-in for manual triggers via the dropdown.

### `daily-email.yml` — Daily email digest

- Runs once a day at 06:00 UTC (= 08:00 Brussels in summer / CEST, 07:00 in winter / CET).
- Reads whatever is currently in `data/latest.json` and emails it.

This split lets you change the cadence on each side independently. Want updates every 3h instead? Change the cron in `daily-update.yml` to `0 */3 * * *`. Want a second email at the end of the day? Add a cron entry in `daily-email.yml`.

> **A note on archives.** Each hourly run for the same day overwrites `data/archive/YYYY-MM-DD.json`. So an "archive entry" is the latest snapshot for that day, not the morning version.

> **A note on DST.** GitHub Actions cron is UTC-only and does not track Daylight Saving Time. If you need exactly 08:00 Brussels year-round for the email, add a second cron entry to switch by season.

**To enable:**

1. Push the repo to GitHub.
2. Add the SMTP secrets (see next section) for the daily email workflow.
3. (Optional) Trigger each workflow once manually via Actions → "Run workflow" to verify.

If you host on Netlify/Vercel/Pages from the same repo, every commit triggers a redeploy — that means up to 24 redeploys/day at this cadence. If your host has a redeploy quota, drop the cron to every few hours.

## 5. Daily email

The `scripts/send-email.js` script reads `data/latest.json` and emails it as a clean HTML digest.

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
| `PUBLIC_URL` (optional) | `https://tracker.thisisdefiant.com` | Shown as a "View online" link |

### Provider-specific setup

**Google Workspace / Gmail:**

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
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=lode@thisisdefiant.com
export SMTP_PASS="your-app-password"
export EMAIL_FROM="Culture Tracker <lode@thisisdefiant.com>"
export EMAIL_TO=lode@thisisdefiant.com
export PUBLIC_URL=https://tracker.thisisdefiant.com   # optional

npm run daily   # runs update + email in one go
# or just:
npm run email   # if you only want to test the email with the existing latest.json
```

If something goes wrong, the script prints the SMTP error directly. The most common one is `Invalid login` — that means you're using your normal password instead of an app password.

## Why these dependencies?

The project has only two runtime dependencies:

- **`rss-parser`** — RSS and Atom have a lot of edge cases (CDATA, namespaces, malformed dates, etc.). Writing a correct parser is more code than it's worth.
- **`nodemailer`** — only needed if you use the email workflow. Plain SMTP, no provider lock-in.

The frontend has **zero** dependencies — pure HTML/CSS/JS, no framework, no build step.

## Data structure

`data/latest.json` (and every file in `data/archive/`) has this shape:

```json
{
  "date": "2026-05-01",
  "daily": {
    "title": "Culture Brief",
    "intro": "27 items from 12 sources across 8 categories, last 24 hours.",
    "themes": [
      {
        "title": "Fashion",
        "summary": "",
        "items": [
          {
            "title": "Item title",
            "summary": "Short snippet from the feed",
            "source": "Highsnobiety",
            "url": "https://example.com",
            "category": "fashion",
            "published": "2026-05-01T08:30:00Z"
          }
        ]
      }
    ]
  },
  "weekly_hypes": [],
  "monthly_trends": []
}
```

`weekly_hypes` and `monthly_trends` are kept in the JSON for backward compatibility with the frontend and email renderer. They are always empty in this RSS-only version — those layers needed AI synthesis to be meaningful.

## Troubleshooting

- **"Could not load today's brief"** in the UI → make sure `data/latest.json` exists and you're serving the site over HTTP, not `file://`.
- **Empty brief / "No items fetched"** → one or more feeds may be down or rate-limiting. Check the script's console output; it logs each source.
- **A specific feed always errors** → try opening the feed URL in a browser. RSS feeds disappear and rename more often than you'd think. Edit `config/sources.json`.
- **GitHub Action runs but nothing commits** → that means the diff was empty (nothing changed since the last hourly run). Check the run logs to confirm the script actually wrote files.
