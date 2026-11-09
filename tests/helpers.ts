import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import * as schema from "../src/db/schema.ts";
import { vi } from "vitest";
import { type Db, useDatabase } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import type { CheckoutInput } from "../src/domain/inputs.ts";
import { hashPassword } from "../src/lib/password.ts";
import * as events from "../src/services/events.ts";

export const T0 = Date.UTC(2026, 10, 1, 12, 0); // fixed "now" for deterministic tests
export const MIN = 60_000;

/** Fresh in-memory database, with the wall clock pinned to T0 so reads agree with the `at` values tests pass. */
let engine: PGlite | undefined;
export async function freshDb() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  if (engine) await engine.close();
  engine = new PGlite();
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) await engine.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  const d = drizzle(engine, { schema });
  useDatabase(d as unknown as Db);
  (await d.insert(users).values({ id: "admin-1", email: "a@x.test", name: "Admin", passwordHash: hashPassword("pw"), role: "ADMIN" }).returning());
  return d;
}

/** A published event (starting in 10 days) with the given waves. Returns ids. */
export async function makeEvent(waveSpecs: { name?: string; capacity: number; price?: number; mode?: "MANUAL" | "AUTO" | "SCHEDULED"; open?: boolean; opensAt?: number; closesAt?: number }[]) {
  const id = (await events.create(
      {
        title: "Test Night",
        slug: `test-${Math.random().toString(36).slice(2, 8)}`,
        subtitle: null,
        organizer: "Night Shift",
        description: "",
        startsAt: T0 + 10 * 86_400_000,
        endsAt: null,
        venueName: "Club",
        venueAddress: "",
        city: "Beirut",
        lineup: [],
        maxPerOrder: 6,
        maxPerBuyer: 6,
        agePolicy: "",
        refundPolicy: "",
      },
      "admin-1",
    ));
  (await Promise.all(waveSpecs.map(async (w, i) =>
        (await events.addWave(
                id,
                {
                  name: w.name ?? `Wave ${i + 1}`,
                  priceDollars: w.price ?? 20,
                  capacity: w.capacity,
                  mode: w.mode ?? "MANUAL",
                  manualOpen: w.open ?? true,
                  opensAt: w.opensAt ?? null,
                  closesAt: w.closesAt ?? null,
                },
                "admin-1",
              )))));
  (await events.setPublished(id, true, "admin-1"));
  const got = (await events.getAdmin(id))!;
  return { eventId: id, slug: got.event.slug, waveIds: got.waves.map((w) => w.id) };
}

let buyerSeq = 0;
/** A distinct buyer each call (unique email + phone), unless `who` pins one, so per-person limits don't interfere. */
export const buyer = (waveId: string, quantity = 1, who?: { email?: string; phone?: string }): CheckoutInput => {
  const n = ++buyerSeq;
  return {
    waveId,
    quantity,
    customerName: "Rami K",
    customerEmail: who?.email ?? `buyer${n}@x.test`,
    customerPhone: who?.phone ?? `+961 70 ${String(100000 + n).slice(-6)}`,
  };
};
