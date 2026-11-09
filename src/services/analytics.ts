// First-party analytics: page views (written by middleware) and per-event numbers read
// straight from orders, tickets and the journal. Plain tables in the starter; charts later.
import { createHash } from "node:crypto";
import { and, count, countDistinct, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { journal, orders, pageViews, tickets, waves } from "../db/schema.ts";

export type ViewType = "PAGE_VIEW" | "EVENT_VIEW" | "CHECKOUT_START";

export function deviceOf(ua: string) {
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
  return "desktop";
}

/** Daily-rotating anonymous visitor id. Not reversible, not linkable across days or to orders. */
export function visitorId(ip: string, ua: string, at = now()) {
  const day = new Date(at).toISOString().slice(0, 10);
  return createHash("sha256").update(`${config.sessionSecret}|${day}|${ip}|${ua}`).digest("base64url").slice(0, 16);
}

export function track(v: { type: ViewType; eventId?: string | null; ip: string; ua: string; path: string; referrer?: string | null }) {
  if (/bot|crawl|spider|preview/i.test(v.ua)) return;
  let referrerHost: string | null = null;
  try {
    referrerHost = v.referrer ? new URL(v.referrer).host : null;
  } catch {}
  if (referrerHost && config.appUrl.includes(referrerHost)) referrerHost = null; // internal navigation
  db()
    .insert(pageViews)
    .values({
      at: now(),
      type: v.type,
      eventId: v.eventId ?? null,
      visitor: visitorId(v.ip, v.ua),
      path: v.path.slice(0, 200),
      referrerHost,
      device: deviceOf(v.ua),
    })
    .run();
}

export function siteStats(days = 30) {
  const since = now() - days * 86_400_000;
  const inRange = gte(pageViews.at, since);
  const totals = db()
    .select({ views: count(), visitors: countDistinct(pageViews.visitor) })
    .from(pageViews)
    .where(inRange)
    .get()!;
  const byDay = db()
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${pageViews.at} / 1000, 'unixepoch')`,
      views: count(),
      visitors: countDistinct(pageViews.visitor),
    })
    .from(pageViews)
    .where(inRange)
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`))
    .all();
  const top = <K extends "path" | "referrerHost" | "device">(k: K) =>
    db()
      .select({ key: pageViews[k], n: count() })
      .from(pageViews)
      .where(and(inRange, isNotNull(pageViews[k])))
      .groupBy(pageViews[k])
      .orderBy(desc(count()))
      .limit(10)
      .all();
  return { days, totals, byDay, pages: top("path"), referrers: top("referrerHost"), devices: top("device") };
}

export function eventStats(eventId: string) {
  const views = (type: ViewType) =>
    db()
      .select({ n: countDistinct(pageViews.visitor) })
      .from(pageViews)
      .where(and(eq(pageViews.eventId, eventId), eq(pageViews.type, type)))
      .get()!.n;
  const journalCount = (action: string) =>
    db().select({ n: count() }).from(journal).where(and(eq(journal.eventId, eventId), eq(journal.action, action))).get()!.n;

  const funnel = [
    { step: "Visitors on event page", n: views("EVENT_VIEW") },
    { step: "Visitors who opened checkout", n: views("CHECKOUT_START") },
    { step: "Orders created", n: journalCount("ORDER_CREATED") },
    { step: "Payment proofs submitted", n: journalCount("PROOF_SUBMITTED") },
    { step: "Orders approved", n: journalCount("ORDER_APPROVED") },
  ];

  const byStatus = db()
    .select({ status: orders.status, orders: count(), tickets: sum(orders.quantity), cents: sum(orders.totalCents) })
    .from(orders)
    .where(and(eq(orders.eventId, eventId), eq(orders.isComp, false)))
    .groupBy(orders.status)
    .all();

  const byWave = db()
    .select({ wave: waves.name, price: waves.priceCents, capacity: waves.capacity, sold: sum(orders.quantity), revenue: sum(orders.totalCents) })
    .from(waves)
    .leftJoin(orders, and(eq(orders.waveId, waves.id), eq(orders.status, "APPROVED")))
    .where(eq(waves.eventId, eventId))
    .groupBy(waves.id)
    .orderBy(waves.position)
    .all();

  const comps = db()
    .select({ n: sum(orders.quantity) })
    .from(orders)
    .where(and(eq(orders.eventId, eventId), eq(orders.isComp, true)))
    .get()!.n;

  const scans = db()
    .select({ result: sql<string>`json_extract(${journal.data}, '$.result')`, n: count() })
    .from(journal)
    .where(and(eq(journal.eventId, eventId), eq(journal.action, "SCAN")))
    .groupBy(sql`1`)
    .all();

  // Check-ins per 15 minutes; slot is epoch ms of the slot start (formatted in Beirut time by the UI).
  const arrivals = db()
    .select({ slot: sql<number>`(${tickets.checkedInAt} / 900000) * 900000`, n: count() })
    .from(tickets)
    .where(and(eq(tickets.eventId, eventId), isNotNull(tickets.checkedInAt)))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all();

  return { funnel, byStatus, byWave, comps: Number(comps ?? 0), scans, arrivals };
}
