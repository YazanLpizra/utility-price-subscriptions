/**
 * Phase 2 — parser tests.
 *
 * Everything here is asserted against the REAL saved 06483 page
 * (test/fixtures/06483.html), and the expected values come from
 * implementation-plan §1.3, which was independently verified twice against the
 * raw HTML. The fixture is the contract: if the site's markup drifts, these
 * tests are what notice.
 */

import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/06483.html?raw";
import liveFixture from "./fixtures/06483-2026-09-07.html?raw";
import {
  extractPriceTables,
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

  it("skips a listing whose two dealerid values disagree, keeping the rest", async () => {
    // Change only the SECOND occurrence of dealer 11's id.
    let seen = 0;
    const broken = fixture.replace(/name="dealerid" value="11"/g, (m) => {
      seen++;
      return seen === 2 ? 'name="dealerid" value="99"' : m;
    });
    expect(seen).toBeGreaterThanOrEqual(2);
    const listings = await parseListingsPage(broken);
    expect(listings.map((l) => l.dealer_id)).toEqual([372, 744, 345, 919]);
  });

  it("skips a listing whose enumtype no longer matches its table class", async () => {
    const broken = fixture.replace('value="Credit"', 'value="Cash"');
    const listings = await parseListingsPage(broken);
    expect(listings.map((l) => l.dealer_id)).toEqual([372, 744, 345, 919]);
  });

  it("still rejects a page on which NO listing can be parsed", async () => {
    const broken = fixture.replace(/name="dealerid"/g, 'name="notdealerid"');
    await expect(parseListingsPage(broken)).rejects.toBeInstanceOf(ParseError);
  });

  it("names the offending listing index in the error message", async () => {
    const broken = fixture.replace(/name="dealerid"/g, 'name="notdealerid"');
    await expect(parseListingsPage(broken)).rejects.toThrow(/listing index \d+/i);
  });
});

// --------------------------------------------------------------- best effort

/** Applies `edit` to the first listing (dealer 11) only, leaving the rest intact. */
function editFirstListing(edit: (html: string) => string): string {
  const second = fixture.indexOf("boxlisting", fixture.indexOf("boxlisting") + 1);
  return edit(fixture.slice(0, second)) + fixture.slice(second);
}

