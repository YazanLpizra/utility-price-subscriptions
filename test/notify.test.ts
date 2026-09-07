/**
 * Phase 5 — evaluation, staleness and ntfy tests.
 *
 * Listings are built BY HAND from implementation-plan §1.3; this phase must not
 * depend on Phase 2's parser. No test touches the network: every transport test
 * injects `fetchImpl`.
 *
 * The case this whole phase exists for (PRD §5.3): on the fixture day the
 * cheapest 06483 cash price is $4.84, but only at 100+ gallons. A subscriber
 * who wants 50 gallons actually faces $5.64. Telling them "$4.84" would be
 * actively misleading.
 */

import { describe, expect, it } from "vitest";
import {
  buildNotification,
  evaluateSubscription,
  isStale,
  notificationFingerprint,
  selectBestPrice,
  sendAlert,
  sendNtfy,
} from "../src/notify";
import type {
  Env,
  NotificationDecision,
  ParsedListing,
  PaymentType,
  PriceTier,
  Subscription,
} from "../src/types";

// --------------------------------------------------------------- fixtures

function tier(
  payment_type: PaymentType,
  gallon_min: number,
  gallon_max: number | null,
  price_per_gallon: number,
): PriceTier {
  return { payment_type, gallon_min, gallon_max, price_per_gallon };
}

/** plan §1.3, by hand. */
function listings(): ParsedListing[] {
  const base = {
    price_updated_on: "2026-09-05",
    same_day_charge: 0,
  };
  return [
    {
      ...base,
      dealer_id: 11,
      delivery_date: "2026-09-08",
      tiers: [
        tier("cash", 100, 149, 4.84),
        tier("cash", 150, 199, 4.84),
        tier("cash", 200, 299, 4.84),
        tier("cash", 300, 399, 4.84),
        tier("credit", 100, 149, 4.94),
        tier("credit", 150, 199, 4.94),
        tier("credit", 200, 299, 4.94),
        tier("credit", 300, 399, 4.94),
      ],
    },
    {
      ...base,
      dealer_id: 372,
      delivery_date: "2026-09-09",
      tiers: [
        tier("cash", 50, 99, 5.64),
        tier("cash", 100, 149, 4.84),
        tier("cash", 150, 199, 4.84),
        tier("cash", 200, 299, 4.84),
        tier("cash", 300, 399, 4.84),
        tier("credit", 50, 99, 5.74),
        tier("credit", 100, 149, 4.94),
        tier("credit", 150, 199, 4.94),
        tier("credit", 200, 299, 4.94),
        tier("credit", 300, 399, 4.94),
      ],
    },
    {
      ...base,
      dealer_id: 744,
      delivery_date: "2026-09-07",
      tiers: [
        tier("cash", 50, 99, 6.0),
        tier("cash", 100, 149, 4.84),
        tier("cash", 150, 199, 4.84),
        tier("cash", 200, 299, 4.84),
        tier("cash", 300, 399, 4.84),
        // no credit 50-99 tier
        tier("credit", 100, 149, 4.94),
        tier("credit", 150, 199, 4.94),
        tier("credit", 200, 299, 4.94),
        tier("credit", 300, 399, 4.94),
      ],
    },
    {
      ...base,
      dealer_id: 345,
      delivery_date: "2026-09-09",
      tiers: [
        tier("cash", 150, 199, 5.19),
        tier("cash", 200, 299, 5.19),
        tier("cash", 300, 399, 5.19),
        tier("credit", 150, 199, 5.19),
        tier("credit", 200, 299, 5.19),
        tier("credit", 300, 399, 5.19),
      ],
    },
    {
      ...base,
      dealer_id: 919,
      delivery_date: "2026-09-09",
      tiers: [
        tier("cash", 150, 199, 5.19),
        tier("cash", 200, 299, 5.19),
        tier("cash", 300, 399, 5.19),
        tier("credit", 150, 199, 5.19),
        tier("credit", 200, 299, 5.19),
        tier("credit", 300, 399, 5.19),
      ],
    },
  ];
}

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    user_id: "v1",
    zip: "06483",
    ntfy_topic: "heating-oil-local-dev",
    min_gallons: 100,
    payment_type: "cash",
    threshold: null,
    active: 1,
    ...over,
  };
}

