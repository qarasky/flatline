# QR sign-in

## Intent

Signing in to Flatline means pasting a long operator token. The owner forgets it, and
re-authenticating the kiosk on the TV (a Raspberry Pi with no keyboard) takes five steps:
find a token on the server, open RustDesk, connect to the Pi, pass the token through, paste it.

Add a second way to sign in: a screen with no session shows a QR code, an already signed-in phone
scans it and approves, and the screen signs itself in. It works on every screen that shows the
token gate (dashboard, superboard, kiosk), not only the kiosk.

## Goals

- A screen signs in with one scan and one tap, with no typing on the screen.
- Works everywhere `TokenGate` is shown.
- Each approved screen is its own operator token, named by the owner, visible in the Agents
  panel and revocable on its own. Revoking the TV does not sign out the phone.
- Approved tokens never expire (owner's decision).
- Pasting a token keeps working, as the fallback and for first boot.

## Non-goals

- Accounts, invites, 2FA, roles. Every operator token keeps full access, as today.
- Scoped or read-only kiosk tokens.
- Expiring or rotating screen tokens.
- Replacing `initial-token.txt` or the Agents panel's token minting.

## Anti-goals

- Someone who only sees or photographs the TV must not get in. Approval always needs a phone
  that already holds a valid operator token.
- The QR code must never contain a credential. It carries only a short-lived, single-use request
  code.
- Do not hand the approver's own token to the new screen (that would tie their revocation together).

## How it behaves

The mockups the owner approved are in `.superpowers/brainstorm/49704-1792606563/content/qr-flow.html`.

**Waiting screen (inside `TokenGate`).** Shows "Sign in to Flatline", the QR code, "Scan with your
phone, where you're already signed in", a countdown, a "Waiting for approval…" line, and a small
"Paste a token instead" link that reveals today's token input. When the code expires, a new one is
requested automatically. When approved, the screen stores the token exactly as the paste flow does
(`setToken`, `onSaved`).

**Approve page (phone).** The QR encodes a URL on this Flatline instance that opens an approve page
for the phone. It shows "Approve this screen?", a name field, what the requesting screen reports
about itself (browser and OS from the user agent, time since the request), and the line "Same access
as you. Never expires. Revoke it any time in Agents." Buttons: Approve, Deny. The name field is
pre-filled from the user agent (for example "Chrome on Linux"), and the owner can edit it. After
approval the phone shows "Signed in". If the phone is not signed in, it shows the normal token gate
first and then continues to the approve page.

**After approval.** A new `flatline_op_` token is minted and named with the entered name. The
waiting screen picks it up within a few seconds and signs in. The token is shown to the waiting
screen once and then forgotten by the server.

## Server design (Rust, `backend-rs`)

Findings from the code analysis that shape this:

- No sessions exist; the operator token is the session. Verification is a SHA-256 lookup in the
  `tokens` table (`auth.rs`).
- Pending requests are process-local state. The code already keeps bounded TTL maps in `AppState`
  and `auth.rs`; a restart dropping pending requests is harmless. No migration for the pending
  state. The minted token is a normal row in `tokens`.

Routes (names are the builder's call, shape is not):

- Public `start`: creates a pending request, returns `{code, expiresIn}`. The code is
  high-entropy and single-use, with a 5 minute lifetime. Records the user agent.
- Public `poll`, by code: returns pending, denied, expired, or approved with the token. Returning
  the token consumes the request. Polling every ~2 seconds.
- Authenticated `approve` and `deny`, by code, in the `authed` router. `approve` mints the token
  with the same logic as `api_keys::create` (no `expires`, `active` set), named by the owner, and
  emits `state.events.invalidate()` so the Agents panel refreshes.
- Authenticated `lookup`, by code, so the approve page can show the requesting screen's details
  before the owner decides.

Limits: the pending map is capped in size, and `start` is rate limited (there is no per-IP login
limiter today, so this adds one for these public routes). Unknown or reused codes behave like
expired ones and reveal nothing.

## Dashboard design (`apps/dashboard`)

- QR panel in `components/TokenGate.tsx`, polling `poll`. Both mount sites (`Dashboard.tsx`,
  `Superboard.tsx`) get it for free.
- Approve page: a new route in `lib/routes.ts` and `App.tsx`, reusing the stored token. Without a
  stored token it renders the gate.
- A QR library has to be added (none installed). Generating the SVG in the browser is the likely
  choice; the backend could do it instead.

## Decisions and open details

Owner decided:

- QR works everywhere, not only for the kiosk.
- Approved screens never expire.
- Each screen gets its own minted, nameable, revocable token.
- The approve page lets the owner name the screen.

My calls (flagged for review):

- 5 minute request lifetime with auto-refresh of the QR on the waiting screen.
- Polling instead of a new public stream.
- In-memory pending state rather than a database table.
- The QR URL is built from `public_url` in `config.rs` when set, otherwise from the request Host.
  A TV reaching the server by a LAN name that the phone cannot resolve is a known risk of the
  fallback.
- Name pre-filled from the user agent.

Added after the builder check (all my calls):

- **Poll secret.** `start` returns two values: the public request code (goes in the QR) and a
  private poll secret (never shown, kept in the waiting screen's memory). `poll` requires both.
  Someone who photographs the QR can scan it but can never collect the token.
- **Mint on delivery, not on approval.** `approve` only marks the request approved and records the
  chosen name. The token row is created on the first successful `poll`, and that result is cached
  for 60 seconds so a lost response can be retried. This leaves no orphaned, never-expiring tokens.
- **States.** pending, approved, denied, expired. A denied screen shows "Request denied" and
  requests a new QR. Approving an expired, denied or already-approved request fails with a clear
  message on the phone.
- **URL.** The code travels in the URL fragment (`#`), so it stays out of server logs and Referer
  headers. It must survive the phone's sign-in step. `public_url` is used when set; otherwise the
  request Host, and the approve page warns if the phone is reaching the instance by a different host.
- **Rate limiting.** Per-IP limits are not meaningful here (behind the Cloudflare Tunnel every
  request has the tunnel's address, and forwarded-for headers are spoofable; see `api/limits.rs`),
  so at most 64 requests wait at once per instance and `start` answers 429 beyond that. `poll`
  needs the poll secret and is not otherwise limited.
- **Names.** Trimmed, 1 to 60 characters, duplicates allowed.
- **Pruning.** The Agents panel already lists tokens; the builder should show last-used time for
  screen tokens there if it does not already.

Owner decided: no confirmation code. Approval is scan and tap. The risk that someone sends the
owner a QR code to approve is accepted; the user-agent line and request age on the approve page are
the only check.

Left to the builder: route names, the QR library, exact rate limits and caps, copy text, tests,
documentation updates (`docs/dashboard.md` "Signing in").
