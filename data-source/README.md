# India BCD & FTA Preferential Duty Master — v1.1

Prepared 13-Nov-2026.

> **Proprietary data.** These files are not covered by the MIT licence for the
> application code. They are private to the operator and may not be redistributed
> in bulk. See [`../DATA-LICENSE.md`](../DATA-LICENSE.md).

## Files

| File | What it is |
|---|---|
| `India_BCD_FTA_Master_v1.1.xlsx` | Main workbook (8 sheets, see below) |
| `HSN_BCD_Master.csv` | Flat master, one row per 8-digit HSN (for ERP import) |
| `FTA_Rate_Long.csv` | Long format, one row per HSN × agreement (288,320 rows) |

## Workbook sheets

1. **README** – scope, sources, warnings, legend.
2. **HSN_BCD_Master** – 14,416 lines: statutory BCD, indicative effective BCD, AIDC, SWS, IGST, cess, source and verification flag.
3. **FTA_Rate_Matrix** – the same HSNs × 20 agreements. Green = 0%, grey = no better than MFN, amber = positive preferential rate. Orange headers = line-specific concession not modelled.
4. **Duty_Calculator** – HSN + country + CIF → BCD, SWS, AIDC, IGST, total duty, landed cost.
5. **Country_Agreement_Map** – 78 countries mapped to the applicable agreement.
6. **FTA_Master** – 20 agreements + MFN: partners, entry into force, notification, India's commitment, exclusions, rules of origin.
7. **Rules_Assumptions** – how every column was derived.
8. **Change_Log** – version history.

## Accuracy summary

- **11,906 of 14,416** codes carry a line-level statutory BCD parsed from the 97 CBIC working-tariff chapter PDFs (as on 30.06.2025). 144 of those parses are approximate (compound/specific-duty rows) and are flagged.
- **2,510** codes exist only in the public HSN dataset (mostly legacy / re-split codes) and keep the dataset's chapter-default rate. They are flagged `Dataset only - verify`.
- **Effective BCD** equals statutory BCD except for ~20 curated high-volume lines (e.g. smartphones 15%, wooden furniture 20%, gold 10% + 5% AIDC).
- **FTA rates are derived from coverage rules**, not from line-level concession schedules. Mauritius, Chile, Mercosur, APTA and GSTP are shown at MFN (orange headers) and must be loaded line by line.
- AIDC is populated only for gold/silver. Anti-dumping duty, safeguard duty, TRQ and origin testing are out of scope.

## Refresh

```bash
.venv/bin/python parse_cbic_tariff.py     # re-parse chapter PDFs in data/pdf
.venv/bin/python build_bcd_master.py      # rebuild workbook + CSVs
```

Update `AGREEMENTS` in `build_bcd_master.py` when a notification or entry-into-force date changes.

**Not legal advice.** Verify every rate used for a Bill of Entry against ICEGATE / the current CBIC notification.

## Inside this app

`data-source/` keeps the two source files the exporter needs. The production
site runs from compact JSON imported into Cloudflare D1 from `data/`, so neither
these workbooks nor the exported JSON are served to browsers.

```bash
python scripts/export_data.py     # rebuild data/*.json from data-source/
node scripts/build_seed.mjs       # rebuild data/seed.sql for D1
```
