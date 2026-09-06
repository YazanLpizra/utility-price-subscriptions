/**
 * src/fetcher.ts — Phase 3: URL/slug resolver + fetch layer.
 *
 * This module is the project's only attack surface that touches an untrusted
 * remote. Following a `Location` header without validating it would be a
 * server-side request forgery primitive with a Cloudflare Worker's network
 * position, so the redirect guard below is a security requirement, not polish.
 *
 * CONCURRENCY: callers must never exceed 6 simultaneous outbound connections
 * (PRD §9.1). This layer issues **at most 2 subrequests per call**
 * (`fetchPricesPage` cached-slug GET + one `resolveAndFetch` fallback is 3 in
 * total across the two entry points; `resolveAndFetch` alone is POST + GET = 2).
 *
 * The module's only thrown type is `FetchError`.
 */
import type { Env, FetchedPage } from "./types";

/** Hard ceiling on a response body. Pairs with Phase 2's matching 2 MB guard. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Every fetch() this module issues carries this timeout. */
const TIMEOUT_MS = 15_000;

/**
 * PRE-CHECK ONLY. A cheap "is this plausibly a results page" test, deliberately
 * tolerant of attribute order and quote style (`class='boxlisting'`,
 * `class="alt boxlisting"`, `CLASS = "boxlisting"`). A naive
 * `body.includes('class="boxlisting"')` would send the fetcher into a needless
 * fallback on perfectly good pages.
 *
 * `parseListingsPage` (src/parser.ts, another phase) remains the SOLE AUTHORITY
 * on whether a page is valid. The fetcher must never be treated as having
 * validated content — this regex only decides whether to bother with a fallback.
 */
const LISTINGS_PRECHECK = /class\s*=\s*["'][^"']*\bboxlisting\b/i;

/** Shape a redirect target's path must have: `/{city}_{state}_oil_prices/{zip}`. */
const SLUG_PATH_RE = /^\/[a-z0-9_]+_[a-z]{2}_oil_prices\/\d{5}$/;

/** Same shape without the leading slash, with capture groups. Multi-word cities work
 *  because `[a-z0-9_]+` backtracks to the LAST `_xx_oil_prices` in the string. */
const SLUG_PARTS_RE = /^([a-z0-9_]+)_([a-z]{2})_oil_prices\/(\d{5})$/;

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FetchError";
  }
}

/** "seymour_ct_oil_prices/06483" -> { city: "seymour", state: "ct", zip: "06483" }. */
export function parseSlugParts(
  slug: string,
): { city: string; state: string; zip: string } | null {
  const m = SLUG_PARTS_RE.exec(slug);
  if (m === null) return null;
  const [, city, state, zip] = m;
  if (city === undefined || state === undefined || zip === undefined) return null;
  return { city, state, zip };
}

/** PRE-CHECK ONLY — see LISTINGS_PRECHECK. */
function hasListings(html: string): boolean {
  return LISTINGS_PRECHECK.test(html);
}

/**
 * The single fetch() call site. Injects the abort signal and converts every
 * rejection (TypeError, AbortError, DNS failure, …) into a FetchError so a
 * caller never has to reason about a raw network error.
 */
async function guardedFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    throw new FetchError(`request to ${url} failed (${detail})`, undefined, { cause });
  }
}

/**
 * Reads a body with a hard 2 MB cap, enforced twice:
 *   1. up front from `Content-Length`, before a single byte is read;
 *   2. while reading, because `Content-Length` may be absent or lying.
 */
async function readBodyCapped(res: Response, url: string): Promise<string> {
  const declared = res.headers.get("Content-Length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      throw new FetchError(
        `response from ${url} declares ${n} bytes, over the ${MAX_BODY_BYTES} byte cap`,
        res.status,
      );
    }
  }

  const body = res.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        throw new FetchError(
          `response from ${url} exceeded the ${MAX_BODY_BYTES} byte cap while reading`,
          res.status,
        );
      }
      out += decoder.decode(value, { stream: true });
    }
  } catch (cause) {
    if (cause instanceof FetchError) throw cause;
    throw new FetchError(`reading body from ${url} failed`, res.status, { cause });
  } finally {
    // Stop the transfer as soon as we bail; bounds memory on an oversized body.
    await reader.cancel().catch(() => undefined);
  }
  out += decoder.decode();
  return out;
}

/**
 * SSRF guard. Resolves `location` against `env.SITE_BASE_URL` and rejects unless
 * ALL of the following hold:
 *   - scheme is exactly `https:`;
 *   - host is EXACTLY EQUAL to the base host (not `endsWith`, which
 *     `evil-cashheatingoil.com` defeats);
 *   - path matches `^/[a-z0-9_]+_[a-z]{2}_oil_prices/\d{5}$`;
 *   - the trailing 5-digit zip EQUALS the requested zip — without this, a
 *     misbehaving upstream could cause another zip's prices to be stored under
 *     this one and the subscriber notified of a price they cannot buy.
 */
