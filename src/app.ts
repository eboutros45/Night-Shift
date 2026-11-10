// Assembles the HTTP app. Access rules live in ONE place (guard below), not per router,
// so who-can-reach-what is readable at a glance and never depends on mount order.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config.ts";
import { DomainError, type Role } from "./domain/status.ts";
import { admin } from "./web/routes/admin.tsx";
import { door } from "./web/routes/door.tsx";
import { insights } from "./web/routes/insights.tsx";
import { pub } from "./web/routes/public.tsx";
import { customerAuth } from "./web/routes/customer-auth.tsx";
import { auth } from "./web/routes/auth.tsx";
import { staff } from "./web/routes/staff.tsx";
import { currentUser, requireRole, type Env } from "./web/session.ts";


/** Path -> roles allowed. First match wins; anything under /admin not listed is ADMIN-only. */
const ACCESS: [RegExp, Role[] | "public"][] = [
  [/^\/admin\/(login|verify|logout)$/, "public"],
  [/^\/admin\/door(\/|$)/, ["ADMIN", "SCANNER"]],
  [/^\/admin(\/|$)/, ["ADMIN"]],
];

export function createApp(assets?: (request: Request) => Promise<Response>) {
  const app = new Hono<Env>();

  app.use(
    "*",
    secureHeaders({
      referrerPolicy: "same-origin",
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

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.use("/admin/*", async (c, next) => {
    const rule = ACCESS.find(([re]) => re.test(c.req.path))?.[1];
    if (!rule || rule === "public") return next();
    return requireRole(...rule)(c, next);
  });

  if (assets) {
    for (const path of ["/static/*", "/fonts/*", "/app.js", "/door.js"]) {
      app.get(path, async (c) => {
        const asset = await assets(c.req.raw);
        // Fetch responses have immutable headers; middleware adds security headers.
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: asset.headers });
      });
    }
  }

  app.route("/", customerAuth);
  app.route("/admin", auth);
  app.route("/admin", staff);
  app.route("/", pub);
  app.route("/admin", admin);
  app.route("/admin/door", door);
  app.route("/admin", insights);

  app.get("/healthz", (c) => c.text("ok"));

  app.notFound((c) => c.html("<!doctype html><title>Not found</title><p>Not found. <a href='/'>Home</a></p>", 404));
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.message, err.status);
    if (err instanceof HTTPException) return err.getResponse(); // e.g. 403 from the CSRF check
    console.error("Application request failed", c.req.method, err instanceof Error ? err.name : "unknown");
    return c.html("<!doctype html><title>Error</title><p>Something went wrong. It has been logged.</p>", 500);
  });

  return app;
}
