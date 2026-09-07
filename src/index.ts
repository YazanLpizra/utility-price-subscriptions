/**
 * Phase 7 — cron producer + queue consumer orchestration.
 *
 * This module wires the four wave-2 modules together and owns nothing else: it
 * contains no HTML knowledge, no SQL, and no notification transport of its own. Every
 * piece of behaviour below is composition.
 *
 * ---------------------------------------------------------------------------
 * SINGLE OWNER FOR ALERTING
 * ---------------------------------------------------------------------------
 * `processZip` NEVER calls `sendAlert`. It throws typed errors (`FetchError`,
 * `ParseError`) and otherwise returns a complete `ProcessZipResult`. The
 * `queue()` handler is the only caller of `sendAlert` on the per-zip path, and
 * `scheduled()` the only caller on the producer path. Two owners would double
 * every alert on an at-least-once redelivery and make the alert channel useless
 * exactly when it matters.
 *
 * ---------------------------------------------------------------------------
 * ERROR ROUTING (implementation-plan §5, Phase 7, item 4)
 * ---------------------------------------------------------------------------
 *   zero listings parsed -> write no PRICE rows, notify nobody, return; queue()
 *                           alerts and ACKs. PRD §8: a missing day beats a wrong
 *                           one. NOTE: the slug resolved for this page IS still
 *                           persisted — the page was structurally valid, so the
 *                           URL is worth caching (see processZip's docblock).
 *   ParseError           -> markup drift. processZip rethrows; queue() alerts
 *                           and ACKs — a retry cannot fix markup. Same slug
 *                           caveat: no PRICE rows, but the slug may be written.
 *   FetchError           -> clearZipSlug (so tomorrow re-resolves from scratch),
 *                           then rethrow; queue() alerts and RETRIES.
 *   sendNotification false -> not a message failure. The D1 write already
 *                           happened, so the data is not lost.
 *   subscription task
 *   rejected             -> processZip throws an aggregate error AFTER the price
 *                           rows are written, so queue() RETRIES. The rows are
 *                           already durable and writePriceRows is idempotent, so
 *                           the retry is safe; the fingerprint dedupe keeps
 *                           already-notified subscriptions from being re-sent.
 *
 * ---------------------------------------------------------------------------
 * A FAILED ALERT IS ONLY OBSERVABLE IN THE LOGS
 * ---------------------------------------------------------------------------
 * `sendAlert` never throws; it returns false. Every call site here checks that
 * boolean and, on false, emits a tagged `ALERT_DELIVERY_FAILED` line via
 * `console.error`. Cloudflare Workers Logs is therefore the durable backstop for
 * an alert that could not be pushed. There is deliberately NO dead-letter queue
 * and NO incidents table: for a single-user personal tracker, observability is
 * the proportionate compensating control. Recorded as an accepted risk in
 * docs/implementation-plan.md §7.
 *
 * ---------------------------------------------------------------------------
 * NO DEAD-LETTER QUEUE IS CONFIGURED
 * ---------------------------------------------------------------------------
 * `wrangler.jsonc` sets `max_retries: 3` with no `dead_letter_queue`. After the
 * third failed attempt a message is **dropped** and that zip simply has no data
 * for the day. This is an ACCEPTED RISK for a personal daily job, recorded here
 * so nobody later reads the retry count as a durability guarantee: the
 * compensating control is the alert pushed on every failed attempt, and
 * tomorrow's cron tries again from scratch. Adding a DLQ is a wrangler.jsonc
 * change plus a second consumer, and is out of scope for v1.
 */
