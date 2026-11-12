import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { freshDb, makeEvent, buyer, T0, screenshot } from "./helpers.ts";
import { withAccessUser } from "../src/web/session.ts";
import { db } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
beforeEach(async () => { await freshDb(); vi.spyOn(console,"log").mockImplementation(()=>{}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); });
it("renders public and admin workflows using PostgreSQL", async () => {
 const e=await makeEvent([{capacity:5}]);
 const o=await orders.confirm(e.slug,buyer(e.waveIds[0]!),T0);
 await orders.submitProof(o.accessToken, screenshot(), "WHISH",T0+1);
 await orders.approve(o.id,"admin-1",T0+2);
 const user=(await db().select().from(users).limit(1))[0]!;
 const app=createApp();
 const paths=["/",`/e/${e.slug}`,`/e/${e.slug}/checkout?wave=${e.waveIds[0]}&quantity=1`,`/o/${o.accessToken}`,`/o/${o.accessToken}/tickets.pdf`,"/account","/admin","/admin/orders","/admin/payments","/admin/analytics","/admin/trace","/admin/email",`/admin/events/${e.eventId}`,`/admin/events/${e.eventId}/stats`,`/admin/events/${e.eventId}/attendees`,`/admin/door/${e.eventId}`,`/admin/orders/${o.id}`];
 for(const path of paths) {
  const response=await withAccessUser(user,()=>app.request(`http://192.168.68.110:3000${path}`));
  expect(response.status,path).toBe(200);
  expect(await response.text(),path).not.toContain("[object Promise]");
 }
});
it("accepts LAN login forms but still blocks foreign and null origins",async()=>{
 const app=createApp();
 const login=await app.request("http://192.168.68.110:3000/admin/login");
 expect(login.headers.get("referrer-policy")).toBe("same-origin");
 for(const [origin,status] of [["http://192.168.68.110:3000",303],["https://evil.example",403],["null",403]] as const) {
  const response=await app.request("http://192.168.68.110:3000/admin/login",{method:"POST",headers:{origin,host:"192.168.68.110:3000","content-type":"application/x-www-form-urlencoded"},body:"email=a%40x.test&password=pw"});
  expect(response.status,origin).toBe(status);
 }
});

it("shows a stable result with Scan next ticket instead of the scanner after admission", async () => {
  const e = await makeEvent([{ capacity: 5 }]);
  const order = await orders.confirm(e.slug, buyer(e.waveIds[0]!), T0);
  await orders.submitProof(order.accessToken, screenshot(), "WHISH", T0 + 1);
  await orders.approve(order.id, "admin-1", T0 + 2);
  const ticket = (await orders.getById(order.id))!.tickets[0]!;
  const user = (await db().select().from(users).limit(1))[0]!;
  const app = createApp();
  const response = await withAccessUser(user, () => app.request(`http://localhost:3000/admin/door/${e.eventId}`, {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: ticket.token }),
  }));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("ADMIT");
  expect(html).toContain("Scan next ticket");
  expect(html).not.toContain('id="scan-form"');
  expect(html).not.toContain('id="reader"');
  const next = await withAccessUser(user, () => app.request(`http://localhost:3000/admin/door/${e.eventId}`));
  expect(await next.text()).toContain('id="scan-form"');
});

const asStaff = async (role = "SCANNER") => ({ ...(await db().select().from(users).limit(1))[0]!, role });
const post = (app: ReturnType<typeof createApp>, user: Awaited<ReturnType<typeof asStaff>>, path: string, body: Record<string, string>) =>
  withAccessUser(user, () => app.request(`http://localhost:3000${path}`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));

it("tells the doorman what to collect for an unpaid ticket, then admits on cash", async () => {
  const e = await makeEvent([{ capacity: 5 }]);
  const order = await orders.confirm(e.slug, buyer(e.waveIds[0]!), T0);
  const ticket = (await orders.getById(order.id))!.tickets[0]!;
  const app = createApp();
  const scanner = await asStaff();
  const scanned = await (await post(app, scanner, `/admin/door/${e.eventId}`, { code: ticket.token })).text();
  expect(scanned).toContain("Not paid");
  expect(scanned).toContain("Collect $20");
  expect(scanned).toContain("Cash received · Admit");
  expect(scanned).not.toContain("Receipt seen");
  expect(scanned).not.toContain("✓ Admit");
  expect((await orders.getById(order.id))!.tickets[0]!.status).toBe("VALID");
  const admitted = await (await post(app, scanner, `/admin/door/${e.eventId}/collect`, { ticketId: ticket.id, via: "CASH" })).text();
  expect(admitted).toContain("✓ Admit");
  expect(admitted).toContain("Cash collected");
  expect((await orders.getById(order.id))!.tickets[0]).toMatchObject({ status: "CHECKED_IN", paidVia: "CASH", paidBy: scanner.id });
});

it("offers 'Receipt seen' only while a screenshot is waiting, and finds guests by phone", async () => {
  const e = await makeEvent([{ capacity: 5 }]);
  const who = buyer(e.waveIds[0]!);
  const order = await orders.confirm(e.slug, who, T0);
  await orders.submitProof(order.accessToken, screenshot(), "NEO", T0 + 1);
  const ticket = (await orders.getById(order.id))!.tickets[0]!;
  const app = createApp();
  const scanner = await asStaff();
  const scanned = await (await post(app, scanner, `/admin/door/${e.eventId}`, { code: ticket.token })).text();
  expect(scanned).toContain("Neo not verified");
  expect(scanned).toContain("Receipt seen · Admit");
  const found = await (await withAccessUser(scanner, () => app.request(`http://localhost:3000/admin/door/${e.eventId}?q=${encodeURIComponent(who.customerPhone.slice(-6))}`))).text();
  expect(found).toContain("Rami K");
  expect(found).toContain("Not paid · $20");
  expect(found).toContain(ticket.token);
});

it("keeps the door closed to guests", async () => {
  const e = await makeEvent([{ capacity: 5 }]);
  const app = createApp();
  const response = await app.request(`http://localhost:3000/admin/door/${e.eventId}/collect`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: "ticketId=x&via=CASH" });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/admin/login");
});
