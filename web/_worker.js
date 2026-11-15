/**
 * CustomsCalc production Worker.
 *
 * Cloudflare Pages "advanced mode" entry point. Serves the static site from
 * `env.ASSETS` and exposes two JSON surfaces backed by D1:
 *
 *   /api/site/*   first-party website (anonymous cookie, 5 quotes/day IST)
 *   /api/v1/*     public API (hashed API keys, 10 billable calls/month free)
 *   /api/admin/*  token-protected operations for issuing and upgrading keys
 *
 * The tariff dataset never ships to the browser. Only code + description are
 * returned by search; rate lookups and calculations are metered.
 */

import {
  computeAssessableValue,
  computeDuty,
  ftaColumnIndex,
  istDayKey,
  FLAG_LABELS,
} from "./assets/duty.js";

const VERSION = "2.0";
const API_FREE_MONTHLY_LIMIT = 10;
const PAID_MONTHLY_LIMIT = 1_000_000;
const SITE_DAILY_LIMIT = 5;
const SITE_IP_DAILY_LIMIT = 40;
const SEARCH_RESULT_MAX = 25;
const BODY_LIMIT = 8 * 1024;
const COOKIE_NAME = "cc_client";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const HSN_RE = /^\d{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-api-key, content-type",
  "access-control-max-age": "86400",
};

const BASE_META = {
  version: "1.1",
  generated: null,
  line_count: 14416,
  free_daily_limit: SITE_DAILY_LIMIT,
  free_api_monthly_limit: API_FREE_MONTHLY_LIMIT,
  price_inr: 99,
  columns: [],
  countries: [],
  agreements: [],
};

let metaCache = null;
let metaCacheAt = 0;

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------- responses --- */

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function apiJson(body, status = 200, headers = {}) {
  return json(body, status, { ...CORS_HEADERS, ...headers });
}

function errorBody(code, message, extra = {}) {
  return {
    error: {
      code,
      message,
      docs: "https://customs.vijayebhava.com/api-docs/",
      ...extra,
    },
  };
}

function apiError(err) {
  const status = err instanceof ApiError ? err.status : 500;
  if (!(err instanceof ApiError)) console.error("Unhandled API error", err);
  return apiJson(
    errorBody(
      err instanceof ApiError ? err.code : "internal_error",
      err instanceof ApiError ? err.message : "Something went wrong. Try again.",
      err instanceof ApiError ? err.extra : {},
    ),
    status,
    status === 401 ? { "www-authenticate": 'Bearer realm="customs-api"' } : {},
  );
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/* ---------------------------------------------------------------- crypto --- */

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `cc_live_${base64url(bytes)}`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function clientIp(request) {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

async function ipHash(request) {
  return (await sha256Hex(`customs-calc:${clientIp(request)}`)).slice(0, 32);
}

/* ------------------------------------------------------------------ time --- */

function istMonthKey(now = Date.now()) {
  return istDayKey(now).slice(0, 7);
}

function nextIstMonthStart(now = Date.now()) {
  const shifted = new Date(now + 5.5 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  if (month === 12) return `${year + 1}-01-01`;
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/* --------------------------------------------------------------- helpers --- */

async function readJsonBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > BODY_LIMIT) {
    throw new ApiError(413, "payload_too_large", "Request body must be under 8 KB.");
  }
  const text = await request.text();
  if (text.length > BODY_LIMIT) {
    throw new ApiError(413, "payload_too_large", "Request body must be under 8 KB.");
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_json", "Send a JSON object in the request body.");
  }
}

function cleanQuery(value, { min = 2, max = 80 } = {}) {
  const q = String(value || "").trim().replace(/\s+/g, " ");
  if (q.length < min) {
    throw new ApiError(400, "invalid_query", `Search needs at least ${min} characters.`);
  }
  if (q.length > max) {
    throw new ApiError(400, "invalid_query", `Search must be ${max} characters or fewer.`);
  }
  return q;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function parseLimit(value, fallback = 12) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(SEARCH_RESULT_MAX, n));
}

function normaliseEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new ApiError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function parseCif(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError(400, "invalid_cif", "cif must be a number greater than zero.");
  }
  if (n > 1e12) {
    throw new ApiError(400, "invalid_cif", "cif looks too large.");
  }
  return Math.round(n * 100) / 100;
}

function parseCharge(value, label) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(400, "invalid_charge", `${label} must be zero or more.`);
  }
  if (n > 1e12) {
    throw new ApiError(400, "invalid_charge", `${label} looks too large.`);
  }
  return Math.round(n * 100) / 100;
}

/**
 * Accept either the legacy `cif` (direct assessable value) or a build-up from
 * invoice value plus freight, insurance and other includible charges.
 */