import {
  clearZipSlug,
  getActiveSubscriptions,
  getActiveZips,
  getLastNotifications,
  getTierLows,
  getNotifiedFingerprints,
  getZip,
  tierLowFor,
  recordNotifiedBatch,
  updateZipSlug,
  writePriceRows,
} from "./db";
import type { NotifiedRow } from "./db";
import { FetchError, fetchPricesPage, parseSlugParts } from "./fetcher";
import { ParseError, parseListingsPage, toPriceRows } from "./parser";
import {
  buildNotification,
  evaluateSubscription,
  isStale,
  notificationFingerprint,
  sendAlert,
  shouldNotify,
  sendNotification,
} from "./notify";
import type { TriggerDecision } from "./notify";
import type {
  Env,
  FetchedPage,
  NotificationDecision,
  ScrapeMessage,
  Subscription,
} from "./types";

/** Cents per gallon of movement that is worth interrupting someone for. */
const DEFAULT_MIN_DELTA = 0.05;
/** Send an unconditional check-in when nothing has been sent for this long. */
const DEFAULT_DIGEST_DAYS = 7;

function numberFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The complete, exhaustive result shape. Every branch returns all four fields. */
export interface ProcessZipResult {
  zip: string;
  rows_written: number;
  notifications_sent: number;
  stale: boolean;
}

/** `sendBatch()` accepts at most 100 messages. At 150 zips an unchunked call
 *  fails and the whole day is lost silently, so the producer always chunks. */
const MAX_QUEUE_BATCH = 100;

/** PRD §9.1 caps outbound concurrency at 6. */
const MAX_NOTIFY_CONCURRENCY = 6;

/** Fallback when STALE_AFTER_DAYS is missing or unparseable. */
const DEFAULT_STALE_AFTER_DAYS = 3;

const ZIP_RE = /^\d{5}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** True only for a real calendar date in ISO `yyyy-mm-dd` form. Rejects
 *  "2026-13-45" and "2026-02-30" rather than letting them roll over. */
function isIsoCalendarDate(input: string): boolean {
  const m = ISO_DATE_RE.exec(input);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/** Longest preview of an untrusted value that ever reaches an alert body. */
const PREVIEW_MAX = 120;

/**
 * A short, human-readable preview of an arbitrary untrusted value that CANNOT
 * itself throw.
 *
 * This matters more than it looks. The validator below runs inside `queue()`'s
 * try/catch, and a throw from the validator is caught by the OUTER handler,
 * which treats an unknown error as transient and RETRIES — exactly the opposite
 * of the "malformed -> ack + alert, never retry" contract. `JSON.stringify`
 * throws on a BigInt ("Do not know how to serialize a BigInt") and on a cyclic
 * object, and structured clone happily delivers both through a queue. So every
 * interpolation of a message body goes through here: stringify, then a guarded
 * `String()`, then the bare type — and the result is always truncated.
 */
function safePreview(value: unknown): string {
  let text: string;
  try {
    const json = JSON.stringify(value);
    // undefined and functions stringify to `undefined`, which reads badly.
    text = json === undefined ? typeof value : json;
  } catch {
    try {
      text = `${typeof value}(${String(value)})`;
    } catch {
      // A Symbol, or an object whose toString throws.
      text = typeof value;
    }
  }
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

/**
 * Validates a queue message body before any of it is used. Returns null when
 * the body is usable, or a human-readable reason when it is not.
 *
 * A malformed message is acked and alerted, never retried: retrying an
 * unparseable body burns the retry budget three times and then drops it anyway.
 * This function MUST NOT throw — see `safePreview`.
 */
function validateScrapeMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return `message body is ${body === null ? "null" : typeof body}, expected an object`;
  }
  const candidate = body as Partial<ScrapeMessage>;
  if (typeof candidate.zip !== "string" || !ZIP_RE.test(candidate.zip)) {
    return `zip ${safePreview(candidate.zip)} is not a 5-digit zip`;
  }
  if (
    typeof candidate.scrape_date !== "string" ||
    !isIsoCalendarDate(candidate.scrape_date)
  ) {
    return `scrape_date ${safePreview(candidate.scrape_date)} is not an ISO calendar date`;
  }
  return null;
}

/**
 * A `clearZipSlug` failure ridden along on the FetchError it could not mask.
 * The FetchError stays the thrown value (queue() routes on its type), but the
 * cleanup failure is not lost: `describeError` folds it into the alert body.
 */
