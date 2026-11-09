// Camera scanning for /admin/door/:eventId. Progressive enhancement: without this file the
// plain form still works. Same QR seen again within 3s is ignored (camera sees it every frame).
(() => {
  const form = document.getElementById("scan-form");
  const toggle = document.getElementById("cam-toggle");
  const result = document.getElementById("result");
  const counts = document.getElementById("counts");
  const input = document.getElementById("code");
  if (!form || !window.Html5Qrcode) return;
  const eventId = form.dataset.event;
  let scanner = null;
  let last = { code: "", at: 0 };
  let busy = false;

  async function submit(code) {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`/admin/door/${eventId}/scan.json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const o = await res.json();
      const ok = o.result === "ADMITTED";
      result.className = `scan-result ${ok ? "ok" : "bad"}`;
      result.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = ok ? "✓ ADMIT" : `✕ ${o.result.replace("_", " ")}`;
      const s = document.createElement("span");
      s.textContent = o.message;
      result.append(b, s);
      counts.textContent = `${o.counts.checkedIn} / ${o.counts.total}`;
      if (navigator.vibrate) navigator.vibrate(o.result === "ADMITTED" ? 80 : [200, 100, 200]);
    } catch {
      result.textContent = "Network error, try again";
    } finally {
      busy = false;
    }
  }

  // With the camera on, the typed form also goes through JSON so the camera keeps running.
  form.addEventListener("submit", (e) => {
    if (!scanner) return;
    e.preventDefault();
    submit(input.value);
    input.value = "";
  });

  toggle.hidden = false;
  toggle.addEventListener("click", async () => {
    if (scanner) {
      await scanner.stop();
      scanner = null;
      toggle.textContent = "📷 Start camera";
      return;
    }
    scanner = new Html5Qrcode("reader");
    try {
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (code) => {
        const t = Date.now();
        if (code === last.code && t - last.at < 3000) return;
        last = { code, at: t };
        submit(code);
      });
      toggle.textContent = "Stop camera";
    } catch (err) {
      scanner = null;
      result.textContent = `Camera unavailable: ${err}`;
    }
  });
})();
