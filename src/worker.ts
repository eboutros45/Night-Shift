import { eq } from "drizzle-orm";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDatabase, withDatabase, db } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { newId } from "./lib/ids.ts";
import { flushMail } from "./services/mailer.ts";
import { withAccessUser } from "./web/session.ts";
import { OWNER_EMAIL, verifyAccess, type AccessSettings } from "./cloud/access.ts";

type Bindings = AccessSettings & {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
};
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // Fail closed, including assets/health checks and alternate hostnames.
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Private preview is not configured.", { status: 503 });
    if (!await verifyAccess(request, env)) return new Response("Sign in through the private preview address to continue.", { status: 403 });
    const connection = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connection || !config.supabase.url || !config.supabase.secretKey || !config.isProd || config.devTools || config.sessionSecret.startsWith("dev-only")) {
      return new Response("Private preview setup is incomplete.", { status: 503 });
    }
    const { database, close } = openDatabase(connection);
    return withDatabase(database, async () => {
      try {
        await db().insert(users).values({ id: newId(), email: OWNER_EMAIL, name: "Elie Boutros", passwordHash: "access-only", role: "ADMIN" }).onConflictDoNothing({ target: users.email });
        const user = (await db().select().from(users).where(eq(users.email, OWNER_EMAIL)).limit(1))[0];
        if (!user || user.role !== "ADMIN") return new Response("Access denied.", { status: 403 });
        const app = createApp((asset) => env.ASSETS.fetch(asset));
        return await withAccessUser(user, () => app.fetch(request));
      } catch (error) {
        // Database errors can contain connection details or row data; do not print them.
        console.error("Worker request failed", error instanceof Error ? error.name : "unknown");
        return new Response("Something went wrong. Please try again.", { status: 500 });
      } finally {
        ctx.waitUntil(flushMail().finally(close));
      }
    });
  },
};
