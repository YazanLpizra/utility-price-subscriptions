/**
 * test/fetcher.test.ts — Phase 3.
 *
 * ZERO REAL NETWORK ACCESS. Every test injects the `fetchImpl` parameter with a
 * hand-rolled stub that returns canned Responses and records calls. There is no
 * mock library and no `fetchMock` here, and no test ever reaches
 * cashheatingoil.com.
 */
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/06483.html?raw";
import type { Env } from "../src/types";
import {
  FetchError,
  fetchPricesPage,
  parseSlugParts,
  resolveAndFetch,
} from "../src/fetcher";

const BASE = "https://www.cashheatingoil.com";
const UA = "heating-oil-tracker/1.0 (+personal price tracker)";
const ZIP = "06483";
const SLUG = "seymour_ct_oil_prices/06483";
const SLUG_URL = `${BASE}/${SLUG}`;
const POST_URL = `${BASE}/cod_oil_prices.php`;

const env = {
  SITE_BASE_URL: BASE,
  NTFY_BASE_URL: "https://ntfy.sh",
  NTFY_ALERT_TOPIC: "test-topic",
  STALE_AFTER_DAYS: "3",
  USER_AGENT: UA,
} as unknown as Env;

// --- the stub -------------------------------------------------------------

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}
type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stub(...responders: Responder[]): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const responder = responders[calls.length - 1];
    if (responder === undefined) {
      throw new Error(`unexpected fetch call #${calls.length} to ${String(input)}`);
    }
    return await responder(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: string): Responder => () => new Response(body, { status: 200 });
const status = (code: number, headers?: Record<string, string>): Responder => () =>
  new Response(null, { status: code, headers });
const redirect = (location: string, code = 302): Responder => () =>
  new Response(null, { status: code, headers: { Location: location } });
const boom = (err: unknown): Responder => () => {
  throw err;
};

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (h === undefined) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
}

// --- parseSlugParts -------------------------------------------------------

describe("parseSlugParts", () => {
  it("parses the four PRD §4.1 slugs, including multi-word cities", () => {
    expect(parseSlugParts("seymour_ct_oil_prices/06483")).toEqual({
      city: "seymour",
      state: "ct",
      zip: "06483",
    });
    expect(parseSlugParts("trumbull_ct_oil_prices/06611")).toEqual({
      city: "trumbull",
      state: "ct",
      zip: "06611",
    });
    expect(parseSlugParts("garden_city_ny_oil_prices/11530")).toEqual({
      city: "garden_city",
      state: "ny",
      zip: "11530",
    });
    expect(parseSlugParts("princeton_nj_oil_prices/08540")).toEqual({
      city: "princeton",
      state: "nj",
      zip: "08540",
    });
  });

  it("returns null on malformed input", () => {
    for (const bad of [
      "",
      "garbage",
      "/seymour_ct_oil_prices/06483", // leading slash is not part of a stored slug
      "seymour_ct_oil_prices/6483", // 4-digit zip
      "seymour_ct_oil_prices/064833", // 6-digit zip
      "seymour_ctt_oil_prices/06483", // 3-letter state
      "seymour_ct_gas_prices/06483", // wrong segment
      "Seymour_CT_oil_prices/06483", // uppercase
      "_ct_oil_prices/06483", // empty city
      "seymour_ct_oil_prices/06483/extra",
    ]) {
      expect(parseSlugParts(bad), bad).toBeNull();
    }
  });
});

// --- cached-slug path -----------------------------------------------------

