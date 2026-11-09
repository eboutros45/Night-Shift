// The door, for ADMIN and SCANNER staff. Two modes, each on its own page so one phone can stay
// on one job all night:
//  - Scan: check tickets in. Works without JavaScript (type/paste the code and submit); with JS,
//    /door.js runs the camera and posts to the JSON endpoint so the camera keeps running.
//  - Walk-ins: log cash sales at the door (services/door-sales.ts), with cash totals per staff.
import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { asc, gt } from "drizzle-orm";
import { now } from "../../clock.ts";
import { db } from "../../db/client.ts";
import { events as eventsT } from "../../db/schema.ts";
import { doorSaleInput, fieldErrors, voidInput } from "../../domain/inputs.ts";
import { DomainError } from "../../domain/status.ts";
import { fmtClock, fmtDate, fmtStamp, money } from "../../lib/time.ts";
import * as doorSales from "../../services/door-sales.ts";
import { feed } from "../../services/journal.ts";
import { checkIn, doorCounts, type ScanOutcome } from "../../services/tickets.ts";
import { back, flash, form } from "../http.ts";
import { asset, Empty, Flash, Page, Status } from "../layout.tsx";
import type { Env } from "../session.ts";

export const door = new Hono<Env>();

const getEvent = (id: string) => db().query.events.findFirst({ where: (e, { eq }) => eq(e.id, id) });

export function describe(o: ScanOutcome) {
  switch (o.result) {
    case "ADMITTED":
      return `Let in: ${o.attendeeName}`;
    case "ALREADY_USED":
      return `Already used at ${fmtClock(o.checkedInAt)} (${o.attendeeName})`;
    case "REVOKED":
      return `Revoked: ${o.reason ?? "no reason"} (${o.attendeeName})`;
    case "WRONG_EVENT":
      return `Ticket is for ${o.otherEvent}`;
    default:
      return "Not a Night Shift ticket";
  }
}

const Result: FC<{ o?: ScanOutcome }> = ({ o }) => (
  <div id="result" role="status" class={`scan-result ${!o ? "" : o.result === "ADMITTED" ? "ok" : "bad"}`}>
    <b>{o ? (o.result === "ADMITTED" ? "✓ ADMIT" : "✕ " + o.result.replace("_", " ")) : "Ready"}</b>
    <span>{o ? describe(o) : "Scan a QR or type the code"}</span>
  </div>
);

door.get("/", (c) => {
  const upcoming = db()
    .select()
    .from(eventsT)
    .where(gt(eventsT.startsAt, now() - 24 * 3600_000))
    .orderBy(asc(eventsT.startsAt))
    .all();
  return c.html(
    <Page title="Door" user={c.get("user")} path="/admin/door">
      <h1>Door</h1>
      <p class="sub">Pick the event you are scanning for.</p>
      <div class="grid">
        {upcoming.map((e) => {
          const n = doorCounts(e.id);
          return (
            <a class="card ecard" href={`/admin/door/${e.id}`}>
              <h2 style="margin:0">{e.title}</h2>
              <p class="small muted" style="margin:4px 0 8px">
                {fmtDate(e.startsAt)}, {e.venueName}
              </p>
              <span>
                <strong>{n.checkedIn}</strong> / {n.total} checked in
              </span>
              <p class="small muted" style="margin:6px 0 0">
                {e.doorPriceCents === null ? "No walk-in sales" : `Walk-ins ${money(e.doorPriceCents)} cash`}
              </p>
            </a>
          );
        })}
      </div>
      {upcoming.length === 0 && <Empty>No upcoming events.</Empty>}
    </Page>,
  );
});

type User = Env["Variables"]["user"];

/** Event title, Scan / Walk-ins switch, and the "inside" count. Shared by both modes. */
function DoorHeader({ eventId, title, mode }: { eventId: string; title: string; mode: "scan" | "walk-in" }) {
  const counts = doorCounts(eventId);
  return (
    <>
      <div class="spread" style="margin-bottom:12px">
        <div>
          <p class="small" style="margin:0">
            <a href="/admin/door">← Events</a>
          </p>
          <h1>{title}</h1>
        </div>
        <div class="stat" style="text-align:right">
          <b id="counts">
            {counts.checkedIn} / {counts.total}
          </b>
          <span>inside</span>
        </div>
      </div>
      <nav class="seg" aria-label="Door mode">
        <a href={`/admin/door/${eventId}`} class={mode === "scan" ? "on" : ""} aria-current={mode === "scan" ? "page" : undefined}>
          Scan tickets
        </a>
        <a href={`/admin/door/${eventId}/walk-in`} class={mode === "walk-in" ? "on" : ""} aria-current={mode === "walk-in" ? "page" : undefined}>
          Walk-ins
        </a>
      </nav>
    </>
  );
}

