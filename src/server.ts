import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { db } from "./db/client.ts";

db(); // open + migrate before accepting traffic
serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(`Night Shift on http://localhost:${info.port}  (admin: /admin)`);
});
