// Night Shift data model. Conventions:
//  - times are UTC epoch milliseconds (integer), money is integer cents
//  - statuses are plain text, validated by src/domain/status.ts
//  - wave stock is NOT stored; it is derived from orders (see services/inventory.ts)
import { sql } from "drizzle-orm";
import { index, integer, bigint, boolean, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const createdAt = () => bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(), // ADMIN | SCANNER | CUSTOMER
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}).enableRLS();

export const events = pgTable("events", {
  id: id(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  organizer: text("organizer").notNull().default("Night Shift"),
  description: text("description").notNull().default(""),
  startsAt: bigint("starts_at", { mode: "number" }).notNull(),
  endsAt: bigint("ends_at", { mode: "number" }),
  venueName: text("venue_name").notNull(),
  venueAddress: text("venue_address").notNull().default(""),
  city: text("city").notNull().default("Beirut"),
  lineup: text("lineup").notNull().default("[]"), // JSON: [{ name, role?, time? }]
  published: boolean("published").notNull().default(false),
  maxPerOrder: integer("max_per_order").notNull().default(6),
  maxPerBuyer: integer("max_per_buyer").notNull().default(6), // across all of one person's orders for this event
  doorPriceCents: integer("door_price_cents"), // walk-in cash price; null = no walk-in sales
  doorLimit: integer("door_limit"), // max walk-in tickets; null = no limit
  agePolicy: text("age_policy").notNull().default("18+ only. Valid ID required at the door."),
  refundPolicy: text("refund_policy")
    .notNull()
    .default("All sales are final. Tickets are non-refundable but may be transferred."),
  posterKey: text("poster_key"), // file name in storage/media
  theme: text("theme"), // JSON, filled during UI sweeps
  createdAt: createdAt(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
}).enableRLS();

export const waves = pgTable(
  "waves",
  {
    id: id(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    priceCents: integer("price_cents").notNull(),
    capacity: integer("capacity").notNull(),
    mode: text("mode").notNull().default("MANUAL"), // MANUAL | AUTO | SCHEDULED
    manualOpen: boolean("manual_open").notNull().default(false),
    opensAt: bigint("opens_at", { mode: "number" }), // SCHEDULED: on sale from this time
    closesAt: bigint("closes_at", { mode: "number" }), // SCHEDULED: optional end of sale
  },
  (t) => [uniqueIndex("waves_event_position").on(t.eventId, t.position)],
).enableRLS();

export const orders = pgTable(
  "orders",
  {
    id: id(),
    reference: text("reference").notNull().unique(), // NS-7K3Q9X, for humans
    accessToken: text("access_token").notNull().unique(), // unguessable, in customer URLs
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    waveId: text("wave_id").references(() => waves.id),
    status: text("status").notNull(), // see ORDER_STATUSES
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    isComp: boolean("is_comp").notNull().default(false),
    channel: text("channel").notNull().default("ONLINE"), // ONLINE (Whish, verified) | DOOR (cash, logged by staff)
    userId: text("user_id").references(() => users.id),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }), // only meaningful while AWAITING_PAYMENT
    payMethod: text("pay_method"), // WHISH | NEO, set when a payment screenshot is submitted
    proofKey: text("proof_key"), // file name in storage/proofs (never public)
    proofMime: text("proof_mime"),
    txnRef: text("txn_ref"),
    submittedAt: bigint("submitted_at", { mode: "number" }),
    decidedAt: bigint("decided_at", { mode: "number" }), // approve / reject / expire time
    decidedBy: text("decided_by"), // user id, or "system" for expiry
    rejectReason: text("reject_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("orders_user").on(t.userId),
    index("orders_wave_status").on(t.waveId, t.status),
    index("orders_status_expires").on(t.status, t.expiresAt),
    index("orders_event_status").on(t.eventId, t.status),
  ],
).enableRLS();

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    token: text("token").notNull().unique(), // 128-bit base64url; the only thing in the QR
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    attendeeName: text("attendee_name").notNull(),
    status: text("status").notNull().default("VALID"), // VALID | CHECKED_IN | REVOKED
    priceCents: integer("price_cents").notNull().default(0), // what this ticket costs
    paidAt: bigint("paid_at", { mode: "number" }), // null = not paid yet
    paidVia: text("paid_via"), // see PAID_VIA
    paidBy: text("paid_by"), // staff user who verified the transfer or took the cash
    checkedInAt: bigint("checked_in_at", { mode: "number" }),
    checkedInBy: text("checked_in_by"),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("tickets_event_status").on(t.eventId, t.status), index("tickets_order").on(t.orderId)],
).enableRLS();

// One stream for everything that happens: state changes, admin actions, door scans, emails.
// Feeds every timeline and /admin/trace. Replaces the old AuditLog + ScanLog.
export const journal = pgTable(
  "journal",
  {
    id: serial("id").primaryKey(),
    at: bigint("at", { mode: "number" }).notNull(),
    actor: text("actor").notNull(), // user id | "customer" | "system"
    entityType: text("entity_type").notNull(), // order | ticket | event | wave | user | scan
    entityId: text("entity_id"),
    eventId: text("event_id"),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    data: text("data"), // JSON
  },
  (t) => [
    index("journal_entity").on(t.entityType, t.entityId),
    index("journal_event_action").on(t.eventId, t.action, t.at),
    index("journal_at").on(t.at),
  ],
).enableRLS();

// First-party analytics. No cookies, no personal data: visitor = hash(ip, ua, day, secret).
export const pageViews = pgTable(
  "page_views",
  {
    id: serial("id").primaryKey(),
    at: bigint("at", { mode: "number" }).notNull(),
    type: text("type").notNull(), // PAGE_VIEW | EVENT_VIEW | CHECKOUT_START
    eventId: text("event_id"),
    visitor: text("visitor").notNull(),
    path: text("path").notNull(),
    referrerHost: text("referrer_host"),
    device: text("device").notNull(), // mobile | tablet | desktop
  },
  (t) => [index("page_views_type_at").on(t.type, t.at), index("page_views_event").on(t.eventId, t.type)],
).enableRLS();

export type User = typeof users.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Wave = typeof waves.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type JournalRow = typeof journal.$inferSelect;

// Shared across Worker isolates; keys are hashed, never raw emails or IP addresses.
export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  n: integer("n").notNull().default(0),
  resetAt: bigint("reset_at", { mode: "number" }).notNull(),
  reported: boolean("reported").notNull().default(false),
}).enableRLS();

// Login codes are HMAC hashes; session tokens are SHA-256 hashes, never raw values.
export const loginChallenges = pgTable("login_challenges", {
  id: id(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  audience: text("audience").notNull().default("staff"),
  codeHash: text("code_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
}, (t) => [uniqueIndex("login_challenges_user").on(t.userId), uniqueIndex("login_challenges_email").on(t.email), index("login_challenges_expiry").on(t.expiresAt)]).enableRLS();

export const staffSessions = pgTable("staff_sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}, (t) => [index("staff_sessions_user").on(t.userId), index("staff_sessions_expiry").on(t.expiresAt)]).enableRLS();
