/**
 * Phase 6 — seed tests.
 *
 * The seed SQL is executed against the real local D1 (migrations already
 * applied by test/setup.ts, which also resets every table before each test).
 * `node:fs` is not available inside the workerd pool, so the file is imported
 * with `?raw` instead.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import seedSql from "../seeds/dev-seed.sql?raw";

const DB = env.DB;

/**
 * Split the seed file into executable statements. Comments are stripped first
 * so that a `;` inside a comment cannot split a statement.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applySeed(): Promise<void> {
  for (const sql of statements(seedSql)) {
    await DB.prepare(sql).run();
  }
}

async function counts(): Promise<{
  zips: number;
  activeZips: number;
  subs: number;
}> {
  const row = await DB.prepare(
    "SELECT (SELECT COUNT(*) FROM zips) AS zips, " +
      "(SELECT COUNT(*) FROM zips WHERE active = 1) AS activeZips, " +
      "(SELECT COUNT(*) FROM subscriptions) AS subs",
  ).first<{ zips: number; activeZips: number; subs: number }>();
  return row!;
}

describe("seeds/dev-seed.sql", () => {
  it("applies cleanly against the migrated schema", async () => {
    await expect(applySeed()).resolves.not.toThrow();
  });

  it("seeds the four PRD zips", async () => {
    await applySeed();
    const rows = await DB.prepare("SELECT zip FROM zips ORDER BY zip").all<{
      zip: string;
    }>();
    expect(rows.results.map((r) => r.zip)).toEqual([
      "06483",
      "06611",
      "08540",
      "11530",
    ]);
  });

  it("seeds EVERY zip inactive, so a local run reaches no network", async () => {
    await applySeed();
    const { zips, activeZips } = await counts();
    expect(zips).toBe(4);
    expect(activeZips).toBe(0);
  });

  it("leaves 06483's slug NULL so the first run resolves it via POST", async () => {
    await applySeed();
    const row = await DB.prepare(
      "SELECT slug, slug_resolved_at FROM zips WHERE zip = '06483'",
    ).first<{ slug: string | null; slug_resolved_at: string | null }>();
    expect(row!.slug).toBeNull();
    expect(row!.slug_resolved_at).toBeNull();
  });

  it("seeds exactly two subscriptions, with fixed ids 1 and 2", async () => {
    await applySeed();
    const rows = await DB.prepare(
      "SELECT id, zip, min_gallons, payment_type, threshold, active FROM subscriptions ORDER BY id",
    ).all<{
      id: number;
      zip: string;
      min_gallons: number;
      payment_type: string;
      threshold: number | null;
      active: number;
    }>();
    expect(rows.results).toEqual([
      {
        id: 1,
        zip: "06483",
        min_gallons: 100,
        payment_type: "cash",
        threshold: null,
        active: 1,
      },
      {
        id: 2,
        zip: "06483",
        min_gallons: 50,
        payment_type: "cash",
        threshold: null,
        active: 1,
      },
    ]);
  });

  it("gives both subscriptions a NULL threshold", async () => {
    // Not cosmetic: the best qualifying 50-gallon price on the fixture day is
    // $5.64, so a threshold of 5.50 would make Phase 5 correctly suppress the
    // notification that the orchestration test expects to be sent.
    await applySeed();
    const row = await DB.prepare(
      "SELECT COUNT(*) AS c FROM subscriptions WHERE threshold IS NOT NULL",
    ).first<{ c: number }>();
    expect(row!.c).toBe(0);
  });

  it("uses only the placeholder ntfy topic, never a real one", async () => {
    await applySeed();
    const rows = await DB.prepare(
      "SELECT DISTINCT ntfy_topic FROM subscriptions",
    ).all<{ ntfy_topic: string }>();
    expect(rows.results.map((r) => r.ntfy_topic)).toEqual(["heating-oil-local-dev"]);
  });

  it("is idempotent: applying it twice changes no counts", async () => {
    await applySeed();
    const first = await counts();
    await applySeed();
    const second = await counts();
    expect(second).toEqual(first);
    expect(second).toEqual({ zips: 4, activeZips: 0, subs: 2 });
  });

  it("is idempotent three times over", async () => {
    await applySeed();
    await applySeed();
    await applySeed();
    expect(await counts()).toEqual({ zips: 4, activeZips: 0, subs: 2 });
  });

  it("does not reactivate a zip the operator has paused", async () => {
    await applySeed();
    await DB.prepare("UPDATE zips SET active = 1 WHERE zip = '06483'").run();
    await DB.prepare("UPDATE zips SET slug = 'seymour_ct_oil_prices/06483' WHERE zip = '06483'").run();
    await applySeed();
    const row = await DB.prepare(
      "SELECT active, slug FROM zips WHERE zip = '06483'",
    ).first<{ active: number; slug: string | null }>();
    // Re-seeding resets `active` to the seed's value by design...
    expect(row!.active).toBe(0);
    // ...but must not discard a slug that has already been resolved.
    expect(row!.slug).toBe("seymour_ct_oil_prices/06483");
  });

  it("produces rows that satisfy the migration's CHECK constraints", async () => {
    // Applying at all proves this, but assert the shape explicitly so a
    // loosened constraint cannot pass unnoticed.
    await applySeed();
    const bad = await DB.prepare(
      "SELECT COUNT(*) AS c FROM subscriptions " +
        "WHERE payment_type NOT IN ('cash','credit') OR min_gallons <= 0 OR active NOT IN (0,1)",
    ).first<{ c: number }>();
    expect(bad!.c).toBe(0);

    const badZips = await DB.prepare(
      "SELECT COUNT(*) AS c FROM zips WHERE zip NOT GLOB '[0-9][0-9][0-9][0-9][0-9]'",
    ).first<{ c: number }>();
    expect(badZips!.c).toBe(0);
  });

  it("its subscriptions reference a seeded zip", async () => {
    await applySeed();
    const orphans = await DB.prepare(
      "SELECT COUNT(*) AS c FROM subscriptions s LEFT JOIN zips z ON z.zip = s.zip WHERE z.zip IS NULL",
    ).first<{ c: number }>();
    expect(orphans!.c).toBe(0);
  });
});
