// Events and their waves.
import { and, asc, count, desc, eq, gt, max, sql } from "drizzle-orm";
import { now } from "../clock.ts";
import { db, tx, type Tx } from "../db/client.ts";
import { events, orders, tickets, waves, type Event } from "../db/schema.ts";
import type { EventInput, LineupItem, WaveInput } from "../domain/inputs.ts";
import { DomainError } from "../domain/status.ts";
import { eventSaleState, fromPrice } from "../domain/waves.ts";
import { newId } from "../lib/ids.ts";
import { waveViews } from "./inventory.ts";
import { record } from "./journal.ts";

const SHOW_AFTER_START_MS = 6 * 3600_000;

export const lineupOf = (e: Event) => JSON.parse(e.lineup) as LineupItem[];

function assertSlugFree(t: Tx, slug: string, exceptId?: string) {
  const hit = t.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get();
  if (hit && hit.id !== exceptId) throw new DomainError("SLUG_TAKEN", `The slug "${slug}" is already used.`, 409);
}

const toRow = (i: EventInput) => ({ ...i, lineup: JSON.stringify(i.lineup) });

// ---------- public ----------

export function listPublic(at = now()) {
  return db()
    .select()
    .from(events)
    .where(and(eq(events.published, true), gt(events.startsAt, at - SHOW_AFTER_START_MS)))
    .orderBy(asc(events.startsAt))
    .all()
    .map((e) => {
      const waves = waveViews(db(), e.id, at);
      return { event: e, waves, sale: eventSaleState(waves), from: fromPrice(waves), low: waves.some((w) => w.low) };
    });
}

export function getPublic(slug: string, at = now()) {
  const event = db().select().from(events).where(and(eq(events.slug, slug), eq(events.published, true))).get();
  if (!event) return null;
  const w = waveViews(db(), event.id, at);
  return { event, waves: w, sale: eventSaleState(w), salesOpen: at <= event.startsAt + SHOW_AFTER_START_MS };
}

// ---------- admin ----------

export function listAdmin() {
  const at = now();
  const sold = new Map(
    db()
      .select({ eventId: tickets.eventId, n: count() })
      .from(tickets)
      .where(sql`${tickets.status} != 'REVOKED'`)
      .groupBy(tickets.eventId)
      .all()
      .map((r) => [r.eventId, r.n]),
  );
  const pending = new Map(
    db()
      .select({ eventId: orders.eventId, n: count() })
      .from(orders)
      .where(eq(orders.status, "PENDING_VERIFICATION"))
      .groupBy(orders.eventId)
      .all()
      .map((r) => [r.eventId, r.n]),
  );
  return db()
    .select()
    .from(events)
    .orderBy(desc(events.startsAt))
    .all()
    .map((e) => {
      const waves = waveViews(db(), e.id, at);
      return {
        event: e,
        waves,
        held: waves.reduce((n, w) => n + w.held, 0),
        capacity: waves.reduce((n, w) => n + w.capacity, 0),
        ticketsIssued: sold.get(e.id) ?? 0,
        pendingOrders: pending.get(e.id) ?? 0,
        sale: eventSaleState(waves),
      };
    });
}

export function getAdmin(id: string) {
  const event = db().select().from(events).where(eq(events.id, id)).get();
  if (!event) return null;
  return { event, waves: waveViews(db(), id) };
}

export function create(input: EventInput, actor: string) {
  return tx((t) => {
    assertSlugFree(t, input.slug);
    const id = newId();
    const at = now();
    t.insert(events).values({ id, ...toRow(input), createdAt: at, updatedAt: at }).run();
    record(t, { actor, entityType: "event", entityId: id, eventId: id, action: "EVENT_CREATED", data: { title: input.title } });
    return id;
  });
}

export function update(id: string, input: EventInput, actor: string) {
  tx((t) => {
    const before = t.select().from(events).where(eq(events.id, id)).get();
    if (!before) throw new DomainError("NOT_FOUND", "Event not found.", 404);
    assertSlugFree(t, input.slug, id);
    const row = toRow(input);
    t.update(events).set({ ...row, updatedAt: now() }).where(eq(events.id, id)).run();
    const changed = Object.keys(row).filter((k) => String(before[k as keyof Event]) !== String(row[k as keyof typeof row]));
    record(t, { actor, entityType: "event", entityId: id, eventId: id, action: "EVENT_UPDATED", data: { changed } });
  });
}

export function setPublished(id: string, published: boolean, actor: string) {
  tx((t) => {
    const e = t.select().from(events).where(eq(events.id, id)).get();
    if (!e) throw new DomainError("NOT_FOUND", "Event not found.", 404);
    if (published && !t.select({ id: waves.id }).from(waves).where(eq(waves.eventId, id)).get())
      throw new DomainError("NO_WAVES", "Add at least one wave before publishing.", 409);
    t.update(events).set({ published, updatedAt: now() }).where(eq(events.id, id)).run();
    record(t, {
      actor,
      entityType: "event",
      entityId: id,
      eventId: id,
      action: published ? "EVENT_PUBLISHED" : "EVENT_UNPUBLISHED",
      from: e.published ? "published" : "draft",
      to: published ? "published" : "draft",
    });
  });
}

export function setPoster(id: string, posterKey: string | null, actor: string) {
  tx((t) => {
    t.update(events).set({ posterKey, updatedAt: now() }).where(eq(events.id, id)).run();
    record(t, { actor, entityType: "event", entityId: id, eventId: id, action: "EVENT_POSTER_SET", data: { posterKey } });
  });
}

