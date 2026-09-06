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
