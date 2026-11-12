// Door check-in and revocation.
import { and, count, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { now } from "../clock.ts";
import { db, tx, type Tx } from "../db/client.ts";
import { events, orders, tickets, users, type Ticket } from "../db/schema.ts";
import { assertTicketTransition, DomainError, type PaidVia, type ScanResult } from "../domain/status.ts";
import { TOKEN_PATTERN } from "../lib/ids.ts";
import { record } from "./journal.ts";

/** The QR holds the bare token. Also accept a pasted ticket URL ending in the token. */
export function extractToken(code: string) {
  const c = code.trim();
  const m = c.match(/([A-Za-z0-9_-]{22})(?:[/?#].*)?$/);
  return m ? m[1]! : c;
}

export type ScanOutcome = {
  result: ScanResult;
  attendeeName?: string;
  checkedInAt?: number | null;
  reason?: string | null;
  otherEvent?: string;
  ticketId?: string;
  /** How an admitted ticket was paid. */
  paidVia?: string | null;
  /** PAYMENT_DUE: what to collect before letting this person in. */
  dueCents?: number;
  /** PAYMENT_DUE: the guest sent a Whish/Neo screenshot that no admin has verified yet. */
  proofPending?: boolean;
  payMethod?: string | null;
};

/** Why a ticket that was not admitted just now can't be: used, revoked, another event, or unpaid. */
async function refusal(t: Tx, ticket: Ticket, eventId: string): Promise<ScanOutcome> {
  const base = { attendeeName: ticket.attendeeName, ticketId: ticket.id };
  if (ticket.eventId !== eventId) {
    const other = (await t.select({ title: events.title }).from(events).where(eq(events.id, ticket.eventId)).limit(1))[0];
    return { result: "WRONG_EVENT", ...base, otherEvent: other?.title ?? "another event" };
  }
  if (ticket.status === "CHECKED_IN") return { result: "ALREADY_USED", ...base, checkedInAt: ticket.checkedInAt };
  if (ticket.status === "REVOKED") return { result: "REVOKED", ...base, reason: ticket.revokeReason };
  if (ticket.status === "VALID" && ticket.paidAt === null) {
    const order = (await t.select({ status: orders.status, payMethod: orders.payMethod }).from(orders).where(eq(orders.id, ticket.orderId)).limit(1))[0];
    const proofPending = order?.status === "PENDING_VERIFICATION";
    return { result: "PAYMENT_DUE", ...base, dueCents: ticket.priceCents, proofPending, payMethod: proofPending ? order?.payMethod ?? "WHISH" : null };
  }
  return { result: "INVALID", ...base };
}

async function logScan(t: Tx, eventId: string, actor: string, at: number, o: ScanOutcome, code?: string) {
  const admitted = o.result === "ADMITTED";
  (await record(t, {
        actor,
        entityType: o.ticketId ? "ticket" : "scan",
        entityId: o.ticketId ?? null,
        eventId,
        action: "SCAN",
        from: admitted ? "VALID" : null,
        to: admitted ? "CHECKED_IN" : null,
        at,
        data: { result: o.result, ...(o.ticketId ? { name: o.attendeeName } : { code: (code ?? "").slice(0, 40) }), ...(o.result === "PAYMENT_DUE" ? { dueCents: o.dueCents } : {}) },
      }));
  return o;
}

/**
 * One conditional UPDATE decides admission, so two phones scanning the same QR at the same
 * moment admit it exactly once. Only a PAID ticket is admitted by a scan; an unpaid one comes
 * back as PAYMENT_DUE and changes nothing (see collectAndAdmit). Every scan is one journal row.
 */
export async function checkIn(eventId: string, code: string, actor: string, at = now()): Promise<ScanOutcome> {
  const token = extractToken(code);
  return (await tx(async (t) => {
      if (!TOKEN_PATTERN.test(token)) return (await logScan(t, eventId, actor, at, { result: "INVALID" }, token));
      const admitted = (await t
            .update(tickets)
            .set({ status: "CHECKED_IN", checkedInAt: at, checkedInBy: actor })
            .where(and(eq(tickets.token, token), eq(tickets.eventId, eventId), eq(tickets.status, "VALID"), isNotNull(tickets.paidAt))).returning())[0];
      if (admitted)
        return (await logScan(t, eventId, actor, at, { result: "ADMITTED", attendeeName: admitted.attendeeName, ticketId: admitted.id, checkedInAt: at, paidVia: admitted.paidVia }));
      const ticket = (await t.select().from(tickets).where(eq(tickets.token, token)).limit(1))[0];
      if (!ticket) return (await logScan(t, eventId, actor, at, { result: "INVALID" }, token));
      return (await logScan(t, eventId, actor, at, (await refusal(t, ticket, eventId))));
    }));
}

/**
 * The door took payment for an unpaid ticket: mark it paid and let the person in, in one
 * conditional UPDATE, so two staff can never both collect for (or both admit) the same ticket.
 * CASH: money in hand. RECEIPT_SEEN: staff looked at the guest's Whish/Neo receipt; only
 * allowed while a screenshot is waiting for an admin, who still verifies it afterwards.
 */
export async function collectAndAdmit(eventId: string, ticketId: string, via: "CASH" | "RECEIPT_SEEN", actor: string, at = now()): Promise<ScanOutcome> {
  return (await tx(async (t) => {
      const ticket = (await t.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1))[0];
      if (!ticket) throw new DomainError("NOT_FOUND", "Ticket not found. Scan it again.", 404);
      if (via === "RECEIPT_SEEN") {
        const order = (await t.select({ status: orders.status }).from(orders).where(eq(orders.id, ticket.orderId)).limit(1))[0];
        if (order?.status !== "PENDING_VERIFICATION")
          throw new DomainError("NO_PROOF", "This guest hasn't sent a payment screenshot. Collect cash instead.", 409);
      }
      const done = (await t
            .update(tickets)
            .set({ paidAt: at, paidVia: via satisfies PaidVia, paidBy: actor, status: "CHECKED_IN", checkedInAt: at, checkedInBy: actor })
            .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId), eq(tickets.status, "VALID"), isNull(tickets.paidAt))).returning())[0];
      if (!done) {
        // Paid or admitted elsewhere a moment ago (or wrong event): report what is true now, admit nothing.
        const o = (await refusal(t, ticket, eventId));
        return (await logScan(t, eventId, actor, at, o.result === "INVALID" ? { ...o, result: "ALREADY_USED", checkedInAt: ticket.checkedInAt } : o));
      }
      (await record(t, {
              actor,
              entityType: "ticket",
              entityId: ticketId,
              eventId,
              action: "PAYMENT_COLLECTED",
              at,
              data: { via, cents: done.priceCents },
            }));
      return (await logScan(t, eventId, actor, at, { result: "ADMITTED", attendeeName: done.attendeeName, ticketId, checkedInAt: at, paidVia: via }));
    }));
}

