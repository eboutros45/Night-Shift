// Accept one QR, stop the camera, and navigate to the server-rendered result.
(() => {
  const form = document.getElementById("scan-form");
  const result = document.getElementById("result");
  if (!form) {
    if (result && document.getElementById("scan-next")) {
      result.focus();
      result.scrollIntoView({ behavior: "auto", block: "center" });
    }
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

  toggle.hidden = false;
  toggle.addEventListener("click", async () => {
    if (locked || changingCamera) return;
    changingCamera = true;
    toggle.disabled = true;
    try {
      if (scanner) {
        await scanner.stop();
        scanner = null;
        toggle.textContent = "Start camera";
        return;
      }
      scanner = new Html5Qrcode("reader");
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (code) => { void submitOnce(code); });
      if (!locked) toggle.textContent = "Stop camera";
    } catch {
      scanner = null;
      result.textContent = "Camera unavailable. Allow camera access or enter the ticket code below.";
      input.focus();
    } finally {
      changingCamera = false;
      toggle.disabled = locked;
    }
  });
})();
