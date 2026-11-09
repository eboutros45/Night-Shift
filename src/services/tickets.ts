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
export async function checkIn(eventId: string, code: string, actor: string, at = now()): Promise<ScanOutcome> {
  const token = extractToken(code);
  return (await tx(async (t) => {
      const log = async (o: ScanOutcome, admitted = false) => {
        (await record(t, {
                  actor,
                  entityType: o.ticketId ? "ticket" : "scan",
                  entityId: o.ticketId ?? null,
                  eventId,
                  action: "SCAN",
                  from: admitted ? "VALID" : null,
                  to: admitted ? "CHECKED_IN" : null,
                  at,
                  data: { result: o.result, ...(o.ticketId ? {} : { code: token.slice(0, 40) }) },
                }));
        return o;
      };
      if (!TOKEN_PATTERN.test(token)) return (await log({ result: "INVALID" }));

      const admitted = (await t
            .update(tickets)
            .set({ status: "CHECKED_IN", checkedInAt: at, checkedInBy: actor })
            .where(and(eq(tickets.token, token), eq(tickets.eventId, eventId), eq(tickets.status, "VALID"))).returning());
      const ticket = (await t.select().from(tickets).where(eq(tickets.token, token)).limit(1))[0];
      if (!ticket) return (await log({ result: "INVALID" }));
      const base = { attendeeName: ticket.attendeeName, ticketId: ticket.id };
      if (admitted.length === 1) return (await log({ result: "ADMITTED", ...base, checkedInAt: at }, true));
      if (ticket.eventId !== eventId) {
        const other = (await t.select({ title: events.title }).from(events).where(eq(events.id, ticket.eventId)).limit(1))[0];
        return (await log({ result: "WRONG_EVENT", ...base, otherEvent: other?.title ?? "another event" }));
      }
      if (ticket.status === "CHECKED_IN") return (await log({ result: "ALREADY_USED", ...base, checkedInAt: ticket.checkedInAt }));
      if (ticket.status === "REVOKED") return (await log({ result: "REVOKED", ...base, reason: ticket.revokeReason }));
      return (await log({ result: "INVALID", ...base }));
    }));
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
