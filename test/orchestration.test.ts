/**
 * test/orchestration.test.ts — Phase 7.
 *
 * ZERO REAL NETWORK ACCESS. Every test either injects `fetchImpl` directly
 * (`processZip`) or replaces `globalThis.fetch` with a recording stub for the
 * duration of the test (`scheduled` / `queue`, whose signatures are fixed by
 * §2.2 and take no fetch parameter). No test can reach cashheatingoil.com or
 * ntfy.sh: the stub throws on any URL it does not recognise.
 *
 * Storage is reset before every `it()` by the global hook in test/setup.ts.
 */
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env as testEnv,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/06483.html?raw";

import worker, { processZip } from "../src/index";
import { FetchError } from "../src/fetcher";
import { ParseError } from "../src/parser";
import type { Env, ScrapeMessage } from "../src/types";

// ---------------------------------------------------------------------------
// constants + env
// ---------------------------------------------------------------------------

const BASE = "https://www.cashheatingoil.com";
const NTFY = "https://ntfy.sh";
const ALERT_TOPIC = "heating-oil-alerts-placeholder";
const SUB_TOPIC = "heating-oil-local-dev";
const ZIP = "06483";
const SLUG = "seymour_ct_oil_prices/06483";
const SLUG_URL = `${BASE}/${SLUG}`;
const POST_URL = `${BASE}/cod_oil_prices.php`;
const SCRAPE_DATE = "2026-09-06";

/** The bindings + vars from wrangler.jsonc, as the worker sees them. */
const baseEnv = testEnv as unknown as Env;

// ---------------------------------------------------------------------------
// fixture variants
// ---------------------------------------------------------------------------

/** A structurally valid page carrying zero `div.boxlisting` elements. */
const strippedFixture = fixture.replace(/boxlisting/g, "nolisting");

/** Markup drift: an enumtype the parser refuses to guess at -> ParseError. */
const brokenFixture = fixture.replace(
  'name="enumtype" value="Cash"',
  'name="enumtype" value="Debit"',
);

/** Dealer 372's credit 50-99 tier removed -> 38 rows instead of 39. */
const oneTierFewerFixture = fixture.replace(
  /\s*<td>50-99<\/td>\s*<td>\$5\.74<\/td>/,
  "",
);

// ---------------------------------------------------------------------------
// the fetch stub
// ---------------------------------------------------------------------------

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

interface RouteOptions {
  /** Body returned for the slug GET. Defaults to the real fixture. */
  html?: string;
  /** Status for the POST to cod_oil_prices.php. Default 302. */
  postStatus?: number;
  /** Status for the slug GET. Default 200. */
  slugStatus?: number;
  /** Status for every ntfy POST. Default 200. */
  ntfyStatus?: number;
  /** Slug the POST redirects to, per requested zip. */
  slugFor?: (zip: string) => string;
}

function zipFromPostBody(init: RequestInit | undefined): string {
  const body = typeof init?.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("txtzipcode") ?? "";
}

