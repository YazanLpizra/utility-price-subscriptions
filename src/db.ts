/**
 * D1 access layer (Phase 4).
 *
 * This module talks to D1 and to nothing else: it imports only `./types` and the
 * Workers type declarations. It never imports `./parser`, `./fetcher`, or
 * `./notify`, so it can be unit-tested against a local D1 in isolation.
 *
 * ---------------------------------------------------------------------------
 * Parameter arithmetic
 * ---------------------------------------------------------------------------
 * A `PriceRow` binds **11** columns, not 12: `prices.id` is `INTEGER PRIMARY KEY
 * AUTOINCREMENT` and is never bound. So a multi-row INSERT of
 * `ROWS_PER_INSERT = 8` rows binds 8 x 11 = **88** parameters, against D1's
 * 100-parameter-per-statement cap. Nine rows (99) would also fit; 8 is kept as a
 * deliberate conservative choice that leaves a whole row of margin, and because
 * every statement-count figure in the implementation plan (39 rows -> 5 INSERTs)
 * is derived from it. PRD 9.3's "12 columns" figure counts `id` and is wrong.
 *
 * ---------------------------------------------------------------------------
 * Per-invocation query budget (D1 caps a Worker invocation at 50 queries)
 * ---------------------------------------------------------------------------
 * The per-subscription pair (`wasNotified` + `recordNotified`) made the cost
 * `8 + 2S` for S subscriptions, so ~21 subscriptions on one zip would breach the
 * 50-query cap. `getNotifiedFingerprints` and `recordNotifiedBatch` replace that
 * pair with two statements that do not grow with S, making the cost constant.
 *
 * For one zip whose page yields 39 price rows and which has two subscriptions
 * that both get notified:
 *
 *     1  zip read            (getZip)
 *   + 1  DELETE              (writePriceRows, inside the single batch)
 *   + 5  INSERTs             (ceil(39 / 8) = 5, same batch)
 *   + 1  slug update         (updateZipSlug; skipped when the cached slug held)
 *   + 1  subscription read   (getActiveSubscriptions)
 *   + 1  dedupe read         (getNotifiedFingerprints, one IN (...) query)
 *   + 1  dedupe write        (recordNotifiedBatch, one multi-row INSERT)
 *   ------------------------------------------------------------------
 *   = 11 of 50
 *
 * On a cached slug the slug update does not happen, so the realistic steady
 * state is 10 and the worst case above is 11. Phase 7's guard stays at 14 —
 * headroom over both, and still far below D1's cap.
 *
 * `wasNotified` and `recordNotified` are retained as the single-row API; the
 * orchestration layer uses the batch pair.
 *
 * ---------------------------------------------------------------------------
 * Why `writePriceRows` is a REPLACE, not an upsert
 * ---------------------------------------------------------------------------
 * A bare `INSERT ... ON CONFLICT DO UPDATE` leaves a gallon tier that has
 * vanished from the site sitting in the table from an earlier run on the same
 * day. That stale tier could later be reported as the cheapest price. So every
 * call issues, first and in the *same* `db.batch()`, a
 * `DELETE FROM prices WHERE scrape_date = ? AND zip = ?`. Because the DELETE is
 * keyed on a single `(scrape_date, zip)`, every row handed to one call must
 * share that pair; a violation throws rather than deleting the wrong day's data.
 * The `ON CONFLICT DO UPDATE` clause is retained anyway: it keeps each
 * individual statement safe under a partially applied batch.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { PriceRow, Subscription, ZipRow } from "./types";

/**
 * Max rows per multi-row INSERT. A PriceRow binds 11 columns (`id` is AUTOINCREMENT and
 * is not bound), so 8 rows = 88 bound parameters against D1's 100-parameter cap.
 * 9 rows (99 params) would also fit; 8 is kept as a deliberate conservative choice that
 * leaves one row of margin, and because every row-count assertion in this plan
 * (39 rows -> 5 statements) is derived from it.
 */
export const ROWS_PER_INSERT = 8;

/** The 11 bound columns of `prices`, in the exact order of the INSERT in the plan. */
const PRICE_COLUMNS = [
  "scrape_date",
  "zip",
  "dealer_id",
  "payment_type",
  "gallon_min",
  "gallon_max",
  "price_per_gallon",
  "delivery_date",
  "price_updated_on",
  "same_day_charge",
  "scraped_at",
] as const;

/** 11. Kept as a derived constant so the SQL and the arithmetic cannot drift apart. */
const BOUND_COLUMNS_PER_ROW = PRICE_COLUMNS.length;

const DELETE_DAY_SQL =
  "DELETE FROM prices WHERE scrape_date = ? AND zip = ?";

