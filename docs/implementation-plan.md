# Implementation Plan: Heating Oil Price Tracker

**Source of truth:** `docs/heating-oil-tracker-prd.md`
**Fixture of record:** `docs/view-source_https___www.cashheatingoil.com_seymour_ct_oil_prices_06483.html`
**Plan status:** ready for parallel execution — 9 phases in 4 waves, ending in a real Cloudflare deploy
**Date:** 2026-09-06

---

## 0. How this plan is executed

This plan is written for **multiple independent AI coding agents running simultaneously**, each in its own git worktree, each doing **exactly one phase**, with **no communication between them**. Branches are merged after each wave.

Rules every executing agent must follow:

1. **Do only your phase.** Do not create, rename, or "fix" files outside your phase's *Files owned* list. If something you need is missing and it belongs to another phase, write your code against the contract in §2 of this document and assume the other agent produced it.
2. **Waves are merge barriers.** A wave-*k* worktree branches from the merge commit of waves 1..*k*-1. Within a wave, no two phases write the same file — this is enforced by the *Files owned* lists.
3. **§2 is law.** All shared types, file paths, export names, and function signatures in §2 are copied verbatim into `src/types.ts` by Phase 1. Downstream phases import from `../src/types` (or `./types`). **Do not "improve" a signature** — a rename here is what breaks the merge.
4. **Config files have exactly one owner.** `package.json`, `package-lock.json`, `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `test/setup.ts`, `test/env.d.ts`, `worker-configuration.d.ts` are owned by **Phase 1 only**. Every other phase assumes they exist and must not create or edit them. If your phase seems to need a new npm dependency, it does not — see §3.
5. **Phases 1–8 are offline. Only Phase 9 touches the network or a Cloudflare account.** Nothing in phases 1–8 requires a Cloudflare account, `wrangler login`, or a request to `cashheatingoil.com` or `ntfy.sh`. All wave 1–4 validation except Phase 9's runs locally against miniflare's local D1 and the saved HTML fixture. Phase 9 (wave 4) is the single phase that deploys for real and verifies a live ntfy push; it is executed by an agent that already holds credentials. §6 lists what remains unverifiable even after Phase 9.
6. **One command per line in every validation block.** This machine's shell is Windows PowerShell 5.1, where `&&` is a parse error. Never chain commands. Prefer `npm run <script>` over invoking a binary directly, so the local `node_modules/.bin` resolution works identically on every platform.
7. **`.npmrc` is not owned by any phase.** A project-local `.npmrc` already exists at the repo root containing:
   ```
   script-shell=cmd.exe
   legacy-peer-deps=true
   ```
   Do not edit it, delete it, or "clean it up". `script-shell=cmd.exe` is required because this machine's global npm config points `script-shell` at `pwsh`, which is not installed. `legacy-peer-deps=true` is required because npm 11.5.1 crashes with `Cannot read properties of null (reading 'edgesOut')` while resolving vitest 4's peer graph without it.

---

## 1. Recon: verified structure of the results page

These facts were extracted from the saved 06483 page (2026-09-05 capture) and are **binding on the parser**. The saved file in `docs/` is a Chrome *view-source* wrapper (173 KB of `<td class="line-content">` rows); Phase 1 de-wraps it into `test/fixtures/06483.html`.

**The de-wrapped document is not identified by a byte count.** It is 33,065 code points but 33,077 UTF-8 bytes — four U+1F525 characters in the page account for the difference — so any assertion phrased as "N bytes" is ambiguous and is deliberately not used anywhere in this plan. The fixture's identity is asserted **structurally** (§5, Phase 1, item 10) and pinned by a SHA-256 recorded once Phase 1 has generated it.

Note also that the view-source wrapper is a **syntax-highlighted** rendering. Each `td.line-content` contains `<span class="html-tag">`, `<span class="html-attribute-name">`, and friends wrapping the real markup. De-wrapping therefore means stripping that `<span class="html-*">` scaffolding and HTML-unescaping the result — **not** merely reading `td.line-content`'s text content, and not a naive "strip all tags" pass over the whole file.

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
- Text handlers deliver **chunks**. Accumulate into a buffer as chunks arrive.
- **`text.lastInTextNode` marks the end of one lexical text node, not the end of the enclosing element.** An element whose content is interrupted by a child (`<td>4.84 <b>x</b></td>`) or by an entity boundary produces several text nodes, each with its own `lastInTextNode: true`. So use `lastInTextNode` only to close off *one chunk run*; **finalise a label's or a cell's complete value in that element's `onEndTag()` handler**, where the whole element is provably done. Concretely: register `element.onEndTag()` on `label.formtxt`, `label.varlabel`, and every `table.paywithcash td` / `table.paybycredit td`, and commit the accumulated buffer there.
- Scope to a listing with `element.onEndTag()` on the `div.boxlisting` handler — HTMLRewriter matches the correct closing tag despite the nested `div.rating` / `div.varaboutus`.
- Supported selector subset covers everything needed here: `div.boxlisting`, `input[name="dealerid"]`, `table.paywithcash td`, `label.formtxt`, `label.varlabel`. Do **not** rely on `:nth-child` ordering across `tr`s; use the pairing rule from §1.2.
- **`&nbsp;` does NOT arrive as U+00A0.** HTMLRewriter does not decode HTML entities in text chunks: a `&nbsp;` in the source is delivered as the six literal characters `&`,`n`,`b`,`s`,`p`,`;`. The parser must decode the entities this page uses (`&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`) itself before matching, then fold U+00A0 and whitespace runs to single spaces. This was verified the hard way: with the original assumption every `label.formtxt` caption key came out as `"price updated on&nbsp;:&nbsp;"`, so `price_updated_on` and `same_day_charge` were silently `null` on all five listings.

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

/** One row of the `prices` table. 11 bound columns -> 8 rows = 88 params per multi-row INSERT. */
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
  /**
   * "seymour_ct_oil_prices/06483", no leading slash.
   * null when the page was obtained without a trustworthy slug (the POST-returns-200
   * edge case). A null slug must never be cached — see Phase 3, work item 1.
   */
  slug: string | null;
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

/**
 * Max rows per multi-row INSERT. A PriceRow binds 11 columns (`id` is AUTOINCREMENT and
 * is not bound), so 8 rows = 88 bound parameters against D1's 100-parameter cap.
 * 9 rows (99 params) would also fit; 8 is kept as a deliberate conservative choice that
 * leaves one row of margin, and because every row-count assertion in this plan
 * (39 rows -> 5 statements) is derived from it.
 */
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
 * Replaces the day's data for one (scrape_date, zip). In a single db.batch():
 *   1. DELETE FROM prices WHERE scrape_date = ? AND zip = ?
 *   2. the rows chunked into groups of ROWS_PER_INSERT, one multi-row
 *      INSERT ... ON CONFLICT DO UPDATE per chunk.
 * All rows must share one (scrape_date, zip); throws if they do not.
 * `statements` counts the DELETE. Writing [] is a no-op that issues zero queries
 * (no DELETE either — there is no key to delete by).
 */
export function writePriceRows(
  db: D1Database,
  rows: PriceRow[],
): Promise<{ statements: number; rows: number }>;

export function getActiveSubscriptions(
  db: D1Database,
  zip: string,
): Promise<Subscription[]>;

/** true when a notification for this (scrape_date, subscription) has already been sent. */
export function wasNotified(
  db: D1Database,
  scrapeDate: string,
  subscriptionId: number,
): Promise<boolean>;

/** Records a sent notification. Idempotent: a second call for the same key is a no-op
 *  (INSERT ... ON CONFLICT DO NOTHING) and must not throw. */
export function recordNotified(
  db: D1Database,
  scrapeDate: string,
  subscriptionId: number,
  fingerprint: string,
  sentAt: string,
): Promise<void>;
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

/**
 * Stable, pure fingerprint of what a notification would say, over exactly:
 * dealer_id, payment_type, gallon_min, price_per_gallon, stale.
 * Used as the dedupe value in the `notifications` table. Must be deterministic
 * across processes — no Date.now(), no object key iteration order dependence.
 */
export function notificationFingerprint(decision: NotificationDecision): string;

/**
 * POSTs to `${env.NTFY_BASE_URL}/${encodeURIComponent(topic)}`.
 * Rejects (returns false, never throws) a topic not matching /^[A-Za-z0-9_-]{1,64}$/
 * before issuing any request. Never throws; returns false on failure (PRD 8).
 */
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

/** The complete, exhaustive result shape. Every branch returns all four fields. */
export interface ProcessZipResult {
  zip: string;
  rows_written: number;
  notifications_sent: number;
  stale: boolean;
}

/**
 * Exported for direct unit testing; processes exactly one zip end to end.
 * NEVER sends an alert itself — it throws typed errors (FetchError, ParseError) and
 * returns structured results. The queue() handler is the only caller of sendAlert.
 */
export function processZip(
  msg: ScrapeMessage,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<ProcessZipResult>;
```

`processZip`'s branches are exhaustively specified in Phase 7, work item 4. There is nothing left for an implementing agent to invent.

### 2.3 `migrations/0001_init.sql` (Phase 1 writes verbatim)

```sql
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
```

The write Phase 4 must emit is a **replace**, not a bare upsert. Every `writePriceRows` call
issues, first in the same `db.batch()`:

```sql
DELETE FROM prices WHERE scrape_date = ? AND zip = ?;
```

then the chunked inserts (illustrative, 2-row form):

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

`id` is `AUTOINCREMENT` and is not bound, so a `PriceRow` binds **11** columns, not 12. 8 rows = **88** bound parameters, under D1's 100-parameter cap with room for a 9th row (99). `ROWS_PER_INSERT = 8` is a deliberate conservative choice, not a hard ceiling; PRD §9.3's "12 columns" figure counts `id`, which is never bound, and is corrected here.

The `ON CONFLICT DO UPDATE` clause is retained even though the `DELETE` runs first: it makes each individual statement safe under a partial batch and keeps the same SQL valid if the delete-first policy is ever relaxed. The `DELETE` is what makes a rerun a true **replace** — a gallon tier that disappears from the site must not survive as a stale row from the morning's run.

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
    "NTFY_ALERT_TOPIC": "heating-oil-alerts-placeholder",
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

`max_batch_size: 1` is deliberate: it preserves the one-zip-per-invocation CPU/D1 budget guarantee of PRD §5.1. `database_id` is a placeholder — local D1 ignores it. **Phase 9 replaces it with the real id after `wrangler d1 create`; that one line is the single sanctioned cross-phase edit in this plan** (see Phase 9).

`NTFY_ALERT_TOPIC`'s value here is a **non-sensitive placeholder that is never the real topic**. On unauthenticated ntfy the topic name *is* the credential (see assumption A8), so the real alert topic must never appear in a committed file. It is supplied:

- **in production** by `wrangler secret put NTFY_ALERT_TOPIC` (a secret of the same name overrides the `vars` entry), done in Phase 9;
- **locally** by `.dev.vars` (gitignored) if the operator wants real local alerts — otherwise the placeholder stands and every local test stubs `fetch` anyway.