function makeStub(opts: RouteOptions = {}) {
  const calls: Recorded[] = [];
  const html = opts.html ?? fixture;
  const postStatus = opts.postStatus ?? 302;
  const slugStatus = opts.slugStatus ?? 200;
  const ntfyStatus = opts.ntfyStatus ?? 200;
  const slugFor = opts.slugFor ?? (() => SLUG);

  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.startsWith(`${NTFY}/`)) {
      return new Response(null, { status: ntfyStatus });
    }
    if (url === POST_URL) {
      if (postStatus !== 302) return new Response(null, { status: postStatus });
      const zip = zipFromPostBody(init);
      return new Response(null, {
        status: 302,
        headers: { Location: `/${slugFor(zip)}` },
      });
    }
    if (url.startsWith(`${BASE}/`)) {
      if (slugStatus !== 200) return new Response(null, { status: slugStatus });
      return new Response(html, { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  const siteCalls = () => calls.filter((c) => c.url.startsWith(`${BASE}/`));
  const alertCalls = () => calls.filter((c) => c.url === `${NTFY}/${ALERT_TOPIC}`);
  const subCalls = () => calls.filter((c) => c.url === `${NTFY}/${SUB_TOPIC}`);
  const bodyOf = (c: Recorded) => (typeof c.init?.body === "string" ? c.init.body : "");

  return { impl, calls, siteCalls, alertCalls, subCalls, bodyOf };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// seeding
// ---------------------------------------------------------------------------

/** Zip 06483 ACTIVE (the committed seed leaves it inactive — this is the
 *  documented opt-in step) plus the two Phase 6 subscriptions, ids 1 and 2. */
async function seed(slug: string | null = null): Promise<void> {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare(
      "INSERT INTO zips (zip, slug, city, state, active, slug_resolved_at) VALUES (?,?,?,?,1,?)",
    ).bind(ZIP, slug, slug === null ? null : "seymour", slug === null ? null : "ct", slug === null ? null : "2026-09-01T00:00:00.000Z"),
    baseEnv.DB.prepare(
      "INSERT INTO subscriptions (id, user_id, zip, ntfy_topic, min_gallons, payment_type, threshold, active) " +
        "VALUES (1,'v1',?,?,100,'cash',NULL,1)",
    ).bind(ZIP, SUB_TOPIC),
    baseEnv.DB.prepare(
      "INSERT INTO subscriptions (id, user_id, zip, ntfy_topic, min_gallons, payment_type, threshold, active) " +
        "VALUES (2,'v1',?,?,50,'cash',NULL,1)",
    ).bind(ZIP, SUB_TOPIC),
  ]);
}

async function countPrices(): Promise<number> {
  const row = await baseEnv.DB.prepare("SELECT COUNT(*) AS c FROM prices").first<{ c: number }>();
  return row?.c ?? 0;
}

async function countNotifications(): Promise<number> {
  const row = await baseEnv.DB.prepare(
    "SELECT COUNT(*) AS c FROM notifications",
  ).first<{ c: number }>();
  return row?.c ?? 0;
}

async function readZip(zip = ZIP) {
  return await baseEnv.DB.prepare(
    "SELECT zip, slug, city, state, active, slug_resolved_at FROM zips WHERE zip = ?",
  )
    .bind(zip)
    .first<{
      zip: string;
      slug: string | null;
      city: string | null;
      state: string | null;
      active: number;
      slug_resolved_at: string | null;
    }>();
}

const message = (zip = ZIP, scrapeDate = SCRAPE_DATE): ScrapeMessage => ({
  zip,
  scrape_date: scrapeDate,
});

// ---------------------------------------------------------------------------
// fake queue / fake message batch
// ---------------------------------------------------------------------------

function fakeQueue() {
  const batches: { body: ScrapeMessage }[][] = [];
  const queue = {
    async send() {
      throw new Error("send() is not used by the producer");
    },
    async sendBatch(messages: Iterable<{ body: ScrapeMessage }>) {
      batches.push([...messages]);
    },
  };
  return { queue: queue as unknown as Env["SCRAPE_QUEUE"], batches };
}

function fakeBatch(bodies: unknown[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, i) => ({
    id: `msg-${i}`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack() {
      acked.push(i);
    },
    retry() {
      retried.push(i);
    },
  }));
  const batch = {
    queue: "heating-oil-scrape",
    messages,
    ackAll() {
      for (const m of messages) m.ack();
    },
    retryAll() {
      for (const m of messages) m.retry();
    },
  };
  return { batch: batch as unknown as MessageBatch<ScrapeMessage>, acked, retried };
}

// ---------------------------------------------------------------------------
// query counter
// ---------------------------------------------------------------------------

function countingDb(db: D1Database) {
  let prepares = 0;
  const wrapped = new Proxy(db as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sql: string) => {
          prepares++;
          return (value as (s: string) => unknown).call(target, sql);
        };
      }
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  }) as unknown as D1Database;
  return { db: wrapped, prepares: () => prepares };
}

// ===========================================================================
// processZip — the happy path
// ===========================================================================