/**
 * Builds the multi-row INSERT for exactly `rowCount` rows, so the final short
 * chunk is a valid statement rather than a fixed-width one padded with nulls.
 */
function buildInsertSql(rowCount: number): string {
  const oneRow = `(${PRICE_COLUMNS.map(() => "?").join(",")})`;
  const values = Array.from({ length: rowCount }, () => oneRow).join(", ");
  return (
    `INSERT INTO prices\n` +
    `  (${PRICE_COLUMNS.join(", ")})\n` +
    `VALUES ${values}\n` +
    `ON CONFLICT (scrape_date, zip, dealer_id, payment_type, gallon_min) DO UPDATE SET\n` +
    `  gallon_max       = excluded.gallon_max,\n` +
    `  price_per_gallon = excluded.price_per_gallon,\n` +
    `  delivery_date    = excluded.delivery_date,\n` +
    `  price_updated_on = excluded.price_updated_on,\n` +
    `  same_day_charge  = excluded.same_day_charge,\n` +
    `  scraped_at       = excluded.scraped_at`
  );
}

/** Flattens one row into its 11 bound values, in `PRICE_COLUMNS` order. */
function bindValues(row: PriceRow): unknown[] {
  return [
    row.scrape_date,
    row.zip,
    row.dealer_id,
    row.payment_type,
    row.gallon_min,
    row.gallon_max,
    row.price_per_gallon,
    row.delivery_date,
    row.price_updated_on,
    row.same_day_charge,
    row.scraped_at,
  ];
}

const ZIP_COLUMNS = "zip, slug, city, state, active, slug_resolved_at";

export async function getActiveZips(db: D1Database): Promise<ZipRow[]> {
  const result = await db
    .prepare(`SELECT ${ZIP_COLUMNS} FROM zips WHERE active = 1 ORDER BY zip`)
    .all<ZipRow>();
  return result.results ?? [];
}

export async function getZip(
  db: D1Database,
  zip: string,
): Promise<ZipRow | null> {
  const row = await db
    .prepare(`SELECT ${ZIP_COLUMNS} FROM zips WHERE zip = ?`)
    .bind(zip)
    .first<ZipRow>();
  return row ?? null;
}

export async function updateZipSlug(
  db: D1Database,
  zip: string,
  slug: string,
  city: string | null,
  state: string | null,
  resolvedAt: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE zips SET slug = ?, city = ?, state = ?, slug_resolved_at = ? WHERE zip = ?",
    )
    .bind(slug, city, state, resolvedAt, zip)
    .run();
}

export async function clearZipSlug(
  db: D1Database,
  zip: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE zips SET slug = NULL, slug_resolved_at = NULL WHERE zip = ?",
    )
    .bind(zip)
    .run();
}

/**
 * Replaces the day's data for one (scrape_date, zip). In a single db.batch():
 *   1. DELETE FROM prices WHERE scrape_date = ? AND zip = ?
 *   2. the rows chunked into groups of ROWS_PER_INSERT, one multi-row
 *      INSERT ... ON CONFLICT DO UPDATE per chunk.
 * All rows must share one (scrape_date, zip); throws if they do not.
 * `statements` counts the DELETE. Writing [] is a no-op that issues zero queries
 * (no DELETE either — there is no key to delete by).
 */
export async function writePriceRows(
  db: D1Database,
  rows: PriceRow[],
): Promise<{ statements: number; rows: number }> {
  if (rows.length === 0) {
    // No key to delete by, so not even the DELETE runs.
    return { statements: 0, rows: 0 };
  }

  const first = rows[0] as PriceRow;
  const scrapeDate = first.scrape_date;
  const zip = first.zip;

  // Precondition check runs BEFORE any db.prepare(), so a mixed-key call issues
  // no D1 call at all. Silently deleting the wrong day's data is the worst
  // available failure mode, so this throws.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as PriceRow;
    if (row.scrape_date !== scrapeDate || row.zip !== zip) {
      throw new Error(
        `writePriceRows: all rows must share one (scrape_date, zip); ` +
          `row 0 is (${scrapeDate}, ${zip}) but row ${i} is ` +
          `(${row.scrape_date}, ${row.zip})`,
      );
    }
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(DELETE_DAY_SQL).bind(scrapeDate, zip),
  ];

  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const params: unknown[] = [];
    for (const row of chunk) params.push(...bindValues(row));
    // chunk.length * 11 params; at most 8 * 11 = 88, under D1's cap of 100.
    statements.push(db.prepare(buildInsertSql(chunk.length)).bind(...params));
  }

  await db.batch(statements);
  return { statements: statements.length, rows: rows.length };
}

