import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDatabase, withDatabase } from "./db/client.ts";
import { sweepExpired } from "./services/inventory.ts";
import { flushMail } from "./services/mailer.ts";

type Bindings = {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
};
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };
export default {
  async scheduled(_event: unknown, env: Bindings, ctx: ExecutionContext) {
    const connection = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connection) throw new Error("Database is not configured");
    const { database, close } = openDatabase(connection);
    ctx.waitUntil(withDatabase(database, async () => {
      try { await sweepExpired(); await flushMail(); } finally { await close(); }
    }));
  },
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const connection = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connection || !config.supabase.url || !config.supabase.secretKey || !config.isProd || config.devTools || config.sessionSecret.length < 32 || config.sessionSecret.startsWith("dev-only") || config.email.provider !== "resend" || !config.email.resendKey) {
      return new Response("Night Shift setup is incomplete.", { status: 503 });
    }
    const { database, close } = openDatabase(connection);
    return withDatabase(database, async () => {
      try {
        return await createApp((asset) => env.ASSETS.fetch(asset)).fetch(request);
      } catch (error) {
        console.error("Worker request failed", error instanceof Error ? error.name : "unknown");
        return new Response("Something went wrong. Please try again.", { status: 500 });
      } finally {
        ctx.waitUntil(flushMail().finally(close));
      }
    });
  },
};
