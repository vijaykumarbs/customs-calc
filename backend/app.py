"""Optional FastAPI backend for CustomsCalc.

The public app is a static site under ``web/`` and works on Cloudflare Pages
without this service. Run the API when you need server-side quota enforcement,
subscription records or a place to plug Razorpay in later.

    uvicorn backend.app:app --reload --port 8000

Endpoints
    GET  /api/meta
    GET  /api/search?q=smartphone&limit=12
    GET  /api/hsn/{code}
    POST /api/calculate       {hsn, country, cif}
    GET  /api/quota
    POST /api/subscribe       {email}
    GET  /api/health
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .duty import compute_duty, preferential_rate, search_hsn

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = Path(os.environ.get("CUSTOMSCALC_WEB_DIR", BASE_DIR.parent / "web"))
DATA_DIR = WEB_DIR / "data"
DB_PATH = Path(os.environ.get("CUSTOMSCALC_DB", BASE_DIR / "data" / "app.db"))
COOKIE_NAME = "cc_client"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")

DATA_VERSION = "1.1"

with open(DATA_DIR / "hsn.json", encoding="utf-8") as fh:
    ROWS: list[list[Any]] = json.load(fh)
with open(DATA_DIR / "fta.json", encoding="utf-8") as fh:
    FTA: dict[str, Any] = json.load(fh)
with open(DATA_DIR / "meta.json", encoding="utf-8") as fh:
    META: dict[str, Any] = json.load(fh)

HSN_INDEX = {str(row[0]): i for i, row in enumerate(ROWS)}
COUNTRIES = {c["name"]: c for c in META.get("countries", [])}
FREE_LIMIT = int(META.get("free_daily_limit", 5))


# --------------------------------------------------------------------- db ---


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS usage (
                client_id TEXT NOT NULL,
                day       TEXT NOT NULL,
                used      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (client_id, day)
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS subscriptions (
                email      TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                source     TEXT NOT NULL DEFAULT 'web'
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS calculations (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id  TEXT NOT NULL,
                created_at TEXT NOT NULL,
                hsn        TEXT NOT NULL,
                country    TEXT NOT NULL,
                cif        REAL NOT NULL,
                total_duty REAL NOT NULL
            )
            """
        )


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    con = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def ist_day() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()


def quota_for(client_id: str) -> dict[str, Any]:
    day = ist_day()
    with connect() as con:
        row = con.execute(
            "SELECT used FROM usage WHERE client_id = ? AND day = ?", (client_id, day)
        ).fetchone()
    used = int(row[0]) if row else 0
    return {
        "day": day,
        "limit": FREE_LIMIT,
        "used": used,
        "remaining": max(0, FREE_LIMIT - used),
    }


def reserve_calculation(client_id: str) -> dict[str, Any]:
    """Atomically take one free calculation, or report that the cap is hit."""
    day = ist_day()
    with connect() as con:
        row = con.execute(
            "SELECT used FROM usage WHERE client_id = ? AND day = ?", (client_id, day)
        ).fetchone()
        used = int(row[0]) if row else 0
        if used >= FREE_LIMIT:
            return {"day": day, "limit": FREE_LIMIT, "used": used, "remaining": 0}
        used += 1
        con.execute(
            """
            INSERT INTO usage (client_id, day, used) VALUES (?, ?, ?)
            ON CONFLICT(client_id, day) DO UPDATE SET used = excluded.used
            """,
            (client_id, day, used),
        )
    return {
        "day": day,
        "limit": FREE_LIMIT,
        "used": used,
        "remaining": max(0, FREE_LIMIT - used),
    }


