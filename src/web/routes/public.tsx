// Customer-facing pages. Flow: Event -> Ticket selection (on the event page) -> Your details
// (checkout) -> Payment (Whish link/QR + proof upload) -> Verification -> Tickets.
// Tickets are only ever issued by an admin approving the payment; nothing here marks a payment paid.
import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { now } from "../../clock.ts";
import { config } from "../../config.ts";
import type { Event } from "../../db/schema.ts";
import { checkoutInput, fieldErrors, proofInput } from "../../domain/inputs.ts";
import { DomainError, orderTier, type OrderStatus } from "../../domain/status.ts";
import type { WaveView } from "../../domain/waves.ts";
import * as limits from "../../lib/limits.ts";
import { ticketsPdf } from "../../lib/pdf.ts";
import { qrSvg } from "../../lib/qr.ts";
import { readStored } from "../../lib/storage.ts";
import { fmtDate, fmtDayLong, fmtDayShort, fmtHourMin, money } from "../../lib/time.ts";
import { track, type ViewType } from "../../services/analytics.ts";
import * as events from "../../services/events.ts";
import * as orders from "../../services/orders.ts";
import { clientIp, flash, retryAfter } from "../http.ts";
import { Countdown, Empty, FieldErr, Flash, Flyer, Page } from "../layout.tsx";

export const pub = new Hono();

async function view(c: Context, type: ViewType, eventId?: string) {
  (await track({ type, eventId, ip: clientIp(c), ua: c.req.header("user-agent") ?? "", path: c.req.path, referrer: c.req.header("referer") }));
}

const acts = (e: Event) => events.lineupOf(e).map((l) => l.name);

/** What a buyer needs to know about a tier, in their words (admin sees the mechanical reason). */
function tierNote(w: WaveView): { text: string; hot?: boolean } {
  if (w.state === "SOLD_OUT") return { text: "Sold out" };
  if (w.state === "CLOSED") return { text: "Sale ended" };
  if (w.state === "UPCOMING") {
    if (w.mode === "SCHEDULED" && w.opensAt) return { text: `On sale ${fmtDayShort(w.opensAt)}, ${fmtHourMin(w.opensAt)}` };
    if (w.mode === "AUTO") return { text: "Next release" };
    return { text: "Not on sale yet" };
  }
  if (w.low) return { text: `Only ${w.remaining} left`, hot: true };
  return { text: "Available" };
}

/** The one tag shown on a poster: only when it changes your decision. */
function cardTag(sale: string, low: boolean, waves: WaveView[]) {
  if (sale === "SOLD_OUT") return <span class="tag out">Sold out</span>;
  if (low) return <span class="tag hot">Selling fast</span>;
  if (sale === "UPCOMING") {
    const next = waves.filter((w) => w.mode === "SCHEDULED" && w.opensAt).sort((a, b) => a.opensAt! - b.opensAt!)[0];
    return <span class="tag">{next ? `On sale ${fmtDayShort(next.opensAt!)}` : "Coming soon"}</span>;
  }
  if (sale === "CLOSED") return <span class="tag out">Sales closed</span>;
  return null;
}

const Icon = {
  cal: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  pin: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  ),
  id: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="12" r="2.5" />
      <path d="M14 10h4M14 14h3" />
    </svg>
  ),
};

// ---------- home ----------

