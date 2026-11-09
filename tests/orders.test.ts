import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdmin } from "../src/services/events.ts";
import { sweepExpired } from "../src/services/inventory.ts";
import { feed } from "../src/services/journal.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { buyer, freshDb, makeEvent, MIN, T0 } from "./helpers.ts";

const proof = () => new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], "p.png");
const remaining = (eventId: string, i = 0) => getAdmin(eventId)!.waves[i]!.remaining;

afterEach(() => flushMail());
beforeEach(() => {
  freshDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("reserve", () => {
  it("holds tickets and refuses to oversell", () => {
    const { eventId, slug, waveIds } = makeEvent([{ capacity: 3 }]);
    orders.reserve(slug, buyer(waveIds[0]!, 2), T0);
    expect(remaining(eventId)).toBe(1);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!, 2), T0)).toThrow(/Only 1 left/);
    orders.reserve(slug, buyer(waveIds[0]!, 1), T0);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!, 1), T0)).toThrow(/sold out/);
  });

  it("frees an unpaid hold the moment it expires, with no cleanup step", () => {
    const { slug, waveIds } = makeEvent([{ capacity: 2 }]);
    const o = orders.reserve(slug, buyer(waveIds[0]!, 2), T0);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!), T0 + 29 * MIN)).toThrow(/sold out/);
    // 30 minutes later the same wave sells again, before any sweep ran.
    orders.reserve(slug, buyer(waveIds[0]!), o.expiresAt!);
  });

  it("rejects closed waves and over-limit quantities", () => {
    const { slug, waveIds } = makeEvent([{ capacity: 10, open: false }]);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!), T0)).toThrow(/not on sale/);
    const e2 = makeEvent([{ capacity: 10 }]);
    expect(() => orders.reserve(e2.slug, buyer(e2.waveIds[0]!, 7), T0)).toThrow(/up to 6/);
  });
});

describe("auto waves", () => {
  it("opens the next AUTO wave when the previous sells out, and closes it again if a hold expires", () => {
    const { eventId, slug, waveIds } = makeEvent([{ capacity: 1 }, { capacity: 5, mode: "AUTO", open: false }]);
    expect(getAdmin(eventId)!.waves[1]!.state).toBe("UPCOMING");
    orders.reserve(slug, buyer(waveIds[0]!), T0); // takes the only Wave 1 ticket until T0+30m
    expect(() => orders.reserve(slug, buyer(waveIds[1]!), T0 + MIN)).not.toThrow();
    expect(() => orders.reserve(slug, buyer(waveIds[1]!), T0 + 31 * MIN)).toThrow(/not on sale/);
  });
});

describe("scheduled waves", () => {
  it("sells only between opensAt and closesAt", () => {
    const { slug, waveIds } = makeEvent([{ capacity: 10, mode: "SCHEDULED", opensAt: T0 + 60 * MIN, closesAt: T0 + 120 * MIN }]);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!), T0)).toThrow(/not on sale yet/);
    orders.reserve(slug, buyer(waveIds[0]!), T0 + 60 * MIN);
    expect(() => orders.reserve(slug, buyer(waveIds[0]!), T0 + 120 * MIN)).toThrow(/not on sale/);
  });
});

describe("payment lifecycle", () => {
  it("proof -> approve issues tickets once, even when approved twice", async () => {
    const { slug, waveIds } = makeEvent([{ capacity: 5 }]);
    const o = orders.reserve(slug, buyer(waveIds[0]!, 2), T0);
    await orders.submitProof(o.accessToken, null, "WH-123", T0 + 5 * MIN);
    expect(orders.approve(o.id, "admin-1", T0 + 10 * MIN)).toEqual({ alreadyApproved: false });
    expect(orders.approve(o.id, "admin-1", T0 + 11 * MIN)).toEqual({ alreadyApproved: true });
    const got = orders.getById(o.id)!;
    expect(got.status).toBe("APPROVED");
    expect(got.tickets).toHaveLength(2);
    // Emails are queued inside the transaction and sent after commit.
    expect(got.timeline.map((r) => r.action)).toEqual([
      "ORDER_CREATED",
      "EMAIL_QUEUED",
      "PROOF_SUBMITTED",
      "ORDER_APPROVED",
      "TICKET_ISSUED",
      "TICKET_ISSUED",
      "EMAIL_QUEUED",
    ]);
  });

  it("a submitted proof freezes the hold past its expiry", async () => {
    const { eventId, slug, waveIds } = makeEvent([{ capacity: 2 }]);
    const o = orders.reserve(slug, buyer(waveIds[0]!, 2), T0);
    await orders.submitProof(o.accessToken, proof(), undefined, T0 + 29 * MIN);
    sweepExpired(T0 + 60 * MIN);
    expect(orders.getById(o.id)!.order.status).toBe("PENDING_VERIFICATION");
    expect(() => orders.reserve(slug, buyer(waveIds[0]!), T0 + 60 * MIN)).toThrow(/sold out/);
    expect(eventId).toBeTruthy();
  });

  it("refuses proof after expiry and the sweep records the expiry at the real time", async () => {
    const { slug, waveIds } = makeEvent([{ capacity: 2 }]);
    const o = orders.reserve(slug, buyer(waveIds[0]!), T0);
    await expect(orders.submitProof(o.accessToken, null, "WH-1", T0 + 31 * MIN)).rejects.toThrow(/expired/);
    expect(sweepExpired(T0 + 45 * MIN)).toBe(1);
    const row = feed({ action: "ORDER_EXPIRED" })[0]!;
    expect(row.at).toBe(o.expiresAt);
    expect(row.actor).toBe("system");
  });

  it("reject frees stock and requires a reason", async () => {
    const { eventId, slug, waveIds } = makeEvent([{ capacity: 1 }]);
    const o = orders.reserve(slug, buyer(waveIds[0]!), T0);
    await orders.submitProof(o.accessToken, null, "WH-9", T0 + MIN);
    expect(() => orders.reject(o.id, "admin-1", " ")).toThrow(/reason/);
    orders.reject(o.id, "admin-1", "Amount didn't match", T0 + 2 * MIN);
    expect(remaining(eventId)).toBe(1);
    expect(() => orders.approve(o.id, "admin-1")).toThrow(/REJECTED/);
  });

  it("comps issue tickets without using wave stock", () => {
    const { eventId } = makeEvent([{ capacity: 1 }]);
    const o = orders.createComp({ eventId, attendeeName: "DJ Guest", email: "g@x.test", phone: "", quantity: 2 }, "admin-1");
    expect(orders.getById(o.id)!.tickets).toHaveLength(2);
    expect(remaining(eventId)).toBe(1);
  });
});
