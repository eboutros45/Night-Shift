# Night Shift

Event ticketing app built with TypeScript, Hono, and PostgreSQL. Includes reservations, manual Whish payment verification, ticket emails, QR scanning, door sales, and an admin interface.

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

## Public browsing, customer accounts, and management

Visitors can browse events without signing in. Checkout requires email-code sign-in at `/login`; the first successful verification creates a CUSTOMER account. The selected checkout URL is retained through verification. New orders belong to that account, use its verified email, and appear at `/account`. Existing legacy and complimentary order links retain their bearer-link behavior.

The MGMT link opens `/admin/login`. Only enabled ADMIN and SCANNER accounts can use management sign-in. Customer registration cannot grant staff access. Administrators manage staff at `/admin/staff`.

Codes are HMAC hashes, expire after ten minutes, allow five attempts, and work once. Resend sends them; sessions expire after twelve hours and are revoked on logout or staff access changes. Staff and customer challenges have separate audiences. A new code replaces the previous one for that email.

Cloudflare Hyperdrive pools database connections with query caching disabled to keep session revocation and ticket inventory current. Event inventory is fetched in batches, identities are reused only within a single request, and reservation cleanup runs from a one-minute Cron Trigger instead of blocking page requests. Expiry is still computed when reading or reserving tickets.

Deploy schema changes with `npm run db:migrate` before deploying the Worker. Required secrets remain DATABASE_URL, SUPABASE_SECRET_KEY, SESSION_SECRET, and RESEND_API_KEY. Configure EMAIL_FROM with a verified sender. Do not seed demo accounts in production. Local sign-in also requires working Resend settings.

Verification: run `npm run typecheck`, `npm test`, and `npm run build`. Tests cover public browsing, checkout ownership, customer/staff separation, code replay and expiry, navigation, and constant event-list query count. They do not replace a real inbox-delivery check.

## Existing local data

The PostgreSQL schema migrations create tables; they do **not** import the old SQLite database or upload local files. Keep `data/`, `data-backup/`, and `storage/` intact. A data import needs a separate backup, explicit column mapping, preserved IDs and tokens, and verification of row counts and uploaded objects before switching over. Do not delete the old data after merely running schema migrations.

Local environment files, databases, uploads, dependencies, generated assets, and the old UI backup are excluded from version control.
