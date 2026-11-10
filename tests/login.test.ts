import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, T0 } from "./helpers.ts";
import { db } from "../src/db/client.ts";
import { loginChallenges, staffSessions, users } from "../src/db/schema.ts";
import { CODE_TTL, requestLogin, revokeSession, sessionUser, verifyLogin } from "../src/services/login.ts";
import { saveStaff } from "../src/services/staff.ts";
import { createApp } from "../src/app.ts";
import { withAccessUser } from "../src/web/session.ts";

vi.mock("../src/config.ts", async (original) => {
  const actual = await original<typeof import("../src/config.ts")>();
  return { ...actual, config: { ...actual.config, email: { ...actual.config.email, provider: "resend", resendKey: "test-only" } } };
});
beforeEach(async () => { await freshDb(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function challenge(email = "a@x.test") {
  let code = "";
  const id = await requestLogin(email, "test-ip", async (_email, value) => { code = value; });
  return { id, code };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: string, cookie = "") => app.request(`http://localhost:3000${path}`, {
  method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded", cookie }, body,
});

it("normalizes email and stores neither the raw code nor the session token", async () => {
  const { id, code } = await challenge(" A@X.TEST ");
  expect(code).toMatch(/^\d{6}$/);
  const row = (await db().select().from(loginChallenges))[0]!;
  expect(row.codeHash).toHaveLength(64);
  expect(row.codeHash).not.toBe(code);
  const result = await verifyLogin(id, code, "verify-ip");
  expect(result?.user.id).toBe("admin-1");
  expect((await db().select().from(staffSessions))[0]?.id).not.toBe(result?.token);
  expect((await sessionUser(result!.token))?.id).toBe("admin-1");
  expect(await verifyLogin(id, code, "verify-ip")).toBeNull();
});
it("does not send codes or create users for unknown and disabled accounts", async () => {
  const send = vi.fn();
  const unknown = await requestLogin("unknown@x.test", "ip", send);
  await db().update(users).set({ active: false }).where(eq(users.id, "admin-1"));
  await requestLogin("a@x.test", "ip", send);
  expect(send).not.toHaveBeenCalled();
  expect(await db().select().from(loginChallenges)).toHaveLength(0);
  expect(await db().select().from(users)).toHaveLength(1);
  expect(await verifyLogin(unknown, "123456", "ip")).toBeNull();
});
it("expires codes using real authentication time", async () => {
  const { id, code } = await challenge();
  vi.setSystemTime(T0 + CODE_TTL);
  expect(await verifyLogin(id, code, "ip")).toBeNull();
});
it("locks a challenge after five wrong attempts, including malformed codes", async () => {
  const { id, code } = await challenge();
  for (let n = 0; n < 5; n++) expect(await verifyLogin(id, "bad", "ip")).toBeNull();
  expect(await verifyLogin(id, code, "another-ip")).toBeNull();
  expect((await db().select().from(loginChallenges))[0]?.attempts).toBe(5);
});
it("invalidates the previous code when a replacement is requested", async () => {
  const old = await challenge();
  const latest = await challenge();
  expect(await verifyLogin(old.id, old.code, "ip")).toBeNull();
  expect(await verifyLogin(latest.id, latest.code, "ip")).not.toBeNull();
});
it("limits email requests even when the caller changes IP", async () => {
  const send = vi.fn();
  for (let n = 0; n < 3; n++) await requestLogin("a@x.test", `ip-${n}`, send);
  await expect(requestLogin("a@x.test", "new-ip", send)).rejects.toMatchObject({ status: 429 });
  expect(send).toHaveBeenCalledTimes(3);
});
it("consumes a code atomically under simultaneous verification", async () => {
  const { id, code } = await challenge();
  const results = await Promise.all([verifyLogin(id, code, "ip1"), verifyLogin(id, code, "ip2")]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db().select().from(staffSessions)).toHaveLength(1);
});
it("invalidates codes after email delivery failure without logging codes", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let code = "";
  const id = await requestLogin("a@x.test", "ip", async (_email, value) => { code = value; throw new Error(value); });
  expect(await verifyLogin(id, code, "ip")).toBeNull();
  expect(errors).toHaveBeenCalledWith("Login email delivery failed");
  expect(JSON.stringify(errors.mock.calls)).not.toContain(code);
});
it("revokes sessions on logout and expiration", async () => {
  const first = await challenge();
  const login = (await verifyLogin(first.id, first.code, "ip"))!;
  await revokeSession(login.token);
  expect(await sessionUser(login.token)).toBeNull();
  const second = await challenge();
  const other = (await verifyLogin(second.id, second.code, "ip"))!;
  vi.setSystemTime(T0 + 12 * 3600_000);
  expect(await sessionUser(other.token)).toBeNull();
});
it("lets admins add staff, forbids scanners and protects the current admin", async () => {
  const id = await saveStaff("admin-1", { email: " Door@X.test ", name: "Door", role: "SCANNER", active: true });
  expect((await db().select().from(users).where(eq(users.id, id)))[0]?.email).toBe("door@x.test");
  await expect(saveStaff(id, { email: "other@x.test", name: "Other", role: "ADMIN", active: true })).rejects.toMatchObject({ status: 403 });
  await expect(saveStaff("admin-1", { email: "a@x.test", name: "Admin", role: "SCANNER", active: true })).rejects.toMatchObject({ code: "SELF_ACCESS" });
  await expect(saveStaff("admin-1", { email: "a@x.test", name: "Admin", role: "ADMIN", active: false })).rejects.toMatchObject({ code: "SELF_ACCESS" });
});
it("disabling or changing roles revokes sessions and pending codes permanently", async () => {
  const data = { email: "door@x.test", name: "Door", role: "SCANNER", active: true };
  await saveStaff("admin-1", data);
  const first = await challenge(data.email);
  const login = (await verifyLogin(first.id, first.code, "ip"))!;
  const pending = await challenge(data.email);
  await saveStaff("admin-1", { ...data, active: false });
  await saveStaff("admin-1", data);
  expect(await sessionUser(login.token)).toBeNull();
  expect(await verifyLogin(pending.id, pending.code, "ip")).toBeNull();
  const next = await challenge(data.email);
  const another = (await verifyLogin(next.id, next.code, "ip"))!;
  await saveStaff("admin-1", { ...data, role: "ADMIN" });
  expect(await sessionUser(another.token)).toBeNull();
});
it("guards management and refuses forged Cloudflare identity headers", async () => {
  const app = createApp();
  for (const path of ["/admin", "/admin/staff", "/admin/door"]) {
    const response = await app.request(`http://localhost:3000${path}`, { headers: { "Cf-Access-Jwt-Assertion": "forged" } });
    expect(response.status, path).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await app.request("http://localhost:3000/admin/login")).status).toBe(200);
});
it("completes browser code login, protects staff management and logs out", async () => {
  let code = "";
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    code = JSON.parse(init.body).text.match(/code is (\d{6})/)[1];
    return new Response(JSON.stringify({ id: "mail-test" }), { status: 200 });
  }));
  const app = createApp();
  const request = await post(app, "/admin/login", "email=a%40x.test");
  expect(request.status).toBe(303);
  const challengeCookie = request.headers.get("set-cookie")!.split(";")[0]!;
  expect(request.headers.get("set-cookie")).toContain("HttpOnly");
  const verified = await post(app, "/admin/verify", `code=${code}`, challengeCookie);
  expect(verified.headers.get("location")).toBe("/admin");
  const sessionCookie = verified.headers.getSetCookie().find(value => value.startsWith("ns_session=") && value.includes("HttpOnly"))!.split(";")[0]!;
  const staffPage = await app.request("http://localhost:3000/admin/staff", { headers: { cookie: sessionCookie } });
  expect(staffPage.status).toBe(200);
  expect(await staffPage.text()).toContain("Add staff");
  await post(app, "/admin/logout", "", sessionCookie);
  expect((await app.request("http://localhost:3000/admin/staff", { headers: { cookie: sessionCookie } })).status).toBe(303);
});
it("scanners cannot read or mutate staff management through HTTP", async () => {
  const id = await saveStaff("admin-1", { email: "door@x.test", name: "Door", role: "SCANNER", active: true });
  const scanner = (await db().select().from(users).where(eq(users.id, id)))[0]!;
  const app = createApp();
  expect((await withAccessUser(scanner, () => app.request("http://localhost:3000/admin/staff"))).status).toBe(403);
  expect((await withAccessUser(scanner, () => post(app, "/admin/staff", "email=other%40x.test&role=ADMIN&name=Other&active=true"))).status).toBe(403);
  expect((await withAccessUser(scanner, () => app.request("http://localhost:3000/admin/door"))).status).toBe(200);
});
it("rejects cross-site code verification and staff changes", async () => {
  const app = createApp();
  for (const path of ["/admin/verify", "/admin/staff"]) {
    const response = await app.request(`http://localhost:3000${path}`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "code=123456" });
    expect(response.status).toBe(403);
  }
});