const env: Env = {
  DB: null as never,
  SCRAPE_QUEUE: null as never,
  SITE_BASE_URL: "https://www.cashheatingoil.com",
  NTFY_BASE_URL: "https://ntfy.sh",
  NTFY_ALERT_TOPIC: "alerts-topic",
  STALE_AFTER_DAYS: "3",
  USER_AGENT: "heating-oil-tracker/1.0 (test)",
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(responder: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await responder();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SCRAPE_DATE = "2026-09-06";

// --------------------------------------------------------------- selection

describe("selectBestPrice", () => {
  it("50 gallons cash -> $5.64 at dealer 372, NOT the headline $4.84", () => {
    const best = selectBestPrice(listings(), sub({ min_gallons: 50 }));
    expect(best).not.toBeNull();
    expect(best!.price_per_gallon).toBe(5.64);
    expect(best!.dealer_id).toBe(372);
    expect(best!.gallon_min).toBe(50);
    expect(best!.gallon_max).toBe(99);
    expect(best!.payment_type).toBe("cash");
  });

  it("100 gallons cash -> $4.84, tie broken to the lowest dealer id (11)", () => {
    const best = selectBestPrice(listings(), sub({ min_gallons: 100 }));
    expect(best!.price_per_gallon).toBe(4.84);
    expect(best!.dealer_id).toBe(11);
  });

  it("100 gallons credit -> $4.94 at dealer 11", () => {
    const best = selectBestPrice(
      listings(),
      sub({ min_gallons: 100, payment_type: "credit" }),
    );
    expect(best!.price_per_gallon).toBe(4.94);
    expect(best!.dealer_id).toBe(11);
  });

  it("50 gallons credit -> $5.74 at dealer 372; dealer 744 has no such tier", () => {
    const best = selectBestPrice(
      listings(),
      sub({ min_gallons: 50, payment_type: "credit" }),
    );
    expect(best!.price_per_gallon).toBe(5.74);
    expect(best!.dealer_id).toBe(372);
  });

  it("carries the winning listing's dates through", () => {
    const best = selectBestPrice(listings(), sub({ min_gallons: 50 }));
    expect(best!.delivery_date).toBe("2026-09-09"); // dealer 372
    expect(best!.price_updated_on).toBe("2026-09-05");
  });

  it("returns null when the order is larger than every tier", () => {
    expect(selectBestPrice(listings(), sub({ min_gallons: 500 }))).toBeNull();
  });

  it("returns null when the order is below every tier's minimum", () => {
    expect(selectBestPrice(listings(), sub({ min_gallons: 25 }))).toBeNull();
  });

  it("returns null for an empty listing set", () => {
    expect(selectBestPrice([], sub())).toBeNull();
  });

  it("matches an open-ended tier for a very large order", () => {
    const open: ParsedListing[] = [
      {
        dealer_id: 500,
        delivery_date: "2026-09-08",
        price_updated_on: "2026-09-05",
        same_day_charge: 0,
        tiers: [tier("cash", 400, null, 4.5)],
      },
    ];
    const best = selectBestPrice(open, sub({ min_gallons: 5000 }));
    expect(best!.price_per_gallon).toBe(4.5);
    expect(best!.gallon_max).toBeNull();
  });

  it("never selects the other payment type", () => {
    for (const payment of ["cash", "credit"] as const) {
      const best = selectBestPrice(listings(), sub({ payment_type: payment }));
      expect(best!.payment_type).toBe(payment);
    }
  });
});

// --------------------------------------------------------------- staleness

describe("isStale", () => {
  const withUpdated = (dates: Array<string | null>): ParsedListing[] =>
    dates.map((d, i) => ({
      dealer_id: i + 1,
      delivery_date: "2026-09-08",
      price_updated_on: d,
      same_day_charge: 0,
      tiers: [tier("cash", 100, 149, 4.84)],
    }));

  it("one day old with N=3 is not stale", () => {
    expect(isStale(withUpdated(["2026-09-05"]), SCRAPE_DATE, 3)).toBe(false);
  });

  it("exactly N days old is NOT stale (the boundary is strictly >)", () => {
    expect(isStale(withUpdated(["2026-09-03"]), SCRAPE_DATE, 3)).toBe(false);
  });

  it("N+1 days old IS stale", () => {
    expect(isStale(withUpdated(["2026-09-02"]), SCRAPE_DATE, 3)).toBe(true);
  });

  it("takes the maximum date across listings", () => {
    expect(
      isStale(withUpdated(["2026-08-01", "2026-09-05"]), SCRAPE_DATE, 3),
    ).toBe(false);
  });

  it("all-null price_updated_on is stale", () => {
    expect(isStale(withUpdated([null, null]), SCRAPE_DATE, 3)).toBe(true);
  });

  it("an empty listing set is stale", () => {
    expect(isStale([], SCRAPE_DATE, 3)).toBe(true);
  });

  it("a future price_updated_on is not stale", () => {
    expect(isStale(withUpdated(["2026-09-10"]), SCRAPE_DATE, 3)).toBe(false);
  });

  it("crosses a month boundary correctly", () => {
    expect(isStale(withUpdated(["2026-08-30"]), "2026-09-01", 3)).toBe(false);
    expect(isStale(withUpdated(["2026-08-28"]), "2026-09-01", 3)).toBe(true);
  });
});

// --------------------------------------------------------------- decisions

describe("evaluateSubscription", () => {
  it("sends when a tier qualifies and no threshold is set", () => {
    const d = evaluateSubscription(listings(), sub(), SCRAPE_DATE, 3);
    expect(d.reason).toBe("send");
    expect(d.should_send).toBe(true);
    expect(d.best!.price_per_gallon).toBe(4.84);
    expect(d.stale).toBe(false);
  });

  it("reports no_qualifying_tier, and does not send, when nothing fits", () => {
    const d = evaluateSubscription(
      listings(),
      sub({ min_gallons: 500 }),
      SCRAPE_DATE,
      3,
    );
    expect(d.reason).toBe("no_qualifying_tier");
    expect(d.should_send).toBe(false);
    expect(d.best).toBeNull();
  });

  it("sends when the price is below the threshold", () => {
    const d = evaluateSubscription(
      listings(),
      sub({ threshold: 5.0 }),
      SCRAPE_DATE,
      3,
    );
    expect(d.reason).toBe("send");
    expect(d.should_send).toBe(true);
  });

  it("suppresses when the price has not fallen below the threshold", () => {
    const d = evaluateSubscription(
      listings(),
      sub({ threshold: 4.5 }),
      SCRAPE_DATE,
      3,
    );
    expect(d.reason).toBe("threshold_not_met");
    expect(d.should_send).toBe(false);
    expect(d.best).not.toBeNull();
  });

  it("treats a price exactly equal to the threshold as not met", () => {
    const d = evaluateSubscription(
      listings(),
      sub({ threshold: 4.84 }),
      SCRAPE_DATE,
      3,
    );
    expect(d.reason).toBe("threshold_not_met");
  });

  it("populates `stale` on every branch, including the suppressed ones", () => {
    const old = listings().map((l) => ({ ...l, price_updated_on: "2026-08-01" }));
    for (const s of [sub(), sub({ threshold: 4.5 }), sub({ min_gallons: 500 })]) {
      expect(evaluateSubscription(old, s, SCRAPE_DATE, 3).stale).toBe(true);
    }
  });

  it("carries the subscription through unchanged", () => {
    const s = sub({ id: 42 });
    expect(evaluateSubscription(listings(), s, SCRAPE_DATE, 3).subscription).toBe(s);
  });
});

// --------------------------------------------------------------- messages

describe("buildNotification", () => {
  const decisionFor = (over: Partial<Subscription> = {}): NotificationDecision =>
    evaluateSubscription(listings(), sub(over), SCRAPE_DATE, 3);

  it("states the price, the tier it applies to, and every relevant date", () => {
    const msg = buildNotification(decisionFor(), "06483", SCRAPE_DATE);
    expect(msg.body).toContain("4.84");
    expect(msg.body).toContain("100");
    expect(msg.body).toContain("149");
    expect(msg.body).toContain("cash");
    expect(msg.body).toContain("2026-09-08"); // delivery
    expect(msg.body).toContain("2026-09-05"); // price updated on
    expect(msg.body).toContain(SCRAPE_DATE);
    expect(msg.body).toContain("06483");
  });

  it("quotes the 50-gallon price, not the headline one", () => {
    const msg = buildNotification(
      decisionFor({ min_gallons: 50 }),
      "06483",
      SCRAPE_DATE,
    );
    expect(msg.body).toContain("5.64");
    expect(msg.body).not.toContain("4.84");
  });

  it("is a normal-priority fuelpump message when the data is fresh", () => {
    const msg = buildNotification(decisionFor(), "06483", SCRAPE_DATE);
    expect(msg.priority).toBe(3);
    expect(msg.tags).toContain("fuelpump");
    expect(msg.tags).not.toContain("warning");
    expect(msg.title.startsWith("[STALE]")).toBe(false);
  });

  it("marks a stale reading in the title, the tags and the priority", () => {
    const old = listings().map((l) => ({ ...l, price_updated_on: "2026-08-01" }));
    const decision = evaluateSubscription(old, sub(), SCRAPE_DATE, 3);
    const msg = buildNotification(decision, "06483", SCRAPE_DATE);
    expect(decision.stale).toBe(true);
    expect(msg.title.startsWith("[STALE]")).toBe(true);
    expect(msg.tags).toContain("warning");
    expect(msg.priority).toBe(4);
    expect(msg.body).toContain("2026-08-01");
  });

  it("is deterministic", () => {
    const a = buildNotification(decisionFor(), "06483", SCRAPE_DATE);
    const b = buildNotification(decisionFor(), "06483", SCRAPE_DATE);
    expect(a).toEqual(b);
  });
});

describe("notificationFingerprint", () => {
  const decisionFor = (over: Partial<Subscription> = {}) =>
    evaluateSubscription(listings(), sub(over), SCRAPE_DATE, 3);

  it("is stable for an unchanged decision", () => {
    expect(notificationFingerprint(decisionFor())).toBe(
      notificationFingerprint(decisionFor()),
    );
  });

  it("differs when the selected price differs", () => {
    expect(notificationFingerprint(decisionFor())).not.toBe(
      notificationFingerprint(decisionFor({ min_gallons: 50 })),
    );
  });

  it("differs when staleness flips", () => {
    const old = listings().map((l) => ({ ...l, price_updated_on: "2026-08-01" }));
    expect(
      notificationFingerprint(evaluateSubscription(old, sub(), SCRAPE_DATE, 3)),
    ).not.toBe(notificationFingerprint(decisionFor()));
  });

  it("handles a null best without throwing", () => {
    expect(typeof notificationFingerprint(decisionFor({ min_gallons: 500 }))).toBe(
      "string",
    );
  });
});

// --------------------------------------------------------------- transport

describe("sendNtfy", () => {
  const msg = { title: "t", body: "b", tags: ["fuelpump"], priority: 3 };

  it("POSTs to the topic URL with the ntfy headers", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await sendNtfy(env, "my-topic", msg, impl)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.sh/my-topic");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Title"]).toBe("t");
    expect(headers["Priority"]).toBe("3");
    expect(headers["Tags"]).toBe("fuelpump");
    expect(calls[0]!.init?.body).toBe("b");
  });

  it("returns false on a 500 without throwing", async () => {
    const { impl } = stubFetch(() => new Response("no", { status: 500 }));
    expect(await sendNtfy(env, "my-topic", msg, impl)).toBe(false);
  });

  it("returns false when the transport rejects outright", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(sendNtfy(env, "my-topic", msg, impl)).resolves.toBe(false);
  });

  it("passes an abort signal so a stalled connection cannot hold the invocation", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    await sendNtfy(env, "my-topic", msg, impl);
    const signal = (calls[0]!.init as RequestInit).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("returns false — never throws — when the request is ABORTED by the timeout", async () => {
    // A queue invocation has a 15-minute ceiling; without a timeout a stalled
    // ntfy connection burns it. The abort must surface as a `false`, exactly
    // like any other transport failure, so no data that is already in D1 is
    // treated as lost.
    const impl = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(sendNtfy(env, "my-topic", msg, impl)).resolves.toBe(false);
  });

  it("sendAlert also returns false on an AbortError rather than throwing", async () => {
    const impl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(sendAlert(env, "t", "b", impl)).resolves.toBe(false);
  });

  describe("rejects a malformed topic without issuing a request", () => {
    const bad = ["", "../admin", "a/b", "topic with spaces", "a".repeat(65), "t;rm -rf"];
    for (const topic of bad) {
      it(JSON.stringify(topic), async () => {
        const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
        expect(await sendNtfy(env, topic, msg, impl)).toBe(false);
        expect(calls).toHaveLength(0);
      });
    }
  });

  it("accepts the allowed topic alphabet", async () => {
    const { impl } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await sendNtfy(env, "yazan-06483-oil", msg, impl)).toBe(true);
    expect(await sendNtfy(env, "A_b-9", msg, impl)).toBe(true);
  });
});

