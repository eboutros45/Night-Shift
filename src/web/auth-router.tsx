import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { config } from "../config.ts";
import { DomainError } from "../domain/status.ts";
import { CODE_TTL, requestLogin, verifyLogin } from "../services/login.ts";
import { back, clientIp, form, retryAfter } from "./http.ts";
import { Page } from "./layout.tsx";
import { SignIn } from "./sign-in.tsx";
import { currentUser, endSession, startSession, type Env } from "./session.ts";

export function customerDestination(value: string | undefined) {
  if (!value || value.length > 1024 || /[\\\r\n]/.test(value)) return "/account";
  try {
    const url = new URL(value, "https://nightshift.invalid");
    if (url.origin !== "https://nightshift.invalid") return "/account";
    if (/^\/e\/[a-z0-9-]+(?:\/checkout)?$/.test(url.pathname) || /^\/o\/[A-Za-z0-9_-]+(?:\/tickets(?:\.pdf)?)?$/.test(url.pathname)) return url.pathname + url.search;
  } catch { /* fall back to the account page */ }
  return "/account";
}

export function signInRouter(audience: "staff" | "customer") {
  const router = new Hono<Env>();
  const management = audience === "staff";
  const base = management ? "/admin" : "";
  const cookie = management ? "ns_login_challenge" : "ns_customer_challenge";
  const options = { httpOnly: true, secure: config.isProd, sameSite: "Lax" as const, path: management ? "/admin" : "/", maxAge: CODE_TTL / 1000 };
  async function challenge(c: Parameters<typeof currentUser>[0]) {
    const value = await getSignedCookie(c, config.sessionSecret, cookie);
    if (typeof value !== "string") return null;
    try { return JSON.parse(value) as { id: string; email: string; next: string }; } catch { return null; }
  }
  router.get("/login", async (c) => {
    const user = await currentUser(c);
    const next = customerDestination(c.req.query("next"));
    if (user && (!management || user.role !== "CUSTOMER")) return c.redirect(management ? user.role === "ADMIN" ? "/admin" : "/admin/door" : next, 303);
    if (c.req.query("change") === "1") deleteCookie(c, cookie, { path: options.path });
    const pending = c.req.query("change") === "1" ? null : await challenge(c);
    return c.html(<Page title={management ? "Management sign in" : "Sign in"}><SignIn management={management} verifying={!!pending} email={pending?.email ?? ""} next={pending?.next ?? next} error={c.req.query("err")} /></Page>);
  });
  router.post("/login", async (c) => {
    const f = await form(c);
    const next = customerDestination(f.next);
    try {
      const id = await requestLogin(f.email ?? "", clientIp(c), undefined, audience);
      await setSignedCookie(c, cookie, JSON.stringify({ id, email: (f.email ?? "").trim().toLowerCase(), next }), config.sessionSecret, options);
      return c.redirect(`${base}/login`, 303);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      retryAfter(c, error);
      return back(c, `${base}/login?next=${encodeURIComponent(next)}`, { err: error.message });
    }
  });
  router.post("/verify", async (c) => {
    const f = await form(c);
    const pending = await challenge(c);
    try {
      const result = await verifyLogin(pending?.id ?? "", f.code ?? "", clientIp(c), audience);
      if (!result) return back(c, `${base}/login`, { err: "Code invalid or expired. Enter the latest code or request a new one." });
      await endSession(c);
      await startSession(c, result.token);
      deleteCookie(c, cookie, { path: options.path });
      return c.redirect(management ? result.user.role === "ADMIN" ? "/admin" : "/admin/door" : customerDestination(pending?.next), 303);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      retryAfter(c, error);
      return back(c, `${base}/login`, { err: error.message });
    }
  });
  router.post("/logout", async (c) => {
    await endSession(c);
    deleteCookie(c, cookie, { path: options.path });
    return c.redirect(management ? "/admin/login" : "/", 303);
  });
  return router;
}