function valuationFromBody(body) {
  const hasGoods =
    body.goodsValue !== undefined ||
    body.invoiceValue !== undefined ||
    body.value !== undefined;
  const hasCharges = ["freight", "insurance", "otherCharges"].some(
    (key) => body[key] !== undefined,
  );

  if (!hasGoods) {
    if (hasCharges) {
      throw new ApiError(
        400,
        "missing_goods_value",
        "Send goodsValue (invoice value) together with freight, insurance or otherCharges.",
      );
    }
    const cif = parseCif(body.cif);
    return {
      goodsValue: cif,
      freight: 0,
      insurance: 0,
      otherCharges: 0,
      chargesTotal: 0,
      assessableValue: cif,
    };
  }

  const goods = parseCif(body.goodsValue ?? body.invoiceValue ?? body.value);
  try {
    return computeAssessableValue({
      goodsValue: goods,
      freight: parseCharge(body.freight, "freight"),
      insurance: parseCharge(body.insurance, "insurance"),
      otherCharges: parseCharge(body.otherCharges, "otherCharges"),
    });
  } catch (err) {
    throw new ApiError(400, "invalid_value", err.message || "Could not value the shipment.");
  }
}

function flagLabel(flag) {
  return FLAG_LABELS[flag] || "Unverified rate";
}

function fmtPct(n) {
  return Number(Number(n).toFixed(2));
}

/* ---------------------------------------------------------------- cookies --- */

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    if (at > 0 && trimmed.slice(0, at) === name) return trimmed.slice(at + 1);
  }
  return null;
}

function siteClient(request) {
  const existing = readCookie(request, COOKIE_NAME);
  if (existing && UUID_RE.test(existing)) return { id: existing, fresh: false };
  return { id: crypto.randomUUID(), fresh: true };
}

function siteJson(body, status, client, headers = {}) {
  const extra = { ...headers };
  if (client?.fresh) {
    extra["set-cookie"] =
      `${COOKIE_NAME}=${client.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
  }
  return json(body, status, extra);
}

/* ----------------------------------------------------------- rate limits --- */

async function bumpRateLimit(env, bucket, limit, windowSeconds, now = Date.now()) {
  const slot = Math.floor(now / (windowSeconds * 1000));
  const key = `${bucket}:${slot}`;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, expires_at, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
    )
      .bind(key, (slot + 1) * windowSeconds * 1000)
      .first();
    return Boolean(row && row.count <= limit);
  } catch (err) {
    console.error("rate limit failed", err);
    return true;
  }
}

async function enforceRateLimit(env, bucket, limit, windowSeconds, message) {
  const allowed = await bumpRateLimit(env, bucket, limit, windowSeconds);
  if (!allowed) {
    throw new ApiError(429, "rate_limited", message, {
      retryAfterSeconds: windowSeconds,
    });
  }
}

/* -------------------------------------------------------------- settings --- */

async function loadMeta(env) {
  const now = Date.now();
  if (metaCache && now - metaCacheAt < 60_000) return metaCache;
  let stored = null;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'meta'",
    ).first();
    if (row?.value) stored = JSON.parse(row.value);
  } catch (err) {
    console.error("settings read failed", err);
  }
  metaCache = { ...BASE_META, ...(stored || {}) };
  metaCacheAt = now;
  return metaCache;
}

function publicMeta(meta) {
  return {
    version: meta.version,
    generated: meta.generated,
    data_as_of: meta.data_as_of || meta.generated,
    line_count: meta.line_count,
    columns: meta.columns,
    countries: meta.countries,
    agreements: meta.agreements,
    free_daily_limit: meta.free_daily_limit || SITE_DAILY_LIMIT,
    free_api_monthly_limit: meta.free_api_monthly_limit || API_FREE_MONTHLY_LIMIT,
    price_inr: meta.price_inr || 99,
  };
}

/* ------------------------------------------------------------------- hsn --- */

function toRow(record) {
  return [
    record.code,
    record.description,
    record.chapter,
    record.bcd_statutory,
    record.bcd_effective,
    record.aidc,
    record.sws,
    record.igst,
    record.cess,
    record.flag,
  ];
}

async function findHsn(env, code) {
  const normalised = String(code || "").replace(/\s/g, "");
  if (!HSN_RE.test(normalised)) {
    throw new ApiError(
      400,
      "invalid_hsn",
      "Use the full 8-digit HSN code, for example 85171300.",
    );
  }
  const record = await env.DB.prepare(
    `SELECT code, description, chapter, bcd_statutory, bcd_effective,
            aidc, sws, igst, cess, flag, fta
       FROM hsn WHERE code = ?`,
  )
    .bind(normalised)
    .first();
  if (!record) {
    throw new ApiError(404, "hsn_not_found", `HSN ${normalised} is not in the dataset.`);
  }
  let rates = [];
  try {
    rates = JSON.parse(record.fta);
  } catch {
    rates = [];
  }
  return { record, rates, row: toRow(record) };
}

async function search(env, query, limit) {
  const q = cleanQuery(query);
  const lower = q.toLowerCase();
  const digits = q.replace(/\D/g, "");
  const tokens = lower
    .split(" ")
    .filter((t) => t.length > 1)
    .slice(0, 4);

  const clauses = [];
  const params = [];

  if (digits.length >= 2) {
    clauses.push("code LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(digits)}%`);
  }
  clauses.push("lower(description) LIKE ? ESCAPE '\\'");
  params.push(`%${escapeLike(lower)}%`);

  let sql = `SELECT code, description FROM hsn WHERE (${clauses.join(" OR ")})`;
  if (tokens.length > 1) {
    sql += ` AND (${tokens
      .map(() => "lower(description) LIKE ? ESCAPE '\\'")
      .join(" AND ")})`;
    for (const token of tokens) params.push(`%${escapeLike(token)}%`);
  }

  sql += ` ORDER BY
    CASE
      WHEN code = ? THEN 0
      WHEN code LIKE ? ESCAPE '\\' THEN 1
      WHEN lower(description) LIKE ? ESCAPE '\\' THEN 2
      ELSE 3
    END,
    length(code), code
    LIMIT ?`;
  params.push(digits, `${escapeLike(digits)}%`, `%${escapeLike(lower)}%`, limit);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results || [];
}

