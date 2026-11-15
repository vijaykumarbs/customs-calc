# CustomsCalc

A public India import duty calculator and a metered REST API, built on the
BCD/FTA master workbook. Search an HSN code, pick the country of origin and get
the full duty stack — BCD, AIDC, SWS, cess, IGST — plus landed cost and the best
applicable preferential rate.

The production site runs on **Cloudflare Pages advanced mode**: a Worker serves
the static assets and exposes the API, while the tariff dataset lives privately
in **Cloudflare D1**. The browser never downloads `hsn.json` or `fta.json`.

- **14,416** eight-digit tariff lines
- **20** trade agreements, **78** country mappings
- **5** free website calculations per day (IST)
- **10** free API calls per IST calendar month, then a ₹99/month unlimited (fair use) plan
- HSN search is free on both surfaces; only rate lookups and calculations count

> Indicative estimates only. Not legal or customs advice. Confirm every rate on
> ICEGATE before filing a Bill of Entry.

**Live:** <https://customs.vijayebhava.com>
**API docs:** <https://customs.vijayebhava.com/api-docs/>

## What it does

1. **HSN search** — by 2–8 digit code prefix or product description, keyboard friendly.
2. **Duty stack** — BCD, SWS (10% of BCD), AIDC, cess and IGST applied in the
   correct order on the CIF assessable value.
3. **FTA comparison** — maps the origin country to its agreement, compares the
   preferential rate with MFN and applies the lower one.
4. **Landed cost** — total duty, effective duty percentage and landed cost,
   with a copy-ready breakdown.
5. **Website quota** — 5 calculations per Indian calendar day, enforced by the
   Worker with an anonymous `cc_client` cookie and a per-IP abuse backstop.
6. **Public API** — self-serve keys, SHA-256 hashed at rest, 10 billable calls
   per IST month on the free plan, unlimited fair use on the paid plan.
7. **API docs page** — auth, endpoints, examples, errors, limits and signup at
   `/api-docs/`.

## Architecture

```
Browser / external app
        │
        ▼
Cloudflare Pages ── web/_worker.js
        │                │
        │                ├── /api/site/*   cookie quota, 5 quotes/day
        │                ├── /api/v1/*     API keys, 10 calls/month free
        │                ├── /api/admin/*  ADMIN_TOKEN operations
        │                └── env.ASSETS    HTML, CSS, JS, docs
        │
        └── D1 (customs-calc)
              hsn, settings, api_keys, api_usage, site_usage,
              rate_limits, waitlist, signup_log
```

Only `code` and `description` leave the database on search. Rate fields are
returned by authenticated lookups or metered calculations.

## Repository layout

```
customs-app/
├── web/                       Pages deployment directory
│   ├── _worker.js             routing, auth, quota, D1 access
│   ├── index.html             calculator
│   ├── api-docs/index.html    API documentation + key signup
│   ├── 404.html
│   ├── assets/
│   │   ├── app.js             calculator UI (talks to /api/site/*)
│   │   ├── docs.js            docs copy buttons and signup form
│   │   ├── duty.js            pure duty engine (Worker + Node tests)
│   │   └── styles.css
│   ├── _headers               CSP, frame and cache headers
│   ├── favicon.svg
│   ├── manifest.webmanifest
│   ├── robots.txt
│   └── sitemap.xml
├── data/                      private data, never served by Pages
│   ├── hsn.json               compact 14,416-row dataset
│   ├── fta.json               20 agreement columns, aligned by index
│   ├── meta.json              agreements, countries, limits, price
│   ├── schema.sql             D1 schema (idempotent)
│   └── seed.sql               generated tariff + settings insert
├── data-source/               source workbook, CSV and provenance notes
├── backend/                   optional local FastAPI/SQLite service
├── scripts/
│   ├── export_data.py         rebuild data/*.json from the workbook
│   ├── build_seed.mjs         generate data/seed.sql
│   └── generate_vectors.mjs   regenerate parity vectors
├── tests/
│   ├── duty.test.mjs          Node duty + search tests
│   ├── test_duty.py           Python parity tests
│   └── vectors.json
├── package.json
├── requirements.txt
└── wrangler.toml              Pages + D1 binding
```

