import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, makeEvent, buyer, screenshot, T0 } from "./helpers.ts";
import { db } from "../src/db/client.ts";
import { users, orders as orderTable } from "../src/db/schema.ts";
import { requestLogin, verifyLogin } from "../src/services/login.ts";
import { createApp } from "../src/app.ts";
import { withAccessUser } from "../src/web/session.ts";
import * as limits from "../src/lib/limits.ts";
import * as events from "../src/services/events.ts";
import { feed } from "../src/services/journal.ts";
import * as orders from "../src/services/orders.ts";
import { flushMail } from "../src/services/mailer.ts";

beforeEach(async () => { await freshDb(); await limits._resetLimits(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { await flushMail(); vi.useRealTimers(); vi.restoreAllMocks(); });

const origin = "http://localhost:3000";
const get = (app: ReturnType<typeof createApp>, path: string) => app.request(`${origin}${path}`);
const post = (app: ReturnType<typeof createApp>, path: string, body: Record<string, string> | FormData) =>
  app.request(`${origin}${path}`, { method: "POST", headers: body instanceof FormData ? { origin } : { origin, "content-type": "application/x-www-form-urlencoded" }, body: body instanceof FormData ? body : new URLSearchParams(body) });
const proofForm = (file: File, method = "WHISH") => { const f = new FormData(); f.set("method", method); f.set("proof", file); return f; };

it("a guest gets a working ticket in two screens with no sign-in", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const app = createApp();
  expect((await get(app, "/")).status).toBe(200);
  expect(await (await get(app, `/e/${event.slug}`)).text()).toContain("Get my ticket");
  const details = await get(app, `/e/${event.slug}/checkout?wave=${event.waveIds[0]}&quantity=2`);
  expect(details.status).toBe(200);
  expect(await details.text()).toContain("Confirm attendance");
  const placed = await post(app, `/e/${event.slug}/checkout`, { ...buyer(event.waveIds[0]!), quantity: "2" });
  expect(placed.status).toBe(303);
  const order = (await db().select().from(orderTable))[0]!;
  expect(placed.headers.get("location")).toBe(`/o/${order.accessToken}`);
  expect(order).toMatchObject({ status: "CONFIRMED", userId: null, quantity: 2 });
  const ticket = await (await get(app, `/o/${order.accessToken}`)).text();
  expect(ticket.match(/<svg/g)!.length).toBeGreaterThanOrEqual(2);
  for (const text of ["You&#39;re in", "Not paid yet · $20", "Pay at the door", "$40", "Send screenshot", "Whish", "Neo"]) expect(ticket, text).toContain(text);
  expect((await get(app, `/o/${order.accessToken}/tickets.pdf`)).headers.get("content-type")).toBe("application/pdf");
  const old = await get(app, `/o/${order.accessToken}/tickets`);
  expect([old.status, old.headers.get("location")]).toEqual([303, `/o/${order.accessToken}`]);
});

it("a payment screenshot moves the ticket to 'checking', and bad files leave it untouched", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const order = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  const app = createApp();
  const path = `/o/${order.accessToken}`;
  const status = async () => (await orders.getById(order.id))!.order.status;

  const text = await post(app, `${path}/proof`, proofForm(new File(["hello"], "note.txt", { type: "text/plain" })));
  expect(text.status).toBe(303);
  expect(decodeURIComponent(text.headers.get("location")!)).toContain("Upload a PNG, JPG, WEBP, PDF file.");
  const huge = await post(app, `${path}/proof`, proofForm(new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" })));
  expect(huge.status).toBe(303);
  expect(decodeURIComponent(huge.headers.get("location")!)).toContain("too big");
  expect(await status()).toBe("CONFIRMED");
  expect(await (await get(app, decodeURI(huge.headers.get("location")!.split("#")[0]!))).text()).toContain("too big");

  const sent = await post(app, `${path}/proof`, proofForm(screenshot(), "NEO"));
  expect([sent.status, sent.headers.get("location")]).toEqual([303, path]);
  expect((await orders.getById(order.id))!.order).toMatchObject({ status: "PENDING_VERIFICATION", payMethod: "NEO" });
  const checking = await (await get(app, path)).text();
  expect(checking).toContain("Got your Neo screenshot");
  expect(checking).not.toContain("Send screenshot");

  await orders.approve(order.id, "admin-1");
  const paid = await (await get(app, path)).text();
  expect(paid).toContain("All paid");
  expect(paid).toContain("Paid · Neo");
});

it("a rejected screenshot shows the reason and lets the guest try again", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const order = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  await orders.submitProof(order.accessToken, screenshot(), "WHISH", T0 + 1);
  await orders.reject(order.id, "admin-1", "Amount was $10, not $20", T0 + 2);
  const html = await (await get(createApp(), `/o/${order.accessToken}`)).text();
  expect(html).toContain("Amount was $10, not $20");
  expect(html).toContain("Send screenshot");
  expect(html).toContain("<svg");
});

it("a free ticket has nothing to pay", async () => {
  const event = await makeEvent([{ capacity: 10, price: 0 }]);
  const order = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  const html = await (await get(createApp(), `/o/${order.accessToken}`)).text();
  expect(html).toContain("Free entry");
  expect(html).not.toContain("Send screenshot");
  expect(html).not.toContain("Pay at the door");
});

it("cancelled orders and orders from the old hold-and-pay flow offer a fresh start", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const app = createApp();
  const gone = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  await orders.cancel(gone.id, "admin-1", "Duplicate sign-up");
  const cancelled = await (await get(app, `/o/${gone.accessToken}`)).text();
  expect(cancelled).toContain("Duplicate sign-up");
  expect(cancelled).toContain("Get a new ticket");
  expect(cancelled).not.toContain("<svg width=\"200");
  expect((await get(app, `/o/${gone.accessToken}/tickets.pdf`)).status).toBe(404);

  const legacy = await orders.confirm(event.slug, buyer(event.waveIds[0]!), T0);
  await db().delete((await import("../src/db/schema.ts")).tickets);
  await db().update(orderTable).set({ status: "AWAITING_PAYMENT", expiresAt: T0 + 60_000 }).where(eq(orderTable.id, legacy.id));
  const old = await get(app, `/o/${legacy.accessToken}`);
  expect(old.status).toBe(200);
  expect(await old.text()).toContain("Get a new ticket");
});

