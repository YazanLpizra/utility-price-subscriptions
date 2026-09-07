-- 0003_notification_triggers.sql
--
-- Notifications become CONDITIONAL rather than daily.
--
-- WHY: a message every day is noise, and noise gets ignored — which defeats the
-- point of the tracker. But the two obvious alternatives are both broken:
--
--   * A fixed price threshold ("tell me under $4.00") requires guessing a number
--     nobody can pick sensibly before seeing a season of data.
--   * A per-day percentage move resets its comparison point every day, so five
--     consecutive 1% moves in the same direction are five non-events even though
--     the price has moved 5%.
--
-- The fix is a STICKY ANCHOR: compare against the price we last told the user
-- about, not against yesterday. The anchor only moves when a notification is
-- actually sent, so slow drift accumulates against it and eventually trips.
--
-- These columns store that anchor. `fingerprint` already encoded the price, but
-- parsing a composite key to recover a number is exactly the kind of fragility
-- this project has been removing, so the price gets its own column.

ALTER TABLE notifications ADD COLUMN price_per_gallon REAL;

-- Which trigger fired. Kept for history: it makes "why did I get this?"
-- answerable, and makes it possible to tune the triggers against real data
-- later instead of guessing again.
ALTER TABLE notifications ADD COLUMN reason TEXT;
