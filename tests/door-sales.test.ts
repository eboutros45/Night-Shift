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
beforeEach(() => {
  freshDb();
  db().insert(users).values({ id: "door-1", email: "d@x.test", name: "Door One", passwordHash: "x", role: "SCANNER" }).run();
  eventId = makeEvent([{ capacity: 10 }]).eventId;
  db().update(events).set({ doorPriceCents: 2500, doorLimit: 5 }).where(eq(events.id, eventId)).run();
});

it("logs a cash sale as an approved door order with tickets already checked in", async () => {
  const o = door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0);
  expect(o).toMatchObject({ channel: "DOOR", status: "APPROVED", totalCents: 5000, waveId: null, decidedBy: "door-1" });
  const t = db().select().from(tickets).where(eq(tickets.orderId, o.id)).all();
  expect(t.map((x) => [x.status, x.checkedInBy])).toEqual([["CHECKED_IN", "door-1"], ["CHECKED_IN", "door-1"]]);
  expect(doorCounts(eventId)).toEqual({ checkedIn: 2, total: 2 });
  expect(feed({ action: "DOOR_SALE" })[0]).toMatchObject({ actor: "door-1", parsed: { quantity: 2, totalCents: 5000, payment: "CASH" } });
  await flushMail();
  expect(feed({ action: "EMAIL_QUEUED" })).toHaveLength(0); // no email for walk-ins
});

it("refuses sales when no door price is set", () => {
  db().update(events).set({ doorPriceCents: null }).where(eq(events.id, eventId)).run();
  expect(() => door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0)).toThrow(/door price/);
});

it("enforces the walk-in limit, and a void frees the tickets again", () => {
  const a = door.sell(eventId, { quantity: 4, name: "Walk-in" }, "door-1", T0);
  expect(() => door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0)).toThrow("Only 1 walk-in ticket left.");
  door.voidSale(a.id, "Rang up 4 instead of 2", "door-1", T0 + 1);
  expect(door.summary(eventId)?.left).toBe(5);
  expect(() => door.sell(eventId, { quantity: 5, name: "Walk-in" }, "door-1", T0 + 2)).not.toThrow();
  expect(() => door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0 + 3)).toThrow("Walk-ins are sold out.");
});

it("void revokes the tickets, keeps the sale in the log, and is idempotent", () => {
  const o = door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-1", T0);
  expect(() => door.voidSale(o.id, " ", "door-1")).toThrow(/reason/);
  expect(door.voidSale(o.id, "Refunded", "admin-1", T0 + 1)).toEqual({ alreadyVoided: false, totalCents: 5000 });
  expect(door.voidSale(o.id, "Refunded", "admin-1", T0 + 2)).toEqual({ alreadyVoided: true, totalCents: 5000 });
  expect(db().select().from(tickets).where(eq(tickets.orderId, o.id)).all().every((t) => t.status === "REVOKED")).toBe(true);
  expect(doorCounts(eventId)).toEqual({ checkedIn: 0, total: 0 });
  expect(feed({ action: "DOOR_SALE_VOIDED" })).toHaveLength(1);
  const s = door.summary(eventId)!;
  expect(s.cashCents).toBe(0);
  expect(s.voided).toEqual({ sales: 1, cents: 5000 });
  expect(s.recent).toHaveLength(1); // still listed, as voided
});

it("totals cash per staff member", () => {
  db().insert(users).values({ id: "door-2", email: "d2@x.test", name: "Door Two", passwordHash: "x", role: "SCANNER" }).run();
  door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-1", T0);
  door.sell(eventId, { quantity: 2, name: "Walk-in" }, "door-2", T0);
  door.sell(eventId, { quantity: 1, name: "Walk-in" }, "door-2", T0);
  const s = door.summary(eventId)!;
  expect(s.cashCents).toBe(10_000);
  expect(s.byStaff.map((r) => [r.name, r.tickets, r.cents])).toEqual([
    ["Door Two", 3, 7500],
    ["Door One", 1, 2500],
  ]);
});

it("only door sales can be voided", () => {
  const ev = makeEvent([{ capacity: 5 }]);
  const online = reserve(ev.slug, buyer(ev.waveIds[0]!, 1), T0);
  expect(() => door.voidSale(online.id, "nope", "admin-1")).toThrow("Only walk-in sales can be voided.");
});
