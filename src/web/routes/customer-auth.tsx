import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { orders, events } from "../../db/schema.ts";
import { signInRouter } from "../auth-router.tsx";
import { currentUser } from "../session.ts";
import { Page } from "../layout.tsx";
import { fmtDate } from "../../lib/time.ts";

export const customerAuth = signInRouter("customer");
customerAuth.get("/account", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 303);
  const mine = await db().select({ order: orders, event: events }).from(orders).innerJoin(events, eq(events.id, orders.eventId)).where(eq(orders.userId, user.id)).orderBy(desc(orders.createdAt));
  return c.html(<Page title="My tickets"><div class="head"><div><h1>My tickets</h1><p class="sub">{user.email}</p></div><form method="post" action="/logout"><button class="ghost">Sign out</button></form></div>
    {mine.length ? <div class="stack">{mine.map(({ order, event }) => <a class="card" href={`/o/${order.accessToken}`}><h2>{event.title}</h2><p>{fmtDate(event.startsAt)} · {order.quantity} {order.quantity === 1 ? "ticket" : "tickets"}</p><span>View order {order.reference} →</span></a>)}</div> : <div class="empty"><strong>No orders yet.</strong><p>Find your next night and your tickets will appear here.</p><a class="btn primary" href="/">Explore events</a></div>}
  </Page>);
});