pub.get("/", async (c) => {
  (await view(c, "PAGE_VIEW"));
  const list = (await events.listPublic());
  const featured = list.find((e) => e.sale === "ON_SALE") ?? list[0];
  const rest = list.filter((e) => e !== featured);
  return c.html(
    <Page title="Club nights and concerts in Beirut" path="/">
      {!featured && (
        <Empty title="Nothing announced yet">New nights are posted here first. Check back soon.</Empty>
      )}
      {featured && (
        <section class="feature" aria-label="Featured event">
          <a href={`/e/${featured.event.slug}`} aria-hidden="true" tabindex={-1}>
            <Flyer event={featured.event} acts={acts(featured.event)} vt />
          </a>
          <div>
            <p class="when">
              {fmtDayLong(featured.event.startsAt)}, {fmtHourMin(featured.event.startsAt)}
            </p>
            <h1 class="display">
              <a href={`/e/${featured.event.slug}`} style="text-decoration:none">
                {featured.event.title}
              </a>
            </h1>
            {featured.event.subtitle && <p class="lede">{featured.event.subtitle}</p>}
            <p class="acts">{acts(featured.event).join(", ")}</p>
            <p class="muted">
              {featured.event.venueName}, {featured.event.city}
            </p>
            <div class="buy">
              {featured.sale === "ON_SALE" ? (
                <a class="btn primary lg" href={`/e/${featured.event.slug}#tickets`}>
                  Get tickets
                </a>
              ) : (
                <a class="btn lg" href={`/e/${featured.event.slug}`}>
                  See event
                </a>
              )}
              {featured.from !== null && (
                <span class="price">
                  <small>from</small>
                  {money(featured.from)}
                </span>
              )}
              {cardTag(featured.sale, featured.low, featured.waves)}
            </div>
          </div>
        </section>
      )}
      {rest.length > 0 && (
        <section aria-label="Upcoming events">
          <div class="section-head">
            <h2 class="display">Upcoming</h2>
          </div>
          <div class="lineup-grid">
            {rest.map(({ event, sale, from, low, waves }) => (
              <a class="ev" href={`/e/${event.slug}`}>
                <div class="art">
                  <Flyer event={event} acts={acts(event)} vt />
                  {cardTag(sale, low, waves)}
                </div>
                <div class="d">
                  {fmtDayShort(event.startsAt)}, {fmtHourMin(event.startsAt)}
                </div>
                <div class="t">{event.title}</div>
                <div class="v">{event.venueName}</div>
                {from !== null && sale !== "SOLD_OUT" && <div class="p">from {money(from)}</div>}
              </a>
            ))}
          </div>
        </section>
      )}
    </Page>,
  );
});

// ---------- event ----------

