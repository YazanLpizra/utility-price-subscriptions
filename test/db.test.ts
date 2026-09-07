/**
 * Phase 4 — D1 write layer tests.
 *
 * These run inside workerd against a real local D1 with
 * migrations/0001_init.sql applied. Rows are built BY HAND rather than through
 * the parser: this phase must not depend on Phase 2.
 *
 * The database is reset before every `it()` by test/setup.ts.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ROWS_PER_INSERT,
  clearZipSlug,
  getActiveSubscriptions,
  getActiveZips,
  getNotifiedFingerprints,
  getZip,
  recordNotified,
  recordNotifiedBatch,
  updateZipSlug,
  wasNotified,
  writePriceRows,
} from "../src/db";
import type { PriceRow } from "../src/types";

const DB = env.DB;

const SCRAPE_DATE = "2026-09-06";
const SCRAPED_AT = "2026-09-06T12:00:00.000Z";
const ZIP = "06483";

// --------------------------------------------------------------- fixtures

/**
 * The fixture day, by hand: 5 dealers, 20 cash + 19 credit = 39 rows,
 * including dealer 744's missing credit 50-99 tier.
 */
function fixtureRows(): PriceRow[] {
  const spec: Array<{
    dealer: number;
    delivery: string;
    cash: Array<[number, number, number]>;
    credit: Array<[number, number, number]>;
  }> = [
    {
      dealer: 11,
      delivery: "2026-09-08",
      cash: [[100, 149, 4.84], [150, 199, 4.84], [200, 299, 4.84], [300, 399, 4.84]],
      credit: [[100, 149, 4.94], [150, 199, 4.94], [200, 299, 4.94], [300, 399, 4.94]],
    },
    {
      dealer: 372,
      delivery: "2026-09-09",
      cash: [[50, 99, 5.64], [100, 149, 4.84], [150, 199, 4.84], [200, 299, 4.84], [300, 399, 4.84]],
      credit: [[50, 99, 5.74], [100, 149, 4.94], [150, 199, 4.94], [200, 299, 4.94], [300, 399, 4.94]],
    },
    {
      dealer: 744,
      delivery: "2026-09-07",
      cash: [[50, 99, 6.0], [100, 149, 4.84], [150, 199, 4.84], [200, 299, 4.84], [300, 399, 4.84]],
      credit: [[100, 149, 4.94], [150, 199, 4.94], [200, 299, 4.94], [300, 399, 4.94]],
    },
    {
      dealer: 345,
      delivery: "2026-09-09",
      cash: [[150, 199, 5.19], [200, 299, 5.19], [300, 399, 5.19]],
      credit: [[150, 199, 5.19], [200, 299, 5.19], [300, 399, 5.19]],
    },
    {
      dealer: 919,
      delivery: "2026-09-09",
      cash: [[150, 199, 5.19], [200, 299, 5.19], [300, 399, 5.19]],
      credit: [[150, 199, 5.19], [200, 299, 5.19], [300, 399, 5.19]],
    },
  ];

  const rows: PriceRow[] = [];
  for (const d of spec) {
    for (const [payment, tiers] of [
      ["cash", d.cash],
      ["credit", d.credit],
    ] as const) {
      for (const [min, max, price] of tiers) {
        rows.push({
          scrape_date: SCRAPE_DATE,
          zip: ZIP,
          dealer_id: d.dealer,
          payment_type: payment,
          gallon_min: min,
          gallon_max: max,
          price_per_gallon: price,
          delivery_date: d.delivery,
          price_updated_on: "2026-09-05",
          same_day_charge: 0,
          scraped_at: SCRAPED_AT,
        });
      }
    }
  }
  return rows;
}

/** n synthetic rows, distinct on the unique key via gallon_min. */
function syntheticRows(n: number): PriceRow[] {
  return Array.from({ length: n }, (_, i) => ({
    scrape_date: SCRAPE_DATE,
    zip: ZIP,
    dealer_id: 11,
    payment_type: "cash" as const,
    gallon_min: (i + 1) * 10,
    gallon_max: (i + 1) * 10 + 9,
    price_per_gallon: 4.84,
    delivery_date: "2026-09-08",
    price_updated_on: "2026-09-05",
    same_day_charge: 0,
    scraped_at: SCRAPED_AT,
  }));
}

