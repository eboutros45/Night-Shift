import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { checkIn, doorCounts, extractToken, revoke } from "../src/services/tickets.ts";
import { feed } from "../src/services/journal.ts";
import { buyer, freshDb, makeEvent, T0 } from "./helpers.ts";

afterEach(() => flushMail());
beforeEach(() => {
  freshDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function approvedTickets(qty = 2) {
  const e = makeEvent([{ capacity: 10 }]);
  const o = orders.reserve(e.slug, buyer(e.waveIds[0]!, qty), T0);
  await orders.submitProof(o.accessToken, null, "WH-1", T0 + 1);
  orders.approve(o.id, "admin-1", T0 + 2);
  return { ...e, tickets: orders.getById(o.id)!.tickets };
}

it("admits a ticket exactly once and logs every scan", async () => {
  const { eventId, tickets } = await approvedTickets();
  const t = tickets[0]!;
  expect(checkIn(eventId, t.token, "admin-1").result).toBe("ADMITTED");
  expect(checkIn(eventId, t.token, "admin-1").result).toBe("ALREADY_USED");
  expect(checkIn(eventId, "garbage", "admin-1").result).toBe("INVALID");
  expect(doorCounts(eventId)).toEqual({ checkedIn: 1, total: 2 });
  expect(feed({ action: "SCAN" }).map((r) => r.parsed?.result)).toEqual(["INVALID", "ALREADY_USED", "ADMITTED"]);
});

it("flags tickets for another event and revoked tickets", async () => {
  const a = await approvedTickets();
  const b = makeEvent([{ capacity: 1 }]);
  expect(checkIn(b.eventId, a.tickets[0]!.token, "admin-1")).toMatchObject({ result: "WRONG_EVENT", otherEvent: "Test Night" });
  revoke(a.tickets[1]!.id, "admin-1", "Chargeback");
  expect(checkIn(a.eventId, a.tickets[1]!.token, "admin-1")).toMatchObject({ result: "REVOKED", reason: "Chargeback" });
  expect(() => revoke(a.tickets[1]!.id, "admin-1", "again")).toThrow(/REVOKED/);
});

it("accepts a pasted ticket URL", () => {
  expect(extractToken("http://x/o/abc/tickets#AAAAAAAAAAAAAAAAAAAAAA")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  expect(extractToken(" AAAAAAAAAAAAAAAAAAAAAA ")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
});