pub.get("/e/:slug", async (c) => {
  const data = (await events.getPublic(c.req.param("slug")));
  if (!data) return c.notFound();
  const { event, waves, sale, salesOpen } = data;
  (await view(c, "EVENT_VIEW", event.id));
  const lineup = events.lineupOf(event);
  const buyable = salesOpen ? waves.filter((w) => w.state === "ON_SALE") : [];
  const first = buyable[0];
  const from = buyable.length ? Math.min(...buyable.map((w) => w.priceCents)) : null;
  const where = [event.venueName, event.venueAddress, event.city].filter(Boolean).join(", ");
  return c.html(
    <Page title={event.title} bodyClass={buyable.length ? "has-buybar" : undefined}>
      <div class="event">
        <div class="poster-col">
          <Flyer event={event} acts={lineup.map((l) => l.name)} vt />
        </div>
        <div>
          <p class="presents">{event.organizer} presents</p>
          <h1 class="display">{event.title}</h1>
          {event.subtitle && (
            <p class="lede" style="margin-top:16px">
              {event.subtitle}
            </p>
          )}
          <ul class="facts">
            <li>
              {Icon.cal}
              <span>
                <strong>{fmtDayLong(event.startsAt)}</strong>
                <span class="muted">
                  {fmtHourMin(event.startsAt)}
                  {event.endsAt && ` until ${fmtHourMin(event.endsAt)}`}
                </span>
              </span>
            </li>
            <li>
              {Icon.pin}
              <span>
                <strong>{event.venueName}</strong>
                <a class="muted" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`} target="_blank" rel="noopener">
                  {[event.venueAddress, event.city].filter(Boolean).join(", ")}
                </a>
              </span>
            </li>
            <li>
              {Icon.id}
              <span class="muted">{event.agePolicy}</span>
            </li>
          </ul>

          <form class="tickets" id="tickets" method="get" action={`/e/${event.slug}/checkout`} data-ticket-form>
            <header>
              <h2 style="margin:0">Tickets</h2>
              {!salesOpen && <span class="muted small">Sales have closed</span>}
              {salesOpen && sale === "SOLD_OUT" && <span class="muted small">Sold out</span>}
            </header>
            {waves.map((w) => {
              const note = tierNote(w);
              const on = salesOpen && w.state === "ON_SALE";
              return (
                <label class={`tier${on ? "" : " off"}`}>
                  <input type="radio" name="wave" value={w.id} checked={w.id === first?.id} disabled={!on} data-price={String(w.priceCents)} />
                  <span class="dot" aria-hidden="true"></span>
                  <span>
                    <span class="name">{w.name}</span>
                    <br />
                    <span class={`note${note.hot ? " hot" : ""}`}>{note.text}</span>
                  </span>
                  <span class="amt">{money(w.priceCents)}</span>
                </label>
              );
            })}
            {waves.length === 0 && <p class="muted" style="padding:20px;margin:0">Tickets are not on sale yet.</p>}
            {buyable.length > 0 && (
              <footer>
                <div class="qty">
                  <span>Quantity</span>
                  <span class="stepper">
                    <button type="button" data-step="-1" aria-label="One fewer">
                      −
                    </button>
                    <input name="quantity" type="number" inputmode="numeric" min="1" max={event.maxPerOrder} value="1" aria-label="Quantity" />
                    <button type="button" data-step="1" aria-label="One more">
                      +
                    </button>
                  </span>
                </div>
                <div class="total">
                  <span>Total</span>
                  <span class="num" data-total>
                    {money(first!.priceCents)}
                  </span>
                </div>
                <button class="primary lg block">Continue</button>
                <p class="tiny muted" style="margin:0">
                  Up to {event.maxPerOrder} per order, {event.maxPerBuyer} per person. You pay by Whish on the next step; we hold your tickets for{" "}
                  {config.reservationMinutes} minutes.
                </p>
              </footer>
            )}
          </form>

          {lineup.length > 0 && (
            <section class="block">
              <h2>Lineup</h2>
              <ul class="timetable">
                {lineup.map((l) => (
                  <li>
                    <span class="time">{l.time ?? ""}</span>
                    <span class="act">{l.name}</span>
                    <span class="role">{l.role ?? ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {event.description && (
            <section class="block">
              <h2>About</h2>
              <p style="white-space:pre-wrap">{event.description}</p>
            </section>
          )}
          <section class="block">
            <h2>Good to know</h2>
            <p class="muted">{event.refundPolicy}</p>
            <p class="muted">Your QR ticket is emailed once your payment is verified. One code per person, scanned once at the door.</p>
          </section>
        </div>
      </div>
      {buyable.length > 0 && (
        <div class="buybar">
          <span class="price">
            <small>from</small>
            {money(from!)}
          </span>
          <a class="btn primary" href="#tickets">
            Get tickets
          </a>
        </div>
      )}
    </Page>,
  );
});

// ---------- checkout: your details ----------

function Steps({ at, failed }: { at: number; failed?: string }) {
  const names = ["Tickets", "Your details", "Payment", "Verification", "Your tickets"];
  return (
    <ol class="steps" aria-label="Progress">
      {names.map((n, i) => (
        <li class={i < at ? "done" : i === at ? (failed ? "fail" : "now") : ""} aria-current={i === at ? "step" : undefined}>
          {i === at && failed ? failed : n}
        </li>
      ))}
    </ol>
  );
}

const Summary: FC<{ event: Event; wave?: WaveView | null; waveName?: string; qty: number; unit: number; total: number }> = (p) => (
  <aside class="summary">
    <div class="ev-head">
      <Flyer event={p.event} />
      <div>
        <strong>{p.event.title}</strong>
        <div class="small muted">
          {fmtDayShort(p.event.startsAt)}, {fmtHourMin(p.event.startsAt)}
          <br />
          {p.event.venueName}
        </div>
      </div>
    </div>
    <div class="line">
      <span>
        {p.qty} × {p.wave?.name ?? p.waveName}
      </span>
      <span class="num">{money(p.unit)} each</span>
    </div>
    <div class="line" style="font-weight:700;font-size:1.1rem">
      <span>Total</span>
      <span class="num">{money(p.total)}</span>
    </div>
  </aside>
);

function CheckoutPage(props: {
  data: NonNullable<Awaited<ReturnType<typeof events.getPublic>>>;
  wave: WaveView;
  values: Record<string, string>;
  errors?: Record<string, string>;
  err?: string;
}) {
  const { event } = props.data;
  const v = props.values;
  const qty = Math.min(event.maxPerOrder, Math.max(1, Number(v.quantity) || 1));
  return (
    <Page title={`Your details | ${event.title}`}>
      <p class="small">
        <a href={`/e/${event.slug}#tickets`} class="muted">
          Back to tickets
        </a>
      </p>
      <Steps at={1} />
      <div class="split">
        <div>
          <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem);margin-bottom:10px">
            Your details
          </h1>
          <p class="sub">Your tickets and payment link go to this email. Use your Whish number so we can match the payment.</p>
          <Flash err={props.err} />
          <form method="post" action={`/e/${event.slug}/checkout`} class="fields">
            <input type="hidden" name="waveId" value={props.wave.id} />
            <input type="hidden" name="quantity" value={String(qty)} />
            <label>
              Full name
              <input name="customerName" value={v.customerName ?? ""} required autocomplete="name" />
              <FieldErr e={props.errors} k="customerName" />
            </label>
            <label>
              Email
              <input name="customerEmail" type="email" value={v.customerEmail ?? ""} required autocomplete="email" inputmode="email" />
              <FieldErr e={props.errors} k="customerEmail" />
            </label>
            <label>
              Phone <span class="hint">(your Whish number)</span>
              <input name="customerPhone" type="tel" value={v.customerPhone ?? ""} required autocomplete="tel" placeholder="+961 70 123 456" />
              <FieldErr e={props.errors} k="customerPhone" />
            </label>
            <FieldErr e={props.errors} k="waveId" />
            <FieldErr e={props.errors} k="quantity" />
            <div>
              <button class="primary lg">Reserve and continue to payment</button>
              <p class="tiny muted" style="margin-top:12px">
                Your tickets are held for {config.reservationMinutes} minutes while you pay. Nothing is charged here.
              </p>
            </div>
          </form>
        </div>
        <Summary event={event} wave={props.wave} qty={qty} unit={props.wave.priceCents} total={props.wave.priceCents * qty} />
      </div>
    </Page>
  );
}

