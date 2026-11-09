import { defineConfig } from "drizzle-kit";

// Used only by `npm run db:generate` to turn src/db/schema.ts into SQL files in drizzle/.
// The app applies those files itself at startup (src/db/client.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
