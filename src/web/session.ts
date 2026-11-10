import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { config } from "../config.ts";
import type { User } from "../db/schema.ts";
import type { Role } from "../domain/status.ts";
import { revokeSession, SESSION_TTL, sessionUser } from "../services/login.ts";
import { AsyncLocalStorage } from "node:async_hooks";

// Test harness only. Production identities come from database-backed session tokens.
const accessUsers = new AsyncLocalStorage<User>();
export const withAccessUser = <T>(user: User, fn: () => T): T => accessUsers.run(user, fn);
const COOKIE = "ns_session";
export type Env = { Variables: { user: User } };

export async function startSession(c: Context, token: string) {
  identities.delete(c);
  await setSignedCookie(c, COOKIE, token, config.sessionSecret, {
    httpOnly: true, sameSite: "Lax", secure: config.isProd, path: "/", maxAge: SESSION_TTL / 1000,
  });
}
export async function endSession(c: Context) {
  identities.delete(c);
  const token = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (typeof token === "string") await revokeSession(token);
  deleteCookie(c, COOKIE, { path: "/" });
}
const identities = new WeakMap<Context, Promise<User | null>>();
export function currentUser(c: Context): Promise<User | null> {
  let identity = identities.get(c);
  if (!identity) { identity = readUser(c); identities.set(c, identity); }
  return identity;
}
async function readUser(c: Context): Promise<User | null> {
  const verified = accessUsers.getStore();
  if (verified) return verified.active ? verified : null;
  const token = await getSignedCookie(c, config.sessionSecret, COOKIE);
  return typeof token === "string" ? sessionUser(token) : null;
}
export function requireRole(...roles: Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/admin/login", 303);
    if (!roles.includes(user.role as Role)) return c.text("Forbidden", 403);
    c.set("user", user);
    await next();
  };
}
