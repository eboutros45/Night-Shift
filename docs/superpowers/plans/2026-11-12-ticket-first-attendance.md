# Ticket-First Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest confirms attendance and gets a QR ticket immediately with no sign-in, then pays by Whish/Neo screenshot or cash at the door; the door scanner shows paid or unpaid and lets staff collect and admit.

**Architecture:** Tickets are issued when the order is created (`CONFIRMED`) instead of on admin approval. Payment moves from the order to each ticket (`paid_at`, `paid_via`, `paid_by`, `price_cents`). The scan becomes "look up, admit if paid, otherwise return what is due", with a second guarded update for collect-and-admit.

**Tech Stack:** TypeScript, Hono JSX (server-rendered), Drizzle ORM on PostgreSQL, Vitest on PGlite, plain browser JS in `public/`.

**Spec:** `docs/superpowers/specs/2026-11-12-ticket-first-attendance-design.md`

## Global Constraints

- Guests never sign in. Staff sign-in (`/admin/login`) is unchanged.
- Online payment is one step: choose `WHISH` or `NEO`, attach one screenshot. No payment QR, no reference note, no transaction-reference field, no Neo account details.
- Payment is per ticket. `paid_via` is one of `WHISH`, `NEO`, `CASH`, `COMP`, `RECEIPT_SEEN`.
- Unpaid tickets hold tier stock. No automatic release.
- Every state change is a guarded `UPDATE` (expected state in `WHERE`) plus a journal row in one transaction, as in the existing services.
- Migrations live in `supabase/migrations/` and are never run at startup. No rows are deleted.
- Times are UTC epoch ms; money is integer cents.
- Checks before every commit: `npm run typecheck` and `npm test`.

## Review Focus

Each line is pinned by a test in the task named.

1. Double tap on **Confirm attendance** → one order, not two (Task 2).
2. A free tier (price 0) → tickets are born paid (`COMP`), no payment choices shown (Task 2, Task 5).
3. Group order partly paid in cash at the door, then the Whish screenshot is approved → only the still-unpaid tickets change (Task 3).
4. Oversized or wrong-type screenshot → plain message on the ticket page, order unchanged (Task 5).
5. Orders created before deploy that are still `AWAITING_PAYMENT` → their page renders and offers a fresh start instead of erroring (Task 5).

---

### Task 1: Vocabulary, schema and migration

**Files:**
- Modify: `src/domain/status.ts`, `src/db/schema.ts`
- Create: `supabase/migrations/0005_ticket_first.sql` (plus the generated snapshot and `_journal.json` entry)
- Test: `tests/domain.test.ts`, `tests/migration.test.ts` (new)

**Interfaces — Produces:**
- `ORDER_STATUSES` gains `"CONFIRMED"` and `"CANCELLED"`. Flow: `CONFIRMED → PENDING_VERIFICATION | CANCELLED`; `PENDING_VERIFICATION → APPROVED | CONFIRMED | CANCELLED`; `APPROVED → VOIDED`. Legacy statuses keep their existing rows.
- `PAY_METHODS = ["WHISH", "NEO"] as const; type PayMethod`.
- `PAID_VIA = ["WHISH", "NEO", "CASH", "COMP", "RECEIPT_SEEN"] as const; type PaidVia`.
- `SCAN_RESULTS` gains `"PAYMENT_DUE"`.
- `LIVE_ORDER_STATUSES = ["CONFIRMED", "PENDING_VERIFICATION", "APPROVED"] as const` (orders that hold stock and count toward the per-person cap).
- `tickets` columns: `priceCents integer not null default 0`, `paidAt bigint null`, `paidVia text null`, `paidBy text null`. `orders` column: `payMethod text null`.

