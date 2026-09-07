-- 0002_notification_destination.sql
--
-- Generalises the notification target away from ntfy.
--
-- WHY: ntfy.sh meters anonymous publishing per source IP, and Cloudflare
-- Workers egress from shared IPs whose daily quota is routinely already spent
-- by other tenants, so production pushes returned 429. An ntfy access token
-- does not fix it either — ntfy's /v1/account reports `limits.basis = "ip"`
-- for free accounts, so metering stays on the IP. The transport therefore
-- becomes pluggable, with Telegram as the default provider.
--
-- `ntfy_topic` held an ntfy topic name; `destination` holds whatever the
-- configured provider addresses — a Telegram chat id, or an ntfy topic. Leaving
-- the column named after one provider while it holds another's identifier is
-- exactly the sort of thing that misleads later.
--
-- SQLite rewrites dependent indexes automatically on RENAME COLUMN, so
-- ux_subs_natural continues to cover the same logical key.

ALTER TABLE subscriptions RENAME COLUMN ntfy_topic TO destination;
