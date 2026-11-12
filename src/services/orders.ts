// Order lifecycle: confirm (tickets issued, unpaid) -> optional payment screenshot -> approve | reject,
// plus cancellation and comps. Paying cash at the door lives in services/tickets.ts.
// Every transition: guarded UPDATE (status in WHERE) + journal row, in one transaction.
import { and, count, desc, eq, gt, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { now } from "../clock.ts";
import { afterCommit, db, tx, type Tx } from "../db/client.ts";
import { events, orders, tickets, waves, type Event, type Order } from "../db/schema.ts";
import type { CheckoutInput, CompInput } from "../domain/inputs.ts";
import { assertOrderTransition, DomainError, effectiveOrderStatus, LIVE_ORDER_STATUSES, type OrderStatus, type PaidVia, type PayMethod } from "../domain/status.ts";
import { newId, orderReference, secretToken } from "../lib/ids.ts";
import { removeStored, saveUpload } from "../lib/storage.ts";
import { waveViews } from "./inventory.ts";
import { orderTimeline, record } from "./journal.ts";
import * as notify from "./notify.ts";

/** Sales close this long after doors open. */
const SALES_CLOSE_AFTER_START_MS = 6 * 3600_000;

async function uniqueReference(t: Tx) {
  for (let i = 0; i < 10; i++) {
    const ref = orderReference();
    if (!(await t.select({ id: orders.id }).from(orders).where(eq(orders.reference, ref)).limit(1))[0]) return ref;
  }
  throw new Error("Could not allocate an order reference");
}

/** Phone as comparable digits: last 8 digits, so "+961 70 123 456" and "70123456" match. */
export const phoneKey = (p: string) => p.replace(/\D/g, "").slice(-8);
const PHONE_KEY_SQL = sql`right(regexp_replace(${orders.customerPhone}, '[^0-9]', '', 'g'), 8)`;

/**
 * Per person (same email OR same phone) per event: a cap across their live orders.
 * With no sign-in and no payment up front, this is what stops one person taking a whole tier.
 * Comps and walk-in (door) sales don't count. Cancelled orders don't count.
 */
async function assertBuyerLimits(t: Tx, event: Event, input: CheckoutInput) {
  const mine = (await t
      .select({ quantity: orders.quantity })
      .from(orders)
      .where(
        and(
          eq(orders.eventId, event.id),
          eq(orders.isComp, false),
          eq(orders.channel, "ONLINE"),
          or(eq(orders.customerEmail, input.customerEmail), eq(PHONE_KEY_SQL, phoneKey(input.customerPhone))),
          inArray(orders.status, LIVE_ORDER_STATUSES),
        ),
      ));
  const have = mine.reduce((n, o) => n + o.quantity, 0);
  if (have + input.quantity > event.maxPerBuyer)
    throw new DomainError(
      "BUYER_LIMIT",
      have
        ? `The limit is ${event.maxPerBuyer} tickets per person for this event and you already have ${have}. Open "My tickets" to find them.`
        : `The limit is ${event.maxPerBuyer} tickets per person for this event.`,
      409,
    );
}

/** A second tap on "Confirm" within this window returns the first order instead of making another. */
const DOUBLE_TAP_MS = 60_000;

/**
 * Confirm attendance: the order and its QR tickets exist immediately, unpaid. The guest pays
 * later (Whish/Neo screenshot, or cash at the door); payment is tracked on each ticket.
 */
export async function confirm(slug: string, input: CheckoutInput, at = now()) {
  return (await tx(async (t) => {
      const event = (await t.select().from(events).where(and(eq(events.slug, slug), eq(events.published, true))).limit(1))[0];
      if (!event) throw new DomainError("EVENT_NOT_FOUND", "This event is not available.", 404);
      if (at > event.startsAt + SALES_CLOSE_AFTER_START_MS)
        throw new DomainError("SALES_CLOSED", "Tickets for this event are no longer available.", 409);
      if (input.quantity > event.maxPerOrder)
        throw new DomainError("QTY_LIMIT", `You can get up to ${event.maxPerOrder} tickets at a time.`);

      const twin = (await t
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.eventId, event.id),
                eq(orders.waveId, input.waveId),
                eq(orders.quantity, input.quantity),
                eq(orders.customerEmail, input.customerEmail),
                eq(PHONE_KEY_SQL, phoneKey(input.customerPhone)),
                eq(orders.status, "CONFIRMED"),
                gt(orders.createdAt, at - DOUBLE_TAP_MS),
              ),
            )
            .limit(1))[0];
      if (twin) return twin;
      (await assertBuyerLimits(t, event, input));

      // The stock check and the insert share one serialized transaction (see db/client.ts),
      // so two guests can never both take the last ticket.
      const wave = (await waveViews(t, event.id, at)).find((w) => w.id === input.waveId);
      if (!wave) throw new DomainError("WAVE_NOT_FOUND", "That ticket type doesn't exist.", 404);
      if (wave.state === "SOLD_OUT") throw new DomainError("SOLD_OUT", `${wave.name} is fully booked.`, 409);
      if (wave.state !== "ON_SALE") throw new DomainError("WAVE_NOT_ON_SALE", `${wave.name} is not available yet.`, 409);
      if (wave.remaining < input.quantity)
        throw new DomainError("NOT_ENOUGH_LEFT", `Only ${wave.remaining} left in ${wave.name}. Reduce the quantity or pick another option.`, 409);

      const order: Order = {
        id: newId(),
        reference: (await uniqueReference(t)),
        accessToken: secretToken(),
        eventId: event.id,
        waveId: wave.id,
        status: "CONFIRMED",
        quantity: input.quantity,
        unitPriceCents: wave.priceCents,
        totalCents: wave.priceCents * input.quantity,
        isComp: false,
        channel: "ONLINE",
        userId: null,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        expiresAt: null,
        payMethod: null,
        proofKey: null,
        proofMime: null,
        txnRef: null,
        submittedAt: null,
        decidedAt: null,
        decidedBy: null,
        rejectReason: null,
        createdAt: at,
      };
      (await t.insert(orders).values(order).returning());
      (await record(t, {
              actor: "customer",
              entityType: "order",
              entityId: order.id,
              eventId: event.id,
              action: "ORDER_CONFIRMED",
              to: "CONFIRMED",
              at,
              data: {
                reference: order.reference,
                wave: wave.name,
                quantity: order.quantity,
                totalCents: order.totalCents,
                waveRemainingAfter: wave.remaining - input.quantity,
              },
            }));
      // A free tier has nothing to collect: its tickets are born paid.
      (await issueTickets(t, order, "customer", at, wave.priceCents === 0 ? { via: "COMP", by: null } : undefined));
      (await notify.ticketsIssued(t, order, event));
      return order;
    }));
}