- [ ] **Step 1: Failing domain tests** in `tests/domain.test.ts`: `assertOrderTransition("CONFIRMED","PENDING_VERIFICATION")`, `("PENDING_VERIFICATION","CONFIRMED")`, `("CONFIRMED","CANCELLED")` do not throw; `("CONFIRMED","APPROVED")` and `("CANCELLED","CONFIRMED")` throw `ILLEGAL_TRANSITION`.
- [ ] **Step 2: Failing migration test** `tests/migration.test.ts`: load migrations `0000`–`0004` into a PGlite, insert one `APPROVED` online order (unit 2000) with 2 tickets, one comp order with 1 ticket, one `DOOR` order (unit 1500) with 1 ticket, one `PENDING_VERIFICATION` order with no tickets; then exec `0005`. Assert: online tickets `price_cents=2000, paid_via='WHISH', paid_at = order.decided_at`; comp ticket `price_cents=0, paid_via='COMP'`; door ticket `price_cents=1500, paid_via='CASH', paid_by = order.decided_by`; row counts unchanged.
- [ ] **Step 3: Run** `npx vitest run tests/domain.test.ts tests/migration.test.ts` → FAIL.
- [ ] **Step 4: Implement** the vocabulary and schema columns. Generate with `npm run db:generate -- --name ticket_first`, then append the backfill `UPDATE … FROM orders` statements described in Step 2 to the generated SQL (separated by `--> statement-breakpoint`).
- [ ] **Step 5: Run** the two test files → PASS; `npm run typecheck` → clean.
- [ ] **Step 6: Commit** `Add per-ticket payment columns and confirmed/cancelled order states`.

### Task 2: Confirming attendance issues tickets

**Files:**
- Modify: `src/services/orders.ts`, `src/services/inventory.ts`, `src/services/notify.ts`, `tests/helpers.ts`
- Test: `tests/orders.test.ts`, `tests/concurrency.test.ts`

**Interfaces:**
- Consumes: Task 1 vocabulary and columns.
- Produces:
  - `orders.confirm(slug: string, input: CheckoutInput, at = now()): Promise<Order>` replaces `reserve`. Creates the order as `CONFIRMED` with `expiresAt: null`, `userId: null`, and issues `quantity` tickets with `priceCents = wave.priceCents`. When the price is 0 the tickets get `paidAt = at`, `paidVia = "COMP"`. Journals `ORDER_CONFIRMED` and one `TICKET_ISSUED` per ticket.
  - Idempotency: if an order with the same event, wave, quantity, email and phone key was created in the previous 60 seconds and is `CONFIRMED`, return it instead of inserting.
  - `assertBuyerLimits` counts `LIVE_ORDER_STATUSES`; the `HOLD_EXISTS` rule is removed.
  - `heldByWave` / `waveViewsForEvents` count `LIVE_ORDER_STATUSES` (the unexpired `AWAITING_PAYMENT` clause stays for legacy rows).
  - `notify.ticketsIssued(x, order, event)` is sent from `confirm`. New text: the ticket link, the amount per ticket, and "Pay by Whish or Neo from the ticket page, or bring cash to the door." `notify.orderPlaced` is deleted.
  - `issueTickets(t, order, actor, at, paid?: { via: PaidVia; by: string | null })` — `createComp` passes `{ via: "COMP", by: actor }`; `door-sales.ts` passes `{ via: "CASH", by: actor }` so walk-in tickets are born paid.

- [ ] **Step 1: Failing tests** in `tests/orders.test.ts` (rewrite the reserve/hold cases):
  - `confirm` returns status `CONFIRMED`; `getByToken` shows `quantity` tickets, each `VALID`, `paidAt === null`, `priceCents === 2000`.
  - Wave of capacity 2: after `confirm` qty 2 the wave view is `SOLD_OUT`; a third buyer gets `SOLD_OUT`.
  - Same email, 4 then 3 with `maxPerBuyer` 6 → second throws `BUYER_LIMIT`.
  - Same input twice at `T0` and `T0 + 5_000` → same order id, ticket count unchanged; at `T0 + 61_000` → a new order.
  - Wave price 0 → tickets have `paidVia === "COMP"` and `paidAt === at`.
  - Queued mail has template `tickets_issued` and no `order_placed`.
  - In `tests/concurrency.test.ts`: 5 parallel `confirm` calls for the last 2 spots → exactly 2 succeed.
