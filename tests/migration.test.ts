import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

// Tickets that existed before payment moved onto the ticket were all issued against paid orders.
test("0005 backfills existing tickets as paid, by how the order was paid", async () => {
  const pg = new PGlite();
  const files = readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).sort();
  for (const f of files.filter((n) => n < "0005")) await pg.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  await pg.exec(`
    insert into events (id, slug, title, starts_at, venue_name) values ('e', 'e', 'E', 1, 'V');
    insert into orders (id, reference, access_token, event_id, status, quantity, unit_price_cents, total_cents, is_comp, channel, customer_name, customer_email, customer_phone, decided_at, decided_by, submitted_at) values
      ('web', 'R1', 'a1', 'e', 'APPROVED', 2, 2000, 4000, false, 'ONLINE', 'A', 'a@x', '1', 500, 'admin-1', 400),
      ('comp', 'R2', 'a2', 'e', 'APPROVED', 1, 0, 0, true, 'ONLINE', 'B', 'b@x', '2', 600, 'admin-1', null),
      ('door', 'R3', 'a3', 'e', 'APPROVED', 1, 1500, 1500, false, 'DOOR', 'C', '', '', 700, 'scan-1', null),
      ('wait', 'R4', 'a4', 'e', 'PENDING_VERIFICATION', 1, 2000, 2000, false, 'ONLINE', 'D', 'd@x', '4', null, null, 800);
    insert into tickets (id, token, order_id, event_id, attendee_name) values
      ('t1', 'k1', 'web', 'e', 'A'), ('t2', 'k2', 'web', 'e', 'A'), ('t3', 'k3', 'comp', 'e', 'B'), ('t4', 'k4', 'door', 'e', 'C');`);
  for (const f of files.filter((n) => n >= "0005")) await pg.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  const rows = (await pg.query<{ id: string; price_cents: number; paid_at: string; paid_via: string; paid_by: string }>("select id, price_cents, paid_at, paid_via, paid_by from tickets order by id")).rows;
  expect(rows.map((r) => [r.id, r.price_cents, Number(r.paid_at), r.paid_via, r.paid_by])).toEqual([
    ["t1", 2000, 500, "WHISH", "admin-1"],
    ["t2", 2000, 500, "WHISH", "admin-1"],
    ["t3", 0, 600, "COMP", "admin-1"],
    ["t4", 1500, 700, "CASH", "scan-1"],
  ]);
  const orders = (await pg.query<{ id: string; pay_method: string | null }>("select id, pay_method from orders order by id")).rows;
  expect(orders.map((o) => [o.id, o.pay_method])).toEqual([["comp", null], ["door", null], ["wait", "WHISH"], ["web", "WHISH"]]);
  await pg.close();
});
