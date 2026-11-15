"""Duty calculation for the optional FastAPI backend.

This mirrors ``web/assets/duty.js`` line for line. The parity test in
``tests/test_duty.py`` compares both implementations against
``tests/vectors.json``; keep the two files in sync when the rate logic changes.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

FLAG_LABELS = {
    0: "Line-level CBIC rate",
    1: "Approximate parse — verify",
    2: "Dataset-only rate — verify",
}

EPSILON = 2.220446049250313e-16


def round2(value: float) -> float:
    """Match JavaScript's Math.round(x * 100) / 100 for positive numbers."""
    return math.floor((value + EPSILON) * 100 + 0.5) / 100


def compute_assessable_value(
    goods_value: float,
    freight: float = 0,
    insurance: float = 0,
    other_charges: float = 0,
) -> dict[str, float]:
    """Build the CIF assessable value from invoice value and includible costs."""
    goods = float(goods_value)
    if not math.isfinite(goods) or goods <= 0:
        raise ValueError("goods_value must be > 0")
    charges = []
    for label, value in (
        ("freight", freight),
        ("insurance", insurance),
        ("other_charges", other_charges),
    ):
        number = float(value or 0)
        if not math.isfinite(number) or number < 0:
            raise ValueError(f"{label} must be >= 0")
        charges.append(round2(number))
    charges_total = round2(sum(charges))
    return {
        "goodsValue": round2(goods),
        "freight": charges[0],
        "insurance": charges[1],
        "otherCharges": charges[2],
        "chargesTotal": charges_total,
        "assessableValue": round2(round2(goods) + charges_total),
    }


def _stack(
    cif: float,
    bcd_rate: float,
    aidc_pct: float,
    sws_pct_of_bcd: float,
    cess_pct: float,
    igst_pct: float,
) -> dict[str, float]:
    bcd = round2(cif * bcd_rate / 100)
    sws = round2(bcd * sws_pct_of_bcd / 100)
    aidc = round2(cif * aidc_pct / 100)
    cess = round2(cif * cess_pct / 100)
    igst_base = cif + bcd + sws + aidc + cess
    igst = round2(igst_base * igst_pct / 100)
    total_duty = round2(bcd + sws + aidc + cess + igst)
    return {
        "bcd": bcd,
        "sws": sws,
        "aidc": aidc,
        "cess": cess,
        "igst": igst,
        "igstBase": round2(igst_base),
        "totalDuty": total_duty,
        "landedCost": round2(cif + total_duty),
    }


def compute_duty(
    cif: float,
    row: Sequence[Any],
    fta_rate: float | None = None,
) -> dict[str, Any]:
    """Return the full landed-cost breakdown for one hsn.json row."""
    if len(row) < 10:
        raise ValueError("row must be a compact hsn.json array")
    if not math.isfinite(cif) or cif <= 0:
        raise ValueError("cif must be greater than zero")

    (
        hsn,
        desc,
        chapter,
        bcd_statutory,
        bcd_effective,
        aidc_pct,
        sws_pct_of_bcd,
        igst_pct,
        cess_pct,
        flag,
    ) = row[:10]

    has_preference = fta_rate is not None and fta_rate < bcd_effective - 1e-9
    applied_bcd_rate = fta_rate if has_preference else bcd_effective

    actual = _stack(cif, applied_bcd_rate, aidc_pct, sws_pct_of_bcd, cess_pct, igst_pct)
    mfn = (
        _stack(cif, bcd_effective, aidc_pct, sws_pct_of_bcd, cess_pct, igst_pct)
        if has_preference
        else actual
    )

    return {
        "hsn": hsn,
        "desc": desc,
        "chapter": chapter,
        "flag": flag,
        "flagLabel": FLAG_LABELS.get(flag, "Unverified rate"),
        "cif": round2(cif),
        "bcdStatutory": bcd_statutory,
        "bcdEffective": bcd_effective,
        "aidcPct": aidc_pct,
        "swsPctOfBcd": sws_pct_of_bcd,
        "igstPct": igst_pct,
        "cessPct": cess_pct,
        "ftaRate": fta_rate if fta_rate is not None else None,
        "appliedBcdRate": applied_bcd_rate,
        "prefApplied": has_preference,
        "prefSaving": round2(mfn["totalDuty"] - actual["totalDuty"]),
        "dutyExclIgstPct": round2(
            (actual["bcd"] + actual["sws"] + actual["aidc"] + actual["cess"]) / cif * 100
        ),
        "effectiveDutyPct": round2(actual["totalDuty"] / cif * 100),
        **actual,
        "mfnLandedCost": mfn["landedCost"],
    }


def fta_column_index(columns: Sequence[str], agreement_col: str | None) -> int:
    """Return the 1-based rate-row column for an agreement, or 0 for MFN."""
    if not agreement_col or agreement_col == "MFN":
        return 0
    try:
        return list(columns).index(agreement_col) + 1
    except ValueError:
        return 0


def preferential_rate(
    columns: Sequence[str],
    rate_row: Sequence[float | None] | None,
    agreement_col: str | None,
) -> float | None:
    """Return the preferential rate for an agreement, or None for MFN."""
    col = fta_column_index(columns, agreement_col)
    if col == 0 or not rate_row:
        return None
    value = rate_row[col] if col < len(rate_row) else None
    return float(value) if isinstance(value, (int, float)) else None


def _normalise(text: str) -> str:
    return " ".join(str(text or "").lower().replace(",", " ").split())


def search_hsn(rows: Sequence[Sequence[Any]], query: str, limit: int = 12) -> list[int]:
    """Search compact rows by code prefix or description tokens."""
    q = _normalise(query)
    if not q:
        return []

    digits = "".join(ch for ch in q if ch.isdigit())
    is_code = all(ch.isdigit() or ch.isspace() for ch in q) and len(digits) >= 2
    tokens = [t for t in q.split(" ") if len(t) > 1 or t.isdigit()]
    scored: list[tuple[float, int]] = []

    for i, row in enumerate(rows):
        code = str(row[0])
        score = -1.0

        if is_code:
            if code == digits:
                score = 1000
            elif code.startswith(digits):
                score = 800 - (len(code) - len(digits))
            elif code[:4] == digits[:4]:
                score = 120
            elif code[:2] == digits[:2]:
                score = 20
        else:
            hay = _normalise(f"{row[1]} {code}")
            if q in hay:
                score = 500 - min(hay.index(q), 200)
            if score < 0 and tokens:
                hits = 0
                pos = 0
                for token in tokens:
                    at = hay.find(token)
                    if at >= 0:
                        hits += 1
                        pos += at
                if hits == len(tokens):
                    score = 300 - min(pos / len(tokens), 200)
                elif hits >= max(1, math.ceil(len(tokens) * 0.6)):
                    score = 80 + hits

        if score >= 0:
            if row[9] == 0:
                score += 5
            scored.append((score, i))

    scored.sort(key=lambda item: (-item[0], str(rows[item[1]][0])))
    return [i for _, i in scored[:limit]]