describe("processZip — end to end against the real fixture", () => {
  it("resolves the slug, writes 39 rows, notifies both subscribers, and never alerts", async () => {
    await seed(null);
    const stub = makeStub();

    const result = await processZip(message(), baseEnv, stub.impl);

    expect(result).toEqual({
      zip: ZIP,
      rows_written: 39,
      notifications_sent: 2,
      stale: false,
    });
    expect(await countPrices()).toBe(39);

    const zipRow = await readZip();
    expect(zipRow?.slug).toBe(SLUG);
    expect(zipRow?.city).toBe("seymour");
    expect(zipRow?.state).toBe("ct");
    expect(typeof zipRow?.slug_resolved_at).toBe("string");
    expect(zipRow?.slug_resolved_at).not.toBe("");

    // Exactly two subscriber pushes, one per subscription.
    const bodies = stub.subCalls().map(stub.bodyOf).sort();
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes("$4.84 per gallon"))).toBe(true);
    expect(bodies.some((b) => b.includes("$5.64 per gallon"))).toBe(true);

    // processZip is NEVER the owner of an alert.
    expect(stub.alertCalls()).toHaveLength(0);

    // The dedupe rows exist for tomorrow's at-least-once redelivery.
    expect(await countNotifications()).toBe(2);
  });

  it("re-running the same zip rewrites the rows but sends no second notification", async () => {
    await seed(null);
    const stub = makeStub();

    const first = await processZip(message(), baseEnv, stub.impl);
    expect(first.notifications_sent).toBe(2);
    expect(await countPrices()).toBe(39);

    const second = await processZip(message(), baseEnv, stub.impl);

    expect(second).toEqual({
      zip: ZIP,
      rows_written: 39,
      notifications_sent: 0,
      stale: false,
    });
    // The write happened again (idempotently) …
    expect(await countPrices()).toBe(39);
    // … but the phone was pushed exactly once per subscription, in total.
    expect(stub.subCalls()).toHaveLength(2);
    expect(await countNotifications()).toBe(2);
  });

  it("replaces the day's rows: a tier that vanishes from the site does not survive", async () => {
    await seed(null);

    await processZip(message(), baseEnv, makeStub().impl);
    expect(await countPrices()).toBe(39);

    await processZip(message(), baseEnv, makeStub({ html: oneTierFewerFixture }).impl);
    expect(await countPrices()).toBe(38);
  });

  it("uses the cached slug without re-resolving, and stays under the D1 statement guard", async () => {
    await seed(SLUG);
    const stub = makeStub();
    const counter = countingDb(baseEnv.DB);
    const env = { ...baseEnv, DB: counter.db } as Env;

    const result = await processZip(message(), env, stub.impl);

    expect(result.rows_written).toBe(39);
    expect(result.notifications_sent).toBe(2);

    // One GET of the cached slug; no POST to cod_oil_prices.php.
    expect(stub.siteCalls()).toHaveLength(1);
    expect(stub.siteCalls()[0]?.url).toBe(SLUG_URL);

    // 1 getZip + 1 DELETE + 5 INSERT + 1 subscription read
    // + 1 getNotifiedFingerprints + 1 recordNotifiedBatch = 10.
    //
    // The dedupe pair no longer scales with the subscription count: it was
    // 2 statements PER subscription (12 here, and past D1's 50-query cap at
    // ~21 subscriptions), and is now 2 statements in total.
    const observed = counter.prepares();
    console.log(`[query guard] cached-slug happy path issued ${observed} D1 statements`);
    expect(observed).toBe(10);
    expect(observed).toBeLessThanOrEqual(14);
  });

  it("the dedupe cost does not grow with the subscription count", async () => {
    await seed(SLUG);
    // Eight more subscriptions on the same zip. Under the old one-wasNotified-
    // and-one-recordNotified-per-subscription shape this would have cost 20
    // dedupe statements; it now costs 2, so the total is unchanged at 10.
    await baseEnv.DB.batch(
      Array.from({ length: 8 }, (_, i) =>
        // `user_id` varies: subscriptions carry a UNIQUE
        // (user_id, zip, ntfy_topic, payment_type, min_gallons).
        baseEnv.DB.prepare(
          "INSERT INTO subscriptions (id, user_id, zip, ntfy_topic, min_gallons, payment_type, threshold, active) " +
            "VALUES (?,?,?,?,100,'cash',NULL,1)",
        ).bind(10 + i, `v${10 + i}`, ZIP, SUB_TOPIC),
      ),
    );

    const stub = makeStub();
    const counter = countingDb(baseEnv.DB);
    const env = { ...baseEnv, DB: counter.db } as Env;

    const result = await processZip(message(), env, stub.impl);

    expect(result.notifications_sent).toBe(10);
    expect(counter.prepares()).toBe(10);
    expect(counter.prepares()).toBeLessThanOrEqual(14);
  });
});

// ===========================================================================
// fingerprint dedupe — unchanged price vs changed price
// ===========================================================================

