// Demo data: two staff accounts, three events showing every wave mode, one draft, and three
// guests on the first event (unpaid, screenshot waiting, paid).
// Idempotent: does nothing if users already exist. `npm run db:reset` wipes and re-seeds.
import { config } from "../config.ts";
import type { WaveInput } from "../domain/inputs.ts";
import { newId } from "../lib/ids.ts";
import { hashPassword } from "../lib/password.ts";
import { localInputToEpoch } from "../lib/time.ts";
import * as events from "../services/events.ts";
import { flushMail } from "../services/mailer.ts";
import * as orders from "../services/orders.ts";
import { db } from "./client.ts";
import { users } from "./schema.ts";

if ((await db().select({ id: users.id }).from(users).limit(1))[0]) {
  console.log("Already seeded. Use `npm run db:reset` to start over.");
  process.exit(0);
}

const adminId = newId();
(await db()
  .insert(users)
  .values([
    { id: adminId, email: config.seed.adminEmail, name: "Admin", passwordHash: hashPassword(config.seed.adminPassword), role: "ADMIN" },
    { id: newId(), email: config.seed.scannerEmail, name: "Door", passwordHash: hashPassword(config.seed.scannerPassword), role: "SCANNER" },
  ]).execute());

const inDays = (d: number, hhmm: string) => {
  const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  return localInputToEpoch(`${day}T${hhmm}`)!;
};

const base = {
  subtitle: null,
  organizer: "Night Shift",
  venueAddress: "Mar Mikhael",
  city: "Beirut",
  maxPerOrder: 6,
  maxPerBuyer: 6,
  agePolicy: "18+ only. Valid ID required at the door.",
  refundPolicy: "All sales are final. Tickets are non-refundable but may be transferred.",
};
const wave = (w: Partial<WaveInput> & Pick<WaveInput, "name" | "priceDollars" | "capacity">): WaveInput => ({
  mode: "MANUAL",
  manualOpen: false,
  opensAt: null,
  closesAt: null,
  ...w,
});

const e1 = (await events.create(
  {
    ...base,
    title: "Low Frequency",
    doorPriceCents: 2500, // walk-ins pay $25 cash at the door
    doorLimit: 60,
    slug: "low-frequency",
    subtitle: "Deep house till sunrise",
    description:
      "Eight hours of deep and minimal house on a sound system tuned for the room. No phones on the floor, no VIP tables in the middle of it. Doors at 22:00, last entry 02:00.",
    startsAt: inDays(10, "22:00"),
    endsAt: inDays(11, "06:00"),
    venueName: "The Ballroom",
    lineup: [
      { time: "22:00", name: "Nour", role: "warm-up" },
      { time: "00:00", name: "Karim Haddad" },
      { time: "02:30", name: "Aya b2b Rami", role: "closing" },
    ],
  },
  adminId,
));
(await events.addWave(e1, wave({ name: "Early Bird", priceDollars: 15, capacity: 5, manualOpen: true }), adminId));
(await events.addWave(e1, wave({ name: "Wave 1", priceDollars: 20, capacity: 40, mode: "AUTO" }), adminId));
(await events.addWave(e1, wave({ name: "Wave 2", priceDollars: 25, capacity: 60, mode: "AUTO" }), adminId));
(await events.addWave(e1, wave({ name: "Final Release", priceDollars: 30, capacity: 30, mode: "AUTO" }), adminId));
(await events.addWave(e1, wave({ name: "VIP", priceDollars: 60, capacity: 20, manualOpen: true }), adminId));
(await events.setPublished(e1, true, adminId));

const e2 = (await events.create(
  {
    ...base,
    title: "Neon Tide",
    slug: "neon-tide",
    organizer: "Tide Collective",
    subtitle: "Rooftop electro and breaks",
    description: "Electro, breaks and the sea breeze. Rooftop opens at sunset; bring a layer.",
    startsAt: inDays(24, "19:00"),
    endsAt: inDays(25, "02:00"),
    venueName: "Rooftop 33",
    venueAddress: "Gemmayzeh",
    lineup: [{ time: "19:00", name: "Tarek" }, { time: "21:30", name: "Lyne", role: "live" }, { time: "23:30", name: "Salma K" }],
  },
  adminId,
));
(await events.addWave(e2, wave({ name: "General", priceDollars: 20, capacity: 100, mode: "SCHEDULED", opensAt: inDays(2, "12:00") }), adminId));
(await events.setPublished(e2, true, adminId));

const e3 = (await events.create(
  {
    ...base,
    title: "Halloweekend",
    slug: "halloweekend",
    subtitle: "Two rooms, one night",
    description: "Costumes encouraged, not required. Techno upstairs, disco downstairs.",
    startsAt: inDays(5, "23:00"),
    endsAt: inDays(6, "07:00"),
    venueName: "Warehouse 9",
    venueAddress: "Karantina",
    lineup: [{ name: "Ziad" }, { name: "Maya Saab" }, { name: "Odd Hours", role: "live" }],
  },
  adminId,
));
(await events.addWave(e3, wave({ name: "Wave 1", priceDollars: 25, capacity: 3, manualOpen: true }), adminId));
(await events.addWave(e3, wave({ name: "Wave 2", priceDollars: 35, capacity: 50, mode: "AUTO" }), adminId));
(await events.setPublished(e3, true, adminId));

const e4 = (await events.create(
  { ...base, title: "Sunset Society", slug: "sunset-society", description: "Not announced yet.", startsAt: inDays(40, "17:00"), endsAt: null, venueName: "Beach Club", lineup: [] },
  adminId,
));
(await events.addWave(e4, wave({ name: "Presale", priceDollars: 30, capacity: 80 }), adminId));

// A few guests on the first event, one in each payment state, so every screen has something to show.
const demoWave = (await events.getAdmin(e1))!.waves.find((w) => w.name === "Early Bird")!.id;
const guest = (n: number, quantity: number) => ({
  waveId: demoWave,
  quantity,
  customerName: ["Rami Khoury", "Lea Haddad", "Omar Saab"][n]!,
  customerEmail: `guest${n + 1}@example.com`,
  customerPhone: `+961 70 10000${n + 1}`,
});
const png = () => new File([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex")], "payment.png", { type: "image/png" });
(await orders.confirm("low-frequency", guest(0, 2))); // unpaid: pays at the door
const checking = (await orders.confirm("low-frequency", guest(1, 1)));
(await orders.submitProof(checking.accessToken, png(), "NEO")); // screenshot waiting for an admin
const paid = (await orders.confirm("low-frequency", guest(2, 1)));
(await orders.submitProof(paid.accessToken, png(), "WHISH"));
(await orders.approve(paid.id, adminId));
(await flushMail());

console.log(`Seeded.
  admin:   ${config.seed.adminEmail} / ${config.seed.adminPassword}
  scanner: ${config.seed.scannerEmail} / ${config.seed.scannerPassword}`);
