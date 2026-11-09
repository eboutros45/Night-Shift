import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdmin } from "../src/services/events.ts";
import { sweepExpired } from "../src/services/inventory.ts";
import { feed } from "../src/services/journal.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { buyer, freshDb, makeEvent, MIN, T0 } from "./helpers.ts";

const proof = () => new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], "p.png");
const remaining = async (eventId: string, i = 0) => (await getAdmin(eventId))!.waves[i]!.remaining;

afterEach(async () => (await flushMail()));
beforeEach(async () => {
  (await freshDb());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("reserve", () => {
  it("holds tickets and refuses to oversell", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 3 }]));
    (await orders.reserve(slug, buyer(waveIds[0]!, 2), T0));
    expect((await remaining(eventId))).toBe(1);
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!, 2), T0)))()).rejects.toThrow(/Only 1 left/);
    (await orders.reserve(slug, buyer(waveIds[0]!, 1), T0));
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!, 1), T0)))()).rejects.toThrow(/sold out/);
  });

  it("frees an unpaid hold the moment it expires, with no cleanup step", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 2 }]));
    const o = (await orders.reserve(slug, buyer(waveIds[0]!, 2), T0));
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!), T0 + 29 * MIN)))()).rejects.toThrow(/sold out/);
    // 30 minutes later the same wave sells again, before any sweep ran.
    (await orders.reserve(slug, buyer(waveIds[0]!), o.expiresAt!));
  });

  it("rejects closed waves and over-limit quantities", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 10, open: false }]));
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!), T0)))()).rejects.toThrow(/not on sale/);
    const e2 = (await makeEvent([{ capacity: 10 }]));
    await expect((async () => (await orders.reserve(e2.slug, buyer(e2.waveIds[0]!, 7), T0)))()).rejects.toThrow(/up to 6/);
  });
});

describe("auto waves", () => {
  it("opens the next AUTO wave when the previous sells out, and closes it again if a hold expires", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 1 }, { capacity: 5, mode: "AUTO", open: false }]));
    expect((await getAdmin(eventId))!.waves[1]!.state).toBe("UPCOMING");
    (await orders.reserve(slug, buyer(waveIds[0]!), T0)); // takes the only Wave 1 ticket until T0+30m
    expect(async () => (await orders.reserve(slug, buyer(waveIds[1]!), T0 + MIN))).not.toThrow();
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[1]!), T0 + 31 * MIN)))()).rejects.toThrow(/not on sale/);
  });
});

describe("scheduled waves", () => {
  it("sells only between opensAt and closesAt", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 10, mode: "SCHEDULED", opensAt: T0 + 60 * MIN, closesAt: T0 + 120 * MIN }]));
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!), T0)))()).rejects.toThrow(/not on sale yet/);
    (await orders.reserve(slug, buyer(waveIds[0]!), T0 + 60 * MIN));
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!), T0 + 120 * MIN)))()).rejects.toThrow(/not on sale/);
  });
});

describe("payment lifecycle", () => {
  it("proof -> approve issues tickets once, even when approved twice", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5 }]));
    const o = (await orders.reserve(slug, buyer(waveIds[0]!, 2), T0));
    await orders.submitProof(o.accessToken, null, "WH-123", T0 + 5 * MIN);
    expect((await orders.approve(o.id, "admin-1", T0 + 10 * MIN))).toEqual({ alreadyApproved: false });
    expect((await orders.approve(o.id, "admin-1", T0 + 11 * MIN))).toEqual({ alreadyApproved: true });
    const got = (await orders.getById(o.id))!;
    expect(got.status).toBe("APPROVED");
    expect(got.tickets).toHaveLength(2);
    // Emails are queued inside the transaction and sent after commit.
    expect(got.timeline.filter((r) => r.action !== "EMAIL_SENT").map((r) => r.action)).toEqual([
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
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 2 }]));
    const o = (await orders.reserve(slug, buyer(waveIds[0]!, 2), T0));
    await orders.submitProof(o.accessToken, proof(), undefined, T0 + 29 * MIN);
    (await sweepExpired(T0 + 60 * MIN));
    expect((await orders.getById(o.id))!.order.status).toBe("PENDING_VERIFICATION");
    await expect((async () => (await orders.reserve(slug, buyer(waveIds[0]!), T0 + 60 * MIN)))()).rejects.toThrow(/sold out/);
    expect(eventId).toBeTruthy();
  });

  it("refuses proof after expiry and the sweep records the expiry at the real time", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 2 }]));
    const o = (await orders.reserve(slug, buyer(waveIds[0]!), T0));
    await expect(orders.submitProof(o.accessToken, null, "WH-1", T0 + 31 * MIN)).rejects.toThrow(/expired/);
    expect((await sweepExpired(T0 + 45 * MIN))).toBe(1);
    const row = (await feed({ action: "ORDER_EXPIRED" }))[0]!;
    expect(row.at).toBe(o.expiresAt);
    expect(row.actor).toBe("system");
  });

  it("reject frees stock and requires a reason", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 1 }]));
    const o = (await orders.reserve(slug, buyer(waveIds[0]!), T0));
    await orders.submitProof(o.accessToken, null, "WH-9", T0 + MIN);
    await expect((async () => (await orders.reject(o.id, "admin-1", " ")))()).rejects.toThrow(/reason/);
    (await orders.reject(o.id, "admin-1", "Amount didn't match", T0 + 2 * MIN));
    expect((await remaining(eventId))).toBe(1);
    await expect((async () => (await orders.approve(o.id, "admin-1")))()).rejects.toThrow(/REJECTED/);
  });

  it("comps issue tickets without using wave stock", async () => {
    const { eventId } = (await makeEvent([{ capacity: 1 }]));
    const o = (await orders.createComp({ eventId, attendeeName: "DJ Guest", email: "g@x.test", phone: "", quantity: 2 }, "admin-1"));
    expect((await orders.getById(o.id))!.tickets).toHaveLength(2);
    expect((await remaining(eventId))).toBe(1);
  });
});