/* ---------------------------------------------------------------- origin --- */

const ORIGIN_ALIASES = {
  uae: "united arab emirates",
  "u.a.e.": "united arab emirates",
  usa: "united states",
  us: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  "south korea": "republic of korea",
  korea: "republic of korea",
  "viet nam": "vietnam",
  laos: "lao pdr",
  "czech republic": "czechia",
  turkiye: "turkey",
};

function resolveOrigin(meta, input) {
  const raw = String(input || "").trim();
  const countries = meta.countries || [];
  const agreements = meta.agreements || [];

  if (!raw) {
    return {
      country: "MFN",
      iso: null,
      agreement: "MFN",
      agreementName: "MFN (WTO)",
      modelled: true,
    };
  }

  let needle = raw.toLowerCase();
  if (ORIGIN_ALIASES[needle]) needle = ORIGIN_ALIASES[needle];
  let country = countries.find(
    (c) =>
      c.name.toLowerCase() === needle ||
      String(c.iso || "").toLowerCase() === needle,
  );
  let column = country ? country.col || "MFN" : null;

  if (!country) {
    const agreement = agreements.find(
      (a) => String(a.col || "").toLowerCase() === needle,
    );
    if (agreement) {
      column = agreement.col;
      country = {
        name: agreement.name,
        iso: null,
        col: agreement.col,
      };
    }
  }

  if (!country || !column) {
    throw new ApiError(
      400,
      "unknown_origin",
      `"${raw}" is not a mapped country or agreement. Use a country name such as Japan, or omit the origin for MFN.`,
    );
  }

  const agreement = agreements.find((a) => a.col === column);
  return {
    country: country.name,
    iso: country.iso || null,
    agreement: column,
    agreementName: agreement?.name || column.replace(/_/g, " "),
    modelled: !/^No\b/i.test(agreement?.modelled || "Yes"),
  };
}

function ftaRateFor(meta, origin, rateRow) {
  if (!origin || origin.agreement === "MFN") return null;
  const col = ftaColumnIndex(meta.columns || [], origin.agreement);
  if (col === 0) return null;
  const value = rateRow[col];
  return Number.isFinite(value) ? value : null;
}

function preferentialMap(meta, rateRow) {
  const map = {};
  for (let i = 0; i < (meta.columns || []).length; i += 1) {
    const value = rateRow[i + 1];
    map[meta.columns[i]] = Number.isFinite(value) ? value : null;
  }
  return map;
}

/* ----------------------------------------------------------------- quota --- */

async function reserveApiQuotaCount(env, key, meta, count) {
  const limit = key.plan === "paid"
    ? PAID_MONTHLY_LIMIT
    : Number(meta.free_api_monthly_limit || API_FREE_MONTHLY_LIMIT);
  const period = istMonthKey();
  const amount = Math.max(1, Math.floor(Number(count) || 1));

  // Make sure the row exists, then increment it only if the whole batch fits.
  // The conditional UPDATE is atomic, so concurrent requests cannot overshoot.
  await env.DB.prepare(
    `INSERT INTO api_usage (key_id, period, used) VALUES (?, ?, 0)
     ON CONFLICT(key_id, period) DO NOTHING`,
  )
    .bind(key.id, period)
    .run();

  const row = await env.DB.prepare(
    `UPDATE api_usage SET used = used + ?
      WHERE key_id = ? AND period = ? AND used + ? <= ?
      RETURNING used`,
  )
    .bind(amount, key.id, period, amount, limit)
    .first();

  if (!row) {
    const current = await env.DB.prepare(
      "SELECT used FROM api_usage WHERE key_id = ? AND period = ?",
    )
      .bind(key.id, period)
      .first();
    throw new ApiError(
      429,
      "quota_exceeded",
      key.plan === "paid"
        ? "This key reached its monthly fair-use limit."
        : `The free API plan includes ${limit} billable calls per month. Upgrade to continue.`,
      {
        upgrade: "https://customs.vijayebhava.com/api-docs/#plans",
        plan: key.plan,
        limit,
        used: current?.used ?? limit,
        period,
        resetsOn: nextIstMonthStart(),
      },
    );
  }

  return {
    plan: key.plan,
    limit,
    used: row.used,
    remaining: Math.max(0, limit - row.used),
    period,
    resetsOn: nextIstMonthStart(),
  };
}