async function seedZip(zip = ZIP, active = 1): Promise<void> {
  await DB.prepare(
    "INSERT INTO zips (zip, slug, city, state, active, slug_resolved_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(zip, null, null, null, active, null)
    .run();
}

async function priceCount(): Promise<number> {
  const r = await DB.prepare("SELECT COUNT(*) AS c FROM prices").first<{ c: number }>();
  return r!.c;
}

// --------------------------------------------------------------- constants

describe("ROWS_PER_INSERT", () => {
  it("is 8: 11 bound columns x 8 rows = 88 params, under D1's cap of 100", () => {
    expect(ROWS_PER_INSERT).toBe(8);
    expect(ROWS_PER_INSERT * 11).toBe(88);
    expect(ROWS_PER_INSERT * 11).toBeLessThan(100);
  });

  it("would still be under the cap at 9 rows, so 8 is deliberately conservative", () => {
    expect(9 * 11).toBeLessThan(100);
  });
});

// --------------------------------------------------------------- writes

describe("writePriceRows", () => {
  it("writes the 39-row fixture day as 1 DELETE + 5 INSERTs", async () => {
    await seedZip();
    const rows = fixtureRows();
    expect(rows.length).toBe(39);

    const result = await writePriceRows(DB, rows);
    expect(result).toEqual({ statements: 6, rows: 39 });
    expect(await priceCount()).toBe(39);
  });

  it("issues no D1 call at all for an empty array", async () => {
    let prepared = 0;
    const spy = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          prepared++;
          return (...args: unknown[]) =>
            (target.prepare as (...a: unknown[]) => unknown)(...args);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof DB;

    expect(await writePriceRows(spy, [])).toEqual({ statements: 0, rows: 0 });
    expect(prepared).toBe(0);
  });

  it("is idempotent: writing the same day twice leaves 39 rows", async () => {
    await seedZip();
    const rows = fixtureRows();
    await writePriceRows(DB, rows);
    await writePriceRows(DB, rows);
    expect(await priceCount()).toBe(39);
  });

  it("REPLACES the day: a tier that vanishes from the site vanishes from the table", async () => {
    await seedZip();
    const full = fixtureRows();
    await writePriceRows(DB, full);
    expect(await priceCount()).toBe(39);

    // The site drops dealer 744's 50-99 cash tier on the second run.
    const shrunk = full.filter(
      (r) => !(r.dealer_id === 744 && r.payment_type === "cash" && r.gallon_min === 50),
    );
    expect(shrunk.length).toBe(38);

    const result = await writePriceRows(DB, shrunk);
    expect(result).toEqual({ statements: 6, rows: 38 });
    expect(await priceCount()).toBe(38);

    const gone = await DB.prepare(
      "SELECT COUNT(*) AS c FROM prices WHERE dealer_id = 744 AND payment_type = 'cash' AND gallon_min = 50",
    ).first<{ c: number }>();
    expect(gone!.c).toBe(0);
  });

  it("updates a changed price in place rather than duplicating it", async () => {
    await seedZip();
    const rows = fixtureRows();
    await writePriceRows(DB, rows);

    const bumped = rows.map((r) =>
      r.dealer_id === 11 && r.payment_type === "cash" && r.gallon_min === 100
        ? { ...r, price_per_gallon: 4.99, scraped_at: "2026-09-06T18:00:00.000Z" }
        : r,
    );
    await writePriceRows(DB, bumped);

    expect(await priceCount()).toBe(39);
    const row = await DB.prepare(
      "SELECT price_per_gallon, scraped_at FROM prices WHERE dealer_id = 11 AND payment_type = 'cash' AND gallon_min = 100",
    ).first<{ price_per_gallon: number; scraped_at: string }>();
    expect(row!.price_per_gallon).toBe(4.99);
    expect(row!.scraped_at).toBe("2026-09-06T18:00:00.000Z");
  });

  it("does not touch another day's rows", async () => {
    await seedZip();
    await writePriceRows(DB, fixtureRows());
    const other = fixtureRows().map((r) => ({ ...r, scrape_date: "2026-09-07" }));
    await writePriceRows(DB, other);
    expect(await priceCount()).toBe(78);
  });

  it("does not touch another zip's rows for the same day", async () => {
    await seedZip();
    await seedZip("06611");
    await writePriceRows(DB, fixtureRows());
    const other = fixtureRows().map((r) => ({ ...r, zip: "06611" }));
    await writePriceRows(DB, other);
    expect(await priceCount()).toBe(78);
  });

  it("throws, issuing no SQL, when rows span more than one (scrape_date, zip)", async () => {
    await seedZip();
    const mixed = [...fixtureRows().slice(0, 3)];
    mixed.push({ ...(mixed[0] as PriceRow), scrape_date: "2026-09-07" });
    await expect(writePriceRows(DB, mixed)).rejects.toThrow(
      /must share one \(scrape_date, zip\)/,
    );
    expect(await priceCount()).toBe(0);
  });

  it("round-trips a null gallon_max as SQL NULL, not the string \"null\"", async () => {
    await seedZip();
    const row: PriceRow = {
      ...(fixtureRows()[0] as PriceRow),
      gallon_min: 400,
      gallon_max: null,
    };
    await writePriceRows(DB, [row]);
    const stored = await DB.prepare(
      "SELECT gallon_max, typeof(gallon_max) AS t FROM prices WHERE gallon_min = 400",
    ).first<{ gallon_max: unknown; t: string }>();
    expect(stored!.gallon_max).toBeNull();
    expect(stored!.t).toBe("null");
  });

  describe("chunk boundaries (the DELETE is always statement 1)", () => {
    const cases: Array<[number, number]> = [
      [1, 2],
      [8, 2],
      [9, 3],
      [16, 3],
      [17, 4],
      [39, 6],
      [100, 14],
    ];
    for (const [rowCount, expectedStatements] of cases) {
      it(`${rowCount} rows -> ${expectedStatements} statements`, async () => {
        await seedZip();
        const result = await writePriceRows(DB, syntheticRows(rowCount));
        expect(result).toEqual({ statements: expectedStatements, rows: rowCount });
        expect(await priceCount()).toBe(rowCount);
      });
    }

    it("100 rows stay far below D1's 50-query per-invocation cap", async () => {
      await seedZip();
      const result = await writePriceRows(DB, syntheticRows(100));
      expect(result.statements).toBeLessThan(50);
    });
  });

  it("never binds more than 88 parameters in one statement", async () => {
    const bound: number[] = [];
    const spy = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(s, p, r) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    bound.push(args.length);
                    return (s.bind as (...a: unknown[]) => unknown)(...args);
                  };
                }
                return Reflect.get(s, p, r);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof DB;

    await seedZip();
    await writePriceRows(spy, fixtureRows());
    expect(bound.length).toBeGreaterThan(0);
    for (const n of bound) expect(n).toBeLessThanOrEqual(88);
    // The DELETE binds 2; the full chunks bind 8 * 11.
    expect(bound[0]).toBe(2);
    expect(bound[1]).toBe(88);
  });
});

