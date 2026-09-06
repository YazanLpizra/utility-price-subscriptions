# PRD: Heating Oil Price Tracker

**Owner:** Yazan
**Status:** Draft — recon complete, free-tier capacity confirmed (§9), ready for build
**Launch zip:** 06483 (Seymour, CT), with a multi-zip schema from day one

---

## 1. Problem

Heating oil is a volatile, cash-purchase commodity. Prices from local COD dealers move daily, and there's no easy way to know whether today is a good day to buy without manually checking a comparison site. The goal is to build a passive daily signal so that buying decisions are informed by trend rather than by whichever day the tank runs low.

## 2. Goals

- Capture heating oil prices for a set of subscribed zip codes once per day, automatically.
- Push the cheapest price relevant to each subscriber's own terms (minimum gallons, payment method) to their Android phone.
- Accumulate historical pricing data from day one, so trend analysis can be built later without backfilling.
- Detect and surface stale data, so an unchanged price is never reported as if it were fresh.

## 3. Non-Goals

- Ordering oil. The site requires a separate form submission (`tranction.php`) with name, address, and payment details, after which a dealer reaches out. This app does not touch that flow.
- A multi-user front end. v1 runs for a single subscriber, but the schema is multi-tenant from the start — see §6. Retrofitting a `user_id` onto months of accumulated rows is the expensive path, so it is paid for up front.
- Any trend UI, charting, or price-drop prediction. Data collection only — the analysis layer is a possible v2.
- Self-service zip onboarding. Zips are added by hand in v1.

## 4. Recon Findings

Recon was performed against the live site on 2026-09-06 and against a saved copy of the 06483 results page from 2026-09-05. All four open items from the previous draft are resolved.

### 4.1 The zip lookup is a POST that redirects to a generated slug

The homepage form is:

```
POST https://www.cashheatingoil.com/cod_oil_prices.php
txtzipcode=06483&btnsubmit=Continue
```

The server responds `302` with a `Location` of `https://www.cashheatingoil.com/seymour_ct_oil_prices/06483` and sets a `PHPSESSID` cookie. The slug follows the pattern `{city}_{state}_oil_prices/{zip}`, confirmed across four zips:

| zip | resolved slug URL |
|---|---|
| 06483 | `/seymour_ct_oil_prices/06483` |
| 06611 | `/trumbull_ct_oil_prices/06611` |
| 11530 | `/garden_city_ny_oil_prices/11530` |
| 08540 | `/princeton_nj_oil_prices/08540` |

**The Worker does not need to derive the slug.** It POSTs the zip and follows the redirect. This removes what would otherwise have been the main obstacle to multi-zip support.

Additionally, a cold `GET` of a slug URL with **no session cookie** returns the full results page. So a slug, once resolved, can be cached and fetched directly on subsequent days, with the POST reserved for first-time resolution and for recovery when a cached slug starts failing.

### 4.2 Results are server-rendered static HTML

The page's only scripts are jQuery 1.6.4 and Google AdSense. Every price is present in the initial HTML response. **A static HTML parser is sufficient**; no browser-rendering service is needed. (Which parser — HTMLRewriter rather than Cheerio — is settled on free-tier CPU grounds in §9.2, not on rendering grounds.)

### 4.3 The results are not a flat table of dealers

Each result is a `div.boxlisting` containing two price tables — one **cash**, one **credit** — and each table is broken into **gallon-quantity tiers**. For 06483 on 2026-09-05:

| # | dealerid | delivery date | cash tiers |
|---|---|---|---|
| 1 | 11 | Sep 8 | 100-149 $4.84, 150-199 $4.84, 200-299 $4.84, 300-399 $4.84 |
| 2 | 372 | Sep 9 | 50-99 **$5.64**, 100-149 $4.84, 150-199 $4.84, 200-299 $4.84, 300-399 $4.84 |
| 3 | 744 | Sep 7 | 50-99 **$6.00**, 100-149 $4.84, 150-199 $4.84, 200-299 $4.84, 300-399 $4.84 |
| 4 | 345 | Sep 9 | 150-199 $5.19, 200-299 $5.19, 300-399 $5.19 |
| 5 | 919 | Sep 9 | 150-199 $5.19, 200-299 $5.19, 300-399 $5.19 |

Credit pricing runs $0.10 above cash for dealers 11, 372, and 744, and equal to cash for 345 and 919. Five listings expand to roughly 44 individual price points.

Each listing also carries: delivery date, "Price Updated on" date, same-day charges, and a ratings link (`feedback.php?id=...`).

### 4.4 Listing counts are small and vary by zip

06483 returns **5** listings. Spot checks: 06611 returns 6, 11530 returns 3, 08540 returns 2.

