/**
 * Phase 5 — subscription evaluation, staleness, and notification delivery.
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
  NotificationMessage,
  ParsedListing,
  Subscription,
} from "./types";

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
): NotificationMessage {
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
 * A Telegram chat id: digits, optionally negative for groups and channels.
 * Validated because it is user-supplied data read out of D1 and interpolated
 * into a request body.
 */
const CHAT_ID_RE = /^-?[1-9]\d{0,18}$/;

/** Telegram ids fit in 52 significant bits. */
const MAX_CHAT_ID = 2n ** 52n;

function isValidChatId(value: string): boolean {
  const trimmed = value.trim();
  if (!CHAT_ID_RE.test(trimmed)) return false;
  const magnitude = BigInt(trimmed < "0" ? trimmed.slice(1) : trimmed);
  return magnitude > 0n && magnitude < MAX_CHAT_ID;
}

/** Telegram's documented maximum for `sendMessage.text`. */
const MAX_TEXT_CHARS = 4096;
const TRUNCATION_MARK = "\n[truncated]";

function truncateText(text: string): string {
  const points = Array.from(text);
  if (points.length <= MAX_TEXT_CHARS) return text;
  const keep = MAX_TEXT_CHARS - Array.from(TRUNCATION_MARK).length;
  return points.slice(0, keep).join("") + TRUNCATION_MARK;
}

/**
 * Telegram transport.
 *
 * WHY TELEGRAM: the original design used ntfy.sh, which meters anonymous
 * publishing per source IP. Cloudflare Workers egress from shared IPs whose
 * daily quota is routinely already spent by other tenants, so production
 * pushes returned 429 while the identical payload succeeded from a home IP.
 * An ntfy access token did not fix it either — `/v1/account` reports
 * `limits.basis = "ip"` for free accounts. Telegram meters per bot token,
 * which is ours alone. (Recorded so nobody reintroduces ntfy expecting the
 * token to be the missing piece.)
 *
 * Sent as plain text with no `parse_mode`: prices contain `$`, `.` and `-`,
 * all of which are MarkdownV2 metacharacters, and a formatting error would be
 * a 400 rather than a delivered message.
 */
async function postToTelegram(
  env: Env,
  chatId: string,
  msg: NotificationMessage,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error("[telegram] no TELEGRAM_BOT_TOKEN configured; cannot send");
    return false;
  }
  if (typeof chatId !== "string" || !isValidChatId(chatId)) {
    console.error("[telegram] refusing to send to a malformed chat id");
    return false;
  }

  try {
    const base = (env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        // Telegram rejects text over 4096 characters with a 400. Alerts
        // interpolate untrusted page content, so an unbounded message would
        // make the very alert reporting markup drift vanish. Truncate by code
        // point, not by UTF-16 unit, so a surrogate pair is never split.
        text: truncateText(`${msg.title}\n\n${msg.body}`),
        disable_notification: msg.priority <= 2,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 200 && res.status < 300) return true;
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 200);
    } catch {
      excerpt = "<unreadable body>";
    }
    // The bot token is part of the URL, so the URL is NEVER logged.
    console.error(
      `[telegram] send rejected: status=${res.status} ${res.statusText} body=${excerpt}`,
    );
    return false;
  } catch (err) {
    // Deliberately NOT err.message: a runtime/fetch error can embed the request
    // URL, and the bot token is IN that URL. Only the error's class name is
    // logged, which is enough to tell a timeout from a network failure.
    console.error(
      `[telegram] send threw: ${err instanceof Error ? err.name : typeof err}`,
    );
    return false;
  }
}

/**
 * Sends one message to `destination` — a Telegram chat id.
 *
 * The `subscriptions.destination` column holds the same thing, which is why it
 * is no longer called `ntfy_topic`. Kept as a named indirection so a second
 * provider can be added without touching the orchestration layer.
 */
export function sendNotification(
  env: Env,
  destination: string,
  msg: NotificationMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return postToTelegram(env, destination, msg, fetchImpl);
}

/** Operational alert to env.ALERT_DESTINATION at priority 4, tag "warning". Never throws. */
export function sendAlert(
  env: Env,
  title: string,
  body: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  // In production ALERT_DESTINATION arrives as a Cloudflare secret (Phase 9),
  // not from the placeholder in wrangler.jsonc. It is an ordinary string here
  // and its value is never logged.
  return sendNotification(
    env,
    env.ALERT_DESTINATION,
    {
      title: `heating-oil-tracker: ${title}`,
      body,
      tags: ["warning"],
      priority: 4,
    },
    fetchImpl,
  );
}
