// Admin read-only views: site analytics, per-event stats, and /trace (the journal feed).
import * as doorSales from "../../services/door-sales.ts";
import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { advanceClock, clockOffset, resetClock } from "../../clock.ts";
import { config } from "../../config.ts";
import { fmtClock, fmtDuration, fmtStamp, money } from "../../lib/time.ts";
import { eventStats, siteStats } from "../../services/analytics.ts";
import * as events from "../../services/events.ts";
import { sweepExpired } from "../../services/inventory.ts";
import { feed } from "../../services/journal.ts";
import { flushMail, queue, verifySmtp } from "../../services/mailer.ts";
import * as limits from "../../lib/limits.ts";
import { db } from "../../db/client.ts";
import { journal } from "../../db/schema.ts";
import { desc, like } from "drizzle-orm";
import { back, flash, form } from "../http.ts";
import { Empty, Flash, Page, Status } from "../layout.tsx";
import type { Env } from "../session.ts";

export const insights = new Hono<Env>();

/** Label / count rows with an inline bar scaled to the largest value. */
const Bars: FC<{ rows: { key: string | null; n: number }[]; title: string }> = ({ rows, title }) => {
  const top = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div class="card flush">
      <h2>{title}</h2>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="small">{r.key ?? "(direct)"}</td>
              <td style="width:45%">
                <div class="bar" style="max-width:none;margin:0">
                  <i style={`width:${(r.n / top) * 100}%`}></i>
                </div>
              </td>
              <td style="width:50px;text-align:right">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>No data yet.</Empty>}
    </div>
  );
};

insights.get("/analytics", async (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
  const s = (await siteStats(days));
  return c.html(
    <Page title="Analytics" user={c.get("user")} path="/admin/analytics">
      <div class="head">
        <div>
          <h1>Site analytics</h1>
          <p class="sub">No cookies, no personal data. A visitor id is a hash that rotates daily.</p>
        </div>
        <div class="chips" style="margin:0">
          {[7, 30, 90].map((d) => (
            <a href={`?days=${d}`} class={d === days ? "on" : ""}>
              {d} days
            </a>
          ))}
        </div>
      </div>
      <div class="stats">
        <div class="stat">
          <b>{s.totals.views}</b>
          <span>page views</span>
        </div>
        <div class="stat">
          <b>{s.totals.visitors}</b>
          <span>visitor-days</span>
        </div>
      </div>
      <div class="cols even">
        <Bars title="Views by day (UTC)" rows={s.byDay.map((d) => ({ key: d.day, n: d.views }))} />
        <div>
          <Bars title="Top pages" rows={s.pages} />
          <Bars title="Referrers" rows={s.referrers} />
          <Bars title="Devices" rows={s.devices} />
        </div>
      </div>
    </Page>,
  );
});

