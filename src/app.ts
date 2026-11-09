// Assembles the HTTP app. Access rules live in ONE place (guard below), not per router,
// so who-can-reach-what is readable at a glance and never depends on mount order.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config.ts";
import { DomainError, type Role } from "./domain/status.ts";
import { sweepExpiredThrottled } from "./services/inventory.ts";
import { admin } from "./web/routes/admin.tsx";
import { door } from "./web/routes/door.tsx";
import { insights } from "./web/routes/insights.tsx";
import { pub } from "./web/routes/public.tsx";
import { requireRole, type Env } from "./web/session.ts";

const html5QrcodeJs = readFileSync(createRequire(import.meta.url).resolve("html5-qrcode/html5-qrcode.min.js"));

/** Path -> roles allowed. First match wins; anything under /admin not listed is ADMIN-only. */
const ACCESS: [RegExp, Role[] | "public"][] = [
  [/^\/admin\/(login|logout)$/, "public"],
  [/^\/admin\/door(\/|$)/, ["ADMIN", "SCANNER"]],
  [/^\/admin(\/|$)/, ["ADMIN"]],
];

export function createApp() {
  const app = new Hono<Env>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  // Rejects cross-site form POSTs by checking Origin; JSON fetches need same-origin anyway.
  app.use(
    "*",
    csrf({
      origin: (o, c) => {
        try {
          return o === config.appUrl || new URL(o).host === c.req.header("host");
        } catch {
          return false;
        }
      },
    }),
  );

  // Cap request bodies BEFORE they are read: uploads get room for a 5 MB file, everything else is tiny.
  const UPLOAD_PATH = /^\/o\/[^/]+\/proof$|^\/admin\/events\/[^/]+\/poster$/;
  const small = bodyLimit({ maxSize: 100 * 1024, onError: (c) => c.text("Request too large.", 413) });
  const upload = bodyLimit({ maxSize: config.uploadLimitBytes + 512 * 1024, onError: (c) => c.text("File too large (max 5 MB).", 413) });
  app.use("*", (c, next) => (UPLOAD_PATH.test(c.req.path) ? upload : small)(c, next));

  // Expiry is computed on read; this only *records* lapsed holds in the journal, at most once a minute.
  app.use("*", async (_c, next) => {
    sweepExpiredThrottled();
    await next();
  });

  app.use("/admin/*", async (c, next) => {
    const rule = ACCESS.find(([re]) => re.test(c.req.path))?.[1];
    if (!rule || rule === "public") return next();
    return requireRole(...rule)(c, next);
  });

  app.get("/static/html5-qrcode.min.js", (c) =>
    c.body(html5QrcodeJs, 200, { "content-type": "text/javascript", "cache-control": "public, max-age=86400" }),
  );
  // Self-hosted Archivo (variable weight + width). Whitelisted files only; no third-party font CDN.
  const fontDir = dirname(createRequire(import.meta.url).resolve("@fontsource-variable/archivo/package.json"));
  const FONTS = new Map(
    ["archivo-latin-wdth-normal.woff2", "archivo-latin-ext-wdth-normal.woff2"].map((f) => [f, readFileSync(join(fontDir, "files", f))]),
  );
  app.get("/fonts/:file", (c) => {
    const buf = FONTS.get(c.req.param("file"));
    if (!buf) return c.notFound();
    return c.body(new Uint8Array(buf), 200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
  });

  app.use("/door.js", serveStatic({ root: "./public" }));
  app.use("/app.js", serveStatic({ root: "./public" }));

  app.route("/", pub);
  app.route("/admin", admin);
  app.route("/admin/door", door);
  app.route("/admin", insights);

  app.get("/healthz", (c) => c.text("ok"));

  app.notFound((c) => c.html("<!doctype html><title>Not found</title><p>Not found. <a href='/'>Home</a></p>", 404));
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.message, err.status);
    if (err instanceof HTTPException) return err.getResponse(); // e.g. 403 from the CSRF check
    console.error(`[error] ${c.req.method} ${c.req.path}`, err);
    return c.html("<!doctype html><title>Error</title><p>Something went wrong. It has been logged.</p>", 500);
  });

  return app;
}
