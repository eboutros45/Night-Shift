/** Staff sign-in: email, then the six-digit code. */
export function SignIn({ verifying, email, error }: { verifying: boolean; email: string; error?: string }) {
  return <section class="sign-in" aria-labelledby="sign-in-title">
    <p class="sign-in-kicker">Night Shift / Management</p>
    <h1 id="sign-in-title">{verifying ? "Check your inbox." : "Welcome back."}</h1>
    <p class="sign-in-intro">{verifying ? `Enter the six-digit code sent to ${email}.` : "Sign in with your invited staff email."}</p>
    {error && <p class="flash err" role="alert">{error}</p>}
    {verifying ? <>
      <p class="hint">Only enabled staff receive a code. Check spam if it has not arrived.</p>
      <form method="post" action="/admin/verify" class="fields sign-in-form">
        <label for="login-code">Verification code</label>
        <div class="otp" data-otp>
          <div class="otp-slots" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span data-digit={i} class="empty">0</span>)}</div>
          <input id="login-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength={6} maxlength={6} autocomplete="one-time-code" required autofocus aria-describedby="code-help" placeholder="000000" />
        </div>
        <p id="code-help" class="hint">Use the latest code. It expires in 10 minutes.</p>
        <button type="submit" class="primary block sign-in-submit" data-busy-label="Signing in…">Verify and sign in <span aria-hidden="true">↗</span></button>
      </form>
      <div class="sign-in-secondary">
        <form method="post" action="/admin/login"><input type="hidden" name="email" value={email} /><button type="submit" class="ghost sm" data-busy-label="Sending…">Send a new code</button></form>
        <a href="/admin/login?change=1">Use another email</a>
      </div>
    </> : <form method="post" action="/admin/login" class="fields sign-in-form">
      <label for="login-email">Email address</label>
      <input id="login-email" name="email" type="email" maxlength={254} autocomplete="email" placeholder="you@example.com" required autofocus value={email} />
      <button type="submit" class="primary block sign-in-submit" data-busy-label="Sending your code…">Email me a code <span aria-hidden="true">↗</span></button>
      <p class="hint">Access is managed by your Night Shift administrator.</p>
    </form>}
    <a class="sign-in-back" href="/">← Back to events</a>
  </section>;
}
