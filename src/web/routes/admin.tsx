// Admin: login, events + waves, payment queue, order detail, comps, proofs, attendee export.
// Access is enforced centrally in src/app.ts (ACCESS table).
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/client.ts";
import { events as eventsT, orders as ordersT, tickets as ticketsT, waves as wavesT, type Event } from "../../db/schema.ts";
import { compInput, eventInput, fieldErrors, lineupToText, loginInput, waveInput } from "../../domain/inputs.ts";
import { DomainError, ORDER_STATUSES, orderTier } from "../../domain/status.ts";
import { readStored, saveUpload } from "../../lib/storage.ts";
import { epochToLocalInput, fmtDate, fmtDayShort, fmtDuration, fmtHourMin, fmtStamp, money } from "../../lib/time.ts";
import { now } from "../../clock.ts";
import * as events from "../../services/events.ts";
import * as attendees from "../../services/attendees.ts";
import * as orders from "../../services/orders.ts";
import * as ticketsSvc from "../../services/tickets.ts";
import { authenticate } from "../../services/users.ts";
import * as limits from "../../lib/limits.ts";
import { act, back, clientIp, flash, form, retryAfter } from "../http.ts";
import type { WaveView } from "../../domain/waves.ts";
import { Empty, FieldErr, Flash, Flyer, Page, Status, Timeline } from "../layout.tsx";
import { currentUser, endSession, startSession, type Env } from "../session.ts";

export const admin = new Hono<Env>();

// ---------- auth ----------

admin.get("/login", async (c) => {
  const user = await currentUser(c);
  if (user) return c.redirect(user.role === "ADMIN" ? "/admin" : "/admin/door");
  return c.html(
    <Page title="Staff login">
      <div style="max-width:380px;margin:40px auto">
        <h1>Staff login</h1>
        <p class="sub">Admins manage events and payments. Door staff scan tickets.</p>
        <Flash err={c.req.query("err")} />
        <form method="post" class="card fields">
          <input type="hidden" name="next" value={c.req.query("next") ?? ""} />
          <label>
            Email <input name="email" type="email" required autocomplete="username" autofocus />
          </label>
          <label>
            Password <input name="password" type="password" required autocomplete="current-password" />
          </label>
          <button class="primary block">Log in</button>
        </form>
      </div>
    </Page>,
  );
});

admin.post("/login", async (c) => {
  const f = await form(c);
  const parsed = loginInput.safeParse(f);
  const email = parsed.success ? parsed.data.email : "";
  try {
    // Per network, and per account: failures on one email are capped even if spread over many IPs.
    limits.take("loginPerIp", clientIp(c));
    if (email) limits.check("loginFailuresPerEmail", email);
  } catch (e) {
    retryAfter(c, e);
    return back(c, "/admin/login", { err: (e as Error).message });
  }
  const user = parsed.success ? authenticate(email, parsed.data.password) : null;
  if (!user) {
    if (email) limits.hit("loginFailuresPerEmail", email);
    return back(c, "/admin/login", { err: "Wrong email or password." });
  }
  await startSession(c, user);
  const next = f.next?.startsWith("/admin") && !f.next.startsWith("//") ? f.next : null;
  return c.redirect(next ?? (user.role === "ADMIN" ? "/admin" : "/admin/door"), 303);
});

admin.post("/logout", (c) => {
  endSession(c);
  return c.redirect("/admin/login", 303);
});

// ---------- dashboard ----------