async function reserveApiQuota(env, key, meta) {
  return reserveApiQuotaCount(env, key, meta, 1);
}

async function apiQuotaSnapshot(env, key, meta) {
  const limit = key.plan === "paid"
    ? PAID_MONTHLY_LIMIT
    : Number(meta.free_api_monthly_limit || API_FREE_MONTHLY_LIMIT);
  const period = istMonthKey();
  const row = await env.DB.prepare(
    "SELECT used FROM api_usage WHERE key_id = ? AND period = ?",
  )
    .bind(key.id, period)
    .first();
  const used = row?.used || 0;
  return {
    plan: key.plan,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    period,
    resetsOn: nextIstMonthStart(),
  };
}

async function siteQuotaSnapshot(env, clientId, meta) {
  const limit = Number(meta.free_daily_limit || SITE_DAILY_LIMIT);
  const day = istDayKey();
  const row = await env.DB.prepare(
    "SELECT used FROM site_usage WHERE client_id = ? AND day = ?",
  )
    .bind(clientId, day)
    .first();
  const used = row?.used || 0;
  return { limit, used, remaining: Math.max(0, limit - used), day };
}

async function reserveSiteQuota(env, clientId, meta) {
  const limit = Number(meta.free_daily_limit || SITE_DAILY_LIMIT);
  const day = istDayKey();
  const row = await env.DB.prepare(
    `INSERT INTO site_usage (client_id, day, used) VALUES (?, ?, 1)
     ON CONFLICT(client_id, day) DO UPDATE SET used = site_usage.used + 1
       WHERE site_usage.used < ?
     RETURNING used`,
  )
    .bind(clientId, day, limit)
    .first();
  if (!row) {
    throw new ApiError(
      429,
      "site_quota_exceeded",
      "Today's five free calculations are used. The unlimited plan is launching soon.",
      { limit, day, upgrade: "https://customs.vijayebhava.com/#pricing" },
    );
  }
  return { limit, used: row.used, remaining: Math.max(0, limit - row.used), day };
}

/* ------------------------------------------------------------------ auth --- */

async function authenticate(request, env) {
  const header = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const raw = bearer || request.headers.get("x-api-key")?.trim() || "";
  if (!raw) {
    throw new ApiError(
      401,
      "missing_api_key",
      "Send your key as Authorization: Bearer <key> or X-API-Key: <key>.",
    );
  }
  if (!raw.startsWith("cc_live_") || raw.length < 20 || raw.length > 120) {
    throw new ApiError(401, "invalid_api_key", "That API key is not valid.");
  }
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    `SELECT id, email, key_prefix, plan, status, created_at
       FROM api_keys WHERE key_hash = ?`,
  )
    .bind(hash)
    .first();
  if (!row) {
    throw new ApiError(401, "invalid_api_key", "That API key is not valid.");
  }
  if (row.status !== "active") {
    throw new ApiError(403, "key_disabled", "This API key has been revoked.");
  }
  return row;
}

async function adminAuth(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token || token.length < 16) {
    throw new ApiError(503, "admin_disabled", "Admin operations are not configured.");
  }
  const supplied = request.headers.get("x-admin-token") || "";
  if (supplied.length !== token.length || supplied !== token) {
    throw new ApiError(401, "invalid_admin_token", "Admin token missing or invalid.");
  }
}

/* ------------------------------------------------------------- api routes --- */