describe("best-effort parsing", () => {
  it("skips a listing with no price tiers instead of failing the page", async () => {
    // The production error: "listing index 0: no price tiers found".
    const noTiers = editFirstListing((h) =>
      h.replace(/<td>\d+-\d+<\/td>\s*<td>\$[\d.]+<\/td>/g, ""),
    );
    const listings = await parseListingsPage(noTiers);
    expect(listings.map((l) => l.dealer_id)).toEqual([372, 744, 345, 919]);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(EXPECTED_TOTAL - 8);
  });

  it("logs a skipped listing when a listing fails parsing, for tuning the parser later", async () => {
    // Modify dealer 11's forms to have mismatched dealerids so finaliseListing throws ParseError
    let seen = 0;
    const broken = fixture.replace(/name="dealerid" value="11"/g, (m) => {
      seen++;
      return seen === 2 ? 'name="dealerid" value="99"' : m;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await parseListingsPage(broken, { zip: "06483" });
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("PARSE_SKIP_LISTING "));
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!.slice("PARSE_SKIP_LISTING ".length));
      expect(entry.zip).toBe("06483");
      expect(entry.listing_index).toBe(0);
      expect(entry.reason).toMatch(/dealerid/);
      // Exactly this listing's markup: it starts at its own div and stops
      // before the next dealer's.
      expect(entry.html).toMatch(/^<div class="boxlisting">/);
      expect(entry.html).toContain('value="11"');
      expect(entry.html).not.toContain('value="372"');
    } finally {
      warn.mockRestore();
    }
  });

  it("logs PARSE_SKIP when a listing has no price tiers", async () => {
    const noTiers = editFirstListing((h) =>
      h.replace(/<td>\d+-\d+<\/td>\s*<td>\$[\d.]+<\/td>/g, ""),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await parseListingsPage(noTiers, { zip: "06483" });
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("PARSE_SKIP "));
      expect(lines.some((l) => l.includes("listing index 0: no price tiers found"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops only the tier whose price is unreadable", async () => {
    const callForPrice = editFirstListing((h) =>
      h.replace("<td>$4.84</td>", "<td>Call</td>"),
    );
    const dealer11 = (await parseListingsPage(callForPrice)).find((l) => l.dealer_id === 11)!;
    expect(tiersOf(dealer11, "cash")).toEqual(GROUND_TRUTH[0]!.cash.slice(1));
    expect(tiersOf(dealer11, "credit")).toEqual(GROUND_TRUTH[0]!.credit);
  });

  it("reads loosely formatted gallons and prices", async () => {
    const loose = editFirstListing((h) =>
      h
        .replace("<td>100-149</td>", "<td>100 – 149 gal</td>")
        .replace("<td>$4.84</td>", "<td>4.849/gal</td>")
        .replace("<td>150-199</td>", "<td>150-199 Gallons</td>"),
    );
    const dealer11 = (await parseListingsPage(loose)).find((l) => l.dealer_id === 11)!;
    expect(tiersOf(dealer11, "cash")).toEqual([
      [100, 149, 4.849],
      ...GROUND_TRUTH[0]!.cash.slice(1),
    ]);
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

// ------------------------------------------------- adversarial markup (scanner)

/**
 * These exist because the price cells are read by a string scanner rather than
 * by HTMLRewriter, and a scanner that is not HTML-aware fails in ways a parser
 * does not. Every case below was a REAL defect found by review, not a
 * hypothetical: the commented-cell case produced a bogus $0.01 "cheapest"
 * price, and the regex case burned 1.1s of CPU on 80KB of input.
 */
describe("adversarial markup", () => {
  it("ignores a <td> commented out INSIDE a price table", async () => {
    const injected = fixture.replace(
      "<td>100-149</td>",
      "<!-- <td>1-1</td><td>$0.01</td> --><td>100-149</td>",
    );
    const listings = await parseListingsPage(injected);
    const total = listings.reduce((n, l) => n + l.tiers.length, 0);
    expect(total).toBe(EXPECTED_TOTAL);
    const cheapest = Math.min(
      ...listings.flatMap((l) => l.tiers.map((t) => t.price_per_gallon)),
    );
    expect(cheapest).toBe(4.84);
  });

  it("ignores a whole price table that is commented out", async () => {
    const fake =
      '<!-- <form action="tranction.php"><input name="dealerid" value="1"/>' +
      '<table class="paywithcash"><tr><td>1-9</td><td>$0.01</td></tr></table></form> -->';
    const listings = await parseListingsPage(fake + fixture);
    expect(listings.length).toBe(5);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(EXPECTED_TOTAL);
  });

  it("ignores <td> inside a <script> block", async () => {
    const injected = fixture.replace(
      "<td>100-149</td>",
      '<script>var x = "<td>1-1</td><td>$0.01</td>";</script><td>100-149</td>',
    );
    const listings = await parseListingsPage(injected);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(EXPECTED_TOTAL);
  });

  it("handles uppercase tags", async () => {
    const injected = fixture.replace(/<table class="paywithcash"/g, '<TABLE CLASS="paywithcash"');
    const listings = await parseListingsPage(injected);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(EXPECTED_TOTAL);
  });

  it("handles an unquoted class attribute", async () => {
    const injected = fixture.replace('class="paywithcash"', "class=paywithcash");
    const listings = await parseListingsPage(injected);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(EXPECTED_TOTAL);
  });

  it("drops a table with an unclosed <td> whole, rather than truncating it", async () => {
    const injected = fixture.replace("<td>200-299</td>", "<td>200-299");
    const listings = await parseListingsPage(injected);
    const dealer11 = listings.find((l) => l.dealer_id === 11)!;
    // No partial cash table survives; the untouched credit side does.
    expect(tiersOf(dealer11, "cash")).toEqual([]);
    expect(tiersOf(dealer11, "credit")).toEqual(GROUND_TRUTH[0]!.credit);
    expect(listings.length).toBe(5);
  });

  it("drops a price table containing a nested table, keeping the page", async () => {
    const injected = fixture.replace(
      "<td>100-149</td>",
      "<td><table><tr><td>x</td></tr></table></td>",
    );
    const listings = await parseListingsPage(injected);
    expect(tiersOf(listings.find((l) => l.dealer_id === 11)!, "cash")).toEqual([]);
    expect(listings.length).toBe(5);
  });

  it("never files one dealer's prices under another when a dealerid drifts", async () => {
    // Break dealer 372's first form only. Its listing must be skipped — and,
    // crucially, no later dealer may inherit a shifted set of prices.
    let seen = 0;
    const injected = fixture.replace(/value="372"/g, (m) => {
      seen++;
      return seen === 1 ? 'value="99999"' : m;
    });
    expect(seen).toBeGreaterThan(0);
    const listings = await parseListingsPage(injected);
    expect(listings.map((l) => l.dealer_id)).toEqual([11, 744, 345, 919]);
    for (const expected of GROUND_TRUTH.filter((d) => d.dealer_id !== 372)) {
      const listing = listings.find((l) => l.dealer_id === expected.dealer_id)!;
      expect(tiersOf(listing, "cash")).toEqual(expected.cash);
      expect(tiersOf(listing, "credit")).toEqual(expected.credit);
    }
  });

  it("scans pathological input in linear time", () => {
    // The previous regex took 1105ms on 80KB of `<table ` prefixes; the 2MB
    // input cap bounds bytes, not backtracking, so this was a real way to burn
    // the whole CPU budget before any alert could be sent.
    const evil = "<table ".repeat((320 * 1024) / 7);
    const started = performance.now();
    extractPriceTables(evil);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

// ------------------------------------------------- a second, real capture

/**
 * A live capture from 2026-09-07, two days after the fixture of record.
 *
 * Its shape genuinely differs — SIX dealers instead of five, a dealer id that
 * did not exist before (1039), and 47 price points instead of 39 — so it proves
 * the parser is not overfitted to one page. It also pins the behaviour that
 * production actually exhibited: the deployed Worker wrote exactly these 47
 * rows on the same day.
 *
 * Not a substitute for the fixture of record: that one is the frozen contract
 * with known-good values from the PRD. This one is evidence the contract
 * survives real markup drift.
 */
describe("second real capture (2026-09-07)", () => {
  it("parses a six-dealer page into 47 price points", async () => {
    const listings = await parseListingsPage(liveFixture);
    expect(listings.length).toBe(6);
    expect(listings.map((l) => l.dealer_id)).toEqual([1039, 744, 11, 372, 345, 919]);
    expect(listings.reduce((n, l) => n + l.tiers.length, 0)).toBe(47);
  });

  it("reads that day's metadata, and reports it as fresh", async () => {
    const listings = await parseListingsPage(liveFixture);
    for (const l of listings) {
      expect(l.price_updated_on).toBe("2026-09-07");
      expect(l.same_day_charge).toBe(0);
    }
  });

  it("produces only well-formed rows", async () => {
    const listings = await parseListingsPage(liveFixture);
    const rows = toPriceRows(listings, "06483", "2026-09-07", "2026-09-07T14:00:00.000Z");
    expect(rows.length).toBe(47);
    for (const r of rows) {
      expect(r.price_per_gallon).toBeGreaterThan(0);
      expect(r.gallon_min).toBeGreaterThan(0);
      expect(r.gallon_max === null || r.gallon_max >= r.gallon_min).toBe(true);
      expect(["cash", "credit"]).toContain(r.payment_type);
    }
    expect(Math.min(...rows.map((r) => r.price_per_gallon))).toBe(4.8);
  });
});
