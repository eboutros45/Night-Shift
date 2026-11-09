// Email delivery. Services call queue() inside their transaction: that records EMAIL_QUEUED
// and schedules delivery for AFTER commit, so a slow or failing mail server can never block
// or roll back an approval. The outcome is journaled as EMAIL_SENT or EMAIL_FAILED, so every
// email (and every failure, with its error) shows up on the order timeline.
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";
import { afterCommit, db, type Db, type Exec } from "../db/client.ts";
import { buildTicketsEmail } from "./ticket-email.ts";
import { record, type Entry } from "./journal.ts";

export type Mail = {
  template: string;
  to: string;
  subject: string;
  text: string;
  /** What the journal rows attach to (an order, or a user for test emails). */
  entityType: Entry["entityType"];
  entityId: string;
  eventId?: string | null;
  /** Generate and attach this order's ticket PDF at send time. */
  attachTicketsFor?: string;
};

let transport: Transporter | null = null;
function transporter() {
  const s = config.email.smtp;
  // Local catchers (Mailpit on localhost:1025) need no login; real servers like Gmail do.
  if (s.user && !s.pass) throw new Error("SMTP_PASS must be set in .env when SMTP_USER is set");
  if (!s.user && !/^(localhost|127\.0\.0\.1|::1)$/.test(s.host)) throw new Error("SMTP_USER and SMTP_PASS must be set in .env for a remote SMTP server");
  transport ??= nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
  return transport;
}


const inFlight = new Set<Promise<void>>();

/** Send now and journal the outcome. `target` is the database the mail was queued against. */
export async function deliver(m: Mail, target: Db = db()) {
  const base = { actor: "system", entityType: m.entityType, entityId: m.entityId, eventId: m.eventId ?? null } as const;
  try {
    // Ticket emails carry the tickets themselves: HTML stubs with inline QR codes + the PDF.
    const rich = m.attachTicketsFor ? await buildTicketsEmail(target, m.attachTicketsFor) : null;
    const attachments = rich?.attachments ?? [];
    let messageId: string | undefined;
    if (config.email.provider === "smtp") {
      // Reply-To: buyers who hit "reply" reach a real inbox even if the From address has none.
      const info = await transporter().sendMail({ from: config.email.from, replyTo: config.brand.supportEmail, to: m.to, subject: m.subject, text: m.text, html: rich?.html, attachments });
      messageId = info.messageId;
    } else {
      const files = attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ");
      console.log(`\n[email:${m.template}] to=${m.to}\n  ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}${files ? `\n  attached: ${files}` : ""}\n`);
    }
    record(target, {
      ...base,
      action: "EMAIL_SENT",
      data: { template: m.template, to: m.to, provider: config.email.provider, attachments: attachments.map((a) => a.filename), messageId },
    });
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    console.error(`[email:${m.template}] FAILED to=${m.to}: ${error}`);
    record(target, { ...base, action: "EMAIL_FAILED", data: { template: m.template, to: m.to, provider: config.email.provider, error } });
  }
}

/** Record the email as queued (inside the caller's transaction) and send it after commit. */
export function queue(x: Exec, m: Mail) {
  record(x, {
    actor: "system",
    entityType: m.entityType,
    entityId: m.entityId,
    eventId: m.eventId ?? null,
    action: "EMAIL_QUEUED",
    data: { template: m.template, to: m.to, subject: m.subject, pdf: Boolean(m.attachTicketsFor) },
  });
  const target = db();
  afterCommit(() => {
    const p = deliver(m, target).finally(() => inFlight.delete(p));
    inFlight.add(p);
  });
}

/** Wait for queued emails to finish (tests; graceful shutdown). */
export async function flushMail() {
  await new Promise((r) => setImmediate(r));
  await Promise.all(inFlight);
}

/** Log in to the SMTP server without sending anything. */
export async function verifySmtp() {
  if (config.email.provider !== "smtp") return { ok: true, detail: "EMAIL_PROVIDER=console: emails are printed to the server console, nothing is sent." };
  try {
    await transporter().verify();
    const s = config.email.smtp;
    return { ok: true, detail: s.user ? `Logged in to ${s.host} as ${s.user}.` : `Connected to ${s.host}:${s.port} (no login needed).` };
  } catch (err) {
    transport = null; // retry with fresh settings next time
    return { ok: false, detail: (err as Error).message };
  }
}
