// Wave sale state. Pure: the caller supplies how many tickets each wave holds and the time.
import { fmtDate } from "../lib/time.ts";

export type WaveInput = {
  id: string;
  name: string;
  position: number;
  priceCents: number;
  capacity: number;
  mode: string;
  manualOpen: boolean;
  opensAt?: number | null;
  closesAt?: number | null;
  held: number; // tickets in pending/approved orders + unexpired unpaid holds
};

export type WaveState = "ON_SALE" | "SOLD_OUT" | "UPCOMING" | "CLOSED";
export type WaveView<W extends WaveInput = WaveInput> = W & {
  remaining: number;
  state: WaveState;
  /** Human sentence: why the wave is in this state (shown in admin, and to buyers where useful). */
  why: string;
  /** On sale with 20% or less left. Drives the "selling fast" indicator. */
  low: boolean;
};

/**
 * MANUAL waves sell while an admin has them switched on.
 * AUTO waves open once the wave before them (by position) has nothing left; a first AUTO wave opens at once.
 * SCHEDULED waves sell between opensAt and closesAt (closesAt optional).
 */
export function computeWaveStates<W extends WaveInput>(waves: W[], at: number): WaveView<W>[] {
  const sorted = [...waves].sort((a, b) => a.position - b.position);
  return sorted.map((w, i) => {
    const remaining = Math.max(0, w.capacity - w.held);
    const prev = sorted[i - 1];
    const prevRemaining = prev ? Math.max(0, prev.capacity - prev.held) : 0;
    let state: WaveState;
    let why: string;
    if (remaining === 0) {
      state = "SOLD_OUT";
      why = `${w.held}/${w.capacity} held`;
    } else if (w.mode === "SCHEDULED") {
      if (w.opensAt && at < w.opensAt) {
        state = "UPCOMING";
        why = `on sale ${fmtDate(w.opensAt)}`;
      } else if (w.closesAt && at >= w.closesAt) {
        state = "CLOSED";
        why = `sale ended ${fmtDate(w.closesAt)}`;
      } else {
        state = "ON_SALE";
        why = w.closesAt ? `scheduled: on sale until ${fmtDate(w.closesAt)}` : "scheduled: on sale";
      }
    } else if (w.mode === "AUTO") {
      state = prevRemaining === 0 ? "ON_SALE" : "UPCOMING";
      why = !prev
        ? "auto: first wave, open immediately"
        : prevRemaining === 0
          ? `auto: ${prev.name} is sold out`
          : `auto: opens when ${prev.name} sells its last ${prevRemaining}`;
    } else {
      state = w.manualOpen ? "ON_SALE" : "UPCOMING";
      why = w.manualOpen ? "manual: switched on" : "manual: switched off";
    }
    const low = state === "ON_SALE" && remaining <= Math.max(1, Math.floor(w.capacity * 0.2));
    return { ...w, remaining, state, why, low };
  });
}

export function eventSaleState(waves: WaveView[]): WaveState {
  if (waves.length === 0) return "UPCOMING";
  if (waves.some((w) => w.state === "ON_SALE")) return "ON_SALE";
  if (waves.every((w) => w.state === "SOLD_OUT")) return "SOLD_OUT";
  return waves.some((w) => w.state === "UPCOMING") ? "UPCOMING" : "CLOSED";
}

/** Cheapest ticket currently on sale, else cheapest overall (for "from $X"). */
export function fromPrice(waves: WaveView[]) {
  const pool = waves.filter((w) => w.state === "ON_SALE");
  const list = pool.length ? pool : waves;
  return list.length ? Math.min(...list.map((w) => w.priceCents)) : null;
}
