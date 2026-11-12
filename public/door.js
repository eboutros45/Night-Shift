// The doorman's camera. Accept one QR, stop the camera, and navigate to the server-rendered result.
// Once the doorman has started the camera, it starts by itself on every following scan, and an
// admitted ticket returns to scanning on its own, so a queue of paid guests needs no taps at all.
(() => {
  const form = document.getElementById("scan-form");
  const result = document.getElementById("result");
  const remember = (on) => { try { if (typeof sessionStorage !== "undefined") sessionStorage.setItem("ns-camera", on ? "1" : "0"); } catch { /* private mode */ } };
  const remembered = () => { try { return typeof sessionStorage !== "undefined" && sessionStorage.getItem("ns-camera") === "1"; } catch { return false; } };
  const buzz = (pattern) => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern); } catch { /* unsupported */ } };

  if (!form) {
    // A result is on screen: make it felt, bring the next action under the thumb.
    if (!result) return;
    const tone = result.dataset ? result.dataset.tone : undefined;
    if (tone === "ok") buzz(80);
    else if (tone === "due") buzz([80, 60, 80]);
    else if (tone === "bad") buzz(400);
    const next = document.getElementById("scan-next");
    const primary = document.getElementById("scan-primary") || next;
    if (primary) {
      result.scrollIntoView({ behavior: "auto", block: "start" });
      primary.focus({ preventScroll: true });
    }
    const wait = next && next.dataset ? Number(next.dataset.auto) : 0;
    if (wait > 0 && remembered()) setTimeout(() => { location.href = next.href; }, wait);
    return;
  }
  const toggle = document.getElementById("cam-toggle");
  const input = document.getElementById("code");
  if (!toggle || !input || !window.Html5Qrcode) return;
  let scanner = null;
  let locked = false;
  let changingCamera = false;

  async function submitOnce(code) {
    if (locked || !code.trim()) return;
    // Lock synchronously: successive frames may decode before stop() completes.
    locked = true;
    toggle.disabled = true;
    toggle.textContent = "Checking ticket…";
    input.value = code;
    if (scanner) {
      try { scanner.pause(true); } catch { /* stop below still releases the camera */ }
      try { await scanner.stop(); } catch { /* the lock still prevents a second submission */ }
      scanner = null;
    }
    form.requestSubmit();
  }

  form.addEventListener("submit", (event) => {
    if (!scanner || locked) return;
    event.preventDefault();
    void submitOnce(input.value);
  });

  async function toggleCamera() {
    if (locked || changingCamera) return;
    changingCamera = true;
    toggle.disabled = true;
    try {
      if (scanner) {
        await scanner.stop();
        scanner = null;
        remember(false);
        toggle.textContent = "Start camera";
        return;
      }
      scanner = new Html5Qrcode("reader");
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (code) => { void submitOnce(code); });
      remember(true);
      if (!locked) toggle.textContent = "Stop camera";
    } catch {
      scanner = null;
      remember(false);
      toggle.textContent = "Start camera";
      result.textContent = "Camera unavailable. Allow camera access, or find the guest by name below.";
    } finally {
      changingCamera = false;
      toggle.disabled = locked;
    }
  }

  toggle.hidden = false;
  toggle.addEventListener("click", toggleCamera);
  if (remembered()) void toggleCamera();
})();
