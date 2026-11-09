import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
const assets = new Hono();
assets.use("*", serveStatic({ root: "./dist/assets" }));
serve({ fetch: createApp(async (request) => assets.fetch(request)).fetch, port: config.port }, (info) => {
  console.log(`Night Shift on http://localhost:${info.port} (admin: /admin)`);
});