describe("fetchPricesPage — cached slug", () => {
  it("happy path: 1 GET, fixture body, resolved_via_post false, slug unchanged", async () => {
    const { impl, calls } = stub(ok(fixture));
    const page = await fetchPricesPage(ZIP, SLUG, env, impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SLUG_URL);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(page.resolved_via_post).toBe(false);
    expect(page.slug).toBe(SLUG);
    expect(page.zip).toBe(ZIP);
    expect(page.url).toBe(SLUG_URL);
    expect(page.city).toBe("seymour");
    expect(page.state).toBe("ct");
    expect(page.html).toBe(fixture);
    expect(page.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("404 → falls back to POST → 302 → GET: exactly 3 calls, resolved_via_post true", async () => {
    const { impl, calls } = stub(status(404), redirect(SLUG_URL), ok(fixture));
    const page = await fetchPricesPage(ZIP, SLUG, env, impl);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(SLUG_URL);
    expect(calls[1]?.url).toBe(POST_URL);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[2]?.url).toBe(SLUG_URL);
    expect(page.resolved_via_post).toBe(true);
    expect(page.slug).toBe(SLUG);
  });

  it("200 with a listing-free body → same fallback", async () => {
    const { impl, calls } = stub(
      ok("<html><body>No dealers found.</body></html>"),
      redirect(SLUG_URL),
      ok(fixture),
    );
    const page = await fetchPricesPage(ZIP, SLUG, env, impl);
    expect(calls).toHaveLength(3);
    expect(page.resolved_via_post).toBe(true);
  });

  it("both paths fail → rejects once, stub called exactly 3 times (no retry storm)", async () => {
    const { impl, calls } = stub(status(404), redirect(SLUG_URL), status(500));
    await expect(fetchPricesPage(ZIP, SLUG, env, impl)).rejects.toBeInstanceOf(FetchError);
    expect(calls).toHaveLength(3);
  });

  it("the fallback is attempted at most once even when the POST itself 500s", async () => {
    const { impl, calls } = stub(status(503), status(500));
    await expect(fetchPricesPage(ZIP, SLUG, env, impl)).rejects.toMatchObject({
      name: "FetchError",
      status: 500,
    });
    expect(calls).toHaveLength(2);
  });
});

// --- listings pre-check ---------------------------------------------------

describe("listings pre-check regex", () => {
  const accepts = [
    `<div class='boxlisting'>x</div>`,
    `<div class="alt boxlisting">x</div>`,
    `<div CLASS = "boxlisting">x</div>`,
    `<div class="boxlisting alt">x</div>`,
  ];
  for (const body of accepts) {
    it(`accepts ${body} without falling back`, async () => {
      const { impl, calls } = stub(ok(body));
      const page = await fetchPricesPage(ZIP, SLUG, env, impl);
      expect(calls).toHaveLength(1);
      expect(page.resolved_via_post).toBe(false);
    });
  }

  const rejects = [`<div class="boxlistings">x</div>`, `<div data-x="boxlisting">x</div>`];
  for (const body of rejects) {
    it(`rejects ${body} and falls back`, async () => {
      const { impl, calls } = stub(ok(body), redirect(SLUG_URL), ok(fixture));
      const page = await fetchPricesPage(ZIP, SLUG, env, impl);
      expect(calls).toHaveLength(3);
      expect(page.resolved_via_post).toBe(true);
    });
  }
});

// --- POST path ------------------------------------------------------------

describe("resolveAndFetch — POST path", () => {
  it("null cached slug goes straight to the POST path with the right URL/body/headers", async () => {
    const { impl, calls } = stub(redirect(SLUG_URL), ok(fixture));
    const page = await fetchPricesPage(ZIP, null, env, impl);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(POST_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(headerOf(calls[0]?.init, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(String(calls[0]?.init?.body)).toContain("txtzipcode=06483");
    expect(String(calls[0]?.init?.body)).toContain("btnsubmit=Continue");
    expect(page.resolved_via_post).toBe(true);
    expect(page.slug).toBe(SLUG);
  });

  it("follows 301 and 303 as well as 302", async () => {
    for (const code of [301, 302, 303]) {
      const { impl, calls } = stub(redirect(SLUG_URL, code), ok(fixture));
      const page = await resolveAndFetch(ZIP, env, impl);
      expect(calls, `status ${code}`).toHaveLength(2);
      expect(page.slug).toBe(SLUG);
    }
  });

  it("POST returns 500 → FetchError with status 500", async () => {
    const { impl, calls } = stub(status(500));
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toMatchObject({
      name: "FetchError",
      status: 500,
    });
    expect(calls).toHaveLength(1);
  });

  it("POST returns 200 with listings → slug null, body still usable, no invented slug", async () => {
    const { impl, calls } = stub(ok(fixture));
    const page = await resolveAndFetch(ZIP, env, impl);
    expect(calls).toHaveLength(1);
    expect(page.slug).toBeNull();
    expect(page.slug).not.toBe(ZIP);
    expect(page.city).toBeNull();
    expect(page.state).toBeNull();
    expect(page.resolved_via_post).toBe(true);
    expect(page.html).toBe(fixture);
  });

  it("POST returns 200 without listings → FetchError", async () => {
    const { impl } = stub(ok("<html>nothing here</html>"));
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toBeInstanceOf(FetchError);
  });

  it("a GET after a valid redirect that is not 200 → FetchError", async () => {
    const { impl, calls } = stub(redirect(SLUG_URL), status(502));
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toMatchObject({
      name: "FetchError",
      status: 502,
    });
    expect(calls).toHaveLength(2);
  });
});

// --- SSRF guard -----------------------------------------------------------

describe("SSRF guard on the Location header", () => {
  const cases: Array<[string, string | null]> = [
    ["wrong scheme", "http://www.cashheatingoil.com/seymour_ct_oil_prices/06483"],
    ["wrong host", "https://evil.example/seymour_ct_oil_prices/06483"],
    ["suffix-match trap", "https://evil-cashheatingoil.com/seymour_ct_oil_prices/06483"],
    ["path shape", "https://www.cashheatingoil.com/admin"],
    ["zip mismatch", "https://www.cashheatingoil.com/trumbull_ct_oil_prices/06611"],
    ["protocol-relative", "//evil.example/x"],
    ["absent Location header", null],
  ];

  for (const [label, location] of cases) {
    it(`${label} → FetchError and NO follow-up GET`, async () => {
      const responder: Responder =
        location === null
          ? () => new Response(null, { status: 302 })
          : redirect(location);
      const { impl, calls } = stub(responder);
      await expect(resolveAndFetch(ZIP, env, impl)).rejects.toBeInstanceOf(FetchError);
      // Exactly one call: the POST. The redirect was never followed.
      expect(calls).toHaveLength(1);
    });
  }

  it("a same-host https redirect to the CORRECT zip is accepted (guard is not a blanket deny)", async () => {
    const { impl, calls } = stub(redirect(SLUG_URL), ok(fixture));
    const page = await resolveAndFetch(ZIP, env, impl);
    expect(calls).toHaveLength(2);
    expect(page.slug).toBe(SLUG);
  });

  it("a relative Location resolving to the right page is accepted", async () => {
    const { impl, calls } = stub(redirect(`/${SLUG}`), ok(fixture));
    const page = await resolveAndFetch(ZIP, env, impl);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(SLUG_URL);
    expect(page.slug).toBe(SLUG);
  });
});

// --- method-preserving redirects -----------------------------------------

describe("307 / 308 are rejected", () => {
  for (const code of [307, 308]) {
    it(`${code} → FetchError, no GET issued`, async () => {
      const { impl, calls } = stub(redirect(SLUG_URL, code));
      await expect(resolveAndFetch(ZIP, env, impl)).rejects.toMatchObject({
        name: "FetchError",
        status: code,
      });
      expect(calls).toHaveLength(1);
    });
  }
});

// --- size cap -------------------------------------------------------------

describe("2 MB response size cap", () => {
  it("Content-Length: 3000000 is rejected on the declared size, not by streaming", async () => {
    let bytesDelivered = 0;
    const responder: Responder = () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          bytesDelivered += 1;
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Length": "3000000" },
      });
    };
    const { impl } = stub(responder);
    // The message proves WHICH guard fired: the up-front Content-Length check,
    // not the while-reading byte counter. (We deliberately do not assert that
    // the stream was never pulled — workerd may pull eagerly when the Response
    // is constructed, which is a runtime detail and not our contract.)
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toThrow(/declares 3000000 bytes/);
    expect(bytesDelivered).toBeLessThanOrEqual(1);
  });

  it("a body with no Content-Length that streams past 2 MB rejects", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(0x61); // 512 KB of 'a'
    const responder: Responder = () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 8) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk.slice());
        },
      });
      return new Response(stream, { status: 200 });
    };
    const { impl } = stub(responder);
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toBeInstanceOf(FetchError);
  });

  it("a body comfortably under the cap is read in full", async () => {
    const body = `<div class="boxlisting">${"x".repeat(50_000)}</div>`;
    const { impl } = stub(ok(body));
    const page = await resolveAndFetch(ZIP, env, impl);
    expect(page.html).toBe(body);
  });
});

