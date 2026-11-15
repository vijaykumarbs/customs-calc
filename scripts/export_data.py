#!/usr/bin/env python3
"""Export the BCD master workbook into compact JSON for the web app.

Usage:
    python scripts/export_data.py
    python scripts/export_data.py --master ../out/HSN_BCD_Master.csv \
        --workbook ../out/India_BCD_FTA_Master_v1.1.xlsx
"""

import argparse
import csv
import datetime as dt
import json
import os

import openpyxl

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MASTER = os.path.join(APP_DIR, "data-source", "HSN_BCD_Master.csv")
DEFAULT_WORKBOOK = os.path.join(APP_DIR, "data-source", "India_BCD_FTA_Master_v1.1.xlsx")
OUT_DIR = os.path.join(APP_DIR, "data")


def load_master(path):
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            flag = 0
            if "dataset-only" in (r.get("flags") or ""):
                flag = 2
            elif "parsed-approx" in (r.get("flags") or ""):
                flag = 1
            rows.append([
                r["hsn"],
                r["description"],
                int(r["chapter"]),
                round(float(r["bcd_statutory_pct"]), 2),
                round(float(r["bcd_effective_pct"]), 2),
                round(float(r["aidc_pct"]), 2),
                round(float(r["sws_pct_of_bcd"]), 2),
                round(float(r["igst_pct"]), 2),
                round(float(r["cess_pct"]), 2),
                flag,
            ])
    rows.sort(key=lambda x: x[0])
    return rows


def load_fta(path, order):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["FTA_Rate_Matrix"]
    it = ws.iter_rows(min_row=1, values_only=True)
    header = next(it)
    cols = list(header[4:24])  # E..X, the 20 agreements
    by_hsn = {}
    for row in it:
        hsn = str(row[0])
        by_hsn[hsn] = [round(float(v), 2) if v is not None else None
                       for v in row[3:24]]  # D..X = MFN + 20 agreements
    wb.close()
    rates = [by_hsn.get(h) for h, *_ in order]
    return cols, rates


def load_meta(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    fm = wb["FTA_Master"]
    fit = fm.iter_rows(min_row=1, values_only=True)
    fhead = next(fit)
    agreements = []
    for row in fit:
        if not row[0] or str(row[0]).startswith("India-EU FTA:"):
            continue
        agreements.append({
            "name": row[0],
            "type": row[1],
            "partners": row[2],
            "inforce": row[3],
            "notif": row[4],
            "commitment": row[5],
            "modelled": row[6],
            "col": row[7],
            "exclusions": row[8],
            "roo": row[9],
            "status": row[10],
            "source": row[11],
        })

    cm = wb["Country_Agreement_Map"]
    cit = cm.iter_rows(min_row=1, values_only=True)
    chead = next(cit)
    countries = []
    for row in cit:
        if not row[0]:
            continue
        countries.append({
            "name": row[0],
            "iso": row[1] or "",
            "region": row[2] or "",
            "agreement": row[3] or "MFN",
            "col": row[4] or "MFN",
            "alt": row[5] or "",
            "note": row[6] or "",
        })
    wb.close()
    countries.sort(key=lambda x: x["name"].lower())
    return agreements, countries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default=DEFAULT_MASTER)
    ap.add_argument("--workbook", default=DEFAULT_WORKBOOK)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    rows = load_master(args.master)
    cols, rates = load_fta(args.workbook, rows)
    agreements, countries = load_meta(args.workbook)

    meta = {
        "generated": dt.date.today().isoformat(),
        "data_as_of": "2025-06-30",
        "version": "1.1",
        "line_count": len(rows),
        "agreements": agreements,
        "countries": countries,
        "columns": cols,
        "free_daily_limit": 5,
        "price_inr": 99,
    }

    def dump(name, obj):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{name}: {os.path.getsize(path)/1024:.0f} KB")

    dump("hsn.json", rows)
    dump("fta.json", {"columns": cols, "rates": rates})
    dump("meta.json", meta)
    print(f"{len(rows)} HSN rows, {len(cols)} agreement columns, "
          f"{len(countries)} countries")


if __name__ == "__main__":
    main()
