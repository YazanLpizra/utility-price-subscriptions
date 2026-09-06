-- dev-seed.sql — local development seed. Idempotent: safe to run repeatedly.
--
-- SAFETY: every zip is seeded INACTIVE (active = 0). The cron producer only
-- enqueues active zips, so with this seed a local run enqueues nothing, and
-- nothing can reach cashheatingoil.com or ntfy.sh by accident. Activating a zip
-- is an explicit opt-in:
--
--     node scripts/seed.mjs --activate 06483
--
-- and doing so locally WILL cause real outbound requests on the next run.
--
-- The ntfy topic below is a placeholder. On unauthenticated ntfy the topic name
-- IS the credential, so real topics never live in a committed file — they are
-- inserted into the deployed database at deploy time.

-- Zips. 06483 (Seymour CT) is the launch zip; the other three exercise the
-- multi-zip path and come from PRD §4.1. slug is NULL so the first run has to
-- resolve it through the POST path.
INSERT INTO zips (zip, slug, city, state, active, slug_resolved_at)
VALUES
  ('06483', NULL, NULL, NULL, 0, NULL),
  ('06611', NULL, NULL, NULL, 0, NULL),
  ('11530', NULL, NULL, NULL, 0, NULL),
  ('08540', NULL, NULL, NULL, 0, NULL)
ON CONFLICT (zip) DO UPDATE SET
  active = excluded.active;

-- Subscriptions. Fixed ids so re-seeding updates rather than appends.
--
-- Both thresholds are NULL deliberately. An earlier draft gave the 50-gallon
-- row a threshold of 5.50, but the best qualifying 50-gallon price on the
-- fixture day is $5.64 — so Phase 5 would have correctly suppressed it while
-- the orchestration test expected it to send. Correct code would have failed.
INSERT INTO subscriptions
  (id, user_id, zip, ntfy_topic, min_gallons, payment_type, threshold, active)
VALUES
  (1, 'v1', '06483', 'heating-oil-local-dev', 100, 'cash', NULL, 1),
  (2, 'v1', '06483', 'heating-oil-local-dev',  50, 'cash', NULL, 1)
ON CONFLICT (id) DO UPDATE SET
  user_id      = excluded.user_id,
  zip          = excluded.zip,
  ntfy_topic   = excluded.ntfy_topic,
  min_gallons  = excluded.min_gallons,
  payment_type = excluded.payment_type,
  threshold    = excluded.threshold,
  active       = excluded.active;