interface WithSlugCleanupFailure {
  slug_cleanup_error?: string;
}

function describeError(err: unknown): string {
  const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const cleanup = (err as WithSlugCleanupFailure | null)?.slug_cleanup_error;
  return typeof cleanup === "string"
    ? `${base}\nSLUG_CLEANUP_FAILED: ${cleanup}`
    : base;
}

/**
 * The single alerting call site wrapper. `sendAlert` never throws — it returns
 * false — so an unchecked call can ack a non-retryable message with nobody
 * informed. Every false is turned into a tagged log line, which Cloudflare
 * Workers Logs retains; that is the compensating control for having no DLQ.
 */
async function alertOrLog(
  env: Env,
  zip: string,
  title: string,
  body: string,
): Promise<void> {
  const delivered = await sendAlert(env, title, body);
  if (!delivered) {
    console.error(
      `ALERT_DELIVERY_FAILED zip=${zip} reason=${title} :: ${body.replace(/\n/g, " | ")}`,
    );
  }
}

/** Bounded-concurrency map. Never rejects: every task's outcome is settled. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// processZip
// ---------------------------------------------------------------------------

/**
 * Exported for direct unit testing; processes exactly one zip end to end.
 * NEVER sends an alert itself — it throws typed errors (FetchError, ParseError)
 * and returns structured results. The queue() handler is the only caller of
 * sendAlert.
 *
 * ON THE ZERO-LISTING AND ParseError BRANCHES THIS WRITES NO **PRICE** ROWS —
 * not "nothing". `updateZipSlug` runs at step 3, BEFORE the parse at step 4, so
 * both branches can still persist the slug. That is deliberate: the page
 * fetched and was structurally valid, so its URL is worth caching even when the
 * listings turned out to be missing or undecodable, and re-resolving it
 * tomorrow would cost an extra POST for no benefit. Only a FetchError — where
 * the URL itself is suspect — clears the cached slug.
 */