describe("processZip — the dedupe compares the fingerprint, it does not just test for a row", () => {
  it("a re-run with an UNCHANGED price sends nothing", async () => {
    await seed(null);
    const stub = makeStub();

    await processZip(message(), baseEnv, stub.impl);
    expect(stub.subCalls()).toHaveLength(2);

    const second = await processZip(message(), baseEnv, stub.impl);

    expect(second.notifications_sent).toBe(0);
    expect(stub.subCalls()).toHaveLength(2);
  });

  it("a re-run with a CHANGED price sends again — a real price move is not suppressed", async () => {
    await seed(null);
    const first = makeStub();
    await processZip(message(), baseEnv, first.impl);
    expect(first.subCalls()).toHaveLength(2);
    expect(await countNotifications()).toBe(2);

    // The site now quotes $4.29 where it quoted $4.84 for the 100+ cash tier.
    // Same day, same subscriptions — but a genuinely different message, so the
    // stored fingerprint no longer matches and both subscribers must hear it.
    // A replacement FUNCTION, not a string: "$4" in a replacement string is
    // capture-group syntax and this test must not depend on how that degrades.
    const cheaperFixture = fixture.replace(/\$4\.84/g, () => "$4.29");
    const second = makeStub({ html: cheaperFixture });

    const result = await processZip(message(), baseEnv, second.impl);

    expect(result.notifications_sent).toBe(1);
    const bodies = second.subCalls().map(second.bodyOf);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("$4.29 per gallon");

    // Still exactly two dedupe rows — the batch UPDATEd, it did not duplicate.
    expect(await countNotifications()).toBe(2);

    // And the stored fingerprint now describes the message actually pushed.
    const row = await baseEnv.DB.prepare(
      "SELECT fingerprint FROM notifications WHERE scrape_date = ? AND subscription_id = 1",
    )
      .bind(SCRAPE_DATE)
      .first<{ fingerprint: string }>();
    expect(row?.fingerprint).toContain("4.29");
  });
});

// ===========================================================================
// per-subscription failures must not be silently lost
// ===========================================================================

/** Wraps a D1 handle so any prepare() whose SQL matches `pattern` throws. */
function dbFailingOn(db: D1Database, pattern: RegExp): D1Database {
  return new Proxy(db as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sql: string) => {
          if (pattern.test(sql)) throw new Error("D1 dedupe write is down");
          return (value as (s: string) => unknown).call(target, sql);
        };
      }
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  }) as unknown as D1Database;
}

describe("processZip — a failed notification task is never silently ACKed", () => {
  it("rejects when recording the sends fails, AFTER the pushes actually went out", async () => {
    await seed(SLUG);
    const stub = makeStub();
    const env = {
      ...baseEnv,
      DB: dbFailingOn(baseEnv.DB, /INSERT INTO notifications/),
    } as Env;

    await expect(processZip(message(), env, stub.impl)).rejects.toThrow(
      /task\(s\) failed after 39 price rows were written/,
    );

    // The price rows are durable, and both subscribers really were notified —
    // the failure is only in the dedupe bookkeeping.
    expect(await countPrices()).toBe(39);
    expect(stub.subCalls()).toHaveLength(2);
    // Nothing recorded, which is exactly why the message must be retried.
    expect(await countNotifications()).toBe(0);
  });

  it("through queue(), that failure RETRIES the message rather than acking it", async () => {
    await seed(SLUG);
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);
    const env = {
      ...baseEnv,
      DB: dbFailingOn(baseEnv.DB, /INSERT INTO notifications/),
    } as Env;

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(retried).toEqual([0]);
    expect(acked).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(stub.bodyOf(stub.alertCalls()[0]!)).toContain("task(s) failed");
  });
});

// ===========================================================================
// processZip — the failure branches
// ===========================================================================