function validateRedirect(location: string, zip: string, env: Env): URL {
  const base = new URL(env.SITE_BASE_URL);

  let target: URL;
  try {
    target = new URL(location, base);
  } catch (cause) {
    throw new FetchError(`unparseable Location header: ${location}`, undefined, { cause });
  }

  if (target.protocol !== "https:") {
    throw new FetchError(`redirect rejected: scheme ${target.protocol} is not https:`);
  }
  if (target.host !== base.host) {
    throw new FetchError(
      `redirect rejected: host ${target.host} !== ${base.host}`,
    );
  }
  if (!SLUG_PATH_RE.test(target.pathname)) {
    throw new FetchError(`redirect rejected: path ${target.pathname} is not a results-page slug`);
  }
  const parts = parseSlugParts(target.pathname.slice(1));
  if (parts === null) {
    throw new FetchError(`redirect rejected: path ${target.pathname} is not a results-page slug`);
  }
  if (parts.zip !== zip) {
    throw new FetchError(
      `redirect rejected: slug zip ${parts.zip} !== requested zip ${zip}`,
    );
  }
  return target;
}

/** GET an already-validated absolute URL and return its (size-capped) body. */
async function getPage(
  url: string,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await guardedFetch(
    url,
    {
      method: "GET",
      headers: { "User-Agent": env.USER_AGENT },
      redirect: "manual",
    },
    fetchImpl,
  );
  if (res.status !== 200) {
    throw new FetchError(`GET ${url} returned ${res.status}`, res.status);
  }
  return await readBodyCapped(res, url);
}

/** POSTs txtzipcode to cod_oil_prices.php and follows the 302 to the slug page. */
export async function resolveAndFetch(
  zip: string,
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FetchedPage> {
  const base = new URL(env.SITE_BASE_URL);
  const postUrl = new URL("/cod_oil_prices.php", base).toString();

  const res = await guardedFetch(
    postUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": env.USER_AGENT,
      },
      body: `txtzipcode=${encodeURIComponent(zip)}&btnsubmit=Continue`,
      // "manual" so the 302's Location is observable and can be validated
      // BEFORE any request is made to it.
      redirect: "manual",
    },
    fetchImpl,
  );

  const status = res.status;

  // 307/308 require the client to preserve the original method. Following one
  // with a GET silently changes semantics, and this site does not use them.
  if (status === 307 || status === 308) {
    throw new FetchError(
      `POST ${postUrl} returned ${status}; method-preserving redirects are not followed`,
      status,
    );
  }

  if (status === 301 || status === 302 || status === 303) {
    const location = res.headers.get("Location");
    if (location === null || location === "") {
      throw new FetchError(`POST ${postUrl} returned ${status} with no Location header`, status);
    }
    const target = validateRedirect(location, zip, env);
    const url = target.toString();
    const html = await getPage(url, env, fetchImpl);
    const slug = target.pathname.slice(1);
    const parts = parseSlugParts(slug);
    return {
      zip,
      slug,
      url,
      html,
      resolved_via_post: true,
      city: parts?.city ?? null,
      state: parts?.state ?? null,
      fetched_at: new Date().toISOString(),
    };
  }

  if (status === 200) {
    const html = await readBodyCapped(res, postUrl);
    if (!hasListings(html)) {
      throw new FetchError(
        `POST ${postUrl} returned 200 with no listings for zip ${zip}`,
        200,
      );
    }
    // The response gives no trustworthy slug. `slug: null` is deliberate:
    // inventing "<zip>" would poison the cache with a URL that does not exist.
    // The caller must never persist a null slug.
    return {
      zip,
      slug: null,
      url: postUrl,
      html,
      resolved_via_post: true,
      city: null,
      state: null,
      fetched_at: new Date().toISOString(),
    };
  }

  throw new FetchError(`POST ${postUrl} returned unexpected status ${status}`, status);
}

/**
 * Uses cachedSlug if given; on non-200 or a body with no `div.boxlisting`,
 * falls back once to resolveAndFetch (PRD 8). Throws FetchError if both paths fail.
 */
export async function fetchPricesPage(
  zip: string,
  cachedSlug: string | null,
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FetchedPage> {
  if (cachedSlug === null) {
    return await resolveAndFetch(zip, env, fetchImpl);
  }

  const base = new URL(env.SITE_BASE_URL);
  const url = `${base.origin}/${cachedSlug.replace(/^\/+/, "")}`;

  try {
    const res = await guardedFetch(
      url,
      {
        method: "GET",
        headers: { "User-Agent": env.USER_AGENT },
        redirect: "manual",
      },
      fetchImpl,
    );
    if (res.status !== 200) {
      throw new FetchError(`GET ${url} returned ${res.status}`, res.status);
    }
    const html = await readBodyCapped(res, url);
    // PRE-CHECK ONLY — parseListingsPage is authoritative.
    if (!hasListings(html)) {
      throw new FetchError(`GET ${url} returned a body with no listings`, 200);
    }
    const parts = parseSlugParts(cachedSlug);
    return {
      zip,
      slug: cachedSlug,
      url,
      html,
      resolved_via_post: false,
      city: parts?.city ?? null,
      state: parts?.state ?? null,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    // Fall back to the POST path AT MOST ONCE. No retry loop: a stale slug that
    // also fails to resolve is a hard failure, and resolveAndFetch's own
    // FetchError propagates unchanged.
    return await resolveAndFetch(zip, env, fetchImpl);
  }
}