Subscriber topics are never in config at all: they live only in D1's `subscriptions.ntfy_topic`.

---

## 3. Dependencies (complete list — no others may be added)

| Package | Version | Kind | One-line justification |
|---|---|---|---|
| `wrangler` | `^4.129.0` | dev | The only way to run local D1 migrations, `dev`, `types`, and a dry-run build. |
| `typescript` | latest 5.x | dev | The project is TypeScript; `tsc --noEmit` is a validation gate in every phase. |
| `vitest` | `^4.1.0` | dev | Test runner mandated by the plan's validation commands. **Not 5.x** — `@cloudflare/vitest-plugin` peer-requires `^4.1.0`. |
| `@cloudflare/vitest-plugin` | `^1.1.4` | dev | Runs tests inside workerd so `HTMLRewriter`, D1, and Queues are the real implementations, not mocks. |
| `@cloudflare/workers-types` | latest | dev | Type declarations for `D1Database`, `Queue`, `MessageBatch`, `HTMLRewriter`. |

All five are **devDependencies**, all pinned with a caret exactly as above, and `package-lock.json` is **committed** so every worktree resolves the same tree.

> **`@cloudflare/vitest-pool-workers` is superseded and must not be used.** The `defineWorkersConfig` entry point it provided is gone. The replacement is `@cloudflare/vitest-plugin`'s `cloudflareTest()` plugin, shown verbatim in Phase 1. The exact setup in Phase 1 was empirically run on this machine and passed: two tests green, covering local D1 with migrations applied plus the `scheduled()` and `queue()` handlers driven through `createScheduledController` / `createMessageBatch` / `getQueueResult`.

**The test-facing contract downstream phases may rely on** (all verified against the working setup): the import specifier is still `cloudflare:test`, and it exports `env`, `applyD1Migrations`, `createExecutionContext`, `waitOnExecutionContext`, `createScheduledController`, `createMessageBatch`, `getQueueResult`, `SELF`, and `fetchMock`. Storage is isolated **per test file, not per test**: inside one file, D1 writes survive from one `it()` to the next. Phase 1's `test/setup.ts` therefore registers a global `beforeEach` that deletes every table child-first and resets the `sqlite_sequence` rows for `prices` and `subscriptions`. It runs for every test file in the project, so no phase needs to write its own cleanup — and no phase can be broken by another phase forgetting to. Do not add a competing reset hook.

