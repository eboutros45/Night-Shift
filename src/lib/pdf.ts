// Ticket PDF: one page per ticket, in the same "printed stub" design as the website
// (bone paper, black type, sodium-amber accent, perforation, big QR). Standard PDF fonts only,
// so no font files are embedded and the file stays small.
import { degrees, PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { config } from "../config.ts";
import type { Event, Order, Ticket } from "../db/schema.ts";
import { orderTier } from "../domain/status.ts";
import { qrPng } from "./qr.ts";
import { fmtDayLong, fmtHourMin, money } from "./time.ts";

const W = 380;
const H = 680;
const M = 28; // side margin
const BONE = rgb(0.929, 0.91, 0.875);
const INK = rgb(0, 0, 0);
const FOG = rgb(0.42, 0.41, 0.39);
const SODIUM = rgb(1, 0.698, 0.22);
const PERF_Y = 318; // perforation line

// Standard PDF fonts only cover Latin-1; replace anything else so a name never breaks the PDF.
const safe = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

/** Split text into lines that fit `width`, shrinking the size until it fits in `maxLines`. */
function fitTitle(text: string, font: PDFFont, width: number, start: number, maxLines: number) {
  const words = safe(text).toUpperCase().split(/\s+/);
  for (let size = start; size >= 14; size -= 1) {
    const lines: string[] = [];
    let cur = "";
    let ok = true;
    for (const w of words) {
      if (font.widthOfTextAtSize(w, size) > width) ok = false;
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (ok && lines.length <= maxLines) return { lines, size };
  }
  return { lines: [safe(text).toUpperCase().slice(0, 28)], size: 14 };
}

function field(page: PDFPage, x: number, y: number, label: string, value: string, f: { reg: PDFFont; bold: PDFFont }, maxW = 150) {
  page.drawText(label, { x, y, size: 7.5, font: f.reg, color: FOG });
  // Truncate with "..." if the value is wider than its column.
  let v = safe(value);
  if (f.bold.widthOfTextAtSize(v, 11) > maxW) {
    while (v.length > 1 && f.bold.widthOfTextAtSize(`${v}...`, 11) > maxW) v = v.slice(0, -1);
    v = `${v.trimEnd()}...`;
  }
  page.drawText(v, { x, y: y - 14, size: 11, font: f.bold, color: INK });
}

export async function ticketsPdf(order: Order, event: Event, tickets: Ticket[], waveName?: string | null) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${event.title} tickets ${order.reference}`);
  doc.setAuthor(config.brand.name);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const f = { reg, bold };
  const tier = orderTier(order, waveName);

  for (const [i, t] of tickets.entries()) {
    const page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: BONE });

    // Header band with wordmark
    page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: INK });
    let x = M;
    for (const [part, color] of [["NIGHT", BONE], ["/", SODIUM], ["SHIFT", BONE]] as const) {
      page.drawText(part, { x, y: H - 35, size: 16, font: bold, color });
      x += bold.widthOfTextAtSize(part, 16) + 1;
    }
    const count = `TICKET ${i + 1} OF ${tickets.length}`;
    page.drawText(count, { x: W - M - reg.widthOfTextAtSize(count, 8), y: H - 32, size: 8, font: reg, color: BONE });

    // Title
    page.drawText(safe(`${event.organizer} presents`), { x: M, y: H - 86, size: 9, font: reg, color: FOG });
    const title = fitTitle(event.title, bold, W - 2 * M, 38, 3);
    let y = H - 92 - title.size * 0.9;
    for (const line of title.lines) {
      page.drawText(line, { x: M, y, size: title.size, font: bold, color: INK });
      y -= title.size * 0.95;
    }

    // Details grid
    y -= 18;
    field(page, M, y, "Date", fmtDayLong(event.startsAt), f, 200);
    field(page, W - M - 90, y, "Doors", fmtHourMin(event.startsAt), f, 90);
    y -= 38;
    field(page, M, y, "Venue", `${event.venueName}${event.city ? `, ${event.city}` : ""}`, f, W - 2 * M);
    y -= 38;
    field(page, M, y, "Name", t.attendeeName, f, 200);
    field(page, W - M - 90, y, "Ticket", tier, f, 90);
    y -= 38;
    field(page, M, y, "Order", order.reference, f, 200);
    field(page, W - M - 90, y, "Price", order.isComp ? "Free" : money(order.unitPriceCents), f, 90);

    // Perforation with punched notches
    page.drawLine({ start: { x: 16, y: PERF_Y }, end: { x: W - 16, y: PERF_Y }, thickness: 1.2, color: FOG, dashArray: [5, 4] });
    page.drawCircle({ x: 0, y: PERF_Y, size: 12, color: INK });
    page.drawCircle({ x: W, y: PERF_Y, size: 12, color: INK });

    // QR on white
    const qrSize = 214;
    const qx = (W - qrSize) / 2;
    const qy = PERF_Y - 28 - qrSize;
    page.drawRectangle({ x: qx - 8, y: qy - 8, width: qrSize + 16, height: qrSize + 16, color: rgb(1, 1, 1) });
    page.drawImage(await doc.embedPng(await qrPng(t.token)), { x: qx, y: qy, width: qrSize, height: qrSize });
    page.drawText(t.token, { x: (W - mono.widthOfTextAtSize(t.token, 8.5)) / 2, y: qy - 24, size: 8.5, font: mono, color: FOG });

    // Footer
    const note = "Show this code at the door. Each code scans once.";
    page.drawText(note, { x: (W - reg.widthOfTextAtSize(note, 8.5)) / 2, y: 34, size: 8.5, font: reg, color: INK });
    const policy = safe(event.agePolicy);
    page.drawText(policy, { x: (W - reg.widthOfTextAtSize(policy, 7.5)) / 2, y: 20, size: 7.5, font: reg, color: FOG, maxWidth: W - 2 * M });

    // Stamp for tickets that can no longer be used
    if (t.status !== "VALID") {
      const label = t.status === "CHECKED_IN" ? "USED" : "CANCELLED";
      const color = t.status === "CHECKED_IN" ? rgb(0.12, 0.42, 0.16) : rgb(0.7, 0.14, 0.09);
      const size = 34;
      const tw = bold.widthOfTextAtSize(label, size);
      page.drawRectangle({ x: (W - tw) / 2 - 12, y: 170, width: tw + 24, height: size + 14, borderColor: color, borderWidth: 3, color: BONE, rotate: degrees(-8) });
      page.drawText(label, { x: (W - tw) / 2, y: 180, size, font: bold, color, rotate: degrees(-8) });
    }
  }
  return Buffer.from(await doc.save());
}