**The "ten cheapest" rule from the previous draft is unworkable** — no sampled zip returns ten listings. It is replaced by "store every price point returned," which is a smaller volume than the original design anyway.

### 4.5 Dealer identity is available after all

The previous draft's central constraint was that dealer identity is unavailable, making cross-day matching impossible. This is **half true and half false**.

The dealer *name* is genuinely hidden — every listing renders `Dealer Name: Available Upon Ordering`, and the name is only disclosed after an order is placed. But each listing's order form carries a hidden `dealerid`:

```html
<input type="hidden" name="listingid" value="xnSdzN5"/>
<input type="hidden" name="dealerid" value="11"/>
<input type="hidden" name="enumtype" value="Cash"/>
<input type="hidden" name="earlistdate" value="2026-09-08" />
```

`dealerid` is a stable numeric identity — the same five ids (11, 345, 372, 744, 919) appeared in both the 2026-09-05 saved page and the 2026-09-06 live fetch.

`listingid` is **not** an identity. It is identical across all five listings within one response and changed between the two fetches (`t2YqEch` → `xnSdzN5`), making it a per-request search token. Do not store it as a key.

**Consequence:** true per-dealer time series are possible, which is a strictly better v2 than distribution-only analysis. The positional `rank` column and the "rank is not identity" caveat are both removed from the data model.

**Caveat:** the two observations above are one day apart and prices did not move between them (both still read "Price Updated on Sep 5th"), so `dealerid` stability is demonstrated across sessions but not yet across a genuine price change. Treat `dealerid` as the working identity key, but verify it holds once a week or two of real data has accumulated. Nothing in the schema breaks if it turns out to drift — the `(scrape_date, zip, dealer_id, ...)` key still stores the data correctly; only the per-dealer trend interpretation would be invalidated.

## 5. Functional Requirements

### 5.1 Scheduled scrape

A Cloudflare Worker runs on a daily cron trigger. The cron handler does **not** scrape. It reads the active rows in `zips` and enqueues one Queues message per zip, then exits. A queue consumer processes each message and, for each zip:

1. Resolves the results URL — uses the cached `slug` if present, otherwise POSTs `txtzipcode` to `cod_oil_prices.php`, follows the 302, and writes the resolved slug back to `zips`.
2. Fetches the results page and parses it with **HTMLRewriter** (not Cheerio — see §7 and §9.2).
3. Extracts, for every `div.boxlisting`: `dealerid`, delivery date, price-updated date, same-day charge, and every `(payment_type, gallon_min, gallon_max, price_per_gallon)` tuple from both the cash and credit tables.
4. Writes all extracted rows to D1 using **multi-row INSERT statements of at most 8 rows each** (see §9.3).
5. Evaluates each active subscription for that zip and sends any matching notification.

**One zip per invocation is a free-tier requirement, not a scaling nicety.** Each Worker invocation gets its own 10 ms CPU budget and its own 50-query D1 budget; a serial loop over zips inside a single cron handler shares one budget across all of them and fails at a low zip count. Fanning out through Queues gives each zip a fresh budget. This is why Queues is in v1 rather than deferred — see §9.

Each message is processed in its own try/catch so that one failing zip does not affect the others. Failed messages are retried by Queues; note that free-tier message retention is 24 hours, which is ample for a daily job.

### 5.2 Storage

D1, one row per `(zip, dealer, payment type, gallon tier)` per day. For 06483 that is roughly 44 rows per day — a trivial volume that stays well inside the free tier for years.

Every price point returned is stored. The previous draft's "ten cheapest" rule assumed a longer result list than the site actually returns, and truncating a 5-listing result set would discard most of the distribution.

### 5.3 Notification

Push via ntfy to the topic named in the subscription.

**A bare "cheapest price" is meaningless without qualifiers.** On 2026-09-05 the cheapest 06483 price was $4.84, but only for orders of 100 gallons or more; a buyer wanting 50 gallons faced $5.64 at the same dealer and $6.00 at another. A notification that says "$4.84" to someone who needs 50 gallons is actively misleading.

Notifications are therefore evaluated per subscription, filtered by that subscriber's `min_gallons` and `payment_type`. The payload contains the qualifying price per gallon, the gallon tier it applies to, the payment type, the delivery date, the "price updated on" date, and the scrape date. This matters even in v1 with a single subscriber, so it is built now rather than deferred.

### 5.4 Staleness detection

Every listing carries a "Price Updated on" date. If the maximum such date across a zip's listings has not advanced in more than N days (N = 3 to start), the notification is annotated as stale rather than presented as a current price. This is cheap to implement and prevents the failure mode where the site quietly stops updating and the tracker keeps reporting a frozen price as today's.

