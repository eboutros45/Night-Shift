// "My tickets" without accounts: type your email, get the links to your tickets by email.
// The response is identical whether or not the address has tickets, so it can't be used to
// find out who is coming.
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, tx } from "../../db/client.ts";
import { events, orders } from "../../db/schema.ts";
import { DomainError, LIVE_ORDER_STATUSES } from "../../domain/status.ts";
import * as limits from "../../lib/limits.ts";
import { emailInput } from "../../services/login.ts";
import * as notify from "../../services/notify.ts";
import { clientIp, form, retryAfter } from "../http.ts";
import { Page } from "../layout.tsx";

export const account = new Hono();

const FindTickets = ({ sent, error, email }: { sent?: boolean; error?: string; email?: string }) => (
  <Page title="My tickets" path="/account">
    <section class="sign-in" aria-labelledby="find-title">
      <p class="sign-in-kicker">Night Shift / My tickets</p>
      <h1 id="find-title">{sent ? "Check your inbox." : "Find my tickets."}</h1>
      <p class="sign-in-intro">
        {sent
          ? "If that email has tickets, we've just sent the links. It can take a minute; check spam too."
          : "Enter the email you used and we'll send you the links to your tickets. No password, no account."}
      </p>
      {error && (
        <p class="flash err" role="alert">
          {error}
        </p>
      )}
      {sent ? (
        <a class="btn primary lg block" href="/">
          Back to events
        </a>
      ) : (
        <form method="post" action="/account" class="fields sign-in-form">
          <label for="find-email">Email address</label>
          <input id="find-email" name="email" type="email" maxlength={254} autocomplete="email" inputmode="email" placeholder="you@example.com" required autofocus value={email ?? ""} />
          <button type="submit" class="primary block sign-in-submit" data-busy-label="Sending…">
            Email me my tickets <span aria-hidden="true">↗</span>
          </button>
          <p class="hint">Tip: your ticket email from when you signed up has the same link.</p>
        </form>
      )}
      {!sent && (
        <a class="sign-in-back" href="/">
          ← Back to events
        </a>
      )}
    </section>
  </Page>
);

account.get("/account", (c) => c.html(<FindTickets />));

account.post("/account", async (c) => {
  const f = await form(c);
  const parsed = emailInput.safeParse(f.email ?? "");
  if (!parsed.success) return c.html(<FindTickets error="Enter a valid email address." email={f.email} />, 400);
  try {
    (await limits.take("linksPerIp", clientIp(c)));
    (await limits.take("linksPerEmail", parsed.data));
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    retryAfter(c, e);
    return c.html(<FindTickets error={e.message} email={parsed.data} />, e.status);
  }
  const found = (await db()
      .select({ order: orders, event: events })
      .from(orders)
      .innerJoin(events, eq(events.id, orders.eventId))
      .where(and(eq(orders.customerEmail, parsed.data), inArray(orders.status, LIVE_ORDER_STATUSES)))
      .orderBy(desc(events.startsAt))
      .limit(20));
  if (found.length) (await tx((t) => notify.ticketLinks(t, parsed.data, found)));
  return c.html(<FindTickets sent />);
});

// The old guest sign-in is gone; anything still pointing at it lands on "My tickets".
account.get("/login", (c) => c.redirect("/account", 303));
