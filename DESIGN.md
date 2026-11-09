# Night Shift (Simplified): design

Rewrite of `../Night Shift` with the same feature set. Goals: **function first, minimal UI**,
lighter stack, and **everything traceable**: if a flow is clear on the bare UI, it will work
under the real UI later.

## Run

```
npm install
cp .env.example .env      # optional; every value has a dev default
npm run db:seed           # admin@nightshift.local / nightshift-admin, door@nightshift.local / nightshift-scan
npm run dev               # http://localhost:3000  (staff: /admin)
npm test                  # service + domain tests
npm run db:reset          # wipe data/ and re-seed
```

Schema change: edit `src/db/schema.ts` → `npm run db:generate` → restart (migrations apply on boot).

## Stack (and what it replaced)

| Concern | Now | Was | Why |
|---|---|---|---|
| HTTP + pages | Hono + server-rendered JSX | Next.js 15 | ~instant restarts, no bundler, every page is a direct view of the DB |
| DB | Drizzle + better-sqlite3 | Prisma | typed SQL, tiny runtime, sync transactions |
| Auth | signed cookie + scrypt (node:crypto) | jose + bcryptjs | zero deps |
| Charts | HTML tables | Recharts | functionality first; charts are a UI sweep |
| Browser JS | only `public/door.js` (camera) | React everywhere | pages work with JS off |

Runtime deps: hono, @hono/node-server, drizzle-orm, better-sqlite3, zod, qrcode, pdf-lib, html5-qrcode.
`drizzle-kit` (dev only) carries an esbuild audit warning that only affects its dev server; it never ships.

## Layout

```
src/
  config.ts  clock.ts          env in one place; the single source of "now"
  db/        schema, client (open + migrate), seed
  domain/    pure rules: statuses + transitions, wave states, input validation
  services/  all business logic; each state change = guarded UPDATE + journal row, one transaction
  lib/       ids, password, time/money format, storage, qr, pdf
  web/       layout, session, http helpers, routes/{public,admin,door,insights}
tests/       vitest against in-memory SQLite with a pinned clock
```

## Key decisions

1. **Wave stock is derived, not stored.** Held = tickets in PENDING_VERIFICATION + APPROVED orders
   + AWAITING_PAYMENT orders whose `expires_at` is still in the future. The old `reserved`
   counter could drift; this can't. An expired hold frees its tickets the instant it lapses, and
   rejecting an order frees them with no release step. Cost: one indexed GROUP BY per read.
2. **Overselling is prevented by an IMMEDIATE transaction.** `reserve()` counts and inserts inside
   one SQLite write transaction, so two buyers can't both take the last ticket. Postgres port: `SELECT … FOR UPDATE`
   on the wave row, same shape.
3. **Expiry is computed on read** (`effectiveOrderStatus`), then *recorded* by a sweep throttled to
   once a minute from request middleware. The journal row is stamped at the real expiry time with
   actor `system`. No background timers, so it is serverless-friendly.
4. **One journal for everything** (replaces AuditLog + ScanLog): state changes, admin actions,
   door scans (every scan, admitted or not), emails, logins. It feeds the order timelines, `/admin/trace`,
   and the door and funnel stats.
5. **Dev clock** (`/admin/trace`, dev only): moves the app's "now" forward so you can watch holds
   expire and AUTO waves open/close. Sessions ignore it.
6. **Access rules in one table** (`ACCESS` in `src/app.ts`), not spread across routers.
7. **Email is sent after commit.** `notify.ts` decides what to say; `mailer.queue()` writes
   `EMAIL_QUEUED` inside the transaction and registers delivery with `afterCommit()`, so a rolled-back
   change sends nothing and a slow/failing SMTP server never blocks or undoes an approval. Outcome is
   journaled as `EMAIL_SENT` (with attachment names + messageId) or `EMAIL_FAILED` (with the error).
   Provider via `EMAIL_PROVIDER`: `console` (default) or `smtp`. Production uses Resend's SMTP relay
   (`smtp.resend.com`, user `resend`, API key as password) on our own verified domain; Mailpit locally.
   Plain SMTP rather than Resend's SDK keeps every provider a `.env` change. Replies go to `SUPPORT_EMAIL`.
   The tickets email attaches the PDF, generated at send time. `/admin/email` checks the connection,
   sends a test, and lists recent sends. Approved orders have "Resend tickets email".
   Known limit: an email in flight when the process dies is lost (visible as QUEUED with no SENT);
   a retry sweep over unmatched QUEUED rows is the next step if that matters.
