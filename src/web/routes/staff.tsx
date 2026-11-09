import { Hono } from "hono";
import { listStaff, saveStaff } from "../../services/staff.ts";
import { act, flash, form } from "../http.ts";
import { Flash, Page } from "../layout.tsx";
import type { Env } from "../session.ts";

export const staff = new Hono<Env>();
staff.get("/staff", async (c) => {
  const accounts = await listStaff();
  return c.html(<Page title="Staff access" user={c.get("user")} path="/admin/staff">
    <h1>Staff access</h1><p class="sub">Only enabled accounts can sign in by email code. Admins manage the app; door scanners handle check-in and door sales.</p>
    <Flash {...flash(c)} />
    <section class="card"><h2>Add staff</h2><form method="post" action="/admin/staff" class="fields">
      <label>Name<input name="name" required maxlength={100} autocomplete="name" /></label>
      <label>Email<input name="email" type="email" required maxlength={254} autocomplete="email" /></label>
      <label>Role<select name="role"><option value="SCANNER">Door scanner</option><option value="ADMIN">Admin</option></select></label>
      <input type="hidden" name="active" value="true" /><button class="primary">Add staff</button>
    </form></section>
    <h2>Accounts</h2><p class="hint">Changing a role or disabling an account signs it out immediately. Re-enabling requires a new login code.</p>
    {accounts.map((account) => <section class="card" aria-label={`Account ${account.email}`}>
      <h3 style="overflow-wrap:anywhere">{account.email}</h3>
      <form method="post" action="/admin/staff" class="fields">
        <input type="hidden" name="email" value={account.email} />
        <label>Name<input name="name" value={account.name} required maxlength={100} /></label>
        <label>Role<select name="role"><option value="SCANNER" selected={account.role === "SCANNER"}>Door scanner</option><option value="ADMIN" selected={account.role === "ADMIN"}>Admin</option></select></label>
        <label>Status<select name="active"><option value="true" selected={account.active}>Enabled</option><option value="false" selected={!account.active}>Disabled</option></select></label>
        <button>Save account</button>
      </form>
    </section>)}
  </Page>);
});
staff.post("/staff", async (c) => {
  const f = await form(c);
  return act(c, "/admin/staff", () => saveStaff(c.get("user").id, { email: f.email, name: f.name, role: f.role, active: f.active === "true" ? true : f.active === "false" ? false : undefined }), "Staff access saved.");
});
