/**
 * Phase 2 — parser tests.
 *
 * Everything here is asserted against the REAL saved 06483 page
 * (test/fixtures/06483.html), and the expected values come from
 * implementation-plan §1.3, which was independently verified twice against the
 * raw HTML. The fixture is the contract: if the site's markup drifts, these
 * tests are what notice.
 */

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/06483.html?raw";
import {
  ParseError,
  parseHumanDate,
  parseListingsPage,
  toPriceRows,
} from "../src/parser";
import type { ParsedListing, PaymentType } from "../src/types";

// --------------------------------------------------------------- ground truth

/** plan §1.3 — the complete expected extraction, dealer by dealer. */
const GROUND_TRUTH: Array<{
  dealer_id: number;
  delivery_date: string;
  cash: Array<[number, number, number]>;
  credit: Array<[number, number, number]>;
}> = [
  {
    dealer_id: 11,
    delivery_date: "2026-09-08",
    cash: [
      [100, 149, 4.84],
      [150, 199, 4.84],
      [200, 299, 4.84],
      [300, 399, 4.84],
    ],
    credit: [
      [100, 149, 4.94],
      [150, 199, 4.94],
      [200, 299, 4.94],
      [300, 399, 4.94],
    ],
  },
  {
    dealer_id: 372,
    delivery_date: "2026-09-09",
    cash: [
      [50, 99, 5.64],
      [100, 149, 4.84],
      [150, 199, 4.84],
      [200, 299, 4.84],
      [300, 399, 4.84],
    ],
    credit: [
      [50, 99, 5.74],
      [100, 149, 4.94],
      [150, 199, 4.94],
      [200, 299, 4.94],
      [300, 399, 4.94],
    ],
  },
  {
    dealer_id: 744,
    delivery_date: "2026-09-07",
    cash: [
      [50, 99, 6.0],
      [100, 149, 4.84],
      [150, 199, 4.84],
      [200, 299, 4.84],
      [300, 399, 4.84],
    ],
    // No 50-99 credit tier. This asymmetry is real, not a parse bug.
    credit: [
      [100, 149, 4.94],
      [150, 199, 4.94],
      [200, 299, 4.94],
      [300, 399, 4.94],
    ],
  },
  {
    dealer_id: 345,
    delivery_date: "2026-09-09",
    cash: [
      [150, 199, 5.19],
      [200, 299, 5.19],
      [300, 399, 5.19],
    ],
    credit: [
      [150, 199, 5.19],
      [200, 299, 5.19],
      [300, 399, 5.19],
    ],
  },
  {
    dealer_id: 919,
    delivery_date: "2026-09-09",
    cash: [
      [150, 199, 5.19],
      [200, 299, 5.19],
      [300, 399, 5.19],
    ],
    credit: [
      [150, 199, 5.19],
      [200, 299, 5.19],
      [300, 399, 5.19],
    ],
  },
];

const EXPECTED_CASH = GROUND_TRUTH.reduce((n, d) => n + d.cash.length, 0); // 20
const EXPECTED_CREDIT = GROUND_TRUTH.reduce((n, d) => n + d.credit.length, 0); // 19
const EXPECTED_TOTAL = EXPECTED_CASH + EXPECTED_CREDIT; // 39

function tiersOf(listing: ParsedListing, payment: PaymentType) {
  return listing.tiers
    .filter((t) => t.payment_type === payment)
    .map((t) => [t.gallon_min, t.gallon_max, t.price_per_gallon]);
}

let cached: ParsedListing[] | null = null;
async function parsed(): Promise<ParsedListing[]> {
  if (cached === null) cached = await parseListingsPage(fixture);
  return cached;
}

// --------------------------------------------------------------- the fixture

