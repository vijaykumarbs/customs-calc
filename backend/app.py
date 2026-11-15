"""Optional FastAPI backend for CustomsCalc.

The public app is served from ``web/`` by a Cloudflare Pages Worker in
production. This optional FastAPI service is a local reference implementation:
it loads the same ``data/*.json`` files, mirrors the website endpoints under
``/api/site/*`` and keeps SQLite quota, subscription and calculation records.

    uvicorn backend.app:app --reload --port 8000

Endpoints
    GET  /api/meta
    GET  /api/search?q=smartphone&limit=12
    GET  /api/hsn/{code}
    POST /api/calculate       {hsn, country, cif}
    GET  /api/quota
    POST /api/subscribe       {email}
    GET  /api/health

    Website aliases: /api/site/meta, /api/site/quota, /api/site/search,
    /api/site/hsn/{code}, /api/site/quote, /api/site/notify
"""

from __future__ import annotations

import json
import hashlib
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

from .duty import compute_assessable_value, compute_duty, preferential_rate, search_hsn

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = Path(os.environ.get("CUSTOMSCALC_WEB_DIR", BASE_DIR.parent / "web"))
DATA_DIR = BASE_DIR.parent / "data"
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
IP_DAILY_LIMIT = int(META.get("free_daily_ip_limit", 40))


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
            CREATE TABLE IF NOT EXISTS ip_usage (
                ip  TEXT NOT NULL,
                day TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (ip, day)
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


def reserve_calculation(
    client_id: str, client_ip: str | None = None
) -> dict[str, Any]:
    """Atomically take one free calculation, or report that the cap is hit.

    The client cookie is the primary key. A separate per-IP daily backstop stops
    a visitor from resetting the cookie forever. SQLite ``BEGIN IMMEDIATE``
    serialises concurrent writers so the cap cannot be exceeded by races.
    """
    day = ist_day()
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT used FROM usage WHERE client_id = ? AND day = ?", (client_id, day)
        ).fetchone()
        used = int(row[0]) if row else 0
        if used >= FREE_LIMIT:
            con.rollback()
            return {
                "day": day,
                "limit": FREE_LIMIT,
                "used": used,
                "remaining": 0,
                "limited_by": "client",
            }
        if client_ip:
            ip_row = con.execute(
                "SELECT used FROM ip_usage WHERE ip = ? AND day = ?", (client_ip, day)
            ).fetchone()
            ip_used = int(ip_row[0]) if ip_row else 0
            if ip_used >= IP_DAILY_LIMIT:
                con.rollback()
                return {
                    "day": day,
                    "limit": FREE_LIMIT,
                    "used": used,
                    "remaining": max(0, FREE_LIMIT - used),
                    "limited_by": "ip",
                }
            con.execute(
                """
                INSERT INTO ip_usage (ip, day, used) VALUES (?, ?, 1)
                ON CONFLICT(ip, day) DO UPDATE SET used = ip_usage.used + 1
                """,
                (client_ip, day),
            )
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
    country: str | None = Field(default=None, max_length=80)
    # Legacy: send the assessable value directly.
    cif: float | None = Field(default=None, gt=0, le=1_000_000_000_000)
    # Preferred: build the assessable value from invoice + charges.
    goodsValue: float | None = Field(default=None, gt=0, le=1_000_000_000_000)
    freight: float | None = Field(default=0, ge=0, le=1_000_000_000_000)
    insurance: float | None = Field(default=0, ge=0, le=1_000_000_000_000)
    otherCharges: float | None = Field(default=0, ge=0, le=1_000_000_000_000)


class SubscribeRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)


