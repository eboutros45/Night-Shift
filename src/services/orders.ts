// Order lifecycle: reserve -> submit proof -> approve | reject, plus expiry and comps.
// Every transition: guarded UPDATE (status in WHERE) + journal row, in one transaction.
import { and, count, desc, eq, gt, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, tx, type Tx } from "../db/client.ts";
import { events, orders, tickets, waves, type Event, type Order } from "../db/schema.ts";
import type { CheckoutInput, CompInput } from "../domain/inputs.ts";
import { assertOrderTransition, DomainError, effectiveOrderStatus, type OrderStatus } from "../domain/status.ts";
import { newId, orderReference, secretToken } from "../lib/ids.ts";
import { removeStored, saveUpload } from "../lib/storage.ts";
import { waveViews } from "./inventory.ts";
import { orderTimeline, record } from "./journal.ts";
import * as notify from "./notify.ts";

/** Sales close this long after doors open. */
const SALES_CLOSE_AFTER_START_MS = 6 * 3600_000;

function uniqueReference(t: Tx) {
  for (let i = 0; i < 10; i++) {
    const ref = orderReference();
    if (!t.select({ id: orders.id }).from(orders).where(eq(orders.reference, ref)).get()) return ref;
  }
  throw new Error("Could not allocate an order reference");
}

/** Phone as comparable digits: last 8 digits, so "+961 70 123 456" and "70123456" match. */
export const phoneKey = (p: string) => p.replace(/\D/g, "").slice(-8);
const PHONE_KEY_SQL = sql`substr(replace(replace(replace(replace(replace(${orders.customerPhone}, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -8)`;

/**
 * Anti-hoarding, per person (same email OR same phone) per event:
 *  - one unpaid hold at a time, so nobody can lock up a wave with repeated 30-minute holds
 *  - a total cap across their live orders (pending + approved + running holds)
 * Comps and walk-in (door) sales don't count. Expired/rejected orders don't count.
 */
function assertBuyerLimits(t: Tx, event: Event, input: CheckoutInput, at: number) {
  const mine = t
    .select({ quantity: orders.quantity, status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.eventId, event.id),
        eq(orders.isComp, false),
        eq(orders.channel, "ONLINE"),
        or(eq(orders.customerEmail, input.customerEmail), eq(PHONE_KEY_SQL, phoneKey(input.customerPhone))),
        or(inArray(orders.status, ["PENDING_VERIFICATION", "APPROVED"]), and(eq(orders.status, "AWAITING_PAYMENT"), gt(orders.expiresAt, at))),
      ),
    )
    .all();
  if (mine.some((o) => o.status === "AWAITING_PAYMENT"))
    throw new DomainError(
      "HOLD_EXISTS",
      "You already have tickets on hold for this event. Finish that payment (the link is in your email) or wait for the hold to expire.",
      409,
    );
  const have = mine.reduce((n, o) => n + o.quantity, 0);
  if (have + input.quantity > event.maxPerBuyer)
    throw new DomainError(
      "BUYER_LIMIT",
      have
        ? `The limit is ${event.maxPerBuyer} tickets per person for this event and you already have ${have}.`
        : `The limit is ${event.maxPerBuyer} tickets per person for this event.`,
      409,
    );
}

export function reserve(slug: string, input: CheckoutInput, at = now()) {
  return tx((t) => {
    const event = t.select().from(events).where(and(eq(events.slug, slug), eq(events.published, true))).get();
    if (!event) throw new DomainError("EVENT_NOT_FOUND", "This event is not available.", 404);
    if (at > event.startsAt + SALES_CLOSE_AFTER_START_MS)
      throw new DomainError("SALES_CLOSED", "Ticket sales for this event have closed.", 409);
    if (input.quantity > event.maxPerOrder)
      throw new DomainError("QTY_LIMIT", `You can buy up to ${event.maxPerOrder} tickets per order.`);
    assertBuyerLimits(t, event, input, at);

    // The stock check and the insert share one IMMEDIATE transaction: SQLite holds the write
    // lock from here to commit, so two buyers can never both take the last ticket.
    const wave = waveViews(t, event.id, at).find((w) => w.id === input.waveId);
    if (!wave) throw new DomainError("WAVE_NOT_FOUND", "That ticket wave doesn't exist.", 404);
    if (wave.state === "SOLD_OUT") throw new DomainError("SOLD_OUT", `${wave.name} is sold out.`, 409);
    if (wave.state !== "ON_SALE") throw new DomainError("WAVE_NOT_ON_SALE", `${wave.name} is not on sale yet.`, 409);
    if (wave.remaining < input.quantity)
      throw new DomainError(
        "NOT_ENOUGH_LEFT",
        `Only ${wave.remaining} left in ${wave.name}. Reduce the quantity or pick another wave.`,
        409,
      );

    const order: Order = {
      id: newId(),
      reference: uniqueReference(t),
      accessToken: secretToken(),
      eventId: event.id,
      waveId: wave.id,
      status: "AWAITING_PAYMENT",
      quantity: input.quantity,
      unitPriceCents: wave.priceCents,
      totalCents: wave.priceCents * input.quantity,
      isComp: false,
      channel: "ONLINE",
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      expiresAt: at + config.reservationMinutes * 60_000,
      proofKey: null,
      proofMime: null,
      txnRef: null,
      submittedAt: null,
      decidedAt: null,
      decidedBy: null,
      rejectReason: null,
      createdAt: at,
    };
    t.insert(orders).values(order).run();
    record(t, {
      actor: "customer",
      entityType: "order",
      entityId: order.id,
      eventId: event.id,
      action: "ORDER_CREATED",
      to: "AWAITING_PAYMENT",
      at,
      data: {
        reference: order.reference,
        wave: wave.name,
        quantity: order.quantity,
        totalCents: order.totalCents,
        expiresAt: order.expiresAt,
        waveRemainingAfter: wave.remaining - input.quantity,
      },
    });
    notify.orderPlaced(t, order, event);
    return order;
  });
}

