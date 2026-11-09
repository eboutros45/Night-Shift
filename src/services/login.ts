import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db, tx } from "../db/client.ts";
import { loginChallenges, staffSessions, users } from "../db/schema.ts";
import { DomainError } from "../domain/status.ts";
import * as limits from "../lib/limits.ts";
import { record } from "./journal.ts";

export const emailInput = z.string().trim().toLowerCase().email().max(254);
export const CODE_TTL = 10 * 60_000;
export const SESSION_TTL = 12 * 3600_000;
const opaque = () => randomBytes(32).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const codeHash = (id: string, code: string) => createHmac("sha256", config.sessionSecret).update(`${id}:${code}`).digest("hex");

/** Deliberately separate from ticket mail: codes must never reach console or journal. */
export async function sendLoginCode(email: string, code: string) {
  if (config.email.provider !== "resend" || !config.email.resendKey) throw new Error("Login email is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.email.resendKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ from: config.email.from, to: [email], subject: "Your Night Shift sign-in code",
      text: `Your Night Shift code is ${code}. It expires in 10 minutes and works once. Enter it only on ${config.appUrl}. If you did not request this code, ignore this email.` }),
  });
  if (!response.ok) throw new Error("Login email delivery failed");
}

export async function requestLogin(email: string, ip: string, send = sendLoginCode) {
  const parsed = emailInput.safeParse(email);
  if (!parsed.success) throw new DomainError("EMAIL", "Enter a valid email address.");
  email = parsed.data;
  await limits.take("loginCodePerIp", ip);
  await limits.take("loginCodePerEmail", email);
  const id = opaque();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const user = await tx(async (t) => {
    await t.delete(loginChallenges).where(lte(loginChallenges.expiresAt, Date.now()));
    const user = (await t.select().from(users).where(and(eq(users.email, email), eq(users.active, true))).limit(1))[0];
    if (!user || !["ADMIN", "SCANNER"].includes(user.role)) return null;
    await t.delete(loginChallenges).where(eq(loginChallenges.userId, user.id));
    await t.insert(loginChallenges).values({ id, userId: user.id, codeHash: codeHash(id, code), expiresAt: Date.now() + CODE_TTL });
    await record(t, { actor: "system", entityType: "user", entityId: user.id, action: "LOGIN_CODE_REQUESTED" });
    return user;
  });
  if (user) {
    try { await send(email, code); }
    catch {
      await db().delete(loginChallenges).where(eq(loginChallenges.id, id));
      await record(db(), { actor: "system", entityType: "user", entityId: user.id, action: "LOGIN_EMAIL_FAILED" });
      // Same browser response for unknown accounts and email failure; no account enumeration.
      console.error("Login email delivery failed");
    }
  }
  return id;
}

/** Attempts, consumption and session creation share one transaction across Worker isolates. */
export async function verifyLogin(id: string, code: string, ip: string) {
  await limits.take("loginPerIp", ip);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return tx(async (t) => {
    const challenge = (await t.select().from(loginChallenges).where(eq(loginChallenges.id, id)).limit(1))[0];
    if (!challenge || challenge.expiresAt <= Date.now() || challenge.attempts >= 5) return null;
    const matches = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(challenge.codeHash, "hex"), Buffer.from(codeHash(id, code), "hex"));
    if (!matches) {
      await t.update(loginChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(loginChallenges.id, id));
      await record(t, { actor: "system", entityType: "user", entityId: challenge.userId, action: "LOGIN_FAILED" });
      return null;
    }
    await t.delete(loginChallenges).where(eq(loginChallenges.id, id));
    const user = (await t.select().from(users).where(and(eq(users.id, challenge.userId), eq(users.active, true))).limit(1))[0];
    if (!user || !["ADMIN", "SCANNER"].includes(user.role)) return null;
    await t.delete(staffSessions).where(lte(staffSessions.expiresAt, Date.now()));
    const token = opaque();
    await t.insert(staffSessions).values({ id: tokenHash(token), userId: user.id, expiresAt: Date.now() + SESSION_TTL });
    await record(t, { actor: user.id, entityType: "user", entityId: user.id, action: "LOGIN" });
    return { user, token };
  });
}

export async function sessionUser(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db().select({ user: users, expiresAt: staffSessions.expiresAt }).from(staffSessions)
    .innerJoin(users, eq(users.id, staffSessions.userId)).where(eq(staffSessions.id, tokenHash(token))).limit(1))[0];
  return row && row.expiresAt > Date.now() && row.user.active && ["ADMIN", "SCANNER"].includes(row.user.role) ? row.user : null;
}

export async function revokeSession(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await db().delete(staffSessions).where(eq(staffSessions.id, tokenHash(token)));
}
