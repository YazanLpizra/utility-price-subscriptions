/**
 * Phase 5 — subscription evaluation, staleness, ntfy transport.
 *
 * This module is deliberately pure except for the two transport functions, and it
 * imports NOTHING but `./types`. No D1 access lives here: `selectBestPrice`,
 * `isStale`, `evaluateSubscription`, `buildNotification` and
 * `notificationFingerprint` are all functions of their arguments alone, so the
 * whole decision layer is unit-testable without a database or a network.
 *
 * The product point (PRD §5.3): a bare "cheapest price" is actively misleading.
 * On the fixture day the cheapest 06483 cash price is $4.84 — but only at 100+
 * gallons. A subscriber who wants 50 gallons actually faces $5.64. Every price
 * this module reports is therefore filtered by the subscriber's own
 * `min_gallons` and `payment_type` before anything is compared.
 */
import type {
  BestPrice,
  Env,
  NotificationDecision,
  NtfyMessage,
  ParsedListing,
  Subscription,
} from "./types";

/**
 * The one grammar for an ntfy topic, used by both `sendNtfy` and `sendAlert`.
 *
 * On unauthenticated ntfy the topic name IS the credential, and a subscriber
 * topic is user-supplied data read out of D1. A value containing `/`, `..`, `?`
 * or a newline would let it address a different ntfy endpoint or inject a
 * header, so it is rejected before any request is issued.
 */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** ISO `yyyy-mm-dd` — the only date shape this module accepts. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `yyyy-mm-dd` -> UTC epoch milliseconds at midnight, or null when unparseable.
 * No date library (§3: zero runtime dependencies); `Date.UTC` is exact for this.
 * Round-tripped back to components so "2026-02-30" is rejected rather than
 * silently rolling over into March.
 */
