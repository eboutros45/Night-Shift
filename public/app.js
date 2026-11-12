// Progressive enhancements shared by every page. Every form and link works without this file.
(() => {
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

  for (const box of document.querySelectorAll('[data-otp]')) {
    const input = box.querySelector('input');
    const slots = [...box.querySelectorAll('[data-digit]')];
    box.classList.add('otp-enhanced');
    const sync = () => {
      const clean = input.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (input.value !== clean) input.value = clean;
      slots.forEach((slot, index) => {
        slot.textContent = clean[index] || '0';
        slot.classList.toggle('empty', !clean[index]);
        slot.classList.toggle('active', document.activeElement === input && index === Math.min(input.selectionStart ?? clean.length, 5));
      });
    };
    for (const event of ['input', 'focus', 'blur', 'keyup', 'click']) input.addEventListener(event, sync);
    sync();
  }

  // Live countdowns: <span data-countdown="msLeft">. Reloads at zero so the page shows the new state.
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}h ${m}m` : `${m}:${String(r).padStart(2, "0")}`;
  };
  const start = Date.now();
  const timers = $$("[data-countdown]");
  if (timers.length) {
    const tick = () => {
      for (const el of timers) {
        const left = Number(el.dataset.countdown) - (Date.now() - start);
        el.textContent = fmt(left);
        el.classList.toggle("urgent", left < 5 * 60_000);
        if (left <= 0 && !el.dataset.done) {
          el.dataset.done = "1";
          setTimeout(() => location.reload(), 1200);
        }
      }
    };
    tick();
    setInterval(tick, 1000);
  }

  // Ticket selection: quantity stepper + live total.
  for (const form of $$("[data-ticket-form]")) {
    const qty = form.querySelector('input[name="quantity"]');
    const total = form.querySelector("[data-total]");
    if (!qty) continue;
    const update = () => {
      const max = Number(qty.max) || 20;
      const n = Math.min(max, Math.max(1, Math.round(Number(qty.value) || 1)));
      qty.value = String(n);
      // Price from the picked wave, or a fixed one on the form (door sales: data-unit-price).
      const picked = form.querySelector('input[name="wave"]:checked');
      const unit = picked ? Number(picked.dataset.price) : Number(form.dataset.unitPrice);
      if (total && !Number.isNaN(unit)) for (const el of $$("[data-total]", form)) el.textContent = money(unit * n);
      for (const b of $$("[data-step]", form)) {
        const d = Number(b.dataset.step);
        b.disabled = (d < 0 && n <= 1) || (d > 0 && n >= max);
      }
    };
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-step]");
      if (!b) return;
      qty.value = String(Number(qty.value) + Number(b.dataset.step));
      update();
    });
    form.addEventListener("change", update);
    qty.addEventListener("input", update);
    update();
  }

  // Copy buttons: <button data-copy="text">.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const was = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = was), 1500);
    } catch {}
  });

  // File inputs inside a drop zone show the chosen file's name.
  for (const input of $$("input[type=file][data-file-label]")) {
    const label = input.closest("label")?.querySelector("[data-file-name]");
    input.addEventListener("change", () => {
      if (label && input.files[0]) label.textContent = input.files[0].name;
    });
  }

  // <x data-show-if="mode=SCHEDULED">: shown only while the named select/input in the same form has that value.
  for (const el of $$("[data-show-if]")) {
    const [name, value] = el.dataset.showIf.split("=");
    const form = el.closest("form");
    const field = form && form.querySelector(`[name="${name}"]`);
    if (!field) continue;
    const sync = () => (el.hidden = field.value !== value);
    field.addEventListener("change", sync);
    sync();
  }

  // Back/forward cache restores pages with buttons still disabled from an earlier submit.
  window.addEventListener("pageshow", (e) => {
    for (const button of document.querySelectorAll('[data-original-label]')) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    if (e.persisted) for (const b of $$("form button:disabled")) (b.disabled = false), b.classList.remove("busy");
  });

  // <tr data-href="...">: click anywhere on the row (links/buttons inside still work normally).
  document.addEventListener("click", (e) => {
    const row = e.target.closest && e.target.closest("tr[data-href]");
    if (!row || e.target.closest("a,button,input,select,textarea,form")) return;
    location.href = row.dataset.href;
  });

  // <form data-confirm="Are you sure?">: ask before destructive actions.
  document.addEventListener("submit", (e) => {
    const msg = e.target.dataset && e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // After a POST is sent: show the pressed button as busy and stop double-submits.
  document.addEventListener("submit", (e) => {
    // Read the attribute: a field named "method" (the Whish/Neo choice) shadows form.method.
    if (e.defaultPrevented || (e.target.getAttribute("method") || "").toLowerCase() === "get") return;
    const pressed = e.submitter;
    if (pressed) {
      pressed.classList.add("busy");
      if (pressed.dataset.busyLabel) {
        pressed.dataset.originalLabel = pressed.innerHTML;
        pressed.textContent = pressed.dataset.busyLabel;
      }
    }
    for (const b of e.target.querySelectorAll("button")) setTimeout(() => (b.disabled = true));
  });
})();
