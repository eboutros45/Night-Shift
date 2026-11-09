# Night Shift

Event ticketing app built with TypeScript, Hono, and SQLite. Includes reservations, manual Whish payment verification, ticket emails, QR scanning, door sales, and an admin interface.

## Run locally

Requires Node.js 22 or newer and npm.

```sh
npm ci
```

Copy `.env.example` to `.env` and adjust the settings, then run:

```sh
npm run db:seed
npm run dev
```

Open http://localhost:3000. Staff interfaces are at `/admin` and `/door`. The seed command creates demo events and staff accounts using the credentials in `.env` (development defaults are documented in `.env.example`).

## Checks

```sh
npm run typecheck
npm test
```

## Hosting

This application needs a running Node.js server and persistent disk storage; GitHub Pages cannot host its backend. No hosting provider is configured in this repository.

- Install dependencies with `npm ci`, including development dependencies because `npm start` uses `tsx`.
- Set `NODE_ENV=production`, `DEV_TOOLS=0`, a strong random `SESSION_SECRET`, and `APP_URL` to the public HTTPS URL.
- Configure real payment details and SMTP settings from `.env.example` if sending ticket emails.
- Persist the SQLite database (`DATABASE_PATH`, default `data/nightshift.db`) and uploads (`STORAGE_DIR`, default `storage`). Use a single application instance with this local SQLite setup.
- Set custom staff credentials before running `npm run db:seed`. This command also creates demo events; review those before opening sales.
- Start with `npm start`. Database migrations run automatically at startup.
- Set `TRUST_PROXY=1` only behind a controlled reverse proxy that supplies the client IP.

Local environment files, databases, uploaded media/payment proofs, dependencies, and the old UI backup are excluded from version control.