function parseIsoDateUtc(input: string | null | undefined): number | null {
  if (typeof input !== "string") return null;
  const m = ISO_DATE_RE.exec(input);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `fromIso` to `toIso`. Both are UTC midnights, so the
 * difference is an exact multiple of a day — no DST, no rounding.
 */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = parseIsoDateUtc(fromIso);
  const to = parseIsoDateUtc(toIso);
  if (from === null || to === null) return null;
  return (to - from) / MS_PER_DAY;
}

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
): BestPrice | null {
  let best: BestPrice | null = null;

  for (const listing of listings) {
    for (const tier of listing.tiers) {
      if (tier.payment_type !== sub.payment_type) continue;
      if (sub.min_gallons < tier.gallon_min) continue;
      if (tier.gallon_max !== null && sub.min_gallons > tier.gallon_max) {
        continue;
      }

      const candidate: BestPrice = {
        dealer_id: listing.dealer_id,
        payment_type: tier.payment_type,
        gallon_min: tier.gallon_min,
        gallon_max: tier.gallon_max,
        price_per_gallon: tier.price_per_gallon,
        delivery_date: listing.delivery_date,
        price_updated_on: listing.price_updated_on,
      };

      if (best === null) {
        best = candidate;
        continue;
      }
      if (candidate.price_per_gallon < best.price_per_gallon) {
        best = candidate;
        continue;
      }
      // Four dealers share $4.84 and four share $5.19 in the fixture, so
      // without an explicit tie-break the "best" dealer depends on iteration
      // order and every downstream test is flaky. Lowest dealer_id wins.
      if (
        candidate.price_per_gallon === best.price_per_gallon &&
        candidate.dealer_id < best.dealer_id
      ) {
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * true when max(price_updated_on) across listings is more than staleAfterDays
 * before scrapeDate, or when no listing carries a price_updated_on (PRD 5.4).
 *
 * The boundary is strictly `>`: with N = 3, data exactly 3 days old is NOT
 * stale; 4 days old is.
 */
export function isStale(
  listings: ParsedListing[],
  scrapeDate: string,
  staleAfterDays: number,
): boolean {
  let newest: string | null = null;
  for (const listing of listings) {
    const updated = listing.price_updated_on;
    if (parseIsoDateUtc(updated) === null) continue;
    // ISO yyyy-mm-dd sorts lexicographically the same way it sorts by date.
    if (newest === null || (updated as string) > newest) {
      newest = updated as string;
    }
  }

  // No listing carries a usable price_updated_on (empty input included):
  // we cannot show freshness, so we must not imply it.
  if (newest === null) return true;

  const age = daysBetween(newest, scrapeDate);
  if (age === null) return true; // unparseable scrapeDate — fail safe.
  return age > staleAfterDays;
}

export function evaluateSubscription(
  listings: ParsedListing[],
  sub: Subscription,
  scrapeDate: string,
  staleAfterDays: number,
): NotificationDecision {
  const stale = isStale(listings, scrapeDate, staleAfterDays);
  const best = selectBestPrice(listings, sub);

  if (best === null) {
    return {
      subscription: sub,
      best: null,
      stale,
      reason: "no_qualifying_tier",
      should_send: false,
    };
  }

  if (sub.threshold !== null && best.price_per_gallon >= sub.threshold) {
    return {
      subscription: sub,
      best,
      stale,
      reason: "threshold_not_met",
      should_send: false,
    };
  }

  return {
    subscription: sub,
    best,
    stale,
    reason: "send",
    should_send: true,
  };
}

/** "100-149" -> "100–149 gal"; an open-ended tier -> "400+ gal". */
function formatTier(gallonMin: number, gallonMax: number | null): string {
  return gallonMax === null
    ? `${gallonMin}+ gal`
    : `${gallonMin}–${gallonMax} gal`;
}

/**
 * Deterministic, pure. Body carries price, tier, payment type, delivery date,
 * price-updated-on, scrape date, and a stale banner when decision.stale.
 */
export function buildNotification(
  decision: NotificationDecision,
  zip: string,
  scrapeDate: string,
): NtfyMessage {
  const { best, stale } = decision;
  const sub = decision.subscription;

  if (best === null) {
    // Defensive: Phase 7 only builds messages for should_send decisions, but a
    // decision with no best price must still produce a coherent, non-throwing
    // message rather than a crash inside the queue consumer.
    const title = `${stale ? "[STALE] " : ""}No qualifying price for ${zip}`;
    const lines = [
      `No dealer offers ${sub.min_gallons} gal (${sub.payment_type}) in ${zip}.`,
      `Zip: ${zip}`,
      `Scrape date: ${scrapeDate}`,
    ];
    if (stale) lines.push("Data may be stale: no dealer reported a price update.");
    return {
      title,
      body: lines.join("\n"),
      tags: stale ? ["warning", "fuelpump"] : ["fuelpump"],
      priority: stale ? 4 : 3,
    };
  }

  const price = best.price_per_gallon.toFixed(2);
  const tier = formatTier(best.gallon_min, best.gallon_max);

  const title =
    `${stale ? "[STALE] " : ""}$${price}/gal ${best.payment_type} in ${zip}`;

  const lines = [
    `$${price} per gallon (${best.payment_type})`,
    `Tier: ${tier} — you asked for ${sub.min_gallons} gal`,
    `Dealer: ${best.dealer_id}`,
    `Delivery date: ${best.delivery_date ?? "unknown"}`,
    `Price updated on: ${best.price_updated_on ?? "unknown"}`,
    `Scrape date: ${scrapeDate}`,
    `Zip: ${zip}`,
  ];

  if (stale) {
    lines.push(
      `STALE: last price update ${best.price_updated_on ?? "unknown"} is older` +
        ` than the configured staleness threshold as of ${scrapeDate}.`,
    );
  }

  return {
    title,
    body: lines.join("\n"),
    tags: stale ? ["warning", "fuelpump"] : ["fuelpump"],
    priority: stale ? 4 : 3,
  };
}

/**
 * Stable, pure fingerprint of what a notification would say, over exactly:
 * dealer_id, payment_type, gallon_min, price_per_gallon, stale.
 * Used as the dedupe value in the `notifications` table. Must be deterministic
 * across processes — no Date.now(), no object key iteration order dependence.
 *
 * Queues delivery is at-least-once: a retry after a *successful* push would
 * otherwise notify the phone twice for the same day. Phase 7 stores this value
 * so "did today's push say the same thing the dedupe row recorded?" is
 * answerable from D1 alone.
 */
export function notificationFingerprint(decision: NotificationDecision): string {
  const best = decision.best;
  const stale = decision.stale ? 1 : 0;
  if (best === null) return `none|none|0|0.00|${stale}`;
  return [
    String(best.dealer_id),
    best.payment_type,
    String(best.gallon_min),
    best.price_per_gallon.toFixed(2),
    String(stale),
  ].join("|");
}

/**
 * The one place a request is actually issued. Shared by `sendNtfy` and
 * `sendAlert` so the topic validation, the encoding and the never-throw
 * guarantee cannot drift apart between them.
 */
async function postToNtfy(
  env: Env,
  topic: string,
  msg: NtfyMessage,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  // Validate BEFORE constructing a URL or touching the network.
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) return false;

  try {
    // Encoded even though the validator already excludes every character that
    // would need encoding: correct by construction, not by the validator
    // happening to stay strict.
    const url = `${env.NTFY_BASE_URL}/${encodeURIComponent(topic)}`;
    const headers: Record<string, string> = {
      Title: msg.title,
      Tags: msg.tags.join(","),
      Priority: String(msg.priority),
    };
    // Authenticate when a token is configured. ntfy meters anonymous publishing
    // per source IP; Workers share egress IPs, so unauthenticated pushes from
    // production get 429 "daily message quota reached" regardless of our own
    // volume. The token moves metering to the owning account. It is a secret:
    // never log it, and never put it in wrangler.jsonc vars.
    // Trimmed: `wrangler secret put` reads stdin, and piping a value through a
    // shell very easily stores a trailing newline. An untrimmed token produces
    // a malformed header and a 401 that looks exactly like a bad credential —
    // which cost a diagnosis cycle here.
    const token = env.NTFY_TOKEN?.trim();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: msg.body,
      // A stalled ntfy connection would otherwise hold a queue invocation open
      // against its 15-minute ceiling. `src/fetcher.ts` already bounds the site
      // fetch the same way; ntfy is the shorter hop, so 10s is generous.
      // The abort surfaces as a rejection, which the catch below turns into
      // `false` — the never-throw guarantee is unchanged.
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 200 && res.status < 300) return true;
    // Log WHY. Without this a failed push is indistinguishable from a
    // suppressed one, which cost real time to diagnose in production. The
    // status and a short body excerpt are enough to tell a rate limit from a
    // rejected payload; the topic is never logged, because on unauthenticated
    // ntfy it is the credential.
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 200);
    } catch {
      excerpt = "<unreadable body>";
    }
    console.error(
      `[ntfy] push rejected: status=${res.status} ${res.statusText} body=${excerpt}`,
    );
    return false;
  } catch (err) {
    // PRD §8: a failed push must not lose data that is already written, so a
    // transport failure — timeout included — is a `false`, never an exception.
    // The topic is never logged: on unauthenticated ntfy it is the credential.
    console.error(
      `[ntfy] push threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    return false;
  }
}

/**
 * POSTs to `${env.NTFY_BASE_URL}/${encodeURIComponent(topic)}`.
 * Rejects (returns false, never throws) a topic not matching /^[A-Za-z0-9_-]{1,64}$/
 * before issuing any request. Never throws; returns false on failure (PRD 8).
 */
export function sendNtfy(
  env: Env,
  topic: string,
  msg: NtfyMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return postToNtfy(env, topic, msg, fetchImpl);
}

/** Operational alert to env.NTFY_ALERT_TOPIC at priority 4, tag "warning". Never throws. */
export function sendAlert(
  env: Env,
  title: string,
  body: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  // In production NTFY_ALERT_TOPIC arrives as a Cloudflare secret (Phase 9),
  // not from the placeholder in wrangler.jsonc. It is an ordinary string here
  // and its value is never logged.
  return postToNtfy(
    env,
    env.NTFY_ALERT_TOPIC,
    {
      title: `heating-oil-tracker: ${title}`,
      body,
      tags: ["warning"],
      priority: 4,
    },
    fetchImpl,
  );
}