async function handleV1(request, env, url, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === "/api/v1" || url.pathname === "/api/v1/") {
    return apiJson({
      name: "CustomsCalc India duty API",
      version: VERSION,
      docs: "https://customs.vijayebhava.com/api-docs/",
      endpoints: [
        "GET /api/v1/meta",
        "GET /api/v1/search?q=",
        "GET /api/v1/hsn/{code}",
        "POST /api/v1/calculate",
        "GET /api/v1/usage",
        "POST /api/v1/signup",
      ],
    });
  }

  if (url.pathname === "/api/v1/signup" && request.method === "POST") {
    return signup(request, env);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
  }

  const key = await authenticate(request, env);
  const meta = await loadMeta(env);
  if (ctx) ctx.waitUntil(
    env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), key.id)
      .run()
      .catch(() => {}),
  );

  if (url.pathname === "/api/v1/meta") {
    return apiJson({ data: publicMeta(meta) });
  }

  if (url.pathname === "/api/v1/usage") {
    return apiJson({ data: await apiQuotaSnapshot(env, key, meta) });
  }

  if (url.pathname === "/api/v1/search") {
    await enforceRateLimit(
      env,
      `v1-search:${key.id}`,
      300,
      3600,
      "Too many searches this hour. Try again later.",
    );
    const results = await search(
      env,
      cleanQuery(url.searchParams.get("q")),
      parseLimit(url.searchParams.get("limit")),
    );
    return apiJson({
      data: { query: url.searchParams.get("q"), results },
      meta: { count: results.length, note: "Search is free and does not use quota." },
    });
  }

  if (url.pathname === "/api/v1/hsn") {
    const code = url.searchParams.get("code");
    return hsnLookup(env, meta, key, code);
  }

  if (url.pathname.startsWith("/api/v1/hsn/")) {
    const code = decodeURIComponent(url.pathname.slice("/api/v1/hsn/".length));
    return hsnLookup(env, meta, key, code);
  }

  if (url.pathname === "/api/v1/calculate" && request.method === "POST") {
    await enforceRateLimit(
      env,
      `v1-calc:${key.id}`,
      60,
      60,
      "Too many requests this minute.",
    );
    return calculate(request, env, meta, key);
  }

  if (url.pathname === "/api/v1/calculate/batch" && request.method === "POST") {
    await enforceRateLimit(
      env,
      `v1-batch:${key.id}`,
      10,
      60,
      "Too many batch requests this minute.",
    );
    return calculateBatch(request, env, meta, key);
  }

  throw new ApiError(404, "not_found", "No such API endpoint.");
}

async function hsnLookup(env, meta, key, code) {
  await enforceRateLimit(
    env,
    `v1-hsn:${key.id}`,
    120,
    60,
    "Too many requests this minute.",
  );
  const { record, rates } = await findHsn(env, code);
  const quota = await reserveApiQuota(env, key, meta);
  return apiJson({
    data: {
      hsn: record.code,
      description: record.description,
      chapter: record.chapter,
      rates: {
        bcdStatutory: record.bcd_statutory,
        bcdEffective: record.bcd_effective,
        aidc: record.aidc,
        swsOfBcd: record.sws,
        igst: record.igst,
        cess: record.cess,
      },
      preferentialRates: { MFN: record.bcd_effective, ...preferentialMap(meta, rates) },
      flag: record.flag,
      flagLabel: flagLabel(record.flag),
      quota,
    },
    meta: {
      indicative: true,
      source: "CBIC working tariff as on 30.06.2025, with curated effective rates",
      disclaimer:
        "Indicative only. Excludes anti-dumping, safeguard, TRQ, specific duties and origin verification. Verify on ICEGATE.",
    },
  });
}

function buildQuoteData(result, origin, valuation, quota, meta) {
  return {
    hsn: result.hsn,
    description: result.desc,
    chapter: result.chapter,
    origin,
    valuation,
    cif: result.cif,
    dataAsOf: meta?.data_as_of || meta?.generated || null,
    rates: {
      bcdStatutory: result.bcdStatutory,
      bcdEffective: result.bcdEffective,
      appliedBcd: result.appliedBcdRate,
      preferential: result.ftaRate,
      swsOfBcd: result.swsPctOfBcd,
      igst: result.igstPct,
      aidc: result.aidcPct,
      cess: result.cessPct,
    },
    amounts: {
      bcd: result.bcd,
      sws: result.sws,
      aidc: result.aidc,
      cess: result.cess,
      igst: result.igst,
      dutyBeforeIgst: Math.round(
        (result.bcd + result.sws + result.aidc + result.cess) * 100,
      ) / 100,
      totalDuty: result.totalDuty,
      landedCost: result.landedCost,
    },
    effectiveDutyPct: fmtPct(result.effectiveDutyPct),
    dutyExclIgstPct: fmtPct(result.dutyExclIgstPct),
    prefApplied: result.prefApplied,
    prefSaving: result.prefSaving,
    mfnLandedCost: result.mfnLandedCost,
    flag: result.flag,
    flagLabel: result.flagLabel,
    quota,
  };
}

async function calculate(request, env, meta, key) {
  const body = await readJsonBody(request);
  const code = String(body.hsn ?? body.code ?? "").trim();
  const valuation = valuationFromBody(body);
  const origin = resolveOrigin(meta, body.country ?? body.origin ?? body.agreement);
  const { record, row, rates } = await findHsn(env, code);
  const ftaRate = ftaRateFor(meta, origin, rates);

  const quota = await reserveApiQuota(env, key, meta);
  let result;
  try {
    result = computeDuty({ cif: valuation.assessableValue, row, ftaRate });
  } catch (err) {
    throw new ApiError(400, "calculation_failed", err.message || "Could not calculate duty.");
  }

  return apiJson({
    data: buildQuoteData(result, origin, valuation, quota, meta),
    meta: {
      indicative: true,
      disclaimer:
        "Indicative only. Excludes anti-dumping, safeguard, TRQ, specific duties and origin verification. Verify on ICEGATE.",
    },
  });
}

