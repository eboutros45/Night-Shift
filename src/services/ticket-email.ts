// The tickets email: the tickets themselves in the body (one stub per ticket with its QR code
// embedded inline), plus the PDF attached. Built at send time from the database, so a resend
// always shows each ticket's current state.
//
// Email-client rules followed here: table layout, inline styles only, no web fonts or CSS
// classes relied on, images referenced by cid: (embedded, so they show even with remote
// images blocked), every value HTML-escaped.
import { asc, eq } from "drizzle-orm";
import { appUrl, config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { events, orders, tickets, waves } from "../db/schema.ts";
import { ticketsPdf } from "../lib/pdf.ts";
import { qrPng } from "../lib/qr.ts";
import { orderTier } from "../domain/status.ts";
import { fmtDayLong, fmtHourMin, money } from "../lib/time.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const C = { black: "#000000", char: "#141414", bone: "#EDE8DF", fog: "#8E8E8E", sodium: "#FFB238", ink: "#000000", grey: "#6B6963" };
const FONT = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";
const DISPLAY = "'Archivo Narrow','Arial Narrow','Helvetica Neue',Helvetica,Arial,sans-serif";

export async function buildTicketsEmail(target: Db, orderId: string) {
  const order = target.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new Error(`order ${orderId} not found`);
  const event = target.select().from(events).where(eq(events.id, order.eventId)).get()!;
  const waveName = order.waveId ? (target.select({ name: waves.name }).from(waves).where(eq(waves.id, order.waveId)).get()?.name ?? null) : null;
  const list = target.select().from(tickets).where(eq(tickets.orderId, orderId)).orderBy(asc(tickets.createdAt)).all();
  const tier = orderTier(order, waveName);
  const when = `${fmtDayLong(event.startsAt)}, doors ${fmtHourMin(event.startsAt)}`;
  const where = [event.venueName, event.venueAddress, event.city].filter(Boolean).join(", ");
  const link = appUrl(`/o/${order.accessToken}/tickets`);

  const qrs = await Promise.all(list.map((t) => qrPng(t.token)));
  const pdf = await ticketsPdf(order, event, list, waveName);

  const stub = (t: (typeof list)[number], i: number) => {
    const usable = t.status === "VALID";
    return `
<tr><td style="padding:0 0 22px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bone};border-radius:10px;border-collapse:separate">
    <tr><td style="padding:22px 24px 16px;font-family:${FONT};color:${C.ink}">
      <div style="font-family:${DISPLAY};font-weight:800;font-size:30px;line-height:30px;letter-spacing:-0.5px;text-transform:uppercase;margin:0 0 10px">${esc(event.title)}</div>
      <div style="font-size:14px;line-height:20px;font-weight:600">${esc(when)}<br>${esc(where)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>
        <td style="font-family:${FONT};font-size:14px;line-height:19px;color:${C.ink}"><strong style="font-size:16px">${esc(t.attendeeName)}</strong><br>${esc(tier)}</td>
        <td align="right" valign="bottom" style="font-family:${FONT};font-size:13px;color:${C.grey}">${i + 1} of ${list.length}</td>
      </tr></table>
    </td></tr>
    <tr><td style="border-top:2px dashed #b9b4ab;padding:20px 24px 22px" align="center">
      ${
        usable
          ? `<img src="cid:qr-${i}@nightshift" width="220" height="220" alt="QR code for ticket ${i + 1}" style="display:block;width:220px;height:220px;border:0;background:#ffffff;padding:8px;border-radius:6px">`
          : `<div style="font-family:${DISPLAY};font-weight:800;font-size:26px;color:${t.status === "CHECKED_IN" ? "#1e6b2a" : "#b42318"};padding:40px 0">${t.status === "CHECKED_IN" ? "ALREADY USED" : "CANCELLED"}</div>`
      }
      <div style="font-family:Consolas,'Courier New',monospace;font-size:12px;color:${C.grey};padding-top:10px">${esc(t.token)}</div>
    </td></tr>
  </table>
</td></tr>`;
  };

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<title>Your tickets for ${esc(event.title)}</title></head>
<body style="margin:0;padding:0;background:${C.black}">
<div style="display:none;max-height:0;overflow:hidden">${list.length} ticket${list.length === 1 ? "" : "s"} for ${esc(event.title)}, ${esc(when)}. Show the QR code at the door.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.black}"><tr><td align="center" style="padding:28px 14px 40px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
    <tr><td style="padding:0 0 26px;font-family:${DISPLAY};font-weight:800;font-size:22px;letter-spacing:-0.3px;color:${C.bone}">NIGHT<span style="color:${C.sodium}">/</span>SHIFT</td></tr>
    <tr><td style="font-family:${DISPLAY};font-weight:800;font-size:44px;line-height:42px;text-transform:uppercase;color:${C.bone};padding:0 0 12px">You're in</td></tr>
    <tr><td style="font-family:${FONT};font-size:16px;line-height:24px;color:${C.bone};padding:0 0 26px">
      Hi ${esc(order.customerName.split(" ")[0] ?? order.customerName)}, your payment is verified. Here ${list.length === 1 ? "is your ticket" : `are your ${list.length} tickets`} for <strong>${esc(event.title)}</strong>. Show one code per person at the door; turning your screen brightness up helps.
    </td></tr>
    ${list.map(stub).join("")}
    <tr><td align="center" style="padding:6px 0 28px">
      <a href="${esc(link)}" style="display:inline-block;background:${C.sodium};color:#1a1000;font-family:${FONT};font-weight:700;font-size:16px;text-decoration:none;padding:14px 26px;border-radius:999px">Open tickets online</a>
    </td></tr>
    <tr><td style="font-family:${FONT};font-size:13px;line-height:20px;color:${C.fog};border-top:1px solid #2a2a2a;padding-top:18px">
      The same tickets are attached as a PDF (one page per ticket) if you'd rather print or save them.<br>
      ${esc(event.agePolicy)} ${esc(event.refundPolicy)}<br><br>
      Order ${esc(order.reference)}${order.isComp ? "" : `, ${list.length} × ${esc(tier)}, ${esc(money(order.totalCents))}`}<br>
      Questions? Reply to this email or write to ${esc(config.brand.supportEmail)}.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return {
    html,
    attachments: [
      { filename: `${order.reference}-tickets.pdf`, content: pdf, contentType: "application/pdf" },
      ...qrs.map((png, i) => ({ filename: `ticket-${i + 1}-qr.png`, content: png, contentType: "image/png", cid: `qr-${i}@nightshift` })),
    ],
  };
}
