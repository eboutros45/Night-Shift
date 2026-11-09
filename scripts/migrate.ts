import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the target PostgreSQL database");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { await migrate(drizzle(pool), { migrationsFolder: "supabase/migrations" }); }
finally { await pool.end(); }