// --------------------------------------------------------------- zip reads

describe("zips", () => {
  it("getActiveZips returns only active rows, ordered by zip", async () => {
    await seedZip("06611", 1);
    await seedZip("06483", 1);
    await seedZip("08540", 0);
    const zips = await getActiveZips(DB);
    expect(zips.map((z) => z.zip)).toEqual(["06483", "06611"]);
  });

  it("getZip returns null for an unknown zip", async () => {
    expect(await getZip(DB, "99999")).toBeNull();
  });

  it("updateZipSlug then getZip round-trips slug, city, state and timestamp", async () => {
    await seedZip();
    await updateZipSlug(
      DB,
      ZIP,
      "seymour_ct_oil_prices/06483",
      "seymour",
      "ct",
      "2026-09-06T12:00:00.000Z",
    );
    const row = await getZip(DB, ZIP);
    expect(row).toMatchObject({
      zip: ZIP,
      slug: "seymour_ct_oil_prices/06483",
      city: "seymour",
      state: "ct",
      slug_resolved_at: "2026-09-06T12:00:00.000Z",
    });
  });

  it("clearZipSlug nulls both the slug and its timestamp, keeping the row", async () => {
    await seedZip();
    await updateZipSlug(
      DB,
      ZIP,
      "seymour_ct_oil_prices/06483",
      "seymour",
      "ct",
      "2026-09-06T12:00:00.000Z",
    );
    await clearZipSlug(DB, ZIP);
    const row = await getZip(DB, ZIP);
    expect(row).not.toBeNull();
    expect(row!.slug).toBeNull();
    expect(row!.slug_resolved_at).toBeNull();
    expect(row!.active).toBe(1);
  });
});

// --------------------------------------------------------------- subs

