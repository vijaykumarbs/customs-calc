import { computeAssessableValue, formatINR, parseAmount } from "./duty.js";

/**
 * Website controller.
 *
 * The tariff dataset lives in Cloudflare D1 and is only reachable through the
 * Worker. Search returns code + description; a rate lookup or calculation is
 * metered by an anonymous cookie quota held server-side.
 */

const $ = (id) => document.getElementById(id);
const SEARCH_DEBOUNCE_MS = 180;

const state = {
  meta: null,
  countries: [],
  selected: null,
  activeOption: -1,
  options: [],
  lastResult: null,
  quota: { limit: 5, used: 0, remaining: 5 },
  limited: new Set(),
  searchTimer: null,
  searchController: null,
  requestSeq: 0,
};

/* --------------------------------------------------------------- helpers --- */

const pct = (n) => `${Number(Number(n).toFixed(2))}%`;
const plainNumber = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

const AGREEMENT_LABELS = {
  AIFTA: "ASEAN–India FTA",
  UAE_CEPA: "India–UAE CEPA",
  Japan_CEPA: "India–Japan CEPA",
  Korea_CEPA: "India–Korea CEPA",
  Australia_ECTA: "India–Australia ECTA",
  Mauritius_CECPA: "India–Mauritius CECPA",
  SriLanka_ISFTA: "India–Sri Lanka FTA",
  SAFTA: "SAFTA",
  Singapore_CECA: "India–Singapore CECA",
  Malaysia_MICECA: "India–Malaysia CECA",
  Nepal_Treaty: "India–Nepal Treaty",
  Bhutan_Treaty: "India–Bhutan Treaty",
  EFTA_TEPA: "India–EFTA TEPA",
  UK_CETA: "India–UK CETA",
  Oman_CEPA: "India–Oman CEPA",
  NewZealand_FTA: "India–New Zealand FTA",
  Chile_PTA: "India–Chile PTA",
  Mercosur_PTA: "India–Mercosur PTA",
  APTA: "APTA",
  GSTP: "GSTP",
};
const prettyAgreement = (key) => AGREEMENT_LABELS[key] || String(key || "MFN").replace(/_/g, " ");
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("is-visible"), 2800);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function apiMessage(body, fallback) {
  return body?.error?.message || fallback;
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.selected) params.set("hsn", state.selected.code);
  if ($("country").value) params.set("country", $("country").value);
  const goods = parseAmount($("goodsValue").value);
  if (Number.isFinite(goods) && goods > 0) params.set("value", String(Math.round(goods)));
  for (const [id, key] of [["freight", "freight"], ["insurance", "insurance"], ["otherCharges", "charges"]]) {
    const amount = parseAmount($(id).value);
    if (Number.isFinite(amount) && amount > 0) params.set(key, String(Math.round(amount)));
  }
  const url = params.toString() ? `${location.pathname}?${params}` : location.pathname;
  history.replaceState(null, "", url);
}

/* ---------------------------------------------------------------- quota --- */

function paintQuota() {
  const quota = state.quota;
  const limit = Math.max(1, quota.limit || state.meta?.free_daily_limit || 5);
  const left = Math.max(0, quota.remaining ?? limit - (quota.used || 0));
  const pctLeft = Math.round((left / limit) * 100);
  const text = $("quotaText");
  const bar = $("quotaBar");
  const wrap = $("quota");

  if (left === 0) {
    text.textContent = "Daily free limit reached — upgrade for unlimited calculations";
    wrap.classList.add("is-empty");
  } else {
    text.textContent = `${left} of ${limit} free calculations left today`;
    wrap.classList.remove("is-empty");
  }
  bar.style.width = `${pctLeft}%`;
  $("planChip").textContent = left === 0 ? "Free limit reached" : "Free plan";
  $("planChip").classList.toggle("is-warn", left === 0);
}

async function refreshQuota() {
  try {
    const { response, body } = await requestJson("/api/site/quota");
    if (response.ok && body?.data) state.quota = body.data;
  } catch {
    /* keep the last known value */
  }
  paintQuota();
}