async function calculateBatch(request, env, meta, key) {
  const body = await readJsonBody(request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0 || items.length > 20) {
    throw new ApiError(
      400,
      "invalid_batch",
      "Send between 1 and 20 line items in the items array.",
    );
  }

  const resolved = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "invalid_batch", `items[${i}] must be an object.`);
    }
    try {
      const code = String(item.hsn ?? item.code ?? "").trim();
      const valuation = valuationFromBody(item);
      const origin = resolveOrigin(meta, item.country ?? item.origin ?? item.agreement);
      const { row, rates } = await findHsn(env, code);
      resolved.push({
        valuation,
        origin,
        row,
        ftaRate: ftaRateFor(meta, origin, rates),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError(
          err.status,
          err.code,
          `items[${i}]: ${err.message}`,
          { ...err.extra, batch_index: i },
        );
      }
      throw err;
    }
  }

  const quota = await reserveApiQuotaCount(env, key, meta, resolved.length);
  const results = resolved.map(({ valuation, origin, row, ftaRate }) => {
    const result = computeDuty({ cif: valuation.assessableValue, row, ftaRate });
    const data = buildQuoteData(result, origin, valuation, quota, meta);
    delete data.quota;
    return data;
  });

  return apiJson({
    data: { count: results.length, quota, results },
    meta: {
      indicative: true,
      disclaimer:
        "Indicative only. Excludes anti-dumping, safeguard, TRQ, specific duties and origin verification. Verify on ICEGATE.",
    },
  });
}

async function signup(request, env) {
  const ip = await ipHash(request);
  await enforceRateLimit(
    env,
    `signup:${ip}`,
    3,
    86400,
    "Too many API keys requested from this address today.",
  );
  const body = await readJsonBody(request);
  const email = normaliseEmail(body.email);

  const existing = await env.DB.prepare(
    "SELECT id, status FROM api_keys WHERE email = ? LIMIT 1",
  )
    .bind(email)
    .first();
  if (existing) {
    throw new ApiError(
      409,
      "email_registered",
      "That email already has an API key. Contact support to rotate or upgrade it.",
    );
  }

  const plaintext = newApiKey();
  const hash = await sha256Hex(plaintext);
  const id = newId("key");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO api_keys
       (id, email, label, key_hash, key_prefix, plan, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'free', 'active', ?)`,
  )
    .bind(id, email, "Self-serve signup", hash, plaintext.slice(0, 16), now)
    .run();
  await env.DB.prepare(
    "INSERT INTO signup_log (email, ip_hash, created_at) VALUES (?, ?, ?)",
  )
    .bind(email, ip, now)
    .run();

  return apiJson(
    {
      data: {
        key: plaintext,
        prefix: plaintext.slice(0, 16),
        email,
        plan: "free",
        monthlyLimit: API_FREE_MONTHLY_LIMIT,
        note: "Store this key now. It is hashed on our servers and cannot be shown again.",
      },
      links: { docs: "https://customs.vijayebhava.com/api-docs/" },
    },
    201,
  );
}

/* -------------------------------------------------------------- site api --- */

async function handleSite(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const client = siteClient(request);
  const meta = await loadMeta(env);

  if (url.pathname === "/api/site/meta" && request.method === "GET") {
    return siteJson({ data: publicMeta(meta) }, 200, client);
  }

  if (url.pathname === "/api/site/quota" && request.method === "GET") {
    return siteJson(
      { data: await siteQuotaSnapshot(env, client.id, meta) },
      200,
      client,
    );
  }

  if (url.pathname === "/api/site/search" && request.method === "GET") {
    const ip = await ipHash(request);
    await enforceRateLimit(
      env,
      `site-search:${client.id}`,
      300,
      3600,
      "Too many searches. Please try again in a little while.",
    );
    await enforceRateLimit(
      env,
      `site-search-ip:${ip}`,
      300,
      3600,
      "Too many searches from this connection. Please try again later.",
    );
    const results = await search(
      env,
      cleanQuery(url.searchParams.get("q")),
      parseLimit(url.searchParams.get("limit")),
    );
    return siteJson(
      {
        data: { query: url.searchParams.get("q"), results },
        meta: { count: results.length },
      },
      200,
      client,
    );
  }

  if (url.pathname.startsWith("/api/site/hsn/") && request.method === "GET") {
    const ip = await ipHash(request);
    await enforceRateLimit(
      env,
      `site-hsn-ip:${ip}`,
      600,
      3600,
      "Too many lookups from this connection. Please try again later.",
    );
    const code = decodeURIComponent(url.pathname.slice("/api/site/hsn/".length));
    const { record } = await findHsn(env, code);
    return siteJson(
      { data: { hsn: record.code, description: record.description } },
      200,
      client,
    );
  }

  if (url.pathname === "/api/site/quote" && request.method === "POST") {
    const ip = await ipHash(request);
    await enforceRateLimit(
      env,
      `site-quote-ip:${ip}`,
      SITE_IP_DAILY_LIMIT,
      86400,
      "Too many calculations from this connection today.",
    );

    const body = await readJsonBody(request);
    const valuation = valuationFromBody(body);
    const origin = resolveOrigin(meta, body.country);
    const { record, row, rates } = await findHsn(env, body.hsn);
    const ftaRate = ftaRateFor(meta, origin, rates);
    const quota = await reserveSiteQuota(env, client.id, meta);

    let result;
    try {
      result = computeDuty({ cif: valuation.assessableValue, row, ftaRate });
    } catch (err) {
      throw new ApiError(400, "calculation_failed", err.message || "Could not calculate duty.");
    }

    return siteJson(
      { data: buildQuoteData(result, origin, valuation, quota, meta) },
      200,
      client,
    );
  }

  if (url.pathname === "/api/site/notify" && request.method === "POST") {
    const ip = await ipHash(request);
    await enforceRateLimit(
      env,
      `notify:${ip}`,
      5,
      86400,
      "Too many signups from this address today.",
    );
    const body = await readJsonBody(request);
    const email = normaliseEmail(body.email);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO waitlist (email, source, created_at) VALUES (?, 'pricing', ?)
       ON CONFLICT(email) DO UPDATE SET created_at = excluded.created_at`,
    )
      .bind(email, now)
      .run();
    return siteJson(
      { data: { ok: true, message: "We'll write when the paid plan opens." } },
      201,
      client,
    );
  }

  throw new ApiError(404, "not_found", "No such site endpoint.");
}

