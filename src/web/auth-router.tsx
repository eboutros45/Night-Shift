// Staff sign-in by emailed code. Guests never sign in (see routes/customer-auth.tsx).
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { config } from "../config.ts";
import { DomainError } from "../domain/status.ts";
import { CODE_TTL, requestLogin, verifyLogin } from "../services/login.ts";
import { back, clientIp, form, retryAfter } from "./http.ts";
import { Page } from "./layout.tsx";
import { SignIn } from "./sign-in.tsx";
import { currentUser, endSession, startSession, type Env } from "./session.ts";

const COOKIE = "ns_login_challenge";
const OPTIONS = { httpOnly: true, secure: config.isProd, sameSite: "Lax" as const, path: "/admin", maxAge: CODE_TTL / 1000 };
const home = (role: string) => (role === "ADMIN" ? "/admin" : "/admin/door");

export function signInRouter() {
  const router = new Hono<Env>();
  async function challenge(c: Parameters<typeof currentUser>[0]) {
    const value = await getSignedCookie(c, config.sessionSecret, COOKIE);
    if (typeof value !== "string") return null;
    try { return JSON.parse(value) as { id: string; email: string }; } catch { return null; }
  }
  router.get("/login", async (c) => {
    const user = await currentUser(c);
    if (user && user.role !== "CUSTOMER") return c.redirect(home(user.role), 303);
    if (c.req.query("change") === "1") deleteCookie(c, COOKIE, { path: OPTIONS.path });
    const pending = c.req.query("change") === "1" ? null : await challenge(c);
    return c.html(<Page title="Management sign in"><SignIn verifying={!!pending} email={pending?.email ?? ""} error={c.req.query("err")} /></Page>);
  });
  router.post("/login", async (c) => {
    const f = await form(c);
    try {
      const id = await requestLogin(f.email ?? "", clientIp(c), undefined, "staff");
      await setSignedCookie(c, COOKIE, JSON.stringify({ id, email: (f.email ?? "").trim().toLowerCase() }), config.sessionSecret, OPTIONS);
      return c.redirect("/admin/login", 303);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      retryAfter(c, error);
      return back(c, "/admin/login", { err: error.message });
    }
  });
  router.post("/verify", async (c) => {
    const f = await form(c);
    const pending = await challenge(c);
    try {
      const result = await verifyLogin(pending?.id ?? "", f.code ?? "", clientIp(c), "staff");
      if (!result) return back(c, "/admin/login", { err: "Code invalid or expired. Enter the latest code or request a new one." });
      await endSession(c);
      await startSession(c, result.token);
      deleteCookie(c, COOKIE, { path: OPTIONS.path });
      return c.redirect(home(result.user.role), 303);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      retryAfter(c, error);
      return back(c, "/admin/login", { err: error.message });
    }
  });
  router.post("/logout", async (c) => {
    await endSession(c);
    deleteCookie(c, COOKIE, { path: OPTIONS.path });
    return c.redirect("/admin/login", 303);
  });
  return router;
}