/** Cash taken at the door for tickets that were confirmed in advance, per staff member. Walk-in sales are separate. */
export async function doorCash(eventId: string) {
  return (await db()
      .select({ staffId: tickets.paidBy, name: users.name, tickets: sql<number>`count(*)`, cents: sql<number>`sum(${tickets.priceCents})` })
      .from(tickets)
      .innerJoin(orders, eq(orders.id, tickets.orderId))
      .leftJoin(users, eq(users.id, tickets.paidBy))
      .where(and(eq(tickets.eventId, eventId), eq(tickets.paidVia, "CASH"), eq(orders.channel, "ONLINE"), ne(tickets.status, "REVOKED")))
      .groupBy(tickets.paidBy, users.name)
      .orderBy(desc(sql`sum(${tickets.priceCents})`)))
    .map((r) => ({ ...r, tickets: Number(r.tickets), cents: Number(r.cents) }));
}

export async function revoke(ticketId: string, actor: string, reason: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give a reason for revoking.");
  (await tx(async (t) => {
        const ticket = (await t.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1))[0];
        if (!ticket) throw new DomainError("NOT_FOUND", "Ticket not found.", 404);
        assertTicketTransition(ticket.status, "REVOKED");
        const res = (await t
              .update(tickets)
              .set({ status: "REVOKED", revokedAt: at, revokeReason: reason.trim() })
              .where(and(eq(tickets.id, ticketId), eq(tickets.status, "VALID"))).returning());
        if (res.length !== 1) throw new DomainError("TICKET_CHANGED", "Ticket changed (maybe just scanned). Refresh.", 409);
        (await record(t, {
                actor,
                entityType: "ticket",
                entityId: ticketId,
                eventId: ticket.eventId,
                action: "TICKET_REVOKED",
                from: "VALID",
                to: "REVOKED",
                at,
                data: { reason: reason.trim() },
              }));
      }));
}

export async function doorCounts(eventId: string) {
  const n = async (where: ReturnType<typeof and>) => (await db().select({ n: count() }).from(tickets).where(where).limit(1))[0]!.n;
  return {
    checkedIn: (await n(and(eq(tickets.eventId, eventId), eq(tickets.status, "CHECKED_IN")))),
    total: (await n(and(eq(tickets.eventId, eventId), ne(tickets.status, "REVOKED")))),
  };
}
