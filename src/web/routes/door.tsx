// The door, for ADMIN and SCANNER staff. Two modes, each on its own page so one phone can stay
// on one job all night:
//  - Scan: check tickets in. A paid ticket is admitted by the scan; an unpaid one shows what to
//    collect and a "Cash received · Admit" button. Guests without their QR can be found by name
//    or phone. Works without JavaScript (type the code); with JS, /door.js runs the camera.
//  - Walk-ins: log cash sales at the door (services/door-sales.ts), with cash totals per staff.
import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { asc, gt } from "drizzle-orm";
import { now } from "../../clock.ts";
import { db } from "../../db/client.ts";
import { events as eventsT } from "../../db/schema.ts";
import { doorSaleInput, fieldErrors, voidInput } from "../../domain/inputs.ts";
import { DomainError, PAY_LABEL } from "../../domain/status.ts";
import { fmtClock, fmtDate, fmtStamp, money } from "../../lib/time.ts";
import * as doorSales from "../../services/door-sales.ts";
import { feed } from "../../services/journal.ts";
import * as attendees from "../../services/attendees.ts";
import { checkIn, collectAndAdmit, doorCash, doorCounts, type ScanOutcome } from "../../services/tickets.ts";
import { back, flash, form } from "../http.ts";
import { asset, Empty, Flash, Page, Status } from "../layout.tsx";
import type { Env } from "../session.ts";

export const door = new Hono<Env>();

const getEvent = (id: string) => db().query.events.findFirst({ where: (e, { eq }) => eq(e.id, id) });

/** One line for logs and the JSON endpoint. The screen itself uses <Result>. */
export function describe(o: ScanOutcome) {
  switch (o.result) {
    case "ADMITTED":
      return `Let in: ${o.attendeeName}`;
    case "PAYMENT_DUE":
      return o.proofPending
        ? `${PAY_LABEL[o.payMethod ?? "WHISH"]} payment not verified yet: ${money(o.dueCents ?? 0)} (${o.attendeeName})`
        : `Not paid: collect ${money(o.dueCents ?? 0)} (${o.attendeeName})`;
    case "ALREADY_USED":
      return `Already used at ${fmtClock(o.checkedInAt)} (${o.attendeeName})`;
    case "REVOKED":
      return `Cancelled: ${o.reason ?? "no reason"} (${o.attendeeName})`;
    case "WRONG_EVENT":
      return `Ticket is for ${o.otherEvent}`;
    default:
      return "Not a Night Shift ticket";
  }
}

/** What the doorman reads at arm's length: a colour, two or three words, then the name. */
function verdict(o: ScanOutcome): { tone: "ok" | "due" | "bad"; kicker: string; headline: string; detail: string } {
  switch (o.result) {
    case "ADMITTED":
      return {
        tone: "ok",
        kicker: o.paidVia === "CASH" ? "Cash collected" : o.paidVia === "RECEIPT_SEEN" ? "Receipt seen" : o.paidVia === "COMP" ? "Free entry" : `Paid · ${PAY_LABEL[o.paidVia ?? ""] ?? "verified"}`,
        headline: "✓ Admit",
        detail: "Let them in.",
      };
    case "PAYMENT_DUE":
      return o.proofPending
        ? {
            tone: "due",
            kicker: `${PAY_LABEL[o.payMethod ?? "WHISH"]} not verified`,
            headline: money(o.dueCents ?? 0),
            detail: `They sent a ${PAY_LABEL[o.payMethod ?? "WHISH"]} screenshot we haven't checked yet. Ask to see the receipt on their phone, or take cash.`,
          }
        : { tone: "due", kicker: "Not paid", headline: `Collect ${money(o.dueCents ?? 0)}`, detail: "Take the cash, then tap the button to let them in." };
    case "ALREADY_USED":
      return { tone: "bad", kicker: "Do not admit", headline: "Already used", detail: `This ticket was scanned at ${fmtClock(o.checkedInAt)}.` };
    case "REVOKED":
      return { tone: "bad", kicker: "Do not admit", headline: "Cancelled", detail: o.reason ?? "This ticket was cancelled." };
    case "WRONG_EVENT":
      return { tone: "bad", kicker: "Do not admit", headline: "Wrong event", detail: `This ticket is for ${o.otherEvent}.` };
    default:
      return { tone: "bad", kicker: "Do not admit", headline: "Not a ticket", detail: "This isn't a Night Shift ticket. Try scanning again, or find the guest by name." };
  }
}

const Result: FC<{ o?: ScanOutcome }> = ({ o }) => {
  if (!o)
    return (
      <div id="result" role="status" tabindex={-1} class="scan-result idle">
        <b>Ready</b>
        <span>Point the camera at a ticket's QR code</span>
      </div>
    );
  const v = verdict(o);
  return (
    <div id="result" role="status" tabindex={-1} class={`scan-result ${v.tone}`} data-tone={v.tone}>
      <small>{v.kicker}</small>
      <b>{v.headline}</b>
      {o.attendeeName && <strong>{o.attendeeName}</strong>}
      <span>{v.detail}</span>
    </div>
  );
};

