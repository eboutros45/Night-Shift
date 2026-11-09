// Event times are entered and shown in Beirut time; stored as UTC epoch ms.
export const TZ = "Asia/Beirut";

function zoneOffsetMs(at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - (at - (at % 1000));
}

/** "2026-11-14T22:00" (an <input type=datetime-local> value, Beirut time) -> epoch ms. */
export function localInputToEpoch(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  // Two passes handle DST boundaries.
  let t = asUtc - zoneOffsetMs(asUtc);
  t = asUtc - zoneOffsetMs(t);
  return t;
}

/** epoch ms -> "2026-11-14T22:00" in Beirut time, for prefilling datetime-local inputs. */
export function epochToLocalInput(ms: number) {
  return new Date(ms + zoneOffsetMs(ms)).toISOString().slice(0, 16);
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const fmtDate = (ms: number | null | undefined) => (ms == null ? "-" : fmt.format(ms));
export const fmtClock = (ms: number | null | undefined) => (ms == null ? "-" : fmtTime.format(ms));
/** Full precision for traces: "2026-11-14 22:00:05.123" Beirut time. */
export const fmtStamp = (ms: number) => new Date(ms + zoneOffsetMs(ms)).toISOString().replace("T", " ").slice(0, 23);

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const fmtHm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtLong = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** "Sat 14 Nov" */
export const fmtDayShort = (ms: number) => fmtDay.format(ms).replace(",", "");
/** "22:00" */
export const fmtHourMin = (ms: number) => fmtHm.format(ms);
/** "Saturday 14 November 2026" */
export const fmtDayLong = (ms: number) => fmtLong.format(ms).replace(",", "");
