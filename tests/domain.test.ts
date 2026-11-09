import { expect, it } from "vitest";
import { parseLineup } from "../src/domain/inputs.ts";
import { effectiveOrderStatus } from "../src/domain/status.ts";
import { computeWaveStates } from "../src/domain/waves.ts";
import { epochToLocalInput, localInputToEpoch } from "../src/lib/time.ts";
import { hashPassword, verifyPassword } from "../src/lib/password.ts";

const wave = (o: Partial<Parameters<typeof computeWaveStates>[0][number]>) => ({
  id: "w",
  name: "W",
  position: 1,
  priceCents: 1000,
  capacity: 10,
  mode: "MANUAL",
  manualOpen: true,
  held: 0,
  ...o,
});

it("computes wave states with a reason", () => {
  const [a, b, c] = computeWaveStates([
    wave({ id: "a", name: "Early", position: 1, capacity: 5, held: 5 }),
    wave({ id: "b", name: "Regular", position: 2, mode: "AUTO", held: 3 }),
    wave({ id: "c", name: "Late", position: 3, mode: "AUTO" }),
  ], 0);
  expect([a!.state, b!.state, c!.state]).toEqual(["SOLD_OUT", "ON_SALE", "UPCOMING"]);
  expect(c!.why).toBe("auto: opens when Regular sells its last 7");
});

it("treats a lapsed unpaid order as expired before the sweep", () => {
  expect(effectiveOrderStatus({ status: "AWAITING_PAYMENT", expiresAt: 100 }, 100)).toBe("EXPIRED");
  expect(effectiveOrderStatus({ status: "AWAITING_PAYMENT", expiresAt: 100 }, 99)).toBe("AWAITING_PAYMENT");
  expect(effectiveOrderStatus({ status: "PENDING_VERIFICATION", expiresAt: 100 }, 500)).toBe("PENDING_VERIFICATION");
});

it("round-trips Beirut local time across DST", () => {
  for (const v of ["2026-01-15T22:00", "2026-07-15T22:00", "2026-11-14T23:30"]) {
    expect(epochToLocalInput(localInputToEpoch(v)!)).toBe(v);
  }
  expect(localInputToEpoch("2026-01-15T22:00")).toBe(Date.UTC(2026, 0, 15, 20, 0)); // UTC+2 in winter
  expect(localInputToEpoch("2026-07-15T22:00")).toBe(Date.UTC(2026, 6, 15, 19, 0)); // UTC+3 in summer
});

it("parses lineup lines", () => {
  expect(parseLineup("22:00 | Nour | live\nKarim\n\nAya | b2b")).toEqual([
    { time: "22:00", name: "Nour", role: "live" },
    { name: "Karim" },
    { name: "Aya", role: "b2b" },
  ]);
});

it("hashes and verifies passwords", () => {
  const h = hashPassword("secret");
  expect(verifyPassword("secret", h)).toBe(true);
  expect(verifyPassword("nope", h)).toBe(false);
});
