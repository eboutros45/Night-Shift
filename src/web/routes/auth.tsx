import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { config } from "../../config.ts";
import { DomainError } from "../../domain/status.ts";
import { CODE_TTL, requestLogin, verifyLogin } from "../../services/login.ts";
import { back, clientIp, form, retryAfter } from "../http.ts";
import { Page } from "../layout.tsx";
import { currentUser, endSession, startSession, type Env } from "../session.ts";

export const auth = new Hono<Env>();
const CHALLENGE = "ns_login_challenge";
const cookieOptions = { httpOnly: true, secure: config.isProd, sameSite: "Lax" as const, path: "/admin", maxAge: CODE_TTL / 1000 };
const message = "If your email is on the staff list, a code will arrive shortly. Check spam too. A new code replaces the previous one.";

auth.get("/login", async (c) => {
  const user = await currentUser(c);
  if (user) return c.redirect(user.role === "ADMIN" ? "/admin" : "/admin/door", 303);
  const verifying = Boolean(await getSignedCookie(c, config.sessionSecret, CHALLENGE));
  return c.html(<Page title="Staff sign in"><div style="max-width:440px;margin:40px auto">
    <h1>Staff sign in</h1><p class="sub">Access is by invitation. Use the email your admin added to Night Shift.</p>
    {c.req.query("err") && <p class="flash err" role="alert">{c.req.query("err")}</p>}
    {verifying && <><p role="status">{message}</p><form method="post" action="/admin/verify" class="card fields">
      <label>Six-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" minlength={6} maxlength={6} autocomplete="one-time-code" required autofocus aria-describedby="code-help" /></label>
      <p id="code-help" class="hint">Codes expire after 10 minutes. Enter the latest code on the browser where you requested it.</p>
      <button class="primary block">Verify and sign in</button>
    </form><hr /></>}
    <form method="post" action="/admin/login" class="card fields">
      <label>Email<input name="email" type="email" maxlength={254} autocomplete="email" required autofocus={!verifying} /></label>
      <button class={verifying ? "block" : "primary block"}>{verifying ? "Send a new code" : "Email me a code"}</button>
    </form>
  </div></Page>);
});

auth.post("/login", async (c) => {
  const f = await form(c);
  try {
    const id = await requestLogin(f.email ?? "", clientIp(c));
    await setSignedCookie(c, CHALLENGE, id, config.sessionSecret, cookieOptions);
    return c.redirect("/admin/login", 303);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    retryAfter(c, error);
    return back(c, "/admin/login", { err: error.message });
  }
});

auth.post("/verify", async (c) => {
  const f = await form(c);
  const id = await getSignedCookie(c, config.sessionSecret, CHALLENGE);
  try {
    const result = await verifyLogin(typeof id === "string" ? id : "", f.code ?? "", clientIp(c));
    if (!result) return back(c, "/admin/login", { err: "Code invalid or expired. Check the latest code or request a new one." });
    await endSession(c);
    await startSession(c, result.token);
    deleteCookie(c, CHALLENGE, { path: "/admin" });
    return c.redirect(result.user.role === "ADMIN" ? "/admin" : "/admin/door", 303);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    retryAfter(c, error);
    return back(c, "/admin/login", { err: error.message });
  }
});

auth.post("/logout", async (c) => {
  await endSession(c);
  deleteCookie(c, CHALLENGE, { path: "/admin" });
  return c.redirect("/admin/login", 303);
});
