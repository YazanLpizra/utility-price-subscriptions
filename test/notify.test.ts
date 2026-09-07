/**
 * Phase 5 — evaluation, staleness and notification-transport tests.
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

import { describe, expect, it, vi } from "vitest";
import {
  buildNotification,
  evaluateSubscription,
  isStale,
  notificationFingerprint,
  selectBestPrice,
  sendAlert,
  sendNotification,
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
    destination: "heating-oil-local-dev",
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
  ALERT_DESTINATION: "5838650961",
  STALE_AFTER_DAYS: "3",
  TELEGRAM_BOT_TOKEN: "123:ABC",
  TELEGRAM_API_BASE: "https://api.telegram.org",
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


describe("sendAlert", () => {
  it("posts alerts to ALERT_DESTINATION", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await sendAlert(env, "parse failed", "details here", impl)).toBe(true);
    expect(calls[0]!.url).toContain("/sendMessage");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.chat_id).toBe("5838650961");
    expect(body.text).toContain("parse failed");
    expect(body.text).toContain("details here");
  });

  it("never throws when the transport rejects", async () => {
    const impl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(sendAlert(env, "t", "b", impl)).resolves.toBe(false);
  });

  it("returns false rather than throwing when the alert destination is malformed", async () => {
    const { impl, calls } = stubFetch(() => new Response("ok", { status: 200 }));
    const broken: Env = { ...env, ALERT_DESTINATION: "not a chat id" };
    expect(await sendAlert(broken, "t", "b", impl)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});


// --------------------------------------------------------------- telegram

describe("telegram transport", () => {
  const msg = { title: "T", body: "B", tags: ["fuelpump"], priority: 3 };
  const tg: Env = {
    ...env,
      TELEGRAM_BOT_TOKEN: "123:ABC",
    TELEGRAM_API_BASE: "https://api.telegram.org",
  };

  it("posts sendMessage with the chat id and a combined title/body", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect(await sendNotification(tg, "5838650961", msg, impl)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.chat_id).toBe("5838650961");
    expect(body.text).toContain("T");
    expect(body.text).toContain("B");
  });

  it("sends no parse_mode, so $ and . in prices cannot break formatting", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    await sendNotification(tg, "5838650961", { ...msg, body: "$4.81 per gallon (cash)" }, impl);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain("$4.81");
  });

  it("accepts a negative chat id (groups and channels)", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect(await sendNotification(tg, "-1001234567890", msg, impl)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  describe("refuses a malformed chat id without issuing a request", () => {
    for (const bad of ["", "abc", "58386 50961", "12;34", "../admin", "1e5"]) {
      it(JSON.stringify(bad), async () => {
        const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
        expect(await sendNotification(tg, bad, msg, impl)).toBe(false);
        expect(calls).toHaveLength(0);
      });
    }
  });

  it("returns false, without sending, when no bot token is configured", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const noToken: Env = { ...tg, TELEGRAM_BOT_TOKEN: undefined };
    expect(await sendNotification(noToken, "5838650961", msg, impl)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("trims a bot token stored with a trailing newline", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const padded: Env = { ...tg, TELEGRAM_BOT_TOKEN: "123:ABC\r\n" };
    expect(await sendNotification(padded, "5838650961", msg, impl)).toBe(true);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
  });

  it("returns false on a 400 and never throws", async () => {
    const { impl } = stubFetch(() => new Response('{"ok":false}', { status: 400 }));
    await expect(sendNotification(tg, "5838650961", msg, impl)).resolves.toBe(false);
  });

  it("returns false when the transport rejects outright", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(sendNotification(tg, "5838650961", msg, impl)).resolves.toBe(false);
  });

  it("routes alerts through Telegram too, not just subscriber pushes", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const alerting: Env = { ...tg, ALERT_DESTINATION: "5838650961" };
    expect(await sendAlert(alerting, "parse failed", "details", impl)).toBe(true);
    expect(calls[0]!.url).toContain("/sendMessage");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.text).toContain("parse failed");
  });

  it("routes every message through Telegram", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect(await sendNotification(tg, "5838650961", msg, impl)).toBe(true);
    expect(calls[0]!.url).toContain("/sendMessage");
  });
});

// ------------------------------------------------- transport hardening

describe("transport hardening", () => {
  const msg = { title: "T", body: "B", tags: [], priority: 3 };
  const tgEnv: Env = { ...env, TELEGRAM_BOT_TOKEN: "123:SECRETTOKEN" };

  it("never logs the bot token, even when the transport throws with the URL in it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const impl = (async () => {
      throw new Error(
        "fetch failed for https://api.telegram.org/bot123:SECRETTOKEN/sendMessage",
      );
    }) as unknown as typeof fetch;
    await expect(sendNotification(tgEnv, "5838650961", msg, impl)).resolves.toBe(false);
    const logged = errors.mock.calls.flat().join("\n");
    expect(logged).not.toContain("SECRETTOKEN");
    expect(logged).toContain("[telegram]");
    errors.mockRestore();
  });

  it("never logs the bot token when the API rejects the send", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { impl } = stubFetch(() => new Response('{"ok":false}', { status: 400 }));
    await sendNotification(tgEnv, "5838650961", msg, impl);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("SECRETTOKEN");
    errors.mockRestore();
  });

  it("truncates text over Telegram's 4096-character limit", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const huge = { ...msg, body: "x".repeat(9000) };
    expect(await sendNotification(tgEnv, "5838650961", huge, impl)).toBe(true);
    const text = JSON.parse(String(calls[0]!.init?.body)).text as string;
    expect(Array.from(text).length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("[truncated]")).toBe(true);
  });

  it("does not split a surrogate pair when truncating", async () => {
    const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const huge = { ...msg, body: "🔥".repeat(5000) };
    await sendNotification(tgEnv, "5838650961", huge, impl);
    const text = JSON.parse(String(calls[0]!.init?.body)).text as string;
    expect(text).not.toContain("\uFFFD");
    expect(/[\uD800-\uDBFF]$/.test(text.replace("[truncated]", ""))).toBe(false);
  });

  describe("rejects chat ids Telegram itself would reject", () => {
    for (const bad of ["0", "-0", "00", "99999999999999999999", "007"]) {
      it(JSON.stringify(bad), async () => {
        const { impl, calls } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
        expect(await sendNotification(tgEnv, bad, msg, impl)).toBe(false);
        expect(calls).toHaveLength(0);
      });
    }
  });

  it("still accepts a real chat id and a negative group id", async () => {
    const { impl } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect(await sendNotification(tgEnv, "5838650961", msg, impl)).toBe(true);
    expect(await sendNotification(tgEnv, "-1001234567890", msg, impl)).toBe(true);
  });
});