export async function getActiveSubscriptions(
  db: D1Database,
  zip: string,
): Promise<Subscription[]> {
  const result = await db
    .prepare(
      "SELECT id, user_id, zip, destination, min_gallons, payment_type, threshold, active " +
        "FROM subscriptions WHERE zip = ? AND active = 1 ORDER BY id",
    )
    .bind(zip)
    .all<Subscription>();
  return result.results ?? [];
}

/** true when a notification for this (scrape_date, subscription) has already been sent. */
export async function wasNotified(
  db: D1Database,
  scrapeDate: string,
  subscriptionId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS hit FROM notifications WHERE scrape_date = ? AND subscription_id = ?",
    )
    .bind(scrapeDate, subscriptionId)
    .first<{ hit: number }>();
  return row !== null && row !== undefined;
}

/** Records a sent notification. Idempotent: a second call for the same key is a no-op
 *  (INSERT ... ON CONFLICT DO NOTHING) and must not throw. */
export async function recordNotified(
  db: D1Database,
  scrapeDate: string,
  subscriptionId: number,
  fingerprint: string,
  sentAt: string,
): Promise<void> {
  // Queues delivery is at-least-once. A retry after a *successful* push must
  // not turn into a constraint error that fails the whole invocation, and must not
  // overwrite the fingerprint that was actually sent — hence DO NOTHING, not
  // DO UPDATE.
  await db
    .prepare(
      "INSERT INTO notifications (scrape_date, subscription_id, fingerprint, sent_at) " +
        "VALUES (?,?,?,?) ON CONFLICT (scrape_date, subscription_id) DO NOTHING",
    )
    .bind(scrapeDate, subscriptionId, fingerprint, sentAt)
    .run();
}

/** One `notifications` row, as handed to `recordNotifiedBatch`. */
export interface NotifiedRow {
  scrape_date: string;
  subscription_id: number;
  fingerprint: string;
  sent_at: string;
}

/**
 * The dedupe state for every subscription in one call, so the read cost does
 * not grow with the number of subscriptions (the previous one-`wasNotified`-per-
 * subscription shape put ~21 subscriptions over D1's 50-query cap).
 *
 * Returns `subscription_id -> fingerprint` for the rows that exist. A missing
 * key means "never notified today"; a present key whose value differs from the
 * fingerprint of today's decision means the price genuinely changed since the
 * recorded send, which the caller treats as a reason to send again rather than
 * to suppress.
 *
 * An empty `subscriptionIds` issues **no query at all**.
 *
 * One statement binds `1 + subscriptionIds.length` parameters against D1's
 * 100-parameter cap, so this supports up to 99 subscriptions on a single zip —
 * far beyond anything this project will see.
 */
export async function getNotifiedFingerprints(
  db: D1Database,
  scrapeDate: string,
  subscriptionIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (subscriptionIds.length === 0) return out;

  const placeholders = subscriptionIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      "SELECT subscription_id, fingerprint FROM notifications " +
        `WHERE scrape_date = ? AND subscription_id IN (${placeholders})`,
    )
    .bind(scrapeDate, ...subscriptionIds)
    .all<{ subscription_id: number; fingerprint: string }>();

  for (const row of result.results ?? []) {
    out.set(row.subscription_id, row.fingerprint);
  }
  return out;
}

/**
 * Max `notifications` rows per multi-row INSERT. A row binds 4 columns, so 24
 * rows = 96 bound parameters against D1's 100-parameter cap. Kept conservative
 * for the same reason as `ROWS_PER_INSERT`.
 */
const NOTIFIED_ROWS_PER_INSERT = 24;

/**
 * Records every send of one run in a single `db.batch()`, so the write cost does
 * not grow with the number of subscriptions either.
 *
 * `DO UPDATE`, not `DO NOTHING`: the caller only reaches this for a send it
 * actually made, and on a same-day re-run where the price CHANGED the row must
 * carry the fingerprint that was last pushed — otherwise the stored fingerprint
 * describes a notification the phone no longer has, and the next comparison is
 * made against a stale value.
 *
 * An empty `rows` issues **no query at all**.
 */
export async function recordNotifiedBatch(
  db: D1Database,
  rows: NotifiedRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += NOTIFIED_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + NOTIFIED_ROWS_PER_INSERT);
    const values = chunk.map(() => "(?,?,?,?)").join(", ");
    const params: unknown[] = [];
    for (const row of chunk) {
      params.push(row.scrape_date, row.subscription_id, row.fingerprint, row.sent_at);
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO notifications (scrape_date, subscription_id, fingerprint, sent_at) " +
            `VALUES ${values} ` +
            "ON CONFLICT (scrape_date, subscription_id) DO UPDATE SET " +
            "fingerprint = excluded.fingerprint, sent_at = excluded.sent_at",
        )
        .bind(...params),
    );
  }

  await db.batch(statements);
}