## Quick start

```bash
npm install
node scripts/build_seed.mjs

# create the local D1 database and load the tariff
npx wrangler d1 execute customs-calc --local --file=data/schema.sql
npx wrangler d1 execute customs-calc --local --file=data/seed.sql

# run Pages advanced mode locally (Worker + assets + D1)
npx wrangler pages dev web --port 8788
# open http://localhost:8788
# docs at http://localhost:8788/api-docs/
```

`npm run db:local` runs both D1 commands. Add `ADMIN_TOKEN` to `.dev.vars`
(gitignored) to test the admin endpoints locally.

## Data

`data/hsn.json` is an array of compact rows, sorted by HSN:

```
[hsn, description, chapter, bcdStatutory, bcdEffective,
 aidc, swsPctOfBcd, igst, cess, flag]
```

`flag` is `0` for a line-level CBIC rate, `1` for an approximate parse and `2`
for a dataset-only/legacy line. `data/fta.json` holds the 20 agreement columns
and one rate array per HSN, aligned by index. Index `0` in each rate array is MFN.

`build_seed.mjs` turns those files into `data/seed.sql` and stores the full
metadata (including `free_api_monthly_limit: 10`) in the `settings` table. The
seed uses a staging table and swaps it in, so a failed import does not leave a
half-empty tariff.

Regenerate from the source files:

```bash
python scripts/export_data.py
node scripts/build_seed.mjs
node scripts/generate_vectors.mjs
npx wrangler d1 execute customs-calc --remote --file=data/seed.sql
```

`data-source/README.md` documents provenance, accuracy and refresh steps. Key
caveats carried over from the workbook:

- 11,906 of 14,416 codes have line-level statutory BCD from the CBIC
  working-tariff PDFs (as on 30.06.2025); 2,510 are dataset-only and flagged.
- 144 parses of compound/specific-duty rows are approximate and flagged.
- Effective BCD differs from statutory BCD only on roughly 20 curated
  high-volume lines.
- AIDC is populated only for gold and silver. Anti-dumping duty, safeguard duty,
  TRQs and origin testing are out of scope.
- Mauritius, Chile, Mercosur, APTA and GSTP are limited PTAs; they are shown at
  MFN and are not modelled line by line.
- The UAE CEPA column uses 533 curated line-level rates from
  `data/indiaftaduty.csv`, including lines marked not eligible.

## Duty logic

The assessable value follows a bill-of-entry build-up:

```
Assessable value = invoice/FOB value + freight + insurance + other includible charges
```

`freight`, `insurance` and `otherCharges` are optional. The legacy `cif` field
can still be sent on its own as a direct assessable value. For assessable value
`CIF` and the applicable BCD rate:

```
BCD  = CIF × BCD rate
SWS  = BCD × 10%
AIDC = CIF × AIDC rate
Cess = CIF × cess rate
IGST = (CIF + BCD + SWS + AIDC + cess) × IGST rate
Duty before IGST = BCD + SWS + AIDC + Cess
Total payable to customs = Duty before IGST + IGST
Landed cost = CIF + Total payable to customs
```

When the origin country has an agreement, `applicable BCD = min(MFN, FTA rate)`.
A preferential rate that is equal to or higher than MFN is ignored. All money
values are rounded to two decimals at each step.

The same logic exists in `web/assets/duty.js` (used by the Worker and the
browser) and `backend/duty.py`. Both are tested against `tests/vectors.json`, so
a change in one that is not mirrored in the other fails the suite.

## Public API

Base URL: `https://customs.vijayebhava.com`

Create a key from the docs page or directly:

```bash
curl -X POST https://customs.vijayebhava.com/api/v1/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@company.com"}'
```

The plaintext key is returned once and stored only as a SHA-256 hash. Send it as
`Authorization: Bearer cc_live_...` or `X-API-Key: cc_live_...`.

