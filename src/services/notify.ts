// Customer notifications: what to say. Delivery (when/how) is mailer.ts.
import { appUrl } from "../config.ts";
import type { Exec } from "../db/client.ts";
import type { Event, Order } from "../db/schema.ts";
import { fmtDate, money } from "../lib/time.ts";
import { queue } from "./mailer.ts";

const about = (o: Order) => ({ entityType: "order" as const, entityId: o.id, eventId: o.eventId, to: o.customerEmail });

export async function orderPlaced(x: Exec, order: Order, event: Event) {
  (await queue(x, {
        ...about(order),
        template: "order_placed",
        subject: `${event.title}: complete your payment (${order.reference})`,
        text: [
          `Hi ${order.customerName},`,
          ``,
          `Your ${order.quantity} ticket(s) for ${event.title} are held until ${fmtDate(order.expiresAt)}.`,
          `Pay ${money(order.totalCents)} with Whish and upload the proof here:`,
          appUrl(`/o/${order.accessToken}`),
          ``,
          `Reference: ${order.reference}`,
        ].join("\n"),
      }));
}

export async function ticketsIssued(x: Exec, order: Order, event: Event) {
  (await queue(x, {
        ...about(order),
        template: "tickets_issued",
        subject: `Your tickets for ${event.title} (${order.reference})`,
        text: [
          `Hi ${order.customerName},`,
          ``,
          `You're in. Your ${order.quantity} ticket(s) for ${event.title} are attached as a PDF.`,
          `${fmtDate(event.startsAt)} · ${event.venueName}, ${event.city}`,
          ``,
          `Show the QR code at the door. You can also open them here:`,
          appUrl(`/o/${order.accessToken}/tickets`),
          ``,
          event.agePolicy,
        ].join("\n"),
        attachTicketsFor: order.id,
      }));
}

export async function orderRejected(x: Exec, order: Order, event: Event, reason: string) {
  (await queue(x, {
        ...about(order),
        template: "order_rejected",
        subject: `${event.title}: we couldn't verify your payment (${order.reference})`,
        text: [
          `Hi ${order.customerName},`,
          ``,
          `We couldn't verify the payment for order ${order.reference}.`,
          `Reason: ${reason}`,
          ``,
          `Order: ${appUrl(`/o/${order.accessToken}`)}`,
          `Reply to this email if you think this is a mistake.`,
        ].join("\n"),
      }));
}
