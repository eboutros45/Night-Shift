// Walk-ins: people who pay cash at the door. Staff log each sale on the door phone.
//
// A door sale is an order with channel DOOR: already APPROVED (staff took the cash) and its
// tickets already CHECKED_IN (the person is standing there), so it counts toward "inside"
// and revenue straight away. No wave (door stock is its own limit), no email.
// Mistakes and refunds are fixed by voiding, never by deleting: the sale stays in the log.
import { and, desc, eq, sql, sum } from "drizzle-orm";
import { now } from "../clock.ts";
import { db, tx, type Exec } from "../db/client.ts";
import { events, orders, tickets, users, type Order } from "../db/schema.ts";
import type { DoorSaleInput } from "../domain/inputs.ts";
import { assertOrderTransition, DomainError } from "../domain/status.ts";
import { newId, orderReference, secretToken } from "../lib/ids.ts";
import { record } from "./journal.ts";

const isDoor = (eventId: string) => and(eq(orders.eventId, eventId), eq(orders.channel, "DOOR"));

/** Walk-in tickets sold and not voided. */
async function soldAtDoor(x: Exec, eventId: string) {
  const r = (await x
      .select({ n: sum(orders.quantity) })
      .from(orders)
      .where(and(isDoor(eventId), eq(orders.status, "APPROVED"))).limit(1))[0];
  return Number(r?.n ?? 0);
}

async function uniqueReference(x: Exec) {
  for (let i = 0; i < 10; i++) {
    const ref = orderReference();
    if (!(await x.select({ id: orders.id }).from(orders).where(eq(orders.reference, ref)).limit(1))[0]) return ref;
  }
  throw new Error("Could not allocate an order reference");
}

export async function sell(eventId: string, input: DoorSaleInput, actor: string, at = now()) {
  return (await tx(async (t) => {
      const event = (await t.select().from(events).where(eq(events.id, eventId)).limit(1))[0];
      if (!event) throw new DomainError("EVENT_NOT_FOUND", "Event not found.", 404);
      if (event.doorPriceCents === null)
        throw new DomainError("DOOR_SALES_OFF", "Walk-in sales are off for this event. An admin needs to set a door price.", 409);
      if (event.doorLimit !== null) {
        const left = event.doorLimit - (await soldAtDoor(t, eventId));
        if (input.quantity > left)
          throw new DomainError("DOOR_LIMIT", left <= 0 ? "Walk-ins are sold out." : `Only ${left} walk-in ticket${left === 1 ? "" : "s"} left.`, 409);
      }

      const order: Order = {
        id: newId(),
        reference: (await uniqueReference(t)),
        accessToken: secretToken(),
        eventId,
        waveId: null,
        status: "APPROVED",
        channel: "DOOR",
        quantity: input.quantity,
        unitPriceCents: event.doorPriceCents,
        totalCents: event.doorPriceCents * input.quantity,
        isComp: false,
        userId: null, customerName: input.name,
        customerEmail: "",
        customerPhone: "",
        expiresAt: null,
        proofKey: null,
        proofMime: null,
        txnRef: null,
        submittedAt: null,
        decidedAt: at,
        decidedBy: actor,
        rejectReason: null,
        createdAt: at,
      };
      (await t.insert(orders).values(order).returning());
      (await record(t, {
              actor,
              entityType: "order",
              entityId: order.id,
              eventId,
              action: "DOOR_SALE",
              to: "APPROVED",
              at,
              data: { reference: order.reference, quantity: order.quantity, totalCents: order.totalCents, payment: "CASH", name: order.customerName },
            }));

      // Tickets exist so attendee lists, counts and exports stay complete; they start checked in.
      for (let i = 0; i < order.quantity; i++) {
        const id = newId();
        (await t.insert(tickets)
                  .values({ id, token: secretToken(), orderId: order.id, eventId, attendeeName: order.customerName, status: "CHECKED_IN", checkedInAt: at, checkedInBy: actor, createdAt: at }).returning());
        (await record(t, { actor, entityType: "ticket", entityId: id, eventId, action: "TICKET_ISSUED", to: "CHECKED_IN", at, data: { door: true } }));
      }
      return order;
    }));
}

/** Undo a door sale (wrong quantity, refund...). Its tickets are revoked; the cash leaves the totals. */
export async function voidSale(orderId: string, reason: string, actor: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give a reason for voiding.");
  return (await tx(async (t) => {
      const order = (await t.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Sale not found.", 404);
      if (order.channel !== "DOOR") throw new DomainError("NOT_DOOR_SALE", "Only walk-in sales can be voided.", 409);
      if (order.status === "VOIDED") return { alreadyVoided: true, totalCents: order.totalCents };
      assertOrderTransition(order.status, "VOIDED");
      const res = (await t
            .update(orders)
            .set({ status: "VOIDED" })
            .where(and(eq(orders.id, orderId), eq(orders.status, "APPROVED"))).returning());
      if (res.length !== 1) return { alreadyVoided: true, totalCents: order.totalCents };
      (await t.update(tickets)
              .set({ status: "REVOKED", revokedAt: at, revokeReason: `Walk-in sale voided: ${reason.trim()}` })
              .where(eq(tickets.orderId, orderId)).returning());
      (await record(t, {
              actor,
              entityType: "order",
              entityId: orderId,
              eventId: order.eventId,
              action: "DOOR_SALE_VOIDED",
              from: "APPROVED",
              to: "VOIDED",
              at,
              data: { reference: order.reference, reason: reason.trim(), quantity: order.quantity, totalCents: order.totalCents, soldBy: order.decidedBy },
            }));
      return { alreadyVoided: false, totalCents: order.totalCents };
    }));
}

/** Everything the walk-in screen shows: price, what's left, cash per staff member, recent sales. */
export async function summary(eventId: string) {
  const event = (await db().select().from(events).where(eq(events.id, eventId)).limit(1))[0];
  if (!event) return null;
  const sold = (await soldAtDoor(db(), eventId));
  const byStaff = (await db()
      .select({
        staffId: orders.decidedBy,
        name: users.name,
        sales: sql<number>`count(*)`,
        tickets: sql<number>`sum(${orders.quantity})`,
        cents: sql<number>`sum(${orders.totalCents})`,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.decidedBy))
      .where(and(isDoor(eventId), eq(orders.status, "APPROVED")))
      .groupBy(orders.decidedBy, users.name)
      .orderBy(desc(sql`sum(${orders.totalCents})`)))
    .map((r) => ({ ...r, sales: Number(r.sales), tickets: Number(r.tickets), cents: Number(r.cents) }));
  const voided = (await db()
      .select({ n: sql<number>`count(*)`, cents: sql<number>`coalesce(sum(${orders.totalCents}), 0)` })
      .from(orders)
      .where(and(isDoor(eventId), eq(orders.status, "VOIDED"))).limit(1))[0]!;
  const recent = (await db()
      .select({ order: orders, staff: users.name })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.decidedBy))
      .where(isDoor(eventId))
      .orderBy(desc(orders.createdAt))
      .limit(25));
  return {
    event,
    priceCents: event.doorPriceCents,
    limit: event.doorLimit,
    sold,
    left: event.doorLimit === null ? null : Math.max(0, event.doorLimit - sold),
    cashCents: byStaff.reduce((n, s) => n + s.cents, 0),
    byStaff,
    voided: { sales: Number(voided.n), cents: Number(voided.cents) },
    recent,
  };
}