- [ ] **Step 2: Run** `npx vitest run tests/orders.test.ts tests/concurrency.test.ts` → FAIL.
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run** the same files → PASS.
- [ ] **Step 5: Commit** `Issue tickets when attendance is confirmed`.

### Task 3: Screenshot payment, approval, rejection, cancellation

**Files:**
- Modify: `src/services/orders.ts`, `src/services/notify.ts`, `src/domain/inputs.ts`
- Test: `tests/orders.test.ts`

**Interfaces:**
- Consumes: Task 2 `confirm`.
- Produces:
  - `proofInput = z.object({ method: z.enum(PAY_METHODS) })`.
  - `orders.submitProof(token: string, file: File | null, method: PayMethod, at = now())`. A file is required (`PROOF_REQUIRED`: "Attach a screenshot of your payment."). `CONFIRMED → PENDING_VERIFICATION`, sets `payMethod`, `proofKey`, `proofMime`, `submittedAt`, clears `rejectReason`. Throws `ALREADY_PAID` (409, "These tickets are already paid.") when no ticket in the order is unpaid.
  - `orders.approve(orderId, actor, at)`: `PENDING_VERIFICATION → APPROVED`; sets `paidAt = at, paidVia = order.payMethod, paidBy = actor` on tickets `WHERE paid_at IS NULL AND status <> 'REVOKED'`. Returns `{ alreadyApproved: boolean; newlyPaid: number }`. Sends `notify.paymentVerified`.
  - `orders.reject(orderId, actor, reason, at)`: `PENDING_VERIFICATION → CONFIRMED`, keeps `rejectReason`; tickets untouched. `notify.orderRejected` text ends with "Your ticket is still valid. Upload a new screenshot or pay cash at the door."
  - `orders.cancel(orderId, actor, reason, at)`: from `CONFIRMED` or `PENDING_VERIFICATION` to `CANCELLED`; every `VALID` ticket becomes `REVOKED` with that reason. Throws `HAS_ENTRIES` (409) if any ticket is `CHECKED_IN`.

- [ ] **Step 1: Failing tests:**
  - Submit with `NEO` → status `PENDING_VERIFICATION`, `payMethod === "NEO"`; approve → all tickets `paidVia === "NEO"`, `paidBy === "admin-1"`, `newlyPaid === quantity`.
  - Submit without a file → `PROOF_REQUIRED`.
  - Reject → status `CONFIRMED`, `rejectReason` kept, tickets `VALID` and unpaid; a second submit succeeds.
  - Review Focus 3: order of 3; mark one ticket paid `CASH` directly in the table; submit `WHISH`; approve → `newlyPaid === 2`, the cash ticket still `paidVia === "CASH"`.
  - Approve twice → second returns `alreadyApproved: true`, no ticket rows change.
  - Cancel a capacity-2 order → wave view back to `ON_SALE` with 2 remaining; tickets `REVOKED`.
  - Cancel with one ticket `CHECKED_IN` → `HAS_ENTRIES`.
- [ ] **Step 2: Run** `npx vitest run tests/orders.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Verify Whish and Neo screenshots per ticket; add order cancellation`.

### Task 4: Scan shows what is due; collect and admit

**Files:**
- Modify: `src/services/tickets.ts`
- Test: `tests/tickets.test.ts`, `tests/concurrency.test.ts`

