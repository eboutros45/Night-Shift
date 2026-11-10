import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, makeEvent, buyer, T0 } from "./helpers.ts";
import { db } from "../src/db/client.ts";
import { users, orders as orderTable } from "../src/db/schema.ts";
import { requestLogin, verifyLogin } from "../src/services/login.ts";
import { createApp } from "../src/app.ts";
import { currentUser, withAccessUser } from "../src/web/session.ts";
import { customerDestination } from "../src/web/auth-router.tsx";
import * as events from "../src/services/events.ts";
import * as orders from "../src/services/orders.ts";
import { flushMail } from "../src/services/mailer.ts";

beforeEach(async () => { await freshDb(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function customer(email = "customer@example.test") {
  let code = "";
  const id = await requestLogin(email, "ip", async (_email, value) => { code = value; }, "customer");
  return { id, code };
}
it("creates customers only after verification and cannot use a customer code for management", async () => {
  const { id, code } = await customer();
  expect(await db().select().from(users)).toHaveLength(1);
  expect(await verifyLogin(id, code, "ip", "staff")).toBeNull();
  const result = (await verifyLogin(id, code, "ip", "customer"))!;
  expect(result.user.role).toBe("CUSTOMER");
  expect(await verifyLogin(id, code, "ip", "customer")).toBeNull();
  const next = await customer();
  expect((await verifyLogin(next.id, next.code, "ip", "customer"))?.user.id).toBe(result.user.id);
  expect(await db().select().from(users)).toHaveLength(2);
  const app = createApp();
  for (const path of ["/admin", "/admin/staff", "/admin/door"]) {
    expect((await withAccessUser(result.user, () => app.request(`http://localhost:3000${path}`))).status).toBe(403);
  }
});
it("keeps browsing public, requires checkout login, and binds orders to the verified owner", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const app = createApp();
  expect((await app.request("http://localhost:3000/")).status).toBe(200);
  expect((await app.request(`http://localhost:3000/e/${event.slug}`)).status).toBe(200);
  const checkout = `/e/${event.slug}/checkout?wave=${event.waveIds[0]}&quantity=1`;
  const response = await app.request(`http://localhost:3000${checkout}`);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`/login?next=${encodeURIComponent(checkout)}`);
  const challenge = await customer();
  const user = (await verifyLogin(challenge.id, challenge.code, "ip", "customer"))!.user;
  const values = buyer(event.waveIds[0]!);
  const placed = await withAccessUser(user, () => app.request(`http://localhost:3000/e/${event.slug}/checkout`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, quantity: "1", customerEmail: "forged@example.test" }) }));
  expect(placed.status).toBe(303);
  const order = (await db().select().from(orderTable))[0]!;
  expect(order.userId).toBe(user.id);
  expect(order.customerEmail).toBe(user.email);
  const path = `/o/${order.accessToken}`;
  expect((await app.request(`http://localhost:3000${path}`)).status).toBe(303);
  expect((await withAccessUser(user, () => app.request(`http://localhost:3000${path}`))).status).toBe(200);
  const stranger = { ...user, id: "stranger" };
  for (const suffix of ["", "/tickets", "/tickets.pdf"]) expect((await withAccessUser(stranger, () => app.request(`http://localhost:3000${path}${suffix}`))).status).toBe(404);
  const account = await withAccessUser(user, () => app.request("http://localhost:3000/account"));
  expect(await account.text()).toContain(order.reference);
});
it("does not reactivate disabled accounts or accept external return URLs", async () => {
  const pending = await customer("a@x.test");
  await db().update(users).set({ active: false }).where(eq(users.id, "admin-1"));
  expect(await verifyLogin(pending.id, pending.code, "ip", "customer")).toBeNull();
  for (const value of ["https://evil.example", "//evil.example", "/admin", "/\\evil.example"]) expect(customerDestination(value)).toBe("/account");
});
it("batches event inventory independently of event count", async () => {
  await makeEvent([{ capacity: 3 }]);
  await makeEvent([{ capacity: 4 }]);
  const select = vi.spyOn(db(), "select");
  const result = await events.listAdmin();
  expect(result).toHaveLength(2);
  expect(select).toHaveBeenCalledTimes(5);
  expect(result.map(row => row.capacity).sort()).toEqual([3, 4]);
});
