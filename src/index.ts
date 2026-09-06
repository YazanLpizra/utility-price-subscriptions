/**
 * Phase 7 — cron producer + queue consumer orchestration.
 *
 * This module wires the four wave-2 modules together and owns nothing else: it
 * contains no HTML knowledge, no SQL, and no ntfy transport of its own. Every
 * piece of behaviour below is composition.
 *
 * ---------------------------------------------------------------------------
 * SINGLE OWNER FOR ALERTING
 * ---------------------------------------------------------------------------
 * `processZip` NEVER calls `sendAlert`. It throws typed errors (`FetchError`,
 * `ParseError`) and otherwise returns a complete `ProcessZipResult`. The
 * `queue()` handler is the only caller of `sendAlert` on the per-zip path, and
 * `scheduled()` the only caller on the producer path. Two owners would double
 * every alert on an at-least-once redelivery and make the alert topic useless
 * exactly when it matters.
 *
 * ---------------------------------------------------------------------------
 * ERROR ROUTING (implementation-plan §5, Phase 7, item 4)
 * ---------------------------------------------------------------------------
 *   zero listings parsed -> write nothing, notify nobody, return; queue() alerts
 *                           and ACKs. PRD §8: a missing day beats a wrong one.
 *   ParseError           -> markup drift. processZip rethrows; queue() alerts
 *                           and ACKs — a retry cannot fix markup.
 *   FetchError           -> clearZipSlug (so tomorrow re-resolves from scratch),
 *                           then rethrow; queue() alerts and RETRIES.
 *   sendNtfy false       -> not a message failure. The D1 write already
 *                           happened, so the data is not lost.
 *
 * ---------------------------------------------------------------------------
 * NO DEAD-LETTER QUEUE IS CONFIGURED
 * ---------------------------------------------------------------------------
 * `wrangler.jsonc` sets `max_retries: 3` with no `dead_letter_queue`. After the
 * third failed attempt a message is **dropped** and that zip simply has no data
 * for the day. This is an ACCEPTED RISK for a personal daily job, recorded here
 * so nobody later reads the retry count as a durability guarantee: the
 * compensating control is the ntfy alert pushed on every failed attempt, and
 * tomorrow's cron tries again from scratch. Adding a DLQ is a wrangler.jsonc
 * change plus a second consumer, and is out of scope for v1.
 */
import {
  clearZipSlug,
  getActiveSubscriptions,
  getActiveZips,
  getZip,
  recordNotified,
  updateZipSlug,
  wasNotified,
  writePriceRows,
} from "./db";
import { FetchError, fetchPricesPage, parseSlugParts } from "./fetcher";
import { ParseError, parseListingsPage, toPriceRows } from "./parser";
import {
  buildNotification,
  evaluateSubscription,
  isStale,
  notificationFingerprint,
  sendAlert,
  sendNtfy,
} from "./notify";
import type { Env, FetchedPage, ScrapeMessage } from "./types";

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

/**
 * Validates a queue message body before any of it is used. Returns null when
 * the body is usable, or a human-readable reason when it is not.
 *
 * A malformed message is acked and alerted, never retried: retrying an
 * unparseable body burns the retry budget three times and then drops it anyway.
 */
function validateScrapeMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return `message body is ${body === null ? "null" : typeof body}, expected an object`;
  }
  const candidate = body as Partial<ScrapeMessage>;
  if (typeof candidate.zip !== "string" || !ZIP_RE.test(candidate.zip)) {
    return `zip ${JSON.stringify(candidate.zip)} is not a 5-digit zip`;
  }
  if (
    typeof candidate.scrape_date !== "string" ||
    !isIsoCalendarDate(candidate.scrape_date)
  ) {
    return `scrape_date ${JSON.stringify(candidate.scrape_date)} is not an ISO calendar date`;
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
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
      } catch {
        // deliberately swallowed — the FetchError below is the real signal.
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

  // 7. evaluate + notify, bounded at 6 concurrent outbound requests.
  const settled = await mapWithConcurrency(subs, MAX_NOTIFY_CONCURRENCY, async (sub) => {
    const decision = evaluateSubscription(listings, sub, scrapeDate, staleAfterDays);
    if (!decision.should_send) return false;

    // De-duplication. Queues delivery is at-least-once and a D1 write is
    // idempotent, but an ntfy push is not: without this guard a retry after a
    // successful push notifies the phone twice for the same day.
    if (await wasNotified(env.DB, scrapeDate, sub.id)) return false;

    const sent = await sendNtfy(
      env,
      sub.ntfy_topic,
      buildNotification(decision, zip, scrapeDate),
      fetchImpl,
    );
    // A false return is logged, never thrown: the data is already in D1.
    if (!sent) {
      console.log(
        `[processZip] ${zip}: ntfy push failed for subscription ${sub.id}; row data is already written`,
      );
      return false;
    }

    // Record AFTER a successful send, never before. Recording first would
    // suppress the notification permanently if the push then failed.
    await recordNotified(
      env.DB,
      scrapeDate,
      sub.id,
      notificationFingerprint(decision),
      new Date().toISOString(),
    );
    return true;
  });

  let notificationsSent = 0;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value) notificationsSent++;
    if (outcome.status === "rejected") {
      console.log(
        `[processZip] ${zip}: notification task failed: ${describeError(outcome.reason)}`,
      );
    }
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
      // operator's only signal would be an ntfy push that may itself have failed.
      await sendAlert(
        env,
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
          await sendAlert(
            env,
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
          await sendAlert(
            env,
            `no listings for ${result.zip}`,
            `scrape_date=${message.body.scrape_date} zip=${result.zip}: the page ` +
              `parsed cleanly but contained zero listings. No rows written, ` +
              `no subscribers notified.`,
          );
        }

        message.ack();
      } catch (err) {
        const zip = (message.body as Partial<ScrapeMessage> | undefined)?.zip ?? "unknown";
        await sendAlert(
          env,
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