/** What to press after a scan. Unpaid tickets get the collect buttons; everything else goes back to scanning. */
const Actions: FC<{ eventId: string; o: ScanOutcome }> = ({ eventId, o }) => {
  const next = `/admin/door/${eventId}`;
  if (o.result !== "PAYMENT_DUE" || !o.ticketId)
    return (
      <a id="scan-next" class={`btn lg block ${o.result === "ADMITTED" ? "primary" : "solid"}`} href={next} data-auto={o.result === "ADMITTED" ? "2500" : undefined}>
        Scan next ticket
      </a>
    );
  return (
    <form method="post" action={`/admin/door/${eventId}/collect`} class="scan-actions">
      <input type="hidden" name="ticketId" value={o.ticketId} />
      <button id="scan-primary" class="ok lg block" name="via" value="CASH" data-busy-label="Letting in…">
        Cash received · Admit
      </button>
      {o.proofPending && (
        <button class="lg block" name="via" value="RECEIPT_SEEN" data-busy-label="Letting in…">
          Receipt seen · Admit
        </button>
      )}
      <a class="btn ghost block" href={next}>
        Cancel, don't admit
      </a>
    </form>
  );
};

door.get("/", async (c) => {
  const upcoming = (await db()
      .select()
      .from(eventsT)
      .where(gt(eventsT.startsAt, now() - 24 * 3600_000))
      .orderBy(asc(eventsT.startsAt)));
  return c.html(
    <Page title="Door" user={c.get("user")} path="/admin/door">
      <h1>Door</h1>
      <p class="sub">Pick the event you are scanning for.</p>
      <div class="grid">
        {(await Promise.all(upcoming.map(async (e) => {
                        const n = (await doorCounts(e.id));
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
                      })))}
      </div>
      {upcoming.length === 0 && <Empty>No upcoming events.</Empty>}
    </Page>,
  );
});

type User = Env["Variables"]["user"];

/** Event title, Scan / Walk-ins switch, and the "inside" count. Shared by both modes. */
async function DoorHeader({ eventId, title, mode }: { eventId: string; title: string; mode: "scan" | "walk-in" }) {
  const counts = (await doorCounts(eventId));
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

type Guest = Awaited<ReturnType<typeof attendees.list>>[number];

/** For guests who can't show their QR: look them up by name or phone and check them in from the list. */
const GuestRow: FC<{ eventId: string; g: Guest }> = ({ eventId, g }) => {
  const t = g.ticket;
  const state =
    t.status === "CHECKED_IN" ? { tone: "", text: `Inside since ${fmtClock(t.checkedInAt)}` }
    : t.status === "REVOKED" ? { tone: "bad", text: "Cancelled" }
    : t.paidAt !== null ? { tone: "ok", text: "Paid" }
    : { tone: "warn", text: `Not paid · ${money(t.priceCents)}` };
  return (
    <li class="guest">
      <div>
        <strong>{t.attendeeName}</strong>
        <span class="small muted">{g.order.customerPhone || g.order.reference}</span>
        <span class={`status ${state.tone}`}>{state.text}</span>
      </div>
      {t.status === "VALID" && (
        <form method="post" action={`/admin/door/${eventId}`}>
          <input type="hidden" name="code" value={t.token} />
          <button class={t.paidAt !== null ? "primary" : ""}>{t.paidAt !== null ? "Check in" : "Open"}</button>
        </form>
      )}
    </li>
  );
};

async function ScanPage({ eventId, title, user, o, q, err }: { eventId: string; title: string; user: User; o?: ScanOutcome; q?: string; err?: string }) {
  const recent = (await feed({ eventId, action: "SCAN", limit: 12 }));
  const found = q ? (await attendees.list(eventId, { q })).slice(0, 25) : null;
  return (
    <Page title={`Door | ${title}`} user={user} path="/admin/door" head={<script src="/static/html5-qrcode.min.js" defer></script>}>
      <div class="door">
        <DoorHeader eventId={eventId} title={title} mode="scan" />
        <Flash err={err} />
        {!found && <Result o={o} />}
        {o && <Actions eventId={eventId} o={o} />}
        {!o && !found && (
          <>
            <div id="reader" class="reader"></div>
            <button type="button" id="cam-toggle" class="primary lg block" hidden>
              Start camera
            </button>
          </>
        )}
        {!o && (
          <div class="door-tools">
            <form method="get" action={`/admin/door/${eventId}`} class="row" role="search">
              <input name="q" value={q ?? ""} type="search" autocomplete="off" placeholder="Find guest by name or phone" aria-label="Find guest by name or phone" required minlength={2} />
              <button>Find</button>
            </form>
            {found && (
              <>
                <ul class="guests">
                  {found.map((g) => (
                    <GuestRow eventId={eventId} g={g} />
                  ))}
                </ul>
                {found.length === 0 && <Empty>No guest matches “{q}”. Try fewer letters or the last digits of their phone.</Empty>}
                <a class="btn block" href={`/admin/door/${eventId}`}>
                  Back to scanning
                </a>
              </>
            )}
            {!found && (
              <details class="typed">
                <summary>Type a ticket code instead</summary>
                <form method="post" id="scan-form" data-event={eventId} class="row">
                  <input name="code" id="code" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Ticket code" aria-label="Ticket code" required />
                  <button>Check</button>
                </form>
              </details>
            )}
          </div>
        )}
        {!found && (
          <div class="card flush" style="margin-top:24px">
            <h2>Last scans</h2>
            <table id="recent">
              <tbody>
                {recent.map((r) => (
                  <tr>
                    <td class="mono small">{fmtStamp(r.at).slice(11, 16)}</td>
                    <td>
                      {String(r.parsed?.name ?? "") || <span class="muted">Unknown code</span>}
                      <div class="small muted">{r.actorName}</div>
                    </td>
                    <td style="text-align:right">
                      <Status s={String(r.parsed?.result)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recent.length === 0 && <Empty>No scans yet.</Empty>}
          </div>
        )}
      </div>
      <script src={asset("door.js")} defer></script>
    </Page>
  );
}

door.get("/:eventId", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const q = c.req.query("q")?.trim().slice(0, 60);
  return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} q={q && q.length >= 2 ? q : undefined} />);
});

door.post("/:eventId", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const o = (await checkIn(ev.id, (await form(c)).code ?? "", c.get("user").id));
  return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} o={o} />);
});

