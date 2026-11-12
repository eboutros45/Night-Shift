import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshDb, makeEvent, buyer, screenshot, T0 } from "./helpers.ts";
import * as orders from "../src/services/orders.ts";
import { checkIn } from "../src/services/tickets.ts";
import { flushMail } from "../src/services/mailer.ts";
beforeEach(async () => { await freshDb(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); });
it("five guests confirming at once for the last two spots: exactly two get tickets", async () => {
  const e = await makeEvent([{ capacity: 2 }]);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => orders.confirm(e.slug, buyer(e.waveIds[0]!), T0)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(3);
});
it("pays once under duplicate approvals and admits a ticket once under duplicate scans", async () => {
  const e = await makeEvent([{ capacity: 2 }]);
  const o = await orders.confirm(e.slug, buyer(e.waveIds[0]!), T0);
  await orders.submitProof(o.accessToken, screenshot(), "WHISH", T0 + 1);
  const approved = await Promise.all([orders.approve(o.id, "admin-1"), orders.approve(o.id, "admin-1")]);
  expect(approved.map(a=>a.alreadyApproved).sort()).toEqual([false,true]);
  expect(approved.map(a=>a.newlyPaid).sort()).toEqual([0,1]);
  const detail = await orders.getById(o.id);
  expect(detail?.tickets).toHaveLength(1);
  const scans = await Promise.all([checkIn(e.eventId, detail!.tickets[0]!.token, "admin-1"), checkIn(e.eventId, detail!.tickets[0]!.token, "admin-1")]);
  expect(scans.map(s=>s.result).sort()).toEqual(["ADMITTED", "ALREADY_USED"]);
});