describe("processZip — zero listings", () => {
  it("writes nothing, notifies nobody, resolves, and issues no alert of its own", async () => {
    await seed(null);
    const stub = makeStub({ html: strippedFixture });

    const result = await processZip(message(), baseEnv, stub.impl);

    expect(result).toEqual({
      zip: ZIP,
      rows_written: 0,
      notifications_sent: 0,
      stale: false,
    });
    expect(await countPrices()).toBe(0);
    expect(stub.subCalls()).toHaveLength(0);
    expect(stub.alertCalls()).toHaveLength(0);
  });

  it("DOES persist the resolved slug — the branch writes no PRICE rows, not nothing", async () => {
    await seed(null);
    const stub = makeStub({ html: strippedFixture });

    await processZip(message(), baseEnv, stub.impl);

    // updateZipSlug runs at step 3, BEFORE the parse at step 4. That is
    // deliberate — the page fetched and was structurally valid, so its URL is
    // worth caching — and this assertion pins it so the docblock's "writes no
    // PRICE rows" wording cannot silently drift back to "writes nothing".
    const zipRow = await readZip();
    expect(zipRow?.slug).toBe(SLUG);
    expect(zipRow?.city).toBe("seymour");
    expect(zipRow?.state).toBe("ct");
    expect(await countPrices()).toBe(0);
  });
});

describe("processZip — ParseError", () => {
  it("rejects with ParseError, writes nothing, and does not alert", async () => {
    await seed(null);
    const stub = makeStub({ html: brokenFixture });

    await expect(processZip(message(), baseEnv, stub.impl)).rejects.toBeInstanceOf(ParseError);

    expect(await countPrices()).toBe(0);
    expect(stub.subCalls()).toHaveLength(0);
    expect(stub.alertCalls()).toHaveLength(0);
  });
});

describe("processZip — FetchError", () => {
  it("clears the cached slug and rethrows so the message can retry", async () => {
    await seed(SLUG);
    const stub = makeStub({ slugStatus: 500, postStatus: 500 });

    await expect(processZip(message(), baseEnv, stub.impl)).rejects.toBeInstanceOf(FetchError);

    const zipRow = await readZip();
    expect(zipRow?.slug).toBeNull();
    expect(zipRow?.slug_resolved_at).toBeNull();
    expect(await countPrices()).toBe(0);
    expect(stub.alertCalls()).toHaveLength(0);
  });

  it("still propagates the FetchError when the slug cleanup ITSELF fails, and logs it", async () => {
    await seed(SLUG);
    const stub = makeStub({ slugStatus: 500, postStatus: 500 });
    const env = {
      ...baseEnv,
      DB: dbFailingOn(baseEnv.DB, /UPDATE zips SET slug = NULL/),
    } as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // The FetchError is what queue() routes on, so a cleanup failure must not
    // replace it — but it must not vanish either.
    await expect(processZip(message(), env, stub.impl)).rejects.toBeInstanceOf(FetchError);

    expect(errors.mock.calls.flat().join("\n")).toContain("SLUG_CLEANUP_FAILED");

    // The slug is still there, which is precisely what the log is warning about.
    expect((await readZip())?.slug).toBe(SLUG);
    errors.mockRestore();
  });

  it("carries the cleanup failure into the alert body through queue()", async () => {
    await seed(SLUG);
    const stub = makeStub({ slugStatus: 500, postStatus: 500 });
    vi.stubGlobal("fetch", stub.impl);
    const env = {
      ...baseEnv,
      DB: dbFailingOn(baseEnv.DB, /UPDATE zips SET slug = NULL/),
    } as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(retried).toEqual([0]);
    expect(acked).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(stub.bodyOf(stub.alertCalls()[0]!)).toContain("SLUG_CLEANUP_FAILED");
    errors.mockRestore();
  });
});

describe("processZip — ntfy failure", () => {
  it("keeps the rows, resolves, counts zero notifications, and records no dedupe row", async () => {
    await seed(null);
    const stub = makeStub({ ntfyStatus: 500 });

    const result = await processZip(message(), baseEnv, stub.impl);

    expect(result).toEqual({
      zip: ZIP,
      rows_written: 39,
      notifications_sent: 0,
      stale: false,
    });
    expect(await countPrices()).toBe(39);
    expect(stub.subCalls()).toHaveLength(2);
    // Nothing recorded, so tomorrow's retry can still push.
    expect(await countNotifications()).toBe(0);
  });
});

// ===========================================================================
// scheduled — the producer
// ===========================================================================

