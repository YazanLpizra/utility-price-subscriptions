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
import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/06483.html?raw";

// --------------------------------------------------------------- helpers

const DB = env.DB;

/**
 * NOTE for every downstream phase: `@cloudflare/vitest-plugin@1.1.4` does NOT
 * give per-test isolated storage — the local D1 is shared by every test in a
 * file and writes survive from one `it()` to the next. Clean up explicitly.
 * Order matters: children before parents, because of the FK references.
 */
beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM notifications"),
    DB.prepare("DELETE FROM prices"),
    DB.prepare("DELETE FROM subscriptions"),
    DB.prepare("DELETE FROM zips"),
  ]);
});

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
  try {
    await DB.prepare(sql)
      .bind(...bind)
      .run();
    return false;
  } catch {
    return true;
  }
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