## 6. Data Model

Three tables. The schema is multi-tenant and multi-zip from the first migration even though v1 runs one subscriber against one zip.

### `zips`

| column | type | notes |
|---|---|---|
| `zip` | TEXT PK | e.g. `06483` |
| `slug` | TEXT | cached resolved path, e.g. `seymour_ct_oil_prices/06483`; nullable until first resolution |
| `city` | TEXT | parsed from the slug |
| `state` | TEXT | parsed from the slug |
| `active` | INTEGER | 0/1, so a zip can be paused without losing its history |
| `slug_resolved_at` | TEXT | ISO timestamp of last successful resolution |

### `prices`

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `scrape_date` | TEXT | ISO date, the logical day of the run |
| `zip` | TEXT | FK to `zips.zip` |
| `dealer_id` | INTEGER | from the hidden `dealerid` input; the identity key |
| `payment_type` | TEXT | `cash` or `credit` |
| `gallon_min` | INTEGER | lower bound of the tier, e.g. 100 |
| `gallon_max` | INTEGER | upper bound, nullable for open-ended tiers |
| `price_per_gallon` | REAL | |
| `delivery_date` | TEXT | ISO date, nullable |
| `price_updated_on` | TEXT | ISO date as reported by the listing, nullable |
| `same_day_charge` | REAL | nullable |
| `scraped_at` | TEXT | ISO timestamp of actual fetch |

Unique constraint on `(scrape_date, zip, dealer_id, payment_type, gallon_min)` so a re-run replaces rather than duplicates.

There is no `rank` column. Ranking is positional and derivable at query time; storing it would bake a presentation detail into the historical record.

### `subscriptions`

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `user_id` | TEXT | opaque; a single constant value in v1 |
| `zip` | TEXT | FK to `zips.zip` |
| `ntfy_topic` | TEXT | |
| `min_gallons` | INTEGER | the subscriber's intended order size; selects the applicable tier |
| `payment_type` | TEXT | `cash` or `credit` |
| `threshold` | REAL | nullable; if set, notify only when the qualifying price falls below it |
| `active` | INTEGER | 0/1 |

## 7. Tech Stack

- **Runtime:** Cloudflare Workers, cron trigger
- **Fan-out:** Cloudflare Queues, one message per zip — required from v1, see §5.1 and §9
- **Parsing:** **HTMLRewriter**, the Workers runtime's native streaming HTML parser. This replaces Cheerio, which was the previous draft's choice. HTMLRewriter runs in native code rather than JS, which matters against the free tier's 10 ms CPU ceiling, and it removes the `nodejs_compat` requirement entirely.
- **Storage:** Cloudflare D1
- **Notification:** ntfy (hosted or self-hosted), Android app subscribed to a topic

The whole thing fits in the free tier, with the caveats and required design choices in §9.

## 8. Error Handling

- **Zero rows parsed for a zip:** log and skip the write for that zip. Do not push a notification. A missing day is better than a wrong one. Other zips in the run continue.
- **Parse failure / structure change:** push an ntfy alert so the failure is visible rather than silent. The site is hand-maintained PHP with inline styles, so markup drift is a realistic ongoing risk.
- **Slug resolution fails, or a cached slug stops returning listings:** invalidate the cached slug and retry once via the POST path before treating it as a failed zip.
- **Data is stale:** if `price_updated_on` has not advanced in more than N days, annotate the notification rather than suppressing it — the price may genuinely be flat.
- **Notification send fails:** the D1 write has already happened, so the data is not lost. Log and move on.

## 9. Free-Tier Capacity

**Verdict: yes, this runs entirely on the Cloudflare free tier, with a wide margin.** Every product in the stack — Workers, Cron Triggers, Queues, and D1 — has a free tier that covers this workload. Nothing here requires a paid plan, at v1 or at any realistic multi-zip scale.

This holds *because of* the design decisions in §9.2 and §9.3, not automatically. The previous draft's approach — Cheerio parsing every zip inside a single cron handler, writing rows one at a time — would breach the CPU and D1 query caps at a low zip count. Do not revert those choices without re-reading this section.

**Projected v1 daily usage** (one zip, one subscriber):

| Resource | v1 usage/day | Free limit | Headroom |
|---|---|---|---|
| Worker invocations | ~2 (cron + 1 consumer) | 100,000/day | ~50,000x |
| Queues operations | ~2 | 10,000/day | ~5,000x |
| D1 rows written | ~44 | 100,000/day | ~2,270x |
| Subrequests | ~3 per invocation | 50 per invocation | ~16x |
| D1 storage | ~1.6 MB/year | 500 MB per database | ~300 years |
| CPU per invocation | one ~33 KB parse | 10 ms | **unverified — see §9.2** |

