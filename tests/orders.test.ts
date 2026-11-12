import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.ts";
import { tickets } from "../src/db/schema.ts";
import { getAdmin } from "../src/services/events.ts";
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

describe("confirming attendance", () => {
  it("issues working, unpaid tickets straight away and emails them", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    expect(o.status).toBe("CONFIRMED");
    const got = (await orders.getById(o.id))!;
    expect(got.tickets.map((t) => [t.status, t.paidAt, t.priceCents])).toEqual([["VALID", null, 2000], ["VALID", null, 2000]]);
    expect(got.dueCents).toBe(4000);
    const queued = (await feed({ action: "EMAIL_QUEUED" })).map((r) => r.parsed?.template);
    expect(queued).toEqual(["tickets_issued"]);
  });

  it("takes spots from the tier and refuses to overbook", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 3 }]));
    (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    expect((await remaining(eventId))).toBe(1);
    await expect(orders.confirm(slug, buyer(waveIds[0]!, 2), T0)).rejects.toThrow(/Only 1 left/);
    (await orders.confirm(slug, buyer(waveIds[0]!, 1), T0));
    await expect(orders.confirm(slug, buyer(waveIds[0]!, 1), T0)).rejects.toThrow(/fully booked/);
    // Unpaid tickets keep their spot: nothing frees up with time.
    await expect(orders.confirm(slug, buyer(waveIds[0]!, 1), T0 + 24 * 60 * MIN)).rejects.toThrow(/fully booked/);
  });

  it("a double tap on Confirm gives the same order, not a second one", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 10 }]));
    const who = buyer(waveIds[0]!, 2);
    const first = (await orders.confirm(slug, who, T0));
    const again = (await orders.confirm(slug, who, T0 + 5_000));
    expect(again.id).toBe(first.id);
    expect((await remaining(eventId))).toBe(8);
    const later = (await orders.confirm(slug, who, T0 + 61_000));
    expect(later.id).not.toBe(first.id);
  });

  it("a free tier has nothing to pay", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5, price: 0 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    const got = (await orders.getById(o.id))!;
    expect(got.tickets.map((t) => [t.paidVia, t.paidAt])).toEqual([["COMP", T0], ["COMP", T0]]);
    expect(got.dueCents).toBe(0);
    await expect(orders.submitProof(o.accessToken, proof(), "WHISH", T0 + MIN)).rejects.toThrow(/already paid/);
  });

  it("rejects closed tiers and over-limit quantities", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 10, open: false }]));
    await expect(orders.confirm(slug, buyer(waveIds[0]!), T0)).rejects.toThrow(/not available yet/);
    const e2 = (await makeEvent([{ capacity: 10 }]));
    await expect(orders.confirm(e2.slug, buyer(e2.waveIds[0]!, 7), T0)).rejects.toThrow(/up to 6/);
  });
});

describe("auto waves", () => {
  it("opens the next AUTO wave when the previous is fully booked, and closes it again if spots are freed", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 1 }, { capacity: 5, mode: "AUTO", open: false }]));
    expect((await getAdmin(eventId))!.waves[1]!.state).toBe("UPCOMING");
    const first = (await orders.confirm(slug, buyer(waveIds[0]!), T0));
    (await orders.confirm(slug, buyer(waveIds[1]!), T0 + MIN));
    (await orders.cancel(first.id, "admin-1", "no-show", T0 + 2 * MIN));
    await expect(orders.confirm(slug, buyer(waveIds[1]!), T0 + 3 * MIN)).rejects.toThrow(/not available yet/);
  });
});

describe("scheduled waves", () => {
  it("are available only between opensAt and closesAt", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 10, mode: "SCHEDULED", opensAt: T0 + 60 * MIN, closesAt: T0 + 120 * MIN }]));
    await expect(orders.confirm(slug, buyer(waveIds[0]!), T0)).rejects.toThrow(/not available yet/);
    (await orders.confirm(slug, buyer(waveIds[0]!), T0 + 60 * MIN));
    await expect(orders.confirm(slug, buyer(waveIds[0]!), T0 + 120 * MIN)).rejects.toThrow(/not available/);
  });
});

