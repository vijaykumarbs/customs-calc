-- CustomsCalc D1 schema.
--
-- Apply once per database, then load data with data/seed.sql. Both statements
-- are idempotent, so they are safe to re-run after a data refresh.
--
--   npx wrangler d1 execute customs-calc --remote --file=data/schema.sql
--   npx wrangler d1 execute customs-calc --remote --file=data/seed.sql

CREATE TABLE IF NOT EXISTS hsn (
  code           TEXT PRIMARY KEY,
  description    TEXT NOT NULL,
  chapter        INTEGER NOT NULL,
  bcd_statutory  REAL NOT NULL,
  bcd_effective  REAL NOT NULL,
  aidc           REAL NOT NULL,
  sws            REAL NOT NULL,
  igst           REAL NOT NULL,
  cess           REAL NOT NULL,
  flag           INTEGER NOT NULL,
  fta            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hsn_chapter ON hsn (chapter);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  label        TEXT,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  upgraded_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys (email);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS api_usage (
  key_id  TEXT NOT NULL,
  period  TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, period)
);

CREATE TABLE IF NOT EXISTS site_usage (
  client_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  source     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signup_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  ip_hash    TEXT,
  created_at TEXT NOT NULL
);