**Interfaces:**
- Consumes: ticket payment columns; order `status` and `payMethod`.
- Produces:
  - `ScanOutcome` gains `dueCents?: number; proofPending?: boolean; payMethod?: PayMethod | null; paidVia?: PaidVia | null`.
  - `checkIn(eventId, code, actor, at)`: the admitting `UPDATE` adds `paid_at IS NOT NULL` to its `WHERE`. A `VALID`, unpaid ticket for this event returns `{ result: "PAYMENT_DUE", ticketId, attendeeName, dueCents: ticket.priceCents, proofPending: order.status === "PENDING_VERIFICATION", payMethod }` and changes nothing. Journal row as for other scans.
  - `collectAndAdmit(eventId: string, ticketId: string, via: "CASH" | "RECEIPT_SEEN", actor: string, at = now()): Promise<ScanOutcome>`. One `UPDATE … WHERE id AND event_id AND status='VALID' AND paid_at IS NULL` setting paid and checked-in fields together. On success returns `ADMITTED` and journals `PAYMENT_COLLECTED` with `{ via, cents }` then `SCAN`. If no row changed, returns the outcome `checkIn` would give for the ticket's current state without admitting twice. `RECEIPT_SEEN` is refused with `DomainError("NO_PROOF", …, 409)` when the order is not `PENDING_VERIFICATION`.
  - `doorCash(eventId): Promise<{ staffId: string; name: string; cents: number; tickets: number }[]>` — tickets with `paid_via='CASH'` on `ONLINE` orders, grouped by `paid_by`.

- [ ] **Step 1: Failing tests:**
  - Paid ticket → `ADMITTED`; second scan → `ALREADY_USED`.
  - Unpaid ticket → `PAYMENT_DUE`, `dueCents === 2000`, `proofPending === false`; ticket row still `VALID`.
  - Unpaid with proof submitted → `proofPending === true`, `payMethod === "WHISH"`.
  - `collectAndAdmit(…, "CASH", "admin-1")` → `ADMITTED`; row has `paidVia "CASH"`, `paidBy "admin-1"`, `status "CHECKED_IN"`; `doorCash` reports 2000 for admin-1.
  - `RECEIPT_SEEN` on an order with no proof → `NO_PROOF`.
  - Collect on a `REVOKED` ticket → `REVOKED`; with another event's id → `WRONG_EVENT`.
  - Concurrency: two parallel `collectAndAdmit` on one ticket → exactly one `ADMITTED`, the other `ALREADY_USED`, one `PAYMENT_COLLECTED` journal row.
- [ ] **Step 2: Run** `npx vitest run tests/tickets.test.ts tests/concurrency.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Scanner reports unpaid tickets and collects at the door`.

### Task 5: Guest pages without sign-in

**Files:**
- Modify: `src/web/routes/public.tsx`, `src/web/routes/customer-auth.tsx`, `src/web/auth-router.tsx`, `src/web/sign-in.tsx`, `src/web/layout.tsx` (nav link and styles), `src/app.ts`, `src/lib/limits.ts`, `src/services/notify.ts`, `public/app.js`
- Test: `tests/customer.test.ts`, `tests/pages.test.ts`, `tests/http.test.ts`

**Interfaces:**
- Consumes: `orders.confirm`, `orders.submitProof`, `proofInput`.
- Produces routes:
  - `GET /e/:slug` — button reads **Get my ticket**; footnote: "Pay by Whish or Neo, or cash at the door."
  - `GET|POST /e/:slug/checkout` — no session required; email is an editable field; heading **Almost there**; button **Confirm attendance**. Steps bar becomes `Tickets → Your details → Your ticket`.
  - `GET /o/:token` — the ticket page. Order: QR stubs first (moved here from `/o/:token/tickets`, each with a `Paid` or `Not paid yet` stamp), then one of:
    - any unpaid ticket and status `CONFIRMED`: two cards. **I paid online** — radio `method` (`Whish` checked, `Neo`), file input `proof` (`accept="image/*,application/pdf"`), button **Send screenshot**; shows "Send {amount due} to {config.whish.phone}" only when `WHISH_PHONE` is set to a non-placeholder value. **Pay at the door** — "Bring {amount due} in cash. Nothing else to do." If `rejectReason` is set, show it above the cards.
    - `PENDING_VERIFICATION`: "We're checking your screenshot. Your ticket already works; if it isn't verified by the time you arrive you can pay at the door."
    - all paid: "You're all set."
    - `CANCELLED`, and legacy `AWAITING_PAYMENT`/`EXPIRED`/`REJECTED`: short notice plus **Get a new ticket** linking to the event (Review Focus 5).
    - Amount due = sum of `priceCents` over unpaid, non-revoked tickets.
  - `POST /o/:token/proof` — parses `method` with `proofInput`; errors redirect back with the message.
  - `GET /o/:token/tickets` → 303 to `/o/:token`. `tickets.pdf` unchanged.
  - The `/o/:token/*` ownership middleware and the checkout login middleware are deleted: order links are bearer links.
  - `GET /account` — heading **Find my tickets**, one email field. `POST /account` — takes limits `linksPerIp` (5 per 10 min) and `linksPerEmail` (3 per hour), calls `notify.ticketLinks(x, email, orders)` when the email has orders that are not `CANCELLED`, and always renders "If that email has tickets, we've sent the links."
  - `GET /login` → 303 to `/account`. `POST /login`, `POST /verify` for guests are removed; the customer `signInRouter` is no longer mounted. Staff router untouched.

