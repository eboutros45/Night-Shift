// Input validation for everything users and admins submit. Routes parse form bodies with
// these; services receive already-clean values.
import { z } from "zod";
import { PAY_METHODS } from "./status.ts";
import { localInputToEpoch } from "../lib/time.ts";

const trimmed = (max: number) => z.string().trim().max(max);
const required = (max: number, label: string) => trimmed(max).min(1, `${label} is required.`);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const localTime = z
  .string()
  .transform((v, ctx) => {
    const t = localInputToEpoch(v);
    if (t === null) {
      ctx.addIssue({ code: "custom", message: "Use the date/time picker." });
      return z.NEVER;
    }
    return t;
  });
const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());

export const checkoutInput = z.object({
  waveId: z.string().min(1, "Pick a wave."),
  quantity: int(1, 20),
  customerName: required(80, "Name"),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid email."),
  customerPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number."),
});
export type CheckoutInput = z.infer<typeof checkoutInput>;

export const proofInput = z.object({ method: z.enum(PAY_METHODS, "Choose Whish or Neo.") });

/** Lineup textarea: one act per line, "22:00 | Name | role" (time and role optional). */
export type LineupItem = { name: string; role?: string; time?: string };
export function parseLineup(text: string): LineupItem[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split("|").map((p) => p.trim()))
    .filter((p) => p.some(Boolean))
    .map((p) => {
      if (p.length === 1) return { name: p[0]! };
      if (/^\d{1,2}:\d{2}$/.test(p[0]!)) return { time: p[0], name: p[1] ?? "", role: p[2] || undefined };
      return { name: p[0]!, role: p[1] || undefined };
    })
    .filter((i) => i.name);
}
export const lineupToText = (items: LineupItem[]) =>
  items.map((i) => [i.time, i.name, i.role].filter(Boolean).join(" | ")).join("\n");

export const eventInput = z
  .object({
    title: required(120, "Title"),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: lowercase letters, numbers and dashes."),
    subtitle: trimmed(160).transform((v) => v || null),
    organizer: z.string().trim().max(80).optional().transform((v) => v || "Night Shift"),
    description: trimmed(5000),
    startsAt: localTime,
    endsAt: z.union([z.literal("").transform(() => null), localTime]),
    venueName: required(120, "Venue"),
    venueAddress: trimmed(200),
    city: required(60, "City"),
    lineup: trimmed(5000).transform(parseLineup),
    maxPerOrder: int(1, 20),
    maxPerBuyer: int(1, 100),
    // Blank door price = no walk-in sales. Blank limit = no limit.
    doorPrice: z
      .union([z.literal(""), z.coerce.number().min(0, "Door price can't be negative.").max(10_000)])
      .optional(),
    doorLimit: z.union([z.literal(""), int(1, 100_000)]).optional(),
    agePolicy: trimmed(300),
    refundPolicy: trimmed(300),
  })
  .refine((e) => e.endsAt === null || e.endsAt > e.startsAt, { message: "End must be after start.", path: ["endsAt"] })
  .refine((e) => e.maxPerBuyer >= e.maxPerOrder, { message: "Must be at least the per-order max.", path: ["maxPerBuyer"] })
  .transform(({ doorPrice, doorLimit, ...e }) => ({
    ...e,
    // undefined (field not sent) leaves the stored value alone on update; "" clears it.
    doorPriceCents: doorPrice === undefined ? undefined : doorPrice === "" ? null : Math.round(doorPrice * 100),
    doorLimit: doorLimit === undefined ? undefined : doorLimit === "" ? null : doorLimit,
  }));
type ParsedEvent = z.output<typeof eventInput>;
export type EventInput = Omit<ParsedEvent, "doorPriceCents" | "doorLimit"> & { doorPriceCents?: number | null; doorLimit?: number | null };

/** A walk-in paying cash at the door, logged by staff. */
export const doorSaleInput = z.object({
  quantity: int(1, 20),
  name: z.string().trim().max(80).optional().transform((v) => v || "Walk-in"),
});
export type DoorSaleInput = z.infer<typeof doorSaleInput>;

export const voidInput = z.object({ reason: required(200, "Reason") });

const optionalLocalTime = z.union([z.undefined().transform(() => null), z.literal("").transform(() => null), localTime]);

export const waveInput = z
  .object({
    name: required(60, "Wave name"),
    priceDollars: z.coerce.number().min(0).max(10_000),
    capacity: int(1, 100_000),
    mode: z.enum(["MANUAL", "AUTO", "SCHEDULED"]),
    manualOpen: checkbox,
    opensAt: optionalLocalTime,
    closesAt: optionalLocalTime,
  })
  .refine((w) => w.mode !== "SCHEDULED" || w.opensAt !== null, { message: "Scheduled waves need an opening time.", path: ["opensAt"] })
  .refine((w) => w.opensAt === null || w.closesAt === null || w.closesAt > w.opensAt, { message: "Sale must end after it opens.", path: ["closesAt"] });
export type WaveInput = z.infer<typeof waveInput>;

export const compInput = z.object({
  eventId: z.string().min(1),
  attendeeName: required(80, "Name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: trimmed(20),
  quantity: int(1, 20),
  note: trimmed(200).optional(),
});
export type CompInput = z.infer<typeof compInput>;

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

/** First error message per field, for re-rendering a form next to its inputs. */
export function fieldErrors(err: z.ZodError) {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = String(i.path[0] ?? "_");
    out[k] ??= i.message;
  }
  return out;
}