pub.get("/e/:slug/checkout", async (c) => {
  const slug = c.req.param("slug");
  const data = (await events.getPublic(slug));
  if (!data) return c.notFound();
  const wave = data.waves.find((w) => w.id === (c.req.query("wave") ?? "") && w.state === "ON_SALE");
  if (!wave || !data.salesOpen) return c.redirect(`/e/${slug}#tickets`, 303);
  (await view(c, "CHECKOUT_START", data.event.id));
  return c.html(<CheckoutPage data={data} wave={wave} values={{ quantity: c.req.query("quantity") ?? "1" }} />);
});

pub.post("/e/:slug/checkout", async (c) => {
  const slug = c.req.param("slug");
  const data = (await events.getPublic(slug));
  if (!data) return c.notFound();
  const body = await c.req.parseBody();
  const values = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const wave = data.waves.find((w) => w.id === values.waveId);
  if (!wave) return c.redirect(`/e/${slug}#tickets`, 303);
  const parsed = checkoutInput.safeParse(values);
  if (!parsed.success) return c.html(<CheckoutPage data={data} wave={wave} values={values} errors={fieldErrors(parsed.error)} />, 400);
  try {
    (await limits.take("checkoutPerIp", clientIp(c)));
    (await limits.take("checkoutPerEmail", parsed.data.customerEmail));
    const order = (await orders.reserve(slug, parsed.data));
    return c.redirect(`/o/${order.accessToken}`, 303);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    retryAfter(c, e);
    return c.html(<CheckoutPage data={(await events.getPublic(slug))!} wave={wave} values={values} err={e.message} />, e.status);
  }
});

// ---------- order: payment, verification, done ----------

const STEP_OF: Record<OrderStatus, { at: number; failed?: string }> = {
  AWAITING_PAYMENT: { at: 2 },
  PENDING_VERIFICATION: { at: 3 },
  APPROVED: { at: 5 },
  EXPIRED: { at: 2, failed: "Hold expired" },
  REJECTED: { at: 3, failed: "Payment not verified" },
  VOIDED: { at: 5, failed: "Sale voided at the door" },
};

