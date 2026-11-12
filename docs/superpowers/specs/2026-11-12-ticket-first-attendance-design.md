# Ticket-first attendance: design

Date: 2026-11-12. Status: awaiting review.

## Goal

Getting a ticket must feel instant. A guest confirms attendance and receives a QR ticket straight away, then chooses how to pay: Whish, Neo, or cash at the door. Door staff scan the ticket, see whether it is paid, and are told what to do.

Success means a guest reaches a ticket in three taps with no sign-in, and no one enters unpaid by accident.

## Decisions made with the organiser

- Guests do not sign in. Staff sign-in is unchanged.
- An unpaid scan lets staff collect cash and admit in one tap.
- Neo is offered next to Whish as an online payment method.
- No-shows are acceptable. Unpaid tickets keep their spot; the organiser has the name and phone number. There is no automatic release.

## Paying online

Paying by Whish or Neo is one step: pick the method and attach a screenshot of the successful payment. The page shows the amount and nothing else that needs reading: no payment QR, no reference to copy into a note, no transaction-reference field, and no Neo account details. Admins match the screenshot to the guest by name and phone number. The existing Whish number stays as a single "send to" line when it is configured.

## Guest flow

1. Event page: choose tier and quantity, tap **Get my ticket**.
2. Details screen: name, phone, email, then **Confirm attendance**. No code and no hold timer.
3. Ticket page (`/o/:token`), shown immediately:
   - QR code per person, each with a **Not paid yet** or **Paid** badge.
   - **I paid online**: choose Whish or Neo and attach the payment screenshot. One upload, one button.
   - **Pay at the door**: no action; shows the cash amount to bring.
4. The ticket link is emailed on confirmation, with the QR codes attached as today.

"My tickets" (`/account`) becomes a single email field. Submitting it emails that address the links to its orders, and always shows the same confirmation whether or not any exist. Order links are bearer links: whoever has the link can view the ticket.

The guest `/login` and `/verify` pages are removed. Existing guest accounts and their orders remain reachable through their order links.

## Payment model

Payment is tracked per ticket, so members of a group can arrive and pay separately.

New ticket columns:

| Column | Meaning |
|---|---|
| `price_cents` | What this ticket costs (the tier price at confirmation; 0 for guest list) |
| `paid_at` | When it was paid; null means unpaid |
| `paid_via` | `WHISH`, `NEO`, `CASH`, `COMP`, or `RECEIPT_SEEN` |
| `paid_by` | Staff user who verified or collected |

New order column: `pay_method` (`WHISH` or `NEO`), set when proof is submitted.

Order statuses for new online orders:

- `CONFIRMED`: tickets issued, no proof under review. Replaces `AWAITING_PAYMENT`.
- `PENDING_VERIFICATION`: Whish or Neo screenshot submitted, awaiting an admin.
- `APPROVED`: proof verified; every unpaid ticket in the order is marked paid.
- `CANCELLED`: an admin cancelled the order; its tickets are revoked and the spots are freed.

Transitions: `CONFIRMED → PENDING_VERIFICATION → APPROVED`; `PENDING_VERIFICATION → CONFIRMED` on rejection (the reason is kept and shown, the tickets stay valid and unpaid, the guest may retry or pay at the door); `CONFIRMED` or `PENDING_VERIFICATION → CANCELLED`. `AWAITING_PAYMENT`, `EXPIRED` and `REJECTED` remain readable for historical orders but are no longer produced. The hold timer and expiry sweep stop applying to new orders.

A tier's remaining stock counts `CONFIRMED`, `PENDING_VERIFICATION` and `APPROVED` orders. The per-person cap (same email or phone) and the checkout rate limits stay as the guard against fake sign-ups. The one-hold-at-a-time rule is dropped.

If every ticket in an order has been paid in cash at the door while a proof is still pending, approving the proof changes nothing further and the admin sees that the tickets were already paid in cash.

## Scanner

Scanning becomes two steps: look up, then admit. Paid tickets are admitted by the look-up itself so the common case stays one scan.

| Ticket state | Screen | Actions |
|---|---|---|
| Paid, valid | Green **PAID, admitted** | None |
| Unpaid | Amber **NOT PAID: collect $X** | **Cash received, admit** / **Cancel** |
| Unpaid, proof pending | Amber **WHISH/NEO NOT VERIFIED: $X** | **Cash received, admit** / **Receipt seen, admit** / **Cancel** |
| Already used, cancelled, wrong event, invalid | Red, as today | None |

**Cash received, admit** marks the ticket paid by `CASH`, records the staff member, and checks it in, in one conditional update, so two phones cannot both collect or both admit. **Receipt seen, admit** does the same with `RECEIPT_SEEN`, leaving the order in the admin queue for proper verification. **Cancel** changes nothing.

Every scan and every collection is written to the journal.

## Admin

- Orders list and order page show paid / unpaid counts and the payment method.
- The review queue lists Whish and Neo proofs, labelled by method.
- An order can be cancelled with a reason, which revokes its tickets.
- Door totals add cash collected on pre-confirmed tickets, per staff member, next to existing walk-in sales.

## Configuration

No new settings. `RESERVATION_MINUTES` and `WHISH_PAYMENT_LINK` become unused.

## Migration

One SQL migration adds the columns above and backfills: tickets of approved orders become paid (`WHISH`, or `COMP` at price 0, or `CASH` for walk-in sales) at the order's unit price. No rows are deleted.

## Error handling

- Sold out, tier closed, per-person cap, rate limit: shown inline on the details screen, as today.
- Proof submitted for a cancelled or already approved order: rejected with a plain message.
- Collect on a ticket that was just paid or admitted elsewhere: the scanner shows the current state instead.

## Testing

Tests run on the existing PGlite setup.

- Confirming issues valid unpaid tickets immediately and reduces tier stock.
- Per-person cap and stock limits under concurrent confirmations.
- Whish and Neo proof → approve marks tickets paid; reject returns the order to `CONFIRMED`.
- Scanner: each row of the table above, plus two simultaneous collect requests admitting exactly once.
- Cancelling an order frees stock and makes its tickets scan as cancelled.
- Guest pages render without a session; `/account` gives the same response for known and unknown emails.
- Migration backfill on an approved order, a guest-list order and a walk-in sale.

## Out of scope

Automatic release of unpaid tickets, online card payments, payment-provider APIs, and changes to walk-in sales or staff sign-in.