- [ ] **Step 1: Failing tests** (HTTP-level, no session cookie):
  - `GET /e/:slug/checkout?wave=…` → 200 and contains "Confirm attendance".
  - `POST` checkout → 303 to `/o/<token>`; that page is 200, contains an `<svg` QR, "Not paid yet", "Send screenshot" and "Pay at the door".
  - Free tier → page contains "You're all set" and not "Send screenshot" (Review Focus 2).
  - `POST /o/:token/proof` with `method=NEO` and a PNG → 303; page then contains "checking your screenshot".
  - Review Focus 4: a 6 MB file, and a `text/plain` file → 303 back with an error message; order still `CONFIRMED`.
  - Review Focus 5: an order row inserted as `AWAITING_PAYMENT` → page is 200 and contains "Get a new ticket".
  - `GET /login` → 303 `/account`. `POST /account` with a known and an unknown email → identical bodies; exactly one queued mail, for the known one.
  - `GET /o/:token/tickets` → 303.
- [ ] **Step 2: Run** `npx vitest run tests/customer.test.ts tests/pages.test.ts tests/http.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Reuse the existing `.stub`, `.card`, `.drop`, `.seg` styles; follow `DESIGN.md`. In `public/app.js`, disable the submit button of any form on submit (extend the existing `data-busy-label` handling to the confirm and screenshot forms).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Screenshot check** at 390 px wide of the event page, details screen and ticket page (unpaid, pending, paid) with Playwright against `npm run dev` on a seeded PGlite or local database; fix anything cramped or cut off.
- [ ] **Step 6: Commit** `Guests confirm attendance and pay from the ticket page without signing in`.

### Task 6: Door scanner screens

**Files:**
- Modify: `src/web/routes/door.tsx`, `public/door.js`, `src/web/layout.tsx` (one `.scan-result.due` style)
- Test: `tests/scanner-ui.test.ts`, `tests/http.test.ts`

**Interfaces:**
- Consumes: `checkIn`, `collectAndAdmit`, `doorCash`.
- Produces:
  - `describe(o)` and `Result` handle `PAYMENT_DUE`: class `due` (amber), headline `NOT PAID · collect $X` or, when `proofPending`, `WHISH NOT VERIFIED · $X` / `NEO NOT VERIFIED · $X`; the guest name beneath.
  - Under a `PAYMENT_DUE` result: form `POST /admin/door/:eventId/collect` with hidden `ticketId`, buttons `name="via" value="CASH"` **Cash received, admit** (primary, full width) and, only when `proofPending`, `value="RECEIPT_SEEN"` **Receipt seen, admit**; then a **Cancel** link back to the scan page.
  - `POST /:eventId/collect` → renders the scan page with the returned outcome. `DomainError` → the scan page with the message.
  - `scan.json` returns the new outcome fields unchanged.
  - Walk-ins page totals add a "Cash on confirmed tickets" row per staff member from `doorCash`.
  - `public/door.js`: after a result page loads, focus the primary action when one exists (**Cash received, admit**), otherwise **Scan next ticket**.

- [ ] **Step 1: Failing tests:** scanning an unpaid ticket as a SCANNER session → body contains "NOT PAID", "collect $20" and "Cash received, admit", not "ADMIT ✓"; posting `collect` with `via=CASH` → body contains "ADMIT" and the ticket row is `CHECKED_IN` and paid; proof-pending ticket → body contains "WHISH NOT VERIFIED" and "Receipt seen, admit"; `collect` without a staff session → redirect to `/admin/login`.
- [ ] **Step 2: Run** `npx vitest run tests/scanner-ui.test.ts tests/http.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Door scanner shows payment status and collects cash`.

### Task 7: Admin screens

**Files:**
- Modify: `src/web/routes/admin.tsx`, `src/web/routes/insights.tsx`, `src/services/attendees.ts`, `src/web/layout.tsx` (`Status` labels)
- Test: `tests/pages.test.ts`

**Interfaces:**
- Consumes: `approve`, `reject`, `cancel`, ticket payment columns.
- Produces:
  - `/admin/payments` lists `PENDING_VERIFICATION` orders with a `Whish`/`Neo` label, guest name and phone beside the screenshot. The transaction-reference column is removed.
  - `/admin/orders` and `/admin/orders/:id` show `paid n / total` and each ticket's `paidVia`. Status filter offers `CONFIRMED`, `PENDING_VERIFICATION`, `APPROVED`, `CANCELLED`, `VOIDED`.
  - `POST /admin/orders/:id/cancel` (`reason` required, validated with `voidInput`) calls `orders.cancel`. A **Cancel order** form appears on `CONFIRMED` and `PENDING_VERIFICATION` orders.
  - After approve, the flash reads "Verified. n ticket(s) marked paid." or, when `newlyPaid === 0`, "Already paid in cash at the door; nothing changed."
  - Attendee list and CSV gain a `Paid` column (`paidVia` or `unpaid`).
  - Revenue figures in `admin.tsx`/`insights.tsx` sum `priceCents` of paid tickets instead of `totalCents` of approved orders, with an "Unpaid, still expected" figure for unpaid valid tickets.
  - `Status` renders `CONFIRMED` as "Confirmed", `CANCELLED` as "Cancelled", `PAYMENT_DUE` as "Payment due".

- [ ] **Step 1: Failing tests:** payments page lists a pending Neo order with "Neo" and the guest phone; cancel route → order `CANCELLED`, redirect with flash; order page of a 3-ticket order with one cash-paid ticket shows "1 / 3"; attendees CSV header includes `Paid`; dashboard revenue for one paid 2000 ticket and one unpaid shows `$20` paid and `$20` expected.
- [ ] **Step 2: Run** `npx vitest run tests/pages.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Show per-ticket payment in admin and allow cancelling orders`.

### Task 8: Seed, docs and full verification

**Files:**
- Modify: `src/db/seed.ts`, `README.md`, `.env.example`, `src/config.ts`

- [ ] **Step 1:** Seed creates one `CONFIRMED` unpaid order, one `PENDING_VERIFICATION` (Neo) order and one fully paid order per demo event through the services, not raw inserts.
- [ ] **Step 2:** README: replace the customer-accounts section with the new flow (confirm → ticket → Whish/Neo screenshot or door), the scanner outcomes table, and the deploy order (`npm run db:migrate` before deploying). `.env.example`: mark `RESERVATION_MINUTES` and `WHISH_PAYMENT_LINK` as unused and remove them from `config.ts` if nothing reads them.
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run build` → all pass. Search for leftovers: `grep -rn "reserve(\|orderPlaced\|txnRef\|Reserve and continue\|held for" src public` → only schema/migration hits for `txn_ref`.
- [ ] **Step 4:** Walk the whole flow in a browser at 390 px: confirm, upload screenshot, approve in admin, scan paid; then confirm a second ticket, scan unpaid, collect cash, re-scan shows used.
- [ ] **Step 5: Commit** `Update seed data and documentation for ticket-first flow` and push.
