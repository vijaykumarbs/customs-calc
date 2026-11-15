#!/usr/bin/env node
/**
 * Regenerate tests/vectors.json from the current data and the browser duty
 * module. The Python parity test uses the same file, so any drift between
 * web/assets/duty.js and backend/duty.py fails the suite.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeDuty } from "../web/assets/duty.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = JSON.parse(readFileSync(join(root, "data/hsn.json"), "utf8"));
const byCode = new Map(rows.map((row) => [row[0], row]));

const cases = [
  { name: "smartphone MFN, UAE rate not preferential", code: "85171300", cif: 100000, fta: 15 },
  { name: "smartphone under AIFTA at zero BCD", code: "85171300", cif: 100000, fta: 0 },
  { name: "gold with 5% AIDC and zero-BCD CEPA", code: "71081200", cif: 2500000, fta: 0 },
  { name: "gold MFN with AIDC", code: "71081200", cif: 2500000, fta: null },
  { name: "cigarettes with cess", code: "24022010", cif: 500000, fta: 28 },
  { name: "petroleum products, 5% BCD", code: "27101290", cif: 1234567.89, fta: 5 },
  { name: "beer, 100% BCD and nil IGST", code: "22030000", cif: 75000, fta: null },
  { name: "dataset-only line with nil IGST", code: "01011010", cif: 400000, fta: 30 },
  { name: "apples, 50% BCD", code: "08081000", cif: 98765.43, fta: 50 },
  { name: "small CIF with rounding pressure", code: "30049099", cif: 145.05, fta: 0 },
];

const vectors = cases.map((item) => {
  const row = byCode.get(item.code);
  if (!row) throw new Error(`missing HSN ${item.code}`);
  const expected = computeDuty({ cif: item.cif, row, ftaRate: item.fta });
  return {
    name: item.name,
    cif: item.cif,
    row,
    ftaRate: item.fta,
    expected,
  };
});

// Highest preferential rate on a line should not beat MFN.
const smartphone = byCode.get("85171300");
vectors.push({
  name: "preference above MFN is ignored",
  cif: 200000,
  row: smartphone,
  ftaRate: 30,
  expected: computeDuty({ cif: 200000, row: smartphone, ftaRate: 30 }),
});

writeFileSync(
  join(root, "tests/vectors.json"),
  `${JSON.stringify(vectors, null, 2)}\n`,
  "utf8",
);
console.log(`wrote tests/vectors.json (${vectors.length} vectors)`);
