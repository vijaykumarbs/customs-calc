import {
  computeDuty,
  ftaColumnIndex,
  formatINR,
  istDayKey,
  parseAmount,
  preferentialRate,
  searchHsn,
} from "./duty.js";

const QUOTA_KEY = "customscalc.quota.v1";
const NOTIFY_KEY = "customscalc.notify.v1";
const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  fta: { columns: [], rates: [] },
  meta: null,
  countries: [],
  selectedIndex: null,
  activeOption: -1,
  options: [],
  lastResult: null,
  freeLimit: 5,
  limited: new Set(),
};

/* ---------------------------------------------------------------- quota --- */

function readQuota() {
  const today = istDayKey();
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(QUOTA_KEY) || "null");
  } catch {
    raw = null;
  }
  if (!raw || raw.day !== today) raw = { day: today, used: 0 };
  return raw;
}

function writeQuota(quota) {
  try {
    localStorage.setItem(QUOTA_KEY, JSON.stringify(quota));
  } catch {
    /* private mode: quota becomes best-effort */
  }
}

function quotaLeft() {
  return Math.max(0, state.freeLimit - readQuota().used);
}

function paintQuota() {
  const quota = readQuota();
  const left = Math.max(0, state.freeLimit - quota.used);
  const pct = Math.round((left / state.freeLimit) * 100);
  const text = $("quotaText");
  const bar = $("quotaBar");
  const wrap = $("quota");

  if (left === 0) {
    text.textContent = "Daily free limit reached — upgrade for unlimited calculations";
    wrap.classList.add("is-empty");
  } else {
    text.textContent = `${left} of ${state.freeLimit} free calculations left today`;
    wrap.classList.remove("is-empty");
  }
  bar.style.width = `${pct}%`;
  $("planChip").textContent = left === 0 ? "Free limit reached" : "Free plan";
  $("planChip").classList.toggle("is-warn", left === 0);
}

function consumeQuota() {
  const quota = readQuota();
  quota.used += 1;
  writeQuota(quota);
  paintQuota();
}

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

function updateUrl() {
  const params = new URLSearchParams();
  if (state.selectedIndex !== null) params.set("hsn", state.rows[state.selectedIndex][0]);
  if ($("country").value) params.set("country", $("country").value);
  const cif = parseAmount($("cif").value);
  if (Number.isFinite(cif) && cif > 0) params.set("cif", String(Math.round(cif)));
  const url = params.toString() ? `${location.pathname}?${params}` : location.pathname;
  history.replaceState(null, "", url);
}

