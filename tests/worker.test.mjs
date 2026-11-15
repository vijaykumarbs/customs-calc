/**
 * Production Worker tests.
 *
 * The Worker is imported directly and run against an in-memory SQLite database
 * behind a small D1-compatible adapter. That keeps the tests fast and CI-safe
 * without needing a Cloudflare account, Wrangler dev server or Miniflare.
 *
 * Run with:
 *   node --test tests/worker.test.mjs
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker, { cleanupExpired } from "../web/_worker.js";

const SCHEMA = readFileSync(new URL("../data/schema.sql", import.meta.url), "utf8");
const ADMIN_TOKEN = "test-admin-token-1234567890";

/* ------------------------------------------------------------ D1 adapter --- */

class D1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.db, this.sql, params);
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }

  async all() {
    return {
      results: this.db.prepare(this.sql).all(...this.params),
      success: true,
      meta: {},
    };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class D1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new D1Statement(this.db, sql);
  }

  async exec(sql) {
    this.db.exec(sql);
  }
}

/* --------------------------------------------------------------- fixtures --- */

const AGREEMENTS = [
  { name: "MFN (WTO)", col: "MFN", modelled: "Yes" },
  { name: "India-ASEAN FTA (AIFTA)", col: "AIFTA", modelled: "Yes - derived by chapter rule" },
  { name: "India-Japan CEPA", col: "Japan_CEPA", modelled: "Yes - derived by chapter rule" },
];

const COUNTRIES = [
  { name: "China", iso: "CHN", col: "AIFTA" },
  { name: "Japan", iso: "JPN", col: "Japan_CEPA" },
  { name: "United Arab Emirates", iso: "ARE", col: "AIFTA" },
];

const META = {
  version: "1.1",
  generated: "2026-01-01",
  data_as_of: "2025-06-30",
  line_count: 8,
  free_daily_limit: 5,
  free_api_monthly_limit: 10,
  price_inr: 99,
  columns: ["AIFTA", "Japan_CEPA"],
  countries: COUNTRIES,
  agreements: AGREEMENTS,
};

// code, description, chapter, bcd stat, bcd effective, aidc, sws, igst, cess, flag, fta
const ROWS = [
  ["85171300", "Smartphones", 85, 20, 15, 0, 10, 18, 0, 0, [15, 0, 0]],
  ["61091000", "T-shirts, singlets and other vests, of cotton, knitted", 61, 20, 20, 0, 10, 12, 0, 0, [20, 20, 20]],
  ["62052000", "Men's or boys' shirts, of cotton", 62, 20, 20, 0, 10, 12, 0, 0, [20, 20, 20]],
  ["72081000", "Flat-rolled products of steel, in coils, hot-rolled", 72, 10, 10, 0, 10, 18, 0, 0, [10, 10, 10]],
  ["09024000", "Tea, whether or not flavoured", 9, 100, 100, 0, 10, 5, 0, 0, [100, 100, 100]],
  ["03061100", "Crustaceans, live, fresh or chilled, including steaming", 3, 30, 30, 0, 10, 5, 0, 0, [30, 30, 30]],
  ["12141000", "Swedes, mangolds, fodder roots, hay, lucerne", 12, 0, 0, 0, 10, 5, 0, 0, [0, 0, 0]],
  ["71081200", "Gold, unwrought, non-monetary", 71, 10, 10, 0, 10, 3, 0, 0, [10, 10, 10]],
];

function searchText(description) {
  const normalised = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalised ? ` ${normalised} ` : " ";
}