/* ------------------------------------------------------------- admin api --- */

async function handleAdmin(request, env, url) {
  await adminAuth(request, env);
  const meta = await loadMeta(env);

  if (url.pathname === "/api/admin/stats" && request.method === "GET") {
    const period = istMonthKey();
    const today = istDayKey();
    const [keys, usage, signups, todaySignups] = await Promise.all([
      env.DB.prepare(
        "SELECT plan, status, COUNT(*) AS n FROM api_keys GROUP BY plan, status",
      ).all(),
      env.DB.prepare(
        "SELECT COALESCE(SUM(used), 0) AS calls, COUNT(*) AS active_keys FROM api_usage WHERE period = ?",
      ).bind(period).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM signup_log").first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM signup_log WHERE substr(created_at, 1, 10) = ?",
      ).bind(today).first(),
    ]);
    return json({
      data: {
        period,
        keys: keys.results || [],
        callsThisMonth: usage?.calls || 0,
        activeKeysThisMonth: usage?.active_keys || 0,
        signups: signups?.n || 0,
        signupsToday: todaySignups?.n || 0,
      },
    });
  }

  if (url.pathname === "/api/admin/keys" && request.method === "GET") {
    const email = url.searchParams.get("email");
    const period = istMonthKey();
    const sql = `
      SELECT k.id, k.email, k.label, k.key_prefix, k.plan, k.status,
             k.created_at, k.last_used_at, COALESCE(u.used, 0) AS used_month
        FROM api_keys k
        LEFT JOIN api_usage u ON u.key_id = k.id AND u.period = ?
       ${email ? "WHERE k.email = ?" : ""}
       ORDER BY k.created_at DESC
       LIMIT 100`;
    const statement = env.DB.prepare(sql);
    const bound = email ? statement.bind(period, email.toLowerCase()) : statement.bind(period);
    const { results } = await bound.all();
    return json({ data: { period, keys: results || [] } });
  }

  if (url.pathname === "/api/admin/create" && request.method === "POST") {
    const body = await readJsonBody(request);
    const email = normaliseEmail(body.email);
    const plan = body.plan === "paid" ? "paid" : "free";
    const exists = await env.DB.prepare(
      "SELECT id FROM api_keys WHERE email = ? LIMIT 1",
    )
      .bind(email)
      .first();
    if (exists) {
      throw new ApiError(409, "email_registered", "That email already has a key.");
    }
    const plaintext = newApiKey();
    const hash = await sha256Hex(plaintext);
    const id = newId("key");
    await env.DB.prepare(
      `INSERT INTO api_keys
         (id, email, label, key_hash, key_prefix, plan, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
      .bind(id, email, body.label || "Admin issued", hash, plaintext.slice(0, 16), plan, new Date().toISOString())
      .run();
    return json(
      { data: { key: plaintext, prefix: plaintext.slice(0, 16), email, plan } },
      201,
    );
  }

  if (url.pathname === "/api/admin/plan" && request.method === "POST") {
    const body = await readJsonBody(request);
    const plan = body.plan === "paid" ? "paid" : "free";
    const target = String(body.email || body.keyPrefix || "").trim();
    if (!target) {
      throw new ApiError(400, "invalid_target", "Send an email or keyPrefix.");
    }
    const result = body.email
      ? await env.DB.prepare(
        "UPDATE api_keys SET plan = ?, upgraded_at = ?, status = 'active' WHERE email = ?",
      ).bind(plan, new Date().toISOString(), target.toLowerCase()).run()
      : await env.DB.prepare(
        "UPDATE api_keys SET plan = ?, upgraded_at = ?, status = 'active' WHERE key_prefix = ?",
      ).bind(plan, new Date().toISOString(), target).run();
    if (!result.meta?.changes) {
      throw new ApiError(404, "key_not_found", "No key matched that email or prefix.");
    }
    return json({ data: { plan, updated: result.meta.changes } });
  }

  if (url.pathname === "/api/admin/revoke" && request.method === "POST") {
    const body = await readJsonBody(request);
    const id = String(body.id || "").trim();
    const prefix = String(body.keyPrefix || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!id && !prefix && !email) {
      throw new ApiError(400, "invalid_target", "Send an id, keyPrefix or email.");
    }
    let result;
    if (id) {
      result = await env.DB.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").bind(id).run();
    } else if (email) {
      result = await env.DB.prepare("UPDATE api_keys SET status = 'revoked' WHERE email = ?").bind(email).run();
    } else {
      result = await env.DB.prepare("UPDATE api_keys SET status = 'revoked' WHERE key_prefix = ?").bind(prefix).run();
    }
    if (!result.meta?.changes) {
      throw new ApiError(404, "key_not_found", "No key matched that id or prefix.");
    }
    return json({ data: { revoked: result.meta.changes } });
  }

  if (url.pathname === "/api/admin/rotate" && request.method === "POST") {
    const body = await readJsonBody(request);
    const email = normaliseEmail(body.email);
    const plaintext = newApiKey();
    const hash = await sha256Hex(plaintext);
    const result = await env.DB.prepare(
      `UPDATE api_keys
          SET key_hash = ?, key_prefix = ?, status = 'active', created_at = ?
        WHERE email = ?`,
    )
      .bind(hash, plaintext.slice(0, 16), new Date().toISOString(), email)
      .run();
    if (!result.meta?.changes) {
      throw new ApiError(404, "key_not_found", "No key matched that email.");
    }
    return json({
      data: {
        key: plaintext,
        prefix: plaintext.slice(0, 16),
        email,
        note: "The previous key stopped working immediately.",
      },
    });
  }

  throw new ApiError(404, "not_found", "No such admin endpoint.");
}

/* ------------------------------------------------------------- entrypoint --- */

const BLOCKED_PREFIXES = [
  "/data/",
  "/data-source/",
  "/scripts/",
  "/tests/",
  "/backend/",
  "/node_modules/",
  "/.git/",
  "/_worker.js",
  "/wrangler.toml",
  "/package.json",
  "/package-lock.json",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        return json({
          ok: true,
          service: "customs-calc",
          version: VERSION,
          database: Boolean(env.DB),
        });
      }
      if (path === "/api/v1" || path.startsWith("/api/v1/")) {
        return await handleV1(request, env, url, ctx);
      }
      if (path === "/api/site" || path.startsWith("/api/site/")) {
        return await handleSite(request, env, url);
      }
      if (path === "/api/admin" || path.startsWith("/api/admin/")) {
        return await handleAdmin(request, env, url);
      }
      if (path.startsWith("/api/")) {
        return apiJson(errorBody("not_found", "No such API endpoint."), 404);
      }
    } catch (err) {
      if (path.startsWith("/api/v1/")) return apiError(err);
      if (path.startsWith("/api/admin/")) {
        const status = err instanceof ApiError ? err.status : 500;
        return json(
          errorBody(err instanceof ApiError ? err.code : "internal_error", err.message),
          status,
        );
      }
      if (path.startsWith("/api/site/")) {
        const status = err instanceof ApiError ? err.status : 500;
        return json(
          errorBody(err instanceof ApiError ? err.code : "internal_error", err.message, err.extra || {}),
          status,
        );
      }
      throw err;
    }

    if (path === "/api-docs") {
      return Response.redirect(new URL("/api-docs/", url).toString(), 308);
    }

    for (const prefix of BLOCKED_PREFIXES) {
      if (path === prefix || path.startsWith(prefix)) return notFound();
    }
    if (/\.(sql|json|py|mjs?|toml|md)$/i.test(path) && !path.startsWith("/api-docs/")) {
      // Only documentation assets under /api-docs may be JSON; the tariff data
      // itself must never be fetchable as a static file.
      if (/^\/(data|data-source|scripts|tests|backend)\//.test(path)) return notFound();
    }

    return env.ASSETS.fetch(request);
  },
};