export async function processZip(
  msg: ScrapeMessage,
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProcessZipResult> {
  const zip = msg.zip;
  const scrapeDate = msg.scrape_date;

  // 1. cached slug (1 query).
  const zipRow = await getZip(env.DB, zip);
  const cachedSlug = zipRow?.slug ?? null;

  // 2. fetch (1-2 subrequests).
  let page: FetchedPage;
  try {
    page = await fetchPricesPage(zip, cachedSlug, env, fetchImpl);
  } catch (err) {
    if (err instanceof FetchError) {
      // Clear the cached slug so tomorrow's run re-resolves from the POST path
      // instead of hammering a URL that no longer works. Best effort: a D1
      // failure here must not mask the FetchError the caller has to route on.
      try {
        await clearZipSlug(env.DB, zip);
      } catch (cleanupErr) {
        // The FetchError below stays the thrown value — queue() routes on its
        // type — but the cleanup failure is not swallowed: it is logged under a
        // tag and ridden along on the error so it reaches the alert body too.
        // A slug that could not be cleared means tomorrow re-fetches the same
        // dead URL, which is worth knowing about.
        const detail =
          cleanupErr instanceof Error
            ? `${cleanupErr.name}: ${cleanupErr.message}`
            : String(cleanupErr);
        console.error(`SLUG_CLEANUP_FAILED zip=${zip} :: ${detail}`);
        (err as WithSlugCleanupFailure).slug_cleanup_error = detail;
      }
    }
    throw err;
  }

  // 3. persist the slug. A null slug is NEVER persisted (Phase 3, item 1):
  // inventing one would poison the cache with a URL that does not exist.
  if (page.slug !== null && (page.resolved_via_post || page.slug !== cachedSlug)) {
    const parts = parseSlugParts(page.slug);
    await updateZipSlug(
      env.DB,
      zip,
      page.slug,
      parts?.city ?? page.city,
      parts?.state ?? page.state,
      page.fetched_at,
    );
  }

  // 4. parse. A ParseError propagates unchanged — queue() acks it.
  const listings = await parseListingsPage(page.html);

  // Zero listings: a valid page with nothing on it. Write nothing, notify
  // nobody (PRD §8 — a missing day beats a wrong one). `stale` is false, not
  // "unknown": staleness is undefined with no listings and false is the
  // non-alarming value; the zero-listing alert from queue() is the signal.
  if (listings.length === 0) {
    return { zip, rows_written: 0, notifications_sent: 0, stale: false };
  }

  // 5. write the day (1 DELETE + ceil(n/8) INSERTs, one batch).
  const rows = toPriceRows(listings, zip, scrapeDate, page.fetched_at);
  const written = await writePriceRows(env.DB, rows);

  // 6. subscriptions (1 query).
  const subs = await getActiveSubscriptions(env.DB, zip);

  const parsedStaleDays = Number(env.STALE_AFTER_DAYS);
  const staleAfterDays = Number.isFinite(parsedStaleDays)
    ? parsedStaleDays
    : DEFAULT_STALE_AFTER_DAYS;

  const stale = isStale(listings, scrapeDate, staleAfterDays);

  // 7. decide, per subscription. Pure — no I/O in this loop.
  const sendable = subs
    .map((sub) => ({
      sub,
      decision: evaluateSubscription(listings, sub, scrapeDate, staleAfterDays),
    }))
    .filter((candidate) => candidate.decision.should_send);

  // 8. de-duplication, in ONE query for the whole zip rather than one per
  // subscription (the per-subscription shape cost 2 queries each, which put
  // ~21 subscriptions over D1's 50-query per-invocation cap).
  //
  // The stored fingerprint is COMPARED, not merely tested for existence. An
  // existing row whose fingerprint MATCHES today's decision means the phone
  // already holds exactly this message — skip. An existing row whose
  // fingerprint DIFFERS means the price genuinely changed since that send, so
  // send again; suppressing it would silently drop a real price movement on a
  // same-day re-run, which is the whole reason the fingerprint is stored.
  // TEMPORARY DIAGNOSTIC ESCAPE HATCH. Setting NOTIFY_DEDUPE="0" makes every
  // run notify, so a short-interval cron can be observed firing from the phone
  // rather than only from the database. Off means one push per run per
  // subscription — at a 5-minute cron that is ~288 pushes a day. Restore this
  // to "1" (or drop the var, which is the same thing) once the schedule is
  // confirmed working.
  const dedupeEnabled = env.NOTIFY_DEDUPE !== "0";

  const subIds = sendable.map((candidate) => candidate.sub.id);

  // Same-day dedupe: a queue retry, or a manual re-run, must not re-push a
  // message the phone already holds.
  const alreadySent = dedupeEnabled
    ? await getNotifiedFingerprints(env.DB, scrapeDate, subIds)
    : new Map<number, string>();

  // Cross-day policy: the anchor each subscriber's price is measured against.
  // Read regardless of the dedupe flag, because it decides whether a message is
  // worth sending at all rather than whether it is a duplicate.
  const lastNotifications = await getLastNotifications(env.DB, subIds);

  // Every tier's historical low in ONE query, so the read cost does not grow
  // with the number of subscriptions.
  const tierLows = await getTierLows(env.DB, zip, scrapeDate);

  const minDelta = numberFrom(env.NOTIFY_MIN_DELTA, DEFAULT_MIN_DELTA);
  const digestAfterDays = numberFrom(env.NOTIFY_DIGEST_DAYS, DEFAULT_DIGEST_DAYS);

  const pending: Array<{
    sub: Subscription;
    decision: NotificationDecision;
    trigger: TriggerDecision;
  }> = [];

  for (const { sub, decision } of sendable) {
    if (dedupeEnabled) {
      const recorded = alreadySent.get(sub.id);
      if (recorded !== undefined && recorded === notificationFingerprint(decision)) {
        continue; // identical message already sent today
      }
    }

    const last = lastNotifications.get(sub.id) ?? null;
    const historicalMinPrice = tierLowFor(tierLows, sub.payment_type, sub.min_gallons);

    const trigger = shouldNotify(
      decision,
      {
        lastNotifiedPrice: last?.price_per_gallon ?? null,
        lastNotifiedDate: last?.scrape_date ?? null,
        historicalMinPrice,
        minDelta,
        digestAfterDays,
      },
      scrapeDate,
    );

    if (!trigger.send) {
      console.log(
        `[processZip] ${zip}: subscription ${sub.id} suppressed (${trigger.reason}, ` +
          `delta=${trigger.delta ?? "n/a"})`,
      );
      continue;
    }
    pending.push({ sub, decision, trigger });
  }

  // 9. notify, bounded at 6 concurrent outbound requests (PRD §9.1).
  const settled = await mapWithConcurrency(
    pending,
    MAX_NOTIFY_CONCURRENCY,
    async ({ sub, decision, trigger }): Promise<NotifiedRow | null> => {
      const sent = await sendNotification(
        env,
        sub.destination,
        buildNotification(decision, zip, scrapeDate, trigger),
        fetchImpl,
      );
      // A false return is logged, never thrown: the data is already in D1.
      if (!sent) {
        console.log(
          `[processZip] ${zip}: notification failed for subscription ${sub.id}; row data is already written`,
        );
        return null;
      }
      return {
        scrape_date: scrapeDate,
        subscription_id: sub.id,
        fingerprint: notificationFingerprint(decision),
        sent_at: new Date().toISOString(),
        // This is what moves the anchor. It is written only on a SUCCESSFUL
        // send, so a failed push leaves the old anchor in place and the next
        // run still measures against the last price actually delivered.
        price_per_gallon: decision.best?.price_per_gallon ?? null,
        reason: trigger.reason,
      };
    },
  );

  // `mapWithConcurrency` settles rather than rejects, so every rejection has to
  // be collected here or it is lost forever behind a log line while the queue
  // ACKs the message. Collect them; the aggregate throw below is what turns a
  // lost notification into a retry.
  const recordRows: NotifiedRow[] = [];
  const failures: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      failures.push(outcome.reason);
      console.error(
        `[processZip] ${zip}: notification task failed: ${describeError(outcome.reason)}`,
      );
      continue;
    }
    if (outcome.value !== null) recordRows.push(outcome.value);
  }
  const notificationsSent = recordRows.length;

  // 10. record every send in one batch. AFTER the sends, never before:
  // recording first would suppress a notification permanently if its push then
  // failed. A failure here joins the aggregate below rather than escaping on
  // its own, so the reporting has a single shape.
  try {
    // Skipped entirely when dedupe is off: with nothing reading the table,
    // writing it would only add D1 work and leave rows that would suppress
    // sends the moment dedupe is switched back on mid-day.
    if (dedupeEnabled) await recordNotifiedBatch(env.DB, recordRows);
  } catch (recordErr) {
    failures.push(recordErr);
    console.error(
      `[processZip] ${zip}: recording ${recordRows.length} sent notification(s) failed: ` +
        describeError(recordErr),
    );
  }

  if (failures.length > 0) {
    // Throwing here makes the queue RETRY. That is safe and deliberate: the
    // price rows are already written and `writePriceRows` is idempotent, and
    // the fingerprint dedupe above keeps the subscriptions that WERE notified
    // from being pushed a second time on the retry.
    throw new Error(
      `[processZip] ${zip}: ${failures.length} of ${pending.length} subscription ` +
        `task(s) failed after ${written.rows} price rows were written; ` +
        `first cause: ${describeError(failures[0])}`,
    );
  }

  return {
    zip,
    rows_written: written.rows,
    notifications_sent: notificationsSent,
    stale,
  };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export default {
  /**
   * The producer (PRD §5.1). Performs NO fetch and NO parsing: it reads the
   * active zips and enqueues one message per zip, so the whole scrape budget
   * lives in the consumer where it can fail per zip.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // One scrape_date, stamped once, so every message in a run agrees even if
    // the batch straddles UTC midnight.
    const scrapeDate = new Date(controller.scheduledTime).toISOString().slice(0, 10);

    try {
      const zips = await getActiveZips(env.DB);

      // Zero active zips is a MISCONFIGURATION, not a failure — and it is the
      // committed seed's default state, since the seed deliberately leaves
      // every zip inactive. Without this branch a forgotten production
      // activation looks exactly like a healthy run: a green cron in the
      // dashboard and indefinite silence on the phone. Alert, log, and return
      // normally: throwing would misreport a config gap as a crash and would
      // burn the cron's error budget every single day.
      if (zips.length === 0) {
        const detail =
          `scrape_date=${scrapeDate}: no active zips — nothing will be scraped. ` +
          `Activate at least one zip (node scripts/seed.mjs --activate <zip>).`;
        console.error(`[scheduled] ${detail}`);
        await alertOrLog(env, "none", "no active zips", detail);
        return;
      }

      const messages = zips.map((z) => ({ body: { zip: z.zip, scrape_date: scrapeDate } }));

      for (const chunk of chunksOf(messages, MAX_QUEUE_BATCH)) {
        await env.SCRAPE_QUEUE.sendBatch(chunk);
      }

      console.log(
        `[scheduled] scrape_date=${scrapeDate} active_zips=${zips.length} ` +
          `batches=${Math.ceil(messages.length / MAX_QUEUE_BATCH)}`,
      );
    } catch (err) {
      // Alert best effort, then RETHROW. A cron invocation that swallows its own
      // failure is reported as a success in Cloudflare's dashboard, and the
      // operator's only signal would be a push that may itself have failed.
      await alertOrLog(
        env,
        "none",
        "cron producer failed",
        `scrape_date=${scrapeDate}\n${describeError(err)}`,
      );
      throw err;
    }
  },

  /**
   * The consumer. Every message is handled in its own try/catch so one bad zip
   * cannot abort the rest of the batch. This handler is the ONLY caller of
   * sendAlert on the per-zip path.
   */
  async queue(
    batch: MessageBatch<ScrapeMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        const invalid = validateScrapeMessage(message.body);
        if (invalid !== null) {
          // Ack, never retry: three more attempts cannot make the body parseable.
          await alertOrLog(
            env,
            "malformed",
            "malformed queue message",
            `Dropping message ${message.id}: ${invalid}`,
          );
          message.ack();
          continue;
        }

        const result = await processZip(message.body, env);

        if (result.rows_written === 0) {
          // Zero listings parsed from a page that fetched and parsed cleanly.
          // Not a message failure — but the operator must hear about it, since
          // silently recording no data for a day is exactly the failure mode
          // PRD §8 wants surfaced.
          await alertOrLog(
            env,
            result.zip,
            `no listings for ${result.zip}`,
            `scrape_date=${message.body.scrape_date} zip=${result.zip}: the page ` +
              `parsed cleanly but contained zero listings. No rows written, ` +
              `no subscribers notified.`,
          );
        }

        message.ack();
      } catch (err) {
        const zip = (message.body as Partial<ScrapeMessage> | undefined)?.zip ?? "unknown";
        await alertOrLog(
          env,
          zip,
          `zip ${zip} failed`,
          `message=${message.id} attempts=${message.attempts}\n${describeError(err)}`,
        );

        if (err instanceof ParseError) {
          // Markup drift. Retrying replays the same broken HTML three times and
          // then drops it anyway, so ack and let the alert carry the signal.
          message.ack();
        } else {
          // FetchError and everything unexpected: transient until proven
          // otherwise. Bounded by max_retries: 3 in wrangler.jsonc.
          message.retry();
        }
      }
    }
  },
};