**Zero runtime dependencies.** No Cheerio (PRD §9.2), no date library (§1.2's date format is a 12-entry month map), no HTTP client (`fetch` is built in), no ntfy SDK (ntfy is a plain `POST`), no test-mock library (inject `fetchImpl`).

---

## 4. Wave / phase overview

| Wave | Phase | Goal | Depends on |
|---|---|---|---|
| 1 | **P1 Foundation** | Repo skeleton, config, shared types, D1 migration, de-wrapped HTML fixture, test harness | — |
| 2 | **P2 Parser** | `parseListingsPage` over the real fixture | P1 |
| 2 | **P3 Fetch/slug** | POST-and-follow-redirect resolver + cached-slug fetch with fallback | P1 |
| 2 | **P4 D1 write layer** | Batched delete-then-multi-row-insert day replace + zip/subscription reads + notification dedupe | P1 |
| 2 | **P5 Notify/eval** | Tier selection, staleness, ntfy message build + transport + alerts | P1 |
| 2 | **P6 Seed/admin** | Local seeding of zips and subscriptions; dev ergonomics | P1 |
| 3 | **P7 Orchestration** | Cron producer + queue consumer wiring everything, with per-zip error isolation | P1–P6 |
| 4 | **P8 Docs + CPU** | README (local dev + deploy), CPU-measurement procedure (PRD §9.2) | P1–P7 |
| 4 | **P9 Deploy + live verification** | Real Cloudflare deploy; live ntfy push to `yazan-06483-oil`; authoritative CPU figure | P1–P7 |

P2–P6 run **simultaneously** in wave 2. **Wave 3 is Phase 7 alone.** P8 and P9 run **simultaneously** in wave 4, after P7 merges.

P8 moved out of wave 3 deliberately: it documents behaviour (the README quickstart, the troubleshooting table, the CPU procedure) that does not exist until P7 merges, and its old gate — "`git status` shows two files" — would pass on entirely wrong documentation. Its gate in wave 4 is an executable one (§5, Phase 8).

File-ownership map (no intra-wave overlap):

```
P1  package.json  package-lock.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
    .gitignore  .dev.vars.example  worker-configuration.d.ts  src/types.ts
    src/index.ts(stub)  migrations/0001_init.sql  scripts/extract-fixture.mjs
    test/fixtures/06483.html  test/setup.ts  test/env.d.ts  test/foundation.test.ts
P2  src/parser.ts            test/parser.test.ts
P3  src/fetcher.ts           test/fetcher.test.ts
P4  src/db.ts                test/db.test.ts
P5  src/notify.ts            test/notify.test.ts
P6  scripts/seed.mjs  seeds/dev-seed.sql  test/seed.test.ts
P7  src/index.ts (replaces P1 stub)  test/orchestration.test.ts
P8  README.md  docs/cpu-measurement.md  scripts/smoke-quickstart.mjs
P9  docs/deployment-log.md  + the one-line `database_id` value in wrangler.jsonc
```

Note: `.npmrc` appears in no phase's list — it is pre-existing and unowned (§0 rule 7). Phase 9's `database_id` edit is the only cross-phase file edit anywhere in this plan, and it is safe because it happens after every merge and touches a single value P1 wrote as a placeholder.

---

## 5. Phases

---

### Phase 1 — Foundation (Wave 1)

**Goal:** stand up the repo, the config, the shared type contracts, the D1 migration, and the real HTML fixture, so that all of wave 2 can code against stable interfaces without touching each other.

**Dependencies:** none.

**Files owned (create):**
```
package.json
package-lock.json            (generated by npm install, committed)
tsconfig.json
wrangler.jsonc
vitest.config.ts
.gitignore
.dev.vars.example
worker-configuration.d.ts    (generated by `npx wrangler types`, committed)
src/types.ts
src/index.ts                 (minimal stub, replaced by P7)
migrations/0001_init.sql
scripts/extract-fixture.mjs
test/fixtures/06483.html     (generated, committed)
test/setup.ts
test/env.d.ts
test/foundation.test.ts
```

**Do not create or edit `.npmrc`.** It already exists and is unowned — see §0 rule 7.

**The single most important deliverable of this phase is a green `npx vitest run`.** All of wave 2 depends on the harness working; a Phase 1 that ships config which has never been executed hands five parallel agents a broken foundation with no way to tell whose fault it is.

**Work items:**

1. `package.json`: `"type": "module"`, `"private": true`, devDependencies exactly as §3 (five, all with the pinned caret ranges given there), and scripts:
   `test` → `vitest run`, `typecheck` → `tsc --noEmit`, `migrate:local` → `wrangler d1 migrations apply heating-oil --local`, `dryrun` → `wrangler deploy --dry-run --outdir=dist`, `fixture` → `node scripts/extract-fixture.mjs`, `cf-types` → `wrangler types`, `seed:local` → `node scripts/seed.mjs`, `seed:dry` → `node scripts/seed.mjs --dry-run`, `smoke` → `node scripts/smoke-quickstart.mjs` (the `seed.mjs` script arrives in P6 and `smoke-quickstart.mjs` in P8; the script *entries* are written now so neither phase needs to touch `package.json`).
   Every other phase's validation block invokes these via `npm run <script>` rather than a bare binary, so `node_modules/.bin` resolution is identical on Windows and POSIX.
2. `tsconfig.json`: `target/lib ES2022`, `module`/`moduleResolution` `Bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`, `types: ["@cloudflare/workers-types"]`, `include: ["src/**/*.ts", "test/**/*.ts", "worker-configuration.d.ts"]`.
3. `wrangler.jsonc` — copy §2.4 verbatim.
4. `vitest.config.ts` — write **exactly** this. It is the verified-working configuration; do not substitute `defineWorkersConfig`, which no longer exists:
   ```ts
   import { defineConfig } from "vitest/config";
   import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

   const migrations = await readD1Migrations("./migrations");

   export default defineConfig({
     plugins: [
       cloudflareTest({
         wrangler: { configPath: "./wrangler.jsonc" },
         miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
       }),
     ],
     test: { setupFiles: ["./test/setup.ts"] },
   });
   ```
5. `test/setup.ts` — write **exactly** this:
   ```ts
   import { applyD1Migrations, env } from "cloudflare:test";
   await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
   ```
6. **Env typing.** Under `@cloudflare/vitest-plugin`, `env` from `cloudflare:test` is typed as `Cloudflare.Env`. Run `npx wrangler types` to generate `worker-configuration.d.ts` — which declares `namespace Cloudflare { interface Env … }` from the bindings and vars in `wrangler.jsonc` — and **commit it**. Then `test/env.d.ts` adds only the test-only binding that wrangler cannot know about:
   ```ts
   declare namespace Cloudflare {
     interface Env {
       TEST_MIGRATIONS: D1Migration[];
     }
   }
   ```
   `src/types.ts`'s hand-written `Env` interface (§2.1) remains the contract the source modules import; it and the generated `Cloudflare.Env` describe the same bindings and must stay in agreement.
7. `src/types.ts` — copy §2.1 verbatim, no additions.
8. `migrations/0001_init.sql` — copy §2.3 verbatim.
9. `src/index.ts` stub: default export with `scheduled` and `queue` handlers that are `async` no-ops returning `undefined`, plus a `// replaced in Phase 7` comment. It must typecheck against `Env` and `ScrapeMessage`.
10. `scripts/extract-fixture.mjs`: reads the view-source file in `docs/` and de-wraps it into `test/fixtures/06483.html`. Per §1, the wrapper is **syntax-highlighted**, so de-wrapping means: take each `<td class="line-content">…</td>` body, strip the `<span class="html-*">…</span>` scaffolding, HTML-unescape the remainder, and join the lines with `\n`. Write the file as **UTF-8 with LF line endings** (no BOM, no CRLF — this machine is Windows and Node will not do it for you). Do **not** assert a byte count. Instead assert, exiting non-zero on any failure:
    - exactly **5** `div.boxlisting`;
    - exactly **10** `dealerid` hidden inputs, whose values in document order are `[11, 11, 372, 372, 744, 744, 345, 345, 919, 919]`;
    - exactly **5** `paywithcash` tables and **5** `paybycredit` tables;
    - exactly **39** gallon-tier labels, distributed `50-99`×3, `100-149`×6, `150-199`×10, `200-299`×10, `300-399`×10;
    - exactly **39** price strings, distributed `$4.84`×12, `$4.94`×12, `$5.19`×12, `$5.64`×1, `$5.74`×1, `$6.00`×1.

    (These five were verified directly against the raw file and are the fixture's identity.) The script must also **print the SHA-256 of the written file**. It must be idempotent: two runs produce a byte-identical file and the same hash.

    **Record the hash here once Phase 1 has run the script:**

    > `test/fixtures/06483.html` SHA-256 = `9778aa32b94a125dcda6fd5ad1f2f6a3b85492e597946614f7809e779adf334d`  *(filled in — Phase 1)*
11. `.dev.vars.example`: document the local-only overrides. In v1 there is exactly one that matters — `NTFY_ALERT_TOPIC`. Note in the file that on unauthenticated ntfy the topic name *is* the credential, that `.dev.vars` is gitignored, and that the placeholder in `wrangler.jsonc` is deliberately not the real topic.
12. `.gitignore`: `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`, `*.log`, `.worktrees/`, `docs/deployment-log.md`. (`package-lock.json` is **not** ignored — it is committed.)
13. `test/foundation.test.ts`: (a) the fixture exists and satisfies every structural assertion of item 10 (5 `div.boxlisting`, 10 `dealerid` inputs in the stated order, 5 + 5 price tables, the 39/39 tier and price distributions) — **no byte-count assertion**; (b) migration applied — insert one `zips` row and one `prices` row, then assert a duplicate `(scrape_date, zip, dealer_id, payment_type, gallon_min)` insert raises a constraint error while the same insert with `ON CONFLICT … DO UPDATE` succeeds and leaves exactly 1 row; (c) `subscriptions.payment_type = 'debit'` is rejected by the CHECK constraint; (d) the new CHECK constraints bite — a 4-digit `zips.zip`, an `active = 2`, a `prices.price_per_gallon = 0`, a `gallon_max` below `gallon_min`, and a `scrape_date` of `"2026-9-6"` are each rejected; (e) `ux_subs_natural` rejects a second subscription with the same `(user_id, zip, ntfy_topic, payment_type, min_gallons)`; (f) the `notifications` table exists and a second insert with the same `(scrape_date, subscription_id)` conflicts.

**Definition of done:**
- [ ] `npm install` succeeds with exactly the five devDependencies of §3 at the pinned ranges and zero runtime dependencies, and `package-lock.json` is committed.
- [ ] `test/fixtures/06483.html` is committed as UTF-8/LF and satisfies every structural assertion of item 10; its SHA-256 is recorded in item 10 of this phase.
- [ ] `src/types.ts` exports every symbol listed in §2.1 with identical names and shapes.
- [ ] `migrations/0001_init.sql` matches §2.3 — including every CHECK constraint, `ux_subs_natural`, and the `notifications` table — and applies cleanly to a fresh local D1.
- [ ] `wrangler.jsonc` declares the `DB` D1 binding, the `SCRAPE_QUEUE` producer, the `heating-oil-scrape` consumer with `max_batch_size: 1`, one cron trigger, and all five `vars`.
- [ ] `worker-configuration.d.ts` is generated and committed; `test/env.d.ts` augments `Cloudflare.Env` with `TEST_MIGRATIONS`.
- [ ] `npm run typecheck` is clean.
- [ ] **`npx vitest run` was actually executed and is green** with at least the six foundation test groups. This is the phase's single most important deliverable — do not merge on a config that has never been run.

**Validation** (one command per line; never chain with `&&`):
```
npm install
npm run fixture
npm run cf-types
npm run typecheck
npm run migrate:local
npx vitest run test/foundation.test.ts
npm run dryrun
```
Pass = every command exits 0; `npm run fixture` prints the 5/10/5/5/39/39 structural counts and a SHA-256; `npm run migrate:local` reports `Migrations applied: 0001_init.sql`; the dry run must **not** prompt for login.

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
   - **Text finalisation, per §1.4:** text handlers accumulate chunks; `text.lastInTextNode` closes off *one lexical text node*, **not** the enclosing element. Finalise a label's or a cell's complete value in that element's `onEndTag()` handler. An implementation that treats `lastInTextNode` as "the element is done" silently truncates any value split across text nodes. All values pass through an NBSP-normalising trim at finalisation time.
   - **Max input guard:** `parseListingsPage` rejects with `ParseError` when `html.length` exceeds 2 MB, before doing any work. A results page for this site is ~33 KB; anything two orders of magnitude larger is an error page, a redirect loop, or an attack, and must not be fed to the state machine.
2. Normalise: `enumtype` `Cash`→`cash`, `Credit`→`credit`; price `"$4.84"`→`4.84`; same-day `"$ 0.00"`→`0`; `"50-99"`→`{min:50,max:99}`; `"400+"`→`{min:400,max:null}`.
3. Implement `parseHumanDate("Sep 5th 2026") -> "2026-09-05"` with a 12-entry month map and an ordinal-suffix strip; return `null` on anything else.
4. Prefer `earlistdate` for `delivery_date`; fall back to `parseHumanDate` of the `Delivery Date` label; else `null`.
5. Defensive rules — each throws `ParseError` with a message **naming the listing index**:
   - a `boxlisting` finishing with no `dealer_id`;
   - the two `dealerid` values inside one listing disagreeing;
   - `enumtype` disagreeing with the price table's class;
   - a `boxlisting` finishing with zero tiers;
   - a listing **not containing exactly two** `form[action="tranction.php"]`;
   - a form **missing** `dealerid` or `enumtype`, or carrying **more than one** of either;
   - the two forms of a listing **not being one `cash` and one `credit`** (two cash forms, or two credit forms, is a structural change, not a valid page);
   - a **duplicate `(payment_type, gallon_min)` tier** within one listing;
   - a tier cell pair where the **gallons cell matches but the price cell does not**. Previously this was silently skipped; that is unsafe, because a dropped tier could hide the actual cheapest price and the subscriber would be told a higher number with no indication anything was lost. A gallons cell with no valid price beside it is a parse error.
   - input larger than 2 MB (work item 1).

   A page with **zero** `div.boxlisting` returns `[]` (not an error) — PRD §8 makes the caller decide. Note that a cell pair where **neither** cell matches (the two header rows, the "Click to Order" row) is still skipped silently; only a *half*-match is an error.
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
   - one negative test per new rule in item 5, each built by mutating the fixture string and each asserting the thrown `ParseError`'s message contains the offending listing index: a listing with one form removed; a form with a second `enumtype` added; a listing whose credit form's `enumtype` is rewritten to `Cash`; a listing with a tier row duplicated; a listing where a price cell's `$4.84` is replaced with `TBD` while the gallons cell is left intact;
   - `parseListingsPage` of a 3 MB string rejects with `ParseError` and does so quickly (the guard runs before parsing);
   - `parseHumanDate` table test: `"Sep 5th 2026"`, `"Jan 1st 2027"`, `"Mar 3rd 2026"`, `"Dec 22nd 2026"`, and `"garbage"` → `null`.
8. Add a `console.time`-free micro-benchmark test that parses the fixture 1x and asserts it resolves — no timing assertion (timing lives in P8's CPU procedure).

**Definition of done:**
- [ ] `parseListingsPage` and `toPriceRows` exported with the exact §2.2 signatures.
- [ ] No import of any package outside `./types` — HTMLRewriter is a global.
- [ ] All assertions in item 7 present and passing.
- [ ] Every value is finalised in an `onEndTag()` handler, not on `lastInTextNode` (grep the source: `lastInTextNode` must never be the trigger for pushing a completed value).
- [ ] Every defensive rule in item 5 has a matching negative test.
- [ ] `src/parser.ts` contains no `cheerio`, no DOM library, no regex-only whole-page parse (regex may be used **only** on already-extracted cell text).
- [ ] `npm run typecheck` clean.

**Validation** (one command per line):
```
npx vitest run test/parser.test.ts
npm run typecheck
```
Pass = all parser tests green (expect ≥ 25 assertions incl. the 39-row total, the 744-credit asymmetry, and the negative tests), tsc silent.

---

### Phase 3 — URL/slug resolver + fetch layer (Wave 2)

**Goal:** get the results HTML for a zip, via cached slug when possible and via the POST redirect when not.

**Dependencies:** P1 merged.

**Files owned:** `src/fetcher.ts`, `test/fetcher.test.ts`.

**Work items:**

This module is the project's only attack surface that touches an untrusted remote, so work items 1–4 below are **security requirements, not polish**. An implementation that follows a `Location` header without validating it is a server-side request forgery primitive with a Cloudflare Worker's network position.

1. `resolveAndFetch(zip, env, fetchImpl)`:
   - `POST ${env.SITE_BASE_URL}/cod_oil_prices.php` with `Content-Type: application/x-www-form-urlencoded`, body `txtzipcode=<zip>&btnsubmit=Continue`, `User-Agent: env.USER_AGENT`, `redirect: "manual"`.
   - On **301 / 302 / 303 only**, read `Location` and validate it (item 2) before doing anything with it. Then `GET` the validated absolute URL (no cookie needed — PRD §4.1) and return a `FetchedPage` with `resolved_via_post: true`, `slug` = the validated path minus its leading `/`, and `city`/`state` from `parseSlugParts`.
   - **Reject 307 and 308** with `FetchError`. Those statuses require the client to preserve the original method; following them with a `GET` is wrong, and this site does not use them. Treating them as 302 would silently change semantics.
   - If the POST returns 200 with a body that passes the listings pre-check (item 5), accept the body but set **`slug: null`** — the response gives no trustworthy slug, and inventing `"<zip>"` would poison the cache with a URL that does not exist. `resolveAndFetch` returns it; the caller must **not** persist a null slug (Phase 7 skips `updateZipSlug` when `page.slug === null`).
   - Any other outcome throws `FetchError` with the status.
2. **Redirect validation (SSRF guard).** After reading `Location`, resolve it against `env.SITE_BASE_URL` and **reject with `FetchError` unless all four hold**:
   - the scheme is exactly `https:`;
   - the host is **exactly equal** to the host of `env.SITE_BASE_URL` (string equality after `new URL()` normalisation — not `endsWith`, which `evil-cashheatingoil.com` defeats);
   - the path matches `^/[a-z0-9_]+_[a-z]{2}_oil_prices/\d{5}$`;
   - the 5-digit zip at the end of the path **equals the requested zip**. Without this last check a redirect to another zip's page would store that zip's prices under this one, and the subscriber would be notified of a price that is not available to them.
3. **Timeouts.** Every `fetch()` this module issues carries `signal: AbortSignal.timeout(15000)`. Every rejected `fetch()` is caught and re-thrown as `FetchError` (preserving the original as `cause`), so a caller never has to reason about a raw `TypeError`, `AbortError`, or DNS failure — the module's only failure type is `FetchError`.
4. **Response size cap.** Reject with `FetchError` when `Content-Length` is present and exceeds **2 MB**. Because `Content-Length` may be absent or lying, also cap while reading: read the body through its reader, accumulate, and abort with `FetchError` the moment the accumulated size passes 2 MB. This bounds memory and pairs with Phase 2's matching 2 MB input guard.

   **Honest note on streaming:** `FetchedPage.html` is a **buffered string**. This layer does not stream into HTMLRewriter, and this plan does not claim it does. HTMLRewriter's benefit here is *native tokenisation* — the per-byte parsing work happens in the runtime rather than in JS, which is what PRD §9.2's CPU argument actually rests on — not true streaming. A genuinely streaming design would hand the `Response` body straight to `HTMLRewriter.transform()` and would change the `parseListingsPage(html: string)` signature; that is deliberately not done, because a buffered 33 KB string is trivially testable and 2 MB is a hard ceiling.
5. `fetchPricesPage(zip, cachedSlug, env, fetchImpl)`:
   - If `cachedSlug` is null → `resolveAndFetch`.
   - Else `GET ${SITE_BASE_URL}/${cachedSlug}`; accept only a 200 whose body passes the listings pre-check. On any other result, fall back **once** to `resolveAndFetch` (PRD §8) and return that, with `resolved_via_post: true`. If the fallback also fails, throw `FetchError`.
   - **The listings pre-check** is a cheap "is this plausibly a results page" test, and must tolerate attribute order and quote style: `/class\s*=\s*["'][^"']*\bboxlisting\b/i`. A naive `body.includes('class="boxlisting"')` fails on `class='boxlisting'` or `class="boxlisting alt"` and would send the fetcher into a needless fallback. **It is only a pre-check** — `parseListingsPage` remains the sole authority on whether a page is valid, and the fetcher must never be treated as having validated content.
6. `parseSlugParts("seymour_ct_oil_prices/06483")` → `{ city: "seymour", state: "ct", zip: "06483" }`; handle multi-word cities (`garden_city_ny_oil_prices/11530` → city `garden_city`, state `ny`); return `null` on a non-matching slug.
7. Concurrency note in a code comment: callers must never exceed 6 simultaneous outbound connections (PRD §9.1). This layer issues at most 2 subrequests per call.
8. `test/fetcher.test.ts` with a hand-rolled `fetchImpl` stub (a function returning canned `Response`s and recording calls) — **no network, no mock library**:
   - cached-slug happy path: 1 GET, body from the fixture, `resolved_via_post === false`, `slug` unchanged;
   - cached slug 404 → falls back to POST → 302 → GET, exactly 3 calls, `resolved_via_post === true`;
   - cached slug returns 200 but a listing-free body → same fallback;
   - the pre-check regex accepts `class='boxlisting'`, `class="alt boxlisting"`, and `CLASS = "boxlisting"` without falling back, and rejects `class="boxlistings"` and `data-x="boxlisting"`;
   - null cached slug → POST path, correct POST URL, correct `content-type`, body contains `txtzipcode=06483`;
   - POST returns 500 → rejects with `FetchError` and `status === 500`;
   - both paths fail → rejects once, and the stub was called exactly 3 times (no retry storm);
   - **SSRF table test** — each of these `Location` values rejects with `FetchError` and issues **no** follow-up GET: `http://www.cashheatingoil.com/seymour_ct_oil_prices/06483` (wrong scheme); `https://evil.example/seymour_ct_oil_prices/06483` (wrong host); `https://evil-cashheatingoil.com/seymour_ct_oil_prices/06483` (suffix-match trap); `https://www.cashheatingoil.com/admin` (path shape); `https://www.cashheatingoil.com/trumbull_ct_oil_prices/06611` when `06483` was requested (**zip mismatch**); `//evil.example/x` (protocol-relative); and a `Location` header that is absent entirely;
   - a 307 and a 308 response each reject with `FetchError`, and no GET is issued;
   - the POST-returns-200 edge returns `slug === null` and the body is still usable;
   - `Content-Length: 3000000` rejects with `FetchError` before the body is read; a body with no `Content-Length` that streams past 2 MB also rejects;
   - a `fetchImpl` that rejects with a raw `TypeError` surfaces as `FetchError`, not `TypeError`;
   - every request carries an `AbortSignal` (assert `init.signal` is present on each recorded call);
   - `parseSlugParts` table test over the four PRD §4.1 slugs plus a malformed one → `null`;
   - `User-Agent` header from `env.USER_AGENT` is present on every request.

**Definition of done:**
- [ ] Exact §2.2 signatures exported, including `FetchError`.
- [ ] `FetchedPage.slug` is `string | null` and the POST-200 edge yields `null`, never `"<zip>"`.
- [ ] Zero real network calls in tests (every test passes `fetchImpl`).
- [ ] Fallback is attempted **at most once**, asserted by call count.
- [ ] `redirect: "manual"` used so the 302 `Location` is observable.
- [ ] Every SSRF case in item 8 rejects and issues no follow-up request (asserted by call count, not just by the thrown error).
- [ ] 307 and 308 reject; only 301/302/303 are followed.
- [ ] Every `fetch()` call site passes `signal: AbortSignal.timeout(15000)`, and the module's only thrown type is `FetchError`.
- [ ] The 2 MB cap is enforced both by `Content-Length` and while reading.
- [ ] `npm run typecheck` clean.

**Validation** (one command per line):
```
npx vitest run test/fetcher.test.ts
npm run typecheck
```
Pass = all fetcher tests green; run with the machine offline if you want proof of no network dependence.

---

### Phase 4 — D1 write layer (Wave 2)

**Goal:** batched, idempotent persistence and the small reads the consumer needs, inside the 50-query budget.

**Dependencies:** P1 merged.

**Files owned:** `src/db.ts`, `test/db.test.ts`.

**Work items:**

1. Implement every §2.2 `src/db.ts` export. Use `db.prepare(...).bind(...)` and a single `db.batch([...])` per `writePriceRows` call.
2. **A `PriceRow` binds 11 columns, not 12.** `id` is `AUTOINCREMENT` and is never bound. 8 rows × 11 = **88** bound parameters against D1's 100-parameter cap. A 9th row (99) would still fit; `ROWS_PER_INSERT = 8` is kept as a deliberate conservative choice with one row of margin, and every row-count assertion in this plan (39 rows → 5 INSERT statements) follows from it. Wherever the number 12 or 96 appears in an older note, it is wrong.
3. **`writePriceRows` is a replace, not an upsert.** A rerun must not leave yesterday-morning's tiers behind: a gallon tier that disappears from the site must disappear from the table. In **one** `db.batch()`, issue:
   1. `DELETE FROM prices WHERE scrape_date = ? AND zip = ?`
   2. the rows chunked at `ROWS_PER_INSERT`, one multi-row `INSERT … ON CONFLICT DO UPDATE` per chunk, SQL built dynamically for the chunk length so the final short chunk is a valid statement.

   Because the DELETE is keyed on a single `(scrape_date, zip)`, **all rows in one call must share that pair**. Assert the precondition explicitly and `throw` (a plain `Error` with both offending values in the message) if it is violated — silently deleting the wrong day's data is the worst available failure.

   Return `{ statements, rows }` where `statements` **counts the DELETE**: 39 rows → `{ statements: 6, rows: 39 }` (1 DELETE + 5 INSERTs). `[]` → `{ statements: 0, rows: 0 }` with **no** D1 call at all — there is no key to delete by.
4. Column order must exactly match §2.3's INSERT list (11 bound columns, `id` omitted).
5. `getActiveZips` selects `WHERE active = 1 ORDER BY zip` — one query. `getActiveSubscriptions` selects `WHERE zip = ? AND active = 1 ORDER BY id` — one query.
6. `updateZipSlug` / `clearZipSlug` — one statement each; `clearZipSlug` nulls both `slug` and `slug_resolved_at`.
7. `wasNotified` — one `SELECT 1 FROM notifications WHERE scrape_date = ? AND subscription_id = ?`, returning a boolean. `recordNotified` — one `INSERT INTO notifications (scrape_date, subscription_id, fingerprint, sent_at) VALUES (?,?,?,?) ON CONFLICT (scrape_date, subscription_id) DO NOTHING`. The `DO NOTHING` is what makes a second call for the same key a silent no-op rather than a constraint error; a retry that races itself must not turn a successful notification into a failed invocation.
8. Add a module comment stating the per-invocation query budget arithmetic for a 39-row zip:
   `1 zip read + 1 DELETE + 5 INSERTs + 1 slug update + 1 subscription read + 2 wasNotified + 2 recordNotified = 13 of 50`.
   With two notified subscriptions on a cached slug that is 13, so the Phase 7 guard is set at **14** — one slot of headroom above the worst realistic case, and still 36 queries below D1's per-invocation cap of 50. See Phase 7 item 8 for the accounting it asserts.
9. `test/db.test.ts` running in the Workers pool against local D1 (migrations applied by `test/setup.ts`):
   - seed a `zips` row, then `getActiveZips` returns it and omits an `active = 0` row;
   - write the 39 rows produced by hand-built `PriceRow` fixtures (do **not** import the parser — P4 must not depend on P2): assert `{ statements: 6, rows: 39 }` and `SELECT COUNT(*) = 39`;
   - **idempotence**: call `writePriceRows` twice with the same rows → still 39 rows in the table;
   - **replace semantics**: write 39 rows, then call `writePriceRows` again with **38** of them (drop one tier) for the same `(scrape_date, zip)` → the table holds **exactly 38**. This is the test that distinguishes a replace from an upsert; an implementation without the DELETE leaves 39 and fails here;
   - **update semantics**: re-write one row with a changed `price_per_gallon` and `scraped_at` → row count unchanged, the stored price is the new value;
   - **mixed-key precondition**: `writePriceRows` with rows spanning two `scrape_date`s, and again with rows spanning two zips, **throws** and issues no D1 call;
   - a chunk-boundary test on the INSERT count (excluding the DELETE): 8 rows → 1 insert statement (`statements === 2`); 9 → 2 (`3`); 16 → 2 (`3`); 17 → 3 (`4`);
   - a 100-row write completes and issues `1 + ⌈100/8⌉ = 14` statements (proves the batching stays well under 50);
   - `writePriceRows(db, [])` returns `{statements:0, rows:0}`;
   - a parameter-count test: build the 8-row SQL and assert it contains exactly **88** `?` placeholders;
   - `gallon_max: null` round-trips as SQL NULL, not the string `"null"`;
   - `getActiveSubscriptions` filters by zip and by `active`, ordered by id;
   - `updateZipSlug` then `getZip` returns the slug/city/state/timestamp; `clearZipSlug` nulls them;
   - `wasNotified` is `false` before and `true` after `recordNotified` for the same key, and `false` for a different `scrape_date` or a different `subscription_id`;
   - `recordNotified` called **twice** with the same `(scrape_date, subscription_id)` does not throw, leaves exactly one row, and leaves the **first** fingerprint in place.

**Definition of done:**
- [ ] All §2.2 `db.ts` exports present with exact signatures, including `wasNotified` and `recordNotified`; `ROWS_PER_INSERT === 8`.
- [ ] No statement ever binds more than 88 parameters (asserted by constructing the 8-row SQL and counting `?`).
- [ ] `writePriceRows` issues the DELETE and the INSERTs in a **single** `db.batch()`, and rejects mixed `(scrape_date, zip)` input.
- [ ] The 39-then-38 rewrite test leaves exactly 38 rows.
- [ ] Double-write leaves row count unchanged and updates the mutable columns.
- [ ] `recordNotified` twice for the same key does not throw.
- [ ] `src/db.ts` imports nothing from `./parser`, `./fetcher`, or `./notify`.
- [ ] `npm run typecheck` clean.

**Validation** (one command per line):
```
npm run migrate:local
npx vitest run test/db.test.ts
npm run typecheck
```
Pass = all db tests green, including the `{statements: 6, rows: 39}` assertion, the 39→38 replace test, and the idempotence pair.

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
5. `notificationFingerprint(decision)`: a stable, pure string over exactly `dealer_id`, `payment_type`, `gallon_min`, `price_per_gallon`, and `stale` — e.g. `` `${d}|${p}|${g}|${price.toFixed(2)}|${stale?1:0}` ``. No timestamps, no object-iteration order, no `JSON.stringify` of a whole object. It is written to `notifications.fingerprint` by Phase 7 so that a later question — "did today's push say the same thing the dedupe row recorded?" — is answerable from D1 alone. `decision.best === null` never reaches it, because only `should_send` decisions are fingerprinted.
6. `sendNtfy`: `POST ${env.NTFY_BASE_URL}/${encodeURIComponent(topic)}` with the body as the message text and `Title`, `Tags`, `Priority` headers (ntfy's plain-HTTP interface — no SDK).
   - **Validate the topic first**: if it does not match `/^[A-Za-z0-9_-]{1,64}$/`, return `false` immediately, issue no request, and **do not throw**. A topic is user-supplied data out of D1; a value containing `/`, `..`, `?`, or a newline would otherwise let it address a different ntfy endpoint or inject a header.
   - URL-encode the topic into the path even after validation, so the encoding is correct by construction rather than by the validator happening to be strict enough.
   - Wrap in try/catch; return `false` on throw or non-2xx; **never throw** (PRD §8: a failed push must not lose the already-written data).
7. `sendAlert`: same transport and the same topic validation, fixed topic `env.NTFY_ALERT_TOPIC`, priority 4, tags `["warning"]`, title prefixed `heating-oil-tracker:`. Note that in production `NTFY_ALERT_TOPIC` comes from a **secret** set by Phase 9, not from the placeholder in `wrangler.jsonc` (§2.4).
8. `test/notify.test.ts` — build `ParsedListing[]` fixtures **by hand** from the §1.3 table (do not import the parser; P5 must not depend on P2):
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
   - **topic validation table**: `""`, `"a/b"`, `"../admin"`, `"a?b"`, `"a b"`, `"a\nb"`, and a 65-character topic each return `false`, do **not** throw, and record **zero** stub calls; `"yazan-06483-oil"`, `"A_b-9"`, and a 64-character topic are accepted;
   - the request URL uses the encoded topic segment (assert against a topic at the edge of the allowed set, e.g. `"a-b_c"`, that the path is exactly `/a-b_c`);
   - `sendAlert` posts to `env.NTFY_ALERT_TOPIC` with priority 4, and returns `false` without a request when that var is itself an invalid topic;
   - `notificationFingerprint` is stable across calls for an equal decision, differs when any of the five inputs differs, and is unaffected by fields outside the five (change `delivery_date` → same fingerprint).

**Definition of done:**
- [ ] All §2.2 `notify.ts` exports present with exact signatures, including `notificationFingerprint`.
- [ ] `sendNtfy` and `sendAlert` provably never throw (tested with a rejecting `fetchImpl` **and** with hostile topics).
- [ ] An invalid topic issues zero requests.
- [ ] The 50-gallon → `$5.64` case is asserted verbatim.
- [ ] `src/notify.ts` imports nothing but `./types`.
- [ ] `npm run typecheck` clean.

**Validation** (one command per line):
```
npx vitest run test/notify.test.ts
npm run typecheck
```
Pass = all notify tests green (expect ≥ 25 assertions), tsc silent.

---

### Phase 6 — Seed / admin path (Wave 2)

**Goal:** a one-command way to put zips and subscriptions into local D1, so every other phase and the operator can exercise the system.

**Dependencies:** P1 merged.

**Files owned:** `scripts/seed.mjs`, `seeds/dev-seed.sql`, `test/seed.test.ts`.
**Must not touch:** `package.json` — P1 already added the `seed:local` script entry pointing at `scripts/seed.mjs`.

**Work items:**

1. `seeds/dev-seed.sql`: idempotent seed containing:
   - `zips`: **all four zips inactive** — `06483`, `06611`, `11530`, `08540`, each with `active = 0` and `slug = NULL`.

     **`06483` is seeded inactive deliberately, and this is load-bearing.** With no active zip, `scheduled()` enqueues nothing, so **no local run can reach `cashheatingoil.com` or `ntfy.sh` by accident** — the local quickstart is fully offline, on a fresh clone, with no environment variable to remember. Activating a zip is an explicit opt-in:
     ```
     node scripts/seed.mjs --activate 06483
     ```
     Document in the script's `--help` and in the seed file's header comment that **activating a zip locally and then triggering the cron will cause real outbound requests** to the live site and to ntfy.
   - `subscriptions`: exactly **two** rows for `user_id = 'v1'` on `06483`, with **explicit fixed ids** so downstream tests and the `notifications` dedupe table can name them:
     | id | min_gallons | payment_type | threshold | best price in the fixture |
     |---|---|---|---|---|
     | 1 | 100 | cash | NULL | `$4.84` (dealer 11) |
     | 2 | 50  | cash | NULL | `$5.64` (dealer 372) |

     **Both therefore send.** The previous seed gave id 2 a `threshold` of `5.50` while the fixture's best 50-gallon price is `$5.64`; Phase 5 would have correctly suppressed it as `threshold_not_met` while Phase 7 asserted the notification was sent. The two phases contradicted each other. Both thresholds are now `NULL`; the `threshold_not_met` branch is covered by Phase 5's own unit tests, which do not need a seeded row.

     Idempotence uses the explicit ids: `INSERT INTO subscriptions (id, …) VALUES (…) ON CONFLICT (id) DO UPDATE SET …`. The `ux_subs_natural` index of §2.3 makes a second insert under a different id impossible anyway.
   - `ntfy_topic` for both rows is the **non-sensitive placeholder `heating-oil-local-dev`**. Local tests never actually post — `fetch` is stubbed everywhere in wave 2 and 3 — so the value only has to be a valid topic, and a real topic must never appear in a committed file. The real subscriber topic is inserted into **remote** D1 by Phase 9 only.
2. `scripts/seed.mjs`: a small Node script that runs `wrangler d1 execute heating-oil --local --file=seeds/dev-seed.sql`, forwarding `--remote` only if the operator passes it explicitly, and printing a post-seed summary (`SELECT` counts). It must refuse to run with `--remote` unless `CONFIRM_REMOTE=1` is set, so nobody seeds production by muscle memory.
   **Cross-platform wrangler invocation:** do **not** spawn a bare `wrangler`. On Windows there is no `wrangler` executable on `PATH` — there is `wrangler.cmd` in `node_modules/.bin`, and `child_process.spawn` without a shell will not find it. Invoke the local binary through npm instead: `spawn(npmCmd, ["exec", "--", "wrangler", …], { stdio: "inherit" })`, or add the wrangler calls as `package.json` scripts (P1 has already reserved `migrate:local`, `seed:local`, `seed:dry`) and shell out with `npm run`. Either way npm resolves `node_modules/.bin` correctly on both platforms.
3. Support ad-hoc admin operations without new files, documented in the script's `--help`:
   `node scripts/seed.mjs --add-zip 06611`, `--activate 06611`, `--deactivate 06611`, `--add-sub <zip> <topic> <min_gallons> <cash|credit> [threshold]`.

   **`wrangler d1 execute` has no bound-parameter interface.** `--command` takes a SQL string and nothing else; there is no `--param`. Any claim that these commands are "parameterised" is false, and an implementation that assumes binding will interpolate anyway. The defence is therefore **validation before interpolation**, in this order:
   1. Validate every field against a strict grammar. Anything that does not match causes a **non-zero exit with no SQL issued at all** — not a sanitised retry, not a warning:
      - zip: `/^\d{5}$/`
      - ntfy topic: `/^[A-Za-z0-9_-]{1,64}$/` (the same grammar `sendNtfy` enforces)
      - gallons: an integer, `1 ≤ n ≤ 100000` (reject `1e3`, `01`, `1.0`, `NaN`, `Infinity`, leading `+`)
      - payment type: exactly `cash` or `credit`
      - threshold: a positive decimal with at most 2 decimal places, `/^\d+(\.\d{1,2})?$/` and `> 0`
   2. **Additionally** escape single quotes (`'` → `''`) in any string that does reach the SQL text. This is belt-and-braces: after the grammars above no string can contain a quote, so if the escape ever fires, a validator has a hole.
   3. Never interpolate an unvalidated value under any flag, including `--dry-run`.

   Add **hostile-input tests** (item 4): `--add-zip "0648'; DROP TABLE zips;--"` must exit non-zero and issue nothing.
4. `test/seed.test.ts` (Workers pool, local D1): read `seeds/dev-seed.sql`, split on `;`, execute the statements against `env.DB`, then assert:
   - 4 zip rows, **exactly 0 active**;
   - exactly 2 subscriptions for `06483`, with ids `1` and `2`, both `threshold IS NULL`, both `ntfy_topic = 'heating-oil-local-dev'`, `min_gallons` `100` and `50`;
   - re-running the same statements leaves every count unchanged and does not throw (idempotence, via the explicit ids and `ux_subs_natural`);
   - the seeded `payment_type` and `zip` values pass every CHECK constraint of §2.3.

   Plus, as plain Node tests over the argument validator exported from `scripts/seed.mjs` (no D1 needed), the hostile-input table — each must be rejected with no SQL produced:
   `--add-zip "0648'; DROP TABLE zips;--"`, `--add-zip 6483`, `--add-zip 064833`, `--add-sub 06483 "a'b" 100 cash`, `--add-sub 06483 t 100 debit`, `--add-sub 06483 t 0 cash`, `--add-sub 06483 t 1e3 cash`, `--add-sub 06483 t 100 cash 5.555`, `--add-sub 06483 t 100 cash -1`, and `--activate "06483 OR 1=1"`.
5. Include a `--dry-run` flag that prints the SQL it would execute and exits 0, running the same validation first.

**Definition of done:**
- [ ] `npm run seed:dry` prints SQL and exits 0 without touching a database.
- [ ] `npm run seed:local` populates local D1; running it twice changes no counts.
- [ ] All four seeded zips are `active = 0`; a fresh clone can run the whole quickstart with the network unplugged.
- [ ] Both seeded subscriptions have ids 1 and 2, `threshold IS NULL`, and `ntfy_topic = 'heating-oil-local-dev'`.
- [ ] `--remote` without `CONFIRM_REMOTE=1` exits non-zero with a clear message.
- [ ] Every hostile input in item 4 exits non-zero without issuing SQL.
- [ ] wrangler is invoked through npm, never as a bare `wrangler` spawn.
- [ ] `test/seed.test.ts` passes.

**Validation** (one command per line; never chain with `&&`):
```
npm run migrate:local
npm run seed:dry
npm run seed:local
npm run seed:local
npx wrangler d1 execute heating-oil --local --command "SELECT COUNT(*) c FROM zips"
npx wrangler d1 execute heating-oil --local --command "SELECT COUNT(*) c FROM subscriptions"
npx wrangler d1 execute heating-oil --local --command "SELECT COUNT(*) c FROM zips WHERE active = 1"
node scripts/seed.mjs --add-zip "0648'; DROP TABLE zips;--"
npx vitest run test/seed.test.ts
```
Pass = the three counts are **4**, **2**, and **0** and are unchanged after the second `seed:local`; the hostile `--add-zip` exits **non-zero** and prints no SQL; all seed tests green.

---

### Phase 7 — Cron producer + queue consumer orchestration (Wave 3)

**Goal:** wire parser + fetcher + db + notify into the two Worker handlers, with per-zip error isolation and alerting.

**Dependencies:** P1–P6 merged.

**Files owned:** `src/index.ts` (replacing the P1 stub), `test/orchestration.test.ts`.
**Must not touch:** `wrangler.jsonc` (P1 already declares every binding this phase needs), nor any wave-2 source file. If a wave-2 module appears to have a bug, work around it in `index.ts` and report it — do not edit their files.

**Work items:**

**Single owner for alerting.** `processZip` **never** sends an alert. It throws typed errors and returns structured results; the `queue()` handler is the only code in the project that calls `sendAlert` for a per-zip failure, and `scheduled()` the only one that alerts for a producer failure. Two owners would double every alert on a retry and make the alert topic useless.

1. `scheduled(controller, env, ctx)` — the producer, per PRD §5.1: compute `scrape_date` as the UTC date of `controller.scheduledTime`, `getActiveZips(env.DB)` (1 query), then enqueue one message per zip. **No scraping, no fetching, no parsing** in this handler. Log a one-line summary.
   - **`sendBatch()` accepts at most 100 messages.** Chunk the sends at 100: `for (const chunk of chunksOf(messages, 100)) await env.SCRAPE_QUEUE.sendBatch(chunk);`. At one zip this is academic; at 150 zips an unchunked call fails and the whole day is lost silently.
   - On failure: `sendAlert` **best-effort, and then RETHROW**. A cron invocation that swallows its own failure is reported as a success in Cloudflare's dashboard, and the operator's only signal is an ntfy push that may itself have failed. Rethrowing makes the failed invocation visible where the platform already shows it.
2. `queue(batch, env, ctx)` — iterate messages; each in its own `try/catch` so one bad zip cannot affect another.
   - **Validate the message body before use**: `msg.body.zip` must match `/^\d{5}$/` and `msg.body.scrape_date` must match `/^\d{4}-\d{2}-\d{2}$/` and be a real calendar date. A malformed message is **ack**ed and alerted, never retried — retrying an unparseable message just burns the retry budget three times and then drops it anyway.
   - On a `processZip` success → `msg.ack()`.
   - On a thrown error → `sendAlert(...)` with the error type and message, then `msg.retry()` (bounded by `max_retries: 3` in wrangler.jsonc).
   - This handler is the **only** caller of `sendAlert` on the per-zip path, including for the zero-listings and `ParseError` outcomes, which `processZip` signals by return value and by throw respectively (item 4).
3. **No dead-letter queue is configured.** After `max_retries: 3` a message is **dropped** and that zip has no data for the day. This is an **accepted risk** for a personal daily job: the compensating control is the alert push on every failed attempt, and tomorrow's cron simply tries again. It is recorded here rather than left implicit so that nobody later reads the retry count as a durability guarantee. Adding a DLQ is a `wrangler.jsonc` change plus a consumer, and is out of scope for v1.
4. `processZip(msg, env, fetchImpl)` — the whole per-zip pipeline. **Every branch returns all four fields of `ProcessZipResult`; nothing is left for an implementing agent to invent.**
   1. `getZip` → cached slug (1 query);
   2. `fetchPricesPage(zip, slug, env, fetchImpl)` (1–2 subrequests);
   3. if `page.slug !== null` **and** (`page.resolved_via_post` or the slug changed) → `updateZipSlug(...)` with `parseSlugParts` output (1 query). **A `null` slug is never persisted** (Phase 3 item 1);
   4. `parseListingsPage(page.html)`;
   5. `toPriceRows` → `writePriceRows` (1 DELETE + ⌈n/8⌉ INSERTs);
   6. `getActiveSubscriptions(env.DB, zip)` (1 query);
   7. for each subscription: `evaluateSubscription(listings, sub, scrape_date, Number(env.STALE_AFTER_DAYS))`; when `should_send`, apply the dedupe protocol of item 5, then `buildNotification` → `sendNtfy`. Count successes; a `false` return is logged, not thrown.

   **The exhaustive branch table:**

   | Branch | Behaviour | `rows_written` | `notifications_sent` | `stale` | Control flow |
   |---|---|---|---|---|---|
   | **Success** | normal path | number of rows written (39 for the fixture) | count of `sendNtfy` calls that returned `true` | `isStale(...)` as computed by `evaluateSubscription` | returns |
   | **Zero listings** (`parseListingsPage` → `[]`) | log; write nothing; notify nobody (PRD §8: a missing day beats a wrong one). Not a message failure | `0` | `0` | **`false`** — staleness is undefined with no listings, and `false` is the non-alarming value; the zero-listing alert is the signal, not a stale flag | returns; `queue()` alerts and **acks** |
   | **`ParseError`** | markup drift; retrying will not fix it | `0` | `0` | **`false`** — same reasoning | **rethrows**; `queue()` alerts and **acks** (does *not* retry) |
   | **ntfy failure** (`sendNtfy` → `false`) | the D1 write has already happened, so the data is not lost (PRD §8) | rows as written | count of **successful** sends only; may be `0` | as computed | returns normally — a failed push is **not** a message failure |
   | **`FetchError`** | `clearZipSlug` first (so tomorrow re-resolves), then rethrow | — | — | — | **rethrows**; `queue()` alerts and **retries** |

   Note the asymmetry that makes this work: `ParseError` and `FetchError` both leave `processZip` by throwing, but `queue()` distinguishes them — `ParseError` → ack, `FetchError` → retry — by inspecting the error type. The zero-listings case is a **return value**, not a throw, because there is nothing wrong with the invocation.
5. **Notification dedupe.** Before sending to a subscription, call `wasNotified(env.DB, scrape_date, sub.id)`; if `true`, skip the send entirely and do not count it. After `sendNtfy` returns `true`, call `recordNotified(env.DB, scrape_date, sub.id, notificationFingerprint(decision), new Date().toISOString())`. This is what keeps at-least-once queue delivery from double-notifying the phone: D1 writes are idempotent, an ntfy push is not.
   Ordering matters: record **after** a successful send, not before. Recording first would suppress the notification permanently if the push then failed.
6. **Query budget.** For the happy path — a cached slug, 39 rows, 2 subscriptions, both notified for the first time — the accounting is:
   `1 getZip + 1 DELETE + 5 INSERT + 1 getActiveSubscriptions + 2 wasNotified + 2 recordNotified = 12`.
   Assert **≤ 14** D1 statements in a test by counting `prepare` calls on a wrapped D1 handle. (The old guard of 10 predates the DELETE and the dedupe queries and is unreachable; the true cached-slug cost for the two seeded subscriptions is 13, so 14 leaves exactly one slot of headroom.) A first-run zip adds one `updateZipSlug`, which is why the guard is stated for the cached-slug path.
7. Never `await` an unnecessary sequential fetch: notifications for multiple subscriptions may be sent with `Promise.allSettled`, capped at 6 concurrent (PRD §9.1).
8. `test/orchestration.test.ts` — full local integration, no network:
   - seed one **active** zip `06483` with `slug = NULL` and the two subscriptions of Phase 6 (ids 1 and 2, both `threshold NULL`). The committed seed leaves every zip inactive; this test activates `06483` in its own setup, which is exactly the opt-in step the README documents;
   - stub `fetchImpl` to answer the POST with a 302, the slug GET with the **real fixture**, and any ntfy POST with 200, recording every call;
   - run `processZip({zip:"06483", scrape_date:"2026-09-06"}, env, stub)` and assert the full result object `{ zip: "06483", rows_written: 39, notifications_sent: 2, stale: false }`; 39 rows in `prices`; the zip's `slug` is now `seymour_ct_oil_prices/06483` with `city = "seymour"`, `state = "ct"`, `slug_resolved_at` set; 2 ntfy POSTs recorded whose bodies contain `4.84` and `5.64` respectively; and **zero** alert POSTs (`processZip` never alerts);
   - **re-run the same call** → still 39 rows in `prices` (the write happened again, idempotently) but **still only 2 ntfy POSTs in total** and `notifications_sent === 0` on the second call. This is the dedupe assertion: reprocessing writes the rows twice and sends the notification once;
   - a rerun with one tier removed from the fixture → exactly 38 rows (the replace semantics of Phase 4, end to end);
   - fixture with the listings stripped → result is `{ zip, rows_written: 0, notifications_sent: 0, stale: false }`, 0 rows written, 0 subscriber notifications, the call **resolves**, and `processZip` itself issues **no** alert; driving the same case through `queue()` produces exactly 1 alert POST and an `ack()`;
   - a `ParseError` case (a mutated fixture) → `processZip` **rejects**; through `queue()`: 1 alert, `ack()` called, `retry()` **not** called;
   - fetch stub returning 500 on both paths → `processZip` rejects with `FetchError`, `zips.slug` has been cleared; through `queue()`: 1 alert and `retry()` called;
   - ntfy stub returning 500 → rows still written, call resolves, `notifications_sent === 0`, and **no** dedupe row is recorded (so tomorrow's retry can still send);
   - `scheduled` with 2 active and 1 inactive zip → exactly 2 messages enqueued with the right `scrape_date`, and **zero** fetches performed by the producer;
   - `scheduled` with 250 active zips → `sendBatch` called **3** times with 100/100/50 messages;
   - `scheduled` whose `getActiveZips` rejects → 1 alert POST **and** the handler **rethrows** (assert with `expect(...).rejects`);
   - `queue` with a 2-message batch where the first throws → the second still processes; first `retry()`ed, second `ack()`ed;
   - `queue` with a message whose `zip` is `"abc"`, and one whose `scrape_date` is `"2026-13-45"` → each is **ack**ed and alerted, and `processZip` is never entered (assert zero fetch calls);
   - query-count guard: ≤ **14** D1 statements for the cached-slug happy path.

**Definition of done:**
- [ ] `src/index.ts` default-exports `scheduled` and `queue`, and named-exports `processZip` with the §2.2 signature and the `ProcessZipResult` shape.
- [ ] `grep -n sendAlert src/index.ts` shows call sites **only** inside `scheduled()` and `queue()` — never inside `processZip`.
- [ ] `scheduled()` rethrows after alerting (asserted).
- [ ] `sendBatch` sends are chunked at 100 (asserted with 250 zips).
- [ ] The cron handler performs no `fetch` (asserted).
- [ ] Every message is individually try/caught; one failure does not abort the batch (asserted).
- [ ] Malformed queue messages are acked and alerted, never retried (asserted).
- [ ] Zero-listing and `ParseError` paths write nothing and notify nobody; the alert comes from `queue()` (asserted).
- [ ] Fetch failure clears the cached slug and rethrows for retry (asserted).
- [ ] End-to-end run against the fixture produces exactly 39 rows, is idempotent, and sends the notification **once** across two runs (asserted).
- [ ] The query-count guard asserts ≤ **14**.
- [ ] `npm run typecheck` clean; `npm run dryrun` builds.

**Validation** (one command per line; never chain with `&&`):
```
npm run migrate:local
npx vitest run
npm run typecheck
npm run dryrun
```
Pass = full suite green (all phases), tsc silent, dry run builds without authenticating.

---

### Phase 8 — Documentation + CPU measurement procedure (Wave 4)

**Goal:** a README that gets a new machine from clone to a green local run, and the PRD §9.2 CPU measurement written up as a repeatable procedure.

**Dependencies:** P1–P7 merged. P8 was deliberately moved out of wave 3: it documents behaviour that does not exist until P7 lands, and its previous gate ("`git status` shows two files") could be satisfied by entirely wrong documentation.

**Files owned:** `README.md`, `docs/cpu-measurement.md`, `scripts/smoke-quickstart.mjs`.
**Must not touch:** any source, test, or config file — including `package.json` (P1 already reserved the `smoke` script entry), `docs/heating-oil-tracker-prd.md`, and `docs/implementation-plan.md`.

**Runs in parallel with Phase 9.** P8 stays offline; P9 owns everything that touches the network. P8 documents the deploy procedure; P9 executes it and records the result in its own file. They share no file.

**Work items:**

1. `README.md`:
   - one-paragraph what/why, linking the PRD;
   - prerequisites (Node 20+, no Cloudflare account needed for local work);
   - a note that `.npmrc` at the repo root is required on this machine and must not be removed (§0 rule 7), with the two reasons;
   - **local quickstart, one command per line** (never `&&` — PowerShell 5.1 is a parse error on it), and every step an `npm run` script:
     ```
     npm install
     npm run fixture
     npm run migrate:local
     npm run seed:local
     npm test
     ```
     State plainly that this sequence is **fully offline**: every seeded zip is inactive, so nothing is enqueued and no request reaches `cashheatingoil.com` or `ntfy.sh`. It works with the network unplugged, and that is a property worth preserving.
   - **an explicit opt-in section for going live locally**: `node scripts/seed.mjs --activate 06483` followed by triggering the cron **will cause real outbound requests** to the live site and to whatever ntfy topic is in D1. Say so in a warning box, not a footnote;
   - how to exercise the Worker locally: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+12+*+*+*"`, plus a note that local Queues run in miniflare and the consumer fires automatically;
   - inspecting data: the three `wrangler d1 execute --local --command` queries a human actually wants (today's rows, cheapest per tier, distinct dealer ids);
   - admin recipes: adding a zip, adding a subscription, pausing a zip (`scripts/seed.mjs` flags);
   - architecture section: the cron→queue→consumer diagram in prose, and why one zip per invocation (cite PRD §5.1/§9.1);
   - a table of the `Env` vars from §2.1 with defaults and which must change before deploy (`NTFY_ALERT_TOPIC`, `database_id`), noting that `NTFY_ALERT_TOPIC` is set as a **secret** (`wrangler secret put`), not edited into `wrangler.jsonc`, because on unauthenticated ntfy the topic name is the credential (assumption A8);
   - **deploy instructions**, one command per line: `wrangler login`, `wrangler d1 create heating-oil`, paste the real `database_id`, `wrangler queues create heating-oil-scrape`, `wrangler d1 migrations apply heating-oil --remote`, `wrangler secret put NTFY_ALERT_TOPIC`, `wrangler deploy`, then read the CPU metric from Workers observability. Mark this section as **the procedure Phase 9 executes**, and link `docs/deployment-log.md` as where the actual run is recorded (noting that the log is gitignored because it contains the real alert topic);
   - a "known limits" box restating the four binding free-tier numbers (10 ms CPU, 50 D1 queries, 50 subrequests, 6 connections);
   - a troubleshooting section covering the three PRD §8 failure modes and what each looks like in the alert topic.
2. `docs/cpu-measurement.md` — the PRD §9.2 action item, written as a procedure someone runs in 15 minutes.

   **Open with the honest framing.** PRD §9 asserts free-tier feasibility, and every line of its capacity table is safe on arithmetic alone **except the one that matters**: CPU time per invocation against the 10 ms ceiling. That number has never been measured. It is therefore an **accepted, unresolved risk** for the entire build, not a settled fact, and it stays unresolved until Phase 9 measures it in production. Say this in the first paragraph rather than burying it under a procedure.

   - **Indicative local measurement — a workerd CPU profile via DevTools.** `wrangler dev`'s request log does **not** report a CPU-time figure; the earlier instruction to "read the CPU time from the `wrangler dev` request log" was wrong and is removed. The documented approach is: run `npx wrangler dev`, open the DevTools inspector `wrangler dev` exposes, start a CPU profile, trigger the handler, stop the profile, and read the self-time of the parse frames. Repeat 10× and record the median. Note the caveat that a local workerd profile on a developer laptop is **indicative, not authoritative** — different hardware, no production contention.
   - **In-process measurement:** a copy-pasteable snippet using `performance.now()` around `parseListingsPage(fixture)` only, run via `npx vitest run` with the fixture, to isolate parse cost from I/O. This is the most repeatable local number and the one to track over time. Record it in the results table.
   - **Authoritative measurement: Workers observability.** After Phase 9's deploy, the CPU-time metric for the **queue consumer** in the Cloudflare dashboard (or via `wrangler tail`) is the only figure that settles the question. `observability` is already enabled in `wrangler.jsonc` (§2.4) precisely so this is available on day one. Phase 9 reads it and records it; this document is where the decision rule it is judged against lives.
   - **Decision rule:** if median parse CPU < 3 ms, HTMLRewriter is settled and no change is needed; 3–7 ms, keep HTMLRewriter and re-measure before adding zips; > 7 ms, open a follow-up to split parsing across messages. Note explicitly that Cheerio stays rejected regardless, because it would also require `nodejs_compat`.
   - A results table with columns `date | environment | median ms | p95 ms | notes`, pre-filled with one blank row for the local number and one for the Phase 9 production number.
   - A closing line: this document blocks no phase; the local numbers are filled in here, and the authoritative one is filled in by Phase 9 against this rule.
3. `scripts/smoke-quickstart.mjs` — the phase's **real gate**. An automated, fully offline smoke test that runs **every command in the README quickstart, in order, on a clean checkout**, and fails if any of them exits non-zero. Requirements:
   - it parses or hard-mirrors the exact command list in `README.md` — if the README says a command, the smoke test runs that command, so the two cannot drift;
   - it runs each command as a separate child process (never a `&&` chain), through `npm exec` / `npm run` so `node_modules/.bin` resolves on Windows;
   - it runs against a **throwaway** local D1 state (a temp `--persist-to` directory, deleted afterwards), so running it does not disturb the developer's local database;
   - it asserts the offline property: after the run, zero zips are active;
   - it prints, for each command, the command and its exit code, then exits 0 only if every one was 0.

**Definition of done:**
- [ ] `README.md` exists; its quickstart is one command per line, uses `npm run` scripts, and is fully offline.
- [ ] The README's live-mode opt-in warning is present and unambiguous.
- [ ] Deploy steps are present and identified as the procedure Phase 9 executes, with `docs/deployment-log.md` named as the record.
- [ ] `docs/cpu-measurement.md` opens by naming the unmeasured 10 ms CPU limit as an accepted unresolved risk, contains the DevTools-profile and in-process procedures, names Workers observability as the authoritative source, and carries the decision rule and an empty results table.
- [ ] **`npm run smoke` exits 0 on a clean checkout**, having executed every README quickstart command.
- [ ] No file outside the three owned paths is modified.

**Validation** (one command per line):
```
npm run smoke
git status --porcelain
```
Pass = `npm run smoke` exits 0 and its per-command log matches the README quickstart command for command; `git status --porcelain` lists only `README.md`, `docs/cpu-measurement.md`, and `scripts/smoke-quickstart.mjs`.

---

### Phase 9 — Deploy and live verification (Wave 4)

**Goal:** put this on Cloudflare for real, prove end to end that a scrape lands in remote D1 and a notification arrives on the phone, and finally close the one free-tier claim nobody has measured.

**Dependencies:** P1–P7 merged. Runs **in parallel with P8**; they share no file.

**Executed by an agent with real Cloudflare credentials already present.** `wrangler whoami` resolves to `yazan@laurelridgesoftwaresolutions.com`, account id `abe6c43eb5ef09c5f01bf617a8e5e058`, with `d1`, `queues`, and `workers_scripts` write scopes. Do not run `wrangler login`; do not create or rotate credentials.

**Files owned:**
```
docs/deployment-log.md       (gitignored — see below)
wrangler.jsonc               ONLY the one-line `database_id` value
```

**The `database_id` edit is the single sanctioned cross-phase edit in this plan.** Phase 1 owns `wrangler.jsonc` and wrote `"00000000-0000-0000-0000-000000000000"` as a placeholder; Phase 9 replaces that one value with the real id. It is safe because it happens after every merge, in a phase that runs alone against that file. Change nothing else in the file — not the vars, not the queue config, not the cron.

`docs/deployment-log.md` is **already listed in `.gitignore`** and must stay that way: it records the real alert topic, which on unauthenticated ntfy is a credential.

**Work items, in order:**

1. `wrangler d1 create heating-oil` — record the real `database_id` into `wrangler.jsonc`.
2. `wrangler queues create heating-oil-scrape`.
   **If this fails because Queues requires a paid plan, STOP and report.** Do not work around it — not by polling, not by a Durable Object, not by moving the scrape into `scheduled()`. The one-zip-per-invocation guarantee of PRD §5.1 is built on Queues, and replacing it silently would invalidate the CPU and D1 budgets this whole plan is designed around. A blocked Phase 9 with a clear report is the correct outcome; an improvised architecture is not.
3. `wrangler d1 migrations apply heating-oil --remote`.
4. `wrangler secret put NTFY_ALERT_TOPIC` — with a **high-entropy value the agent generates** (at least 32 characters from `[A-Za-z0-9_-]`, so it satisfies `sendNtfy`'s topic grammar). Record it **only** in `docs/deployment-log.md`. It must never appear in `wrangler.jsonc`, in a commit, in a test, or in the final report. Note that a secret of this name overrides the `vars` placeholder.
5. `wrangler deploy`.
6. Seed **remote** D1 with the real data — this is the only place the real subscriber topic exists:
   - one `zips` row: `06483`, `active = 1`, `slug = NULL` (so the first run exercises the POST resolution path for real);
   - one `subscriptions` row: `user_id 'v1'`, `zip 06483`, `ntfy_topic 'yazan-06483-oil'`, `min_gallons 100`, `payment_type 'cash'`, `threshold NULL`.
7. Trigger a real run and verify end to end:
   - subscribe to `yazan-06483-oil` first, so nothing is missed;
   - trigger the scheduled handler (a manual `wrangler` cron trigger, or wait for 12:00 UTC — say which was used);
   - **remote D1**: `wrangler d1 execute heating-oil --remote --command "SELECT COUNT(*) FROM prices WHERE scrape_date = '<today>'"` returns a non-zero count, and record the exact number (expect ~39 if the site's structure is unchanged; a different number is a finding, not a failure);
   - `SELECT slug, city, state FROM zips WHERE zip = '06483'` shows the slug was resolved and cached;
   - `SELECT COUNT(*) FROM notifications WHERE scrape_date = '<today>'` is `1`;
   - **verify the push independently of the phone**: `curl "https://ntfy.sh/yazan-06483-oil/json?poll=1"` and paste the returned JSON into the log. This is the authoritative evidence the notification actually left the Worker — a handset screenshot is not required and is not sufficient.
8. **Read the authoritative CPU time for the queue consumer** from Workers observability in the Cloudflare dashboard, or via `wrangler tail`, and record it against the decision rule in `docs/cpu-measurement.md` (PRD §9.2): `< 3 ms` settles it; `3–7 ms` keep HTMLRewriter and re-measure before adding zips; `> 7 ms` open a follow-up. **This closes the one unverified free-tier claim in the entire project** — record the number even if it is comfortable.
9. Record everything in `docs/deployment-log.md`: the real `database_id`, the generated alert topic, every command run with its output, the row counts, the polled ntfy JSON, the CPU figure and which decision-rule bucket it falls in, and anything that differed from this plan.

**Definition of done:**
- [ ] `wrangler.jsonc` carries the real `database_id` and nothing else changed in it.
- [ ] `heating-oil` D1 database and `heating-oil-scrape` queue both exist (or the Queues step is blocked and reported, and the phase stops there).
- [ ] Remote migrations applied; `notifications`, `prices`, `zips`, `subscriptions` all exist remotely.
- [ ] `NTFY_ALERT_TOPIC` is set as a secret with a high-entropy value that appears **only** in the gitignored log.
- [ ] `wrangler deploy` succeeded and `wrangler deployments list` shows the version.
- [ ] Remote `prices` holds a recorded, non-zero row count for today's `scrape_date`, and the exact number is in the log.
- [ ] Remote `notifications` holds exactly 1 row for today.
- [ ] The polled `https://ntfy.sh/yazan-06483-oil/json?poll=1` JSON showing the message is pasted into the log.
- [ ] The authoritative queue-consumer CPU figure is recorded, with its decision-rule bucket.
- [ ] `docs/deployment-log.md` exists, is gitignored, and contains all of the above.

**Validation** (one command per line; substitute today's date):
```
wrangler whoami
wrangler d1 execute heating-oil --remote --command "SELECT COUNT(*) AS n FROM prices WHERE scrape_date = '2026-09-06'"
wrangler d1 execute heating-oil --remote --command "SELECT COUNT(*) AS n FROM notifications WHERE scrape_date = '2026-09-06'"
wrangler d1 execute heating-oil --remote --command "SELECT zip, slug, city, state, active FROM zips"
curl "https://ntfy.sh/yazan-06483-oil/json?poll=1"
wrangler deployments list
```
Pass = the price count is non-zero and recorded; the notification count is exactly 1; the zips row shows a resolved slug; the `curl` returns JSON containing the notification message; and the CPU figure is written into the log. Every one of these is a concrete artefact, not a judgement call.

---

## 6. Explicitly out of scope (still unverified after Phase 9)

Phase 9 closes most of what this section used to list. What remains cannot be settled by a single deploy and **must not** be treated as a phase blocker:

1. **The live site's current markup over time.** Every parser assertion is against the 2026-09-05 capture. Phase 9 proves the parser works against the site *today*; ongoing markup drift is detected in production by the alert path of PRD §8, not by these tests.
2. **Sustained free-tier accounting** — daily Queues operations, D1 rows written, and storage growth over weeks. Phase 9 measures one day.
3. **Notification rendering on the handset** — ntfy topic subscription, Android notification channels, do-not-disturb behaviour. Phase 9 proves the message left the Worker and is retrievable from ntfy (`?poll=1`); how it looks on the phone is the operator's to check.
4. **Retry and dead-letter behaviour under real failure.** Phase 9 exercises the happy path. The `max_retries: 3`-then-drop behaviour (Phase 7 item 3) has been reasoned about, not observed in production.
5. **`dealerid` stability across a genuine price change** (PRD §4.5 caveat) — needs a week or two of real accumulated data.
6. **Cron firing reliability over time.** Phase 9 triggers a run; that the schedule keeps firing at 12:00 UTC every day is an operational observation, not a test.

---

## 7. Assumptions and open questions

**A1. The page has 39 price points, not ~44.** PRD §4.3 says "roughly 44"; the fixture holds exactly 20 cash + 19 credit = 39, because dealer 744 has no credit `50-99` tier. All row-count assertions in this plan use **39**. Fewer rows is more headroom, and 39 rows → 5 INSERT statements rather than 6. The PRD's capacity arithmetic is corrected on a separate point in assumption A11.

**A2. `Same Day Charges` is always present and always `$ 0.00` in this fixture.** The parser treats it as optional (`null` when absent) rather than assuming it. Non-zero values are untested against real markup.

**A3. Open-ended gallon tiers (`400+`) do not occur in the fixture.** Support is implemented and unit-tested against synthetic input only, because it is cheap and the site plausibly uses it in other zips.

**A4. `city`/`state` come from the slug, not the page.** PRD §6 says "parsed from the slug", and the slug is available on every path, so the parser does not read the page's State/City metadata table. Slug-derived values are lowercase (`seymour`, `ct`) — no title-casing is applied, to avoid guessing at multi-word city capitalisation.

**A5. Staleness needs no historical read.** PRD §5.4 says "has not advanced in more than N days"; that is computable from today's `max(price_updated_on)` versus `scrape_date` alone. This keeps `isStale` pure and saves a D1 query. If a future requirement is truly "did not advance *relative to yesterday's observation*", it needs a `prices` read and a signature change — flagged, not built.

**A6. `scrape_date` is the UTC date of the cron's `scheduledTime`.** With a 12:00 UTC cron this is unambiguous for a US-Eastern user. If the operator later wants a local-date semantic, it is a one-line change in the producer, but it must be made *before* data accumulates.

**A7. Tie-break is lowest `dealer_id`.** Several dealers offer identical prices (four at `4.84`, four at `5.19`), so an unspecified tie-break would make notification tests flaky. This is a test-determinism choice, not a product statement about which dealer is "best".

**A8. ntfy topics are secrets, and the previous version of this assumption had it backwards.** On unauthenticated ntfy, **the topic name *is* the credential** — anyone who knows it can read every message published to it and publish to it themselves. That is a reason to keep topic names hidden, not a reason to treat them as public. Accordingly:

- `NTFY_ALERT_TOPIC` in the committed `wrangler.jsonc` is a **non-sensitive placeholder that is never the real topic**. The real value is supplied in production by `wrangler secret put NTFY_ALERT_TOPIC` (Phase 9) — a secret of the same name overrides the `vars` entry — and locally by `.dev.vars`, which is gitignored.
- **Subscriber topics never appear in any file.** They live only in D1's `subscriptions.ntfy_topic`. The committed dev seed uses the placeholder `heating-oil-local-dev`; the real topic `yazan-06483-oil` is inserted into **remote** D1 by Phase 9 and nowhere else.
- The residual exposure is that an unguessable topic name is the whole of the security model. Whether to move to authenticated ntfy is open question **O4**.

**A9. `max_batch_size: 1`** on the consumer is what makes "one zip per invocation" (PRD §5.1) actually true. A larger batch would silently reintroduce the shared-budget failure mode the PRD rejects.

**A10. CPU time against the 10 ms ceiling is an accepted, unresolved risk until Phase 9 measures it.** PRD §9 concludes that this project runs on the free tier "with a wide margin", and for every resource except one that follows from arithmetic. CPU per invocation is the exception: it is the **only binding limit that is reasoned rather than measured**, PRD §9.2 itself flags it as unverified, and no phase before 9 can settle it — local numbers are indicative at best. This plan therefore proceeds on an unproven premise, deliberately and with the risk named. Phase 9 item 8 reads the authoritative figure from Workers observability and judges it against the decision rule in `docs/cpu-measurement.md`. If it lands above 7 ms, the design change (splitting parsing across messages) is already identified; it is not a redesign.

**A11. PRD §9.4's capacity ceiling is optimistic and is corrected here.** §9.4 computes the Queues ceiling at "~2 ops per zip ≈ 5,000 zips/day". Normal delivery costs about **three** Queues operations per message — one write (the producer's `sendBatch` entry), one read (the consumer's pull), and one delete (the ack) — so 10,000 operations/day is nearer **3,300 zips/day**, and a retry adds two more for that message. This does not change the conclusion: **D1 row writes still bind first**, at 100,000 rows/day ÷ 39 rows ≈ **2,560 zips/day** for a 06483-shaped zip. The corrected ordering is D1 rows (~2,560) then Queues operations (~3,300), both orders of magnitude beyond this project's plausible scope. Also note §9.4's per-zip row figure of 44 is the PRD's estimate; the measured figure is 39 (assumption A1).

**A12. No dead-letter queue.** After `max_retries: 3` a message is dropped and that zip has no data for the day. Accepted for a personal daily job; the compensating control is the alert push on every failed attempt, and tomorrow's cron retries from scratch. See Phase 7 item 3.

**A13. `writePriceRows` is a replace, not an upsert.** A rerun for the same `(scrape_date, zip)` deletes the day's rows and rewrites them, so a tier that disappears from the site disappears from the table. The alternative — upsert only — silently preserves stale tiers, and a stale tier could be the one reported as cheapest. The cost is that a partial rerun would leave partial data; that is bounded by the DELETE and INSERTs sharing one `db.batch()`.

**Open question O1.** PRD §8 says a cached slug that stops returning listings should "retry once via the POST path before treating it as a failed zip", but does not say whether a *successful* re-resolution to a *different* slug should be recorded silently or alerted. This plan records it silently and logs it. If the operator wants an alert on slug change, it is one line in `processZip`.

**Open question O2.** Whether a subscription with a `threshold` should send a "no longer below threshold" notification when a previously-qualifying price rises. This plan sends nothing (`threshold_not_met`, silent), per a literal reading of PRD §6 ("notify only when the qualifying price falls below it").

**Open question O3. Delivery time.** The deployed cron is `0 12 * * *` — **12:00 UTC, which is 08:00 US Eastern during EDT and 07:00 during EST**. Confirm this is the desired local delivery time before data accumulates: `scrape_date` is derived from the cron's `scheduledTime` (assumption A6), so changing the cron later changes what "today" means in the stored rows. Phase 9 should note the actual observed delivery time in the deployment log.

**Open question O4. Should the alert topic be authenticated?** Assumption A8 rests entirely on the topic name being unguessable — Phase 9 generates a 32+ character high-entropy value, which is a reasonable secret, but it is still bearer-token-in-a-URL security, and ntfy's public server retains messages for a period after delivery. ntfy supports access tokens and per-topic ACLs. Moving to them means adding an `Authorization: Bearer` header in `sendNtfy`/`sendAlert` and a second secret; it is a small change and is deliberately not made in v1. Decide before the alert topic carries anything more sensitive than "the parser broke".
