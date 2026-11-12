// Customer notifications: what to say. Delivery (when/how) is mailer.ts.
import { appUrl } from "../config.ts";
import type { Exec } from "../db/client.ts";
import type { Event, Order } from "../db/schema.ts";
import { fmtDate, money } from "../lib/time.ts";
import { queue } from "./mailer.ts";

const about = (o: Order) => ({ entityType: "order" as const, entityId: o.id, eventId: o.eventId, to: o.customerEmail });

/** Sent the moment attendance is confirmed (and for guest-list tickets): the tickets themselves. */
export async function ticketsIssued(x: Exec, order: Order, event: Event) {
  const toPay = order.totalCents > 0 && order.status !== "APPROVED";
  (await queue(x, {
        ...about(order),
        template: "tickets_issued",
        subject: `Your ticket${order.quantity === 1 ? "" : "s"} for ${event.title} (${order.reference})`,
        text: [
          `Hi ${order.customerName},`,
          ``,
          `You're on the list. Your ${order.quantity} ticket(s) for ${event.title} are attached as a PDF.`,
          `${fmtDate(event.startsAt)} · ${event.venueName}, ${event.city}`,
          ``,
          `Show the QR code at the door. You can also open your tickets here:`,
          appUrl(`/o/${order.accessToken}`),
          ``,
          ...(toPay
            ? [`To pay: ${money(order.unitPriceCents)} per ticket. Pay by Whish or Neo and send the screenshot from the link above, or just pay cash at the door.`, ``]
            : []),
          event.agePolicy,
        ].join("\n"),
        attachTicketsFor: order.id,
      }));
}

export async function paymentVerified(x: Exec, order: Order, event: Event) {
  (await queue(x, {
        ...about(order),
        template: "payment_verified",
        subject: `${event.title}: payment received (${order.reference})`,
        text: [
          `Hi ${order.customerName},`,
          ``,
          `We've verified your payment for ${event.title}. Your tickets are paid; just show the QR code at the door.`,
          appUrl(`/o/${order.accessToken}`),
        ].join("\n"),
      }));
}

/** "Find my tickets": the links to every live order for one email address. */
export async function ticketLinks(x: Exec, email: string, found: { order: Order; event: Event }[]) {
  (await queue(x, {
        entityType: "order",
        entityId: found[0]!.order.id,
        eventId: found[0]!.order.eventId,
        to: email,
        template: "ticket_links",
        subject: "Your Night Shift tickets",
        text: [
          `Here are your tickets:`,
          ``,
          ...found.flatMap(({ order, event }) => [`${event.title}, ${fmtDate(event.startsAt)} (${order.quantity} ticket${order.quantity === 1 ? "" : "s"})`, appUrl(`/o/${order.accessToken}`), ``]),
          `Anyone with these links can open the tickets, so keep them to yourself.`,
        ].join("\n"),
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
          `We couldn't verify the payment screenshot for order ${order.reference}.`,
          `Reason: ${reason}`,
          ``,
          `Your ticket is still valid. Send a new screenshot here, or pay cash at the door:`,
          appUrl(`/o/${order.accessToken}`),
          `Reply to this email if you think this is a mistake.`,
        ].join("\n"),
      }));
}
