// Small helpers shared by route files.
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.ts";
import { DomainError } from "../domain/status.ts";
import { RateLimitError } from "../lib/limits.ts";

/** Form fields as plain strings (files dropped; use c.req.parseBody directly for uploads). */
export async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Redirect with a one-shot message in the query string (visible, bookmark-safe, no session state). */
export function back(c: Context, to: string, msg: { ok?: string; err?: string }) {
  const u = new URL(to, "http://x");
  if (msg.ok) u.searchParams.set("ok", msg.ok);
  if (msg.err) u.searchParams.set("err", msg.err);
  return c.redirect(u.pathname + u.search, 303);
}

/** Run a service call; DomainErrors become an error message on the redirect target. */
export async function act(c: Context, to: string, fn: () => unknown, okMsg: string) {
  try {
    await fn();
    return back(c, to, { ok: okMsg });
  } catch (e) {
    if (e instanceof DomainError) return back(c, to, { err: e.message });
    throw e;
  }
}

export const flash = (c: Context) => ({ ok: c.req.query("ok"), err: c.req.query("err") });

/** The caller's IP. X-Forwarded-For is ignored unless TRUST_PROXY=1 (it is trivially spoofable). */
export function clientIp(c: Context) {
  // Cloudflare supplies this header at the Worker edge; clients cannot set it there.
  if (process.env.CF_WORKER === "1") return c.req.header("CF-Connecting-IP") ?? "unknown";
  if (config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** On 429s, tell the client when to retry (browsers and proxies understand Retry-After). */
export function retryAfter(c: Context, e: unknown) {
  if (e instanceof RateLimitError) c.header("Retry-After", String(e.retryAfterSec));
}