function rateSummary(row) {
  return `<span class="mini-stat"><b>BCD ${pct(row[4])}</b></span>
    <span class="mini-stat"><b>IGST ${pct(row[7])}</b></span>
    <span class="mini-stat">SWS ${pct(row[6])} of BCD</span>`;
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

function renderResults(indices, query) {
  const list = $("searchResults");
  state.options = indices;
  state.activeOption = indices.length ? 0 : -1;
  list.innerHTML = "";

  if (!indices.length) {
    list.innerHTML = `<div class="combo-empty">No tariff line matches “${escapeHtml(query)}”.
      <span>Try the first 4 digits of the HSN code.</span></div>`;
    list.hidden = false;
    $("hsnSearch").setAttribute("aria-expanded", "true");
    return;
  }

  indices.forEach((idx, order) => {
    const row = state.rows[idx];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "combo-option";
    btn.id = `hsn-option-${order}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", "false");
    btn.innerHTML = `<span class="opt-code">${escapeHtml(row[0])}</span>
      <span class="opt-desc">${escapeHtml(row[1])}</span>
      <span class="opt-rates">${rateSummary(row)}</span>`;
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => selectRow(idx));
    list.appendChild(btn);
  });

  list.hidden = false;
  $("hsnSearch").setAttribute("aria-expanded", "true");
  paintActiveOption();
}

function runSearch() {
  const query = $("hsnSearch").value.trim();
  if (query.length < 2) {
    closeResults();
    return;
  }
  renderResults(searchHsn(state.rows, query, 14), query);
}

function selectRow(idx, { scroll = false } = {}) {
  const row = state.rows[idx];
  state.selectedIndex = idx;
  $("hsnSearch").value = `${row[0]} — ${row[1]}`.slice(0, 120);
  $("selCode").textContent = row[0];
  $("selDesc").textContent = row[1];
  $("selRates").innerHTML = rateSummary(row);
  $("selectedCard").hidden = false;
  closeResults();
  updateUrl();
  if (scroll) $("selectedCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* -------------------------------------------------------------- countries --- */

function loadCountries() {
  const select = $("country");
  select.replaceChildren();
  const countries = [...state.meta.countries]
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

function renderResult(result, country, ftaRow) {
  const body = $("resultBody");
  const r = result;
  const agreement = country.agreement;
  const parts = [];

  parts.push(`<div class="result-head">
    <div class="result-title">
      <span class="pill">HSN ${escapeHtml(r.hsn)}</span>
      <h3>${escapeHtml(r.desc)}</h3>
      <p class="result-origin">${escapeHtml(country.name)} · ${agreement === "MFN" ? "MFN rate" : escapeHtml(country.agreementLabel)}</p>
    </div>
    <div class="result-total">
      <span>Landed cost</span>
      <strong>${formatINR(r.landedCost)}</strong>
      <small>${formatINR(r.cif)} assessable + ${formatINR(r.totalDuty)} duty</small>
    </div>
  </div>`);

  if (r.prefApplied) {
    parts.push(`<div class="banner banner-good">
      <strong>Preferential rate applied.</strong>
      ${escapeHtml(country.agreementLabel)} BCD is ${pct(r.appliedBcdRate)} against MFN ${pct(r.bcdEffective)} —
      saving ${formatINR(r.prefSaving)} on this shipment.
      <span>Requires a valid certificate of origin and direct consignment.</span>
    </div>`);
  } else if (!country.modelled && agreement !== "MFN") {
    parts.push(`<div class="banner banner-note">
      <strong>${escapeHtml(country.agreementLabel)} is a limited agreement.</strong>
      This line is shown at the MFN rate. Line-specific concessions are not modelled yet, so
      confirm the preferential rate against the notification before claiming it.
    </div>`);
  } else if (r.ftaRate !== null) {
    parts.push(`<div class="banner banner-note">
      The ${escapeHtml(country.agreementLabel)} rate for this line is ${pct(r.ftaRate)}, which is not lower than
      MFN ${pct(r.bcdEffective)}. The MFN rate applies.
    </div>`);
  }

  parts.push(`<div class="table-wrap"><table class="duty-table">
    <caption class="sr-only">Duty breakdown</caption>
    <thead><tr><th scope="col">Component</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead>
    <tbody>
      ${row("Assessable value (CIF)", "—", r.cif)}
      ${row("Basic customs duty (BCD)", pct(r.appliedBcdRate), r.bcd, {
        note: r.bcdStatutory !== r.bcdEffective
          ? `Statutory ${pct(r.bcdStatutory)} · effective ${pct(r.bcdEffective)}`
          : "",
      })}
      ${row("Social welfare surcharge", `${pct(r.swsPctOfBcd ?? 10)} of BCD`, r.sws)}
      ${r.aidc ? row("AIDC", pct(r.aidcPct), r.aidc) : ""}
      ${r.cess ? row("Cess", pct(r.cessPct), r.cess) : ""}
      ${row("IGST", pct(r.igstPct), r.igst, { note: "on CIF + BCD + SWS + AIDC + cess" })}
      ${row("Total duty", r.effectiveDutyPct + "% of CIF", r.totalDuty, { strong: true })}
      ${row("Landed cost", "—", r.landedCost, { strong: true })}
    </tbody>
  </table></div>`);

  parts.push(`<div class="result-meta">
    <span class="chip">Duty excl. IGST ${pct(r.dutyExclIgstPct)}</span>
    <span class="chip">Effective ${pct(r.effectiveDutyPct)}</span>
    ${ftaRow ? `<span class="chip chip-muted">MFN BCD ${pct(r.bcdEffective)} · ${escapeHtml(country.agreementLabel)} ${pct(r.ftaRate ?? r.bcdEffective)}</span>` : ""}
    <span class="chip ${r.flag === 0 ? "chip-good" : "chip-warn"}">${escapeHtml(r.flagLabel)}</span>
  </div>
  <div class="result-actions">
    <button class="btn btn-outline btn-sm" type="button" id="copyBtn">Copy breakdown</button>
    <a class="btn btn-ghost btn-sm" href="#calculator" id="recalcLink">Change shipment</a>
  </div>
  <p class="result-fine">Indicative only. Anti-dumping, safeguard, TRQ, specific duties and origin verification are excluded. Confirm on ICEGATE before filing.</p>`);

  body.innerHTML = parts.join("");
  body.hidden = false;
  $("resultEmpty").hidden = true;

  $("copyBtn").addEventListener("click", () => copyBreakdown(r, country));
  $("recalcLink").addEventListener("click", () => {
    $("hsnSearch").focus();
  });
}

async function copyBreakdown(r, country) {
  const lines = [
    `CustomsCalc — indicative import duty`,
    `HSN ${r.hsn} · ${r.desc}`,
    `Origin: ${country.name}${country.agreement !== "MFN" ? ` (${country.agreementLabel})` : " (MFN)"}`,
    `Assessable value: ${formatINR(r.cif)}`,
    `BCD: ${pct(r.appliedBcdRate)} = ${formatINR(r.bcd)}`,
    `SWS: ${formatINR(r.sws)}`,
    r.aidc ? `AIDC: ${formatINR(r.aidc)}` : "",
    r.cess ? `Cess: ${formatINR(r.cess)}` : "",
    `IGST: ${pct(r.igstPct)} = ${formatINR(r.igst)}`,
    `Total duty: ${formatINR(r.totalDuty)} (${pct(r.effectiveDutyPct)} of CIF)`,
    `Landed cost: ${formatINR(r.landedCost)}`,
    `Verify on ICEGATE before filing.`,
  ].filter(Boolean);

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("Breakdown copied to clipboard");
  } catch {
    toast("Copy failed — select the table manually");
  }
}

function showQuotaWall() {
  openPricing();
  toast("Free limit reached. The unlimited plan is launching soon.");
}

/* -------------------------------------------------------------- calculate --- */

function calculate(ev) {
  ev.preventDefault();

  if (state.selectedIndex === null) {
    const typed = $("hsnSearch").value.trim();
    const digits = typed.replace(/\D/g, "");
    if (!typed) {
      toast("Pick an HSN code from the search results first.");
      $("hsnSearch").focus();
      return;
    }
    const found = digits
      ? state.rows.findIndex((r) => r[0] === digits)
      : state.rows.findIndex((r) => r[1].toLowerCase().includes(typed.toLowerCase()));
    if (found >= 0) {
      selectRow(found);
    } else {
      toast("Pick an HSN code from the search results first.");
      $("hsnSearch").focus();
      return;
    }
  }

  const cif = parseAmount($("cif").value);
  if (!Number.isFinite(cif) || cif <= 0) {
    toast("Enter the assessable value in rupees.");
    $("cif").focus();
    return;
  }

  if (quotaLeft() <= 0) {
    showQuotaWall();
    return;
  }

  const idx = state.selectedIndex;
  const rowData = state.rows[idx];
  const ftaRow = state.fta.rates[idx];
  const country = selectedCountry();
  const pref = preferentialRate(state.fta, ftaRow, country.agreement);

  let result;
  try {
    result = computeDuty({ cif, row: rowData, ftaRate: pref });
  } catch (err) {
    toast(err.message || "Could not calculate duty.");
    return;
  }

  result.swsPctOfBcd = rowData[6];
  result.igstPct = rowData[7];
  state.lastResult = { result, country, ftaRow };

  consumeQuota();
  renderResult(result, country, ftaRow);
  updateUrl();

  if (window.matchMedia("(max-width: 900px)").matches) {
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
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

  $("notifyForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const email = $("notifyEmail").value.trim();
    if (!email) return;
    try {
      const saved = JSON.parse(localStorage.getItem(NOTIFY_KEY) || "[]");
      saved.push({ email, at: istDayKey() });
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(saved.slice(-5)));
    } catch {
      /* best effort */
    }
    $("notifyStatus").textContent = `Saved ${email}. We'll write when the ₹99 plan opens.`;
    $("notifyEmail").value = "";
    toast("You're on the list");
  });
}

/* ------------------------------------------------------------------ init --- */

function wireCombo() {
  const input = $("hsnSearch");
  input.addEventListener("input", () => {
    state.selectedIndex = null;
    $("selectedCard").hidden = true;
    runSearch();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2 && state.selectedIndex === null) runSearch();
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
      if (state.activeOption >= 0 && state.options[state.activeOption] !== undefined) {
        ev.preventDefault();
        selectRow(state.options[state.activeOption]);
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
      $("cif").value = plainNumber(Number(btn.dataset.amount));
      updateUrl();
    });
  });
  $("cif").addEventListener("blur", () => {
    const n = parseAmount($("cif").value);
    if (Number.isFinite(n) && n > 0) $("cif").value = plainNumber(n);
  });
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  const hsn = (params.get("hsn") || "").replace(/\D/g, "");
  if (hsn) {
    const idx = state.rows.findIndex((r) => r[0] === hsn || r[0].startsWith(hsn));
    if (idx >= 0) selectRow(idx);
  }
  const country = params.get("country");
  if (country && [...$("country").options].some((o) => o.value === country)) {
    $("country").value = country;
  }
  const cif = Number(params.get("cif"));
  if (Number.isFinite(cif) && cif > 0) $("cif").value = plainNumber(cif);
}

