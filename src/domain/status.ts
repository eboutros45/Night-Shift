// Domain vocabulary and state machines. Pure: no database, no clock.

export const ROLES = ["ADMIN", "SCANNER"] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = ["AWAITING_PAYMENT", "PENDING_VERIFICATION", "APPROVED", "REJECTED", "EXPIRED", "VOIDED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TICKET_STATUSES = ["VALID", "CHECKED_IN", "REVOKED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const WAVE_MODES = ["MANUAL", "AUTO", "SCHEDULED"] as const;
export type WaveMode = (typeof WAVE_MODES)[number];

export const SCAN_RESULTS = ["ADMITTED", "ALREADY_USED", "REVOKED", "WRONG_EVENT", "INVALID"] as const;
export type ScanResult = (typeof SCAN_RESULTS)[number];

const ORDER_FLOW: Record<OrderStatus, readonly OrderStatus[]> = {
  AWAITING_PAYMENT: ["PENDING_VERIFICATION", "EXPIRED"],
  PENDING_VERIFICATION: ["APPROVED", "REJECTED"],
  APPROVED: ["VOIDED"], // only door (cash) sales can be voided; see services/door-sales.ts
  REJECTED: [],
  EXPIRED: [],
  VOIDED: [],
};

/** What an order bought, in words: guest list, a walk-in at the door, or the wave name. */
export function orderTier(o: { isComp: boolean; channel: string }, waveName?: string | null) {
  if (o.isComp) return "Guest list";
  if (o.channel === "DOOR") return "Walk-in (cash)";
  return waveName ?? "General";
}

export const ORDER_CHANNELS = ["ONLINE", "DOOR"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

const TICKET_FLOW: Record<TicketStatus, readonly TicketStatus[]> = {
  VALID: ["CHECKED_IN", "REVOKED"],
  CHECKED_IN: [],
  REVOKED: [],
};

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 403 | 404 | 409 | 413 | 429 = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function assertOrderTransition(from: string, to: OrderStatus) {
  if (!(ORDER_FLOW[from as OrderStatus] ?? []).includes(to))
    throw new DomainError("ILLEGAL_TRANSITION", `Order cannot move from ${from} to ${to}.`, 409);
}

export function assertTicketTransition(from: string, to: TicketStatus) {
  if (!(TICKET_FLOW[from as TicketStatus] ?? []).includes(to))
    throw new DomainError("ILLEGAL_TRANSITION", `Ticket cannot move from ${from} to ${to}.`, 409);
}

/**
 * The status a reader should see. An unpaid order past its hold is EXPIRED even before
 * the sweep writes it down, so no screen ever shows a stale "awaiting payment".
 */
export function effectiveOrderStatus(o: { status: string; expiresAt: number | null }, now: number): OrderStatus {
  if (o.status === "AWAITING_PAYMENT" && o.expiresAt !== null && o.expiresAt <= now) return "EXPIRED";
  return o.status as OrderStatus;
}
