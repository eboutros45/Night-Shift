// Opens SQLite, applies migrations from drizzle/, and hands out the shared handle.
// Tests swap in a fresh in-memory database with useDatabase(openDatabase(":memory:")).
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the db itself or an open transaction. */
export type Exec = Db | Tx;

const MIGRATIONS = resolve(import.meta.dirname, "../../drizzle");

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

let current: Db | null = null;

export function db(): Db {
  current ??= openDatabase(config.databasePath);
  return current;
}

export function useDatabase(next: Db) {
  current = next;
}

// Side effects (emails) registered during a transaction run only if it commits.
let pendingHooks: (() => void)[] | null = null;

/** Run `fn` after the current transaction commits (dropped if it rolls back); outside a transaction, run soon. */
export function afterCommit(fn: () => void) {
  if (pendingHooks) pendingHooks.push(fn);
  else setImmediate(fn);
}

/**
 * better-sqlite3 transactions are synchronous: the callback must not await.
 * That is a feature here: nothing else can interleave between a stock check and the insert.
 */
export function tx<T>(fn: (tx: Tx) => T): T {
  if (pendingHooks) return db().transaction(fn); // nested: outer tx owns the hooks
  pendingHooks = [];
  try {
    const result = db().transaction(fn, { behavior: "immediate" });
    const hooks = pendingHooks;
    pendingHooks = null;
    for (const h of hooks) setImmediate(h);
    return result;
  } catch (err) {
    pendingHooks = null;
    throw err;
  }
}