/* ---------------------------------------------------------------- search --- */

function closeResults() {
  const list = $("searchResults");
  list.hidden = true;
  $("hsnSearch").setAttribute("aria-expanded", "false");
  state.activeOption = -1;
}

function paintActiveOption() {
  const list = $("searchResults");
  const buttons = [...list.querySelectorAll(".combo-option")];
  buttons.forEach((btn, i) => {
    const on = i === state.activeOption;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", String(on));
    if (on) {
      btn.scrollIntoView({ block: "nearest" });
      $("hsnSearch").setAttribute("aria-activedescendant", btn.id);
    }
  });
  if (state.activeOption < 0) $("hsnSearch").removeAttribute("aria-activedescendant");
}

function renderResults(results, query) {
  const list = $("searchResults");
  state.options = results;
  state.activeOption = results.length ? 0 : -1;
  list.innerHTML = "";

  if (!results.length) {
    list.innerHTML = `<div class="combo-empty">No tariff line matches “${escapeHtml(query)}”.
      <span>Try the first 4 digits of the HSN code.</span></div>`;
    list.hidden = false;
    $("hsnSearch").setAttribute("aria-expanded", "true");
    return;
  }

  results.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "combo-option";
    btn.id = `hsn-option-${index}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", "false");
    btn.innerHTML = `<span class="opt-code">${escapeHtml(item.code)}</span>
      <span class="opt-desc">${escapeHtml(item.description)}</span>`;
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => selectCode(item.code, item.description));
    list.appendChild(btn);
  });

  list.hidden = false;
  $("hsnSearch").setAttribute("aria-expanded", "true");
  paintActiveOption();
}

function renderSearchError(message) {
  const list = $("searchResults");
  state.options = [];
  state.activeOption = -1;
  list.innerHTML = `<div class="combo-empty">Search is unavailable right now.
    <span>${escapeHtml(message || "Please try again in a moment.")}</span></div>`;
  list.hidden = false;
  $("hsnSearch").setAttribute("aria-expanded", "true");
}

async function runSearch() {
  const query = $("hsnSearch").value.trim();
  if (query.length < 2) {
    closeResults();
    return;
  }

  state.searchController?.abort();
  const controller = new AbortController();
  state.searchController = controller;
  const seq = ++state.requestSeq;

  try {
    const { response, body } = await requestJson(
      `/api/site/search?q=${encodeURIComponent(query)}&limit=14`,
      { signal: controller.signal },
    );
    if (seq !== state.requestSeq) return;
    if (!response.ok) {
      renderSearchError(apiMessage(body, "Search failed."));
      return;
    }
    renderResults(body?.data?.results || [], query);
  } catch (err) {
    if (err.name === "AbortError") return;
    if (seq !== state.requestSeq) return;
    renderSearchError("Check your connection and try again.");
  }
}

function scheduleSearch() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

function selectCode(code, description, { scroll = false } = {}) {
  state.selected = { code, description };
  $("hsnSearch").value = `${code} — ${description}`.slice(0, 120);
  $("selCode").textContent = code;
  $("selDesc").textContent = description;
  $("selectedCard").hidden = false;
  closeResults();
  updateUrl();
  if (scroll) $("selectedCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* -------------------------------------------------------------- countries --- */

function loadCountries() {
  const select = $("country");
  select.replaceChildren();
  const countries = [...(state.meta?.countries || [])]
    .filter((c) => !/^india$/i.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map();
  for (const country of countries) {
    const region = country.region || "Other";
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(country);
  }

  for (const [region, items] of groups) {
    const group = document.createElement("optgroup");
    group.label = region;
    for (const country of items) {
      const option = document.createElement("option");
      option.value = country.name;
      option.dataset.col = country.col || "MFN";
      option.textContent = country.agreement && country.agreement !== "MFN"
        ? `${country.name} · ${country.agreement}`
        : country.name;
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  const preferred = ["China", "United Arab Emirates", "United States", "Japan", "Germany"];
  const pick = preferred.find((name) => countries.some((c) => c.name === name)) || countries[0]?.name;
  if (pick) select.value = pick;
}

function selectedCountry() {
  const select = $("country");
  const option = select.selectedOptions[0];
  const col = option?.dataset.col || "MFN";
  return {
    name: select.value,
    agreement: col,
    agreementLabel: prettyAgreement(col),
    modelled: col === "MFN" || !state.limited.has(col),
    label: option?.textContent || select.value,
  };
}

/* ---------------------------------------------------------------- result --- */

function row(label, rate, amount, { strong = false, note = "" } = {}) {
  return `<tr class="${strong ? "is-total" : ""}">
    <th scope="row">${label}${note ? `<span class="cell-note">${note}</span>` : ""}</th>
    <td class="rate">${rate}</td>
    <td class="amount">${formatINR(amount)}</td>
  </tr>`;
}

function renderResult(r, origin) {
  const body = $("resultBody");
  const agreement = origin.agreement;
  const agreementLabel = origin.agreementName || origin.agreementLabel || prettyAgreement(agreement);
  const valuation = r.valuation || {
    goodsValue: r.cif,
    freight: 0,
    insurance: 0,
    otherCharges: 0,
    chargesTotal: 0,
    assessableValue: r.cif,
  };
  const parts = [];

  parts.push(`<div class="result-head">
    <div class="result-title">
      <span class="pill">HSN ${escapeHtml(r.hsn)}</span>
      <h3>${escapeHtml(r.desc || r.description)}</h3>
      <p class="result-origin">${escapeHtml(origin.country)} · ${agreement === "MFN" ? "MFN rate" : escapeHtml(agreementLabel)}</p>
    </div>
    <div class="result-total">
      <span>Landed cost</span>
      <strong>${formatINR(r.landedCost)}</strong>
      <small>${formatINR(r.cif)} assessable + ${formatINR(r.totalDuty)} payable to customs</small>
    </div>
  </div>`);

  if (r.prefApplied) {
    parts.push(`<div class="banner banner-good">
      <strong>Preferential rate applied.</strong>
      ${escapeHtml(agreementLabel)} BCD is ${pct(r.appliedBcdRate)} against MFN ${pct(r.bcdEffective)} —
      saving ${formatINR(r.prefSaving)} on this shipment.
      <span>Requires a valid certificate of origin and direct consignment.</span>
    </div>`);
  } else if (origin.modelled === false && agreement !== "MFN") {
    parts.push(`<div class="banner banner-note">
      <strong>${escapeHtml(agreementLabel)} is a limited agreement.</strong>
      This line is shown at the MFN rate. Line-specific concessions are not modelled yet, so
      confirm the preferential rate against the notification before claiming it.
    </div>`);
  } else if (r.ftaRate !== null) {
    parts.push(`<div class="banner banner-note">
      The ${escapeHtml(agreementLabel)} rate for this line is ${pct(r.ftaRate)}, which is not lower than
      MFN ${pct(r.bcdEffective)}. The MFN rate applies.
    </div>`);
  }

  const chapter = Number(r.chapter);
  if ([28, 29, 32, 38, 39, 40, 48, 69, 70, 72, 73, 76, 84, 85, 87].includes(chapter)) {
    parts.push(`<div class="banner banner-warn">
      <strong>Anti-dumping or safeguard duty may apply.</strong>
      Some lines in chapter ${escapeHtml(String(r.chapter))} attract anti-dumping, countervailing or
      safeguard duty. These are notified case by case and are not included in this estimate. Check the
      current DGTR/CBIC notification before filing.
    </div>`);
  }

  parts.push(`<div class="table-wrap"><table class="duty-table">
    <caption class="sr-only">Duty breakdown</caption>
    <thead><tr><th scope="col">Component</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead>
    <tbody>
      ${row("Invoice / FOB value", "—", valuation.goodsValue)}
      ${row("Freight to India", "—", valuation.freight)}
      ${row("Insurance", "—", valuation.insurance)}
      ${row("Other includible charges", "—", valuation.otherCharges)}
      ${row("Assessable value (CIF)", "—", r.cif, { strong: true })}
      ${row("Basic customs duty (BCD)", pct(r.appliedBcdRate), r.bcd, {
        note: r.bcdStatutory !== r.bcdEffective
          ? `Statutory ${pct(r.bcdStatutory)} · effective ${pct(r.bcdEffective)}`
          : "",
      })}
      ${row("Social welfare surcharge", `${pct(r.swsPctOfBcd ?? 10)} of BCD`, r.sws)}
      ${r.aidc ? row("AIDC", pct(r.aidcPct), r.aidc) : ""}
      ${r.cess ? row("Cess", pct(r.cessPct), r.cess) : ""}
      ${row("Customs duty before IGST", pct(r.dutyExclIgstPct), r.bcd + r.sws + r.aidc + r.cess, {
        note: "BCD + SWS + AIDC + cess",
      })}
      ${row("IGST at import", pct(r.igstPct), r.igst, {
        note: "on assessable value + BCD + SWS + AIDC + cess",
      })}
      ${row("Total payable to customs", r.effectiveDutyPct + "% of assessable value", r.totalDuty, { strong: true })}
      ${row("Landed cost", "—", r.landedCost, { strong: true })}
    </tbody>
  </table></div>`);

  parts.push(`<div class="result-meta">
    <span class="chip">Duty excl. IGST ${pct(r.dutyExclIgstPct)}</span>
    <span class="chip">Effective ${pct(r.effectiveDutyPct)}</span>
    ${r.ftaRate !== null ? `<span class="chip chip-muted">MFN BCD ${pct(r.bcdEffective)} · ${escapeHtml(agreementLabel)} ${pct(r.ftaRate)}</span>` : ""}
    <span class="chip ${r.flag === 0 ? "chip-good" : "chip-warn"}">${escapeHtml(r.flagLabel)}</span>
  </div>
  <div class="result-actions">
    <button class="btn btn-outline btn-sm" type="button" id="copyBtn">Copy breakdown</button>
    <button class="btn btn-outline btn-sm" type="button" id="csvBtn">Download CSV</button>
    <button class="btn btn-ghost btn-sm" type="button" id="printBtn">Print / save PDF</button>
    <a class="btn btn-ghost btn-sm" href="#calculator" id="recalcLink">Change shipment</a>
  </div>
  <p class="result-fine">Indicative only. Assessable value build-up uses invoice value plus freight, insurance and other includible charges. Anti-dumping, safeguard, TRQ, specific duties and origin verification are excluded. Confirm on ICEGATE before filing.${r.dataAsOf ? ` Tariff data as on ${escapeHtml(r.dataAsOf)}.` : ""}</p>`);

  body.innerHTML = parts.join("");
  body.hidden = false;
  $("resultEmpty").hidden = true;

  $("copyBtn").addEventListener("click", () => copyBreakdown(r, origin));
  $("csvBtn").addEventListener("click", () => downloadCsv(r, origin));
  $("printBtn").addEventListener("click", () => window.print());
  $("recalcLink").addEventListener("click", () => {
    $("hsnSearch").focus();
  });
}

async function copyBreakdown(r, origin) {
  const agreementLabel = origin.agreementName || prettyAgreement(origin.agreement);
  const valuation = r.valuation || {
    goodsValue: r.cif,
    freight: 0,
    insurance: 0,
    otherCharges: 0,
  };
  const lines = [
    "CustomsCalc — indicative import duty",
    `HSN ${r.hsn} · ${r.desc || r.description}`,
    `Origin: ${origin.country}${origin.agreement !== "MFN" ? ` (${agreementLabel})` : " (MFN)"}`,
    `Invoice / FOB value: ${formatINR(valuation.goodsValue)}`,
    `Freight: ${formatINR(valuation.freight)}`,
    `Insurance: ${formatINR(valuation.insurance)}`,
    `Other includible charges: ${formatINR(valuation.otherCharges)}`,
    `Assessable value (CIF): ${formatINR(r.cif)}`,
    `BCD: ${pct(r.appliedBcdRate)} = ${formatINR(r.bcd)}`,
    `SWS: ${formatINR(r.sws)}`,
    r.aidc ? `AIDC: ${formatINR(r.aidc)}` : "",
    r.cess ? `Cess: ${formatINR(r.cess)}` : "",
    `IGST at import: ${pct(r.igstPct)} = ${formatINR(r.igst)}`,
    `Total payable to customs: ${formatINR(r.totalDuty)} (${pct(r.effectiveDutyPct)} of assessable value)`,
    `Landed cost: ${formatINR(r.landedCost)}`,
    r.dataAsOf ? `Tariff data as on: ${r.dataAsOf}` : "",
    "Verify on ICEGATE before filing.",
  ].filter(Boolean);

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("Breakdown copied to clipboard");
  } catch {
    toast("Copy failed — select the table manually");
  }
}

function downloadCsv(r, origin) {
  const valuation = r.valuation || {
    goodsValue: r.cif,
    freight: 0,
    insurance: 0,
    otherCharges: 0,
  };
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    ["Field", "Value"],
    ["HSN", r.hsn],
    ["Description", r.desc || r.description],
    ["Origin", origin.country],
    ["Agreement", origin.agreementName || origin.agreement],
    ["Invoice / FOB value", valuation.goodsValue],
    ["Freight", valuation.freight],
    ["Insurance", valuation.insurance],
    ["Other includible charges", valuation.otherCharges],
    ["Assessable value (CIF)", r.cif],
    ["BCD rate %", r.appliedBcdRate],
    ["BCD", r.bcd],
    ["SWS", r.sws],
    ["AIDC", r.aidc],
    ["Cess", r.cess],
    ["Duty before IGST", r.bcd + r.sws + r.aidc + r.cess],
    ["IGST rate %", r.igstPct],
    ["IGST", r.igst],
    ["Total payable to customs", r.totalDuty],
    ["Landed cost", r.landedCost],
    ["Rate flag", r.flagLabel],
    ["Tariff data as on", r.dataAsOf || ""],
    ["Note", "Indicative only. Verify on ICEGATE before filing."],
  ];
  const csv = rows.map((row) => row.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `customscalc-${r.hsn}-${r.cif}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("CSV downloaded");
}

