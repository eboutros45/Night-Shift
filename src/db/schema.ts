// Night Shift data model. Conventions:
//  - times are UTC epoch milliseconds (integer), money is integer cents
//  - statuses are plain text, validated by src/domain/status.ts
//  - wave stock is NOT stored; it is derived from orders (see services/inventory.ts)
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () => integer("created_at").notNull().default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(), // ADMIN | SCANNER
  createdAt: createdAt(),
});

export const events = sqliteTable("events", {
  id: id(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  organizer: text("organizer").notNull().default("Night Shift"),
  description: text("description").notNull().default(""),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at"),
  venueName: text("venue_name").notNull(),
  venueAddress: text("venue_address").notNull().default(""),
  city: text("city").notNull().default("Beirut"),
  lineup: text("lineup").notNull().default("[]"), // JSON: [{ name, role?, time? }]
  published: integer("published", { mode: "boolean" }).notNull().default(false),
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
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const waves = sqliteTable(
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
    manualOpen: integer("manual_open", { mode: "boolean" }).notNull().default(false),
    opensAt: integer("opens_at"), // SCHEDULED: on sale from this time
    closesAt: integer("closes_at"), // SCHEDULED: optional end of sale
  },
  (t) => [uniqueIndex("waves_event_position").on(t.eventId, t.position)],
);

export const orders = sqliteTable(
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
    isComp: integer("is_comp", { mode: "boolean" }).notNull().default(false),
    channel: text("channel").notNull().default("ONLINE"), // ONLINE (Whish, verified) | DOOR (cash, logged by staff)
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    expiresAt: integer("expires_at"), // only meaningful while AWAITING_PAYMENT
    proofKey: text("proof_key"), // file name in storage/proofs (never public)
    proofMime: text("proof_mime"),
    txnRef: text("txn_ref"),
    submittedAt: integer("submitted_at"),
    decidedAt: integer("decided_at"), // approve / reject / expire time
    decidedBy: text("decided_by"), // user id, or "system" for expiry
    rejectReason: text("reject_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("orders_wave_status").on(t.waveId, t.status),
    index("orders_status_expires").on(t.status, t.expiresAt),
    index("orders_event_status").on(t.eventId, t.status),
  ],
);

export const tickets = sqliteTable(
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
    checkedInAt: integer("checked_in_at"),
    checkedInBy: text("checked_in_by"),
    revokedAt: integer("revoked_at"),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("tickets_event_status").on(t.eventId, t.status), index("tickets_order").on(t.orderId)],
);

// One stream for everything that happens: state changes, admin actions, door scans, emails.
// Feeds every timeline and /admin/trace. Replaces the old AuditLog + ScanLog.
export const journal = sqliteTable(
  "journal",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
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
);

// First-party analytics. No cookies, no personal data: visitor = hash(ip, ua, day, secret).
export const pageViews = sqliteTable(
  "page_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    type: text("type").notNull(), // PAGE_VIEW | EVENT_VIEW | CHECKOUT_START
    eventId: text("event_id"),
    visitor: text("visitor").notNull(),
    path: text("path").notNull(),
    referrerHost: text("referrer_host"),
    device: text("device").notNull(), // mobile | tablet | desktop
  },
  (t) => [index("page_views_type_at").on(t.type, t.at), index("page_views_event").on(t.eventId, t.type)],
);

export type User = typeof users.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Wave = typeof waves.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type JournalRow = typeof journal.$inferSelect;
