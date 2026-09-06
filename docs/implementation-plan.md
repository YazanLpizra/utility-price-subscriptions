# Implementation Plan: Heating Oil Price Tracker

**Source of truth:** `docs/heating-oil-tracker-prd.md`
**Fixture of record:** `docs/view-source_https___www.cashheatingoil.com_seymour_ct_oil_prices_06483.html`
**Plan status:** ready for parallel execution
**Date:** 2026-09-06

---

## 0. How this plan is executed

This plan is written for **multiple independent AI coding agents running simultaneously**, each in its own git worktree, each doing **exactly one phase**, with **no communication between them**. Branches are merged after each wave.

Rules every executing agent must follow:

1. **Do only your phase.** Do not create, rename, or "fix" files outside your phase's *Files owned* list. If something you need is missing and it belongs to another phase, write your code against the contract in §2 of this document and assume the other agent produced it.
2. **Waves are merge barriers.** A wave-*k* worktree branches from the merge commit of waves 1..*k*-1. Within a wave, no two phases write the same file — this is enforced by the *Files owned* lists.
3. **§2 is law.** All shared types, file paths, export names, and function signatures in §2 are copied verbatim into `src/types.ts` by Phase 1. Downstream phases import from `../src/types` (or `./types`). **Do not "improve" a signature** — a rename here is what breaks the merge.
4. **Config files have exactly one owner.** `package.json`, `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `test/setup.ts`, `test/env.d.ts` are owned by **Phase 1 only**. Every other phase assumes they exist and must not create or edit them. If your phase seems to need a new npm dependency, it does not — see §3.
5. **No deployment, no credentials, no network.** Nothing in this plan requires a Cloudflare account, `wrangler login`, or a request to `cashheatingoil.com`. All validation runs locally against miniflare's local D1 and the saved HTML fixture. Deploy-only items are listed in §6.

---

## 1. Recon: verified structure of the results page

These facts were extracted from the saved 06483 page (2026-09-05 capture) and are **binding on the parser**. The saved file in `docs/` is a Chrome *view-source* wrapper (173 KB of `<td class="line-content">` rows); the real document inside it is **33,065 bytes**. Phase 1 de-wraps it into `test/fixtures/06483.html`.

### 1.1 Page skeleton

```
div.content > div.box > div.vardetail
    table (no class)                      <- LISTING ID / State / City metadata
    div.alllisting
        div.boxlisting     x5             <- one per dealer, siblings, not nested
```

- `div.varheading` text: `CashHeatingOil.com - Please SCROLL DOWN to see all the heating oil prices in Seymour CT, 06483`
- The metadata table above `div.alllisting` holds `State` = `CT` and `City` = `Seymour` in `td` siblings of `td.formtxt`. **The parser does not need these** — per PRD §6, `city`/`state` are derived from the resolved slug (`seymour_ct_oil_prices/06483`).
- `LISTING ID` (`t2YqEch`) is the per-request search token. **Not an identity. Never stored.**

### 1.2 Inside one `div.boxlisting`

Two sibling `<table>`s.

**Table A — metadata**, `<table cellpadding="2" cellspacing="2" border="0" width="100%">`, built from `label.formtxt` (the caption) followed by `label.varlabel` (the value). Captions use `&nbsp;` around the colon, which HTMLRewriter surfaces as U+00A0:

```html
<label class="formtxt">Delivery Date&nbsp;:&nbsp;</label>
<label class="varlabel">Sep 8th 2026</label>
...
<label class="formtxt">Price Updated on&nbsp;:&nbsp;</label><label class="varlabel">Sep 5th 2026</label>
...
<label class="formtxt">Dealer Name&nbsp;:&nbsp;</label><label class="varlabel">Available Upon Ordering</label>
...
<label class="formtxt" style="float:left;">Same Day Charges&nbsp;:&nbsp;</label><label class="varlabel">$&nbsp;0.00</label>
```

Also present, and **optional** — dealer 919 has no ratings link at all:

```html
<a title="View Ratings" class="links" href="feedback.php?id=WEkjMTEjUlo=" target="_blank">
  <div class="rating" style="width:188.1px"></div></a>
```

`div.varaboutus` and a free-text `div` (comments) also live in Table A. Both contain arbitrary text and `<br/>` — the parser must not be confused by them, which is why the metadata state machine keys on `label.formtxt` / `label.varlabel` pairs and not on `td` position.

**Table B — pricing**, `<table width="100%">` containing exactly **two `<form method="post" action="tranction.php">`** in two `<td>`s: cash on the left, credit on the right. Each form:

```html
<form method="post" action="tranction.php">
  <input type="hidden" name="listingid"    value="t2YqEch"/>
  <input type="hidden" name="dealerid"     value="11"/>
  <input type="hidden" name="enumtype"     value="Cash"/>      <!-- or "Credit" -->
  <input type="hidden" name="earlistdate"  value="2026-09-08" /> <!-- already ISO -->
  <table class="paywithcash" width="100%">                     <!-- or class="paybycredit" -->
    <tr><td>Cash Prices : </td><td><input type="Submit" value="Click to Order"/></td></tr>
    <tr><td><b>Gallons:</b></td><td><b>Price/Gallon</b></td></tr>
    <tr><td>100-149</td><td>$4.84</td></tr>
    <tr><td>150-199</td><td>$4.84</td></tr>
    ...
  </table>
</form>
```

Key structural facts:

- **Cash vs credit is distinguished two ways, redundantly**: the hidden `enumtype` input (`Cash` / `Credit`) and the price table's class (`paywithcash` / `paybycredit`). Use `enumtype` as primary and treat a table-class/enumtype disagreement as a parse error.
- `dealerid` appears **twice per listing** (once per form) with the same value. Take the first; assert the second matches.
- `earlistdate` is **already ISO** (`2026-09-08`) and is the preferred source for `delivery_date`. `Delivery Date : Sep 8th 2026` is the human fallback.
- `Price Updated on` has **no ISO twin** — it must be parsed from `Sep 5th 2026` (`MMM D(st|nd|rd|th) YYYY`).
- Tier rows are **unclassed `<td>` pairs**. There is no per-row class, no `id`, no `data-` attribute. The two header rows must be skipped. The robust rule: within a `table.paywithcash` / `table.paybycredit`, pair consecutive `td` text values and accept a pair only when cell 1 matches `/^\s*(\d+)\s*-\s*(\d+)\s*\+?\s*$/` (or `/^\s*(\d+)\s*\+\s*$/` for an open-ended tier, which does not occur in this fixture but is cheap to support → `gallon_max = null`) and cell 2 matches `/^\s*\$\s*([\d,]+\.\d{2})\s*$/`. The "Click to Order" cell holds only an `<input>`, so its text is empty and it never matches.
- **Tier sets are not symmetric between cash and credit.** Dealer 744 has a `50-99` cash tier and **no** `50-99` credit tier. Any parser that assumes a per-listing tier list shared by both tables is wrong.
- The whole page has **39** price points, not the "roughly 44" estimated in PRD §4.3 (20 cash + 19 credit). See §7 assumption A1.

### 1.3 Ground truth for the parser test (the fixture, verbatim)

All five listings: `price_updated_on = 2026-09-05`, `same_day_charge = 0.00`.

| # | dealer_id | delivery_date | cash tiers (gallons → $/gal) | credit tiers |
|---|---|---|---|---|
| 1 | 11  | 2026-09-08 | 100-149 4.84, 150-199 4.84, 200-299 4.84, 300-399 4.84 | 100-149 4.94, 150-199 4.94, 200-299 4.94, 300-399 4.94 |
| 2 | 372 | 2026-09-09 | **50-99 5.64**, 100-149 4.84, 150-199 4.84, 200-299 4.84, 300-399 4.84 | **50-99 5.74**, 100-149 4.94, 150-199 4.94, 200-299 4.94, 300-399 4.94 |
| 3 | 744 | 2026-09-07 | **50-99 6.00**, 100-149 4.84, 150-199 4.84, 200-299 4.84, 300-399 4.84 | 100-149 4.94, 150-199 4.94, 200-299 4.94, 300-399 4.94  *(no 50-99)* |
| 4 | 345 | 2026-09-09 | 150-199 5.19, 200-299 5.19, 300-399 5.19 | 150-199 5.19, 200-299 5.19, 300-399 5.19 |
| 5 | 919 | 2026-09-09 | 150-199 5.19, 200-299 5.19, 300-399 5.19 | 150-199 5.19, 200-299 5.19, 300-399 5.19 |

Totals: 5 listings, 20 cash rows, 19 credit rows, **39 rows**. Cash/credit spread is **+$0.10** for dealers 11, 372, 744 and **$0.00** for 345, 919.

### 1.4 HTMLRewriter notes (hard-won, applies to Phase 2)

- `HTMLRewriter` only runs against a `Response` body: `await new HTMLRewriter().on(...).transform(new Response(html)).arrayBuffer()` (or `.text()`) to drive it to completion.
- Text handlers deliver **chunks**. Accumulate into a buffer and only act when `text.lastInTextNode` is true.
- Scope to a listing with `element.onEndTag()` on the `div.boxlisting` handler — HTMLRewriter matches the correct closing tag despite the nested `div.rating` / `div.varaboutus`.
- Supported selector subset covers everything needed here: `div.boxlisting`, `input[name="dealerid"]`, `table.paywithcash td`, `label.formtxt`, `label.varlabel`. Do **not** rely on `:nth-child` ordering across `tr`s; use the pairing rule from §1.2.
- `&nbsp;` arrives as ` `. Normalise with `.replace(/ /g, " ").trim()` before matching.

---

## 2. Shared contracts (Phase 1 writes these verbatim)

### 2.1 `src/types.ts`

```ts
/// <reference types="@cloudflare/workers-types" />