8. **Comps** are APPROVED $0 orders with no wave, so they never consume capacity.
   **Walk-ins** (cash at the door) are orders with `channel = DOOR`, logged by door staff on the
   door phone's "Walk-ins" tab (`services/door-sales.ts`). Already APPROVED (staff took the cash) and
   tickets already CHECKED_IN (they're standing there), so they count as inside and as revenue at
   once. Price is the event's `doorPriceCents`, set by an admin (blank = walk-ins off); staff can't
   type a price, so the cash box matches the system. Optional `doorLimit` caps walk-in tickets. No
   email. Mistakes/refunds are **voided** with a reason (order VOIDED, tickets REVOKED, out of the
   cash totals) and stay in the log. The tab shows tonight's cash, each staff member's cash for
   end-of-night reconciliation, and recent sales. Journal: `DOOR_SALE`, `DOOR_SALE_VOIDED`.
   The door phone has two modes on separate pages (Scan tickets / Walk-ins) so one phone can stay on
   one job all night.
9. **Uploads** are typed by magic bytes, stored under random names, 5 MB max. Proofs are only
   served to admins, behind auth.
10. **Analytics** use no cookies: the visitor id is a daily-rotating hash of ip + user agent + secret.

## Visual design: "after-hours print"

- **Palette (dark only):** black `#000`, charcoal `#141414`, lines `#2A2A2A`, fog `#8E8E8E`, bone `#EDE8DF`,
  and one accent, sodium amber `#FFB238` (a 4am streetlight), used only for the action that moves you
  forward: buy, continue, pay, publish, plus "selling fast" and live countdowns.
- **Type:** Archivo variable, self-hosted (`@fontsource-variable/archivo`, served from `/fonts/`). Display is
  the same family at `font-stretch:62%` and weight 850–900, uppercase; body is normal width. No second face.
- **Artwork first.** Events without an uploaded poster get a generated typographic flyer (`<Flyer>` in
  `web/layout.tsx`): title, lineup, date and venue in one of four layouts picked from the slug. Sizes use
  container-query units so the same flyer works as a 56px thumbnail and a full hero.
- **Motion:** cross-document view transitions (posters morph from list to event page), a poster reveal on
  the event page, hover zoom on posters. All disabled under `prefers-reduced-motion`.
- **Public flow:** event page (tier + quantity) -> your details -> payment (Whish QR + proof) -> verification
  -> ticket stubs. Steps are numbered because they are a real sequence.
- **Admin:** same tokens, denser: sidebar, events table, verification queue rows, attendees page.

## Limits

Ticket limits (per event, editable on the event page):
- **Max per order** (default 6) and **max per person** (default 6) across all of one person's live
  orders (pending + approved + running holds). A person = same email **or** same phone (last 8 digits,
  so `+961 70 123 456` = `70123456`). Comps, expired and rejected orders don't count.
- **One unpaid hold per person per event**, so nobody can lock up a wave with repeated 30-minute holds.
- Wave capacity can't be set below what is already held.

Rate limits (all in `src/lib/limits.ts`, one table): checkout per IP (10/10min) and per email (5/10min),
proof uploads per order (6/10min) and per IP (20/10min), logins per IP (20/15min) and **failed** logins
per account (5/15min, so spreading guesses over many IPs doesn't help), ticket resends per order (3/h),
test emails per admin (5/10min). Blocked requests get 429 + `Retry-After`; the first block per window
is journaled as `RATE_LIMITED` (visible on /admin/trace). In-memory: correct for one server process.

Request bodies are capped before they are read: 100 KB normally, ~5.5 MB on the two upload routes.
`X-Forwarded-For` is only trusted with `TRUST_PROXY=1`.

## Not yet (deliberately)

UI/theme sweeps (per-event `theme` JSON column is reserved), per-attendee ticket names,
Postgres/S3 adapters, ticket transfer, staff user management UI.