Every row except the last has margin measured in multiples of 100x or more, so those are safe on arithmetic alone. CPU is the only limit where the margin is reasoned rather than measured, and it is therefore the only one that could force a design change after build starts. Measure it early — see the action item in §9.2.

Limits below were read from Cloudflare's docs on 2026-09-06. They are the binding constraints on this design, so re-check them before any significant scale-up.

### 9.1 The limits that matter

| Limit | Workers Free | Relevance here |
|---|---|---|
| CPU time per cron invocation | **10 ms** | **Binding.** Drives the HTMLRewriter and one-zip-per-invocation decisions. |
| D1 queries per Worker invocation | **50** | **Binding.** Drives multi-row INSERT batching. |
| Subrequests per invocation | 50 | Comfortable: 1–2 fetches + 1 ntfy per zip. |
| Simultaneous outbound connections | 6 | Cap any parallel fetching at 6. |
| Cron triggers per account | 5 | Fine — this needs one. Rules out cron-based fan-out. |
| Worker requests per day | 100,000 | Not binding; scheduled invocations count against it. |
| Queues operations per day | 10,000 | Not binding; ~2 ops per zip per day. |
| D1 rows written per day | 100,000 | ~2,270 zips/day at 44 rows each. Not binding. |
| D1 max database size | 500 MB | ~1.6 MB per zip-year. Not binding. |
| D1 storage per account | 5 GB | Not binding. |

Exceeding the D1 daily row limits returns errors rather than incurring charges, so overrun degrades into missed days rather than a surprise bill — consistent with §8's "a missing day is better than a wrong one."

### 9.2 CPU time forces HTMLRewriter over Cheerio

The free tier allows **10 ms of CPU per cron invocation**. The 06483 results page is ~33 KB of HTML. Cheerio builds a full DOM in JavaScript, and the previous draft compounded this by looping every zip inside one invocation — all zips sharing a single 10 ms budget.

HTMLRewriter is the Workers runtime's own streaming parser, implemented natively, so per-byte parsing cost does not come out of the JS CPU budget the same way. It also drops the `nodejs_compat` requirement.

**Honest tradeoff:** HTMLRewriter is streaming and handler-based, so extracting the tiered cash/credit tables needs explicit state — track which `boxlisting` is open, which of its two tables is being read, and which column a `<td>` belongs to. That is meaningfully more code than Cheerio selectors. It is still the right call, because Cheerio at 10 ms is a gamble on a number nobody has measured.

**Action before build:** measure actual CPU for one 06483 parse using `wrangler dev` and the Workers observability CPU metric. If HTMLRewriter lands comfortably under budget, this is settled. If Cheerio also lands comfortably under budget with one zip per invocation, Cheerio remains viable as a simpler fallback — but do not assume it, measure it.

### 9.3 The 50-query D1 cap forces multi-row INSERTs

Free-tier D1 allows **50 queries per Worker invocation**, and each statement inside a `batch()` counts individually. Writing 06483's ~44 rows one at a time is ~44 queries — under the cap, but leaving almost no room for the reads the same invocation needs, and impossible for two zips.

Multi-row INSERT (`INSERT INTO prices (...) VALUES (...),(...),...`) is **one** statement. With a 100 bound-parameter cap and 12 columns per row, that is **8 rows per statement**:

- 44 rows → **6 statements**, leaving ~44 queries of headroom for slug lookups, subscription reads, and the staleness check.

### 9.4 Where the ceiling actually is

With one zip per queue message, per-invocation limits stop being a function of zip count. The remaining ceilings, in the order they would be hit:

1. **Queues free-tier operations** — 10,000/day at ~2 ops per zip ≈ **5,000 zips/day**.
2. **D1 rows written** — 100,000/day at 44 rows ≈ **2,270 zips/day**.

So D1 row writes bind first, at roughly **2,000 zips**. That is orders of magnitude beyond the plausible scope of this project. For the realistic range — one zip, or a few dozen — the free tier is not close to strained.

The one caveat is that 44 rows/day is the 06483 figure. A zip with more listings or more gallon tiers writes more, so treat 2,000 as an estimate rather than a guarantee.

## 10. Future Considerations

- Historical trend view — the reason every price point is stored rather than just the daily minimum.
- Per-dealer time series, keyed on `dealer_id`, pending the stability verification in §4.5.
- Alerting on a price drop below a threshold or below a rolling average — the `subscriptions.threshold` column is already in place for this.
- Cash-versus-credit spread tracking per dealer, which the schema supports for free.
- Additional zips, which the POST-and-follow-redirect approach makes straightforward.
- A self-service front end for adding zips and subscriptions, if this ever leaves single-user use.
