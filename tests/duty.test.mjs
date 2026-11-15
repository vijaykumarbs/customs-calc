import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  computeAssessableValue,
  computeDuty,
  ftaColumnIndex,
  istDayKey,
  parseAmount,
  preferentialRate,
  searchHsn,
} from "../web/assets/duty.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(readFileSync(join(root, "tests/vectors.json"), "utf8"));
const rows = JSON.parse(readFileSync(join(root, "data/hsn.json"), "utf8"));
const fta = JSON.parse(readFileSync(join(root, "data/fta.json"), "utf8"));

test("duty vectors match the recorded expectations", () => {
  for (const vector of vectors) {
    const actual = computeDuty({ cif: vector.cif, row: vector.row, ftaRate: vector.ftaRate });
    assert.deepEqual(actual, vector.expected, vector.name);
  }
});

test("MFN stack adds BCD, SWS, IGST in the right order", () => {
  const row = rows.find((r) => r[0] === "85171300");
  const result = computeDuty({ cif: 100000, row, ftaRate: null });
  assert.equal(result.bcd, 15000);
  assert.equal(result.sws, 1500);
  assert.equal(result.igst, 20970);
  assert.equal(result.totalDuty, 37470);
  assert.equal(result.landedCost, 137470);
  assert.equal(result.prefApplied, false);
});

test("preferential rate beats MFN and reports savings", () => {
  const row = rows.find((r) => r[0] === "85171300");
  const result = computeDuty({ cif: 100000, row, ftaRate: 0 });
  assert.equal(result.prefApplied, true);
  assert.equal(result.bcd, 0);
  assert.equal(result.igst, 18000);
  assert.equal(result.prefSaving, 19470);
  assert.equal(result.landedCost, 118000);
});

test("rejects invalid assessable values", () => {
  const row = rows[0];
  assert.throws(() => computeDuty({ cif: 0, row }), RangeError);
  assert.throws(() => computeDuty({ cif: -5, row }), RangeError);
  assert.throws(() => computeDuty({ cif: Number.NaN, row }), RangeError);
});

test("assessable value adds freight, insurance and other charges", () => {
  const valuation = computeAssessableValue({
    goodsValue: 100000,
    freight: 5000,
    insurance: 1000,
    otherCharges: 500,
  });
  assert.deepEqual(valuation, {
    goodsValue: 100000,
    freight: 5000,
    insurance: 1000,
    otherCharges: 500,
    chargesTotal: 6500,
    assessableValue: 106500,
  });
});

test("assessable value defaults charges to zero", () => {
  const valuation = computeAssessableValue({ goodsValue: 250000 });
  assert.equal(valuation.chargesTotal, 0);
  assert.equal(valuation.assessableValue, 250000);
  assert.equal(valuation.freight, 0);
  assert.equal(valuation.insurance, 0);
  assert.equal(valuation.otherCharges, 0);
});

test("assessable value rejects missing, non-positive and negative inputs", () => {
  assert.throws(() => computeAssessableValue({ goodsValue: 0 }), RangeError);
  assert.throws(() => computeAssessableValue({ goodsValue: -1 }), RangeError);
  assert.throws(() => computeAssessableValue({}), RangeError);
  assert.throws(
    () => computeAssessableValue({ goodsValue: 1000, freight: -1 }),
    RangeError,
  );
  assert.throws(
    () => computeAssessableValue({ goodsValue: 1000, insurance: -0.01 }),
    RangeError,
  );
});

test("duty stack runs on the built-up assessable value", () => {
  const row = rows.find((r) => r[0] === "85171300");
  const valuation = computeAssessableValue({
    goodsValue: 100000,
    freight: 5000,
    insurance: 1000,
    otherCharges: 500,
  });
  const result = computeDuty({ cif: valuation.assessableValue, row, ftaRate: 0 });
  assert.equal(result.cif, 106500);
  assert.equal(result.bcd, 0);
  assert.equal(result.igst, 19170);
  assert.equal(result.totalDuty, 19170);
  assert.equal(result.landedCost, 125670);
});

test("agreement columns resolve to the FTA matrix", () => {
  assert.equal(ftaColumnIndex(fta.columns, "MFN"), 0);
  assert.equal(ftaColumnIndex(fta.columns, "AIFTA"), 1);
  assert.equal(preferentialRate(fta, fta.rates[0], "MFN"), null);
  const index = rows.findIndex((r) => r[0] === "85171300");
  assert.equal(preferentialRate(fta, fta.rates[index], "AIFTA"), 0);
});

test("search finds codes by prefix and products by words", () => {
  const byCode = searchHsn(rows, "851713", 5);
  assert.equal(rows[byCode[0]][0], "85171300");

  const byWord = searchHsn(rows, "smartphone", 5);
  assert.ok(byWord.some((i) => /smartphone/i.test(rows[i][1])));

  assert.deepEqual(searchHsn(rows, "", 5), []);
});

test("amount parsing and IST day key", () => {
  assert.equal(parseAmount("₹1,00,000"), 100000);
  assert.equal(parseAmount("1 234.50"), 1234.5);
  assert.ok(Number.isNaN(parseAmount("abc")));

  // 2026-11-14T19:00:00Z is already 15 November in India.
  assert.equal(istDayKey(Date.parse("2026-11-14T19:00:00Z")), "2026-11-15");
  assert.equal(istDayKey(Date.parse("2026-11-14T18:00:00Z")), "2026-11-14");
});