export async function submitProof(token: string, file: File | null, txnRef: string | undefined, at = now()) {
  if (!file && !txnRef)
    throw new DomainError("PROOF_REQUIRED", "Upload a screenshot/PDF of the payment or enter the Whish transaction reference.");
  // File first (async, outside the sync transaction); deleted again if the state change fails.
  const stored = file ? await saveUpload("proofs", file) : null;
  try {
    return tx((t) => {
      const order = t.select().from(orders).where(eq(orders.accessToken, token)).get();
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
      const status = effectiveOrderStatus(order, at);
      if (status === "EXPIRED")
        throw new DomainError("ORDER_EXPIRED", "This reservation expired before payment was submitted. Please start a new order.", 409);
      assertOrderTransition(status, "PENDING_VERIFICATION");
      const res = t
        .update(orders)
        .set({
          status: "PENDING_VERIFICATION",
          submittedAt: at,
          proofKey: stored?.key ?? null,
          proofMime: stored?.mime ?? null,
          txnRef: txnRef ?? null,
        })
        .where(and(eq(orders.id, order.id), eq(orders.status, "AWAITING_PAYMENT"), gt(orders.expiresAt, at)))
        .run();
      if (res.changes !== 1) throw new DomainError("ORDER_CHANGED", "This order can no longer accept payment.", 409);
      record(t, {
        actor: "customer",
        entityType: "order",
        entityId: order.id,
        eventId: order.eventId,
        action: "PROOF_SUBMITTED",
        from: "AWAITING_PAYMENT",
        to: "PENDING_VERIFICATION",
        at,
        data: { file: stored ? stored.mime : null, txnRef: txnRef ?? null, msBeforeExpiry: order.expiresAt! - at },
      });
      return order;
    });
  } catch (err) {
    if (stored) await removeStored("proofs", stored.key);
    throw err;
  }
}

function issueTickets(t: Tx, order: Order, actor: string, at: number) {
  const rows = Array.from({ length: order.quantity }, () => ({
    id: newId(),
    token: secretToken(),
    orderId: order.id,
    eventId: order.eventId,
    attendeeName: order.customerName,
    status: "VALID",
    createdAt: at,
  }));
  t.insert(tickets).values(rows).run();
  for (const r of rows)
    record(t, { actor, entityType: "ticket", entityId: r.id, eventId: order.eventId, action: "TICKET_ISSUED", to: "VALID", at });
  return rows;
}

/** Idempotent: approving twice (double click, two admins) never issues a second set of tickets. */
export function approve(orderId: string, actor: string, at = now()) {
  return tx((t) => {
    const order = t.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
    if (order.status === "APPROVED") return { alreadyApproved: true };
    assertOrderTransition(order.status, "APPROVED");
    const res = t
      .update(orders)
      .set({ status: "APPROVED", decidedAt: at, decidedBy: actor })
      .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING_VERIFICATION")))
      .run();
    if (res.changes !== 1) throw new DomainError("ORDER_CHANGED", "Order changed; refresh and try again.", 409);
    record(t, {
      actor,
      entityType: "order",
      entityId: order.id,
      eventId: order.eventId,
      action: "ORDER_APPROVED",
      from: "PENDING_VERIFICATION",
      to: "APPROVED",
      at,
      data: { reference: order.reference, quantity: order.quantity, totalCents: order.totalCents, waitedMs: at - (order.submittedAt ?? at) },
    });
    issueTickets(t, order, actor, at);
    const event = t.select().from(events).where(eq(events.id, order.eventId)).get()!;
    notify.ticketsIssued(t, { ...order, status: "APPROVED" }, event);
    return { alreadyApproved: false };
  });
}

