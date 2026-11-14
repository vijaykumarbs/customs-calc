"""Parity and unit tests for the optional FastAPI backend.

Run from the ``customs-app`` directory:

    python -m unittest discover -s tests -p "test_*.py"
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.duty import (  # noqa: E402
    compute_duty,
    fta_column_index,
    preferential_rate,
    search_hsn,
)

VECTORS = json.loads((ROOT / "tests" / "vectors.json").read_text(encoding="utf-8"))
ROWS = json.loads((ROOT / "web" / "data" / "hsn.json").read_text(encoding="utf-8"))
FTA = json.loads((ROOT / "web" / "data" / "fta.json").read_text(encoding="utf-8"))


class VectorParityTest(unittest.TestCase):
    def test_vectors_match_browser_module(self):
        for vector in VECTORS:
            with self.subTest(vector["name"]):
                actual = compute_duty(vector["cif"], vector["row"], vector["ftaRate"])
                self.assertEqual(actual, vector["expected"])


class DutyTest(unittest.TestCase):
    def setUp(self):
        self.smartphone = next(row for row in ROWS if row[0] == "85171300")

    def test_mfn_stack(self):
        result = compute_duty(100000, self.smartphone, None)
        self.assertEqual(result["bcd"], 15000)
        self.assertEqual(result["sws"], 1500)
        self.assertEqual(result["igst"], 20970)
        self.assertEqual(result["totalDuty"], 37470)
        self.assertEqual(result["landedCost"], 137470)
        self.assertFalse(result["prefApplied"])

    def test_preference(self):
        result = compute_duty(100000, self.smartphone, 0)
        self.assertTrue(result["prefApplied"])
        self.assertEqual(result["bcd"], 0)
        self.assertEqual(result["igst"], 18000)
        self.assertEqual(result["prefSaving"], 19470)

    def test_rejects_invalid_cif(self):
        for cif in (0, -5, float("nan")):
            with self.subTest(cif=cif):
                with self.assertRaises(ValueError):
                    compute_duty(cif, self.smartphone, None)

    def test_agreement_columns(self):
        self.assertEqual(fta_column_index(FTA["columns"], "MFN"), 0)
        self.assertEqual(fta_column_index(FTA["columns"], "AIFTA"), 1)
        self.assertIsNone(preferential_rate(FTA["columns"], FTA["rates"][0], "MFN"))
        index = ROWS.index(self.smartphone)
        self.assertEqual(preferential_rate(FTA["columns"], FTA["rates"][index], "AIFTA"), 0)

    def test_search(self):
        results = search_hsn(ROWS, "851713", 5)
        self.assertEqual(results[0], ROWS.index(self.smartphone))
        self.assertIn(
            "smartphone",
            " ".join(ROWS[i][1].lower() for i in search_hsn(ROWS, "smartphone", 5)),
        )
        self.assertEqual(search_hsn(ROWS, "", 5), [])


if __name__ == "__main__":
    unittest.main()