it("'My tickets' emails the links and answers the same for known and unknown addresses", async () => {
  const event = await makeEvent([{ capacity: 10 }]);
  const who = buyer(event.waveIds[0]!);
  const order = await orders.confirm(event.slug, who, T0);
  await flushMail();
  const app = createApp();
  const login = await get(app, "/login");
  expect([login.status, login.headers.get("location")]).toEqual([303, "/account"]);
  expect(await (await get(app, "/account")).text()).toContain("Find my tickets");
  const known = await (await post(app, "/account", { email: who.customerEmail.toUpperCase() })).text();
  const unknown = await (await post(app, "/account", { email: "nobody@x.test" })).text();
  expect(known).toBe(unknown);
  expect(known).not.toContain(order.accessToken);
  await flushMail();
  const links = (await feed({ action: "EMAIL_QUEUED" })).filter((r) => r.parsed?.template === "ticket_links");
  expect(links).toHaveLength(1);
  expect((await post(app, "/account", { email: "not-an-email" })).status).toBe(400);
});

it("customer accounts from before can never reach management", async () => {
  let code = "";
  const id = await requestLogin("customer@example.test", "ip", async (_email, value) => { code = value; }, "customer");
  expect(await verifyLogin(id, code, "ip", "staff")).toBeNull();
  const result = (await verifyLogin(id, code, "ip", "customer"))!;
  expect(result.user.role).toBe("CUSTOMER");
  const app = createApp();
  for (const path of ["/admin", "/admin/staff", "/admin/door"]) {
    expect((await withAccessUser(result.user, () => app.request(`${origin}${path}`))).status).toBe(403);
  }
  await db().update(users).set({ active: false }).where(eq(users.id, result.user.id));
  expect((await withAccessUser({ ...result.user, active: false }, () => app.request(`${origin}/admin`))).status).toBe(303);
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