describe("scheduled — the cron producer", () => {
  it("enqueues one message per ACTIVE zip and performs zero fetches", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06483', 1)"),
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06611', 1)"),
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('11530', 0)"),
    ]);

    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { queue, batches } = fakeQueue();
    const env = { ...baseEnv, SCRAPE_QUEUE: queue } as Env;

    const controller = createScheduledController({
      scheduledTime: new Date("2026-09-06T12:00:00.000Z"),
      cron: "0 12 * * *",
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const sent = batches.flat();
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.body.zip).sort()).toEqual(["06483", "06611"]);
    for (const m of sent) expect(m.body.scrape_date).toBe("2026-09-06");

    // The producer neither scrapes nor parses.
    expect(stub.calls).toHaveLength(0);
  });

  it("chunks sendBatch at 100 messages with 250 active zips", async () => {
    const inserts = Array.from({ length: 250 }, (_, i) =>
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES (?, 1)").bind(
        String(10000 + i),
      ),
    );
    await baseEnv.DB.batch(inserts);

    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { queue, batches } = fakeQueue();
    const env = { ...baseEnv, SCRAPE_QUEUE: queue } as Env;

    const controller = createScheduledController({
      scheduledTime: new Date("2026-09-06T12:00:00.000Z"),
      cron: "0 12 * * *",
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(100);
    expect(batches.flat()).toHaveLength(250);
    expect(stub.calls).toHaveLength(0);
  });

  it("ALERTS and enqueues nothing when there are zero active zips", async () => {
    // No zips at all — which is also the committed seed's state, since the seed
    // deliberately leaves every zip inactive. Without an alert here a forgotten
    // production activation is indefinite silence behind a green cron.
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { queue, batches } = fakeQueue();
    const env = { ...baseEnv, SCRAPE_QUEUE: queue } as Env;

    const controller = createScheduledController({
      scheduledTime: new Date("2026-09-06T12:00:00.000Z"),
      cron: "0 12 * * *",
    });
    const ctx = createExecutionContext();

    // Returns normally: a misconfiguration is not a crash, and throwing would
    // burn the cron's error budget every single day.
    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    expect(batches).toHaveLength(0);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(stub.bodyOf(stub.alertCalls()[0]!)).toContain("no active zips");
    expect(errors.mock.calls.flat().join("\n")).toContain("no active zips");
    errors.mockRestore();
  });

  it("alerts and then RETHROWS when the producer fails", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const failingDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    const { queue } = fakeQueue();
    const env = { ...baseEnv, DB: failingDb, SCRAPE_QUEUE: queue } as Env;

    const controller = createScheduledController({
      scheduledTime: new Date("2026-09-06T12:00:00.000Z"),
      cron: "0 12 * * *",
    });
    const ctx = createExecutionContext();

    await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow("D1 is down");
    expect(stub.alertCalls()).toHaveLength(1);
  });
});

// ===========================================================================
// queue — the consumer
// ===========================================================================

describe("queue — the consumer", () => {
  it("alerts and acks a zero-listing zip", async () => {
    await seed(null);
    const stub = makeStub({ html: strippedFixture });
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(await countPrices()).toBe(0);
  });

  it("alerts and ACKS a ParseError — a retry cannot fix markup drift", async () => {
    await seed(null);
    const stub = makeStub({ html: brokenFixture });
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
  });

  it("alerts and RETRIES a FetchError, having cleared the cached slug", async () => {
    await seed(SLUG);
    const stub = makeStub({ slugStatus: 500, postStatus: 500 });
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(retried).toEqual([0]);
    expect(acked).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect((await readZip())?.slug).toBeNull();
  });

  it("isolates failures: a throwing first message does not stop the second", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06483', 1)"),
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06611', 1)"),
    ]);

    // 06483 fails at both fetch paths; 06611 resolves and serves the fixture.
    const calls: Recorded[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith(`${NTFY}/`)) return new Response(null, { status: 200 });
      if (url === POST_URL) {
        const zip = zipFromPostBody(init);
        if (zip === "06611") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/trumbull_ct_oil_prices/06611" },
          });
        }
        return new Response(null, { status: 500 });
      }
      if (url === `${BASE}/trumbull_ct_oil_prices/06611`) {
        return new Response(fixture, { status: 200 });
      }
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", impl);

    const { batch, acked, retried } = fakeBatch([message("06483"), message("06611")]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(retried).toEqual([0]);
    expect(acked).toEqual([1]);

    // The second zip really did its work.
    const row = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS c FROM prices WHERE zip = '06611'",
    ).first<{ c: number }>();
    expect(row?.c).toBe(39);

    expect(calls.filter((c) => c.url === `${NTFY}/${ALERT_TOPIC}`)).toHaveLength(1);
  });

  it("acks and alerts a malformed message without ever entering processZip", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([
      { zip: "abc", scrape_date: SCRAPE_DATE },
      { zip: ZIP, scrape_date: "2026-13-45" },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(2);
    // processZip was never entered: not one request to the site.
    expect(stub.siteCalls()).toHaveLength(0);
  });

  it("acks and alerts a message that is not an object at all", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([null, "06483"]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(2);
    expect(stub.siteCalls()).toHaveLength(0);
  });

  it("acks a healthy zip and sends no alert", async () => {
    await seed(null);
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(0);
    expect(stub.subCalls()).toHaveLength(2);
    expect(await countPrices()).toBe(39);
  });
});