| Method | Path | Quota | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/hsn/{code}` | 1 call | Rate stack and preferential rates |
| `POST` | `/api/v1/calculate` | 1 call | Landed cost |
| `POST` | `/api/v1/calculate/batch` | 1 call / line | Up to 20 lines in one request |
| `GET` | `/api/v1/search?q=` | Free | Code + description only |
| `GET` | `/api/v1/meta` | Free | Dataset metadata |
| `GET` | `/api/v1/usage` | Free | Monthly usage and reset date |
| `POST` | `/api/v1/signup` | Free | Create a key |

Example:

```bash
curl -X POST https://customs.vijayebhava.com/api/v1/calculate \
  -H "Authorization: Bearer $CUSTOMS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"hsn":"85171300","country":"Japan","goodsValue":100000,"freight":5000,"insurance":1000,"otherCharges":500}'
```

Every calculation response includes `valuation` (the build-up), `amounts.dutyBeforeIgst`,
`amounts.totalDuty` and `dataAsOf` (the tariff date). The legacy `cif` field is still
accepted as a direct assessable value when no charge fields are sent.

All responses are JSON. Success payloads are wrapped in `data`; failures use:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "The free API plan includes 10 billable calls per month. Upgrade to continue.",
    "docs": "https://customs.vijayebhava.com/api-docs/",
    "limit": 10,
    "used": 10,
    "period": "2026-11",
    "resetsOn": "2026-12-01"
  }
}
```

CORS is open for `/api/v1/*`. Never put a key in a public browser page; call the
API from your own server.

### Website API

The calculator uses first-party endpoints. They are not part of the public
contract and may change:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/site/meta` | Agreements, countries, limits |
| `GET` | `/api/site/search?q=` | Search without rates |
| `GET` | `/api/site/hsn/{code}` | Code + description for deep links |
| `GET` | `/api/site/quota` | Today's cookie quota |
| `POST` | `/api/site/quote` | Calculate and consume one daily quote |
| `POST` | `/api/site/notify` | Pricing waitlist email |

### Admin operations

Set a high-entropy secret once:

```bash
openssl rand -hex 32 | npx wrangler pages secret put ADMIN_TOKEN \
  --project-name india-customs-duty
```

Then send `X-Admin-Token` to:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/stats` | Key counts, calls this month, signups |
| `GET` | `/api/admin/keys?email=` | Inspect keys and usage |
| `POST` | `/api/admin/create` | Issue a key manually |
| `POST` | `/api/admin/plan` | Upgrade or downgrade by email or prefix |
| `POST` | `/api/admin/revoke` | Revoke by id, email or prefix |
| `POST` | `/api/admin/rotate` | Replace an email's key |

```bash
curl -X POST https://customs.vijayebhava.com/api/admin/plan \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@company.com","plan":"paid"}'
```

Paid activation is deliberately manual until a payment provider is connected.

## Security model

- The tariff JSON lives in `data/` and D1 only. `wrangler.toml` deploys `web/`,
  and the Worker returns 404 for `/data/`, `/data-source/`, `/scripts/`,
  `/tests/`, `/backend/`, `_worker.js` and config files.
- Search returns code + description, caps at 25 rows and is rate-limited, so the
  dataset cannot be bulk-downloaded through search.
- API keys are random 32-byte values prefixed `cc_live_`, hashed with SHA-256
  before storage, and shown exactly once.
- Signup is limited to 3 keys per hashed IP per day and one key per email.
- Quota is reserved atomically in D1 before rates are returned, so concurrent
  requests cannot exceed the monthly allowance.
- The website quota uses an HttpOnly cookie plus a 40/day IP backstop. A cookie
  reset bypasses the cookie count, so the IP limit caps casual abuse.
- The Worker sets `Cache-Control: no-store` on every API response.

This is abuse resistance, not DRM. Anyone entitled to query rates can read the
rates they query; the goal is to stop trivial bulk extraction.

## Free quota and plans

| Surface | Limit | Reset | Identity |
|---|---|---|---|
| Website calculator | 5 calculations/day | Midnight IST | `cc_site` cookie + IP backstop |
| API free plan | 10 billable calls/month | 1st of month, IST | Hashed API key |
| API paid plan | Unlimited fair use | — | Hashed API key |