function showQuotaWall() {
  openPricing();
  toast("Free limit reached. The paid plan is not open yet — join the waitlist.");
}

/* -------------------------------------------------------------- valuation --- */

function readValuation({ focus = false } = {}) {
  const goodsValue = parseAmount($("goodsValue").value);
  const freight = parseAmount($("freight").value) || 0;
  const insurance = parseAmount($("insurance").value) || 0;
  const otherCharges = parseAmount($("otherCharges").value) || 0;

  if (!Number.isFinite(goodsValue) || goodsValue <= 0) {
    if (focus) {
      toast("Enter the invoice / FOB value in rupees.");
      $("goodsValue").focus();
    }
    return null;
  }
  if ([freight, insurance, otherCharges].some((n) => !Number.isFinite(n) || n < 0)) {
    if (focus) toast("Freight, insurance and other charges cannot be negative.");
    return null;
  }
  try {
    return computeAssessableValue({ goodsValue, freight, insurance, otherCharges });
  } catch (err) {
    if (focus) toast(err.message || "Check the shipment values.");
    return null;
  }
}

function paintValuation() {
  const valuation = readValuation();
  const amount = $("avAmount");
  if (!valuation) {
    amount.textContent = "—";
    return;
  }
  amount.textContent = formatINR(valuation.assessableValue);
}

