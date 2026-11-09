// Shared PostgreSQL rate limits across Worker isolates.
import { createHash } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { rateLimits } from "../db/schema.ts";
import { db, tx } from "../db/client.ts";
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


async function apply(policy: Policy, key: string, mode: "check" | "hit" | "take") {
  const at = Date.now();
  const id = createHash("sha256").update(policy + ":" + key).digest("hex");
  const blockedUntil = await tx(async (t) => {
    await t.delete(rateLimits).where(lte(rateLimits.resetAt, at));
    await t.insert(rateLimits).values({ id, n: 0, resetAt: at + LIMITS[policy].windowMs }).onConflictDoNothing();
    const row = (await t.select().from(rateLimits).where(eq(rateLimits.id, id)).limit(1))[0]!;
    if (mode !== "hit" && row.n >= LIMITS[policy].limit) {
      if (!row.reported) {
        await t.update(rateLimits).set({ reported: true }).where(eq(rateLimits.id, id));
        await record(t, { actor: "system", entityType: "system", action: "RATE_LIMITED", data: { policy, limit: LIMITS[policy].limit } });
      }
      return row.resetAt;
    }
    if (mode !== "check") await t.update(rateLimits).set({ n: row.n + 1 }).where(eq(rateLimits.id, id));
    return null;
  });
  if (blockedUntil !== null) throw new RateLimitError(policy, Math.max(1, Math.ceil((blockedUntil - at) / 1000)));
}
export async function check(policy: Policy, key: string) { await apply(policy, key, "check"); }
export async function hit(policy: Policy, key: string) { await apply(policy, key, "hit"); }
export async function take(policy: Policy, key: string) { await apply(policy, key, "take"); }
export const _resetLimits = async () => { await db().delete(rateLimits); };