/** The doorman took payment for an unpaid ticket: mark it paid and let the person in. */
door.post("/:eventId/collect", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.notFound();
  const f = await form(c);
  const via = f.via === "RECEIPT_SEEN" ? "RECEIPT_SEEN" : "CASH";
  try {
    const o = (await collectAndAdmit(ev.id, f.ticketId ?? "", via, c.get("user").id));
    return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} o={o} />);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    return c.html(<ScanPage eventId={ev.id} title={ev.title} user={c.get("user")} err={e.message} />, e.status);
  }
});

door.post("/:eventId/scan.json", async (c) => {
  const ev = await getEvent(c.req.param("eventId"));
  if (!ev) return c.json({ error: "not found" }, 404);
  const { code } = await c.req.json<{ code?: string }>();
  const o = (await checkIn(ev.id, String(code ?? ""), c.get("user").id));
  return c.json({ ...o, message: describe(o), counts: (await doorCounts(ev.id)) });
});

// ---------- walk-ins (cash at the door) ----------

async function WalkInPage({ eventId, user, ok, err }: { eventId: string; user: User; ok?: string; err?: string }) {
  const s = (await doorSales.summary(eventId))!;
  // The cash drawer holds two things: walk-in sales, and cash taken for tickets confirmed in advance.
  const collected = (await doorCash(eventId));
  const staffIds = [...new Set([...s.byStaff.map((r) => r.staffId), ...collected.map((r) => r.staffId)])];
  const drawer = staffIds
    .map((id) => {
      const w = s.byStaff.find((r) => r.staffId === id);
      const t = collected.find((r) => r.staffId === id);
      return { staffId: id, name: w?.name ?? t?.name ?? id, walkIns: w?.tickets ?? 0, collected: t?.tickets ?? 0, cents: (w?.cents ?? 0) + (t?.cents ?? 0) };
    })
    .sort((a, b) => b.cents - a.cents);
  const cashCents = drawer.reduce((n, r) => n + r.cents, 0);
  const mine = drawer.find((r) => r.staffId === user.id);
  const maxQty = Math.max(1, Math.min(20, s.left ?? 20));
  return (
    <Page title={`Walk-ins | ${s.event.title}`} user={user} path="/admin/door">
      <div class="door">
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
            <b>{money(cashCents)}</b>
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

        {drawer.length > 0 && (
          <div class="card flush">
            <h2>Cash by staff</h2>
            <table>
              <tbody>
                {drawer.map((r) => (
                  <tr>
                    <td>{r.name}</td>
                    <td class="small muted">
                      {[r.walkIns ? `${r.walkIns} walk-in${r.walkIns === 1 ? "" : "s"}` : "", r.collected ? `${r.collected} ticket${r.collected === 1 ? "" : "s"} paid at door` : ""].filter(Boolean).join(", ")}
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
    const o = (await doorSales.sell(ev.id, parsed.data, c.get("user").id));
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
    const r = (await doorSales.voidSale(c.req.param("orderId"), parsed.data.reason, c.get("user").id));
    return back(c, to, { ok: r.alreadyVoided ? "That sale was already voided." : `Sale voided: ${money(r.totalCents)} taken off tonight's cash. If it was a refund, hand the cash back.` });
  } catch (e) {
    if (e instanceof DomainError) return back(c, to, { err: e.message });
    throw e;
  }
});