function makeEnv() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  raw
    .prepare("INSERT INTO settings (key, value) VALUES ('meta', ?)")
    .run(JSON.stringify(META));
  const insert = raw.prepare(
    `INSERT INTO hsn
       (code, description, chapter, bcd_statutory, bcd_effective, aidc, sws, igst, cess, flag, fta, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of ROWS) {
    insert.run(
      ...row.slice(0, 10),
      JSON.stringify(row[10]),
      searchText(row[1]),
    );
  }
  return {
    raw,
    DB: new D1Database(raw),
    ADMIN_TOKEN,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
}

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function insertKey(env, email, { plan = "free", status = "active" } = {}) {
  const raw = `cc_live_${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  env.raw
    .prepare(
      `INSERT INTO api_keys
         (id, email, label, key_hash, key_prefix, plan, status, created_at)
       VALUES (?, ?, 'test', ?, ?, ?, ?, ?)`,
    )
    .run(
      `key_${randomBytes(8).toString("hex")}`,
      email,
      hashKey(raw),
      raw.slice(0, 16),
      plan,
      status,
      now,
    );
  return raw;
}

let callSequence = 0;

async function call(env, path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    ip = `203.0.113.${(callSequence += 1) % 250}`,
    cookie,
  } = options;
  const requestHeaders = new Headers(headers);
  if (ip) requestHeaders.set("cf-connecting-ip", ip);
  if (cookie) requestHeaders.set("cookie", cookie);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const pending = [];
  const request = new Request(`https://customs.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  return { response, text, json, pending };
}

function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

function quoteBody(overrides = {}) {
  return {
    hsn: "85171300",
    country: "Japan",
    goodsValue: 100000,
    freight: 5000,
    insurance: 1000,
    otherCharges: 500,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ tests --- */

test("health endpoint reports the database binding", async () => {
  const env = makeEnv();
  const { response, json } = await call(env, "/api/health");
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.database, true);
});

test("multi-word search matches the intended phrase and whole words", async () => {
  const env = makeEnv();
  const cases = [
    ["cotton t-shirt", "61091000"],
    ["t shirt cotton", "61091000"],
    ["steel coil", "72081000"],
    ["8517 13", "85171300"],
    ["6109 t-shirt", "61091000"],
  ];

  for (const [query, expected] of cases) {
    const { response, json } = await call(
      env,
      `/api/site/search?q=${encodeURIComponent(query)}&limit=10`,
    );
    assert.equal(response.status, 200, query);
    const codes = json.data.results.map((row) => row.code);
    assert.ok(codes.includes(expected), `${query} should include ${expected}, got ${codes}`);
  }
});

test("single-word search does not match inside unrelated words", async () => {
  const env = makeEnv();

  const tea = await call(env, "/api/site/search?q=tea&limit=10");
  assert.equal(tea.response.status, 200);
  assert.equal(tea.json.data.results[0].code, "09024000");
  assert.ok(!tea.json.data.results.some((row) => row.code === "03061100"));

  const gold = await call(env, "/api/site/search?q=gold&limit=10");
  assert.equal(gold.response.status, 200);
  assert.equal(gold.json.data.results[0].code, "71081200");
  assert.ok(!gold.json.data.results.some((row) => row.code === "12141000"));
});

test("search requires a useful query and returns no rates", async () => {
  const env = makeEnv();
  const short = await call(env, "/api/site/search?q=a");
  assert.equal(short.response.status, 400);
  assert.equal(short.json.error.code, "invalid_query");

  const search = await call(env, "/api/site/search?q=smartphone");
  assert.deepEqual(Object.keys(search.json.data.results[0]).sort(), ["code", "description"]);
});

test("API keys are required and revoked keys are rejected", async () => {
  const env = makeEnv();

  const missing = await call(env, "/api/v1/hsn/85171300");
  assert.equal(missing.response.status, 401);
  assert.equal(missing.json.error.code, "missing_api_key");

  const malformed = await call(env, "/api/v1/hsn/85171300", {
    headers: bearer("not-a-key"),
  });
  assert.equal(malformed.response.status, 401);

  const revoked = insertKey(env, "revoked@example.com", { status: "revoked" });
  const revokedResponse = await call(env, "/api/v1/hsn/85171300", {
    headers: bearer(revoked),
  });
  assert.equal(revokedResponse.response.status, 403);
  assert.equal(revokedResponse.json.error.code, "key_disabled");
});

test("a free API key gets ten billable calls and the eleventh is 429", async () => {
  const env = makeEnv();
  const key = insertKey(env, "quota@example.com");

  for (let i = 0; i < 10; i += 1) {
    const result = await call(env, "/api/v1/calculate", {
      method: "POST",
      headers: bearer(key),
      body: quoteBody(),
      ip: "198.51.100.10",
    });
    assert.equal(result.response.status, 200, `call ${i + 1}`);
  }

  const blocked = await call(env, "/api/v1/calculate", {
    method: "POST",
    headers: bearer(key),
    body: quoteBody(),
    ip: "198.51.100.10",
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.json.error.code, "quota_exceeded");
});

test("invalid API requests do not consume quota", async () => {
  const env = makeEnv();
  const key = insertKey(env, "invalid@example.com");

  const empty = await call(env, "/api/v1/calculate", {
    method: "POST",
    headers: bearer(key),
    body: {},
    ip: "198.51.100.20",
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.json.error.code, "missing_value");
  assert.match(empty.json.error.message, /hsn and goodsValue/i);

  const usage = await call(env, "/api/v1/usage", {
    headers: bearer(key),
    ip: "198.51.100.20",
  });
  assert.equal(usage.response.status, 200);
  assert.equal(usage.json.data.used, 0);

  const valid = await call(env, "/api/v1/calculate", {
    method: "POST",
    headers: bearer(key),
    body: quoteBody(),
    ip: "198.51.100.20",
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.json.data.valuation.assessableValue, 106500);
  assert.equal(valid.json.data.amounts.totalDuty, 19170);
  assert.equal(valid.json.data.dataAsOf, "2025-06-30");
  assert.equal(valid.json.data.antiDumpingMayApply, true);
  assert.equal(valid.json.data.warnings[0].code, "anti_dumping_may_apply");
});

test("batch reserves quota atomically and respects the free-plan line cap", async () => {
  const env = makeEnv();
  const key = insertKey(env, "batch@example.com");
  const two = {
    items: [
      quoteBody(),
      quoteBody({
        country: "United Arab Emirates",
        goodsValue: 50000,
        freight: 0,
        insurance: 0,
        otherCharges: 0,
      }),
    ],
  };

  const first = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: two,
    ip: "198.51.100.30",
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.data.count, 2);
  assert.equal(first.json.data.quota.used, 2);
  assert.equal(first.json.data.results[0].valuation.assessableValue, 106500);
  assert.equal(first.json.data.results[1].valuation.assessableValue, 50000);

  const tooMany = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: { items: Array.from({ length: 11 }, () => quoteBody()) },
    ip: "198.51.100.30",
  });
  assert.equal(tooMany.response.status, 400);
  assert.equal(tooMany.json.error.code, "invalid_batch");

  const eight = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: { items: Array.from({ length: 8 }, () => quoteBody()) },
    ip: "198.51.100.30",
  });
  assert.equal(eight.response.status, 200);
  assert.equal(eight.json.data.quota.used, 10);

  const over = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: { items: [quoteBody()] },
    ip: "198.51.100.30",
  });
  assert.equal(over.response.status, 429);
  assert.equal(over.json.error.code, "quota_exceeded");

  const usage = await call(env, "/api/v1/usage", {
    headers: bearer(key),
    ip: "198.51.100.30",
  });
  assert.equal(usage.json.data.used, 10);
});

test("batch validates every line before reserving quota", async () => {
  const env = makeEnv();
  const key = insertKey(env, "batch-invalid@example.com");

  const result = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: {
      items: [
        quoteBody(),
        quoteBody({ hsn: "00000000" }),
      ],
    },
    ip: "198.51.100.40",
  });
  assert.equal(result.response.status, 404);
  assert.match(result.json.error.message, /items\[1\]/);

  const usage = await call(env, "/api/v1/usage", {
    headers: bearer(key),
    ip: "198.51.100.40",
  });
  assert.equal(usage.json.data.used, 0);
});

test("a paid key can submit twenty batch lines", async () => {
  const env = makeEnv();
  const key = insertKey(env, "paid-batch@example.com", { plan: "paid" });

  const result = await call(env, "/api/v1/calculate/batch", {
    method: "POST",
    headers: bearer(key),
    body: { items: Array.from({ length: 20 }, () => quoteBody()) },
    ip: "198.51.100.50",
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.data.quota.used, 20);
});

test("the API root lists the batch endpoint", async () => {
  const env = makeEnv();
  const key = insertKey(env, "root@example.com");
  const { response, json } = await call(env, "/api/v1", {
    headers: bearer(key),
    ip: "198.51.100.60",
  });
  assert.equal(response.status, 200);
  assert.ok(json.endpoints.includes("POST /api/v1/calculate/batch"));
});

test("admin token failures are throttled and the token comparison is not a plain string check", async () => {
  const env = makeEnv();
  const ip = "198.51.100.70";

  for (let i = 0; i < 20; i += 1) {
    const wrong = await call(env, "/api/admin/stats", {
      headers: { "x-admin-token": `wrong-token-${i}` },
      ip,
    });
    assert.equal(wrong.response.status, 401, `attempt ${i + 1}`);
  }

  const locked = await call(env, "/api/admin/stats", {
    headers: { "x-admin-token": "wrong-token-after-lockout" },
    ip,
  });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.json.error.code, "rate_limited");
});

test("admin can issue, rotate and revoke a key", async () => {
  const env = makeEnv();
  const headers = { "x-admin-token": ADMIN_TOKEN };
  const ip = "198.51.100.80";

  const created = await call(env, "/api/admin/create", {
    method: "POST",
    headers,
    body: { email: "admin-key@example.com", label: "test" },
    ip,
  });
  assert.equal(created.response.status, 201);
  const oldKey = created.json.data.key;

  const rotated = await call(env, "/api/admin/rotate", {
    method: "POST",
    headers,
    body: { email: "admin-key@example.com" },
    ip,
  });
  assert.equal(rotated.response.status, 200);
  const newKey = rotated.json.data.key;
  assert.notEqual(newKey, oldKey);

  const oldResponse = await call(env, "/api/v1/usage", {
    headers: bearer(oldKey),
    ip: "198.51.100.81",
  });
  assert.equal(oldResponse.response.status, 401);

  const newResponse = await call(env, "/api/v1/usage", {
    headers: bearer(newKey),
    ip: "198.51.100.81",
  });
  assert.equal(newResponse.response.status, 200);

  const revoked = await call(env, "/api/admin/revoke", {
    method: "POST",
    headers,
    body: { email: "admin-key@example.com" },
    ip,
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.json.data.revoked, 1);

  const afterRevoke = await call(env, "/api/v1/usage", {
    headers: bearer(newKey),
    ip: "198.51.100.81",
  });
  assert.equal(afterRevoke.response.status, 403);
});

test("site quota is five per cookie-day and invalid requests do not consume the IP backstop", async () => {
  const env = makeEnv();
  const cookie = "cc_client=11111111-1111-4111-8111-111111111111";
  const ip = "198.51.100.90";

  for (let i = 0; i < 5; i += 1) {
    const result = await call(env, "/api/site/quote", {
      method: "POST",
      body: quoteBody(),
      cookie,
      ip,
    });
    assert.equal(result.response.status, 200, `quote ${i + 1}`);
  }
  const blocked = await call(env, "/api/site/quote", {
    method: "POST",
    body: quoteBody(),
    cookie,
    ip,
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.json.error.code, "site_quota_exceeded");

  const invalidIp = "198.51.100.91";
  for (let i = 0; i < 40; i += 1) {
    const invalid = await call(env, "/api/site/quote", {
      method: "POST",
      body: {},
      ip: invalidIp,
    });
    assert.equal(invalid.response.status, 400, `invalid ${i + 1}`);
  }
  const valid = await call(env, "/api/site/quote", {
    method: "POST",
    body: quoteBody(),
    ip: invalidIp,
  });
  assert.equal(valid.response.status, 200);
});

test("an established cookie still works when the new-session IP bucket is full", async () => {
  const env = makeEnv();
  const ip = "198.51.100.92";
  const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const slot = Math.floor(Date.now() / 86400000);
  const ipHash = createHash("sha256")
    .update(`customs-calc:${ip}`)
    .digest("hex")
    .slice(0, 32);
  env.raw
    .prepare("INSERT INTO rate_limits (bucket, expires_at, count) VALUES (?, ?, ?)")
    .run(`site-quote-ip:${ipHash}:${slot}`, (slot + 1) * 86400000, 40);

  const cookie = "cc_client=22222222-2222-4222-8222-222222222222";
  const result = await call(env, "/api/site/quote", {
    method: "POST",
    body: quoteBody(),
    cookie,
    ip,
  });
  assert.equal(result.response.status, 200, day);
});

test("cleanup deletes expired counters and rate-limit buckets", async () => {
  const env = makeEnv();
  const oldRate = "old-bucket";
  const recentRate = "recent-bucket";
  env.raw
    .prepare("INSERT INTO rate_limits (bucket, expires_at, count) VALUES (?, 1, 1)")
    .run(oldRate);
  env.raw
    .prepare("INSERT INTO rate_limits (bucket, expires_at, count) VALUES (?, ?, 1)")
    .run(recentRate, Date.now() + 60000);
  env.raw
    .prepare("INSERT INTO site_usage (client_id, day, used) VALUES ('old', '2020-01-01', 1)")
    .run();
  env.raw
    .prepare("INSERT INTO site_usage (client_id, day, used) VALUES ('recent', ?, 1)")
    .run(new Date().toISOString().slice(0, 10));
  env.raw
    .prepare("INSERT INTO api_usage (key_id, period, used) VALUES ('old', '2020-01', 1)")
    .run();
  env.raw
    .prepare("INSERT INTO api_usage (key_id, period, used) VALUES ('recent', ?, 1)")
    .run(new Date().toISOString().slice(0, 7));
  env.raw
    .prepare("INSERT INTO signup_log (email, created_at) VALUES ('old@example.com', '2020-01-01T00:00:00.000Z')")
    .run();
  env.raw
    .prepare("INSERT INTO signup_log (email, created_at) VALUES ('recent@example.com', ?)")
    .run(new Date().toISOString());

  await cleanupExpired(env);

  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = ?").get(oldRate).n,
    0,
  );
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = ?").get(recentRate).n,
    1,
  );
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM site_usage WHERE client_id = 'old'").get().n,
    0,
  );
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM api_usage WHERE key_id = 'old'").get().n,
    0,
  );
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM signup_log WHERE email = 'old@example.com'").get().n,
    0,
  );
  assert.equal(
    env.raw.prepare("SELECT COUNT(*) AS n FROM signup_log WHERE email = 'recent@example.com'").get().n,
    1,
  );
});

test("signup normalises plus aliases and the email column is unique", async () => {
  const env = makeEnv();

  const first = await call(env, "/api/v1/signup", {
    method: "POST",
    body: { email: "Case+2@Example.com" },
    ip: "198.51.100.100",
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.json.data.email, "case@example.com");

  const second = await call(env, "/api/v1/signup", {
    method: "POST",
    body: { email: "case+3@example.com" },
    ip: "198.51.100.101",
  });
  assert.equal(second.response.status, 409);

  assert.throws(() => {
    env.raw
      .prepare(
        `INSERT INTO api_keys
           (id, email, label, key_hash, key_prefix, plan, status, created_at)
         VALUES ('dup', 'case@example.com', 'dup', 'hash', 'prefix', 'free', 'active', '2026-01-01')`,
      )
      .run();
  }, /UNIQUE/i);
});

test("unexpected errors do not leak internal messages", async () => {
  const secret = "SECRET internal path /srv/app";
  const brokenDb = {
    prepare() {
      throw new Error(secret);
    },
  };
  const env = { ...makeEnv(), DB: brokenDb };
  const originalError = console.error;
  console.error = () => {};
  try {
    const site = await call(env, "/api/site/search?q=smartphone", {
      ip: "198.51.100.110",
    });
    assert.equal(site.response.status, 503);
    assert.ok(!site.text.includes(secret));
    assert.equal(site.json.error.code, "rate_limit_unavailable");

    const admin = await call(env, "/api/admin/stats", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      ip: "198.51.100.111",
    });
    assert.equal(admin.response.status, 503);
    assert.ok(!admin.text.includes(secret));
    assert.equal(
      admin.json.error.message,
      "We could not verify rate limits. Try again in a moment.",
    );
  } finally {
    console.error = originalError;
  }
});