/** The guest says "I paid by Whish/Neo" and attaches the screenshot. An admin verifies it. */
export async function submitProof(token: string, file: File | null, method: PayMethod, at = now()) {
  if (!file) throw new DomainError("PROOF_REQUIRED", "Attach a screenshot of your payment.");
  // File first (async, outside the transaction); deleted again if the state change fails.
  const stored = await saveUpload("proofs", file);
  try {
    return (await tx(async (t) => {
          const order = (await t.select().from(orders).where(eq(orders.accessToken, token)).limit(1))[0];
          if (!order) throw new DomainError("ORDER_NOT_FOUND", "Ticket not found.", 404);
          if (order.status === "PENDING_VERIFICATION")
            throw new DomainError("ALREADY_SUBMITTED", "We already have your screenshot and are checking it.", 409);
          if (order.status !== "CONFIRMED") throw new DomainError("ORDER_CHANGED", "This order can no longer accept a payment.", 409);
          const unpaid = (await t.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.orderId, order.id), UNPAID)).limit(1))[0];
          if (!unpaid) throw new DomainError("ALREADY_PAID", "These tickets are already paid.", 409);
          const res = (await t
                  .update(orders)
                  .set({ status: "PENDING_VERIFICATION", submittedAt: at, payMethod: method, proofKey: stored.key, proofMime: stored.mime, rejectReason: null })
                  .where(and(eq(orders.id, order.id), eq(orders.status, "CONFIRMED"))).returning());
          if (res.length !== 1) throw new DomainError("ORDER_CHANGED", "This order can no longer accept a payment.", 409);
          if (order.proofKey) afterCommit(() => removeStored("proofs", order.proofKey!));
          (await record(t, {
                    actor: "customer",
                    entityType: "order",
                    entityId: order.id,
                    eventId: order.eventId,
                    action: "PROOF_SUBMITTED",
                    from: "CONFIRMED",
                    to: "PENDING_VERIFICATION",
                    at,
                    data: { file: stored.mime, method },
                  }));
          return order;
        }));
  } catch (err) {
    await removeStored("proofs", stored.key);
    throw err;
  }
}

/** Tickets that still need paying. Revoked tickets owe nothing. */
const UNPAID = and(isNull(tickets.paidAt), ne(tickets.status, "REVOKED"));

async function issueTickets(t: Tx, order: Order, actor: string, at: number, paid?: { via: PaidVia; by: string | null }) {
  const rows = Array.from({ length: order.quantity }, () => ({
    id: newId(),
    token: secretToken(),
    orderId: order.id,
    eventId: order.eventId,
    attendeeName: order.customerName,
    status: "VALID",
    priceCents: order.unitPriceCents,
    paidAt: paid ? at : null,
    paidVia: paid?.via ?? null,
    paidBy: paid?.by ?? null,
    createdAt: at,
  }));
  (await t.insert(tickets).values(rows).returning());
  for (const r of rows)
    (await record(t, { actor, entityType: "ticket", entityId: r.id, eventId: order.eventId, action: "TICKET_ISSUED", to: "VALID", at }));
  return rows;
}

