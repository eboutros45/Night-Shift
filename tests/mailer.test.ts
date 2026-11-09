import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tx } from "../src/db/client.ts";
import { feed } from "../src/services/journal.ts";
import { flushMail, queue } from "../src/services/mailer.ts";
import * as orders from "../src/services/orders.ts";
import { buyer, freshDb, makeEvent, T0 } from "./helpers.ts";

let logs: string[] = [];
beforeEach(async () => {
  (await freshDb());
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => (await flushMail()));

async function approvedOrder() {
  const e = (await makeEvent([{ capacity: 5 }]));
  const o = (await orders.reserve(e.slug, buyer(e.waveIds[0]!, 2), T0));
  await orders.submitProof(o.accessToken, null, "WH-1", T0 + 1);
  (await orders.approve(o.id, "admin-1", T0 + 2));
  await flushMail();
  return o;
}

it("sends the tickets email after commit with the PDF attached", async () => {
  const o = await approvedOrder();
  const sent = (await feed({ action: "EMAIL_SENT" })).map((r) => r.parsed);
  expect(sent.map((d) => d?.template).sort()).toEqual(["order_placed", "tickets_issued"]);
  // The PDF plus one inline QR image per ticket (shown in the email body).
  expect(sent.find((d) => d?.template === "tickets_issued")?.attachments).toEqual([
    `${o.reference}-tickets.pdf`,
    "ticket-1-qr.png",
    "ticket-2-qr.png",
  ]);
  expect(logs.some((l) => /attached: NS-\w+-tickets\.pdf \(\d+ bytes\)/.test(l))).toBe(true);
});

it("resend queues the tickets email again, recorded as done by the admin", async () => {
  const o = await approvedOrder();
  (await orders.resendTickets(o.id, "admin-1"));
  await flushMail();
  expect((await feed({ action: "TICKETS_RESENT" }))[0]?.actor).toBe("admin-1");
  expect((await feed({ action: "EMAIL_SENT" })).filter((r) => r.parsed?.template === "tickets_issued")).toHaveLength(2);
});

it("journals a failure instead of throwing", async () => {
  (await tx(async (t) => (await queue(t, { template: "tickets_issued", to: "x@x.test", subject: "s", text: "t", entityType: "order", entityId: "o1", attachTicketsFor: "missing-order" }))));
  await flushMail();
  expect((await feed({ action: "EMAIL_FAILED" }))[0]?.parsed?.error).toMatch(/not found/);
});

it("sends nothing when the transaction rolls back", async () => {
  await expect((async () =>
        (await tx(async (t) => {
                (await queue(t, { template: "test", to: "x@x.test", subject: "s", text: "t", entityType: "user", entityId: "admin-1" }));
                throw new Error("boom");
              })))()).rejects.toThrow("boom");
  await flushMail();
  expect((await feed({ action: "EMAIL_SENT" }))).toHaveLength(0);
  expect((await feed({ action: "EMAIL_QUEUED" }))).toHaveLength(0); // the queued row rolled back too
});
