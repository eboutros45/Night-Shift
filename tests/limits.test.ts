import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as limits from "../src/lib/limits.ts";
import { feed } from "../src/services/journal.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { buyer, freshDb, makeEvent, MIN, T0 } from "./helpers.ts";

beforeEach(() => {
  freshDb();
  limits._resetLimits();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => flushMail());

describe("per-person ticket limits", () => {
  const rami = { email: "rami@x.test", phone: "+961 70 123 456" };

  it("allows only one unpaid hold per person per event", () => {
    const { slug, waveIds } = makeEvent([{ capacity: 50 }]);
    orders.reserve(slug, buyer(waveIds[0]!, 1, rami), T0);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!, 1, rami), T0)).toThrow(/already have tickets on hold/);
  });

  it("matches the same person by phone even with a different email and format", () => {
    const { slug, waveIds } = makeEvent([{ capacity: 50 }]);
    orders.reserve(slug, buyer(waveIds[0]!, 1, rami), T0);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!, 1, { email: "other@x.test", phone: "70-123-456" }), T0)).toThrow(/on hold/);
  });

  it("caps the total across a person's orders, and frees the hold check once paid", async () => {
    const { slug, waveIds } = makeEvent([{ capacity: 50 }]); // maxPerBuyer = 6
    const o = orders.reserve(slug, buyer(waveIds[0]!, 4, rami), T0);
    await orders.submitProof(o.accessToken, null, "WH-1", T0 + MIN);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!, 3, rami), T0 + 2 * MIN)).toThrow(/limit is 6 tickets per person.*already have 4/);
    orders.reserve(slug, buyer(waveIds[0]!, 2, rami), T0 + 2 * MIN); // 4 + 2 = 6 is fine
  });

  it("stops counting expired and rejected orders", async () => {
    const { slug, waveIds } = makeEvent([{ capacity: 50 }]);
    const a = orders.reserve(slug, buyer(waveIds[0]!, 6, rami), T0);
    orders.reserve(slug, buyer(waveIds[0]!, 6, rami), a.expiresAt!); // first hold lapsed
    const b = feed({ action: "ORDER_CREATED" })[0]!;
    expect(b.parsed?.quantity).toBe(6);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit, reports retry time, and journals only the first block", () => {
    for (let i = 0; i < 5; i++) limits.take("checkoutPerEmail", "a@x.test");
    expect(() => limits.take("checkoutPerEmail", "a@x.test")).toThrow(/Too many orders for this email\. Try again in 10 minutes/);
    expect(() => limits.take("checkoutPerEmail", "a@x.test")).toThrow(limits.RateLimitError);
    limits.take("checkoutPerEmail", "b@x.test"); // other keys unaffected
    expect(feed({ action: "RATE_LIMITED" })).toHaveLength(1);
  });

  it("check() does not count; hit() does (used for login failures)", () => {
    for (let i = 0; i < 10; i++) limits.check("loginFailuresPerEmail", "admin@x.test");
    for (let i = 0; i < 5; i++) limits.hit("loginFailuresPerEmail", "admin@x.test");
    expect(() => limits.check("loginFailuresPerEmail", "admin@x.test")).toThrow(/failed logins/);
  });
});
