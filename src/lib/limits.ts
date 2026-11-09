// Every rate limit in the app, in one table. Fixed-window counters held in memory: correct for
// a single server process; move the Map to Redis/the DB if we ever run more than one.
// Uses real time (Date.now), not the dev clock, so time travel can't unlock anything.
import { db } from "../db/client.ts";
import { DomainError } from "../domain/status.ts";
import { record } from "../services/journal.ts";

const MIN = 60_000;

export const LIMITS = {
  checkoutPerIp: { limit: 10, windowMs: 10 * MIN, what: "checkout attempts from this network" },
  checkoutPerEmail: { limit: 5, windowMs: 10 * MIN, what: "orders for this email" },
  proofPerOrder: { limit: 6, windowMs: 10 * MIN, what: "proof uploads for this order" },
  proofPerIp: { limit: 20, windowMs: 10 * MIN, what: "proof uploads from this network" },
  loginPerIp: { limit: 20, windowMs: 15 * MIN, what: "login attempts from this network" },
  loginFailuresPerEmail: { limit: 5, windowMs: 15 * MIN, what: "failed logins for this account" },
  resendPerOrder: { limit: 3, windowMs: 60 * MIN, what: "ticket resends for this order" },
  testEmailPerUser: { limit: 5, windowMs: 10 * MIN, what: "test emails" },
} as const;

export type Policy = keyof typeof LIMITS;

export class RateLimitError extends DomainError {
  constructor(
    public policy: Policy,
    public retryAfterSec: number,
  ) {
    const mins = Math.ceil(retryAfterSec / 60);
    super("RATE_LIMITED", `Too many ${LIMITS[policy].what}. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 429);
  }
}

const windows = new Map<string, { n: number; resetAt: number; reported: boolean }>();

function current(policy: Policy, key: string) {
  const t = Date.now();
  const id = `${policy}:${key}`;
  let w = windows.get(id);
  if (!w || w.resetAt <= t) {
    w = { n: 0, resetAt: t + LIMITS[policy].windowMs, reported: false };
    windows.set(id, w);
    if (windows.size > 20_000) for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
  }
  return w;
}

/** Throw if the window is already full (does not count this attempt). */
export function check(policy: Policy, key: string) {
  const w = current(policy, key);
  if (w.n < LIMITS[policy].limit) return;
  if (!w.reported) {
    // Journal the first block per window only, so an attacker can't flood the trace.
    w.reported = true;
    try {
      record(db(), { actor: "system", entityType: "system", action: "RATE_LIMITED", data: { policy, key, limit: LIMITS[policy].limit } });
    } catch {}
  }
  throw new RateLimitError(policy, Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000)));
}

/** Count one attempt. */
export function hit(policy: Policy, key: string) {
  current(policy, key).n++;
}

/** Check, then count. The usual call. */
export function take(policy: Policy, key: string) {
  check(policy, key);
  hit(policy, key);
}

export const _resetLimits = () => windows.clear();
