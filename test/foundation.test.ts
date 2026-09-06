/**
 * Phase 1 foundation tests.
 *
 * Two jobs, and they are the reason every other phase can start:
 *   1. prove the de-wrapped HTML fixture is the document the plan describes
 *      (structurally — never by byte count);
 *   2. prove the test harness really is running inside workerd against a local
 *      D1 with migrations/0001_init.sql applied, and that every constraint that
 *      migration claims to enforce actually bites.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/06483.html?raw";

// --------------------------------------------------------------- helpers

const DB = env.DB;

/**
 * The database is reset before every `it()` by test/setup.ts, which runs for
 * every test file in the project. Storage is isolated per FILE, not per test,
 * so that global hook is what makes these tests order-independent.
 */

function countMatches(re: RegExp): number {
  return (fixture.match(re) ?? []).length;
}

function distribution(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Runs a statement and resolves to true when D1 rejected it. */
async function rejects(sql: string, ...bind: unknown[]): Promise<boolean> {
  return (await rejectionOf(sql, ...bind)) !== null;
}

/**
 * Runs a statement and resolves to the rejection message, or null if it
 * succeeded. Tests assert on the message so that a schema typo cannot
 * masquerade as the constraint violation we meant to provoke.
 */
async function rejectionOf(sql: string, ...bind: unknown[]): Promise<string | null> {
  try {
    await DB.prepare(sql)
      .bind(...bind)
      .run();
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

/** Asserts the statement was rejected specifically by a CHECK constraint. */
async function expectCheckViolation(sql: string, ...bind: unknown[]): Promise<void> {
  const message = await rejectionOf(sql, ...bind);
  expect(message, "statement was expected to be rejected, but it succeeded").not.toBeNull();
  expect(message).toMatch(/CHECK constraint failed/i);
}

const INSERT_PRICE = `
  INSERT INTO prices
    (scrape_date, zip, dealer_id, payment_type, gallon_min, gallon_max,
     price_per_gallon, delivery_date, price_updated_on, same_day_charge, scraped_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

const PRICE_ARGS: unknown[] = [
  "2026-09-05",
  "06483",
  11,
  "cash",
  100,
  149,
  4.84,
  "2026-09-08",
  "2026-09-05",
  0,
  "2026-09-05T12:00:00.000Z",
];

async function seedZip(zip = "06483"): Promise<void> {
  await DB.prepare(
    "INSERT INTO zips (zip, slug, city, state, active, slug_resolved_at) VALUES (?,?,?,?,1,?)",
  )
    .bind(zip, `seymour_ct_oil_prices/${zip}`, "seymour", "ct", "2026-09-05T12:00:00.000Z")
    .run();
}

// ----------------------------------------------------- (a) the fixture

describe("fixture: test/fixtures/06483.html", () => {
  it("exists, is non-empty, and has LF-only line endings", () => {
    expect(fixture.length).toBeGreaterThan(1000);
    expect(fixture).toContain("<html");
    expect(fixture).not.toContain("\r");
    // the view-source scaffolding must be gone
    expect(fixture).not.toContain("line-content");
    expect(fixture).not.toContain("html-attribute-name");
    // and the real markup must be un-escaped
    expect(fixture).not.toContain("&lt;div");
  });

  it("has exactly 5 div.boxlisting", () => {
    expect(countMatches(/class\s*=\s*["'][^"']*\bboxlisting\b[^"']*["']/gi)).toBe(5);
  });

  it("has 10 dealerid inputs, in the documented document order", () => {
    const ids = [
      ...fixture.matchAll(
        /<input[^>]*\bname\s*=\s*["']dealerid["'][^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>/gi,
      ),
    ].map((m) => Number(m[1]));
    expect(ids).toHaveLength(10);
    expect(ids).toEqual([11, 11, 372, 372, 744, 744, 345, 345, 919, 919]);
  });

  it("has 5 paywithcash and 5 paybycredit tables", () => {
    expect(countMatches(/class\s*=\s*["'][^"']*\bpaywithcash\b[^"']*["']/gi)).toBe(5);
    expect(countMatches(/class\s*=\s*["'][^"']*\bpaybycredit\b[^"']*["']/gi)).toBe(5);
  });

  it("has 39 gallon-tier labels with the documented distribution", () => {
    const tiers = [...fixture.matchAll(/<td[^>]*>\s*(\d+\s*-\s*\d+)\s*<\/td>/gi)].map((m) =>
      m[1]!.replace(/\s+/g, ""),
    );
    expect(tiers).toHaveLength(39);
    expect(distribution(tiers)).toEqual({
      "50-99": 3,
      "100-149": 6,
      "150-199": 10,
      "200-299": 10,
      "300-399": 10,
    });
  });

  it("has 39 price strings with the documented distribution", () => {
    const prices = [...fixture.matchAll(/<td[^>]*>\s*(\$\s*[\d,]+\.\d{2})\s*<\/td>/gi)].map((m) =>
      m[1]!.replace(/\s+/g, ""),
    );
    expect(prices).toHaveLength(39);
    expect(distribution(prices)).toEqual({
      "$4.84": 12,
      "$4.94": 12,
      "$5.19": 12,
      "$5.64": 1,
      "$5.74": 1,
      "$6.00": 1,
    });
  });
});

// ------------------------------------------- (b) migration applied + upsert

describe("migration 0001_init: schema is present", () => {
  it("created every table and index", async () => {
    const { results } = await DB.prepare(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string; type: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["zips", "prices", "subscriptions", "notifications"]) {
      expect(names).toContain(t);
    }
    for (const i of [
      "ux_prices_day",
      "ix_prices_zip_date",
      "ix_prices_dealer",
      "ix_subs_zip_active",
      "ux_subs_natural",
    ]) {
      expect(names).toContain(i);
    }
  });
});

describe("prices: ux_prices_day uniqueness", () => {
  it("rejects a duplicate day/zip/dealer/payment/gallon_min, but accepts the upsert form", async () => {
    await seedZip();
    await DB.prepare(INSERT_PRICE)
      .bind(...PRICE_ARGS)
      .run();

    // plain duplicate -> constraint error
    expect(await rejects(INSERT_PRICE, ...PRICE_ARGS)).toBe(true);

    // same key via ON CONFLICT DO UPDATE -> succeeds, still one row, new value
    const upsertArgs = [...PRICE_ARGS];
    upsertArgs[6] = 4.5;
    await DB.prepare(
      `${INSERT_PRICE}
       ON CONFLICT (scrape_date, zip, dealer_id, payment_type, gallon_min) DO UPDATE SET
         gallon_max       = excluded.gallon_max,
         price_per_gallon = excluded.price_per_gallon,
         delivery_date    = excluded.delivery_date,
         price_updated_on = excluded.price_updated_on,
         same_day_charge  = excluded.same_day_charge,
         scraped_at       = excluded.scraped_at`,
    )
      .bind(...upsertArgs)
      .run();

    const row = await DB.prepare(
      "SELECT COUNT(*) AS n, MAX(price_per_gallon) AS p FROM prices",
    ).first<{ n: number; p: number }>();
    expect(row?.n).toBe(1);
    expect(row?.p).toBeCloseTo(4.5, 9);
  });
});

// ------------------------------------------------- (c)+(d) CHECK constraints

describe("CHECK constraints bite", () => {
  it("rejects subscriptions.payment_type = 'debit'", async () => {
    await seedZip();
    expect(
      await rejects(
        "INSERT INTO subscriptions (user_id, zip, ntfy_topic, min_gallons, payment_type) VALUES (?,?,?,?,?)",
        "yazan",
        "06483",
        "topic-a",
        150,
        "debit",
      ),
    ).toBe(true);
  });

  it("rejects a 4-digit zips.zip", async () => {
    expect(await rejects("INSERT INTO zips (zip) VALUES (?)", "0648")).toBe(true);
  });

  it("rejects a non-numeric zips.zip of the right length", async () => {
    expect(await rejects("INSERT INTO zips (zip) VALUES (?)", "0648A")).toBe(true);
  });

  it("rejects zips.active = 2", async () => {
    expect(await rejects("INSERT INTO zips (zip, active) VALUES (?,?)", "06484", 2)).toBe(true);
  });

  it("rejects prices.price_per_gallon = 0", async () => {
    await seedZip();
    const args = [...PRICE_ARGS];
    args[6] = 0;
    expect(await rejects(INSERT_PRICE, ...args)).toBe(true);
  });

  it("rejects a gallon_max below gallon_min", async () => {
    await seedZip();
    const args = [...PRICE_ARGS];
    args[4] = 300;
    args[5] = 99;
    expect(await rejects(INSERT_PRICE, ...args)).toBe(true);
  });

  it('rejects a scrape_date of "2026-9-6"', async () => {
    await seedZip();
    const args = [...PRICE_ARGS];
    args[0] = "2026-9-6";
    expect(await rejects(INSERT_PRICE, ...args)).toBe(true);
  });

  it("accepts a NULL gallon_max (open-ended tier)", async () => {
    await seedZip();
    const args = [...PRICE_ARGS];
    args[4] = 400;
    args[5] = null;
    await DB.prepare(INSERT_PRICE)
      .bind(...args)
      .run();
    const row = await DB.prepare(
      "SELECT gallon_max FROM prices WHERE gallon_min = 400",
    ).first<{ gallon_max: number | null }>();
    expect(row?.gallon_max).toBeNull();
  });
});

// ------------------------------------------------------- (e) ux_subs_natural

describe("subscriptions: ux_subs_natural", () => {
  it("rejects a second subscription with the same natural key", async () => {
    await seedZip();
    const sql =
      "INSERT INTO subscriptions (user_id, zip, ntfy_topic, min_gallons, payment_type, threshold) VALUES (?,?,?,?,?,?)";
    const args: unknown[] = ["yazan", "06483", "yazan-06483-oil", 150, "cash", null];
    await DB.prepare(sql)
      .bind(...args)
      .run();
    expect(await rejects(sql, ...args)).toBe(true);

    // a different min_gallons is a different natural key and is accepted
    await DB.prepare(sql)
      .bind("yazan", "06483", "yazan-06483-oil", 200, "cash", null)
      .run();
    const row = await DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

// -------------------------------------------------------- (f) notifications

describe("notifications table", () => {
  it("exists and de-duplicates on (scrape_date, subscription_id)", async () => {
    await seedZip();
    await DB.prepare(
      "INSERT INTO subscriptions (id, user_id, zip, ntfy_topic, min_gallons, payment_type) VALUES (1,?,?,?,?,?)",
    )
      .bind("yazan", "06483", "yazan-06483-oil", 150, "cash")
      .run();

    const sql =
      "INSERT INTO notifications (scrape_date, subscription_id, fingerprint, sent_at) VALUES (?,?,?,?)";
    await DB.prepare(sql).bind("2026-09-05", 1, "fp-1", "2026-09-05T12:00:00.000Z").run();

    // a second row for the same (day, subscription) conflicts...
    expect(await rejects(sql, "2026-09-05", 1, "fp-2", "2026-09-05T12:05:00.000Z")).toBe(true);

    // ...and the DO NOTHING form is a silent no-op that leaves one row
    await DB.prepare(`${sql} ON CONFLICT (scrape_date, subscription_id) DO NOTHING`)
      .bind("2026-09-05", 1, "fp-2", "2026-09-05T12:05:00.000Z")
      .run();

    const row = await DB.prepare(
      "SELECT COUNT(*) AS n, MAX(fingerprint) AS f FROM notifications",
    ).first<{ n: number; f: string }>();
    expect(row?.n).toBe(1);
    expect(row?.f).toBe("fp-1");

    // the next day is a distinct key
    await DB.prepare(sql).bind("2026-09-06", 1, "fp-3", "2026-09-06T12:00:00.000Z").run();
    const after = await DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(after?.n).toBe(2);
  });
});

// ------------------------------------------------ harness sanity: isolation

describe("harness", () => {
  it("starts each test from a clean database", async () => {
    for (const t of ["prices", "zips", "subscriptions", "notifications"]) {
      const row = await DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(row?.n, t).toBe(0);
    }
  });

  it("exposes HTMLRewriter, the real workerd global", () => {
    expect(typeof HTMLRewriter).toBe("function");
  });
});

/**
 * Exhaustive CHECK coverage. migrations/0001_init.sql declares 16 CHECK
 * clauses; every one gets a row here. Each case starts from a row that is
 * otherwise valid and mutates exactly ONE column, so a rejection can only be
 * attributable to the constraint under test — and the assertion requires the
 * error to actually name a CHECK violation, not merely to be some error.
 */
describe("CHECK constraints: every clause in the migration", () => {
  interface Case {
    name: string;
    table: "zips" | "prices" | "subscriptions";
    column: string;
    value: unknown;
  }

  const cases: Case[] = [
    { name: "zips.zip too short", table: "zips", column: "zip", value: "0648" },
    { name: "zips.zip non-numeric", table: "zips", column: "zip", value: "0648A" },
    { name: "zips.active out of range", table: "zips", column: "active", value: 2 },

    { name: "prices.scrape_date unpadded", table: "prices", column: "scrape_date", value: "2026-9-6" },
    { name: "prices.zip too short", table: "prices", column: "zip", value: "6483" },
    { name: "prices.dealer_id zero", table: "prices", column: "dealer_id", value: 0 },
    { name: "prices.dealer_id negative", table: "prices", column: "dealer_id", value: -11 },
    { name: "prices.payment_type unknown", table: "prices", column: "payment_type", value: "debit" },
    { name: "prices.gallon_min zero", table: "prices", column: "gallon_min", value: 0 },
    { name: "prices.gallon_max below gallon_min", table: "prices", column: "gallon_max", value: 50 },
    { name: "prices.price_per_gallon zero", table: "prices", column: "price_per_gallon", value: 0 },
    { name: "prices.price_per_gallon negative", table: "prices", column: "price_per_gallon", value: -1 },
    { name: "prices.delivery_date malformed", table: "prices", column: "delivery_date", value: "Sep 8th 2026" },
    { name: "prices.price_updated_on malformed", table: "prices", column: "price_updated_on", value: "2026/09/05" },

    { name: "subscriptions.zip too short", table: "subscriptions", column: "zip", value: "648" },
    { name: "subscriptions.min_gallons zero", table: "subscriptions", column: "min_gallons", value: 0 },
    { name: "subscriptions.payment_type unknown", table: "subscriptions", column: "payment_type", value: "crypto" },
    { name: "subscriptions.threshold zero", table: "subscriptions", column: "threshold", value: 0 },
    { name: "subscriptions.threshold negative", table: "subscriptions", column: "threshold", value: -5 },
    { name: "subscriptions.active out of range", table: "subscriptions", column: "active", value: 7 },
  ];

  const baselines = {
    zips: {
      zip: "06483",
      slug: "seymour_ct_oil_prices/06483",
      city: "seymour",
      state: "ct",
      active: 1,
      slug_resolved_at: "2026-09-05T12:00:00.000Z",
    } as Record<string, unknown>,
    prices: {
      scrape_date: "2026-09-05",
      zip: "06483",
      dealer_id: 11,
      payment_type: "cash",
      gallon_min: 100,
      gallon_max: 149,
      price_per_gallon: 4.84,
      delivery_date: "2026-09-08",
      price_updated_on: "2026-09-05",
      same_day_charge: 0,
      scraped_at: "2026-09-05T12:00:00.000Z",
    } as Record<string, unknown>,
    subscriptions: {
      user_id: "v1",
      zip: "06483",
      ntfy_topic: "heating-oil-local-dev",
      min_gallons: 100,
      payment_type: "cash",
      threshold: null,
      active: 1,
    } as Record<string, unknown>,
  };

  function statementFor(table: Case["table"], row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    return { sql, args: cols.map((c) => row[c]) };
  }

  // Guard: each baseline must itself be accepted, otherwise every case below
  // would "pass" for the wrong reason.
  it("baseline rows are valid", async () => {
    for (const table of ["zips", "prices", "subscriptions"] as const) {
      if (table !== "zips") await seedZip();
      const { sql, args } = statementFor(table, baselines[table]);
      expect(await rejectionOf(sql, ...args), `${table} baseline`).toBeNull();
      await DB.batch([
        DB.prepare("DELETE FROM subscriptions"),
        DB.prepare("DELETE FROM prices"),
        DB.prepare("DELETE FROM zips"),
      ]);
    }
  });

  for (const c of cases) {
    it(`rejects ${c.name}`, async () => {
      if (c.table !== "zips") await seedZip();
      const row = { ...baselines[c.table], [c.column]: c.value };
      const { sql, args } = statementFor(c.table, row);
      await expectCheckViolation(sql, ...args);
    });
  }
});