pub.get("/o/:token", async (c) => {
  const o = (await orders.getByToken(c.req.param("token")));
  if (!o) return c.notFound();
  const { order, event, wave, status } = o;
  const whishQr = status === "AWAITING_PAYMENT" ? await qrSvg(config.whish.link) : "";
  const step = STEP_OF[status];
  return c.html(
    <Page title={`Order ${order.reference}`}>
      <Steps at={step.at} failed={step.failed} />
      <div class="split">
        <div>
          <Flash {...flash(c)} />
          {status === "AWAITING_PAYMENT" && (
            <section class="stack">
              <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem)">
                Pay with Whish
              </h1>
              <p class="lede">
                Your tickets are held for <Countdown ms={(order.expiresAt ?? 0) - now()} />. Pay the exact amount, then upload your proof below.
              </p>
              <div class="pay card" style="margin-top:22px">
                <div class="qr" aria-label="QR code that opens Whish">
                  {raw(whishQr)}
                </div>
                <div class="stack">
                  <div class="amount">{money(order.totalCents)}</div>
                  <p style="margin:0">
                    To <strong>{config.whish.accountName}</strong>
                    <br />
                    <span class="num">{config.whish.phone}</span>
                  </p>
                  <p class="small" style="margin:0">
                    Put <code>{order.reference}</code> in the payment note{" "}
                    <button type="button" class="sm ghost" data-copy={order.reference}>
                      Copy
                    </button>
                  </p>
                  <div>
                    <a class="btn solid" href={config.whish.link} target="_blank" rel="noopener">
                      Open Whish
                    </a>
                  </div>
                </div>
              </div>
              <h2 style="margin-top:34px">Upload your proof</h2>
              <form method="post" action={`/o/${order.accessToken}/proof`} enctype="multipart/form-data" class="fields">
                <label class="drop">
                  <input type="file" name="proof" accept="image/png,image/jpeg,image/webp,application/pdf" data-file-label />
                  <strong data-file-name>Choose a screenshot or PDF</strong>
                  <span class="small">PNG, JPG, WEBP or PDF, up to 5 MB</span>
                </label>
                <label>
                  Whish transaction reference <span class="hint">(optional if you upload a file)</span>
                  <input name="txnRef" maxlength={80} autocomplete="off" />
                </label>
                <div>
                  <button class="primary lg">Submit payment proof</button>
                </div>
              </form>
            </section>
          )}
          {status === "PENDING_VERIFICATION" && (
            <section>
              <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem)">
                Checking your payment
              </h1>
              <p class="lede" style="margin-top:16px">
                We have your proof. Once someone on our team matches it to the Whish payment, your tickets are emailed to you and appear here.
              </p>
              <p class="muted">Submitted {fmtDate(order.submittedAt)}. Your tickets stay reserved while we check.</p>
            </section>
          )}
          {status === "APPROVED" && (
            <section>
              <h1 class="display" style="font-size:clamp(2.6rem,7vw,5rem)">
                You're in
              </h1>
              <p class="lede" style="margin-top:16px">
                {order.quantity} ticket{order.quantity === 1 ? "" : "s"} for {event.title}. Show the QR code at the door.
              </p>
              <div class="row" style="margin-top:24px">
                <a class="btn primary lg" href={`/o/${order.accessToken}/tickets`}>
                  Show my tickets
                </a>
                <a class="btn lg" href={`/o/${order.accessToken}/tickets.pdf`}>
                  Download PDF
                </a>
              </div>
            </section>
          )}
          {status === "REJECTED" && (
            <section>
              <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem)">
                Payment not verified
              </h1>
              <p class="lede" style="margin-top:16px">
                {order.rejectReason}
              </p>
              <p class="muted">If you paid and think this is a mistake, reply to the email we sent with your Whish receipt.</p>
              <a class="btn primary" href={`/e/${event.slug}#tickets`}>
                Start a new order
              </a>
            </section>
          )}
          {status === "EXPIRED" && (
            <section>
              <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem)">
                Your hold expired
              </h1>
              <p class="lede" style="margin-top:16px">
                No payment proof arrived within {config.reservationMinutes} minutes, so these tickets went back on sale.
              </p>
              <a class="btn primary" href={`/e/${event.slug}#tickets`}>
                Start a new order
              </a>
            </section>
          )}
          <details class="card" style="margin-top:40px">
            <summary>
              <strong>Order history</strong> <span class="muted small">reference {order.reference}</span>
            </summary>
            <div style="margin-top:14px">
              <Timeline rows={o.timeline.filter((r) => r.action === "ORDER_CREATED" || r.action === "PROOF_SUBMITTED" || r.toStatus)} />
            </div>
          </details>
        </div>
        <Summary event={event} waveName={orderTier(order, wave?.name)} qty={order.quantity} unit={order.unitPriceCents} total={order.totalCents} />
      </div>
    </Page>,
  );
});

