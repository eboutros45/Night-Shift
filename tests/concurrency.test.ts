import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshDb, makeEvent, buyer, T0 } from "./helpers.ts";
import * as orders from "../src/services/orders.ts";
import { checkIn } from "../src/services/tickets.ts";
import { flushMail } from "../src/services/mailer.ts";
beforeEach(async () => { await freshDb(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); });
it("allows only one of two simultaneous buyers to reserve the last ticket", async () => {
  const e = await makeEvent([{ capacity: 1 }]);
  const results = await Promise.allSettled([orders.reserve(e.slug, buyer(e.waveIds[0]!), T0), orders.reserve(e.slug, buyer(e.waveIds[0]!), T0)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
});
it("issues once under duplicate approvals and admits a ticket once under duplicate scans", async () => {
  const e = await makeEvent([{ capacity: 2 }]);
  const o = await orders.reserve(e.slug, buyer(e.waveIds[0]!), T0);
  await orders.submitProof(o.accessToken, null, "payment", T0 + 1);
  const approved = await Promise.all([orders.approve(o.id, "admin-1"), orders.approve(o.id, "admin-1")]);
  expect(approved.map(a=>a.alreadyApproved).sort()).toEqual([false,true]);
  const detail = await orders.getById(o.id);
  expect(detail?.tickets).toHaveLength(1);
  const scans = await Promise.all([checkIn(e.eventId, detail!.tickets[0]!.token, "admin-1"), checkIn(e.eventId, detail!.tickets[0]!.token, "admin-1")]);
  expect(scans.map(s=>s.result).sort()).toEqual(["ADMITTED", "ALREADY_USED"]);
});
