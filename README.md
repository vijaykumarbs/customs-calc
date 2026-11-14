# CustomsCalc

A small, public India import duty calculator built on the BCD/FTA master
workbook. Search an HSN code, pick the country of origin and get the full duty
stack — BCD, AIDC, SWS, cess, IGST — plus landed cost and the best applicable
preferential rate.

The production site is static: no build step, no server, no database. Duty
logic runs in the browser from compact JSON. An optional FastAPI service adds
server-side quota enforcement and a place to plug payments in later.

- **14,416** eight-digit tariff lines
- **20** trade agreements, **78** country mappings
- **5** free landed-cost calculations per day (IST), then a ₹99/month plan
- HSN lookup is free and unlimited

> Indicative estimates only. Not legal or customs advice. Confirm every rate on
> ICEGATE before filing a Bill of Entry.

**Live:** <https://customs.vijayebhava.com>

## What it does

1. **HSN search** — by 4–8 digit code or product description, keyboard friendly.
2. **Duty stack** — BCD, SWS (10% of BCD), AIDC, cess and IGST applied in the
   correct order on the CIF assessable value.
3. **FTA comparison** — maps the origin country to its agreement, compares the
   preferential rate with MFN and applies the lower one.
4. **Landed cost** — total duty, effective duty percentage and landed cost,
   with a copy-ready breakdown.
5. **Free quota** — 5 calculations per Indian calendar day. HSN lookups stay free.
6. **Paywall placeholder** — a ₹99/month unlimited plan with a “notify me” form.
   No payment is collected in this version.

## Quick start

### Static site (what ships)

```bash
cd customs-app
npm run serve          # python3 -m http.server 8080 --directory web
# open http://localhost:8080
```

There is no build step. The browser loads `web/data/*.json` (about 3 MB total,
gzip ≈ 500 KB) and computes everything locally.

### Optional API

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

