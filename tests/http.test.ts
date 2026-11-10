import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { freshDb, makeEvent, buyer, T0 } from "./helpers.ts";
import { withAccessUser } from "../src/web/session.ts";
import { db } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { flushMail } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
beforeEach(async () => { await freshDb(); vi.spyOn(console,"log").mockImplementation(()=>{}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); });
it("renders public and admin workflows using PostgreSQL", async () => {
 const e=await makeEvent([{capacity:5}]);
 const o=await orders.reserve(e.slug,buyer(e.waveIds[0]!),T0);
 await orders.submitProof(o.accessToken,null,"payment",T0+1);
 await orders.approve(o.id,"admin-1",T0+2);
 const user=(await db().select().from(users).limit(1))[0]!;
 const app=createApp();
 const paths=["/",`/e/${e.slug}`,`/e/${e.slug}/checkout?wave=${e.waveIds[0]}&quantity=1`,`/o/${o.accessToken}`,`/o/${o.accessToken}/tickets`,"/admin","/admin/orders","/admin/payments","/admin/analytics","/admin/trace","/admin/email",`/admin/events/${e.eventId}`,`/admin/events/${e.eventId}/stats`,`/admin/events/${e.eventId}/attendees`,`/admin/door/${e.eventId}`,`/admin/orders/${o.id}`];
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
  const order = await orders.reserve(e.slug, buyer(e.waveIds[0]!), T0);
  await orders.submitProof(order.accessToken, null, "paid", T0 + 1);
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