def record_calculation(client_id: str, hsn: str, country: str, cif: float, total: float) -> None:
    with connect() as con:
        con.execute(
            """INSERT INTO calculations (client_id, created_at, hsn, country, cif, total_duty)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (client_id, datetime.now(timezone.utc).isoformat(timespec="seconds"), hsn, country, cif, total),
        )


# ------------------------------------------------------------------- models ---


class CalculateRequest(BaseModel):
    hsn: str = Field(min_length=4, max_length=8)
    country: str = Field(min_length=2, max_length=80)
    cif: float = Field(gt=0, le=1_000_000_000_000)


class SubscribeRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)


# --------------------------------------------------------------------- app ---


app = FastAPI(
    title="CustomsCalc API",
    description="India import duty and landed-cost estimates.",
    version=DATA_VERSION,
)

allowed = [o for o in os.environ.get("CUSTOMSCALC_ALLOWED_ORIGINS", "").split(",") if o.strip()]
if allowed:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )


@app.middleware("http")
async def anonymise_client(request: Request, call_next):
    client_id = request.cookies.get(COOKIE_NAME)
    fresh = False
    if not client_id or not re.fullmatch(r"[a-f0-9]{32}", client_id):
        client_id = secrets.token_hex(16)
        fresh = True
    request.state.client_id = client_id

    response = await call_next(request)
    if fresh and request.url.path.startswith("/api/"):
        response.set_cookie(
            COOKIE_NAME,
            client_id,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
    return response


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "lines": len(ROWS),
        "agreements": len(FTA.get("columns", [])),
        "countries": len(COUNTRIES),
        "dataVersion": DATA_VERSION,
    }


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    return META


@app.get("/api/quota")
def quota(request: Request) -> dict[str, Any]:
    return quota_for(request.state.client_id)


@app.get("/api/search")
def search(q: str = "", limit: int = 12) -> dict[str, Any]:
    limit = max(1, min(limit, 30))
    indices = search_hsn(ROWS, q, limit)
    results = []
    for i in indices:
        row = ROWS[i]
        results.append(
            {
                "hsn": row[0],
                "desc": row[1],
                "chapter": row[2],
                "bcdEffective": row[4],
                "igst": row[7],
                "aidc": row[5],
                "cess": row[8],
                "sws": row[6],
                "flag": row[9],
            }
        )
    return {"query": q, "count": len(results), "results": results}


@app.get("/api/hsn/{code}")
def hsn_detail(code: str) -> dict[str, Any]:
    digits = "".join(ch for ch in code if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {code} not found")

    row = ROWS[index]
    rate_row = FTA["rates"][index]
    preferences = {}
    if rate_row:
        for position, agreement in enumerate(FTA["columns"], start=1):
            value = rate_row[position] if position < len(rate_row) else None
            if isinstance(value, (int, float)) and value < row[4]:
                preferences[agreement] = value

    return {
        "hsn": row[0],
        "desc": row[1],
        "chapter": row[2],
        "bcdStatutory": row[3],
        "bcdEffective": row[4],
        "aidc": row[5],
        "swsPctOfBcd": row[6],
        "igst": row[7],
        "cess": row[8],
        "flag": row[9],
        "mfn": rate_row[0] if rate_row else row[4],
        "preferences": preferences,
    }


@app.post("/api/calculate")
def calculate(payload: CalculateRequest, request: Request) -> Any:
    digits = "".join(ch for ch in payload.hsn if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {payload.hsn} not found")

    country = COUNTRIES.get(payload.country)
    if country is None:
        raise HTTPException(status_code=404, detail=f"Country {payload.country} not mapped")

    client_id = request.state.client_id
    quota_state = quota_for(client_id)
    if quota_state["remaining"] <= 0:
        return JSONResponse(
            status_code=402,
            content={
                "error": "quota_exceeded",
                "message": "Daily free limit reached. The ₹99/month plan is launching soon.",
                "quota": quota_state,
                "upgrade": {"price_inr": META.get("price_inr", 99), "available": False},
            },
        )

    rate = preferential_rate(FTA["columns"], FTA["rates"][index], country.get("col", "MFN"))
    breakdown = compute_duty(payload.cif, ROWS[index], rate)

    quota_state = reserve_calculation(client_id)
    record_calculation(client_id, digits, payload.country, payload.cif, breakdown["totalDuty"])

    return {
        "breakdown": breakdown,
        "origin": {
            "country": country["name"],
            "iso": country.get("iso", ""),
            "agreement": country.get("agreement", "MFN"),
            "column": country.get("col", "MFN"),
        },
        "quota": quota_state,
        "dataVersion": DATA_VERSION,
    }


@app.post("/api/subscribe")
def subscribe(payload: SubscribeRequest) -> dict[str, Any]:
    email = payload.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Enter a valid email address")

    with connect() as con:
        con.execute(
            """INSERT INTO subscriptions (email, created_at, source) VALUES (?, ?, 'web')
               ON CONFLICT(email) DO NOTHING""",
            (email, datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    return {"ok": True, "message": "We'll write when the ₹99 plan opens."}


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