Search, metadata and usage checks never consume quota. The ₹99/month plan
remains a placeholder; the pricing modal stores emails in D1 through
`POST /api/site/notify`.

## Tests

```bash
npm test                     # Node duty + search tests
python -m unittest discover -s tests -p "test_*.py"

# after changing rate logic or data
node scripts/generate_vectors.mjs
```

The Node suite reads `data/hsn.json` and `data/fta.json` directly. Worker
behaviour is exercised against local D1 with `wrangler pages dev`.

## Deploy to Cloudflare Pages

The repository is deployed by direct upload to the private Pages project
`india-customs-duty`.

```bash
# one-time, after creating the D1 database and setting the binding
npx wrangler d1 execute customs-calc --remote --file=data/schema.sql
npx wrangler d1 execute customs-calc --remote --file=data/seed.sql

# every release
npx wrangler pages deploy web --project-name india-customs-duty --branch main
```

`wrangler.toml`:

```toml
name = "india-customs-duty"
pages_build_output_dir = "web"
compatibility_date = "2026-11-14"

[[d1_databases]]
binding = "DB"
database_name = "customs-calc"
database_id = "d0a66a58-5dc8-444f-883d-d9f686a0da3b"
```

Direct upload does not redeploy on `git push`. To deploy on every push, connect
the repository in the Pages dashboard (private repos need the Cloudflare GitHub
app) or add a GitHub Actions step with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

### Dashboard

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Select the repo. Build command: leave empty. Build output directory: `web`.
3. Deploy. The project gets a `<project>.pages.dev` URL.
4. **Custom domains** → add `customs.vijayebhava.com`.

### DNS for the subdomain

Preferred URL: **https://customs.vijayebhava.com**

- If `vijayebhava.com` is on Cloudflare DNS, add a proxied CNAME under
  **DNS → Records**: `customs` → `india-customs-duty.pages.dev`. Pages verifies
  it and issues the certificate automatically.
- Otherwise create the same CNAME at your DNS host.

### Why not `vijayebhava.com/customs/`?

Pages custom domains are hostnames, not paths. Hosting the app under a
subdirectory of the existing site needs a Cloudflare Worker or a reverse proxy
that serves the Pages project on that route. The subdomain is simpler and is
what this repo is set up for.

## Optional local FastAPI backend

`backend/` remains available for offline experiments and as a self-hosted
reference. It loads `data/*.json` and keeps SQLite usage, subscriptions and a
calculation log. It is not used in production and does not implement the
Worker's `/api/v1` key model.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --reload --port 8000
```

## Roadmap

- Razorpay subscription in place of the notify form, with signed webhooks.
- Email verification and self-serve key rotation.
- Line-level schedules for the five limited PTAs and broader AIDC coverage.
- Bulk/batch calculation endpoint for costing systems.
- Saved shipments and printable costing sheets.

## Licence, data and privacy

- Application source code: **MIT** — see [`LICENSE`](LICENSE).
- Tariff dataset, master workbook, derived JSON/SQL and API rate data:
  **proprietary, not for redistribution** — see
  [`DATA-LICENSE.md`](DATA-LICENSE.md). The repository is private and the raw
  dataset is never served by the public website.
- Privacy policy: <https://customs.vijayebhava.com/privacy/>
- Terms of use: <https://customs.vijayebhava.com/terms/>
- The website stores an anonymous `cc_client` cookie for the daily quota, a
  hashed IP for abuse limits, optional waitlist emails and anonymous calculation
  records. See the privacy policy for retention and deletion.

## Sources and disclaimer

Rates are compiled from CBIC working-tariff chapter PDFs, the GST rate
schedule, CBIC notifications and public HSN datasets. Trade-agreement rates are
derived from coverage rules and the curated data described above, not from every
line-level schedule. The calculation excludes anti-dumping duty, safeguard duty,
tariff-rate quotas, specific duties, valuation adjustments and origin
verification.

**Verify every rate against ICEGATE and the current CBIC notification before
filing.**
