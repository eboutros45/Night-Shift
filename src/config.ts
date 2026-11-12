// Every env var is read here and nowhere else.
const env = process.env;

const fromAddress = env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] ?? (env.EMAIL_FROM?.includes("@") ? env.EMAIL_FROM.trim() : undefined);
// SMTP_USER is a real address for Gmail, but just "resend"/"apikey" for Resend or Brevo.
const smtpUserAddress = env.SMTP_USER?.includes("@") ? env.SMTP_USER : undefined;

export const config = {
  port: Number(env.PORT ?? 3000),
  appUrl: (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  databasePath: env.DATABASE_PATH ?? "data/nightshift.db",
  sessionSecret: env.SESSION_SECRET ?? "dev-only-change-me-dev-only-change-me",
  devTools: env.DEV_TOOLS === "1" || env.NODE_ENV !== "production",
  isProd: env.NODE_ENV === "production",
  // Only trust X-Forwarded-For when a reverse proxy we control sets it; otherwise clients can fake their IP.
  trustProxy: env.TRUST_PROXY === "1",
  storageDir: env.STORAGE_DIR ?? "storage",
  supabase: { url: env.SUPABASE_URL ?? "", secretKey: env.SUPABASE_SECRET_KEY ?? "" },
  uploadLimitBytes: 5 * 1024 * 1024,
  brand: { name: "Night Shift", orderPrefix: "NS", currency: "USD", supportEmail: env.SUPPORT_EMAIL || fromAddress || smtpUserAddress || "tickets@nightshift.local" },
  // Shown to guests as "send $X to <number>" on the ticket page; left out while it is the placeholder.
  whish: { phone: env.WHISH_PHONE ?? "+961 00 000 000" },
  email: {
    // console = print only (default, safe for dev) | smtp = really send (Resend, Mailpit, Gmail...)
    provider: (env.EMAIL_PROVIDER === "resend" ? "resend" : env.EMAIL_PROVIDER === "smtp" ? "smtp" : "console") as "resend" | "smtp" | "console",
    resendKey: env.RESEND_API_KEY ?? "",
    from: env.EMAIL_FROM || (smtpUserAddress ? `Night Shift <${smtpUserAddress}>` : "Night Shift <tickets@nightshift.local>"),
    smtp: {
      host: env.SMTP_HOST ?? "smtp.gmail.com",
      port: Number(env.SMTP_PORT ?? 465),
      user: env.SMTP_USER ?? "",
      pass: env.SMTP_PASS ?? "",
    },
  },
  seed: {
    adminEmail: env.SEED_ADMIN_EMAIL ?? "admin@nightshift.local",
    adminPassword: env.SEED_ADMIN_PASSWORD ?? "nightshift-admin",
    scannerEmail: env.SEED_SCANNER_EMAIL ?? "door@nightshift.local",
    scannerPassword: env.SEED_SCANNER_PASSWORD ?? "nightshift-scan",
  },
} as const;

// Production requirements are checked inside the Worker request handler, not at upload time.

export const appUrl = (path = "") => `${config.appUrl}${path}`;