/** Orders submitted before tickets were issued up front have none yet; give them theirs. */
async function ensureTickets(t: Tx, order: Order, actor: string, at: number) {
  if (!(await t.select({ id: tickets.id }).from(tickets).where(eq(tickets.orderId, order.id)).limit(1))[0])
    (await issueTickets(t, order, actor, at));
}

/**
 * The screenshot checks out: every ticket in the order that is still unpaid becomes paid.
 * Tickets already paid in cash at the door are left alone. Idempotent: approving twice
 * (double click, two admins) changes nothing the second time.
 */
export async function approve(orderId: string, actor: string, at = now()) {
  return (await tx(async (t) => {
      const order = (await t.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
      if (order.status === "APPROVED") return { alreadyApproved: true, newlyPaid: 0 };
      assertOrderTransition(order.status, "APPROVED");
      const res = (await t
            .update(orders)
            .set({ status: "APPROVED", decidedAt: at, decidedBy: actor })
            .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING_VERIFICATION"))).returning());
      if (res.length !== 1) throw new DomainError("ORDER_CHANGED", "Order changed; refresh and try again.", 409);
      (await ensureTickets(t, order, actor, at));
      const via = (order.payMethod ?? "WHISH") as PaidVia;
      // RECEIPT_SEEN tickets were let in on trust at the door; this is the real verification.
      const paid = (await t
            .update(tickets)
            .set({ paidAt: at, paidVia: via, paidBy: actor })
            .where(and(eq(tickets.orderId, orderId), ne(tickets.status, "REVOKED"), or(isNull(tickets.paidAt), eq(tickets.paidVia, "RECEIPT_SEEN")))).returning());
      (await record(t, {
              actor,
              entityType: "order",
              entityId: order.id,
              eventId: order.eventId,
              action: "ORDER_APPROVED",
              from: "PENDING_VERIFICATION",
              to: "APPROVED",
              at,
              data: { reference: order.reference, method: via, ticketsPaid: paid.length, cents: paid.reduce((n, r) => n + r.priceCents, 0), waitedMs: at - (order.submittedAt ?? at) },
            }));
      const event = (await t.select().from(events).where(eq(events.id, order.eventId)).limit(1))[0]!;
      (await notify.paymentVerified(t, order, event));
      return { alreadyApproved: false, newlyPaid: paid.length };
    }));
}

/** The screenshot doesn't check out. The tickets stay valid and unpaid: retry, or pay at the door. */
export async function reject(orderId: string, actor: string, reason: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give the guest a reason.");
  return (await tx(async (t) => {
      const order = (await t.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
      assertOrderTransition(order.status, "CONFIRMED");
      const res = (await t
            .update(orders)
            .set({ status: "CONFIRMED", decidedAt: at, decidedBy: actor, rejectReason: reason.trim() })
            .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING_VERIFICATION"))).returning());
      if (res.length !== 1) throw new DomainError("ORDER_CHANGED", "Order changed; refresh and try again.", 409);
      (await ensureTickets(t, order, actor, at));
      (await record(t, {
              actor,
              entityType: "order",
              entityId: order.id,
              eventId: order.eventId,
              action: "ORDER_REJECTED",
              from: "PENDING_VERIFICATION",
              to: "CONFIRMED",
              at,
              data: { reference: order.reference, reason: reason.trim() },
            }));
      const event = (await t.select().from(events).where(eq(events.id, order.eventId)).limit(1))[0]!;
      (await notify.orderRejected(t, order, event, reason.trim()));
    }));
}

/** Cancel a no-show or fake sign-up: its tickets stop working and its spots go back to the tier. */
export async function cancel(orderId: string, actor: string, reason: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give a reason for cancelling.");
  return (await tx(async (t) => {
      const order = (await t.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
      assertOrderTransition(order.status, "CANCELLED");
      const mine = (await t.select().from(tickets).where(eq(tickets.orderId, orderId)));
      if (mine.some((r) => r.status === "CHECKED_IN"))
        throw new DomainError("HAS_ENTRIES", "Someone on this order is already inside. Revoke the unused tickets one by one instead.", 409);
      const res = (await t
            .update(orders)
            .set({ status: "CANCELLED", decidedAt: at, decidedBy: actor, rejectReason: reason.trim() })
            .where(and(eq(orders.id, orderId), eq(orders.status, order.status))).returning());
      if (res.length !== 1) throw new DomainError("ORDER_CHANGED", "Order changed; refresh and try again.", 409);
      (await t.update(tickets)
              .set({ status: "REVOKED", revokedAt: at, revokeReason: `Order cancelled: ${reason.trim()}` })
              .where(and(eq(tickets.orderId, orderId), eq(tickets.status, "VALID"))).returning());
      (await record(t, {
              actor,
              entityType: "order",
              entityId: order.id,
              eventId: order.eventId,
              action: "ORDER_CANCELLED",
              from: order.status,
              to: "CANCELLED",
              at,
              data: { reference: order.reference, reason: reason.trim(), freed: order.quantity },
            }));
    }));
}

/** Complimentary tickets: an APPROVED $0 order with no wave, so it never uses wave stock. */
export async function createComp(input: CompInput, actor: string, at = now()) {
  return (await tx(async (t) => {
      const event = (await t.select().from(events).where(eq(events.id, input.eventId)).limit(1))[0];
      if (!event) throw new DomainError("EVENT_NOT_FOUND", "Event not found.", 404);
      const order: Order = {
        id: newId(),
        reference: (await uniqueReference(t)),
        accessToken: secretToken(),
        eventId: event.id,
        waveId: null,
        status: "APPROVED",
        quantity: input.quantity,
        unitPriceCents: 0,
        totalCents: 0,
        isComp: true,
        channel: "ONLINE",
        userId: null,
        customerName: input.attendeeName,
        customerEmail: input.email,
        customerPhone: input.phone,
        expiresAt: null,
        payMethod: null,
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
              eventId: event.id,
              action: "COMP_CREATED",
              to: "APPROVED",
              at,
              data: { reference: order.reference, quantity: input.quantity, note: input.note ?? null },
            }));
      (await issueTickets(t, order, actor, at, { via: "COMP", by: actor }));
      (await notify.ticketsIssued(t, order, event));
      return order;
    }));
}

/** Email the ticket PDF again (customer lost it, typo fixed, first send failed). */
export async function resendTickets(orderId: string, actor: string, at = now()) {
  (await tx(async (t) => {
        const order = (await t.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
        if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.", 404);
        if (!LIVE_ORDER_STATUSES.includes(order.status)) throw new DomainError("NO_TICKETS", "This order has no working tickets to send.", 409);
        const event = (await t.select().from(events).where(eq(events.id, order.eventId)).limit(1))[0]!;
        (await record(t, { actor, entityType: "order", entityId: order.id, eventId: order.eventId, action: "TICKETS_RESENT", at, data: { to: order.customerEmail } }));
        (await notify.ticketsIssued(t, order, event));
      }));
}

// ---------- reads ----------

async function loadOrder(where: SQL) {
  const row = (await db()
      .select({ order: orders, event: events, wave: waves })
      .from(orders)
      .innerJoin(events, eq(events.id, orders.eventId))
      .leftJoin(waves, eq(waves.id, orders.waveId))
      .where(where).limit(1))[0];
  if (!row) return null;
  const ticketRows = (await db().select().from(tickets).where(eq(tickets.orderId, row.order.id)).orderBy(tickets.createdAt));
  return {
    ...row,
    status: effectiveOrderStatus(row.order, now()),
    tickets: ticketRows,
    /** What is still owed across this order's working tickets. */
    dueCents: ticketRows.filter((r) => r.paidAt === null && r.status !== "REVOKED").reduce((n, r) => n + r.priceCents, 0),
    timeline: (await orderTimeline(
          row.order.id,
          ticketRows.map((r) => r.id),
        )),
  };
}

export const getByToken = async (token: string) => (await loadOrder(eq(orders.accessToken, token)));
export const getById = async (id: string) => (await loadOrder(eq(orders.id, id)));

export type OrderFilter = { status?: string; eventId?: string; q?: string };

export async function list(f: OrderFilter = {}) {
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
  return (await db()
      .select({
        order: orders,
        eventTitle: events.title,
        waveName: waves.name,
        ticketCount: sql<number>`(select count(*) from tickets t where t.order_id = ${orders.id} and t.status <> 'REVOKED')`,
        paidCount: sql<number>`(select count(*) from tickets t where t.order_id = ${orders.id} and t.status <> 'REVOKED' and t.paid_at is not null)`,
      })
      .from(orders)
      .innerJoin(events, eq(events.id, orders.eventId))
      .leftJoin(waves, eq(waves.id, orders.waveId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(orders.createdAt))
      .limit(300))
    .map((r) => ({ ...r, ticketCount: Number(r.ticketCount), paidCount: Number(r.paidCount), status: effectiveOrderStatus(r.order, at) }));
}

/** Working tickets nobody has paid for yet, across all events. */
export async function unpaidTickets() {
  return (await db().select({ n: count() }).from(tickets).where(UNPAID).limit(1))[0]!.n;
}

export async function countByStatus(statuses: OrderStatus[]) {
  return (await db().select({ n: count() }).from(orders).where(inArray(orders.status, statuses)).limit(1))[0]!.n;
}