function ScanPage({ eventId, title, user, o }: { eventId: string; title: string; user: User; o?: ScanOutcome }) {
  const recent = feed({ eventId, action: "SCAN", limit: 15 });
  return (
    <Page title={`Door | ${title}`} user={user} path="/admin/door" head={<script src="/static/html5-qrcode.min.js" defer></script>}>
      <div style="max-width:560px;margin:0 auto">
        <DoorHeader eventId={eventId} title={title} mode="scan" />
        <Result o={o} />
        <form method="post" id="scan-form" data-event={eventId} class="row">
          <input name="code" id="code" autofocus autocomplete="off" placeholder="Ticket code" required style="flex:1;width:auto;font-size:18px;padding:12px" />
          <button class="primary lg">Check in</button>
        </form>
        <button type="button" id="cam-toggle" class="lg block" style="margin-top:10px" hidden>
          📷 Start camera
        </button>
        <div id="reader" style="margin-top:12px;border-radius:var(--r);overflow:hidden"></div>
        <div class="card flush" style="margin-top:20px">
          <h2>Last scans</h2>
          <table id="recent">
            <tbody>
              {recent.map((r) => (
                <tr>
                  <td class="mono small">{fmtStamp(r.at).slice(11, 19)}</td>
                  <td>
                    <Status s={String(r.parsed?.result)} />
                  </td>
                  <td class="small">{r.actorName}</td>
                  <td class="mono small muted">{r.entityId?.slice(0, 8) ?? String(r.parsed?.code ?? "").slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recent.length === 0 && <Empty>No scans yet.</Empty>}
        </div>
      </div>
      <script src={asset("door.js")} defer></script>
    </Page>
  );
}

door.get("/:eventId", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} />);
});

door.post("/:eventId", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const o = checkIn(ev.id, (await form(c)).code ?? "", c.get("user").id);
  return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} o={o} />);
});

door.post("/:eventId/scan.json", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.json({ error: "not found" }, 404);
  const { code } = await c.req.json<{ code?: string }>();
  const o = checkIn(ev.id, String(code ?? ""), c.get("user").id);
  return c.json({ ...o, message: describe(o), counts: doorCounts(ev.id) });
});

// ---------- walk-ins (cash at the door) ----------

