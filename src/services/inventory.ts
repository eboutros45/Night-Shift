// Wave stock is derived from orders, never stored. A wave "holds" every ticket in an order
// that is pending verification or approved, plus unpaid orders whose hold has not run out.
// So an expired hold frees its tickets the instant it expires: no counter, no release step.
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { now } from "../clock.ts";
import { tx, type Exec } from "../db/client.ts";
import { orders, waves } from "../db/schema.ts";
import { computeWaveStates } from "../domain/waves.ts";
import { record } from "./journal.ts";

export async function heldByWave(x: Exec, eventId: string, at: number) {
  const rows = (await x
      .select({ waveId: orders.waveId, held: sql<number>`sum(${orders.quantity})` })
      .from(orders)
      .where(
        and(
          eq(orders.eventId, eventId),
          isNotNull(orders.waveId),
          or(
            inArray(orders.status, ["PENDING_VERIFICATION", "APPROVED"]),
            and(eq(orders.status, "AWAITING_PAYMENT"), gt(orders.expiresAt, at)),
          ),
        ),
      )
      .groupBy(orders.waveId));
  return new Map(rows.map((r) => [r.waveId!, Number(r.held)]));
}

/** Two queries for all requested events, instead of two per event. */
export async function waveViewsForEvents(x: Exec, eventIds: string[], at = now()) {
  if (!eventIds.length) return new Map<string, ReturnType<typeof computeWaveStates>>();
  const [heldRows, allWaves] = await Promise.all([
    x.select({ waveId: orders.waveId, held: sql<number>`sum(${orders.quantity})` }).from(orders)
      .where(and(inArray(orders.eventId, eventIds), isNotNull(orders.waveId), or(
        inArray(orders.status, ["PENDING_VERIFICATION", "APPROVED"]),
        and(eq(orders.status, "AWAITING_PAYMENT"), gt(orders.expiresAt, at)))))
      .groupBy(orders.waveId),
    x.select().from(waves).where(inArray(waves.eventId, eventIds)).orderBy(asc(waves.position)),
  ]);
  const held = new Map(heldRows.map(row => [row.waveId, Number(row.held)]));
  const grouped = new Map<string, typeof allWaves>();
  for (const wave of allWaves) {
    const group = grouped.get(wave.eventId) ?? [];
    group.push(wave); grouped.set(wave.eventId, group);
  }
  return new Map(eventIds.map(id => [id, computeWaveStates((grouped.get(id) ?? []).map(wave => ({ ...wave, held: held.get(wave.id) ?? 0 })), at)]));
}
export async function waveViews(x: Exec, eventId: string, at = now()) {
  return (await waveViewsForEvents(x, [eventId], at)).get(eventId)!;
}

/**
 * Writes down expiries that have already happened (status is computed on read regardless,
 * see effectiveOrderStatus). Records each one in the journal as done by "system" at the
 * moment the hold actually ran out, not when the sweep noticed.
 */
export async function sweepExpired(at = now()) {
  return (await tx(async (t) => {
      const stale = (await t
            .select({ id: orders.id, eventId: orders.eventId, expiresAt: orders.expiresAt, reference: orders.reference })
            .from(orders)
            .where(and(eq(orders.status, "AWAITING_PAYMENT"), lte(orders.expiresAt, at))));
      for (const o of stale) {
        const res = (await t
                .update(orders)
                .set({ status: "EXPIRED", decidedAt: o.expiresAt, decidedBy: "system" })
                .where(and(eq(orders.id, o.id), eq(orders.status, "AWAITING_PAYMENT"))).returning());
        if (res.length === 1)
          (await record(t, {
                      actor: "system",
                      entityType: "order",
                      entityId: o.id,
                      eventId: o.eventId,
                      action: "ORDER_EXPIRED",
                      from: "AWAITING_PAYMENT",
                      to: "EXPIRED",
                      at: o.expiresAt!,
                      data: { reference: o.reference, noticedAt: at },
                    }));
      }
      return stale.length;
    }));
}

let lastSweep = 0;
/** At most once a minute; called from request middleware so no background timer is needed. */
export async function sweepExpiredThrottled() {
  const t = now();
  if (t - lastSweep < 60_000) return;
  lastSweep = t;
  (await sweepExpired(t));
}

export const _resetSweepThrottle = () => {
  lastSweep = 0;
};