def valuation_from_payload(payload: CalculateRequest) -> dict[str, float]:
    has_charges = any(
        (payload.freight or 0, payload.insurance or 0, payload.otherCharges or 0)
    )
    if payload.goodsValue is not None:
        try:
            return compute_assessable_value(
                payload.goodsValue,
                payload.freight or 0,
                payload.insurance or 0,
                payload.otherCharges or 0,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if has_charges:
        raise HTTPException(
            status_code=400,
            detail="Send goodsValue together with freight, insurance or otherCharges",
        )
    if payload.cif is None:
        raise HTTPException(status_code=400, detail="Send goodsValue or cif")
    cif = round(payload.cif, 2)
    return {
        "goodsValue": cif,
        "freight": 0.0,
        "insurance": 0.0,
        "otherCharges": 0.0,
        "chargesTotal": 0.0,
        "assessableValue": cif,
    }


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
    raw_ip = request.client.host if request.client else ""
    request.state.client_ip = (
        hashlib.sha256(raw_ip.encode("utf-8")).hexdigest()[:16] if raw_ip else None
    )

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
    results = [{"hsn": ROWS[i][0], "desc": ROWS[i][1]} for i in indices]
    return {"query": q, "count": len(results), "results": results}


@app.get("/api/hsn/{code}")
def hsn_detail(code: str, request: Request) -> Any:
    digits = "".join(ch for ch in code if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {code} not found")

    quota_state = quota_for(request.state.client_id)
    if quota_state["remaining"] <= 0:
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "quota_exceeded",
                    "message": "Daily free limit reached. The paid plan is launching soon.",
                    "docs": "https://customs.vijayebhava.com/api-docs/",
                    "quota": quota_state,
                }
            },
        )
    quota_state = reserve_calculation(request.state.client_id, request.state.client_ip)
    if quota_state.get("limited_by"):
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "quota_exceeded",
                    "message": "Too many lookups from this connection today.",
                    "docs": "https://customs.vijayebhava.com/api-docs/",
                    "quota": quota_state,
                }
            },
        )

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
        "quota": quota_state,
    }