insights.get("/events/:id/stats", async (c) => {
  const data = (await events.getAdmin(c.req.param("id")));
  if (!data) return c.notFound();
  const s = (await eventStats(data.event.id));
  const sold = s.byWave.reduce((n, w) => n + Number(w.sold ?? 0), 0);
  const revenue = s.byWave.reduce((n, w) => n + Number(w.revenue ?? 0), 0);
  const capacity = s.byWave.reduce((n, w) => n + w.capacity, 0);
  const admitted = s.scans.find((r) => r.result === "ADMITTED")?.n ?? 0;
  const walkIns = (await doorSales.summary(data.event.id))!;
  return c.html(
    <Page title={`Stats | ${data.event.title}`} user={c.get("user")} path="/admin">
      <p class="small">
        <a href={`/admin/events/${data.event.id}`}>← {data.event.title}</a>
      </p>
      <h1>Stats</h1>
      <p class="sub">{data.event.title}</p>
      <div class="stats">
        <div class="stat">
          <b>{money(revenue)}</b>
          <span>online revenue (Whish)</span>
        </div>
        <a class="stat" href={`/admin/door/${data.event.id}/walk-in`}>
          <b>{money(walkIns.cashCents)}</b>
          <span>
            door cash, {walkIns.sold} walk-in{walkIns.sold === 1 ? "" : "s"}
            {walkIns.voided.sales ? `, ${walkIns.voided.sales} voided` : ""}
          </span>
        </a>
        <div class="stat">
          <b>
            {sold} / {capacity}
          </b>
          <span>tickets sold</span>
        </div>
        <div class="stat">
          <b>{s.comps}</b>
          <span>comps</span>
        </div>
        <div class="stat">
          <b>{admitted}</b>
          <span>scanned in at door</span>
        </div>
      </div>
      <div class="cols even">
        <Bars title="Funnel" rows={s.funnel.map((f) => ({ key: f.step, n: f.n }))} />
        <div class="card flush">
          <h2>Sales by wave</h2>
          <table>
            <thead>
              <tr>
                <th>Wave</th>
                <th>Price</th>
                <th>Sold</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {s.byWave.map((w) => (
                <tr>
                  <td>{w.wave}</td>
                  <td>{money(w.price)}</td>
                  <td>
                    {Number(w.sold ?? 0)} / {w.capacity}
                  </td>
                  <td>{money(Number(w.revenue ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card flush">
          <h2>Orders by status</h2>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Orders</th>
                <th>Tickets</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {s.byStatus.map((r) => (
                <tr>
                  <td>
                    <Status s={r.status} />
                  </td>
                  <td>{r.orders}</td>
                  <td>{Number(r.tickets ?? 0)}</td>
                  <td>{money(Number(r.cents ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.byStatus.length === 0 && <Empty>No orders yet.</Empty>}
        </div>
        <Bars title="Door scans by result" rows={s.scans.map((r) => ({ key: r.result, n: r.n }))} />
        <Bars title="Arrivals per 15 min (Beirut)" rows={s.arrivals.map((a) => ({ key: fmtClock(a.slot).slice(0, 5), n: a.n }))} />
      </div>
    </Page>,
  );
});

insights.get("/trace", async (c) => {
  const q = (k: string) => c.req.query(k) || undefined;
  const f = { eventId: q("event"), entityType: q("type"), entityId: q("id"), action: q("action"), before: Number(q("before")) || undefined };
  const rows = (await feed({ ...f, limit: 200 }));
  const evs = (await events.listAdmin());
  const link = (p: Record<string, string | undefined>) =>
    "?" +
    new URLSearchParams(
      Object.entries({ event: f.eventId, type: f.entityType, id: f.entityId, action: f.action, ...p }).filter(([, v]) => v) as [string, string][],
    );
  const off = clockOffset();
  return c.html(
    <Page title="Trace" user={c.get("user")} path="/admin/trace">
      <h1>Trace</h1>
      <p class="sub">Every state change, admin action, door scan and email, newest first. Click any value to filter by it.</p>
      <Flash {...flash(c)} />

      {config.devTools && (
        <div class="card spread">
          <div>
            <h3 style="margin:0">Dev clock {off ? <span class="devclock mono">+{fmtDuration(off)}</span> : <span class="pill">real time</span>}</h3>
            <span class="small muted">Jump the app's "now" forward to watch holds expire and auto waves open/close. Resets on restart.</span>
          </div>
          <form method="post" action="/admin/dev/clock" class="row">
            {(
              [
                ["+5 min", 5],
                ["+31 min", 31],
                ["+1 day", 1440],
              ] as const
            ).map(([l, m]) => (
              <button class="sm" name="minutes" value={String(m)}>
                {l}
              </button>
            ))}
            <button class="sm danger" name="minutes" value="reset">
              Reset
            </button>
          </form>
        </div>
      )}

      <form method="get" class="row" style="margin-bottom:12px">
        <select name="event" style="width:auto">
          <option value="">All events</option>
          {evs.map(({ event: e }) => (
            <option value={e.id} selected={f.eventId === e.id}>
              {e.title}
            </option>
          ))}
        </select>
        <select name="type" style="width:auto">
          <option value="">All entities</option>
          {["order", "ticket", "event", "wave", "user", "scan"].map((t) => (
            <option selected={f.entityType === t}>{t}</option>
          ))}
        </select>
        <input name="action" value={f.action ?? ""} placeholder="ACTION" style="width:140px" />
        <input name="id" value={f.entityId ?? ""} placeholder="entity id" style="width:160px" />
        <button>Filter</button>
        <a class="btn" href="/admin/trace">
          Clear
        </a>
      </form>
      <div class="card flush">
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Entity</th>
                <th>Action</th>
                <th>Change</th>
                <th>By</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="mono small muted">{r.id}</td>
                  <td class="mono small">{fmtStamp(r.at).slice(5, 19)}</td>
                  <td class="small">
                    <a href={link({ type: r.entityType, id: undefined })}>{r.entityType}</a>{" "}
                    {r.entityId && (
                      <a class="mono" href={r.entityType === "order" ? `/admin/orders/${r.entityId}` : link({ type: r.entityType, id: r.entityId })}>
                        {r.entityId.slice(0, 8)}
                      </a>
                    )}
                  </td>
                  <td>
                    <a class="mono small" href={link({ action: r.action })}>
                      {r.action}
                    </a>
                  </td>
                  <td>
                    {r.fromStatus && <Status s={r.fromStatus} />}
                    {r.fromStatus && r.toStatus && " → "}
                    {r.toStatus && <Status s={r.toStatus} />}
                  </td>
                  <td class="small">{r.actorName}</td>
                  <td class="mono data">{r.data ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty>Nothing matches.</Empty>}
      </div>
      {rows.length === 200 && (
        <a class="btn" href={link({ before: String(rows[rows.length - 1]!.id) })}>
          Older entries
        </a>
      )}
    </Page>,
  );
});

insights.post("/dev/clock", async (c) => {
  if (!config.devTools) return c.notFound();
  const m = (await form(c)).minutes;
  if (m === "reset") resetClock();
  else advanceClock(Math.max(0, Number(m) || 0) * 60_000);
  const expired = (await sweepExpired());
  return back(c, "/admin/trace", {
    ok: `Clock ${m === "reset" ? "reset to real time" : `moved +${m} min`}. ${expired} hold(s) expired and recorded.`,
  });
});

// ---------- email settings / diagnostics ----------

insights.get("/email", async (c) => {
  const e = config.email;
  const recent = (await db()
      .select()
      .from(journal)
      .where(like(journal.action, "EMAIL_%"))
      .orderBy(desc(journal.id))
      .limit(30));
  return c.html(
    <Page title="Email" user={c.get("user")} path="/admin/email">
      <h1>Email</h1>
      <p class="sub">How customer emails are sent. Settings live in <code>.env</code>; restart the server after changing them.</p>
      <Flash {...flash(c)} />
      <div class="cols even">
        <div class="card stack">
          <div class="spread">
            <h2 style="margin:0">Delivery</h2>
            <span class={`pill ${e.provider === "smtp" ? "ok" : "warn"}`}>{e.provider === "smtp" ? "SENDING (SMTP)" : "CONSOLE ONLY"}</span>
          </div>
          <table class="kv">
            <tbody>
              <tr>
                <th>EMAIL_PROVIDER</th>
                <td class="mono">{e.provider}</td>
              </tr>
              <tr>
                <th>From</th>
                <td class="mono small">{e.from}</td>
              </tr>
              <tr>
                <th>SMTP host</th>
                <td class="mono small">
                  {e.smtp.host}:{e.smtp.port}
                </td>
              </tr>
              <tr>
                <th>SMTP user</th>
                <td class="mono small">{e.smtp.user || <span class="muted">not set</span>}</td>
              </tr>
              <tr>
                <th>SMTP password</th>
                <td>{e.smtp.pass ? <span class="pill ok">SET</span> : <span class="pill bad">NOT SET</span>}</td>
              </tr>
            </tbody>
          </table>
          <form method="post" action="/admin/email/verify">
            <button>Check connection</button>
          </form>
        </div>
        <div class="card">
          <h2>Send a test</h2>
          <form method="post" action="/admin/email/test" class="fields">
            <label>
              To <input name="to" type="email" required placeholder="you@example.com" />
            </label>
            <div>
              <button class="primary">Send test email</button>
            </div>
          </form>
          <p class="small muted">To test the ticket PDF, approve an order or use "Resend tickets email" on an approved order.</p>
        </div>
      </div>
      <div class="card flush">
        <h2>Recent emails</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Template</th>
              <th>To</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => {
              const d = (r.data ? JSON.parse(r.data) : {}) as Record<string, unknown>;
              return (
                <tr>
                  <td class="mono small">{fmtStamp(r.at).slice(5, 19)}</td>
                  <td>
                    <span class={`pill ${r.action === "EMAIL_SENT" ? "ok" : r.action === "EMAIL_FAILED" ? "bad" : ""}`}>{r.action.replace("EMAIL_", "")}</span>
                  </td>
                  <td class="small">{String(d.template ?? "")}</td>
                  <td class="small">
                    {r.entityType === "order" ? <a href={`/admin/orders/${r.entityId}`}>{String(d.to ?? "")}</a> : String(d.to ?? "")}
                  </td>
                  <td class="mono data">{String(d.error ?? (Array.isArray(d.attachments) && d.attachments.length ? `attached ${d.attachments.join(", ")}` : ""))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {recent.length === 0 && <Empty>No emails yet.</Empty>}
      </div>
    </Page>,
  );
});

insights.post("/email/verify", async (c) => {
  const r = await verifySmtp();
  return back(c, "/admin/email", r.ok ? { ok: r.detail } : { err: `Connection failed: ${r.detail}` });
});

insights.post("/email/test", async (c) => {
  const to = (await form(c)).to?.trim() ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return back(c, "/admin/email", { err: "Enter a valid email address." });
  const user = c.get("user");
  try {
    (await limits.take("testEmailPerUser", user.id));
  } catch (e) {
    return back(c, "/admin/email", { err: (e as Error).message });
  }
  (await queue(db(), {
        template: "test",
        to,
        subject: `${config.brand.name} test email`,
        text: `This is a test from ${config.brand.name}, sent by ${user.name}. If you can read it, email delivery works.`,
        entityType: "user",
        entityId: user.id,
      }));
  await flushMail();
  return back(c, "/admin/email", { ok: `Test sent to ${to}. Check the table below for SENT or FAILED.` });
});
