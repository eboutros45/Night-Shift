import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { freshDb, makeEvent, buyer, T0, screenshot } from "./helpers.ts";
import { withAccessUser } from "../src/web/session.ts";
import { db } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";

beforeEach(async () => { await freshDb(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("serves every internal page linked from populated admin and customer workflows", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const order = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  await orders.submitProof(order.accessToken, screenshot(), "WHISH", T0 + 1);
  await orders.approve(order.id, "admin-1", T0 + 2);
  const user = (await db().select().from(users).limit(1))[0]!;
  const app = createApp();
  const queue = ["/", "/admin", "/admin/door", "/admin/comps", "/admin/staff", `/o/${order.accessToken}`];
  const visited = new Set<string>();
  const failures: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    expect(visited.size).toBeLessThan(150);
    const response = await withAccessUser(user, () => app.request(`http://localhost:3000${path}`));
    if (response.status === 303 || response.status === 302) {
      queue.push(response.headers.get("location")!);
      continue;
    }
    if (response.status !== 200) failures.push(`${path}: ${response.status}`);
    if (!response.headers.get("content-type")?.includes("text/html")) continue;
    const html = await response.text();
    expect(html, path).not.toContain("[object Promise]");
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const href = match[1]!.replaceAll("&amp;", "&");
      if (href.startsWith("/") && !href.startsWith("//")) queue.push(href.split("#")[0]!);
    }
  }
  expect(failures).toEqual([]);
  expect(visited.has("/admin/events/new")).toBe(true);
});

it("creates drafts through the New event form and preserves validation errors", async () => {
  const user = (await db().select().from(users).limit(1))[0]!;
  const app = createApp();
  const submit = (data: Record<string, string>) => withAccessUser(user, () => app.request("http://localhost:3000/admin/events/new", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data),
  }));
  const fields = { title: "New Night", slug: "new-night", subtitle: "", organizer: "Night Shift", description: "", startsAt: "2026-11-20T22:00", endsAt: "", venueName: "Club", venueAddress: "", city: "Beirut", lineup: "", maxPerOrder: "6", maxPerBuyer: "6", doorPrice: "", doorLimit: "", agePolicy: "18+", refundPolicy: "" };
  const invalid = await submit({ ...fields, title: "" });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain("Title is required.");
  const created = await submit(fields);
  expect(created.status).toBe(303);
  const path = created.headers.get("location")!;
  expect(path).toMatch(/^\/admin\/events\/[^?]+/);
  const page = await withAccessUser(user, () => app.request(`http://localhost:3000${path}`));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("New Night");
  const duplicate = await submit(fields);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.text()).toContain("already used");
  const scanner = { ...user, role: "SCANNER" };
  expect((await withAccessUser(scanner, () => app.request("http://localhost:3000/admin/events/new"))).status).toBe(403);
});

it("admin sees who paid how, checks screenshots by name and phone, and can cancel a no-show", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const who = buyer(event.waveIds[0]!, 3);
  const order = await orders.confirm(event.slug, who, T0);
  const first = (await orders.getById(order.id))!.tickets[0]!;
  const { collectAndAdmit } = await import("../src/services/tickets.ts");
  await collectAndAdmit(event.eventId, first.id, "CASH", "admin-1", T0 + 1);
  await orders.submitProof(order.accessToken, screenshot(), "NEO", T0 + 2);
  const user = (await db().select().from(users).limit(1))[0]!;
  const app = createApp();
  const get = async (path: string) => (await withAccessUser(user, () => app.request(`http://localhost:3000${path}`))).text();
  const post = (path: string, body: Record<string, string>) => withAccessUser(user, () => app.request(`http://localhost:3000${path}`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));

  const queue = await get("/admin/payments");
  for (const text of ["Neo", who.customerPhone, "Rami K", "mark 3 tickets paid"]) expect(queue, text).toContain(text);
  expect(await get("/admin/orders")).toContain("1 / 3");
  const detail = await get(`/admin/orders/${order.id}`);
  expect(detail).toContain("Cash at door");
  expect(detail).toContain("the rest was already paid at the door");
  const csv = await get(`/admin/events/${event.eventId}/attendees.csv`);
  expect(csv.split("\r\n")[0]).toContain("paid,price");
  expect(csv).toContain('"cash","20.00"');
  expect(csv).toContain('"unpaid","20.00"');
  const stats = await get(`/admin/events/${event.eventId}/stats`);
  expect(stats).toContain("still to collect");

  const approved = await post(`/admin/orders/${order.id}/approve`, {});
  expect(decodeURIComponent(approved.headers.get("location")!.replaceAll("+", " "))).toContain("2 tickets marked paid");

  const other = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  expect((await post(`/admin/orders/${other.id}/cancel`, { reason: "" })).headers.get("location")).toContain("err=");
  const cancelled = await post(`/admin/orders/${other.id}/cancel`, { reason: "No-show" });
  expect(cancelled.status).toBe(303);
  expect((await orders.getById(other.id))!.status).toBe("CANCELLED");
});