async function init() {
  $("year").textContent = String(new Date().getFullYear());
  wireModal();
  wireCombo();
  wireAmounts();
  paintQuota();
  $("calcForm").addEventListener("submit", calculate);
  $("country").addEventListener("change", updateUrl);

  try {
    const [hsn, fta, meta] = await Promise.all(
      ["data/hsn.json", "data/fta.json", "data/meta.json"].map((path) =>
        fetch(path, { cache: "force-cache" }).then((res) => {
          if (!res.ok) throw new Error(`${path} returned ${res.status}`);
          return res.json();
        }),
      ),
    );
    state.rows = hsn;
    state.fta = fta;
    state.meta = meta;
    state.freeLimit = meta.free_daily_limit || 5;
    state.limited = new Set(
      (meta.agreements || [])
        .filter((a) => /^No\b/i.test(a.modelled || ""))
        .map((a) => a.col),
    );

    loadCountries();
    paintQuota();
    applyUrlState();

    $("calcBtn").disabled = false;
    $("calcBtn").textContent = "Calculate landed cost";
  } catch (err) {
    $("calcBtn").disabled = true;
    $("calcBtn").textContent = "Data unavailable";
    $("resultEmpty").innerHTML = `<div class="empty-icon" aria-hidden="true">!</div>
      <h3>Could not load the tariff data</h3>
      <p>${escapeHtml(err.message)}. Refresh the page, or check that <code>data/</code> is deployed next to the app.</p>`;
    console.error(err);
  }
}

init();
