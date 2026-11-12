# Night Shift

Event ticketing app built with TypeScript, Hono, and PostgreSQL. Guests confirm attendance and get a QR ticket at once, then pay by Whish or Neo (screenshot, verified by an admin) or cash at the door. Includes ticket emails, a door scanner that shows who has paid, walk-in sales, and an admin interface.

## Run locally

Requires Node.js 22 or newer, npm, and a PostgreSQL database.

```sh
npm ci
```

Copy `.env.example` to `.env` and set `DATABASE_URL` to a development database. Then:

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:3000. Staff interfaces are at `/admin` and `/door`. Seeding creates demo events and staff accounts; use it only on a development database. Migrations are explicit and do not run at server startup. Uploads use local `storage/` directories unless Supabase storage is configured.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Tests use an isolated PGlite PostgreSQL engine and tracked SQL migrations. They do not verify live Supabase connectivity or cross-instance PostgreSQL locking. The build bundles assets and performs a Worker deployment dry run; it does not publish.

## How a guest gets in

Guests never sign in.

1. On the event page they pick a ticket type and quantity and tap **Get my ticket**.
2. They enter name, phone and email and tap **Confirm attendance**.
3. The ticket page (`/o/<token>`) shows their QR code straight away, and it is emailed too. Under it they choose:
   - **Pay at the door**: nothing to do; bring cash.
   - **Already paid by Whish or Neo**: pick the method and attach a screenshot of the payment. An admin checks it at `/admin/payments`.

Payment is tracked per ticket, so a group can arrive and pay separately. An unpaid ticket keeps its spot in the tier until an admin cancels the order. A rejected screenshot leaves the ticket valid: the guest can send another or pay at the door. One person (same email or phone) can hold at most the event's per-person limit.

Ticket links are bearer links: anyone holding the link can open the ticket. **My tickets** (`/account`) emails a guest the links for their address and answers the same whether or not the address has tickets.

## At the door

Staff open `/admin/door`, pick the event, and start the camera once; it restarts by itself after each scan.

| Scan shows | Meaning | What staff do |
|---|---|---|
| Green **Admit** | Paid (or free) and now checked in | Let them in. The screen returns to scanning by itself. |
| Amber **Collect $X** | Not paid | Take the cash, tap **Cash received · Admit**. |
| Amber **Whish/Neo not verified** | Screenshot sent, not yet checked by an admin | Take cash, or look at the receipt on their phone and tap **Receipt seen · Admit**. The order stays in the admin queue. |
| Red | Already used, cancelled, wrong event, or not a ticket | Do not admit. |

Guests without their QR can be found by name or phone on the same screen. Cash taken for tickets is credited to the staff member and shown with walk-in cash on the Walk-ins tab.

## Management

The MGMT link opens `/admin/login`. Only enabled ADMIN and SCANNER accounts can sign in, with a six-digit code sent by email. Administrators manage staff at `/admin/staff`. Codes are HMAC hashes, expire after ten minutes, allow five attempts, and work once. Sessions expire after twelve hours and are revoked on logout or staff access changes.

Cloudflare Hyperdrive pools database connections with query caching disabled to keep session revocation and ticket inventory current. Event inventory is fetched in batches and identities are reused only within a single request.

Deploy schema changes with `npm run db:migrate` **before** deploying the Worker. Migration `0005_ticket_first` adds per-ticket payment columns and marks every existing ticket as paid; it deletes nothing. Orders that were still waiting for payment under the old hold-and-pay flow show a "get a new ticket" page. Required secrets remain DATABASE_URL, SUPABASE_SECRET_KEY, SESSION_SECRET, and RESEND_API_KEY. Configure EMAIL_FROM with a verified sender. Set `WHISH_PHONE` if guests should see where to send money. Do not seed demo accounts in production.

Verification: run `npm run typecheck`, `npm test`, and `npm run build`. Tests cover confirming without sign-in, stock and per-person limits, screenshot approval and rejection, every scanner outcome including two doormen collecting at once, cancellation, and the migration backfill. They do not replace a real inbox-delivery check or a camera test on a real phone.

## Existing local data

The PostgreSQL schema migrations create tables; they do **not** import the old SQLite database or upload local files. Keep `data/`, `data-backup/`, and `storage/` intact. A data import needs a separate backup, explicit column mapping, preserved IDs and tokens, and verification of row counts and uploaded objects before switching over. Do not delete the old data after merely running schema migrations.

Local environment files, databases, uploads, dependencies, generated assets, and the old UI backup are excluded from version control.

### Ticket QR renderer check

Ticket email PNGs and PDFs must use the server entry of `qrcode`; the default package entry is replaced by the canvas/browser implementation when bundling Workers. To check the Worker runtime without sending mail or touching a database, run `npx wrangler dev --config tests/fixtures/qr-worker.jsonc --port 8791`, then request `http://127.0.0.1:8791`. Expect PNG signature `89504e470d0a1a0a`, width 600, SVG true, and a nonzero PDF size. Stop the local Worker afterward.