// --- error translation, signals, user-agent -------------------------------

describe("error translation and request hygiene", () => {
  it("a raw TypeError from fetchImpl surfaces as FetchError, not TypeError", async () => {
    const { impl } = stub(boom(new TypeError("network go boom")));
    const err = await resolveAndFetch(ZIP, env, impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as FetchError).cause).toBeInstanceOf(TypeError);
  });

  it("an AbortError from fetchImpl surfaces as FetchError", async () => {
    const { impl } = stub(boom(new DOMException("The operation was aborted", "AbortError")));
    await expect(resolveAndFetch(ZIP, env, impl)).rejects.toBeInstanceOf(FetchError);
  });

  it("a rejecting cached-slug GET still falls back exactly once", async () => {
    const { impl, calls } = stub(boom(new TypeError("dns")), redirect(SLUG_URL), ok(fixture));
    const page = await fetchPricesPage(ZIP, SLUG, env, impl);
    expect(calls).toHaveLength(3);
    expect(page.resolved_via_post).toBe(true);
  });

  it("every request carries an AbortSignal and the configured User-Agent", async () => {
    const { impl, calls } = stub(status(404), redirect(SLUG_URL), ok(fixture));
    await fetchPricesPage(ZIP, SLUG, env, impl);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.signal, call.url).toBeDefined();
      expect(call.init?.signal?.aborted, call.url).toBe(false);
      expect(headerOf(call.init, "user-agent"), call.url).toBe(UA);
    }
  });
});
