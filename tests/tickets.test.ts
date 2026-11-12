import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { checkIn, collectAndAdmit, doorCash, doorCounts, extractToken, revoke } from "../src/services/tickets.ts";
import { feed } from "../src/services/journal.ts";
import { buyer, freshDb, makeEvent, screenshot, T0 } from "./helpers.ts";

afterEach(async () => (await flushMail()));
beforeEach(async () => {
  (await freshDb());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** Confirmed tickets; `paid` runs them through a verified Whish screenshot, `pending` stops before the admin. */
async function someTickets(state: "unpaid" | "pending" | "paid" = "paid", qty = 2) {
  const e = (await makeEvent([{ capacity: 10 }]));
  const o = (await orders.confirm(e.slug, buyer(e.waveIds[0]!, qty), T0));
  if (state !== "unpaid") await orders.submitProof(o.accessToken, screenshot(), "WHISH", T0 + 1);
  if (state === "paid") (await orders.approve(o.id, "admin-1", T0 + 2));
  return { ...e, orderId: o.id, tickets: (await orders.getById(o.id))!.tickets };
}
const row = async (orderId: string, id: string) => (await orders.getById(orderId))!.tickets.find((t) => t.id === id)!;

it("admits a paid ticket exactly once and logs every scan", async () => {
  const { eventId, tickets } = await someTickets();
  const t = tickets[0]!;
  expect((await checkIn(eventId, t.token, "admin-1"))).toMatchObject({ result: "ADMITTED", paidVia: "WHISH" });
  expect((await checkIn(eventId, t.token, "admin-1")).result).toBe("ALREADY_USED");
  expect((await checkIn(eventId, "garbage", "admin-1")).result).toBe("INVALID");
  expect((await doorCounts(eventId))).toEqual({ checkedIn: 1, total: 2 });
  expect((await feed({ action: "SCAN" })).map((r) => r.parsed?.result)).toEqual(["INVALID", "ALREADY_USED", "ADMITTED"]);
});

it("does not admit an unpaid ticket: it says what to collect", async () => {
  const { eventId, orderId, tickets } = await someTickets("unpaid");
  const t = tickets[0]!;
  expect((await checkIn(eventId, t.token, "admin-1"))).toMatchObject({ result: "PAYMENT_DUE", dueCents: 2000, proofPending: false, attendeeName: "Rami K", ticketId: t.id });
  expect((await row(orderId, t.id))).toMatchObject({ status: "VALID", paidAt: null });
  expect((await doorCounts(eventId)).checkedIn).toBe(0);
});

it("flags an unverified Whish screenshot at the door", async () => {
  const { eventId, tickets } = await someTickets("pending");
  expect((await checkIn(eventId, tickets[0]!.token, "admin-1"))).toMatchObject({ result: "PAYMENT_DUE", proofPending: true, payMethod: "WHISH" });
});

it("cash at the door pays and admits in one step, credited to the staff member", async () => {
  const { eventId, orderId, tickets } = await someTickets("unpaid");
  const t = tickets[0]!;
  expect((await collectAndAdmit(eventId, t.id, "CASH", "admin-1", T0 + 5))).toMatchObject({ result: "ADMITTED", paidVia: "CASH" });
  expect((await row(orderId, t.id))).toMatchObject({ status: "CHECKED_IN", paidVia: "CASH", paidBy: "admin-1", paidAt: T0 + 5, checkedInAt: T0 + 5 });
  expect((await doorCash(eventId))).toEqual([{ staffId: "admin-1", name: "Admin", tickets: 1, cents: 2000 }]);
  expect((await checkIn(eventId, t.token, "admin-1")).result).toBe("ALREADY_USED");
  // The other ticket in the group still owes.
  expect((await checkIn(eventId, tickets[1]!.token, "admin-1")).result).toBe("PAYMENT_DUE");
});

it("'receipt seen' needs a screenshot on file, and the admin's approval later replaces it", async () => {
  const none = await someTickets("unpaid");
  await expect(collectAndAdmit(none.eventId, none.tickets[0]!.id, "RECEIPT_SEEN", "admin-1")).rejects.toThrow(/Collect cash/);
  const p = await someTickets("pending");
  expect((await collectAndAdmit(p.eventId, p.tickets[0]!.id, "RECEIPT_SEEN", "admin-1")).result).toBe("ADMITTED");
  expect((await row(p.orderId, p.tickets[0]!.id)).paidVia).toBe("RECEIPT_SEEN");
  expect((await doorCash(p.eventId))).toEqual([]);
  expect((await orders.approve(p.orderId, "admin-1")).newlyPaid).toBe(2);
  expect((await row(p.orderId, p.tickets[0]!.id))).toMatchObject({ paidVia: "WHISH", status: "CHECKED_IN" });
});

it("collecting never admits a ticket that is used, revoked or for another event", async () => {
  const a = await someTickets("unpaid");
  const b = (await makeEvent([{ capacity: 1 }]));
  expect((await collectAndAdmit(b.eventId, a.tickets[0]!.id, "CASH", "admin-1")).result).toBe("WRONG_EVENT");
  (await revoke(a.tickets[1]!.id, "admin-1", "Banned"));
  expect((await collectAndAdmit(a.eventId, a.tickets[1]!.id, "CASH", "admin-1"))).toMatchObject({ result: "REVOKED", reason: "Banned" });
  expect((await doorCash(a.eventId))).toEqual([]);
});

it("two doormen collecting for the same ticket: one payment, one entry", async () => {
  const { eventId, tickets } = await someTickets("unpaid");
  const both = await Promise.all([collectAndAdmit(eventId, tickets[0]!.id, "CASH", "admin-1"), collectAndAdmit(eventId, tickets[0]!.id, "CASH", "admin-1")]);
  expect(both.map((o) => o.result).sort()).toEqual(["ADMITTED", "ALREADY_USED"]);
  expect((await feed({ action: "PAYMENT_COLLECTED" }))).toHaveLength(1);
});

it("flags tickets for another event and revoked tickets", async () => {
  const a = await someTickets();
  const b = (await makeEvent([{ capacity: 1 }]));
  expect((await checkIn(b.eventId, a.tickets[0]!.token, "admin-1"))).toMatchObject({ result: "WRONG_EVENT", otherEvent: "Test Night" });
  (await revoke(a.tickets[1]!.id, "admin-1", "Chargeback"));
  expect((await checkIn(a.eventId, a.tickets[1]!.token, "admin-1"))).toMatchObject({ result: "REVOKED", reason: "Chargeback" });
  await expect((async () => (await revoke(a.tickets[1]!.id, "admin-1", "again")))()).rejects.toThrow(/REVOKED/);
});

it("accepts a pasted ticket URL", () => {
  expect(extractToken("http://x/o/abc/tickets#AAAAAAAAAAAAAAAAAAAAAA")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  expect(extractToken(" AAAAAAAAAAAAAAAAAAAAAA ")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
});
