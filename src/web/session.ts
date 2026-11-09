// Staff sessions: a signed cookie "<userId>.<expiresAt>". The user row is re-read on every
// request, so deleting a user or changing their role takes effect immediately.
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { config } from "../config.ts";
import type { User } from "../db/schema.ts";
import type { Role } from "../domain/status.ts";
import { getUser } from "../services/users.ts";

const COOKIE = "ns_session";
const TTL_MS = 12 * 3600_000;

export type Env = { Variables: { user: User } };

export async function startSession(c: Context, user: User) {
  await setSignedCookie(c, COOKIE, `${user.id}.${Date.now() + TTL_MS}`, config.sessionSecret, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.isProd,
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export const endSession = (c: Context) => deleteCookie(c, COOKIE, { path: "/" });

export async function currentUser(c: Context): Promise<User | null> {
  const v = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (!v) return null;
  const [id, exp] = v.split(".");
  // Real time, not the dev clock: time-travelling must not log you out.
  if (!id || !exp || Number(exp) < Date.now()) return null;
  return getUser(id);
}

/** Gate a route group. Scanners only reach the door; admins reach everything. */
export function requireRole(...roles: Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = await currentUser(c);
    if (!user) return c.redirect(`/admin/login?next=${encodeURIComponent(c.req.path)}`);
    if (!roles.includes(user.role as Role)) return c.text("Forbidden", 403);
    c.set("user", user);
    await next();
  };
}