admin.get("/", (c) => {
  const list = events.listAdmin();
  const pending = orders.countByStatus(["PENDING_VERIFICATION"]);
  const awaiting = orders.countByStatus(["AWAITING_PAYMENT"]);
  const issued = list.reduce((n, e) => n + e.ticketsIssued, 0);
  return c.html(
    <Page title="Events" user={c.get("user")} path="/admin">
      <Flash {...flash(c)} />
      <div class="stats">
        <a class={`stat ${pending ? "alert" : ""}`} href="/admin/payments">
          <b>{pending}</b>
          <span>payments to verify</span>
        </a>
        <a class="stat" href="/admin/orders?status=AWAITING_PAYMENT">
          <b>{awaiting}</b>
          <span>holds awaiting payment</span>
        </a>
        <div class="stat">
          <b>{issued}</b>
          <span>tickets issued (all events)</span>
        </div>
        <div class="stat">
          <b>{list.filter((e) => e.event.published).length}</b>
          <span>published events</span>
        </div>
      </div>
      <div class="head">
        <h1>Events</h1>
        <a class="btn primary" href="/admin/events/new">
          + New event
        </a>
      </div>
      {list.length === 0 ? (
        <Empty title="No events yet">
          <p style="margin:6px auto 16px">Create your first night, add ticket waves, then publish it.</p>
          <a class="btn primary" href="/admin/events/new">
            Create an event
          </a>
        </Empty>
      ) : (
        <div class="card flush">
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Sales</th>
                  <th>Held / capacity</th>
                  <th>To verify</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ event: e, sale, held, capacity, pendingOrders }) => (
                  <tr data-href={`/admin/events/${e.id}`}>
                    <td>
                      <div class="ev-row">
                        <div class="thumb">
                          <Flyer event={e} />
                        </div>
                        <div>
                          <a href={`/admin/events/${e.id}`} style="font-weight:700;text-decoration:none">
                            {e.title}
                          </a>
                          <div class="small muted">
                            {fmtDayShort(e.startsAt)}, {fmtHourMin(e.startsAt)}
                            <br />
                            {e.venueName}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Status s={e.published ? "published" : "draft"} />
                    </td>
                    <td>
                      <Status s={sale} />
                    </td>
                    <td class="num">
                      {held} / {capacity}
                      <div class={`bar${capacity && held / capacity > 0.8 ? " hot" : ""}`}>
                        <i style={`width:${capacity ? Math.round((held / capacity) * 100) : 0}%`}></i>
                      </div>
                    </td>
                    <td>
                      {pendingOrders > 0 ? (
                        <a href={`/admin/payments?event=${e.id}`} class="badge" style="text-decoration:none">
                          {pendingOrders}
                        </a>
                      ) : (
                        <span class="muted">0</span>
                      )}
                    </td>
                    <td>
                      <div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
                        <a class="btn sm" href={`/admin/events/${e.id}/attendees`}>
                          Attendees
                        </a>
                        <a class="btn sm" href={`/admin/door/${e.id}`}>
                          Door
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Page>,
  );
});

// ---------- events ----------

const eventValues = (e: Event): Record<string, string> => ({
  title: e.title,
  slug: e.slug,
  subtitle: e.subtitle ?? "",
  organizer: e.organizer,
  description: e.description,
  startsAt: epochToLocalInput(e.startsAt),
  endsAt: e.endsAt ? epochToLocalInput(e.endsAt) : "",
  venueName: e.venueName,
  venueAddress: e.venueAddress,
  city: e.city,
  lineup: lineupToText(events.lineupOf(e)),
  maxPerOrder: String(e.maxPerOrder),
  maxPerBuyer: String(e.maxPerBuyer),
  doorPrice: e.doorPriceCents === null ? "" : String(e.doorPriceCents / 100),
  doorLimit: e.doorLimit === null ? "" : String(e.doorLimit),
  agePolicy: e.agePolicy,
  refundPolicy: e.refundPolicy,
});

function EventForm({ action, v, e, submit }: { action: string; v: Record<string, string>; e?: Record<string, string>; submit: string }) {
  const field = (k: string, label: string, type = "text", extra: Record<string, unknown> = {}) => (
    <label>
      {label}
      <input name={k} type={type} value={v[k] ?? ""} {...extra} />
      <FieldErr e={e} k={k} />
    </label>
  );
  return (
    <form method="post" action={action} class="fields">
      <div class="fields two">
        {field("title", "Title", "text", { required: true })}
        {field("slug", "URL slug", "text", { required: true, pattern: "[a-z0-9]+(-[a-z0-9]+)*", placeholder: "low-frequency" })}
      </div>
      <div class="fields two">
        {field("subtitle", "Subtitle")}
        {field("organizer", "Presented by", "text", { placeholder: "Night Shift" })}
      </div>
      <label>
        Description
        <textarea name="description">{v.description ?? ""}</textarea>
      </label>
      <div class="fields two">
        {field("startsAt", "Starts (Beirut time)", "datetime-local", { required: true })}
        {field("endsAt", "Ends (optional)", "datetime-local")}
      </div>
      <div class="fields two">
        {field("venueName", "Venue", "text", { required: true })}
        {field("city", "City", "text", { required: true })}
      </div>
      {field("venueAddress", "Address")}
      <label>
        Lineup <span class="hint">one per line: 22:00 | Name | role</span>
        <textarea name="lineup">{v.lineup ?? ""}</textarea>
      </label>
      <div class="fields two">
        {field("maxPerOrder", "Max tickets per order", "number", { min: 1, max: 20 })}
        {field("maxPerBuyer", "Max tickets per person (whole event)", "number", { min: 1, max: 100 })}
      </div>
      <div class="fields two">
        {field("doorPrice", "Door price, cash ($)", "number", { min: 0, step: "0.01", placeholder: "Blank = no walk-ins" })}
        {field("doorLimit", "Walk-in limit", "number", { min: 1, placeholder: "Blank = no limit" })}
      </div>
      {field("agePolicy", "Age policy")}
      {field("refundPolicy", "Refund policy")}
      <div>
        <button class="primary">{submit}</button>
      </div>
    </form>
  );
}

const NEW_DEFAULTS = {
  city: "Beirut",
  maxPerOrder: "6",
  maxPerBuyer: "6",
  agePolicy: "18+ only. Valid ID required at the door.",
  refundPolicy: "All sales are final. Tickets are non-refundable but may be transferred.",
};

const NewEventPage = ({ c, v, e, err }: { c: { get: (k: "user") => Env["Variables"]["user"] }; v: Record<string, string>; e?: Record<string, string>; err?: string }) => (
  <Page title="New event" user={c.get("user")} path="/admin">
    <p class="crumb">
      <a href="/admin">Events</a>
    </p>
    <div class="head">
      <div>
        <h1>New event</h1>
        <p class="sub">It starts as a draft. Add ticket waves, then publish when you're ready to sell.</p>
      </div>
    </div>
    <Flash err={err} />
    <div class="card" style="max-width:780px">
      <EventForm action="/admin/events/new" v={v} e={e} submit="Create draft" />
    </div>
  </Page>
);

const MODE_HELP = {
  MANUAL: "Manual: sells while you have it switched on",
  AUTO: "Auto: opens when the wave above sells out",
  SCHEDULED: "Scheduled: sells between the times you set",
};

/** Shared by "Add wave" and each wave's Edit panel. Schedule fields only show for SCHEDULED. */
function WaveFields({ w, held }: { w?: Partial<WaveView>; held?: number }) {
  return (
    <>
      <div class="fields two">
        <label>
          Name <input name="name" value={w?.name ?? ""} required placeholder="Early Bird" />
        </label>
        <label>
          Price ($) <input name="priceDollars" type="number" step="0.01" min="0" required value={w ? String((w.priceCents ?? 0) / 100) : ""} />
        </label>
        <label>
          Capacity {held !== undefined && <span class="hint">(at least {held} already held)</span>}
          <input name="capacity" type="number" min={Math.max(1, held ?? 1)} required value={w?.capacity ? String(w.capacity) : ""} />
        </label>
        <label>
          How it goes on sale
          <select name="mode">
            {(["MANUAL", "AUTO", "SCHEDULED"] as const).map((m) => (
              <option value={m} selected={(w?.mode ?? "MANUAL") === m}>
                {MODE_HELP[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="fields two" data-show-if="mode=SCHEDULED">
        <label>
          On sale from <span class="hint">(Beirut time)</span>
          <input name="opensAt" type="datetime-local" value={w?.opensAt ? epochToLocalInput(w.opensAt) : ""} />
        </label>
        <label>
          Until <span class="hint">(optional)</span>
          <input name="closesAt" type="datetime-local" value={w?.closesAt ? epochToLocalInput(w.closesAt) : ""} />
        </label>
      </div>
      <label class="check" data-show-if="mode=MANUAL">
        <input name="manualOpen" type="checkbox" checked={w?.manualOpen ?? false} /> On sale now
      </label>
    </>
  );
}

function EventPage(props: {
  c: { get: (k: "user") => Env["Variables"]["user"] };
  id: string;
  v?: Record<string, string>;
  e?: Record<string, string>;
  msg: { ok?: string; err?: string };
}) {
  const { event: ev, waves } = events.getAdmin(props.id)!;
  const base = `/admin/events/${ev.id}`;
  const held = waves.reduce((n, w) => n + w.held, 0);
  const cap = waves.reduce((n, w) => n + w.capacity, 0);
  return (
    <Page title={ev.title} user={props.c.get("user")} path="/admin">
      <p class="crumb">
        <a href="/admin">Events</a>
      </p>
      <div class="head">
        <div>
          <h1>{ev.title}</h1>
          <p class="sub">
            <Status s={ev.published ? "published" : "draft"} />
            <span class="muted">
              {"  "}
              {fmtDate(ev.startsAt)}, {ev.venueName}
            </span>
          </p>
        </div>
        <div class="row">
          {ev.published && (
            <a class="btn sm" href={`/e/${ev.slug}`} target="_blank" rel="noopener">
              View public page
            </a>
          )}
          <form method="post" action={`${base}/duplicate`}>
            <button class="sm">Duplicate</button>
          </form>
          <form
            method="post"
            action={`${base}/publish`}
            data-confirm={ev.published ? "Unpublish? The event disappears from the site; existing tickets stay valid." : undefined}
          >
            <input type="hidden" name="published" value={ev.published ? "0" : "1"} />
            {ev.published ? <button class="sm">Unpublish</button> : <button class="primary">Publish</button>}
          </form>
        </div>
      </div>
      <Flash {...props.msg} />
      <div class="chips">
        <a href={`${base}/attendees`}>Attendees</a>
        <a href={`/admin/orders?event=${ev.id}`}>Orders</a>
        <a href={`/admin/payments?event=${ev.id}`}>Payments</a>
        <a href={`${base}/stats`}>Stats</a>
        <a href={`/admin/door/${ev.id}`}>Door</a>
        <a href={`/admin/trace?event=${ev.id}`}>Trace</a>
      </div>

      <div class="card flush" style="overflow:visible">
        <div class="spread" style="padding:20px 22px 0">
          <h2 style="margin:0">Ticket waves</h2>
          <span class="small muted num">
            {held} of {cap} held
          </span>
        </div>
        <p class="small muted" style="padding:6px 22px 0;margin:0">
          Held counts paid, pending and unexpired unpaid holds. Buyers see waves top to bottom.
        </p>
        <div class="scroll" style="margin-top:8px;overflow:visible">
          <table>
            <thead>
              <tr>
                <th>Wave</th>
                <th>Price</th>
                <th>Held</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {waves.map((w, i) => (
                <tr>
                  <td>
                    <strong>{w.name}</strong>
                    <div class="small muted">{MODE_HELP[w.mode as keyof typeof MODE_HELP]?.split(":")[0]}</div>
                  </td>
                  <td class="num">{money(w.priceCents)}</td>
                  <td class="num">
                    {w.held} / {w.capacity}
                    <div class={`bar${w.low ? " hot" : ""}`}>
                      <i style={`width:${Math.round((w.held / w.capacity) * 100)}%`}></i>
                    </div>
                  </td>
                  <td>
                    <Status s={w.state} />
                    <div class="small muted">{w.why}</div>
                  </td>
                  <td>
                    <div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
                      {w.mode === "MANUAL" && (
                        <form method="post" action={`/admin/waves/${w.id}/open`}>
                          <input type="hidden" name="open" value={w.manualOpen ? "0" : "1"} />
                          {w.manualOpen ? <button class="sm">Stop sales</button> : <button class="sm ok">Start sales</button>}
                        </form>
                      )}
                      <form method="post" action={`/admin/waves/${w.id}/move`} class="inline" style="flex-wrap:nowrap">
                        <button class="sm ghost" name="dir" value="-1" aria-label={`Move ${w.name} up`} disabled={i === 0}>
                          ↑
                        </button>
                        <button class="sm ghost" name="dir" value="1" aria-label={`Move ${w.name} down`} disabled={i === waves.length - 1}>
                          ↓
                        </button>
                      </form>
                      <details>
                        <summary class="btn sm">Edit</summary>
                        <div class="card pop">
                          <form method="post" action={`/admin/waves/${w.id}`} class="fields">
                            <WaveFields w={w} held={w.held} />
                            <div>
                              <button class="primary sm">Save wave</button>
                            </div>
                          </form>
                          <form method="post" action={`/admin/waves/${w.id}/delete`} data-confirm={`Delete wave "${w.name}"?`} style="margin-top:14px">
                            <button class="sm danger">Delete wave</button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {waves.length === 0 && <Empty title="No waves yet">Add one below. An event needs at least one wave before it can be published.</Empty>}
        <details open={waves.length === 0} style="padding:16px 22px 22px;border-top:1px solid var(--line)">
          <summary class="btn sm">Add a wave</summary>
          <form method="post" action={`${base}/waves`} class="fields" style="margin-top:16px;max-width:640px">
            <WaveFields />
            <div>
              <button class="primary">Add wave</button>
            </div>
          </form>
        </details>
      </div>

      <div class="cols">
        <div class="card">
          <h2>Details</h2>
          <EventForm action={base} v={props.v ?? eventValues(ev)} e={props.e} submit="Save changes" />
        </div>
        <div>
          <div class="card">
            <h2>Artwork</h2>
            <Flyer event={ev} acts={events.lineupOf(ev).map((l) => l.name)} />
            <p class="small muted" style="margin:12px 0">
              {ev.posterKey ? "Your uploaded poster." : "No poster uploaded, so buyers see this generated flyer. Upload a 4:5 image to replace it."}
            </p>
            <form method="post" action={`${base}/poster`} enctype="multipart/form-data" class="fields">
              <label class="drop">
                <input type="file" name="poster" accept="image/png,image/jpeg,image/webp" required data-file-label />
                <strong data-file-name>Choose an image</strong>
                <span class="small">PNG, JPG or WEBP, up to 5 MB</span>
              </label>
              <div>
                <button class="sm">Upload poster</button>
              </div>
            </form>
          </div>
          <div class="card">
            <h2>Export</h2>
            <p class="small muted">Everyone with a ticket, for the door list or your records.</p>
            <a class="btn sm" href={`${base}/attendees.csv`}>
              Download attendees CSV
            </a>
          </div>
        </div>
      </div>
    </Page>
  );
}

admin.get("/events/:id", (c) => {
  if (!events.getAdmin(c.req.param("id"))) return c.notFound();
  return c.html(<EventPage c={c} id={c.req.param("id")} msg={flash(c)} />);
});

admin.post("/events/:id", async (c) => {
  const id = c.req.param("id");
  const f = await form(c);
  const parsed = eventInput.safeParse(f);
  if (!parsed.success)
    return c.html(<EventPage c={c} id={id} v={f} e={fieldErrors(parsed.error)} msg={{ err: "Fix the highlighted fields." }} />, 400);
  return act(c, `/admin/events/${id}`, () => events.update(id, parsed.data, c.get("user").id), "Saved.");
});

admin.post("/events/:id/publish", async (c) => {
  const id = c.req.param("id");
  const on = (await form(c)).published === "1";
  return act(c, `/admin/events/${id}`, () => events.setPublished(id, on, c.get("user").id), on ? "Published. It's live on the site." : "Unpublished.");
});

admin.post("/events/:id/duplicate", (c) => {
  try {
    const newId = events.duplicate(c.req.param("id"), c.get("user").id);
    return back(c, `/admin/events/${newId}`, { ok: "Copied as a draft. Adjust the date and slug, then publish." });
  } catch (e) {
    if (e instanceof DomainError) return back(c, `/admin/events/${c.req.param("id")}`, { err: e.message });
    throw e;
  }
});

admin.post("/events/:id/poster", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  return act(
    c,
    `/admin/events/${id}`,
    async () => {
      if (!(body.poster instanceof File)) throw new DomainError("NO_FILE", "Choose an image.");
      const { key } = await saveUpload("media", body.poster);
      events.setPoster(id, key, c.get("user").id);
    },
    "Poster updated.",
  );
});

admin.post("/events/:id/waves", async (c) => {
  const id = c.req.param("id");
  const parsed = waveInput.safeParse(await form(c));
  if (!parsed.success) return back(c, `/admin/events/${id}`, { err: Object.values(fieldErrors(parsed.error)).join(" ") });
  return act(c, `/admin/events/${id}`, () => events.addWave(id, parsed.data, c.get("user").id), "Wave added.");
});

const waveEvent = (waveId: string) => db().select({ eventId: wavesT.eventId }).from(wavesT).where(eq(wavesT.id, waveId)).get()?.eventId;

admin.post("/waves/:id", async (c) => {
  const id = c.req.param("id");
  const eventId = waveEvent(id);
  if (!eventId) return c.notFound();
  const parsed = waveInput.safeParse(await form(c));
  if (!parsed.success) return back(c, `/admin/events/${eventId}`, { err: Object.values(fieldErrors(parsed.error)).join(" ") });
  return act(c, `/admin/events/${eventId}`, () => events.updateWave(id, parsed.data, c.get("user").id), "Wave saved.");
});

admin.post("/waves/:id/open", async (c) => {
  const id = c.req.param("id");
  const eventId = waveEvent(id);
  if (!eventId) return c.notFound();
  const open = (await form(c)).open === "1";
  return act(c, `/admin/events/${eventId}`, () => events.setWaveOpen(id, open, c.get("user").id), open ? "Sales opened." : "Sales closed.");
});

admin.post("/waves/:id/move", async (c) => {
  const id = c.req.param("id");
  const eventId = waveEvent(id);
  if (!eventId) return c.notFound();
  const dir = (await form(c)).dir === "-1" ? -1 : 1;
  return act(c, `/admin/events/${eventId}`, () => events.moveWave(id, dir, c.get("user").id), "Wave moved.");
});

admin.post("/waves/:id/delete", (c) => {
  const id = c.req.param("id");
  const eventId = waveEvent(id);
  if (!eventId) return c.notFound();
  return act(c, `/admin/events/${eventId}`, () => events.deleteWave(id, c.get("user").id), "Wave deleted.");
});

admin.get("/events/:id/attendees", (c) => {
  const data = events.getAdmin(c.req.param("id"));
  if (!data) return c.notFound();
  const ev = data.event;
  const state = (["in", "out", "revoked"] as const).find((s) => s === c.req.query("state"));
  const q = c.req.query("q") ?? "";
  const rows = attendees.list(ev.id, { q, state });
  const n = attendees.counts(ev.id);
  const chip = (s: typeof state, label: string, count: number) => {
    const p = new URLSearchParams(Object.entries({ state: s, q }).filter(([, v]) => v) as [string, string][]);
    return (
      <a href={`?${p}`} class={state === s ? "on" : ""}>
        {label} <span class="num">{count}</span>
      </a>
    );
  };
  return c.html(
    <Page title={`Attendees | ${ev.title}`} user={c.get("user")} path="/admin">
      <p class="crumb">
        <a href={`/admin/events/${ev.id}`}>{ev.title}</a>
      </p>
      <div class="head">
        <div>
          <h1>Attendees</h1>
          <p class="sub">
            {n.in} of {n.all - n.revoked} checked in
          </p>
        </div>
        <div class="row">
          <a class="btn sm" href={`/admin/events/${ev.id}/attendees.csv`}>
            Download CSV
          </a>
          <a class="btn sm primary" href={`/admin/door/${ev.id}`}>
            Open door scanner
          </a>
        </div>
      </div>
      <div class="spread" style="margin-bottom:6px">
        <div class="chips" style="margin:0">
          {chip(undefined, "Everyone", n.all)}
          {chip("out", "Not arrived", n.out)}
          {chip("in", "Checked in", n.in)}
          {chip("revoked", "Cancelled", n.revoked)}
        </div>
        <form method="get" class="row">
          {state && <input type="hidden" name="state" value={state} />}
          <input name="q" value={q} placeholder="Name, email, phone or order" style="width:260px" aria-label="Search attendees" />
          <button class="sm">Search</button>
        </form>
      </div>
      <div class="card flush" style="margin-top:14px">
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Ticket</th>
                <th>Order</th>
                <th>Contact</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ ticket: t, order: o, wave }) => (
                <tr data-href={`/admin/orders/${o.id}`}>
                  <td>
                    <strong>{t.attendeeName}</strong>
                  </td>
                  <td class="small">{orderTier(o, wave)}</td>
                  <td>
                    <a class="mono small" href={`/admin/orders/${o.id}`}>
                      {o.reference}
                    </a>
                  </td>
                  <td class="small muted">
                    {o.customerEmail}
                    <br />
                    {o.customerPhone}
                  </td>
                  <td>
                    <Status s={t.status} />
                    {t.checkedInAt && <div class="small muted num">{fmtHourMin(t.checkedInAt)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <Empty title={q || state ? "No one matches" : "No tickets yet"}>
            {q || state ? "Try another name, or clear the filters." : "Tickets appear here once payments are approved or guest list spots are added."}
          </Empty>
        )}
      </div>
    </Page>,
  );
});

admin.get("/events/:id/attendees.csv", (c) => {
  const id = c.req.param("id");
  const ev = db().select().from(eventsT).where(eq(eventsT.id, id)).get();
  if (!ev) return c.notFound();
  const rows = db()
    .select({ t: ticketsT, o: ordersT, wave: wavesT.name })
    .from(ticketsT)
    .innerJoin(ordersT, eq(ordersT.id, ticketsT.orderId))
    .leftJoin(wavesT, eq(wavesT.id, ordersT.waveId))
    .where(eq(ticketsT.eventId, id))
    .orderBy(ticketsT.attendeeName)
    .all();
  // Prefix formula-looking cells so spreadsheet apps never execute them.
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ["attendee", "email", "phone", "order", "ticket_type", "comp", "ticket_status", "checked_in_at", "ticket_id"];
  const lines = rows.map(({ t, o, wave }) =>
    [t.attendeeName, o.customerEmail, o.customerPhone, o.reference, orderTier(o, wave), o.isComp ? "yes" : "", t.status, t.checkedInAt ? fmtStamp(t.checkedInAt) : "", t.id]
      .map(cell)
      .join(","),
  );
  return c.body([header.join(","), ...lines].join("\r\n"), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${ev.slug}-attendees.csv"`,
  });
});

// ---------- payments queue ----------

admin.get("/payments", (c) => {
  const eventId = c.req.query("event") || undefined;
  const list = orders.list({ status: "PENDING_VERIFICATION", eventId }).reverse(); // oldest first: fair queue
  const at = now();
  return c.html(
    <Page title="Payments" user={c.get("user")} path="/admin/payments">
      <div class="head">
        <div>
          <h1>Payments to verify</h1>
          <p class="sub">Oldest first. Match each proof to the Whish payment, then approve to issue tickets or reject with a reason.</p>
        </div>
        {eventId && (
          <a class="btn sm" href="/admin/payments">
            Show all events
          </a>
        )}
      </div>
      <Flash {...flash(c)} />
      {list.length === 0 && <Empty title="All caught up">New payment proofs land here as buyers submit them.</Empty>}
      <div class="queue">
        {list.map(({ order: o, eventTitle, waveName }) => (
          <article class="card verify">
            <div class="proof">
              {o.proofKey ? (
                o.proofMime === "application/pdf" ? (
                  <a class="btn sm" href={`/admin/orders/${o.id}/proof`} target="_blank" rel="noopener">
                    Open PDF proof
                  </a>
                ) : (
                  <a href={`/admin/orders/${o.id}/proof`} target="_blank" rel="noopener" aria-label="Open proof full size">
                    <img src={`/admin/orders/${o.id}/proof`} alt={`Payment proof for ${o.reference}`} />
                  </a>
                )
              ) : (
                <span class="small muted">No file. Reference only.</span>
              )}
            </div>
            <div class="facts-col">
              <div class="spread">
                <a href={`/admin/orders/${o.id}`} class="mono small">
                  {o.reference}
                </a>
                <span class="small muted">waiting {fmtDuration(at - (o.submittedAt ?? at))}</span>
              </div>
              <div class="big num" style="margin:8px 0 4px">
                {money(o.totalCents)}
              </div>
              <p class="small muted" style="margin:0 0 10px">
                {o.quantity} × {waveName}, {eventTitle}
              </p>
              <table class="kv">
                <tbody>
                  <tr>
                    <th>Buyer</th>
                    <td>{o.customerName}</td>
                  </tr>
                  <tr>
                    <th>Whish number</th>
                    <td class="num">{o.customerPhone}</td>
                  </tr>
                  <tr>
                    <th>Whish reference</th>
                    <td>{o.txnRef ? <code>{o.txnRef}</code> : <span class="muted">none given</span>}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="decide">
              <form method="post" action={`/admin/orders/${o.id}/approve`}>
                <input type="hidden" name="back" value="/admin/payments" />
                <button class="ok block">
                  Approve, issue {o.quantity} ticket{o.quantity === 1 ? "" : "s"}
                </button>
              </form>
              <form method="post" action={`/admin/orders/${o.id}/reject`} class="fields" style="gap:8px">
                <input type="hidden" name="back" value="/admin/payments" />
                <input name="reason" required placeholder="Reason the buyer will see" aria-label={`Reject reason for ${o.reference}`} />
                <button class="danger block">Reject</button>
              </form>
            </div>
          </article>
        ))}
      </div>
    </Page>,
  );
});

// ---------- orders ----------

admin.get("/orders", (c) => {
  const f = { status: c.req.query("status") || undefined, eventId: c.req.query("event") || undefined, q: c.req.query("q") || undefined };
  const list = orders.list(f);
  const evs = events.listAdmin();
  const chip = (status: string | undefined, label: string) => {
    const p = new URLSearchParams(Object.entries({ status, event: f.eventId, q: f.q }).filter(([, v]) => v) as [string, string][]);
    return (
      <a href={`/admin/orders?${p}`} class={f.status === status ? "on" : ""}>
        {label}
      </a>
    );
  };
  return c.html(
    <Page title="Orders" user={c.get("user")} path="/admin/orders">
      <h1>Orders</h1>
      <p class="sub">Every order with its live status. Click a reference for the full timeline.</p>
      <Flash {...flash(c)} />
      <div class="chips">
        {chip(undefined, "All")}
        {ORDER_STATUSES.map((s) => chip(s, s.replace("_", " ").toLowerCase()))}
      </div>
      <form method="get" class="row" style="margin-bottom:12px">
        {f.status && <input type="hidden" name="status" value={f.status} />}
        <select name="event" style="width:auto">
          <option value="">All events</option>
          {evs.map(({ event: e }) => (
            <option value={e.id} selected={f.eventId === e.id}>
              {e.title}
            </option>
          ))}
        </select>
        <input name="q" value={f.q ?? ""} placeholder="Search ref, name, email, phone, Whish ref" style="flex:1;min-width:200px;width:auto" />
        <button>Search</button>
      </form>
      <div class="card flush">
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Created</th>
                <th>Event and wave</th>
                <th>Qty</th>
                <th>Total</th>
                <th>Customer</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map(({ order: o, eventTitle, waveName, status }) => (
                <tr data-href={`/admin/orders/${o.id}`}>
                  <td>
                    <a href={`/admin/orders/${o.id}`} class="mono">
                      {o.reference}
                    </a>
                  </td>
                  <td class="small">{fmtStamp(o.createdAt).slice(5, 16)}</td>
                  <td class="small">
                    {eventTitle}
                    <br />
                    <span class="muted">{orderTier(o, waveName)}</span>
                  </td>
                  <td>{o.quantity}</td>
                  <td>{money(o.totalCents)}</td>
                  <td class="small">
                    {o.customerName}
                    <br />
                    <span class="muted">{o.customerEmail}</span>
                  </td>
                  <td>
                    <Status s={status} />
                    {status !== o.status && <div class="small muted">stored: {o.status}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length === 0 && <Empty>No orders match.</Empty>}
      </div>
      <p class="small muted">{list.length} shown (max 300), newest first.</p>
    </Page>,
  );
});

admin.get("/orders/:id", (c) => {
  const o = orders.getById(c.req.param("id"));
  if (!o) return c.notFound();
  const { order, event, wave, status } = o;
  const base = `/admin/orders/${order.id}`;
  return c.html(
    <Page title={order.reference} user={c.get("user")} path="/admin/orders">
      <p class="small">
        <a href="/admin/orders">← Orders</a>
      </p>
      <div class="head">
        <div>
          <div class="row">
            <h1 class="mono">{order.reference}</h1>
            <Status s={status} />
          </div>
          <p class="sub">
            <a href={`/admin/events/${event.id}`}>{event.title}</a>, {order.quantity} × {orderTier(order, wave?.name)},{" "}
            {money(order.totalCents)}
          </p>
        </div>
        <div class="row">
          {status === "APPROVED" && (
            <form method="post" action={`${base}/resend`}>
              <button class="sm">Resend tickets email</button>
            </form>
          )}
          <a class="btn sm" href={`/o/${order.accessToken}`} target="_blank">
            Customer view ↗
          </a>
        </div>
      </div>
      <Flash {...flash(c)} />
      <div class="cols">
        <div>
          {status === "PENDING_VERIFICATION" && (
            <div class="card stack">
              <h2>Verify payment</h2>
              {order.proofKey ? (
                order.proofMime === "application/pdf" ? (
                  <a class="btn" href={`${base}/proof`} target="_blank">
                    Open PDF proof ↗
                  </a>
                ) : (
                  <a href={`${base}/proof`} target="_blank">
                    <img src={`${base}/proof`} alt="payment proof" style="max-width:100%;max-height:420px;border-radius:8px" />
                  </a>
                )
              ) : (
                <p class="muted">No file uploaded.</p>
              )}
              <p>
                Whish ref: {order.txnRef ? <code>{order.txnRef}</code> : <span class="muted">none</span>}. Expected{" "}
                <strong>{money(order.totalCents)}</strong>
              </p>
              <form method="post" action={`${base}/approve`}>
                <button class="ok lg">
                  Approve and issue {order.quantity} ticket{order.quantity === 1 ? "" : "s"}
                </button>
              </form>
              <form method="post" action={`${base}/reject`} class="row">
                <input name="reason" required placeholder="Reason shown to the customer" style="flex:1;width:auto" />
                <button class="danger">Reject</button>
              </form>
            </div>
          )}
          {o.tickets.length > 0 && (
            <div class="card flush">
              <h2>Tickets ({o.tickets.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Status</th>
                    <th>Checked in</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {o.tickets.map((t) => (
                    <tr>
                      <td>
                        {t.attendeeName}
                        <div class="mono small muted">{t.id.slice(0, 8)}</div>
                      </td>
                      <td>
                        <Status s={t.status} />
                        {t.revokeReason && <div class="small muted">{t.revokeReason}</div>}
                      </td>
                      <td class="small">{t.checkedInAt ? fmtStamp(t.checkedInAt).slice(11, 19) : ""}</td>
                      <td>
                        {t.status === "VALID" && (
                          <form method="post" action={`/admin/tickets/${t.id}/revoke`} class="inline" data-confirm="Revoke this ticket? It will be refused at the door.">
                            <input name="reason" required placeholder="reason" size={12} />
                            <button class="sm danger">Revoke</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div class="card flush">
            <h2>Timeline</h2>
            <Timeline rows={o.timeline} />
          </div>
        </div>
        <div>
          <div class="card flush">
            <table class="kv">
              <tbody>
                {(
                  [
                    ["Customer", order.customerName],
                    ["Email", order.customerEmail],
                    ["Phone", order.customerPhone],
                    ["Unit price", money(order.unitPriceCents)],
                    ["Created", fmtStamp(order.createdAt).slice(0, 19)],
                    ["Hold expires", order.expiresAt ? fmtStamp(order.expiresAt).slice(0, 19) : "-"],
                    ["Proof submitted", order.submittedAt ? fmtStamp(order.submittedAt).slice(0, 19) : "-"],
                    ["Decided", order.decidedAt ? fmtStamp(order.decidedAt).slice(0, 19) : "-"],
                    ["Reject reason", order.rejectReason ?? "-"],
                    ["Stored status", order.status],
                  ] as const
                ).map(([k, v]) => (
                  <tr>
                    <th>{k}</th>
                    <td class="small">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Page>,
  );
});

admin.get("/orders/:id/proof", async (c) => {
  const o = db().select({ key: ordersT.proofKey }).from(ordersT).where(eq(ordersT.id, c.req.param("id"))).get();
  const f = o?.key ? await readStored("proofs", o.key) : null;
  if (!f) return c.notFound();
  return c.body(new Uint8Array(f.buf), 200, { "content-type": f.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
});

/** Where to go after an action: the payments queue if the form came from there, else the order. */
const afterAction = (f: Record<string, string>, id: string) => (f.back === "/admin/payments" ? "/admin/payments" : `/admin/orders/${id}`);

admin.post("/orders/:id/approve", async (c) => {
  const id = c.req.param("id");
  const to = afterAction(await form(c), id);
  try {
    const r = orders.approve(id, c.get("user").id);
    return back(c, to, { ok: r.alreadyApproved ? "Already approved; nothing changed." : "Approved. Tickets issued and emailed." });
  } catch (e) {
    if (e instanceof DomainError) return back(c, to, { err: e.message });
    throw e;
  }
});

admin.post("/orders/:id/reject", async (c) => {
  const id = c.req.param("id");
  const f = await form(c);
  return act(c, afterAction(f, id), () => orders.reject(id, c.get("user").id, f.reason ?? ""), "Rejected. Customer notified; tickets back on sale.");
});

admin.post("/orders/:id/resend", (c) => {
  const id = c.req.param("id");
  return act(
    c,
    `/admin/orders/${id}`,
    () => {
      limits.take("resendPerOrder", id); // Gmail allows ~500/day; don't let a stuck button burn it
      orders.resendTickets(id, c.get("user").id);
    },
    "Tickets queued for sending. Watch the timeline for EMAIL_SENT.",
  );
});

admin.post("/tickets/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const reason = (await form(c)).reason ?? "";
  const t = db().select({ orderId: ticketsT.orderId }).from(ticketsT).where(eq(ticketsT.id, id)).get();
  if (!t) return c.notFound();
  return act(c, `/admin/orders/${t.orderId}`, () => ticketsSvc.revoke(id, c.get("user").id, reason), "Ticket revoked.");
});

// ---------- comps ----------

admin.get("/comps", (c) => {
  const evs = events.listAdmin();
  return c.html(
    <Page title="Comps" user={c.get("user")} path="/admin/comps">
      <h1>Complimentary tickets</h1>
      <p class="sub">Free tickets for guests and artists. Issued immediately, don't use wave capacity.</p>
      <Flash {...flash(c)} />
      <form method="post" class="card fields" style="max-width:560px">
        <label>
          Event
          <select name="eventId">
            {evs.map(({ event: e }) => (
              <option value={e.id}>{e.title}</option>
            ))}
          </select>
        </label>
        <label>
          Guest name <input name="attendeeName" required />
        </label>
        <div class="fields two">
          <label>
            Email <span class="hint">(tickets sent here)</span>
            <input name="email" type="email" required />
          </label>
          <label>
            Phone <input name="phone" />
          </label>
        </div>
        <div class="fields two">
          <label>
            Quantity <input name="quantity" type="number" min="1" max="20" value="1" />
          </label>
          <label>
            Internal note <input name="note" placeholder="e.g. artist +1" />
          </label>
        </div>
        <div>
          <button class="primary">Issue comps</button>
        </div>
      </form>
    </Page>,
  );
});

admin.post("/comps", async (c) => {
  const parsed = compInput.safeParse(await form(c));
  if (!parsed.success) return back(c, "/admin/comps", { err: Object.values(fieldErrors(parsed.error)).join(" ") });
  try {
    const o = orders.createComp(parsed.data, c.get("user").id);
    return back(c, `/admin/orders/${o.id}`, { ok: "Comps issued and emailed." });
  } catch (e) {
    if (e instanceof DomainError) return back(c, "/admin/comps", { err: e.message });
    throw e;
  }
});
