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

The deployment target is Cloudflare Workers with PostgreSQL (direct connection or a Hyperdrive binding) and private Supabase storage. `wrangler.jsonc` disables workers.dev and preview URLs. All Worker requests require a verified Cloudflare Access JWT for the owner account in `src/cloud/access.ts`, including assets and health checks. This preview is not yet a public ticket-sales deployment.

Before deploying:

1. Set `DATABASE_URL` for the intended database and run `npm run db:migrate`. Run `supabase/bootstrap.sql` in the Supabase SQL editor to create private buckets and revoke browser-role access to application tables.
2. Configure Cloudflare Access for the intended hostname with an owner-only allow policy. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` on the Worker.
3. Configure the hostname/route and check `APP_URL` and `SUPABASE_URL` in `wrangler.jsonc`. The URL variable alone does not configure DNS or a Worker route.
4. Set Worker secrets `DATABASE_URL` (or configure `HYPERDRIVE`), `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, and `RESEND_API_KEY`. Use a strong random session secret. Configure verified `EMAIL_FROM`, `SUPPORT_EMAIL`, and the real Whish details. Keep production mode enabled and development tools disabled.
5. Run the checks above, then `npm run deploy` when ready to publish. Verify owner login, rejection of anonymous/other accounts, reservation, proof upload, approval/email, ticket scan, and duplicate scan against the hosted preview.

Store credentials only in ignored environment files or provider secret stores. The Worker creates the owner admin account after successful Access verification; do not seed demo accounts into production.

## Existing local data

The PostgreSQL schema migrations create tables; they do **not** import the old SQLite database or upload local files. Keep `data/`, `data-backup/`, and `storage/` intact. A data import needs a separate backup, explicit column mapping, preserved IDs and tokens, and verification of row counts and uploaded objects before switching over. Do not delete the old data after merely running schema migrations.

Local environment files, databases, uploads, dependencies, generated assets, and the old UI backup are excluded from version control.
