// The journal: one append-only row per thing that happened. Every state change in the
// services writes here inside the same transaction as the change itself, so the journal
// can never disagree with the data.
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { now } from "../clock.ts";
import { db, type Exec } from "../db/client.ts";
import { journal, users, type JournalRow } from "../db/schema.ts";

export type Actor = string; // user id | "customer" | "system"

export type Entry = {
  actor: Actor;
  entityType: "order" | "ticket" | "event" | "wave" | "user" | "scan" | "system";
  entityId?: string | null;
  eventId?: string | null;
  action: string;
  from?: string | null;
  to?: string | null;
  data?: Record<string, unknown>;
  at?: number;
};

export async function record(x: Exec, e: Entry) {
  (await x.insert(journal)
        .values({
          at: e.at ?? now(),
          actor: e.actor,
          entityType: e.entityType,
          entityId: e.entityId ?? null,
          eventId: e.eventId ?? null,
          action: e.action,
          fromStatus: e.from ?? null,
          toStatus: e.to ?? null,
          data: e.data ? JSON.stringify(e.data) : null,
        }).returning());
}

export type TimelineRow = JournalRow & { actorName: string; parsed: Record<string, unknown> | null };

async function withActorNames(rows: JournalRow[]): Promise<TimelineRow[]> {
  const ids = [...new Set(rows.map((r) => r.actor).filter((a) => a !== "customer" && a !== "system"))];
  const names = new Map(
    ids.length
      ? (await db().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name])
      : [],
  );
  return rows.map((r) => ({
    ...r,
    actorName: names.get(r.actor) ?? r.actor,
    parsed: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null,
  }));
}

/** Everything that happened to an order and its tickets, oldest first. */
export async function orderTimeline(orderId: string, ticketIds: string[]) {
  const isOrder = and(eq(journal.entityType, "order"), eq(journal.entityId, orderId));
  const where = ticketIds.length
    ? or(isOrder, and(eq(journal.entityType, "ticket"), inArray(journal.entityId, ticketIds)))
    : isOrder;
  return (await withActorNames((await db().select().from(journal).where(where).orderBy(journal.id))));
}

export async function entityTimeline(entityType: Entry["entityType"], entityId: string) {
  return (await withActorNames(
      (await db()
              .select()
              .from(journal)
              .where(and(eq(journal.entityType, entityType), eq(journal.entityId, entityId)))
              .orderBy(journal.id)),
    ));
}

export type FeedFilter = { eventId?: string; entityType?: string; entityId?: string; action?: string; before?: number; limit?: number };

/** Newest first, for /admin/trace. `before` is a journal id for paging. */
export async function feed(f: FeedFilter = {}) {
  const conds: SQL[] = [];
  if (f.eventId) conds.push(eq(journal.eventId, f.eventId));
  if (f.entityType) conds.push(eq(journal.entityType, f.entityType));
  if (f.entityId) conds.push(eq(journal.entityId, f.entityId));
  if (f.action) conds.push(eq(journal.action, f.action));
  if (f.before) conds.push(lt(journal.id, f.before));
  return (await withActorNames(
      (await db()
              .select()
              .from(journal)
              .where(conds.length ? and(...conds) : undefined)
              .orderBy(desc(journal.id))
              .limit(Math.min(f.limit ?? 100, 500))),
    ));
}
