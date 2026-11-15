"""Endpoint, quota and valuation tests for the optional FastAPI backend.

Run from the ``customs-app`` directory:

    python -m unittest discover -s tests -p "test_*.py"

These tests use an isolated SQLite file. They are skipped when the optional
FastAPI test dependencies are not installed.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Must be set before importing backend.app, which opens the database path.
_TMP_DB = tempfile.NamedTemporaryFile(prefix="customscalc-test-", suffix=".db", delete=False)
_TMP_DB.close()
os.environ["CUSTOMSCALC_DB"] = _TMP_DB.name

try:  # pragma: no cover - exercised in CI where requirements are installed
    from fastapi.testclient import TestClient

    from backend.app import app
except ImportError:  # pragma: no cover
    TestClient = None
    app = None


@unittest.skipIf(TestClient is None, "FastAPI test dependencies are not installed")
class EndpointTest(unittest.TestCase):
    def client(self):
        return TestClient(app)

    def test_health(self):
        with self.client() as client:
            response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["lines"], 14416)

    def test_search_never_returns_rates(self):
        with self.client() as client:
            response = client.get("/api/search", params={"q": "smartphone", "limit": 5})
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertTrue(results)
        self.assertEqual(set(results[0]), {"hsn", "desc"})

    def test_hsn_lookup_consumes_quota_and_returns_429(self):
        with self.client() as client:
            statuses = []
            for _ in range(6):
                response = client.get("/api/hsn/85171300")
                statuses.append(response.status_code)
        self.assertEqual(statuses[:5], [200] * 5)
        self.assertEqual(statuses[5], 429)
        body = response.json()["error"]
        self.assertEqual(body["code"], "quota_exceeded")

    def test_calculate_builds_assessable_value(self):
        with self.client() as client:
            response = client.post(
                "/api/calculate",
                json={
                    "hsn": "85171300",
                    "country": "Japan",
                    "goodsValue": 100000,
                    "freight": 5000,
                    "insurance": 1000,
                    "otherCharges": 500,
                },
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["breakdown"]["valuation"]["assessableValue"], 106500)
        self.assertEqual(body["breakdown"]["cif"], 106500)
        self.assertEqual(body["breakdown"]["dutyBeforeIgst"], 0)
        self.assertEqual(body["breakdown"]["totalDuty"], 19170)
        self.assertEqual(body["quota"]["used"], 1)

    def test_legacy_cif_still_works(self):
        with self.client() as client:
            response = client.post(
                "/api/calculate",
                json={"hsn": "85171300", "country": "Japan", "cif": 100000},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["breakdown"]["valuation"]["assessableValue"], 100000)
        self.assertEqual(body["breakdown"]["valuation"]["chargesTotal"], 0)

    def test_site_quote_returns_valuation(self):
        with self.client() as client:
            response = client.post(
                "/api/site/quote",
                json={
                    "hsn": "85171300",
                    "country": "Japan",
                    "goodsValue": 100000,
                    "freight": 5000,
                    "insurance": 1000,
                    "otherCharges": 500,
                },
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["valuation"]["assessableValue"], 106500)
        self.assertEqual(data["amounts"]["landedCost"], 125670)
        self.assertEqual(data["dataAsOf"], "2025-06-30")

    def test_charges_without_goods_value_fail(self):
        with self.client() as client:
            response = client.post(
                "/api/site/quote",
                json={"hsn": "85171300", "country": "Japan", "freight": 5000},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("goodsValue", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
