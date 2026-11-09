import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { checkIn, doorCounts, extractToken, revoke } from "../src/services/tickets.ts";
import { feed } from "../src/services/journal.ts";
import { buyer, freshDb, makeEvent, T0 } from "./helpers.ts";

afterEach(async () => (await flushMail()));
beforeEach(async () => {
  (await freshDb());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function approvedTickets(qty = 2) {
  const e = (await makeEvent([{ capacity: 10 }]));
  const o = (await orders.reserve(e.slug, buyer(e.waveIds[0]!, qty), T0));
  await orders.submitProof(o.accessToken, null, "WH-1", T0 + 1);
  (await orders.approve(o.id, "admin-1", T0 + 2));
  return { ...e, tickets: (await orders.getById(o.id))!.tickets };
}

it("admits a ticket exactly once and logs every scan", async () => {
  const { eventId, tickets } = await approvedTickets();
  const t = tickets[0]!;
  expect((await checkIn(eventId, t.token, "admin-1")).result).toBe("ADMITTED");
  expect((await checkIn(eventId, t.token, "admin-1")).result).toBe("ALREADY_USED");
  expect((await checkIn(eventId, "garbage", "admin-1")).result).toBe("INVALID");
  expect((await doorCounts(eventId))).toEqual({ checkedIn: 1, total: 2 });
  expect((await feed({ action: "SCAN" })).map((r) => r.parsed?.result)).toEqual(["INVALID", "ALREADY_USED", "ADMITTED"]);
});

it("flags tickets for another event and revoked tickets", async () => {
  const a = await approvedTickets();
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