/** Copy an event and its waves (no orders) as an unpublished draft. */
export function duplicate(id: string, actor: string) {
  return tx((t) => {
    const e = t.select().from(events).where(eq(events.id, id)).get();
    if (!e) throw new DomainError("NOT_FOUND", "Event not found.", 404);
    let slug = `${e.slug}-copy`;
    for (let i = 2; t.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get(); i++) slug = `${e.slug}-copy-${i}`;
    const newEventId = newId();
    const at = now();
    t.insert(events).values({ ...e, id: newEventId, slug, title: `${e.title} (copy)`, published: false, createdAt: at, updatedAt: at }).run();
    const ws = t.select().from(waves).where(eq(waves.eventId, id)).all();
    if (ws.length) t.insert(waves).values(ws.map((w) => ({ ...w, id: newId(), eventId: newEventId, manualOpen: false }))).run();
    record(t, { actor, entityType: "event", entityId: newEventId, eventId: newEventId, action: "EVENT_DUPLICATED", data: { from: id } });
    return newEventId;
  });
}

// ---------- waves ----------

const waveRow = (i: WaveInput) => ({
  name: i.name,
  priceCents: Math.round(i.priceDollars * 100),
  capacity: i.capacity,
  mode: i.mode,
  manualOpen: i.manualOpen,
  opensAt: i.mode === "SCHEDULED" ? i.opensAt : null,
  closesAt: i.mode === "SCHEDULED" ? i.closesAt : null,
});

export function addWave(eventId: string, input: WaveInput, actor: string) {
  tx((t) => {
    if (!t.select({ id: events.id }).from(events).where(eq(events.id, eventId)).get())
      throw new DomainError("NOT_FOUND", "Event not found.", 404);
    const position = (t.select({ m: max(waves.position) }).from(waves).where(eq(waves.eventId, eventId)).get()?.m ?? 0) + 1;
    const id = newId();
    const row = waveRow(input);
    t.insert(waves).values({ id, eventId, position, ...row }).run();
    record(t, { actor, entityType: "wave", entityId: id, eventId, action: "WAVE_CREATED", data: { ...row, position } });
  });
}

export function updateWave(waveId: string, input: WaveInput, actor: string) {
  tx((t) => {
    const w = t.select().from(waves).where(eq(waves.id, waveId)).get();
    if (!w) throw new DomainError("NOT_FOUND", "Wave not found.", 404);
    const held = waveViews(t, w.eventId).find((v) => v.id === waveId)!.held;
    if (input.capacity < held)
      throw new DomainError("CAPACITY_BELOW_HELD", `Capacity can't go below the ${held} tickets already held in ${w.name}.`, 409);
    const row = waveRow(input);
    t.update(waves).set(row).where(eq(waves.id, waveId)).run();
    const changed = Object.fromEntries(
      Object.entries(row)
        .filter(([k, v]) => w[k as keyof typeof w] !== v)
        .map(([k, v]) => [k, { from: w[k as keyof typeof w], to: v }]),
    );
    record(t, { actor, entityType: "wave", entityId: waveId, eventId: w.eventId, action: "WAVE_UPDATED", data: { name: w.name, changed } });
  });
}

export function setWaveOpen(waveId: string, open: boolean, actor: string) {
  tx((t) => {
    const w = t.select().from(waves).where(eq(waves.id, waveId)).get();
    if (!w) throw new DomainError("NOT_FOUND", "Wave not found.", 404);
    t.update(waves).set({ manualOpen: open }).where(eq(waves.id, waveId)).run();
    record(t, {
      actor,
      entityType: "wave",
      entityId: waveId,
      eventId: w.eventId,
      action: open ? "WAVE_OPENED" : "WAVE_CLOSED",
      from: w.manualOpen ? "open" : "closed",
      to: open ? "open" : "closed",
      data: { name: w.name, mode: w.mode },
    });
  });
}

/** Swap with the neighbour above/below. Positions are unique, so go via a temporary slot. */
export function moveWave(waveId: string, dir: -1 | 1, actor: string) {
  tx((t) => {
    const w = t.select().from(waves).where(eq(waves.id, waveId)).get();
    if (!w) throw new DomainError("NOT_FOUND", "Wave not found.", 404);
    const all = t.select().from(waves).where(eq(waves.eventId, w.eventId)).orderBy(asc(waves.position)).all();
    const i = all.findIndex((x) => x.id === waveId);
    const other = all[i + dir];
    if (!other) return;
    t.update(waves).set({ position: -1 }).where(eq(waves.id, w.id)).run();
    t.update(waves).set({ position: w.position }).where(eq(waves.id, other.id)).run();
    t.update(waves).set({ position: other.position }).where(eq(waves.id, w.id)).run();
    record(t, { actor, entityType: "wave", entityId: waveId, eventId: w.eventId, action: "WAVE_MOVED", data: { name: w.name, swappedWith: other.name } });
  });
}

export function deleteWave(waveId: string, actor: string) {
  tx((t) => {
    const w = t.select().from(waves).where(eq(waves.id, waveId)).get();
    if (!w) throw new DomainError("NOT_FOUND", "Wave not found.", 404);
    if (t.select({ id: orders.id }).from(orders).where(eq(orders.waveId, waveId)).get())
      throw new DomainError("WAVE_HAS_ORDERS", "This wave has orders. Set its capacity or close it instead.", 409);
    t.delete(waves).where(eq(waves.id, waveId)).run();
    record(t, { actor, entityType: "wave", entityId: waveId, eventId: w.eventId, action: "WAVE_DELETED", data: { name: w.name } });
  });
}