describe("paying online with a screenshot", () => {
  it("screenshot -> approve marks every ticket paid by that method, once", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    await orders.submitProof(o.accessToken, proof(), "NEO", T0 + 5 * MIN);
    expect((await orders.getById(o.id))!.order).toMatchObject({ status: "PENDING_VERIFICATION", payMethod: "NEO" });
    expect((await orders.approve(o.id, "admin-1", T0 + 10 * MIN))).toEqual({ alreadyApproved: false, newlyPaid: 2 });
    expect((await orders.approve(o.id, "admin-1", T0 + 11 * MIN))).toEqual({ alreadyApproved: true, newlyPaid: 0 });
    const got = (await orders.getById(o.id))!;
    expect(got.status).toBe("APPROVED");
    expect(got.tickets.map((t) => [t.paidVia, t.paidBy, t.paidAt])).toEqual([["NEO", "admin-1", T0 + 10 * MIN], ["NEO", "admin-1", T0 + 10 * MIN]]);
    expect(got.dueCents).toBe(0);
    // Emails are queued inside the transaction and sent after commit.
    expect(got.timeline.filter((r) => r.action !== "EMAIL_SENT").map((r) => r.action)).toEqual([
      "ORDER_CONFIRMED",
      "TICKET_ISSUED",
      "TICKET_ISSUED",
      "EMAIL_QUEUED",
      "PROOF_SUBMITTED",
      "ORDER_APPROVED",
      "EMAIL_QUEUED",
    ]);
  });

  it("needs a screenshot, and only one review at a time", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!), T0));
    await expect(orders.submitProof(o.accessToken, null, "WHISH", T0)).rejects.toThrow(/screenshot/);
    await orders.submitProof(o.accessToken, proof(), "WHISH", T0 + MIN);
    await expect(orders.submitProof(o.accessToken, proof(), "WHISH", T0 + 2 * MIN)).rejects.toThrow(/already have your screenshot/);
  });

  it("a rejected screenshot leaves the ticket valid and unpaid, and the guest can try again", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 1 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!), T0));
    await orders.submitProof(o.accessToken, proof(), "WHISH", T0 + MIN);
    await expect(orders.reject(o.id, "admin-1", " ")).rejects.toThrow(/reason/);
    (await orders.reject(o.id, "admin-1", "Amount didn't match", T0 + 2 * MIN));
    const got = (await orders.getById(o.id))!;
    expect(got.order).toMatchObject({ status: "CONFIRMED", rejectReason: "Amount didn't match" });
    expect(got.tickets.map((t) => [t.status, t.paidAt])).toEqual([["VALID", null]]);
    expect((await remaining(eventId))).toBe(0); // still holds its spot
    await orders.submitProof(o.accessToken, proof(), "NEO", T0 + 3 * MIN);
    expect((await orders.getById(o.id))!.order).toMatchObject({ status: "PENDING_VERIFICATION", rejectReason: null });
  });

  it("approving after part of a group paid cash at the door only pays the rest", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 5 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 3), T0));
    const first = (await orders.getById(o.id))!.tickets[0]!;
    (await db().update(tickets).set({ paidAt: T0 + MIN, paidVia: "CASH", paidBy: "scan-1", status: "CHECKED_IN" }).where(eq(tickets.id, first.id)));
    await orders.submitProof(o.accessToken, proof(), "WHISH", T0 + 2 * MIN);
    expect((await orders.approve(o.id, "admin-1", T0 + 3 * MIN)).newlyPaid).toBe(2);
    const after = (await orders.getById(o.id))!.tickets;
    expect(after.find((t) => t.id === first.id)).toMatchObject({ paidVia: "CASH", paidBy: "scan-1" });
    expect(after.filter((t) => t.paidVia === "WHISH")).toHaveLength(2);
  });

  it("comps issue paid tickets without using wave stock", async () => {
    const { eventId } = (await makeEvent([{ capacity: 1 }]));
    const o = (await orders.createComp({ eventId, attendeeName: "DJ Guest", email: "g@x.test", phone: "", quantity: 2 }, "admin-1"));
    const got = (await orders.getById(o.id))!;
    expect(got.tickets.map((t) => t.paidVia)).toEqual(["COMP", "COMP"]);
    expect((await remaining(eventId))).toBe(1);
  });
});

describe("cancelling", () => {
  it("frees the spots and kills the tickets", async () => {
    const { eventId, slug, waveIds } = (await makeEvent([{ capacity: 2 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    expect((await remaining(eventId))).toBe(0);
    (await orders.cancel(o.id, "admin-1", "fake sign-up", T0 + MIN));
    expect((await remaining(eventId))).toBe(2);
    const got = (await orders.getById(o.id))!;
    expect(got.status).toBe("CANCELLED");
    expect(got.tickets.map((t) => t.status)).toEqual(["REVOKED", "REVOKED"]);
    await expect(orders.submitProof(o.accessToken, proof(), "WHISH", T0 + 2 * MIN)).rejects.toThrow(/no longer accept/);
  });

  it("is refused once someone on the order is inside", async () => {
    const { slug, waveIds } = (await makeEvent([{ capacity: 2 }]));
    const o = (await orders.confirm(slug, buyer(waveIds[0]!, 2), T0));
    const first = (await orders.getById(o.id))!.tickets[0]!;
    (await db().update(tickets).set({ status: "CHECKED_IN" }).where(eq(tickets.id, first.id)));
    await expect(orders.cancel(o.id, "admin-1", "x")).rejects.toThrow(/already inside/);
  });
});