function WalkInPage({ eventId, user, ok, err }: { eventId: string; user: User; ok?: string; err?: string }) {
  const s = doorSales.summary(eventId)!;
  const mine = s.byStaff.find((r) => r.staffId === user.id);
  const maxQty = Math.max(1, Math.min(20, s.left ?? 20));
  return (
    <Page title={`Walk-ins | ${s.event.title}`} user={user} path="/admin/door">
      <div style="max-width:560px;margin:0 auto">
        <DoorHeader eventId={eventId} title={s.event.title} mode="walk-in" />
        <Flash ok={ok} err={err} />

        {s.priceCents === null ? (
          <Empty title="Walk-in sales are off">
            {user.role === "ADMIN" ? (
              <>
                Set a door price in <a href={`/admin/events/${eventId}`}>the event settings</a> to sell at the door.
              </>
            ) : (
              "Ask an admin to set a door price for this event."
            )}
          </Empty>
        ) : s.left === 0 ? (
          <Empty title="Walk-ins sold out">All {s.limit} walk-in tickets are sold.</Empty>
        ) : (
          <form method="post" action={`/admin/door/${eventId}/walk-in`} class="card walkin" data-ticket-form data-unit-price={s.priceCents}>
            <div class="spread">
              <div>
                <span class="small muted">Door price</span>
                <b class="walkin-price">{money(s.priceCents)}</b>
              </div>
              {s.left !== null && <span class="small muted">{s.left} left</span>}
            </div>
            <div class="spread walkin-qty">
              <span>How many people</span>
              <span class="stepper">
                <button type="button" data-step="-1" aria-label="One fewer">
                  −
                </button>
                <input name="quantity" type="number" inputmode="numeric" min="1" max={maxQty} value="1" aria-label="Quantity" />
                <button type="button" data-step="1" aria-label="One more">
                  +
                </button>
              </span>
            </div>
            <label>
              Name <span class="hint">optional</span>
              <input name="name" maxlength={80} autocomplete="off" placeholder="Walk-in" />
            </label>
            <p class="walkin-collect">
              Collect <b data-total>{money(s.priceCents)}</b> in cash, then log it.
            </p>
            <button class="primary lg">Log cash sale</button>
          </form>
        )}

        <div class="stats" style="margin-top:20px">
          <div class="stat">
            <b>{money(s.cashCents)}</b>
            <span>cash tonight</span>
          </div>
          <div class="stat">
            <b>{s.sold}</b>
            <span>walk-ins{s.limit !== null ? ` of ${s.limit}` : ""}</span>
          </div>
          <div class="stat">
            <b>{money(mine?.cents ?? 0)}</b>
            <span>your cash</span>
          </div>
        </div>

        {s.byStaff.length > 0 && (
          <div class="card flush">
            <h2>Cash by staff</h2>
            <table>
              <tbody>
                {s.byStaff.map((r) => (
                  <tr>
                    <td>{r.name ?? r.staffId}</td>
                    <td class="small muted">
                      {r.tickets} walk-in{r.tickets === 1 ? "" : "s"}
                    </td>
                    <td style="text-align:right">
                      <b>{money(r.cents)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.voided.sales > 0 && (
          <p class="small muted" style="margin:10px 0 0">
            {s.voided.sales} voided sale{s.voided.sales === 1 ? "" : "s"} ({money(s.voided.cents)}) not counted in the cash above.
          </p>
        )}

        <div class="card flush" style="margin-top:20px">
          <h2>Last walk-ins</h2>
          <table>
            <tbody>
              {s.recent.map(({ order: o, staff }) => (
                <tr>
                  <td class="mono small">{fmtStamp(o.createdAt).slice(11, 16)}</td>
                  <td>
                    {o.quantity} × {o.customerName}
                    <div class="small muted">
                      {money(o.totalCents)} cash, {staff ?? o.decidedBy}
                    </div>
                  </td>
                  <td>
                    {o.status === "VOIDED" ? (
                      <Status s="VOIDED" />
                    ) : (
                      <details class="void">
                        <summary>Void</summary>
                        <form method="post" action={`/admin/door/${eventId}/walk-in/${o.id}/void`}>
                          <input name="reason" required maxlength={200} placeholder="Why? e.g. wrong count, refunded" />
                          <button class="danger">Void sale</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.recent.length === 0 && <Empty>No walk-ins yet.</Empty>}
        </div>
      </div>
    </Page>
  );
}

door.get("/:eventId/walk-in", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const f = flash(c);
  return c.html(<WalkInPage eventId={ev.id} user={c.get("user")} ok={f.ok} err={f.err} />);
});

door.post("/:eventId/walk-in", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const to = `/admin/door/${ev.id}/walk-in`;
  const parsed = doorSaleInput.safeParse(await form(c));
  if (!parsed.success) return back(c, to, { err: Object.values(fieldErrors(parsed.error)).join(" ") });
  try {
    const o = doorSales.sell(ev.id, parsed.data, c.get("user").id);
    return back(c, to, { ok: `Logged ${o.quantity} walk-in${o.quantity === 1 ? "" : "s"}: ${money(o.totalCents)} cash. They're checked in.` });
  } catch (e) {
    if (e instanceof DomainError) return back(c, to, { err: e.message });
    throw e;
  }
});

door.post("/:eventId/walk-in/:orderId/void", async (c) => {
  const to = `/admin/door/${c.req.param("eventId")}/walk-in`;
  const parsed = voidInput.safeParse(await form(c));
  if (!parsed.success) return back(c, to, { err: Object.values(fieldErrors(parsed.error)).join(" ") });
  try {
    const r = doorSales.voidSale(c.req.param("orderId"), parsed.data.reason, c.get("user").id);
    return back(c, to, { ok: r.alreadyVoided ? "That sale was already voided." : `Sale voided: ${money(r.totalCents)} taken off tonight's cash. If it was a refund, hand the cash back.` });
  } catch (e) {
    if (e instanceof DomainError) return back(c, to, { err: e.message });
    throw e;
  }
});