describe("parseListingsPage against the real 06483 page", () => {
  it("extracts exactly 5 listings", async () => {
    expect((await parsed()).length).toBe(5);
  });

  it("reports dealer ids in document order", async () => {
    expect((await parsed()).map((l) => l.dealer_id)).toEqual([
      11, 372, 744, 345, 919,
    ]);
  });

  it("reports the delivery date of every listing, from the ISO earlistdate", async () => {
    expect((await parsed()).map((l) => l.delivery_date)).toEqual([
      "2026-09-08",
      "2026-09-09",
      "2026-09-07",
      "2026-09-09",
      "2026-09-09",
    ]);
  });

  it("reports price_updated_on 2026-09-05 for every listing", async () => {
    for (const listing of await parsed()) {
      expect(listing.price_updated_on).toBe("2026-09-05");
    }
  });

  it("reports a same-day charge of 0 for every listing", async () => {
    for (const listing of await parsed()) {
      expect(listing.same_day_charge).toBe(0);
    }
  });

  it("extracts 39 price points: 20 cash and 19 credit", async () => {
    const listings = await parsed();
    const cash = listings.flatMap((l) =>
      l.tiers.filter((t) => t.payment_type === "cash"),
    );
    const credit = listings.flatMap((l) =>
      l.tiers.filter((t) => t.payment_type === "credit"),
    );
    expect(cash.length).toBe(20);
    expect(credit.length).toBe(19);
    expect(cash.length + credit.length).toBe(EXPECTED_TOTAL);
  });

  // One test per dealer, asserting the full tier set both ways round.
  for (const expected of GROUND_TRUTH) {
    it(`extracts every tier for dealer ${expected.dealer_id}`, async () => {
      const listing = (await parsed()).find(
        (l) => l.dealer_id === expected.dealer_id,
      );
      expect(listing, `dealer ${expected.dealer_id} missing`).toBeDefined();
      expect(tiersOf(listing!, "cash")).toEqual(expected.cash);
      expect(tiersOf(listing!, "credit")).toEqual(expected.credit);
    });
  }

  it("does NOT invent a credit 50-99 tier for dealer 744", async () => {
    const listing = (await parsed()).find((l) => l.dealer_id === 744)!;
    const credit = listing.tiers.filter((t) => t.payment_type === "credit");
    expect(credit.length).toBe(4);
    expect(credit.some((t) => t.gallon_min === 50)).toBe(false);
    // ...while its cash side does have one, at $6.00.
    const cash50 = listing.tiers.find(
      (t) => t.payment_type === "cash" && t.gallon_min === 50,
    );
    expect(cash50?.price_per_gallon).toBe(6.0);
  });

  it("preserves the 50-99 cash prices that make a bare cheapest-price misleading", async () => {
    const listings = await parsed();
    const at = (dealer: number) =>
      listings
        .find((l) => l.dealer_id === dealer)!
        .tiers.find((t) => t.payment_type === "cash" && t.gallon_min === 50)
        ?.price_per_gallon;
    expect(at(372)).toBe(5.64);
    expect(at(744)).toBe(6.0);
  });

  it("shows a +$0.10 cash-to-credit spread for 11/372/744 and $0 for 345/919", async () => {
    const listings = await parsed();
    const expectedSpread: Record<number, number> = {
      11: 0.1,
      372: 0.1,
      744: 0.1,
      345: 0,
      919: 0,
    };
    for (const listing of listings) {
      const cash = listing.tiers.filter((t) => t.payment_type === "cash");
      const credit = listing.tiers.filter((t) => t.payment_type === "credit");
      let compared = 0;
      for (const c of cash) {
        const match = credit.find((t) => t.gallon_min === c.gallon_min);
        if (!match) continue; // dealer 744's missing 50-99 credit tier
        compared++;
        expect(
          Math.abs(
            match.price_per_gallon -
              c.price_per_gallon -
              expectedSpread[listing.dealer_id]!,
          ),
          `dealer ${listing.dealer_id} tier ${c.gallon_min}`,
        ).toBeLessThan(1e-9);
      }
      expect(compared).toBeGreaterThan(0);
    }
  });

  it("never emits a payment_type outside cash|credit", async () => {
    for (const listing of await parsed()) {
      for (const tier of listing.tiers) {
        expect(["cash", "credit"]).toContain(tier.payment_type);
      }
    }
  });

  it("never emits a tier with a non-finite or non-positive price", async () => {
    for (const listing of await parsed()) {
      for (const tier of listing.tiers) {
        expect(Number.isFinite(tier.price_per_gallon)).toBe(true);
        expect(tier.price_per_gallon).toBeGreaterThan(0);
        expect(tier.gallon_min).toBeGreaterThan(0);
        expect(tier.gallon_max === null || tier.gallon_max >= tier.gallon_min).toBe(
          true,
        );
      }
    }
  });

  it("is deterministic across repeated parses", async () => {
    const a = await parseListingsPage(fixture);
    const b = await parseListingsPage(fixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// --------------------------------------------------------------- toPriceRows

describe("toPriceRows", () => {
  it("flattens the fixture to 39 rows carrying the run's metadata", async () => {
    const rows = toPriceRows(
      await parsed(),
      "06483",
      "2026-09-06",
      "2026-09-06T12:00:00.000Z",
    );
    expect(rows.length).toBe(EXPECTED_TOTAL);
    for (const row of rows) {
      expect(row.zip).toBe("06483");
      expect(row.scrape_date).toBe("2026-09-06");
      expect(row.scraped_at).toBe("2026-09-06T12:00:00.000Z");
      expect(["cash", "credit"]).toContain(row.payment_type);
    }
  });

  it("preserves listing order then tier order", async () => {
    const rows = toPriceRows(
      await parsed(),
      "06483",
      "2026-09-06",
      "2026-09-06T12:00:00.000Z",
    );
    // Dealer ids appear in blocks, in document order.
    const order: number[] = [];
    for (const row of rows) {
      if (order[order.length - 1] !== row.dealer_id) order.push(row.dealer_id);
    }
    expect(order).toEqual([11, 372, 744, 345, 919]);
  });

  it("copies listing-level fields onto every row", async () => {
    const rows = toPriceRows(
      await parsed(),
      "06483",
      "2026-09-06",
      "2026-09-06T12:00:00.000Z",
    );
    const dealer744 = rows.filter((r) => r.dealer_id === 744);
    expect(dealer744.length).toBe(9); // 5 cash + 4 credit
    for (const row of dealer744) {
      expect(row.delivery_date).toBe("2026-09-07");
      expect(row.price_updated_on).toBe("2026-09-05");
      expect(row.same_day_charge).toBe(0);
    }
  });

  it("returns [] for []", () => {
    expect(toPriceRows([], "06483", "2026-09-06", "2026-09-06T12:00:00.000Z")).toEqual(
      [],
    );
  });
});

// --------------------------------------------------------------- empty & bad

describe("pages with no listings", () => {
  it("returns [] rather than throwing, so the caller decides (PRD §8)", async () => {
    expect(await parseListingsPage("<html><body></body></html>")).toEqual([]);
  });

  it("returns [] for a page that is well-formed but listing-free", async () => {
    const stripped = fixture.replace(/boxlisting/g, "notalisting");
    expect(await parseListingsPage(stripped)).toEqual([]);
  });
});

describe("defensive rules", () => {
  it("rejects input larger than 2 MB", async () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(parseListingsPage(huge)).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a listing whose dealerid inputs have been removed", async () => {
    const broken = fixture.replace(/name="dealerid"/g, 'name="notdealerid"');
    await expect(parseListingsPage(broken)).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a listing whose two dealerid values disagree", async () => {
    // Change only the SECOND occurrence of dealer 11's id.
    let seen = 0;
    const broken = fixture.replace(/name="dealerid" value="11"/g, (m) => {
      seen++;
      return seen === 2 ? 'name="dealerid" value="99"' : m;
    });
    expect(seen).toBeGreaterThanOrEqual(2);
    await expect(parseListingsPage(broken)).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a listing whose enumtype no longer matches its table class", async () => {
    const broken = fixture.replace('value="Credit"', 'value="Cash"');
    await expect(parseListingsPage(broken)).rejects.toBeInstanceOf(ParseError);
  });

  it("names the offending listing index in the error message", async () => {
    const broken = fixture.replace(/name="dealerid"/g, 'name="notdealerid"');
    await expect(parseListingsPage(broken)).rejects.toThrow(/listing index \d+/i);
  });
});

// --------------------------------------------------------------- date parsing

describe("parseHumanDate", () => {
  const cases: Array<[string, string | null]> = [
    ["Sep 5th 2026", "2026-09-05"],
    ["Jan 1st 2027", "2027-01-01"],
    ["Mar 3rd 2026", "2026-03-03"],
    ["Dec 22nd 2026", "2026-12-22"],
    ["Sep 8th 2026", "2026-09-08"],
    ["garbage", null],
    ["", null],
    ["2026-09-05", null],
    ["Foo 5th 2026", null],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseHumanDate(input)).toBe(expected);
    });
  }

  it("tolerates the NBSP padding the site actually emits", () => {
    expect(parseHumanDate(" Sep 5th 2026 ")).toBe("2026-09-05");
  });
});
