/**
 * Pure duty-calculation helpers for CustomsCalc.
 *
 * No DOM access lives here, so the same module is used in the browser and in
 * Node-based parity tests. All money values are rupees rounded to 2 decimals.
 *
 * Duty stack (order matters):
 *   BCD   = assessable value x applicable BCD rate
 *   SWS   = BCD x 10% (rate supplied per line, normally 10)
 *   AIDC  = assessable value x AIDC rate
 *   Cess  = assessable value x cess rate
 *   IGST  = (assessable value + BCD + SWS + AIDC + Cess) x IGST rate
 */

export const DATA_VERSION = "1.1";
export const FLAG_LABELS = {
  0: "Line-level CBIC rate",
  1: "Approximate parse — verify",
  2: "Dataset-only rate — verify",
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Current date in Asia/Kolkata as YYYY-MM-DD. Used to scope the free quota to
 * an Indian calendar day rather than the visitor's local day.
 */
export function istDayKey(now = Date.now()) {
  const shifted = new Date(now + 5.5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Build the customs assessable value from the invoice and transport costs.
 *
 * Indian customs value is normally the transaction value plus freight,
 * insurance and other includible charges (landing, packing, commissions,
 * etc.). The result is the CIF value that BCD, SWS, AIDC, cess and IGST use.
 *
 * @param {object} input
 * @param {number} input.goodsValue    Invoice / FOB value in rupees.
 * @param {number} [input.freight]     Freight to India.
 * @param {number} [input.insurance]   Marine insurance.
 * @param {number} [input.otherCharges] Landing, packing, commission, etc.
 * @returns {{goodsValue:number, freight:number, insurance:number,
 *            otherCharges:number, chargesTotal:number, assessableValue:number}}
 */
export function computeAssessableValue({
  goodsValue,
  freight = 0,
  insurance = 0,
  otherCharges = 0,
} = {}) {
  const goods = Number(goodsValue);
  if (!Number.isFinite(goods) || goods <= 0) {
    throw new RangeError("goodsValue must be > 0");
  }
  const charges = [freight, insurance, otherCharges].map((value) => {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n) || n < 0) {
      throw new RangeError("freight, insurance and otherCharges must be >= 0");
    }
    return round2(n);
  });
  const [freightValue, insuranceValue, otherValue] = charges;
  const chargesTotal = round2(freightValue + insuranceValue + otherValue);
  return {
    goodsValue: round2(goods),
    freight: freightValue,
    insurance: insuranceValue,
    otherCharges: otherValue,
    chargesTotal,
    assessableValue: round2(round2(goods) + chargesTotal),
  };
}

function dutyStack(cif, bcdRate, aidcPct, swsPctOfBcd, cessPct, igstPct) {
  const bcd = round2((cif * bcdRate) / 100);
  const sws = round2((bcd * swsPctOfBcd) / 100);
  const aidc = round2((cif * aidcPct) / 100);
  const cess = round2((cif * cessPct) / 100);
  const igstBase = cif + bcd + sws + aidc + cess;
  const igst = round2((igstBase * igstPct) / 100);
  const totalDuty = round2(bcd + sws + aidc + cess + igst);
  return {
    bcd,
    sws,
    aidc,
    cess,
    igst,
    igstBase: round2(igstBase),
    totalDuty,
    landedCost: round2(cif + totalDuty),
  };
}

/**
 * Compute the full landed cost for one tariff line.
 *
 * @param {object} input
 * @param {number} input.cif       Assessable value in rupees.
 * @param {Array}  input.row       Compact HSN row from hsn.json.
 * @param {?number} input.ftaRate  Preferential rate for the chosen origin, if any.
 * @returns {object} breakdown ready for rendering.
 */
export function computeDuty({ cif, row, ftaRate = null }) {
  if (!Array.isArray(row)) throw new TypeError("row must be an hsn.json array");
  if (!Number.isFinite(cif) || cif <= 0) throw new RangeError("cif must be > 0");

  const [hsn, desc, chapter, bcdStatutory, bcdEffective, aidcPct, swsPctOfBcd, igstPct, cessPct, flag] = row;

  const hasPreference = Number.isFinite(ftaRate) && ftaRate < bcdEffective - 1e-9;
  const appliedBcdRate = hasPreference ? ftaRate : bcdEffective;

  const actual = dutyStack(cif, appliedBcdRate, aidcPct, swsPctOfBcd, cessPct, igstPct);
  const mfn = hasPreference
    ? dutyStack(cif, bcdEffective, aidcPct, swsPctOfBcd, cessPct, igstPct)
    : actual;

  return {
    hsn,
    desc,
    chapter,
    flag,
    flagLabel: FLAG_LABELS[flag] || "Unverified rate",
    cif: round2(cif),
    bcdStatutory,
    bcdEffective,
    aidcPct,
    swsPctOfBcd,
    igstPct,
    cessPct,
    ftaRate: Number.isFinite(ftaRate) ? ftaRate : null,
    appliedBcdRate,
    prefApplied: hasPreference,
    prefSaving: round2(mfn.totalDuty - actual.totalDuty),
    dutyExclIgstPct: round2(((actual.bcd + actual.sws + actual.aidc + actual.cess) / cif) * 100),
    effectiveDutyPct: round2((actual.totalDuty / cif) * 100),
    ...actual,
    mfnLandedCost: mfn.landedCost,
  };
}

const normalise = (s) => String(s || "").toLowerCase().replace(/[,\s]+/g, " ").trim();

/**
 * Search compact HSN rows by code prefix or description tokens.
 * Returns row indices, best matches first.
 */
export function searchHsn(rows, query, limit = 12) {
  const q = normalise(query);
  if (!q) return [];

  const digits = q.replace(/\D/g, "");
  const isCode = /^[\d\s]+$/.test(q) && digits.length >= 2;
  const tokens = q.split(" ").filter((t) => t.length > 1 || /\d/.test(t));
  const scored = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const code = row[0];
    let score = -1;

    if (isCode) {
      if (code === digits) score = 1000;
      else if (code.startsWith(digits)) score = 800 - (code.length - digits.length);
      else if (code.slice(0, 4) === digits.slice(0, 4)) score = 120;
      else if (code.slice(0, 2) === digits.slice(0, 2)) score = 20;
    } else {
      const hay = normalise(`${row[1]} ${code}`);
      if (hay.includes(q)) score = 500 - Math.min(hay.indexOf(q), 200);
      if (score < 0 && tokens.length) {
        let hits = 0;
        let pos = 0;
        for (const t of tokens) {
          const at = hay.indexOf(t);
          if (at >= 0) {
            hits += 1;
            pos += at;
          }
        }
        if (hits === tokens.length) score = 300 - Math.min(pos / tokens.length, 200);
        else if (hits >= Math.max(1, Math.ceil(tokens.length * 0.6))) score = 80 + hits;
      }
    }

    if (score >= 0) {
      // Slightly prefer lines that carry a real CBIC rate over placeholders.
      if (row[9] === 0) score += 5;
      scored.push([score, i]);
    }
  }

  scored.sort((a, b) => b[0] - a[0] || rows[a[1]][0].localeCompare(rows[b[1]][0]));
  return scored.slice(0, limit).map(([, i]) => i);
}

/** 1-based column index in fta.json rates for an agreement, or 0 for MFN. */
export function ftaColumnIndex(columns, agreementCol) {
  if (!agreementCol || agreementCol === "MFN") return 0;
  const i = columns.indexOf(agreementCol);
  return i < 0 ? 0 : i + 1;
}

/** Preferential rate for a row and agreement, or null when MFN applies. */
export function preferentialRate(fta, rateRow, agreementCol) {
  const col = ftaColumnIndex(fta.columns, agreementCol);
  if (col === 0 || !rateRow) return null;
  const value = rateRow[col]; // rateRow[0] is MFN
  return Number.isFinite(value) ? value : null;
}

export function formatINR(value, { decimals = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function parseAmount(input) {
  const cleaned = String(input ?? "").replace(/[^\d.]/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}
