import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { events, tickets, users } from "../src/db/schema.ts";
import * as door from "../src/services/door-sales.ts";
import { feed } from "../src/services/journal.ts";
import { flushMail } from "../src/services/mailer.ts";
import { reserve } from "../src/services/orders.ts";
import { doorCounts } from "../src/services/tickets.ts";
import { buyer, freshDb, makeEvent, T0 } from "./helpers.ts";

let eventId: string;
beforeEach(async () => {
  (await freshDb());
  (await db().insert(users).values({ id: "door-1", email: "d@x.test", name: "Door One", passwordHash: "x", role: "SCANNER" }).returning());
  eventId = (await makeEvent([{ capacity: 10 }])).eventId;
  (await db().update(events).set({ doorPriceCents: 2500, doorLimit: 5 }).where(eq(events.id, eventId)).returning());
});

it("logs a cash sale as an approved door order with tickets already checked in", async () => {
  const o = (await door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0));
  expect(o).toMatchObject({ channel: "DOOR", status: "APPROVED", totalCents: 5000, waveId: null, decidedBy: "door-1" });
  const t = (await db().select().from(tickets).where(eq(tickets.orderId, o.id)));
  expect(t.map((x) => [x.status, x.checkedInBy])).toEqual([["CHECKED_IN", "door-1"], ["CHECKED_IN", "door-1"]]);
  expect((await doorCounts(eventId))).toEqual({ checkedIn: 2, total: 2 });
  expect((await feed({ action: "DOOR_SALE" }))[0]).toMatchObject({ actor: "door-1", parsed: { quantity: 2, totalCents: 5000, payment: "CASH" } });
  await flushMail();
  expect((await feed({ action: "EMAIL_QUEUED" }))).toHaveLength(0); // no email for walk-ins
});

it("refuses sales when no door price is set", async () => {
  (await db().update(events).set({ doorPriceCents: null }).where(eq(events.id, eventId)).returning());
  await expect((async () => (await door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0)))()).rejects.toThrow(/door price/);
});

it("enforces the walk-in limit, and a void frees the tickets again", async () => {
  const a = (await door.sell(eventId, { quantity: 4, name: "Walk-in" }, "door-1", T0));
  await expect((async () => (await door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0)))()).rejects.toThrow("Only 1 walk-in ticket left.");
  (await door.voidSale(a.id, "Rang up 4 instead of 2", "door-1", T0 + 1));
  expect((await door.summary(eventId))?.left).toBe(5);
  expect(async () => (await door.sell(eventId, { quantity: 5, name: "Walk-in" }, "door-1", T0 + 2))).not.toThrow();
  await expect((async () => (await door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0 + 3)))()).rejects.toThrow("Walk-ins are sold out.");
});

it("void revokes the tickets, keeps the sale in the log, and is idempotent", async () => {
  const o = (await door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0));
  await expect((async () => (await door.voidSale(o.id, " ", "door-1")))()).rejects.toThrow(/reason/);
  expect((await door.voidSale(o.id, "Refunded", "admin-1", T0 + 1))).toEqual({ alreadyVoided: false, totalCents: 5000 });
  expect((await door.voidSale(o.id, "Refunded", "admin-1", T0 + 2))).toEqual({ alreadyVoided: true, totalCents: 5000 });
  expect((await db().select().from(tickets).where(eq(tickets.orderId, o.id))).every((t) => t.status === "REVOKED")).toBe(true);
  expect((await doorCounts(eventId))).toEqual({ checkedIn: 0, total: 0 });
  expect((await feed({ action: "DOOR_SALE_VOIDED" }))).toHaveLength(1);
  const s = (await door.summary(eventId))!;
  expect(s.cashCents).toBe(0);
  expect(s.voided).toEqual({ sales: 1, cents: 5000 });
  expect(s.recent).toHaveLength(1); // still listed, as voided
});

it("totals cash per staff member", async () => {
  (await db().insert(users).values({ id: "door-2", email: "d2@x.test", name: "Door Two", passwordHash: "x", role: "SCANNER" }).returning());
  (await door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0));
  (await door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-2", T0));
  (await door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-2", T0));
  const s = (await door.summary(eventId))!;
  expect(s.cashCents).toBe(10_000);
  expect(s.byStaff.map((r) => [r.name, r.tickets, r.cents])).toEqual([
    ["Door Two", 3, 7500],
    ["Door One", 1, 2500],
  ]);
});

it("only door sales can be voided", async () => {
  const ev = (await makeEvent([{ capacity: 5 }]));
  const online = (await reserve(ev.slug, buyer(ev.waveIds[0]!, 1), T0));
  await expect((async () => (await door.voidSale(online.id, "nope", "admin-1")))()).rejects.toThrow("Only walk-in sales can be voided.");
});