export type PaymentType = "cash" | "credit";

/** One (payment type, gallon tier) price point from one dealer's listing. */
export interface PriceTier {
  payment_type: PaymentType;
  gallon_min: number;
  /** null for an open-ended tier such as "400+". */
  gallon_max: number | null;
  price_per_gallon: number;
}

/** One div.boxlisting, fully extracted. */
export interface ParsedListing {
  /** hidden input name="dealerid"; the identity key (PRD 4.5). */
  dealer_id: number;
  /** ISO yyyy-mm-dd, from hidden input name="earlistdate". */
  delivery_date: string | null;
  /** ISO yyyy-mm-dd, parsed from "Price Updated on : Sep 5th 2026". */
  price_updated_on: string | null;
  /** dollars, from "Same Day Charges : $ 0.00". */
  same_day_charge: number | null;
  tiers: PriceTier[];
}

/** One row of the `prices` table. 12 columns -> 8 rows per multi-row INSERT (PRD 9.3). */
export interface PriceRow {
  scrape_date: string;        // ISO yyyy-mm-dd, logical day of the run
  zip: string;
  dealer_id: number;
  payment_type: PaymentType;
  gallon_min: number;
  gallon_max: number | null;
  price_per_gallon: number;
  delivery_date: string | null;
  price_updated_on: string | null;
  same_day_charge: number | null;
  scraped_at: string;         // ISO 8601 datetime of the actual fetch
}

/** One row of the `zips` table. */
export interface ZipRow {
  zip: string;
  /** e.g. "seymour_ct_oil_prices/06483"; no leading slash. */
  slug: string | null;
  city: string | null;
  state: string | null;
  active: number;             // 0 | 1
  slug_resolved_at: string | null;
}

/** One row of the `subscriptions` table. */
export interface Subscription {
  id: number;
  user_id: string;
  zip: string;
  ntfy_topic: string;
  min_gallons: number;
  payment_type: PaymentType;
  threshold: number | null;
  active: number;             // 0 | 1
}

/** Queue message body: one zip per message (PRD 5.1). */
export interface ScrapeMessage {
  zip: string;
  /** ISO yyyy-mm-dd, stamped by the producer so every message in a run agrees. */
  scrape_date: string;
}

/** The cheapest tier that satisfies one subscription's terms. */
export interface BestPrice {
  dealer_id: number;
  payment_type: PaymentType;
  gallon_min: number;
  gallon_max: number | null;
  price_per_gallon: number;
  delivery_date: string | null;
  price_updated_on: string | null;
}

export type DecisionReason =
  | "send"
  | "no_qualifying_tier"
  | "threshold_not_met";

export interface NotificationDecision {
  subscription: Subscription;
  best: BestPrice | null;
  stale: boolean;
  reason: DecisionReason;
  /** true iff reason === "send". */
  should_send: boolean;
}

/** Payload handed to the ntfy transport. */
export interface NtfyMessage {
  title: string;
  body: string;
  tags: string[];
  priority: number;           // ntfy 1..5
}

/** Result of resolving + fetching a zip's results page. */
export interface FetchedPage {
  zip: string;
  /** "seymour_ct_oil_prices/06483", no leading slash. */
  slug: string;
  /** absolute URL actually fetched. */
  url: string;
  html: string;
  /** true when the cached slug was unusable and the POST path was used. */
  resolved_via_post: boolean;
  city: string | null;
  state: string | null;
  fetched_at: string;         // ISO 8601
}

export interface Env {
  DB: D1Database;
  SCRAPE_QUEUE: Queue<ScrapeMessage>;
  /** e.g. "https://www.cashheatingoil.com" — no trailing slash. */
  SITE_BASE_URL: string;
  /** e.g. "https://ntfy.sh" — no trailing slash. */
  NTFY_BASE_URL: string;
  /** topic that receives parse-failure / error alerts (PRD 8). */
  NTFY_ALERT_TOPIC: string;
  /** stringified integer N; notification annotated stale when data is older than N days. */
  STALE_AFTER_DAYS: string;
  USER_AGENT: string;
}
```

### 2.2 Module contracts

Every signature below is exact. `fetchImpl` parameters exist purely so tests can inject a stub — they default to `globalThis.fetch` and callers normally omit them.

```ts
// ---- src/parser.ts  (Phase 2) -------------------------------------------
import type { ParsedListing, PriceRow } from "./types";

/** Throws ParseError on a structurally broken page. Returns [] for a valid page with no listings. */
export function parseListingsPage(html: string): Promise<ParsedListing[]>;

/** Flattens listings into DB rows. Pure. Order: listing order, then tier order. */
export function toPriceRows(
  listings: ParsedListing[],
  zip: string,
  scrapeDate: string,
  scrapedAt: string,
): PriceRow[];

export class ParseError extends Error {
  constructor(message: string, readonly detail?: unknown);
}

/** "Sep 5th 2026" -> "2026-09-05"; returns null when unparseable. Exported for tests. */
export function parseHumanDate(input: string): string | null;
```

```ts
// ---- src/fetcher.ts  (Phase 3) ------------------------------------------
import type { Env, FetchedPage } from "./types";

