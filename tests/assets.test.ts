import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshDb } from "./helpers.ts";
import { createApp } from "../src/app.ts";

beforeEach(freshDb);
afterEach(() => vi.useRealTimers());

it("serves fetched assets whose response headers are immutable", async () => {
  const app = createApp(async () => fetch("data:text/javascript,console.log('asset')"));
  const response = await app.request("http://localhost:3000/app.js");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("console.log('asset')");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