describe("sendAlert", () => {
  it("posts to NTFY_ALERT_TOPIC at priority 4 with a warning tag", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await sendAlert(env, "parse failed", "details here", impl)).toBe(true);
    expect(calls[0]!.url).toBe("https://ntfy.sh/alerts-topic");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Priority"]).toBe("4");
    expect(headers["Tags"]).toContain("warning");
    expect(headers["Title"]).toContain("parse failed");
    expect(calls[0]!.init?.body).toBe("details here");
  });

  it("never throws when the transport rejects", async () => {
    const impl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(sendAlert(env, "t", "b", impl)).resolves.toBe(false);
  });

  it("returns false rather than throwing when the alert topic is malformed", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const broken: Env = { ...env, NTFY_ALERT_TOPIC: "not a topic" };
    expect(await sendAlert(broken, "t", "b", impl)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------- ntfy auth

describe("ntfy authentication", () => {
  const msg = { title: "t", body: "b", tags: ["fuelpump"], priority: 3 };

  it("sends no Authorization header when no token is configured", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await sendNtfy(env, "my-topic", msg, impl)).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends a Bearer token when NTFY_TOKEN is set", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const authed: Env = { ...env, NTFY_TOKEN: "tk_example" };
    expect(await sendNtfy(authed, "my-topic", msg, impl)).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tk_example");
  });

  it("authenticates alerts too, not just subscriber pushes", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const authed: Env = { ...env, NTFY_TOKEN: "tk_example" };
    expect(await sendAlert(authed, "t", "b", impl)).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tk_example");
  });

  it("never puts the token in the URL, where it could be logged", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const authed: Env = { ...env, NTFY_TOKEN: "tk_example" };
    await sendNtfy(authed, "my-topic", msg, impl);
    expect(calls[0]!.url).toBe("https://ntfy.sh/my-topic");
    expect(calls[0]!.url).not.toContain("tk_example");
  });

  it("still returns false, without throwing, when an authenticated push is rejected", async () => {
    const { impl } = stubFetch(() => new Response("denied", { status: 401 }));
    const authed: Env = { ...env, NTFY_TOKEN: "tk_example" };
    expect(await sendNtfy(authed, "my-topic", msg, impl)).toBe(false);
  });

  it("trims a token stored with a trailing newline by `wrangler secret put`", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const authed: Env = { ...env, NTFY_TOKEN: "tk_example\r\n" };
    expect(await sendNtfy(authed, "my-topic", msg, impl)).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tk_example");
  });

  it("treats a whitespace-only token as absent", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const authed: Env = { ...env, NTFY_TOKEN: "   " };
    expect(await sendNtfy(authed, "my-topic", msg, impl)).toBe(true);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