/** POSTs txtzipcode to cod_oil_prices.php and follows the 302 to the slug page. */
export function resolveAndFetch(
  zip: string,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<FetchedPage>;

/**
 * Uses cachedSlug if given; on non-200 or a body with no `div.boxlisting`,
 * falls back once to resolveAndFetch (PRD 8). Throws FetchError if both paths fail.
 */
export function fetchPricesPage(
  zip: string,
  cachedSlug: string | null,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<FetchedPage>;

/** "seymour_ct_oil_prices/06483" -> { city: "seymour", state: "ct", zip: "06483" }. */
export function parseSlugParts(
  slug: string,
): { city: string; state: string; zip: string } | null;

export class FetchError extends Error {
  constructor(message: string, readonly status?: number);
}
```

```ts
// ---- src/db.ts  (Phase 4) -----------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import type { PriceRow, Subscription, ZipRow } from "./types";

/** Max rows per multi-row INSERT: 12 cols x 8 = 96 bound params, under D1's 100 cap. */
export const ROWS_PER_INSERT = 8;

export function getActiveZips(db: D1Database): Promise<ZipRow[]>;
export function getZip(db: D1Database, zip: string): Promise<ZipRow | null>;

export function updateZipSlug(
  db: D1Database,
  zip: string,
  slug: string,
  city: string | null,
  state: string | null,
  resolvedAt: string,
): Promise<void>;

export function clearZipSlug(db: D1Database, zip: string): Promise<void>;

/**
 * Chunks rows into groups of ROWS_PER_INSERT, one multi-row INSERT ... ON CONFLICT
 * DO UPDATE per chunk, all sent in a single db.batch(). Returns counts for assertions.
 * Writing [] is a no-op that issues zero queries.
 */
export function writePriceRows(
  db: D1Database,
  rows: PriceRow[],
): Promise<{ statements: number; rows: number }>;

export function getActiveSubscriptions(
  db: D1Database,
  zip: string,
): Promise<Subscription[]>;
```

```ts
// ---- src/notify.ts  (Phase 5) -------------------------------------------
import type {
  BestPrice, Env, NotificationDecision, NtfyMessage,
  ParsedListing, Subscription,
} from "./types";

/**
 * Cheapest tier across all listings where
 *   payment_type === sub.payment_type
 *   && sub.min_gallons >= gallon_min
 *   && (gallon_max === null || sub.min_gallons <= gallon_max).
 * Ties broken by lowest dealer_id, for deterministic tests. null when nothing qualifies.
 */
export function selectBestPrice(
  listings: ParsedListing[],
  sub: Subscription,
): BestPrice | null;

/**
 * true when max(price_updated_on) across listings is more than staleAfterDays
 * before scrapeDate, or when no listing carries a price_updated_on (PRD 5.4).
 */
export function isStale(
  listings: ParsedListing[],
  scrapeDate: string,
  staleAfterDays: number,
): boolean;

export function evaluateSubscription(
  listings: ParsedListing[],
  sub: Subscription,
  scrapeDate: string,
  staleAfterDays: number,
): NotificationDecision;

/** Deterministic, pure. Body carries price, tier, payment type, delivery date,
 *  price-updated-on, scrape date, and a stale banner when decision.stale. */
export function buildNotification(
  decision: NotificationDecision,
  zip: string,
  scrapeDate: string,
): NtfyMessage;

/** POSTs to `${env.NTFY_BASE_URL}/${topic}`. Never throws; returns false on failure (PRD 8). */
export function sendNtfy(
  env: Env,
  topic: string,
  msg: NtfyMessage,
  fetchImpl?: typeof fetch,
): Promise<boolean>;

/** Operational alert to env.NTFY_ALERT_TOPIC at priority 4, tag "warning". Never throws. */
export function sendAlert(
  env: Env,
  title: string,
  body: string,
  fetchImpl?: typeof fetch,
): Promise<boolean>;
```

```ts
// ---- src/index.ts  (Phase 7) --------------------------------------------
import type { Env, ScrapeMessage } from "./types";

declare const _default: {
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
  queue(batch: MessageBatch<ScrapeMessage>, env: Env, ctx: ExecutionContext): Promise<void>;
};
export default _default;

/** Exported for direct unit testing; processes exactly one zip end to end. */
export function processZip(
  msg: ScrapeMessage,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<{ zip: string; rows_written: number; notifications_sent: number; stale: boolean }>;
```

### 2.3 `migrations/0001_init.sql` (Phase 1 writes verbatim)

```sql
-- 0001_init.sql — PRD §6. Multi-tenant, multi-zip from day one.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS zips (
  zip              TEXT PRIMARY KEY,
  slug             TEXT,
  city             TEXT,
  state            TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  slug_resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS prices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_date       TEXT    NOT NULL,
  zip               TEXT    NOT NULL REFERENCES zips(zip),
  dealer_id         INTEGER NOT NULL,
  payment_type      TEXT    NOT NULL CHECK (payment_type IN ('cash','credit')),
  gallon_min        INTEGER NOT NULL,
  gallon_max        INTEGER,
  price_per_gallon  REAL    NOT NULL,
  delivery_date     TEXT,
  price_updated_on  TEXT,
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
  zip          TEXT    NOT NULL REFERENCES zips(zip),
  ntfy_topic   TEXT    NOT NULL,
  min_gallons  INTEGER NOT NULL,
  payment_type TEXT    NOT NULL CHECK (payment_type IN ('cash','credit')),
  threshold    REAL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ix_subs_zip_active ON subscriptions (zip, active);
```

The upsert Phase 4 must emit (illustrative, 2-row form):

```sql
INSERT INTO prices
  (scrape_date, zip, dealer_id, payment_type, gallon_min, gallon_max,
   price_per_gallon, delivery_date, price_updated_on, same_day_charge, scraped_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (scrape_date, zip, dealer_id, payment_type, gallon_min) DO UPDATE SET
  gallon_max       = excluded.gallon_max,
  price_per_gallon = excluded.price_per_gallon,
  delivery_date    = excluded.delivery_date,
  price_updated_on = excluded.price_updated_on,
  same_day_charge  = excluded.same_day_charge,
  scraped_at       = excluded.scraped_at;
```

`id` is not bound, so 11 bound params per row; 8 rows = 88 params, safely under D1's 100-parameter cap. `ROWS_PER_INSERT = 8` is kept at 8 (per PRD §9.3) rather than raised.

### 2.4 `wrangler.jsonc` (Phase 1 owns; all bindings final)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "heating-oil-tracker",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "observability": { "enabled": true },
  "triggers": { "crons": ["0 12 * * *"] },
  "vars": {
    "SITE_BASE_URL": "https://www.cashheatingoil.com",
    "NTFY_BASE_URL": "https://ntfy.sh",
    "NTFY_ALERT_TOPIC": "heating-oil-alerts-CHANGEME",
    "STALE_AFTER_DAYS": "3",
    "USER_AGENT": "heating-oil-tracker/1.0 (+personal price tracker)"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "heating-oil",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [{ "binding": "SCRAPE_QUEUE", "queue": "heating-oil-scrape" }],
    "consumers": [
      {
        "queue": "heating-oil-scrape",
        "max_batch_size": 1,
        "max_retries": 3,
        "max_concurrency": 6
      }
    ]
  }
}
```

`max_batch_size: 1` is deliberate: it preserves the one-zip-per-invocation CPU/D1 budget guarantee of PRD §5.1. `database_id` is a placeholder — local D1 ignores it; the README tells the operator to replace it before any real deploy.

---

## 3. Dependencies (complete list — no others may be added)

| Package | Kind | One-line justification |
|---|---|---|
| `wrangler` | dev | The only way to run local D1 migrations, `dev`, and a dry-run build. |
| `typescript` | dev | The project is TypeScript; `tsc --noEmit` is a validation gate in every phase. |
| `vitest` | dev | Test runner mandated by the plan's validation commands. |
| `@cloudflare/vitest-pool-workers` | dev | Runs tests inside workerd so `HTMLRewriter`, D1, and Queues are the real implementations, not mocks. |
| `@cloudflare/workers-types` | dev | Type declarations for `D1Database`, `Queue`, `MessageBatch`, `HTMLRewriter`. |

**Zero runtime dependencies.** No Cheerio (PRD §9.2), no date library (§1.2's date format is a 12-entry month map), no HTTP client (`fetch` is built in), no ntfy SDK (ntfy is a plain `POST`), no test-mock library (inject `fetchImpl`).

---

## 4. Wave / phase overview

| Wave | Phase | Goal | Depends on |
|---|---|---|---|
| 1 | **P1 Foundation** | Repo skeleton, config, shared types, D1 migration, de-wrapped HTML fixture, test harness | — |
| 2 | **P2 Parser** | `parseListingsPage` over the real fixture | P1 |
| 2 | **P3 Fetch/slug** | POST-and-follow-redirect resolver + cached-slug fetch with fallback | P1 |
| 2 | **P4 D1 write layer** | Batched multi-row upserts + zip/subscription reads | P1 |
| 2 | **P5 Notify/eval** | Tier selection, staleness, ntfy message build + transport + alerts | P1 |
| 2 | **P6 Seed/admin** | Local seeding of zips and subscriptions; dev ergonomics | P1 |
| 3 | **P7 Orchestration** | Cron producer + queue consumer wiring everything, with per-zip error isolation | P1–P6 |
| 3 | **P8 Docs + CPU** | README (local dev + deploy), CPU-measurement procedure (PRD §9.2) | P1 (reads P2–P6 contracts from this plan) |

P2–P6 run **simultaneously**. P7 and P8 run **simultaneously** after wave 2 merges.

File-ownership map (no intra-wave overlap):

```
P1  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .gitignore
    .dev.vars.example  src/types.ts  src/index.ts(stub)  migrations/0001_init.sql
    scripts/extract-fixture.mjs  test/fixtures/06483.html  test/setup.ts
    test/env.d.ts  test/foundation.test.ts
P2  src/parser.ts            test/parser.test.ts
P3  src/fetcher.ts           test/fetcher.test.ts
P4  src/db.ts                test/db.test.ts
P5  src/notify.ts            test/notify.test.ts
P6  scripts/seed.mjs  seeds/dev-seed.sql  test/seed.test.ts
P7  src/index.ts (replaces P1 stub)  test/orchestration.test.ts
P8  README.md  docs/cpu-measurement.md
```

---

## 5. Phases

---

### Phase 1 — Foundation (Wave 1)

**Goal:** stand up the repo, the config, the shared type contracts, the D1 migration, and the real HTML fixture, so that all of wave 2 can code against stable interfaces without touching each other.

**Dependencies:** none.

**Files owned (create):**
```
package.json
tsconfig.json
wrangler.jsonc
vitest.config.ts
.gitignore
.dev.vars.example
src/types.ts
src/index.ts                 (minimal stub, replaced by P7)
migrations/0001_init.sql
scripts/extract-fixture.mjs
test/fixtures/06483.html     (generated, committed)
test/setup.ts
test/env.d.ts
test/foundation.test.ts
```

**Work items:**

1. `package.json`: `"type": "module"`, `"private": true`, devDependencies exactly as §3, and scripts:
   `test` → `vitest run`, `typecheck` → `tsc --noEmit`, `migrate:local` → `wrangler d1 migrations apply heating-oil --local`, `dryrun` → `wrangler deploy --dry-run --outdir=dist`, `fixture` → `node scripts/extract-fixture.mjs`, `seed:local` → `node scripts/seed.mjs` (the script itself arrives in P6; the script entry is written now so P6 does not need to touch `package.json`).
2. `tsconfig.json`: `target/lib ES2022`, `module`/`moduleResolution` `Bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`, `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]`, `include: ["src/**/*.ts", "test/**/*.ts"]`.
3. `wrangler.jsonc` — copy §2.4 verbatim.
4. `vitest.config.ts` using `defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config`, pointing `wrangler.configPath` at `./wrangler.jsonc`, with `setupFiles: ["./test/setup.ts"]` and `miniflare: { compatibilityDate }` inherited from the wrangler config.
5. `test/setup.ts`: `import { applyD1Migrations, env } from "cloudflare:test";` then `await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);`. Add `migrations` to the vitest config's `miniflare.bindings` as `TEST_MIGRATIONS` via `readD1Migrations("./migrations")`.
6. `test/env.d.ts`: `declare module "cloudflare:test" { interface ProvidedEnv extends Env { TEST_MIGRATIONS: D1Migration[] } }`.
7. `src/types.ts` — copy §2.1 verbatim, no additions.
8. `migrations/0001_init.sql` — copy §2.3 verbatim.
9. `src/index.ts` stub: default export with `scheduled` and `queue` handlers that are `async` no-ops returning `undefined`, plus a `// replaced in Phase 7` comment. It must typecheck against `Env` and `ScrapeMessage`.
10. `scripts/extract-fixture.mjs`: reads the view-source file in `docs/`, extracts every `<td class="line-content">…</td>` body, strips HTML comments then tags, HTML-unescapes, joins with `\n`, writes `test/fixtures/06483.html`. It must be idempotent and must **assert** the output is 33,065 bytes ± 0 and contains exactly 5 occurrences of `class="boxlisting"`, exiting non-zero otherwise. Run it and commit the generated fixture.
11. `.dev.vars.example` documenting any local-only overrides (none are secret in v1; ntfy topics are non-secret by design — note this).
12. `.gitignore`: `node_modules`, `dist`, `.wrangler`, `.dev.vars`.
13. `test/foundation.test.ts`: (a) fixture exists, is 33,065 bytes, has 5 `div.boxlisting`, contains `name="dealerid" value="11"` and `class="paybycredit"`; (b) migration applied — insert one `zips` row and one `prices` row, then assert a duplicate `(scrape_date, zip, dealer_id, payment_type, gallon_min)` insert raises a constraint error while the same insert with `ON CONFLICT … DO UPDATE` succeeds and leaves exactly 1 row; (c) `subscriptions.payment_type = 'debit'` is rejected by the CHECK constraint.

**Definition of done:**
- [ ] `npm ci` (or `npm install`) succeeds with exactly the five devDependencies of §3 and zero runtime dependencies.
- [ ] `test/fixtures/06483.html` is committed, is 33,065 bytes, and contains 5 `div.boxlisting`, 10 `dealerid` inputs, 5 `paywithcash` tables, 5 `paybycredit` tables.
- [ ] `src/types.ts` exports every symbol listed in §2.1 with identical names and shapes.
- [ ] `migrations/0001_init.sql` matches §2.3 and applies cleanly to a fresh local D1.
- [ ] `wrangler.jsonc` declares the `DB` D1 binding, the `SCRAPE_QUEUE` producer, the `heating-oil-scrape` consumer with `max_batch_size: 1`, one cron trigger, and all five `vars`.
- [ ] `npx tsc --noEmit` is clean.
- [ ] `npx vitest run` passes with at least the 3 foundation test groups.

**Validation:**
```
npm install
node scripts/extract-fixture.mjs          # exit 0, prints "33065 bytes, 5 listings"
npx tsc --noEmit                          # no output
npx wrangler d1 migrations apply heating-oil --local   # "Migrations applied: 0001_init.sql"
npx vitest run test/foundation.test.ts    # all tests pass
npx wrangler deploy --dry-run --outdir=dist            # builds; no auth required
```
Pass = every command exits 0; the dry run must **not** prompt for login.

---

### Phase 2 — HTML parser (Wave 2)

**Goal:** turn the real 06483 HTML into `ParsedListing[]` with HTMLRewriter, correctly and defensively.

**Dependencies:** P1 merged.

**Files owned:** `src/parser.ts`, `test/parser.test.ts`.
**Must not touch:** anything else, including `package.json`.

**Work items:**

1. Implement `parseListingsPage(html)` per §2.2 using `HTMLRewriter` only. Structure it as an explicit state machine, as PRD §9.2 warns:
   - `div.boxlisting` handler opens a new draft listing and registers `element.onEndTag()` to finalise and push it.
   - `input[name="dealerid"]`, `input[name="enumtype"]`, `input[name="earlistdate"]` handlers read `getAttribute("value")` into the current form's draft. A `form[action="tranction.php"]` handler resets the per-form draft.
   - `label.formtxt` / `label.varlabel` text handlers implement the caption→value pairing for `Price Updated on` and `Same Day Charges` (and `Delivery Date` as fallback when `earlistdate` is absent).
   - `table.paywithcash td` and `table.paybycredit td` text handlers feed the two-cell pairing rule from §1.2.
   - All text handlers buffer chunks until `text.lastInTextNode`; all values pass through an NBSP-normalising trim.
2. Normalise: `enumtype` `Cash`→`cash`, `Credit`→`credit`; price `"$4.84"`→`4.84`; same-day `"$ 0.00"`→`0`; `"50-99"`→`{min:50,max:99}`; `"400+"`→`{min:400,max:null}`.
3. Implement `parseHumanDate("Sep 5th 2026") -> "2026-09-05"` with a 12-entry month map and an ordinal-suffix strip; return `null` on anything else.
4. Prefer `earlistdate` for `delivery_date`; fall back to `parseHumanDate` of the `Delivery Date` label; else `null`.
5. Defensive rules — each throws `ParseError` with a message naming the listing index:
   - a `boxlisting` finishing with no `dealer_id`;
   - the two `dealerid` values inside one listing disagreeing;
   - `enumtype` disagreeing with the price table's class;
   - a `boxlisting` finishing with zero tiers.
   A page with **zero** `div.boxlisting` returns `[]` (not an error) — PRD §8 makes the caller decide.
6. Implement `toPriceRows` — pure flatten, listing order then tier order, copying listing-level fields onto every row.
7. `test/parser.test.ts`, reading `test/fixtures/06483.html` via `import fixture from "./fixtures/06483.html?raw"` (or `fs.readFileSync` if the raw import is unavailable in the pool). Assertions, all against §1.3:
   - exactly 5 listings; `dealer_id`s in document order are `[11, 372, 744, 345, 919]`;
   - delivery dates `["2026-09-08","2026-09-09","2026-09-07","2026-09-09","2026-09-09"]`;
   - every listing has `price_updated_on === "2026-09-05"` and `same_day_charge === 0`;
   - dealer 11 cash tiers are exactly the 4 rows at `4.84`; credit exactly 4 rows at `4.94`;
   - dealer 372 cash `50-99` is `5.64`; dealer 744 cash `50-99` is `6.00`; dealer 372 credit `50-99` is `5.74`;
   - **dealer 744 has no credit `50-99` tier** (4 credit tiers, not 5);
   - dealers 345 and 919 have 3 cash + 3 credit tiers, all `5.19`;
   - cash→credit spread is exactly `0.10` for dealers 11/372/744 on every shared tier and `0` for 345/919 (compute per shared `(gallon_min)` pair, assert with a 1e-9 epsilon);
   - total tier count across all listings is **39** (20 cash, 19 credit);
   - `toPriceRows(...)` returns 39 `PriceRow`s, each with the passed `zip`/`scrape_date`/`scraped_at`, and no row has `payment_type` outside `cash|credit`;
   - `parseListingsPage("<html><body></body></html>")` resolves to `[]`;
   - a mutated fixture with the `dealerid` inputs deleted from listing 1 rejects with `ParseError`;
   - `parseHumanDate` table test: `"Sep 5th 2026"`, `"Jan 1st 2027"`, `"Mar 3rd 2026"`, `"Dec 22nd 2026"`, and `"garbage"` → `null`.
8. Add a `console.time`-free micro-benchmark test that parses the fixture 1x and asserts it resolves — no timing assertion (timing lives in P8's CPU procedure).

**Definition of done:**
- [ ] `parseListingsPage` and `toPriceRows` exported with the exact §2.2 signatures.
- [ ] No import of any package outside `./types` — HTMLRewriter is a global.
- [ ] All assertions in item 7 present and passing.
- [ ] `src/parser.ts` contains no `cheerio`, no DOM library, no regex-only whole-page parse (regex may be used **only** on already-extracted cell text).
- [ ] `npx tsc --noEmit` clean.

**Validation:**
```
npx vitest run test/parser.test.ts
npx tsc --noEmit
```
Pass = all parser tests green (expect ≥ 15 assertions incl. the 39-row total and the 744-credit asymmetry), tsc silent.

---

### Phase 3 — URL/slug resolver + fetch layer (Wave 2)

**Goal:** get the results HTML for a zip, via cached slug when possible and via the POST redirect when not.

**Dependencies:** P1 merged.

**Files owned:** `src/fetcher.ts`, `test/fetcher.test.ts`.

**Work items:**

1. `resolveAndFetch(zip, env, fetchImpl)`:
   - `POST ${env.SITE_BASE_URL}/cod_oil_prices.php` with `Content-Type: application/x-www-form-urlencoded`, body `txtzipcode=<zip>&btnsubmit=Continue`, `User-Agent: env.USER_AGENT`, `redirect: "manual"`.
   - On `301/302/303/307/308`, read `Location`, resolve it against `SITE_BASE_URL`, derive `slug` as the path with the leading `/` stripped, then `GET` it (no cookie needed — PRD §4.1) and return a `FetchedPage` with `resolved_via_post: true` and `city`/`state` from `parseSlugParts`.
   - If the POST returns 200 with a body that already contains `div.boxlisting`, accept it and derive the slug from the response URL if available, else `<zip>` — document this edge.
   - Any other outcome throws `FetchError` with the status.
2. `fetchPricesPage(zip, cachedSlug, env, fetchImpl)`:
   - If `cachedSlug` is null → `resolveAndFetch`.
   - Else `GET ${SITE_BASE_URL}/${cachedSlug}`; accept only a 200 whose body contains `class="boxlisting"`. On any other result, fall back **once** to `resolveAndFetch` (PRD §8) and return that, with `resolved_via_post: true`. If the fallback also fails, throw `FetchError`.
3. `parseSlugParts("seymour_ct_oil_prices/06483")` → `{ city: "seymour", state: "ct", zip: "06483" }`; handle multi-word cities (`garden_city_ny_oil_prices/11530` → city `garden_city`, state `ny`); return `null` on a non-matching slug.
4. Concurrency note in a code comment: callers must never exceed 6 simultaneous outbound connections (PRD §9.1). This layer issues at most 2 subrequests per call.
5. `test/fetcher.test.ts` with a hand-rolled `fetchImpl` stub (a function returning canned `Response`s and recording calls) — **no network, no mock library**:
   - cached-slug happy path: 1 GET, body from the fixture, `resolved_via_post === false`, `slug` unchanged;
   - cached slug 404 → falls back to POST → 302 → GET, exactly 3 calls, `resolved_via_post === true`;
   - cached slug returns 200 but a listing-free body → same fallback;
   - null cached slug → POST path, correct POST URL, correct `content-type`, body contains `txtzipcode=06483`;
   - POST returns 500 → rejects with `FetchError` and `status === 500`;
   - both paths fail → rejects once, and the stub was called exactly 3 times (no retry storm);
   - `parseSlugParts` table test over the four PRD §4.1 slugs plus a malformed one → `null`;
   - `User-Agent` header from `env.USER_AGENT` is present on every request.

**Definition of done:**
- [ ] Exact §2.2 signatures exported, including `FetchError`.
- [ ] Zero real network calls in tests (every test passes `fetchImpl`).
- [ ] Fallback is attempted **at most once**, asserted by call count.
- [ ] `redirect: "manual"` used so the 302 `Location` is observable.
- [ ] `npx tsc --noEmit` clean.

**Validation:**
```
npx vitest run test/fetcher.test.ts
npx tsc --noEmit
```
Pass = all fetcher tests green; run with the machine offline if you want proof of no network dependence.

---

### Phase 4 — D1 write layer (Wave 2)

**Goal:** batched, idempotent persistence and the small reads the consumer needs, inside the 50-query budget.

**Dependencies:** P1 merged.

**Files owned:** `src/db.ts`, `test/db.test.ts`.

**Work items:**

1. Implement every §2.2 `src/db.ts` export. Use `db.prepare(...).bind(...)` and a single `db.batch([...])` per `writePriceRows` call.
2. `writePriceRows` builds the SQL of §2.3 dynamically for the chunk length (so the final short chunk is a valid statement), chunking at `ROWS_PER_INSERT = 8`. Returns `{ statements, rows }`. `[]` → `{ statements: 0, rows: 0 }` with **no** D1 call.
3. Column order must exactly match §2.3's INSERT list (11 bound columns, `id` omitted).
4. `getActiveZips` selects `WHERE active = 1 ORDER BY zip` — one query. `getActiveSubscriptions` selects `WHERE zip = ? AND active = 1 ORDER BY id` — one query.
5. `updateZipSlug` / `clearZipSlug` — one statement each; `clearZipSlug` nulls both `slug` and `slug_resolved_at`.
6. Add a module comment stating the per-invocation query budget arithmetic: 1 zip read + 1 subscription read + ⌈rows/8⌉ inserts (5 for 39 rows) + 1 slug update ≈ 8 of 50 queries.
7. `test/db.test.ts` running in the Workers pool against local D1 (migrations applied by `test/setup.ts`):
   - seed a `zips` row, then `getActiveZips` returns it and omits an `active = 0` row;
   - write the 39 rows produced by hand-built `PriceRow` fixtures (do **not** import the parser — P4 must not depend on P2): assert `{ statements: 5, rows: 39 }` and `SELECT COUNT(*) = 39`;
   - **idempotence**: call `writePriceRows` twice with the same rows → still 39 rows in the table;
   - **upsert semantics**: re-write one row with a changed `price_per_gallon` and `scraped_at` → row count unchanged, the stored price is the new value;
   - a chunk-boundary test: 8 rows → 1 statement; 9 rows → 2 statements; 16 → 2; 17 → 3;
   - a 100-row write completes and issues `⌈100/8⌉ = 13` statements (proves the batching stays well under 50);
   - `writePriceRows(db, [])` returns `{statements:0, rows:0}`;
   - `gallon_max: null` round-trips as SQL NULL, not the string `"null"`;
   - `getActiveSubscriptions` filters by zip and by `active`, ordered by id;
   - `updateZipSlug` then `getZip` returns the slug/city/state/timestamp; `clearZipSlug` nulls them.

**Definition of done:**
- [ ] All §2.2 `db.ts` exports present with exact signatures; `ROWS_PER_INSERT === 8`.
- [ ] No statement ever binds more than 88 parameters (assert in a test by constructing the 8-row SQL and counting `?`).
- [ ] Double-write leaves row count unchanged and updates the mutable columns.
- [ ] `src/db.ts` imports nothing from `./parser`, `./fetcher`, or `./notify`.
- [ ] `npx tsc --noEmit` clean.

**Validation:**
```
npx wrangler d1 migrations apply heating-oil --local
npx vitest run test/db.test.ts
npx tsc --noEmit
```
Pass = all db tests green, including the `{statements: 5, rows: 39}` assertion and the idempotence pair.

---

### Phase 5 — Subscription evaluation, staleness, and ntfy (Wave 2)

**Goal:** decide what to tell the subscriber, say it correctly, and provide the operational alert channel.

**Dependencies:** P1 merged.

**Files owned:** `src/notify.ts`, `test/notify.test.ts`.

**Work items:**

1. `selectBestPrice` per the qualification rule in §2.2. It operates on `ParsedListing[]` — **no D1 access from this module**, so it stays pure and testable.
2. `isStale(listings, scrapeDate, staleAfterDays)`: take `max(price_updated_on)`; stale when `daysBetween(max, scrapeDate) > staleAfterDays`, or when no listing has a `price_updated_on`. Compute day differences on UTC dates parsed from `yyyy-mm-dd` — no date library.
3. `evaluateSubscription` composes the two into a `NotificationDecision`:
   - no qualifying tier → `no_qualifying_tier`, `should_send: false`;
   - `sub.threshold !== null && best.price_per_gallon >= sub.threshold` → `threshold_not_met`, `should_send: false`;
   - otherwise `send`. `stale` is populated in all three cases.
4. `buildNotification` must, per PRD §5.3, include in the body: price per gallon, the gallon tier it applies to (`"100–149 gal"`, or `"400+ gal"` for open-ended), payment type, delivery date, price-updated-on date, scrape date, and the zip. When `decision.stale`, prefix the title with `[STALE]` and add a line naming the last-updated date and the configured threshold. Tags: `["fuelpump"]` normally, `["warning","fuelpump"]` when stale. Priority 3 normally, 4 when stale.
5. `sendNtfy`: `POST ${env.NTFY_BASE_URL}/${topic}` with the body as the message text and `Title`, `Tags`, `Priority` headers (ntfy's plain-HTTP interface — no SDK). Wrap in try/catch; return `false` on throw or non-2xx; **never throw** (PRD §8: a failed push must not lose the already-written data).
6. `sendAlert`: same transport, fixed topic `env.NTFY_ALERT_TOPIC`, priority 4, tags `["warning"]`, title prefixed `heating-oil-tracker:`.
7. `test/notify.test.ts` — build `ParsedListing[]` fixtures **by hand** from the §1.3 table (do not import the parser; P5 must not depend on P2):
   - `min_gallons: 50, payment_type: cash` → `$5.64`, dealer 372 (the 6.00 dealer loses) — this is the exact misleading-price scenario in PRD §5.3;
   - `min_gallons: 100, cash` → `$4.84`, tie broken to dealer 11 (lowest id);
   - `min_gallons: 100, credit` → `$4.94`, dealer 11;
   - `min_gallons: 50, credit` → `$5.74`, dealer 372 (744 has no credit 50-99 tier and must not be selected);
   - `min_gallons: 500, cash` → `null` and reason `no_qualifying_tier` (no tier covers 500);
   - `min_gallons: 25` → `null` (below every tier's minimum);
   - open-ended tier `{gallon_min: 400, gallon_max: null}` matches `min_gallons: 5000`;
   - threshold `5.00` with best `4.84` → `send`; threshold `4.50` → `threshold_not_met`, `should_send: false`;
   - staleness: `price_updated_on` all `2026-09-05` with `scrape_date 2026-09-06`, N=3 → not stale; `2026-09-10`, N=3 → stale; all-null → stale; exactly N days → not stale (boundary is `>` N);
   - `buildNotification` snapshot-style assertions: body contains `4.84`, `100`, `149`, `cash`, `2026-09-08`, `2026-09-05`, the zip; stale variant title starts with `[STALE]`;
   - `sendNtfy` with a stub `fetchImpl`: correct URL `https://ntfy.sh/<topic>`, `Title`/`Priority`/`Tags` headers present, returns `true` on 200, `false` on 500, `false` (and does not throw) when the stub rejects;
   - `sendAlert` posts to `env.NTFY_ALERT_TOPIC` with priority 4.

**Definition of done:**
- [ ] All §2.2 `notify.ts` exports present with exact signatures.
- [ ] `sendNtfy` and `sendAlert` provably never throw (test with a rejecting `fetchImpl`).
- [ ] The 50-gallon → `$5.64` case is asserted verbatim.
- [ ] `src/notify.ts` imports nothing but `./types`.
- [ ] `npx tsc --noEmit` clean.

**Validation:**
```
npx vitest run test/notify.test.ts
npx tsc --noEmit
```
Pass = all notify tests green (expect ≥ 18 assertions), tsc silent.

---

### Phase 6 — Seed / admin path (Wave 2)

**Goal:** a one-command way to put zips and subscriptions into local D1, so every other phase and the operator can exercise the system.

**Dependencies:** P1 merged.

**Files owned:** `scripts/seed.mjs`, `seeds/dev-seed.sql`, `test/seed.test.ts`.
**Must not touch:** `package.json` — P1 already added the `seed:local` script entry pointing at `scripts/seed.mjs`.

**Work items:**

1. `seeds/dev-seed.sql`: idempotent (`INSERT … ON CONFLICT DO UPDATE` / `INSERT OR IGNORE`) seed containing:
   - `zips`: `06483` active with `slug = NULL` (forces a real resolution on first run) plus `06611`, `11530`, `08540` inserted **inactive** so the multi-zip path can be exercised by flipping a flag;
   - `subscriptions`: two rows for `user_id = 'v1'` on `06483` — one `min_gallons 100 / cash / threshold NULL`, one `min_gallons 50 / cash / threshold 5.50` — which together cover the interesting evaluation branches of Phase 5.
2. `scripts/seed.mjs`: a small Node script that shells out to `wrangler d1 execute heating-oil --local --file=seeds/dev-seed.sql`, forwarding `--remote` only if the operator passes it explicitly, and printing a post-seed summary (`SELECT` counts). It must refuse to run with `--remote` unless `CONFIRM_REMOTE=1` is set, so nobody seeds production by muscle memory.
3. Support ad-hoc admin operations without new files, documented in the script's `--help`:
   `node scripts/seed.mjs --add-zip 06611`, `--activate 06611`, `--deactivate 06611`, `--add-sub <zip> <topic> <min_gallons> <cash|credit> [threshold]`. Implement these as parameterised `wrangler d1 execute --command` invocations with input validation (zip must be 5 digits; payment type must be `cash|credit`) — reject anything else rather than interpolating it into SQL.
4. `test/seed.test.ts` (Workers pool, local D1): read `seeds/dev-seed.sql`, split on `;`, execute the statements against `env.DB`, then assert: 4 zip rows, exactly 1 active; 2 subscriptions for `06483`; re-running the same statements leaves the counts unchanged (idempotence); the seeded `payment_type` values pass the CHECK constraint.
5. Include a `--dry-run` flag that prints the SQL it would execute and exits 0.

**Definition of done:**
- [ ] `node scripts/seed.mjs --dry-run` prints SQL and exits 0 without touching a database.
- [ ] `node scripts/seed.mjs` populates local D1; running it twice changes no counts.
- [ ] `--remote` without `CONFIRM_REMOTE=1` exits non-zero with a clear message.
- [ ] Invalid input to `--add-zip` / `--add-sub` exits non-zero without issuing SQL.
- [ ] `test/seed.test.ts` passes.

**Validation:**
```
npx wrangler d1 migrations apply heating-oil --local
node scripts/seed.mjs --dry-run
node scripts/seed.mjs
node scripts/seed.mjs                    # second run: same counts
npx wrangler d1 execute heating-oil --local --command "SELECT COUNT(*) c FROM zips"          # 4
npx wrangler d1 execute heating-oil --local --command "SELECT COUNT(*) c FROM subscriptions" # 2
npx vitest run test/seed.test.ts
```
Pass = counts are 4 and 2 after both runs; all seed tests green.

---

### Phase 7 — Cron producer + queue consumer orchestration (Wave 3)

**Goal:** wire parser + fetcher + db + notify into the two Worker handlers, with per-zip error isolation and alerting.

**Dependencies:** P1–P6 merged.

**Files owned:** `src/index.ts` (replacing the P1 stub), `test/orchestration.test.ts`.
**Must not touch:** `wrangler.jsonc` (P1 already declares every binding this phase needs), nor any wave-2 source file. If a wave-2 module appears to have a bug, work around it in `index.ts` and report it — do not edit their files.

**Work items:**

1. `scheduled(controller, env, ctx)` — the producer, per PRD §5.1: compute `scrape_date` as the UTC date of `controller.scheduledTime`, `getActiveZips(env.DB)` (1 query), then `env.SCRAPE_QUEUE.sendBatch(zips.map(z => ({ body: { zip: z.zip, scrape_date } })))`. **No scraping, no fetching, no parsing** in this handler. Wrap in try/catch → `sendAlert` on failure. Log a one-line summary.
2. `queue(batch, env, ctx)` — iterate messages; each in its own `try/catch` so one bad zip cannot affect another; on success `msg.ack()`, on failure `msg.retry()` (bounded by `max_retries: 3` in wrangler.jsonc) after `sendAlert`.
3. `processZip(msg, env, fetchImpl)` — the whole per-zip pipeline:
   1. `getZip` → cached slug (1 query);
   2. `fetchPricesPage(zip, slug, env, fetchImpl)` (1–2 subrequests);
   3. if `page.resolved_via_post` or the slug changed → `updateZipSlug(...)` with `parseSlugParts` output (1 query);
   4. `parseListingsPage(page.html)`;
   5. **zero listings** → log, `sendAlert("no listings parsed", zip)`, write nothing, notify nobody, return `rows_written: 0` (PRD §8: a missing day beats a wrong one). This is *not* a message failure — ack it;
   6. `ParseError` → `sendAlert` with the message, ack (retrying will not fix markup drift), return `rows_written: 0`;
   7. `toPriceRows` → `writePriceRows` (⌈n/8⌉ queries);
   8. `getActiveSubscriptions(env.DB, zip)` (1 query);
   9. for each: `evaluateSubscription(listings, sub, scrape_date, Number(env.STALE_AFTER_DAYS))`; when `should_send`, `buildNotification` → `sendNtfy`. Count successes; a `false` return is logged, not thrown;
   10. `FetchError` → `clearZipSlug` (so tomorrow re-resolves), `sendAlert`, then rethrow so the message retries.
4. Keep total D1 queries per message ≤ 10 for a 39-row zip; assert this in a test by counting `prepare` calls on a wrapped D1 handle.
5. Never `await` an unnecessary sequential fetch: notifications for multiple subscriptions may be sent with `Promise.allSettled`, capped at 6 concurrent (PRD §9.1).
6. `test/orchestration.test.ts` — full local integration, no network:
   - seed one active zip `06483` with `slug = NULL` and two subscriptions;
   - stub `fetchImpl` to answer the POST with a 302, the slug GET with the **real fixture**, and any ntfy POST with 200, recording every call;
   - run `processZip({zip:"06483", scrape_date:"2026-09-06"}, env, stub)` and assert: 39 rows in `prices`, the zip's `slug` is now `seymour_ct_oil_prices/06483` with `city = "seymour"`, `state = "ct"`, and `slug_resolved_at` set, 2 ntfy POSTs recorded whose bodies contain `4.84` and `5.64` respectively;
   - re-run the same call → still 39 rows (upsert idempotence end to end);
   - fixture with the listings stripped → 0 rows written, 0 subscriber notifications, 1 alert POST to `NTFY_ALERT_TOPIC`, and the call resolves (no throw);
   - fetch stub returning 500 on both paths → `processZip` rejects, `zips.slug` has been cleared, 1 alert POST;
   - ntfy stub returning 500 → rows still written, call resolves, `notifications_sent === 0`;
   - `scheduled` with 2 active and 1 inactive zip → exactly 2 messages enqueued with the right `scrape_date`, and **zero** fetches performed by the producer;
   - `queue` with a 2-message batch where the first throws → the second still processes; first `retry()`ed, second `ack()`ed;
   - query-count guard: ≤ 10 D1 statements for the happy path.

**Definition of done:**
- [ ] `src/index.ts` default-exports `scheduled` and `queue`, and named-exports `processZip` with the §2.2 signature.
- [ ] The cron handler performs no `fetch` (asserted).
- [ ] Every message is individually try/caught; one failure does not abort the batch (asserted).
- [ ] Zero-listing and `ParseError` paths write nothing, notify nobody, and alert (asserted).
- [ ] Fetch failure clears the cached slug and rethrows for retry (asserted).
- [ ] End-to-end run against the fixture produces exactly 39 rows and is idempotent (asserted).
- [ ] `npx tsc --noEmit` clean; `npx wrangler deploy --dry-run` builds.

**Validation:**
```
npx wrangler d1 migrations apply heating-oil --local
npx vitest run                        # whole suite, all phases
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir=dist
```
Pass = full suite green, tsc silent, dry run builds without authenticating.

---

### Phase 8 — Documentation + CPU measurement procedure (Wave 3)

**Goal:** a README that gets a new machine from clone to a green local run, and the PRD §9.2 CPU measurement written up as a repeatable procedure.

**Dependencies:** P1 merged (P8 may start in wave 3 alongside P7; it documents the contracts in §2 of this plan, which are fixed, so it does not need P7's code).

**Files owned:** `README.md`, `docs/cpu-measurement.md`.
**Must not touch:** any source, test, or config file — including `docs/heating-oil-tracker-prd.md` and `docs/implementation-plan.md`.

**Work items:**

1. `README.md`:
   - one-paragraph what/why, linking the PRD;
   - prerequisites (Node 20+, no Cloudflare account needed for local work);
   - local quickstart: `npm install` → `node scripts/extract-fixture.mjs` → `npx wrangler d1 migrations apply heating-oil --local` → `node scripts/seed.mjs` → `npx vitest run`;
   - how to exercise the Worker locally: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+12+*+*+*"`, plus a note that local Queues run in miniflare and the consumer fires automatically;
   - inspecting data: the three `wrangler d1 execute --local --command` queries a human actually wants (today's rows, cheapest per tier, distinct dealer ids);
   - admin recipes: adding a zip, adding a subscription, pausing a zip (`scripts/seed.mjs` flags);
   - architecture section: the cron→queue→consumer diagram in prose, and why one zip per invocation (cite PRD §5.1/§9.1);
   - a table of the `Env` vars from §2.1 with defaults and which must change before deploy (`NTFY_ALERT_TOPIC`, `database_id`);
   - **deploy instructions, clearly marked "not executed by this project's build":** `wrangler login`, `wrangler d1 create heating-oil`, paste the real `database_id`, `wrangler queues create heating-oil-scrape`, `wrangler d1 migrations apply heating-oil --remote`, `wrangler deploy`, then verify via the Workers observability CPU metric;
   - a "known limits" box restating the four binding free-tier numbers (10 ms CPU, 50 D1 queries, 50 subrequests, 6 connections);
   - a troubleshooting section covering the three PRD §8 failure modes and what each looks like in the alert topic.
2. `docs/cpu-measurement.md` — the PRD §9.2 action item, written as a procedure someone runs in 15 minutes:
   - **Local measurement:** run `npx wrangler dev`, trigger the scheduled handler, and read the CPU time reported in the `wrangler dev` request log; repeat 10x and record the median. Note the caveat that local CPU is indicative, not authoritative.
   - **In-process measurement:** a copy-pasteable snippet using `performance.now()` around `parseListingsPage(fixture)` only, run via `npx vitest run` with the fixture, to isolate parse cost from I/O. Record the number in a results table in the same file.
   - **Authoritative measurement (deploy-time, out of scope here):** the Workers observability CPU-time metric for the queue consumer, after a real deploy.
   - **Decision rule:** if median parse CPU < 3 ms, HTMLRewriter is settled and no change is needed; 3–7 ms, keep HTMLRewriter and re-measure before adding zips; > 7 ms, open a follow-up to split parsing across messages. Note explicitly that Cheerio stays rejected regardless, because it would also require `nodejs_compat`.
   - A results table with columns `date | environment | median ms | p95 ms | notes`, pre-filled with one blank row.
   - A closing line: this document does not block any phase; it is run once after Phase 7 merges.

**Definition of done:**
- [ ] `README.md` exists and its quickstart command sequence works verbatim on a clean clone.
- [ ] Deploy steps are present and explicitly marked as not performed/not verified by this project.
- [ ] `docs/cpu-measurement.md` contains both measurement procedures, the decision rule, and an empty results table.
- [ ] No file outside the two owned paths is modified (`git status` shows exactly 2 files).

**Validation:**
```
git status --porcelain        # exactly two entries: README.md, docs/cpu-measurement.md
```
Then a reviewer executes the README quickstart verbatim on a fresh clone: `npm install && node scripts/extract-fixture.mjs && npx wrangler d1 migrations apply heating-oil --local && node scripts/seed.mjs && npx vitest run` — pass = every command exits 0 and the suite is green with no undocumented extra step.

---

## 6. Explicitly out of scope (verifiable only at deploy time)

These cannot be tested locally and **must not** be treated as phase blockers or definition-of-done items:

1. **Real cron firing** on Cloudflare's schedule. Locally we only prove the handler works when invoked (`--test-scheduled`).
2. **Real Queues delivery, retry, and the 24-hour retention window.** Miniflare's queue is a faithful-enough local stand-in for handler logic, not for delivery semantics or free-tier accounting.
3. **Actual CPU time against the 10 ms free-tier ceiling.** Local numbers are indicative only; the authoritative figure is the Workers observability metric (Phase 8, §9.2).
4. **The live site's current markup.** Every parser assertion is against the 2026-09-05 capture. Markup drift is detected in production by the alert path of PRD §8, not by these tests.
5. **Real ntfy delivery to an Android handset**, including topic subscription and notification rendering.
6. **Remote D1** — creation, `database_id`, remote migrations, and the daily row/storage limits.
7. **`dealerid` stability across a genuine price change** (PRD §4.5 caveat) — needs a week or two of real accumulated data.

---

## 7. Assumptions and open questions

**A1. The page has 39 price points, not ~44.** PRD §4.3 says "roughly 44"; the fixture holds exactly 20 cash + 19 credit = 39, because dealer 744 has no credit `50-99` tier. All row-count assertions in this plan use **39**. The PRD's capacity arithmetic is unaffected (39 < 44 is more headroom, and 39 rows → 5 INSERT statements rather than 6).

**A2. `Same Day Charges` is always present and always `$ 0.00` in this fixture.** The parser treats it as optional (`null` when absent) rather than assuming it. Non-zero values are untested against real markup.

**A3. Open-ended gallon tiers (`400+`) do not occur in the fixture.** Support is implemented and unit-tested against synthetic input only, because it is cheap and the site plausibly uses it in other zips.

**A4. `city`/`state` come from the slug, not the page.** PRD §6 says "parsed from the slug", and the slug is available on every path, so the parser does not read the page's State/City metadata table. Slug-derived values are lowercase (`seymour`, `ct`) — no title-casing is applied, to avoid guessing at multi-word city capitalisation.

**A5. Staleness needs no historical read.** PRD §5.4 says "has not advanced in more than N days"; that is computable from today's `max(price_updated_on)` versus `scrape_date` alone. This keeps `isStale` pure and saves a D1 query. If a future requirement is truly "did not advance *relative to yesterday's observation*", it needs a `prices` read and a signature change — flagged, not built.

**A6. `scrape_date` is the UTC date of the cron's `scheduledTime`.** With a 12:00 UTC cron this is unambiguous for a US-Eastern user. If the operator later wants a local-date semantic, it is a one-line change in the producer, but it must be made *before* data accumulates.

**A7. Tie-break is lowest `dealer_id`.** Several dealers offer identical prices (four at `4.84`, four at `5.19`), so an unspecified tie-break would make notification tests flaky. This is a test-determinism choice, not a product statement about which dealer is "best".

**A8. ntfy topics are treated as non-secret** and live in `wrangler.jsonc` `vars`, matching ntfy's own security model (a topic name *is* the credential). If the operator wants them hidden, they move to `wrangler secret` — a config-only change, noted in the README.

**A9. `max_batch_size: 1`** on the consumer is what makes "one zip per invocation" (PRD §5.1) actually true. A larger batch would silently reintroduce the shared-budget failure mode the PRD rejects.

**Open question O1.** PRD §8 says a cached slug that stops returning listings should "retry once via the POST path before treating it as a failed zip", but does not say whether a *successful* re-resolution to a *different* slug should be recorded silently or alerted. This plan records it silently and logs it. If the operator wants an alert on slug change, it is one line in `processZip`.

**Open question O2.** Whether a subscription with a `threshold` should send a "no longer below threshold" notification when a previously-qualifying price rises. This plan sends nothing (`threshold_not_met`, silent), per a literal reading of PRD §6 ("notify only when the qualifying price falls below it").
