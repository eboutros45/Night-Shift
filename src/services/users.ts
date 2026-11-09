import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { users, type User } from "../db/schema.ts";
import { verifyPassword } from "../lib/password.ts";
import { record } from "./journal.ts";

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = (await db().select().from(users).where(eq(users.email, email)).limit(1))[0];
  const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    (await record(db(), { actor: "system", entityType: "user", entityId: user?.id ?? null, action: "LOGIN_FAILED", data: { email } }));
    return null;
  }
  (await record(db(), { actor: user.id, entityType: "user", entityId: user.id, action: "LOGIN" }));
  return user;
}

export const getUser = async (id: string) => (await db().select().from(users).where(eq(users.id, id)).limit(1))[0] ?? null;
