// Attendee list for an event: one row per ticket, with its order and check-in state.
import { and, asc, eq, like, or, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { orders, tickets, waves } from "../db/schema.ts";

export type AttendeeFilter = { q?: string; state?: "in" | "out" | "revoked" };

export function list(eventId: string, f: AttendeeFilter = {}) {
  const conds: SQL[] = [eq(tickets.eventId, eventId)];
  if (f.state === "in") conds.push(eq(tickets.status, "CHECKED_IN"));
  if (f.state === "out") conds.push(eq(tickets.status, "VALID"));
  if (f.state === "revoked") conds.push(eq(tickets.status, "REVOKED"));
  if (f.q?.trim()) {
    const q = `%${f.q.trim()}%`;
    conds.push(
      or(
        like(tickets.attendeeName, q),
        like(orders.customerEmail, q.toLowerCase()),
        like(orders.customerPhone, q),
        like(orders.reference, q.toUpperCase()),
      )!,
    );
  }
  return db()
    .select({ ticket: tickets, order: orders, wave: waves.name })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .leftJoin(waves, eq(waves.id, orders.waveId))
    .where(and(...conds))
    .orderBy(asc(tickets.attendeeName), asc(tickets.createdAt))
    .all();
}

/** Counts for the filter chips (always over the whole event, not the current search). */
export function counts(eventId: string) {
  const rows = db().select({ status: tickets.status }).from(tickets).where(eq(tickets.eventId, eventId)).all();
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  return { all: rows.length, in: n("CHECKED_IN"), out: n("VALID"), revoked: n("REVOKED") };
}