@app.post("/api/calculate")
def calculate(payload: CalculateRequest, request: Request) -> Any:
    digits = "".join(ch for ch in payload.hsn if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {payload.hsn} not found")

    valuation = valuation_from_payload(payload)
    if payload.country is None:
        country = {
            "name": "MFN",
            "iso": "",
            "agreement": "MFN",
            "col": "MFN",
        }
    else:
        country = COUNTRIES.get(payload.country)
        if country is None:
            raise HTTPException(status_code=404, detail=f"Country {payload.country} not mapped")

    client_id = request.state.client_id
    quota_state = quota_for(client_id)
    if quota_state["remaining"] <= 0:
        return JSONResponse(
            status_code=429,
            content={
                "error": "quota_exceeded",
                "message": "Daily free limit reached. The ₹99/month plan is launching soon.",
                "quota": quota_state,
                "upgrade": {"price_inr": META.get("price_inr", 99), "available": False},
            },
        )

    rate = preferential_rate(FTA["columns"], FTA["rates"][index], country.get("col", "MFN"))
    breakdown = compute_duty(valuation["assessableValue"], ROWS[index], rate)
    breakdown["valuation"] = valuation
    breakdown["dutyBeforeIgst"] = round(
        breakdown["bcd"] + breakdown["sws"] + breakdown["aidc"] + breakdown["cess"], 2
    )

    quota_state = reserve_calculation(client_id, request.state.client_ip)
    if quota_state.get("limited_by"):
        return JSONResponse(
            status_code=429,
            content={
                "error": "quota_exceeded",
                "message": "Daily free limit reached. The paid plan is launching soon.",
                "quota": quota_state,
            },
        )
    record_calculation(
        client_id,
        digits,
        country["name"],
        valuation["assessableValue"],
        breakdown["totalDuty"],
    )

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


# ------------------------------------------------------------- website API ---
# Mirrors the Worker's /api/site/* surface so the calculator also works when
# this service is used for local development. Production uses the Worker.


SITE_ALIASES = {
    "uae": "united arab emirates",
    "u.a.e.": "united arab emirates",
    "usa": "united states",
    "us": "united states",
    "uk": "united kingdom",
    "south korea": "republic of korea",
    "korea": "republic of korea",
    "viet nam": "vietnam",
    "laos": "lao pdr",
    "czech republic": "czechia",
    "turkiye": "turkey",
}


def resolve_origin(value: str | None) -> dict[str, Any]:
    raw = (value or "").strip()
    if not raw:
        return {
            "country": "MFN",
            "iso": None,
            "agreement": "MFN",
            "agreementName": "MFN (WTO)",
            "modelled": True,
        }
    needle = SITE_ALIASES.get(raw.lower(), raw.lower())
    country = next(
        (
            item
            for item in META.get("countries", [])
            if item["name"].lower() == needle or str(item.get("iso", "")).lower() == needle
        ),
        None,
    )
    column = country.get("col", "MFN") if country else None
    if country is None:
        agreement = next(
            (item for item in META.get("agreements", []) if str(item.get("col", "")).lower() == needle),
            None,
        )
        if agreement:
            column = agreement["col"]
            country = {"name": agreement["name"], "iso": None, "col": agreement["col"]}
    if country is None or column is None:
        raise HTTPException(status_code=400, detail=f'Unknown origin "{raw}"')
    agreement = next(
        (item for item in META.get("agreements", []) if item.get("col") == column), {}
    )
    return {
        "country": country["name"],
        "iso": country.get("iso") or None,
        "agreement": column,
        "agreementName": agreement.get("name", column.replace("_", " ")),
        "modelled": not str(agreement.get("modelled", "Yes")).lower().startswith("no"),
    }


def site_breakdown(
    index: int, origin: dict[str, Any], valuation: dict[str, float]
) -> dict[str, Any]:
    row = ROWS[index]
    rate = preferential_rate(FTA["columns"], FTA["rates"][index], origin["agreement"])
    result = compute_duty(valuation["assessableValue"], row, rate)
    duty_before_igst = round(
        result["bcd"] + result["sws"] + result["aidc"] + result["cess"], 2
    )
    return {
        "hsn": result["hsn"],
        "description": result["desc"],
        "chapter": result["chapter"],
        "origin": origin,
        "valuation": valuation,
        "cif": result["cif"],
        "dataAsOf": META.get("data_as_of"),
        "rates": {
            "bcdStatutory": result["bcdStatutory"],
            "bcdEffective": result["bcdEffective"],
            "appliedBcd": result["appliedBcdRate"],
            "preferential": result["ftaRate"],
            "swsOfBcd": result["swsPctOfBcd"],
            "igst": result["igstPct"],
            "aidc": result["aidcPct"],
            "cess": result["cessPct"],
        },
        "amounts": {
            "bcd": result["bcd"],
            "sws": result["sws"],
            "aidc": result["aidc"],
            "cess": result["cess"],
            "igst": result["igst"],
            "dutyBeforeIgst": duty_before_igst,
            "totalDuty": result["totalDuty"],
            "landedCost": result["landedCost"],
        },
        "effectiveDutyPct": result["effectiveDutyPct"],
        "dutyExclIgstPct": result["dutyExclIgstPct"],
        "prefApplied": result["prefApplied"],
        "prefSaving": result["prefSaving"],
        "mfnLandedCost": result["mfnLandedCost"],
        "flag": result["flag"],
        "flagLabel": result["flagLabel"],
    }


@app.get("/api/site/meta")
def site_meta() -> dict[str, Any]:
    payload = dict(META)
    payload.setdefault("free_api_monthly_limit", 10)
    return {"data": payload}


@app.get("/api/site/quota")
def site_quota(request: Request) -> dict[str, Any]:
    return {"data": quota_for(request.state.client_id)}


@app.get("/api/site/search")
def site_search(q: str = "", limit: int = 14) -> dict[str, Any]:
    limit = max(1, min(limit, 25))
    results = [
        {"code": ROWS[i][0], "description": ROWS[i][1]}
        for i in search_hsn(ROWS, q, limit)
    ]
    return {"data": {"query": q, "results": results}, "meta": {"count": len(results)}}


@app.get("/api/site/hsn/{code}")
def site_hsn(code: str) -> dict[str, Any]:
    digits = "".join(ch for ch in code if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {code} not found")
    return {"data": {"hsn": ROWS[index][0], "description": ROWS[index][1]}}


@app.post("/api/site/quote")
def site_quote(payload: CalculateRequest, request: Request) -> Any:
    digits = "".join(ch for ch in payload.hsn if ch.isdigit())
    index = HSN_INDEX.get(digits)
    if index is None:
        raise HTTPException(status_code=404, detail=f"HSN {payload.hsn} not found")

    origin = resolve_origin(payload.country)
    valuation = valuation_from_payload(payload)
    quota_state = quota_for(request.state.client_id)
    if quota_state["remaining"] <= 0:
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "site_quota_exceeded",
                    "message": "Today's five free calculations are used.",
                    "docs": "https://customs.vijayebhava.com/api-docs/",
                }
            },
        )

    quota_state = reserve_calculation(request.state.client_id, request.state.client_ip)
    if quota_state.get("limited_by"):
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "site_quota_exceeded",
                    "message": "Too many calculations from this connection today.",
                    "docs": "https://customs.vijayebhava.com/api-docs/",
                }
            },
        )
    breakdown = site_breakdown(index, origin, valuation)
    record_calculation(
        request.state.client_id,
        digits,
        origin["country"],
        valuation["assessableValue"],
        breakdown["amounts"]["totalDuty"],
    )
    breakdown["quota"] = quota_state
    return {"data": breakdown}


@app.post("/api/site/notify")
def site_notify(payload: SubscribeRequest) -> dict[str, Any]:
    return subscribe(payload)


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