describe("subscriptions", () => {
  async function seedSub(
    id: number,
    zip: string,
    active: number,
    minGallons: number,
  ): Promise<void> {
    await DB.prepare(
      "INSERT INTO subscriptions (id, user_id, zip, destination, min_gallons, payment_type, threshold, active) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(id, "v1", zip, `topic-${id}`, minGallons, "cash", null, active)
      .run();
  }

  it("filters by zip and by active, ordered by id", async () => {
    await seedZip(ZIP);
    await seedZip("06611");
    await seedSub(2, ZIP, 1, 50);
    await seedSub(1, ZIP, 1, 100);
    await seedSub(3, ZIP, 0, 200);
    await seedSub(4, "06611", 1, 100);

    const subs = await getActiveSubscriptions(DB, ZIP);
    expect(subs.map((s) => s.id)).toEqual([1, 2]);
    expect(subs.every((s) => s.zip === ZIP)).toBe(true);
  });

  it("returns [] when a zip has none", async () => {
    await seedZip();
    expect(await getActiveSubscriptions(DB, ZIP)).toEqual([]);
  });
});

// --------------------------------------------------------------- dedupe

describe("notification de-duplication", () => {
  async function seedSub(id: number): Promise<void> {
    await seedZip();
    await DB.prepare(
      "INSERT INTO subscriptions (id, user_id, zip, destination, min_gallons, payment_type, threshold, active) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(id, "v1", ZIP, "heating-oil-local-dev", 100, "cash", null, 1)
      .run();
  }

  it("wasNotified is false before anything is recorded", async () => {
    await seedSub(1);
    expect(await wasNotified(DB, SCRAPE_DATE, 1)).toBe(false);
  });

  it("wasNotified is true after recordNotified", async () => {
    await seedSub(1);
    await recordNotified(DB, SCRAPE_DATE, 1, "fp-1", SCRAPED_AT);
    expect(await wasNotified(DB, SCRAPE_DATE, 1)).toBe(true);
  });

  it("recordNotified twice for the same key does not throw", async () => {
    await seedSub(1);
    await recordNotified(DB, SCRAPE_DATE, 1, "fp-1", SCRAPED_AT);
    await expect(
      recordNotified(DB, SCRAPE_DATE, 1, "fp-changed", "2026-09-06T18:00:00.000Z"),
    ).resolves.not.toThrow();
    const r = await DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{
      c: number;
    }>();
    expect(r!.c).toBe(1);
  });

  it("is scoped per day, so tomorrow notifies again", async () => {
    await seedSub(1);
    await recordNotified(DB, SCRAPE_DATE, 1, "fp-1", SCRAPED_AT);
    expect(await wasNotified(DB, "2026-09-07", 1)).toBe(false);
  });

  it("is scoped per subscription", async () => {
    await seedSub(1);
    await recordNotified(DB, SCRAPE_DATE, 1, "fp-1", SCRAPED_AT);
    expect(await wasNotified(DB, SCRAPE_DATE, 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the batched dedupe API
//
// `wasNotified`/`recordNotified` above are the single-row API and stay. These
// two exist because the orchestration layer called the single-row pair ONCE PER
// SUBSCRIPTION, making the per-invocation cost 8 + 2S — past D1's 50-query cap
// at roughly 21 subscriptions on one zip. These do the same work in two
// statements regardless of S.
// ---------------------------------------------------------------------------

describe("batched notification de-duplication", () => {
  async function seedSubs(ids: number[]): Promise<void> {
    await seedZip();
    await DB.batch(
      ids.map((id) =>
        DB.prepare(
          "INSERT INTO subscriptions (id, user_id, zip, destination, min_gallons, payment_type, threshold, active) VALUES (?,?,?,?,?,?,?,?)",
        // `user_id` varies: subscriptions carry a UNIQUE
        // (user_id, zip, destination, payment_type, min_gallons).
        ).bind(id, `v${id}`, ZIP, "heating-oil-local-dev", 100, "cash", null, 1),
      ),
    );
  }

  /** A D1 handle that refuses to prepare anything, to prove "zero queries". */
  const noQueryDb = {
    prepare() {
      throw new Error("no query should have been issued");
    },
    batch() {
      throw new Error("no batch should have been issued");
    },
  } as unknown as typeof DB;

  describe("getNotifiedFingerprints", () => {
    it("returns an empty map for an empty id list WITHOUT issuing a query", async () => {
      const map = await getNotifiedFingerprints(noQueryDb, SCRAPE_DATE, []);
      expect(map.size).toBe(0);
    });

    it("returns nothing when no notification has been recorded", async () => {
      await seedSubs([1, 2]);
      const map = await getNotifiedFingerprints(DB, SCRAPE_DATE, [1, 2]);
      expect(map.size).toBe(0);
    });

    it("reads every recorded fingerprint in one call", async () => {
      await seedSubs([1, 2, 3]);
      await recordNotifiedBatch(DB, [
        { scrape_date: SCRAPE_DATE, subscription_id: 1, fingerprint: "fp-1", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
        { scrape_date: SCRAPE_DATE, subscription_id: 3, fingerprint: "fp-3", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
      ]);

      const map = await getNotifiedFingerprints(DB, SCRAPE_DATE, [1, 2, 3]);

      expect(map.get(1)).toBe("fp-1");
      expect(map.get(3)).toBe("fp-3");
      // Subscription 2 was never notified, so it must be absent, not empty.
      expect(map.has(2)).toBe(false);
    });

    it("is scoped to the day and to the requested ids", async () => {
      await seedSubs([1, 2]);
      await recordNotifiedBatch(DB, [
        { scrape_date: SCRAPE_DATE, subscription_id: 1, fingerprint: "fp-1", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
        { scrape_date: SCRAPE_DATE, subscription_id: 2, fingerprint: "fp-2", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
      ]);

      expect((await getNotifiedFingerprints(DB, "2026-09-07", [1, 2])).size).toBe(0);
      const only1 = await getNotifiedFingerprints(DB, SCRAPE_DATE, [1]);
      expect([...only1.keys()]).toEqual([1]);
    });
  });

  describe("recordNotifiedBatch", () => {
    it("is a no-op issuing zero queries for an empty array", async () => {
      await expect(recordNotifiedBatch(noQueryDb, [])).resolves.toBeUndefined();
    });

    it("writes every row in one call", async () => {
      await seedSubs([1, 2]);
      await recordNotifiedBatch(DB, [
        { scrape_date: SCRAPE_DATE, subscription_id: 1, fingerprint: "fp-1", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
        { scrape_date: SCRAPE_DATE, subscription_id: 2, fingerprint: "fp-2", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
      ]);

      const r = await DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{ c: number }>();
      expect(r!.c).toBe(2);
      expect(await wasNotified(DB, SCRAPE_DATE, 1)).toBe(true);
      expect(await wasNotified(DB, SCRAPE_DATE, 2)).toBe(true);
    });

    it("UPDATES an existing row when the fingerprint differs", async () => {
      await seedSubs([1]);
      await recordNotifiedBatch(DB, [
        { scrape_date: SCRAPE_DATE, subscription_id: 1, fingerprint: "fp-old", sent_at: SCRAPED_AT, price_per_gallon: 4.84, reason: "price_moved" },
      ]);

      // The price moved and a second push really was made the same day. The row
      // must now describe the message the phone actually holds — otherwise the
      // next comparison is made against a fingerprint that was superseded.
      const later = "2026-09-06T18:00:00.000Z";
      await recordNotifiedBatch(DB, [
        { scrape_date: SCRAPE_DATE, subscription_id: 1, fingerprint: "fp-new", sent_at: later, price_per_gallon: 4.84, reason: "price_moved" },
      ]);

      const row = await DB.prepare(
        "SELECT fingerprint, sent_at FROM notifications WHERE scrape_date = ? AND subscription_id = 1",
      )
        .bind(SCRAPE_DATE)
        .first<{ fingerprint: string; sent_at: string }>();
      expect(row?.fingerprint).toBe("fp-new");
      expect(row?.sent_at).toBe(later);

      const count = await DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{ c: number }>();
      expect(count!.c).toBe(1);
    });

    it("does not throw when re-recording an identical row", async () => {
      await seedSubs([1]);
      const row = {
        scrape_date: SCRAPE_DATE,
        subscription_id: 1,
        fingerprint: "fp-1",
        sent_at: SCRAPED_AT,
        price_per_gallon: 4.84,
        reason: "price_moved",
      };
      await recordNotifiedBatch(DB, [row]);
      await expect(recordNotifiedBatch(DB, [row])).resolves.toBeUndefined();
      const count = await DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{ c: number }>();
      expect(count!.c).toBe(1);
    });

    it("chunks past the 100-bound-parameter cap: 30 rows in one call", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => i + 1);
      await seedSubs(ids);

      await recordNotifiedBatch(
        DB,
        ids.map((id) => ({
          scrape_date: SCRAPE_DATE,
          subscription_id: id,
          fingerprint: `fp-${id}`,
          sent_at: SCRAPED_AT,
        price_per_gallon: 4.84,
        reason: "price_moved",
        })),
      );

      const count = await DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{ c: number }>();
      expect(count!.c).toBe(30);
      const map = await getNotifiedFingerprints(DB, SCRAPE_DATE, ids);
      expect(map.size).toBe(30);
      expect(map.get(30)).toBe("fp-30");
    });
  });
});
