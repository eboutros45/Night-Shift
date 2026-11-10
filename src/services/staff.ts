import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tx } from "../db/client.ts";
import { loginChallenges, staffSessions, users } from "../db/schema.ts";
import { DomainError } from "../domain/status.ts";
import { newId } from "../lib/ids.ts";
import { emailInput } from "./login.ts";
import { record } from "./journal.ts";

const staffInput = z.object({ email: emailInput, name: z.string().trim().min(1).max(100), role: z.enum(["ADMIN", "SCANNER"]), active: z.boolean() }).strict();
export const listStaff = () => db().select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active }).from(users).where(inArray(users.role, ["ADMIN", "SCANNER"])).orderBy(users.email);

export async function saveStaff(actorId: string, input: unknown) {
  const parsed = staffInput.safeParse(input);
  if (!parsed.success) throw new DomainError("STAFF_INPUT", "Enter a name, valid email and staff role.");
  const data = parsed.data;
  return tx(async (t) => {
    const actor = (await t.select().from(users).where(eq(users.id, actorId)).limit(1))[0];
    if (!actor?.active || actor.role !== "ADMIN") throw new DomainError("FORBIDDEN", "Admin access required.", 403);
    const existing = (await t.select().from(users).where(eq(users.email, data.email)).limit(1))[0];
    if (existing?.id === actorId && (!data.active || data.role !== "ADMIN")) throw new DomainError("SELF_ACCESS", "You cannot disable or demote your own admin account.");
    const id = existing?.id ?? newId();
    if (existing) {
      await t.update(users).set(data).where(eq(users.id, id));
      if (existing.role !== data.role || existing.active !== data.active) {
        await t.delete(staffSessions).where(eq(staffSessions.userId, id));
        await t.delete(loginChallenges).where(eq(loginChallenges.userId, id));
      }
    } else {
      await t.insert(users).values({ id, ...data, passwordHash: "email-code-only" });
    }
    await record(t, { actor: actorId, entityType: "user", entityId: id, action: existing ? "STAFF_UPDATED" : "STAFF_ADDED", data: { role: data.role, active: data.active } });
    return id;
  });
}