/* -------------------------------------------------------------- calculate --- */

async function calculate(ev) {
  ev.preventDefault();

  if (!state.selected) {
    const typed = $("hsnSearch").value.trim();
    const digits = typed.replace(/\D/g, "");
    if (digits.length === 8) {
      selectCode(digits, "Selected HSN code");
    } else {
      toast("Pick an HSN code from the search results first.");
      $("hsnSearch").focus();
      return;
    }
  }

  const valuation = readValuation({ focus: true });
  if (!valuation) return;

  if (state.quota.remaining <= 0) {
    showQuotaWall();
    return;
  }

  const country = selectedCountry();
  const btn = $("calcBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Calculating…";

  try {
    const { response, body } = await requestJson("/api/site/quote", {
      method: "POST",
      body: JSON.stringify({
        hsn: state.selected.code,
        country: country.name,
        goodsValue: valuation.goodsValue,
        freight: valuation.freight,
        insurance: valuation.insurance,
        otherCharges: valuation.otherCharges,
      }),
    });

    if (!response.ok) {
      if (body?.error?.code === "site_quota_exceeded") {
        state.quota = { ...state.quota, remaining: 0 };
        paintQuota();
        showQuotaWall();
      } else {
        toast(apiMessage(body, "Could not calculate duty."));
      }
      return;
    }

    const data = body.data;
    if (data.quota) state.quota = data.quota;
    paintQuota();

    const result = {
      hsn: data.hsn,
      desc: data.description,
      chapter: data.chapter,
      cif: data.cif,
      valuation: data.valuation,
      bcdStatutory: data.rates.bcdStatutory,
      bcdEffective: data.rates.bcdEffective,
      appliedBcdRate: data.rates.appliedBcd,
      ftaRate: data.rates.preferential,
      swsPctOfBcd: data.rates.swsOfBcd,
      igstPct: data.rates.igst,
      aidcPct: data.rates.aidc,
      cessPct: data.rates.cess,
      ...data.amounts,
      effectiveDutyPct: data.effectiveDutyPct,
      dutyExclIgstPct: data.dutyExclIgstPct,
      prefApplied: data.prefApplied,
      prefSaving: data.prefSaving,
      flag: data.flag,
      flagLabel: data.flagLabel,
      dataAsOf: data.dataAsOf || null,
    };

    state.lastResult = { result, origin: data.origin };
    state.selected = { code: data.hsn, description: data.description };
    $("selDesc").textContent = data.description;
    renderResult(result, data.origin);
    updateUrl();

    if (window.matchMedia("(max-width: 900px)").matches) {
      $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch {
    toast("Could not reach the server. Check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

/* ----------------------------------------------------------------- modal --- */

let lastFocus = null;

function openPricing() {
  const modal = $("pricingModal");
  lastFocus = document.activeElement;
  modal.hidden = false;
  modal.classList.add("is-open");
  document.body.classList.add("modal-open");
  modal.querySelector(".modal-close")?.focus();
}

function closePricing() {
  const modal = $("pricingModal");
  modal.hidden = true;
  modal.classList.remove("is-open");
  document.body.classList.remove("modal-open");
  if (lastFocus) lastFocus.focus();
}

function wireModal() {
  document.querySelectorAll("[data-open-pricing]").forEach((btn) => {
    btn.addEventListener("click", openPricing);
  });
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", closePricing);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("pricingModal").hidden) {
      closePricing();
      return;
    }
    if (ev.key === "Tab" && !$("pricingModal").hidden) {
      const focusables = [...$("pricingModal").querySelectorAll("button, input, a[href]")].filter(
        (el) => el.offsetParent !== null,
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  $("notifyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("notifyEmail").value.trim();
    if (!email) return;

    const status = $("notifyStatus");
    const button = $("notifyForm").querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const { response, body } = await requestJson("/api/site/notify", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        status.textContent = apiMessage(body, "Could not save that email. Try again.");
        return;
      }
      status.textContent = `Saved ${email}. We'll write when the ₹99 plan opens.`;
      $("notifyEmail").value = "";
      toast("You're on the list");
    } catch {
      status.textContent = "Could not reach the server. Try again.";
    } finally {
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ init --- */

function wireCombo() {
  const input = $("hsnSearch");
  input.addEventListener("input", () => {
    state.selected = null;
    $("selectedCard").hidden = true;
    scheduleSearch();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2 && !state.selected) runSearch();
  });
  input.addEventListener("keydown", (ev) => {
    const list = $("searchResults");
    if (list.hidden) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        runSearch();
      }
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = state.options.length;
      if (!n) return;
      state.activeOption =
        ev.key === "ArrowDown"
          ? (state.activeOption + 1) % n
          : (state.activeOption - 1 + n) % n;
      paintActiveOption();
    } else if (ev.key === "Enter") {
      const item = state.options[state.activeOption];
      if (item) {
        ev.preventDefault();
        selectCode(item.code, item.description);
      }
    } else if (ev.key === "Escape") {
      closeResults();
    }
  });
  document.addEventListener("click", (ev) => {
    if (!$("combo").contains(ev.target)) closeResults();
  });
}

function wireAmounts() {
  document.querySelectorAll("[data-amount]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("goodsValue").value = plainNumber(Number(btn.dataset.amount));
      paintValuation();
      updateUrl();
    });
  });

  for (const id of ["goodsValue", "freight", "insurance", "otherCharges"]) {
    const input = $(id);
    input.addEventListener("input", () => {
      paintValuation();
      updateUrl();
    });
    input.addEventListener("blur", () => {
      const n = parseAmount(input.value);
      if (Number.isFinite(n) && n >= 0) input.value = plainNumber(n);
      paintValuation();
    });
  }
}

async function applyUrlState() {
  const params = new URLSearchParams(location.search);
  const hsn = (params.get("hsn") || "").replace(/\D/g, "");
  if (hsn.length === 8) {
    try {
      const { response, body } = await requestJson(`/api/site/hsn/${encodeURIComponent(hsn)}`);
      if (response.ok && body?.data) {
        selectCode(body.data.hsn, body.data.description);
      }
    } catch {
      /* leave the field empty */
    }
  }
  const country = params.get("country");
  if (country && [...$("country").options].some((o) => o.value === country)) {
    $("country").value = country;
  }
  const goods = Number(params.get("value") || params.get("cif"));
  if (Number.isFinite(goods) && goods > 0) $("goodsValue").value = plainNumber(goods);
  for (const [param, id] of [["freight", "freight"], ["insurance", "insurance"], ["charges", "otherCharges"]]) {
    const amount = Number(params.get(param));
    if (Number.isFinite(amount) && amount >= 0) $(id).value = plainNumber(amount);
  }
  paintValuation();
}

async function init() {
  $("year").textContent = String(new Date().getFullYear());
  wireModal();
  wireCombo();
  wireAmounts();
  $("calcForm").addEventListener("submit", calculate);
  $("country").addEventListener("change", updateUrl);
  paintValuation();
  paintQuota();

  try {
    const [metaResult, quotaResult] = await Promise.all([
      requestJson("/api/site/meta"),
      requestJson("/api/site/quota"),
    ]);

    if (!metaResult.response.ok || !metaResult.body?.data) {
      throw new Error(apiMessage(metaResult.body, "The tariff service is unavailable."));
    }
    state.meta = metaResult.body.data;
    state.countries = state.meta.countries || [];
    state.limited = new Set(
      (state.meta.agreements || [])
        .filter((a) => /^No\b/i.test(a.modelled || ""))
        .map((a) => a.col),
    );
    if (quotaResult.response.ok && quotaResult.body?.data) {
      state.quota = quotaResult.body.data;
    } else {
      state.quota = { limit: state.meta.free_daily_limit || 5, used: 0, remaining: state.meta.free_daily_limit || 5 };
    }

    loadCountries();
    paintQuota();
    await applyUrlState();

    $("calcBtn").disabled = false;
    $("calcBtn").textContent = "Calculate landed cost";
  } catch (err) {
    $("calcBtn").disabled = true;
    $("calcBtn").textContent = "Data unavailable";
    $("resultEmpty").innerHTML = `<div class="empty-icon" aria-hidden="true">!</div>
      <h3>Could not load the tariff service</h3>
      <p>${escapeHtml(err.message || "Please refresh in a moment.")}</p>`;
    console.error(err);
  }

  refreshQuota();
}

init();
