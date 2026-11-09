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

## Private web preview

Cloudflare Workers serves the app; PostgreSQL stores accounts, expiring login challenges, and revocable sessions. Supabase stores private uploads. Cloudflare Access is no longer required: the app gates the preview using its own staff email allowlist.

Sign in at `/admin/login`. Enabled staff receive a six-digit code through Resend. Codes expire after ten minutes, allow five verification attempts, and work once. Requesting a new code invalidates the old one. Codes are never logged or stored in plaintext. Sessions expire after twelve hours and are revoked on logout, account disabling, or role changes.

Admins manage accounts at `/admin/staff`. Door scanners cannot manage staff or access admin operations. Unknown and disabled emails cannot sign in. There is no public registration. The initial production admin is provisioned separately; Worker requests never create or promote accounts automatically.

Deploy in this order:

1. Run `npm run db:migrate` against the intended database, then run `supabase/bootstrap.sql` to initialize private storage and permissions.
2. Configure Worker secrets `DATABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, and `RESEND_API_KEY`. Set `EMAIL_FROM` to a sender on a verified Resend domain. Keep production mode enabled and development tools disabled.
3. Run `npm run typecheck`, `npm test`, and `npm run build`, then deploy with `npm run deploy`. Configure the custom domain; `APP_URL` alone does not create a route.
4. After the replacement login is deployed, remove the old Cloudflare Access protection so visitors reach the app's login page. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not used.
5. Test email delivery, sign-in, logout, staff permissions, and account disabling. The entire preview remains restricted to enabled staff, including customer-facing pages. Opening public ticket sales is a separate change.

Local interactive sign-in also requires Resend configuration and a staff account with an email you can receive. Demo passwords no longer authenticate. Do not seed demo accounts in production.

## Existing local data

The PostgreSQL schema migrations create tables; they do **not** import the old SQLite database or upload local files. Keep `data/`, `data-backup/`, and `storage/` intact. A data import needs a separate backup, explicit column mapping, preserved IDs and tokens, and verification of row counts and uploaded objects before switching over. Do not delete the old data after merely running schema migrations.

Local environment files, databases, uploads, dependencies, generated assets, and the old UI backup are excluded from version control.
