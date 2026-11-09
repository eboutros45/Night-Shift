// Door check-in and revocation.
import { and, count, eq, ne } from "drizzle-orm";
import { now } from "../clock.ts";
import { db, tx } from "../db/client.ts";
import { events, tickets } from "../db/schema.ts";
import { assertTicketTransition, DomainError, type ScanResult } from "../domain/status.ts";
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
};

/**
 * One conditional UPDATE decides admission, so two phones scanning the same QR at the same
 * moment admit it exactly once. Every scan, admitted or not, becomes one journal row.
 */
export function checkIn(eventId: string, code: string, actor: string, at = now()): ScanOutcome {
  const token = extractToken(code);
  return tx((t) => {
    const log = (o: ScanOutcome, admitted = false) => {
      record(t, {
        actor,
        entityType: o.ticketId ? "ticket" : "scan",
        entityId: o.ticketId ?? null,
        eventId,
        action: "SCAN",
        from: admitted ? "VALID" : null,
        to: admitted ? "CHECKED_IN" : null,
        at,
        data: { result: o.result, ...(o.ticketId ? {} : { code: token.slice(0, 40) }) },
      });
      return o;
    };
    if (!TOKEN_PATTERN.test(token)) return log({ result: "INVALID" });

    const admitted = t
      .update(tickets)
      .set({ status: "CHECKED_IN", checkedInAt: at, checkedInBy: actor })
      .where(and(eq(tickets.token, token), eq(tickets.eventId, eventId), eq(tickets.status, "VALID")))
      .run();
    const ticket = t.select().from(tickets).where(eq(tickets.token, token)).get();
    if (!ticket) return log({ result: "INVALID" });
    const base = { attendeeName: ticket.attendeeName, ticketId: ticket.id };
    if (admitted.changes === 1) return log({ result: "ADMITTED", ...base, checkedInAt: at }, true);
    if (ticket.eventId !== eventId) {
      const other = t.select({ title: events.title }).from(events).where(eq(events.id, ticket.eventId)).get();
      return log({ result: "WRONG_EVENT", ...base, otherEvent: other?.title ?? "another event" });
    }
    if (ticket.status === "CHECKED_IN") return log({ result: "ALREADY_USED", ...base, checkedInAt: ticket.checkedInAt });
    if (ticket.status === "REVOKED") return log({ result: "REVOKED", ...base, reason: ticket.revokeReason });
    return log({ result: "INVALID", ...base });
  });
}

export function revoke(ticketId: string, actor: string, reason: string, at = now()) {
  if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Give a reason for revoking.");
  tx((t) => {
    const ticket = t.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!ticket) throw new DomainError("NOT_FOUND", "Ticket not found.", 404);
    assertTicketTransition(ticket.status, "REVOKED");
    const res = t
      .update(tickets)
      .set({ status: "REVOKED", revokedAt: at, revokeReason: reason.trim() })
      .where(and(eq(tickets.id, ticketId), eq(tickets.status, "VALID")))
      .run();
    if (res.changes !== 1) throw new DomainError("TICKET_CHANGED", "Ticket changed (maybe just scanned). Refresh.", 409);
    record(t, {
      actor,
      entityType: "ticket",
      entityId: ticketId,
      eventId: ticket.eventId,
      action: "TICKET_REVOKED",
      from: "VALID",
      to: "REVOKED",
      at,
      data: { reason: reason.trim() },
    });
  });
}

export function doorCounts(eventId: string) {
  const n = (where: ReturnType<typeof and>) => db().select({ n: count() }).from(tickets).where(where).get()!.n;
  return {
    checkedIn: n(and(eq(tickets.eventId, eventId), eq(tickets.status, "CHECKED_IN"))),
    total: n(and(eq(tickets.eventId, eventId), ne(tickets.status, "REVOKED"))),
  };
}