// Customer timeline: plain words, no staff identities.
const LABELS: Record<string, string> = {
  ORDER_CREATED: "Tickets reserved",
  PROOF_SUBMITTED: "Payment proof submitted",
  ORDER_APPROVED: "Payment verified, tickets issued",
  ORDER_REJECTED: "Payment not verified",
  ORDER_EXPIRED: "Hold expired",
  COMP_CREATED: "Guest list tickets issued",
  TICKET_REVOKED: "A ticket was cancelled",
};
const Timeline: FC<{ rows: { at: number; action: string }[] }> = ({ rows }) => (
  <ul class="timetable">
    {rows
      .filter((r) => LABELS[r.action])
      .map((r) => (
        <li>
          <span class="time small">{fmtHourMin(r.at)}</span>
          <span>{LABELS[r.action]}</span>
          <span class="role">{fmtDayShort(r.at)}</span>
        </li>
      ))}
  </ul>
);

pub.post("/o/:token/proof", async (c) => {
  const token = c.req.param("token");
  try {
    // Limits are checked before the body is read, so a blocked client can't make us parse uploads.
    (await limits.take("proofPerIp", clientIp(c)));
    (await limits.take("proofPerOrder", token));
  } catch (e) {
    retryAfter(c, e);
    return c.redirect(`/o/${token}?err=${encodeURIComponent((e as Error).message)}`, 303);
  }
  const body = await c.req.parseBody();
  const file = body.proof instanceof File && body.proof.size > 0 ? body.proof : null;
  const { txnRef } = proofInput.parse({ txnRef: typeof body.txnRef === "string" ? body.txnRef : undefined });
  try {
    await orders.submitProof(token, file, txnRef);
    return c.redirect(`/o/${token}`, 303);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    return c.redirect(`/o/${token}?err=${encodeURIComponent(e.message)}`, 303);
  }
});

// ---------- tickets ----------

pub.get("/o/:token/tickets", async (c) => {
  const o = (await orders.getByToken(c.req.param("token")));
  if (!o || o.status !== "APPROVED") return c.notFound();
  const svgs = await Promise.all(o.tickets.map((t) => qrSvg(t.token)));
  const tier = orderTier(o.order, o.wave?.name);
  return c.html(
    <Page title={`Tickets | ${o.event.title}`}>
      <Steps at={5} />
      <div class="head">
        <div>
          <h1 class="display" style="font-size:clamp(2.4rem,6vw,4rem)">
            Your tickets
          </h1>
          <p class="sub">
            Show one code per person at the door. Screen brightness up helps. Order <span class="mono">{o.order.reference}</span>
          </p>
        </div>
        <div class="row">
          <a class="btn" href={`/o/${o.order.accessToken}`}>
            Order details
          </a>
          <a class="btn solid" href={`/o/${o.order.accessToken}/tickets.pdf`}>
            Download PDF
          </a>
        </div>
      </div>
      <div class="stubs">
        {o.tickets.map((t, i) => (
          <article class={`stub${t.status === "VALID" ? "" : " void"}`} aria-label={`Ticket ${i + 1} of ${o.tickets.length}`}>
            {t.status === "CHECKED_IN" && <span class="stamp used">Used</span>}
            {t.status === "REVOKED" && <span class="stamp revoked">Cancelled</span>}
            <div class="top">
              <p class="ttl">{o.event.title}</p>
              <p class="meta">
                {fmtDayShort(o.event.startsAt)}, {fmtHourMin(o.event.startsAt)}
                <br />
                {o.event.venueName}, {o.event.city}
              </p>
              <div class="who">
                <span>
                  <strong>{t.attendeeName}</strong>
                  {tier}
                </span>
                <span class="num">
                  {i + 1}/{o.tickets.length}
                </span>
              </div>
            </div>
            <div class="bottom">
              {raw(svgs[i])}
              <span class="code">{t.token}</span>
            </div>
          </article>
        ))}
      </div>
    </Page>,
  );
});

pub.get("/o/:token/tickets.pdf", async (c) => {
  const o = (await orders.getByToken(c.req.param("token")));
  if (!o || o.status !== "APPROVED") return c.notFound();
  const pdf = await ticketsPdf(o.order, o.event, o.tickets, o.wave?.name);
  return c.body(new Uint8Array(pdf), 200, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${o.order.reference}.pdf"`,
    "cache-control": "private, no-store",
  });
});

pub.get("/media/:key", async (c) => {
  const f = await readStored("media", c.req.param("key"));
  if (!f) return c.notFound();
  return c.body(new Uint8Array(f.buf), 200, { "content-type": f.mime, "cache-control": "public, max-age=31536000, immutable" });
});
