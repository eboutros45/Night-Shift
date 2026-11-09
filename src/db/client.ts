import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Exec = Db | Tx;
type Hook = () => void | Promise<void>;
const databases = new AsyncLocalStorage<Db>();
const transactions = new AsyncLocalStorage<{ transaction: Tx; hooks: Hook[] }>();
let local: Db | undefined;
export function openDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000 });
  return { database: drizzle(pool, { schema }), close: () => pool.end() };
}
export function useDatabase(database: Db) { local = database; }
const requestTasks = new AsyncLocalStorage<Set<Promise<void>>>();
export function withDatabase<T>(database: Db, fn: () => T): T { return databases.run(database, () => requestTasks.run(new Set(), fn)); }
export function db(): Db {
  const scoped = databases.getStore() ?? local;
  if (scoped) return scoped;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  local = openDatabase(process.env.DATABASE_URL).database;
  return local;
}
const pending = new Set<Promise<void>>();
function schedule(hook: Hook) {
  const tasks = requestTasks.getStore() ?? pending;
  const promise = Promise.resolve().then(hook).then(() => {}).catch(() => { console.error("Post-commit task failed"); }).finally(() => tasks.delete(promise));
  tasks.add(promise);
}
export function afterCommit(hook: Hook) {
  const scope = transactions.getStore();
  if (scope) scope.hooks.push(hook); else schedule(hook);
}
export async function flushAfterCommit() {
  const tasks = requestTasks.getStore() ?? pending;
  while (tasks.size) await Promise.all([...tasks]);
}
/** Serialize writes across isolates, preserving the previous single-writer guarantees.
 * Reads remain concurrent. The lock is automatically released on commit or rollback.
 */
export async function tx<T>(fn: (transaction: Tx) => T | Promise<T>): Promise<T> {
  const parent = transactions.getStore();
  if (parent) return fn(parent.transaction);
  const hooks: Hook[] = [];
  const result = await db().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(728410324)`);
    return transactions.run({ transaction, hooks }, () => fn(transaction));
  });
  for (const hook of hooks) schedule(hook);
  return result;
}
