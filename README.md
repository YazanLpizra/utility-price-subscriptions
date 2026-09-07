# Heating Oil Price Tracker

A Cloudflare Worker that scrapes [cashheatingoil.com](https://www.cashheatingoil.com) once a
day for one or more zip codes, stores every dealer's cash/credit price tier in D1, and pushes a
Telegram message to each subscriber when a price qualifies for their order size. Full
requirements and rationale live in
[`docs/heating-oil-tracker-prd.md`](docs/heating-oil-tracker-prd.md); the phase-by-phase build
record is in [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Prerequisites

- Node.js 20+ (this project is developed and tested on 24.5.0).
- **No Cloudflare account is needed for local work.** Everything below — parsing, the database,
  the test suite — runs against a local D1 instance provided by `wrangler`'s miniflare runtime.
  A Cloudflare account is only needed for the deploy steps in [Deploying](#deploying-phase-9),
  which this repository's Phase 9 has already performed for the live instance.
- A project-local `.npmrc` already exists at the repo root (`script-shell=cmd.exe`,
  `legacy-peer-deps=true`) and is required on Windows for `npm install` to work at all. Do not
  edit or delete it.

## Local quickstart

Run each line separately — **do not chain these with `&&`**; this project is developed against
PowerShell 5.1, where `&&` is a parse error.

```
npm install
npm run fixture
npm run migrate:local
npm run seed:local
npm test
```

- `npm install` — installs the five devDependencies (wrangler, typescript, vitest, the Cloudflare
  vitest plugin, and `@cloudflare/workers-types`). Zero runtime dependencies.
- `npm run fixture` — de-wraps the saved view-source capture in `docs/` into
  `test/fixtures/06483.html` and prints structural counts plus a SHA-256.
- `npm run migrate:local` — applies both `migrations/0001_init.sql` and
  `migrations/0002_notification_destination.sql` to a local D1 instance under `.wrangler/state`.
  The second migration renames `subscriptions.ntfy_topic` to `subscriptions.destination`.
- `npm run seed:local` — applies `seeds/dev-seed.sql`: 4 zips, all inactive, and 2 subscriptions.
- `npm test` — runs the full Vitest suite (251 tests) against local D1 and HTMLRewriter, both the
  real workerd implementations via `@cloudflare/vitest-plugin`, not mocks.

> **This entire sequence is offline.** Every seeded zip has `active = 0` (see
> `seeds/dev-seed.sql`), and the cron producer only enqueues active zips. With the seed as
> committed, a local run enqueues nothing, so nothing reaches `cashheatingoil.com` or Telegram.
> You can run all five commands with the network unplugged and they will pass. That property is
> worth preserving — don't activate a zip in the committed seed.

You can verify the whole sequence non-interactively with `npm run smoke` (see
[`scripts/smoke-quickstart.mjs`](scripts/smoke-quickstart.mjs)), which runs it against a
throwaway D1 state and checks the seeded counts.

## ⚠️ Going live locally is an explicit opt-in

Activating a zip **will cause real outbound requests** the next time the scheduled handler runs
locally (see [Exercising the Worker locally](#exercising-the-worker-locally)):

```
node scripts/seed.mjs --activate 06483
```

Once `06483` is active, triggering the cron will POST to `cashheatingoil.com` (or GET its cached
slug) and, if a subscription qualifies, POST to the Telegram Bot API for whatever `destination`
(chat id) is in that subscription's row in D1. The committed seed uses `5551234567`, a placeholder
chat id — sending to it will fail (Telegram will reject it), which is harmless locally since no
`TELEGRAM_BOT_TOKEN` is configured by default anyway (see [Environment
variables](#environment-variables-env-srctypests)). Deactivate again with `node scripts/seed.mjs
--deactivate 06483` when you're done.

## Exercising the Worker locally

```
npx wrangler dev --test-scheduled --port 8787
```

In a second terminal, fire the cron:

```
curl "http://127.0.0.1:8787/__scheduled?cron=0+12+*+*+*"
```

**Verified against this project's pinned `wrangler@4.129.0`:** the correct endpoint is
`/__scheduled`, not `/cdn-cgi/local/scheduled` (nor `/cdn-cgi/handler/scheduled`, another
candidate seen in circulation). This was confirmed empirically by running `wrangler dev
--test-scheduled` and requesting both paths directly:

- `GET /__scheduled?cron=...` → `200 OK`, body `Ran scheduled event` — this is the real trigger;
  the response text is only produced once the Worker's `scheduled()` handler has actually run.
- `GET /cdn-cgi/handler/scheduled?cron=...` → `200 OK`, body `ok` — a different, generic miniflare
  stub route; it does **not** invoke `scheduled()`.
- Any other path with no `fetch()` export → `500`, `Error: Handler does not export a fetch()
  function.` (expected: this Worker only exports `scheduled` and `queue`).

Local **Queues consumers fire automatically** in miniflare: once the scheduled handler enqueues a
message, the `queue()` handler runs against it without any extra step, and its logs appear in the
same `wrangler dev` terminal.

## Inspecting local data

```
npx wrangler d1 execute heating-oil --local --command "SELECT scrape_date, zip, dealer_id, payment_type, gallon_min, gallon_max, price_per_gallon FROM prices WHERE scrape_date = date('now') ORDER BY zip, dealer_id, payment_type, gallon_min"

npx wrangler d1 execute heating-oil --local --command "SELECT zip, payment_type, gallon_min, gallon_max, price_per_gallon, dealer_id FROM prices WHERE scrape_date = (SELECT MAX(scrape_date) FROM prices) AND payment_type = 'cash' AND gallon_min <= 100 AND (gallon_max IS NULL OR gallon_max >= 100) ORDER BY price_per_gallon LIMIT 1"

npx wrangler d1 execute heating-oil --local --command "SELECT DISTINCT zip, dealer_id FROM prices ORDER BY zip, dealer_id"
```

The first shows today's rows for every zip; the second finds the cheapest cash price per gallon
for a 100-gallon order on the most recent scrape date (adjust `gallon_min`/`payment_type` for
other tiers); the third lists every distinct `(zip, dealer_id)` pair seen so far.

## Admin recipes

All admin operations go through `scripts/seed.mjs`, which validates every argument against a
strict grammar before issuing any SQL (see `node scripts/seed.mjs --help`):

```
node scripts/seed.mjs --add-zip 06611
node scripts/seed.mjs --activate 06611
node scripts/seed.mjs --deactivate 06611
node scripts/seed.mjs --add-sub 06483 123456789 100 cash
node scripts/seed.mjs --add-sub 06483 123456789 50 credit 5.50
```

- `--add-zip <zip>` — inserts a new zip, `active = 0` by default (never network-touching by
  itself). `<zip>` must be exactly 5 digits.
- `--activate <zip>` / `--deactivate <zip>` — flips `active` for a zip already in the table.
  Activating causes real fetches on the next scheduled run (local or deployed).
- `--add-sub <zip> <chat-id> <min_gallons> <cash|credit> [threshold]` — inserts or updates (by the
  natural key `user_id, zip, destination, payment_type, min_gallons`) a subscription. `<chat-id>`
  is a Telegram chat id and must match `^-?\d{1,20}$` (digits, optionally negative for groups and
  channels — see [Getting set up with Telegram](#getting-set-up-with-telegram) for how to find
  one); `<min_gallons>` a positive integer up to 100000; `[threshold]` is optional, a positive
  decimal with at most 2 decimal places.
- Every command accepts `--dry-run` (prints the SQL, touches nothing) and defaults to `--local`;
  `--remote` requires `CONFIRM_REMOTE=1` in the environment as a safety interlock.
- Running `node scripts/seed.mjs` with no flags re-applies `seeds/dev-seed.sql` (idempotent) and
  prints the resulting zip/active-zip/subscription counts.

## Architecture

```
cron (12:00 UTC, one trigger)
  -> scheduled(): reads active zips from D1, enqueues ONE Queues message per zip, exits
       -> Queues (heating-oil-scrape, max_batch_size: 1)
            -> queue(): one message at a time
                 -> fetchPricesPage(): cached slug, or POST + follow-redirect resolution
                 -> parseListingsPage(): HTMLRewriter state machine -> ParsedListing[]
                 -> writePriceRows(): D1 batch — DELETE the day's rows for this zip, then
                    chunked multi-row INSERT ... ON CONFLICT DO UPDATE (replace, not upsert)
                 -> evaluateSubscription() per active subscription for that zip
                 -> sendNotification() for every subscription whose decision says to send
```

**Why one zip per Queues message, rather than a loop over all zips in one invocation:** each
Worker invocation gets its own 10 ms CPU budget and its own 50-D1-query budget (PRD §9.1). A
serial loop over N zips inside a single cron handler would share *one* of each budget across all
N zips — the CPU budget in particular is consumed by HTMLRewriter parsing plus D1 round-trips, and
a handful of zips would already be enough to blow through 10 ms or 50 queries. Fanning out through
Queues (`max_batch_size: 1` in `wrangler.jsonc`) gives every zip a fresh invocation and therefore a
fresh budget, which is what makes the free tier's binding limits — CPU time and D1 queries per
invocation — irrelevant to how many zips this project tracks (PRD §5.1). See
`docs/implementation-plan.md` §2.4 and Phase 7 for the full accounting.

## Why Telegram, not ntfy

This project originally pushed notifications through [ntfy](https://ntfy.sh). That transport was
removed. ntfy.sh meters anonymous publishing **per source IP**, and Cloudflare Workers egress
from a shared pool of IPs whose daily quota is routinely already spent by other tenants — so
production pushes came back `429 Too Many Requests` while the identical payload succeeded
immediately from a home IP. An ntfy access token did **not** fix this: ntfy's `/v1/account`
endpoint reports `limits.basis = "ip"` for free accounts, so metering stays keyed to the IP
regardless of authentication. Telegram meters per bot token instead, which is exclusive to this
project, so the same Worker-to-shared-IP problem does not apply. This is recorded here so nobody
reintroduces ntfy expecting a token to be the missing piece — see `src/notify.ts` and
`migrations/0002_notification_destination.sql` for the same rationale in the code.

Messages are sent as an HTTP POST to `https://api.telegram.org/bot<TOKEN>/sendMessage` with a JSON
body of `{ chat_id, text, disable_notification }`, as plain text with **no** `parse_mode` — prices
contain `$`, `.` and `-`, all of which are MarkdownV2 metacharacters, and a formatting error would
turn into a silent `400` rather than a delivered message.

## Getting set up with Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the bot token it
   gives you.
2. Message the bot once, from the Telegram account (or group) that should receive alerts.
   Telegram will not reveal a chat id until the user initiates contact, and bots cannot message a
   user first — so this step cannot be skipped or automated.
3. Fetch `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser or with `curl` and read the
   chat id out of the JSON response (`result[0].message.chat.id`). That is the value passed to
   `--add-sub` and stored as `ALERT_DESTINATION`.

## Environment variables (`Env`, `src/types.ts`)

| Var | Committed default (`wrangler.jsonc`) | Must change before deploy? |
|---|---|---|
| `SITE_BASE_URL` | `https://www.cashheatingoil.com` | No |
| `STALE_AFTER_DAYS` | `"3"` | No |
| `USER_AGENT` | `heating-oil-tracker/1.0 (+personal price tracker)` | No |
| `NOTIFY_PROVIDER` | `"telegram"` | No — the only transport implemented; kept so a second provider could be added later |
| `DB` (`database_id` in `wrangler.jsonc`) | the live instance's real database id (set once, per Deploying below) | No, unless you point this project at a different D1 database |
| `SCRAPE_QUEUE` | binds to queue `heating-oil-scrape` | No, as long as the queue is created with that name |

Two more values are read from `Env` but are deliberately **not** in `wrangler.jsonc`'s `vars` —
they are Cloudflare **secrets**, set with `wrangler secret put`:

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot's API token. Grants full control of the bot. |
| `ALERT_DESTINATION` | The Telegram chat id that receives operational alerts (parse failures, fetch failures, etc.). |

## Security notes

- **`TELEGRAM_BOT_TOKEN` and `ALERT_DESTINATION` are secrets, never `vars`, and this matters
  mechanically, not just as a style preference.** A `vars` entry and a secret of the same name
  share the same binding namespace, and the `vars` entry **overwrites the secret on every
  deploy**. This actually happened during this project's development — a stray `vars` entry
  clobbered the secret, and `wrangler secret list` returned `[]` afterwards. Never add either name
  to `wrangler.jsonc`'s `vars`.
- **The bot token must never be logged.** It appears directly in the Telegram API request URL
  (`.../bot<TOKEN>/sendMessage`), so `src/notify.ts` deliberately logs only the response status
  and a short body excerpt on failure — never the request URL.
- **Subscriber destinations are never in any config file at all.** They live only in
  `subscriptions.destination` in D1 (renamed from `ntfy_topic` by
  `migrations/0002_notification_destination.sql`). The committed dev seed
  (`seeds/dev-seed.sql`) uses a placeholder chat id; real subscriber chat ids are inserted
  directly into the deployed database and nowhere else.
- Locally, `.dev.vars` (gitignored) can carry real values for `wrangler dev` if you want to test
  actual delivery; copy `.dev.vars.example` to `.dev.vars` to use it.

## Deploying (Phase 9)

The steps below are the deploy procedure — **they are performed by Phase 9, not by this
document**, and were already executed once for this project's live instance. The record of that
run is in `docs/deployment-log.md`, which is gitignored (it names the real alert chat id).

```
wrangler login
wrangler d1 create heating-oil
wrangler d1 migrations apply heating-oil --remote
wrangler queues create heating-oil-scrape
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ALERT_DESTINATION
wrangler deploy
```

After `wrangler d1 create`, paste the real `database_id` it prints into `wrangler.jsonc`'s
`d1_databases[0].database_id` — this is the one sanctioned cross-phase edit to that file (already
done for this project's live instance). `wrangler secret put TELEGRAM_BOT_TOKEN` takes the bot
token from @BotFather; `wrangler secret put ALERT_DESTINATION` takes the Telegram chat id that
should receive operational alerts (see [Getting set up with
Telegram](#getting-set-up-with-telegram)). Neither is ever written to `wrangler.jsonc` or to any
commit.

## Known limits (Cloudflare Workers free tier)

| Limit | Value |
|---|---|
| CPU time per invocation | 10 ms |
| D1 queries per invocation | 50 |
| Subrequests per invocation | 50 |
| Simultaneous outbound connections | 6 |
| `sendBatch()` max messages | 100 |

These are the binding constraints behind this project's design choices — one zip per Queues
message, multi-row INSERTs capped at 8 rows (88 of 100 bound parameters), and a
concurrency-limited notification fan-out. CPU time was the one figure that had never been measured
against production traffic; the original parser read price cells with HTMLRewriter text handlers
and measured **12–16 ms** in production — over the free-tier ceiling, though runs still completed
`outcome: ok`. The parser was optimised to read price cells with a plain string scan of the
response body instead of per-cell HTMLRewriter text handlers (HTMLRewriter's native tokenizer is
essentially free; the cost was the JS callback dispatched per text node). The production queue
consumer now measures **~10 ms**. See `docs/heating-oil-tracker-prd.md` §9 and
`docs/cpu-measurement.md` for the full measurement method, the profiling breakdown, and the
guidance to follow if CPU pressure returns.

## Troubleshooting

These map to the failure modes in `docs/heating-oil-tracker-prd.md` §8. Everything below shows up
as a message to whatever chat `ALERT_DESTINATION` resolves to (the secret in production; your
`.dev.vars` override, if set, locally) and as a `console.error` line in Workers Logs / the
`wrangler dev` terminal.

| Symptom | What it looks like on the alert chat | Likely cause |
|---|---|---|
| **Zero listings parsed** | `no listings for <zip>` — "the page parsed cleanly but contained zero listings. No rows written, no subscribers notified." | The results page loaded and is structurally valid HTML, but `div.boxlisting` count is zero for that zip today — e.g. no dealers currently list that zip. Not a crash; the day is simply skipped for that zip (PRD §8: a missing day beats a wrong one). |
| **`ParseError` from markup drift** | `zip <zip> failed` with a `ParseError: ...` message naming the listing index | The site's HTML structure changed in a way the state machine doesn't recognize (a missing `dealerid`, a duplicate tier, forms that no longer pair up as one cash + one credit, etc.). The message is acked, not retried — a parse error can't be fixed by trying again — so re-check the fixture and parser against the live markup. |
| **Fetch failure** | `zip <zip> failed` with a `FetchError: ...` message, `attempts` incrementing across retries | The POST/redirect resolution or the cached-slug GET failed (non-2xx, timeout, oversized body, or an SSRF-guard rejection). The zip's cached slug is cleared so tomorrow re-resolves from scratch, and the message is retried up to `max_retries: 3` before being dropped. |
| **Stale data** | Not an alert by itself — the Telegram notification body itself carries a stale banner | `price_updated_on` across a zip's listings has not advanced in more than `STALE_AFTER_DAYS` (default 3) relative to `scrape_date`. The subscriber is still notified (a stale price may be genuinely flat), just told it's stale. |
| **No active zips** | `no active zips` — "scrape_date=...: no active zips — nothing will be scraped." | The committed seed leaves every zip inactive; this fires every cron run until one is activated. Not a bug — it's the safety default (see the opt-in warning above). |
| **Cron producer failed** | `cron producer failed` with the underlying error | `getActiveZips` or `SCRAPE_QUEUE.sendBatch` threw. The cron invocation itself is rethrown after alerting, so it shows as a failed invocation in the dashboard too — this is the one path that is *not* swallowed. |
| **Telegram `401 Unauthorized`** | `[telegram] send rejected: status=401 ...` in Workers Logs | The bot token is wrong, revoked, or was pasted with leading/trailing whitespace or a newline (`wrangler secret put` reads stdin literally). Re-copy the token from @BotFather and re-run `wrangler secret put TELEGRAM_BOT_TOKEN`. |
| **Telegram `400 Bad Request`** | `[telegram] send rejected: status=400 ...` in Workers Logs | Usually a bad `chat_id` — malformed, or a chat the bot cannot message. A chat id is only obtainable after that user has messaged the bot at least once (see [Getting set up with Telegram](#getting-set-up-with-telegram)); if they haven't, Telegram has nothing to deliver to. |

## Accepted risks

Carried over from `docs/implementation-plan.md` §7 — these are deliberate, documented trade-offs,
not bugs:

- **Notification delivery is at-least-once.** Cloudflare Queues redelivers on retry, and the
  dedupe record in the `notifications` table is written only *after* a successful Telegram push
  (it has to be — recording first would permanently suppress a notification if the push then
  failed). A crash or D1 failure in the narrow window between a successful push and that write can
  cause a rare duplicate notification. Ordinary retries, aggregate-failure retries, and manual
  re-runs are all still deduplicated; only that narrow crash window is not.
- **There is no dead-letter queue.** `wrangler.jsonc` sets `max_retries: 3` with no
  `dead_letter_queue`. After three failed attempts a message is dropped and that zip has no data
  for the day. The compensating control is the Telegram alert pushed on every failed attempt, plus
  Cloudflare Workers Logs as the durable backstop, and tomorrow's cron retries from scratch. This
  is accepted as proportionate for a single-user personal tracker (see implementation plan
  assumptions A12 and A15).