uvicorn backend.app:app --reload --port 8000
# app:  http://localhost:8000
# docs: http://localhost:8000/docs
```

The API serves the same `web/` directory and adds SQLite-backed quota,
subscription emails and a calculation log. `backend/data/app.db` is created on
first start and is gitignored.

## Repository layout

```
customs-app/
├── web/                     deployable static site
│   ├── index.html
│   ├── 404.html
│   ├── assets/
│   │   ├── app.js           UI, search, quota, URL state
│   │   ├── duty.js          pure duty engine (browser + Node tests)
│   │   └── styles.css
│   ├── data/                exported JSON (committed)
│   │   ├── hsn.json
│   │   ├── fta.json
│   │   └── meta.json
│   ├── _headers             Cloudflare Pages security + cache headers
│   ├── favicon.svg
│   ├── manifest.webmanifest
│   ├── robots.txt
│   └── sitemap.xml
├── backend/
│   ├── app.py               optional FastAPI service
│   └── duty.py              Python mirror of duty.js
├── data-source/             source workbook + flat CSV (not served)
├── scripts/
│   ├── export_data.py       rebuild web/data/*.json
│   └── generate_vectors.mjs regenerate parity vectors
├── tests/
│   ├── duty.test.mjs        Node tests
│   ├── test_duty.py         Python + parity tests
│   └── vectors.json         shared expected results
├── package.json
├── requirements.txt
└── wrangler.toml
```

## Data

`web/data/hsn.json` is an array of compact rows, sorted by HSN:

```
[hsn, description, chapter, bcdStatutory, bcdEffective,
 aidc, swsPctOfBcd, igst, cess, flag]
```

`flag` is `0` for a line-level CBIC rate, `1` for an approximate parse and `2`
for a dataset-only/legacy line. `web/data/fta.json` holds the 20 agreement
columns and one rate array per HSN, aligned by index. Index `0` in each rate
array is MFN.

Regenerate from the source files:

```bash
python scripts/export_data.py
node scripts/generate_vectors.mjs
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

For assessable value `CIF` and the applicable BCD rate:

```
BCD  = CIF × BCD rate
SWS  = BCD × 10%
AIDC = CIF × AIDC rate
Cess = CIF × cess rate
IGST = (CIF + BCD + SWS + AIDC + cess) × IGST rate
Duty = BCD + SWS + AIDC + Cess + IGST
Landed cost = CIF + Duty
```

When the origin country has an agreement, `applicable BCD = min(MFN, FTA rate)`.
A preferential rate that is equal to or higher than MFN is ignored. All money
values are rounded to two decimals at each step.

The same logic exists in `web/assets/duty.js` and `backend/duty.py`. Both are
tested against `tests/vectors.json`, so a change in one that is not mirrored in
the other fails the suite.

## Free quota and paywall

**Static site.** `localStorage` stores `{day, used}` under
`customscalc.quota.v1`. The day is the Asia/Kolkata date, so the limit resets at
midnight IST. HSN searches do not touch the counter.

This is deliberately client-side: it is easy to bypass and is not a security
boundary. It lets people try the product without an account.

**Server mode.** `POST /api/calculate` keeps usage in SQLite keyed by an
anonymous `cc_client` cookie and the IST day. The sixth call returns HTTP 402
with an upgrade payload. Move the frontend to this endpoint when payments go
live.

The ₹99/month plan is a placeholder. The “notify me” form stores the email
locally in the static site, or in the `subscriptions` table through
`POST /api/subscribe` when the API is running.

## Tests

```bash
npm test                     # Node duty + search tests
python -m unittest discover -s tests -p "test_*.py"

# after changing rate logic or data
node scripts/generate_vectors.mjs
```

## Deploy to Cloudflare Pages

The site is plain static files, so Cloudflare Pages can serve `web/` directly.
FastAPI cannot run on Pages; deploy it separately (Render, Railway, Fly.io) if
you need server-side quota.

### Dashboard

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
3. Select the repo. Build command: leave empty. Build output directory: `web`.
4. Deploy. The project gets a `<project>.pages.dev` URL.
5. **Custom domains** → add `customs.vijayebhava.com`.

### Wrangler

```bash
npm install --save-dev wrangler
npx wrangler login
npx wrangler pages project create india-customs-duty --production-branch main
npx wrangler pages deploy web --project-name india-customs-duty
```

`wrangler.toml` already sets `pages_build_output_dir = "web"`, so
`npx wrangler pages deploy` also works once the project exists.

If `npx wrangler` fails with a `workerd` optional-dependency error, install
Wrangler locally (as above) instead of running it through `npx` from a global
cache, and make sure npm is not configured with `omit=optional`.

### DNS for the subdomain

Preferred URL: **https://customs.vijayebhava.com**

- If `vijayebhava.com` uses Cloudflare DNS, adding the custom domain in Pages
  creates the proxied `CNAME` automatically.
- Otherwise create a `CNAME` record at your DNS host:
  `customs` → `india-customs-duty.pages.dev`.

### Why not `vijayebhava.com/customs/`?

Pages custom domains are hostnames, not paths. Hosting the app under a
subdirectory of the existing site needs a Cloudflare Worker or a reverse proxy
that serves the Pages project on that route. The subdomain is simpler and is
what this repo is set up for.

`web/_headers` adds CSP, frame, referrer and cache headers on every Pages
deploy. If you add third-party scripts or a payment SDK later, update the CSP
at the same time.

## API (optional backend)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Line, agreement and country counts |
| `GET` | `/api/meta` | Agreements, countries, free limit and price |
| `GET` | `/api/search?q=smartphone&limit=12` | Search tariff lines |
| `GET` | `/api/hsn/{code}` | One line plus its preferential rates |
| `POST` | `/api/calculate` | `{hsn, country, cif}` → breakdown and quota |
| `GET` | `/api/quota` | Current anonymous usage |
| `POST` | `/api/subscribe` | `{email}` → waitlist record |

Example:

```bash
curl -X POST http://localhost:8000/api/calculate \
  -H 'Content-Type: application/json' \
  -d '{"hsn":"85171300","country":"Japan","cif":100000}'
```

## Roadmap

- Razorpay subscription in place of the notify form, with signed webhooks.
- Real accounts so a paid plan works across devices.
- Server-side quota for the public site, not only the optional API.
- Line-level schedules for the five limited PTAs and broader AIDC coverage.
- Saved shipments and CSV export for costing sheets.

## Sources and disclaimer

Rates are compiled from CBIC working-tariff chapter PDFs, the GST rate
schedule, CBIC notifications and public HSN datasets. Trade-agreement rates are
derived from coverage rules and the curated data described above, not from every
line-level schedule. The calculation excludes anti-dumping duty, safeguard duty,
tariff-rate quotas, specific duties, valuation adjustments and origin
verification.

**Verify every rate against ICEGATE and the current CBIC notification before
filing.**
