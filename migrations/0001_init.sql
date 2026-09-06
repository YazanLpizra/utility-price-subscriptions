-- 0001_init.sql — PRD §6. Multi-tenant, multi-zip from day one.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS zips (
  zip              TEXT PRIMARY KEY CHECK (zip GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  slug             TEXT,
  city             TEXT,
  state            TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  slug_resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS prices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_date       TEXT    NOT NULL
                      CHECK (scrape_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  zip               TEXT    NOT NULL REFERENCES zips(zip)
                      CHECK (zip GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  dealer_id         INTEGER NOT NULL CHECK (dealer_id > 0),
  payment_type      TEXT    NOT NULL CHECK (payment_type IN ('cash','credit')),
  gallon_min        INTEGER NOT NULL CHECK (gallon_min > 0),
  gallon_max        INTEGER CHECK (gallon_max IS NULL OR gallon_max >= gallon_min),
  price_per_gallon  REAL    NOT NULL CHECK (price_per_gallon > 0),
  delivery_date     TEXT
                      CHECK (delivery_date IS NULL OR
                             delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  price_updated_on  TEXT
                      CHECK (price_updated_on IS NULL OR
                             price_updated_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  same_day_charge   REAL,
  scraped_at        TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prices_day
  ON prices (scrape_date, zip, dealer_id, payment_type, gallon_min);

CREATE INDEX IF NOT EXISTS ix_prices_zip_date  ON prices (zip, scrape_date);
CREATE INDEX IF NOT EXISTS ix_prices_dealer    ON prices (zip, dealer_id, scrape_date);

CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  zip          TEXT    NOT NULL REFERENCES zips(zip)
                 CHECK (zip GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  ntfy_topic   TEXT    NOT NULL,
  min_gallons  INTEGER NOT NULL CHECK (min_gallons > 0),
  payment_type TEXT    NOT NULL CHECK (payment_type IN ('cash','credit')),
  threshold    REAL    CHECK (threshold IS NULL OR threshold > 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE INDEX IF NOT EXISTS ix_subs_zip_active ON subscriptions (zip, active);

-- Natural key, so seeding and admin inserts are genuinely idempotent rather than
-- appending a duplicate subscription on every run.
CREATE UNIQUE INDEX IF NOT EXISTS ux_subs_natural
  ON subscriptions (user_id, zip, ntfy_topic, payment_type, min_gallons);

-- Notification de-duplication. D1 writes are idempotent, but an ntfy push is not, and
-- Queues delivery is at-least-once: a retry after a *successful* push would otherwise
-- notify the phone twice for the same day. One row per (day, subscription) is the guard.
CREATE TABLE IF NOT EXISTS notifications (
  scrape_date     TEXT    NOT NULL,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  fingerprint     TEXT    NOT NULL,
  sent_at         TEXT    NOT NULL,
  PRIMARY KEY (scrape_date, subscription_id)
);