/** Rejecting frees the tickets automatically: a REJECTED order no longer counts toward stock. */
export function reject(orderId: string, actor: string, reason: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give the customer a reason.");
  return tx((t) => {
    const order = t.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
    assertOrderTransition(order.status, "REJECTED");
    const res = t
      .update(orders)
      .set({ status: "REJECTED", decidedAt: at, decidedBy: actor, rejectReason: reason.trim() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING_VERIFICATION")))
      .run();
    if (res.changes !== 1) throw new DomainError("ORDER_CHANGED", "Order changed; refresh and try again.", 409);
    record(t, {
      actor,
      entityType: "order",
      entityId: order.id,
      eventId: order.eventId,
      action: "ORDER_REJECTED",
      from: "PENDING_VERIFICATION",
      to: "REJECTED",
      at,
      data: { reference: order.reference, reason: reason.trim(), freed: order.quantity },
    });
    const event = t.select().from(events).where(eq(events.id, order.eventId)).get()!;
    notify.orderRejected(t, order, event, reason.trim());
  });
}

/** Complimentary tickets: an APPROVED $0 order with no wave, so it never uses wave stock. */
export function createComp(input: CompInput, actor: string, at = now()) {
  return tx((t) => {
    const event = t.select().from(events).where(eq(events.id, input.eventId)).get();
    if (!event) throw new DomainError("EVENT_NOT_FOUND", "Event not found.", 404);
    const order: Order = {
      id: newId(),
      reference: uniqueReference(t),
      accessToken: secretToken(),
      eventId: event.id,
      waveId: null,
      status: "APPROVED",
      quantity: input.quantity,
      unitPriceCents: 0,
      totalCents: 0,
      isComp: true,
      channel: "ONLINE",
      customerName: input.attendeeName,
      customerEmail: input.email,
      customerPhone: input.phone,
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
    t.insert(orders).values(order).run();
    record(t, {
      actor,
      entityType: "order",
      entityId: order.id,
      eventId: event.id,
      action: "COMP_CREATED",
      to: "APPROVED",
      at,
      data: { reference: order.reference, quantity: input.quantity, note: input.note ?? null },
    });
    issueTickets(t, order, actor, at);
    notify.ticketsIssued(t, order, event);
    return order;
  });
}

/** Email the ticket PDF again (customer lost it, typo fixed, first send failed). */
export function resendTickets(orderId: string, actor: string, at = now()) {
  tx((t) => {
    const order = t.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
    if (order.status !== "APPROVED") throw new DomainError("NOT_APPROVED", "Only approved orders have tickets to send.", 409);
    const event = t.select().from(events).where(eq(events.id, order.eventId)).get()!;
    record(t, { actor, entityType: "order", entityId: order.id, eventId: order.eventId, action: "TICKETS_RESENT", at, data: { to: order.customerEmail } });
    notify.ticketsIssued(t, order, event);
  });
}

// ---------- reads ----------

function loadOrder(where: SQL) {
  const row = db()
    .select({ order: orders, event: events, wave: waves })
    .from(orders)
    .innerJoin(events, eq(events.id, orders.eventId))
    .leftJoin(waves, eq(waves.id, orders.waveId))
    .where(where)
    .get();
  if (!row) return null;
  const ticketRows = db().select().from(tickets).where(eq(tickets.orderId, row.order.id)).orderBy(tickets.createdAt).all();
  return {
    ...row,
    status: effectiveOrderStatus(row.order, now()),
    tickets: ticketRows,
    timeline: orderTimeline(
      row.order.id,
      ticketRows.map((r) => r.id),
    ),
  };
}

export const getByToken = (token: string) => loadOrder(eq(orders.accessToken, token));
export const getById = (id: string) => loadOrder(eq(orders.id, id));

export type OrderFilter = { status?: string; eventId?: string; q?: string };

export function list(f: OrderFilter = {}) {
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(orders.status, f.status));
  if (f.eventId) conds.push(eq(orders.eventId, f.eventId));
  if (f.q) {
    const q = `%${f.q.trim()}%`;
    conds.push(
      or(
        like(orders.reference, q.toUpperCase()),
        like(orders.customerName, q),
        like(orders.customerEmail, q.toLowerCase()),
        like(orders.customerPhone, q),
        like(orders.txnRef, q),
      )!,
    );
  }
  const at = now();
  return db()
    .select({ order: orders, eventTitle: events.title, waveName: waves.name })
    .from(orders)
    .innerJoin(events, eq(events.id, orders.eventId))
    .leftJoin(waves, eq(waves.id, orders.waveId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(300)
    .all()
    .map((r) => ({ ...r, status: effectiveOrderStatus(r.order, at) }));
}

export function countByStatus(statuses: OrderStatus[]) {
  return db().select({ n: count() }).from(orders).where(inArray(orders.status, statuses)).get()!.n;
}