// ===========================================================================
// the validator must never throw — a throw would be caught as "transient"
// by the outer handler and RETRIED, violating "malformed -> ack, never retry"
// ===========================================================================

describe("queue — bodies that break JSON.stringify are still acked, never retried", () => {
  /** structuredClone carries BigInts through a queue; JSON.stringify throws on them. */
  it("acks and alerts a body whose zip is a BigInt", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const { batch, acked, retried } = fakeBatch([
      { zip: 1n, scrape_date: SCRAPE_DATE },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(stub.bodyOf(stub.alertCalls()[0]!)).toContain("not a 5-digit zip");
    expect(stub.siteCalls()).toHaveLength(0);
  });

  it("acks and alerts a body whose zip is a cyclic object", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub.impl);

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;

    const { batch, acked, retried } = fakeBatch([
      { zip: cyclic, scrape_date: SCRAPE_DATE },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);
    expect(stub.bodyOf(stub.alertCalls()[0]!)).toContain("not a 5-digit zip");
    expect(stub.siteCalls()).toHaveLength(0);
  });
});

// ===========================================================================
// a failed alert leaves evidence in the logs — the only backstop there is
// ===========================================================================

describe("queue — an alert that could not be delivered", () => {
  it("still ACKS the branch and logs ALERT_DELIVERY_FAILED", async () => {
    await seed(null);
    // The site serves a listing-free page (so queue() alerts) and ntfy 500s
    // (so the alert itself fails). Nothing throws; the log is the whole record.
    const stub = makeStub({ html: strippedFixture, ntfyStatus: 500 });
    vi.stubGlobal("fetch", stub.impl);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { batch, acked, retried } = fakeBatch([message()]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(stub.alertCalls()).toHaveLength(1);

    const logged = errors.mock.calls.flat().join("\n");
    expect(logged).toContain("ALERT_DELIVERY_FAILED");
    expect(logged).toContain(`zip=${ZIP}`);
    errors.mockRestore();
  });
});

// ===========================================================================
// the real runtime, not hand-written spies
// ===========================================================================

describe("queue — driven through the real cloudflare:test message batch", () => {
  it("reports the genuine ack/retry outcome for a healthy zip and a failing one", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06483', 1)"),
      baseEnv.DB.prepare("INSERT INTO zips (zip, active) VALUES ('06611', 1)"),
    ]);

    // 06611 resolves and serves the fixture; 06483 500s on both fetch paths.
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${NTFY}/`)) return new Response(null, { status: 200 });
      if (url === POST_URL) {
        return zipFromPostBody(init) === "06611"
          ? new Response(null, {
              status: 302,
              headers: { Location: "/trumbull_ct_oil_prices/06611" },
            })
          : new Response(null, { status: 500 });
      }
      if (url === `${BASE}/trumbull_ct_oil_prices/06611`) {
        return new Response(fixture, { status: 200 });
      }
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", impl);

    // A real MessageBatch from the workerd runtime, whose ack()/retry() state is
    // read back by the runtime itself rather than by a spy this file wrote.
    const batch = createMessageBatch<ScrapeMessage>("heating-oil-scrape", [
      { id: "real-fetch-fail", timestamp: new Date(0), attempts: 1, body: message("06483") },
      { id: "real-healthy", timestamp: new Date(0), attempts: 1, body: message("06611") },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, baseEnv, ctx);

    const result = await getQueueResult(batch, ctx);

    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual(["real-healthy"]);
    expect(result.retryMessages.map((m: { msgId: string }) => m.msgId)).toEqual([
      "real-fetch-fail",
    ]);
    expect(result.outcome).toBe("ok");

    const row = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS c FROM prices WHERE zip = '06611'",
    ).first<{ c: number }>();
    expect(row?.c).toBe(39);
  });
});
