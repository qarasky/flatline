# Kore ID single sign-on

**Kore ID is the only way a person signs in to KoreMonitor.** It is the shared
OpenID Connect provider of Kore, KoreMind, KoreCalendar and KoreMonitor.
There is no email/password login, no operator-token login, no
first-account setup, no change-password and no password reset. With
`KORE_ID_ISSUER` unset the web app still boots, and its sign-in page says that
no sign-in method is configured. Machine credentials are never routed through
SSO: operator API tokens used as `Authorization: Bearer`, push tokens,
backup-agent tokens and the host agents keep working exactly as before.

## Where it lives

The backend (`backend-rs/src/sso.rs`) is the OIDC relying party, not the web
app. It owns accounts, sessions and the `fl_session` cookie, and Caddy sends
`/api/*` straight to it, so the browser never needs a second cookie jar or a
Node-side session. The web app only shows a **Continue with Kore ID** link to
`/api/v1/auth/sso/start` and a message for `/sign-in?sso_error=<code>`.

## The flow

1. `GET /api/v1/auth/sso/start?next=/path` reads the provider's discovery
   document, makes `state`, `nonce` and a PKCE `S256` verifier, remembers them
   server-side (10 minutes, one use), sets the `fl_sso` cookie that binds the
   attempt to this browser, and redirects to Kore ID.
2. Kore ID signs the person in (its own session may already exist) and
   returns to `/api/v1/auth/sso/callback?code&state`.
3. The callback checks `state` and the `fl_sso` cookie, exchanges the code
   (client secret by HTTP Basic, or in the body with `KORE_ID_CLIENT_AUTH=post`),
   and verifies the id token: EdDSA signature against the provider's JWKS
   (cached, refetched for an unknown `kid`, at most every 30 s), `iss`, `aud`
   (the client id), `exp`, `nbf` and `nonce`. Any other `alg` is refused.
4. The token's `sub` picks the local account (see below), a normal session
   is created, and the browser is sent to `next` (a local path only).

Every failure redirects to `/sign-in?sso_error=` `state`, `provider`,
`token`, `unavailable`, `denied` or `disabled` and sets no session.

## Who gets an account

KoreMonitor has **one level of access: every account is a full operator**, with
no roles. Who may use KoreMonitor is therefore decided **in Kore ID's admin**:
Kore ID enforces per-user app access (app key `flatline`) and never hands a
code to someone without it, and its accounts are created by an admin, so
every token carries `email_verified: true`.

- An account already tied to the person's `sub` signs in. Its name follows
  the provider, and its email too when the provider marks it verified.
- Otherwise an account is **created on first sign-in** for anyone Kore ID
  admits (`KORE_ID_AUTO_PROVISION`, default `true`). On a fresh install the
  first person to sign in therefore becomes the first full operator; there is
  no bootstrap token to create them. An existing account with the same email
  is **linked** instead, only when the token says `email_verified: true`; its
  old password hash is overwritten with the no-password sentinel and it signs
  in through Kore ID from then on. An unverified email that matches an account
  is refused (`sso_error=denied`) rather than taking the account over.
- `KORE_ID_ALLOWED_SUBS` / `KORE_ID_ALLOWED_EMAILS` are an **optional extra
  filter**: when either is set, only listed identities get a new account (an
  email entry needs a verified email). `KORE_ID_AUTO_PROVISION=false` with no
  lists means only accounts already tied to a `sub` can sign in — do not use
  that on a fresh install, because nobody could create the first account.
- An email that belongs to an account already tied to a different `sub`
  is refused.

To give someone KoreMonitor, grant them the `flatline` app in Kore ID. To take
it away, remove the app (or disable the user) in Kore ID, which also ends
their KoreMonitor sessions by back-channel logout, and remove them from
**Members** so the account is gone.

SSO accounts have no password (`password_hash` is the sentinel `!sso`) and
never need to choose one. The column stays in the schema for older databases
but nothing verifies it. Identity is the `sub` UUID (`users.kore_sub`,
unique), the same in all four Kore apps; local user ids stay integers.

## Operator API tokens

Operator tokens (`flatline_op_...`) remain **machine credentials** for
`/api/v1` and the tokenized provisioning documents. They never create a
browser session: `POST /api/v1/auth/session` is sign-out-only, and a session
belongs to an account created by Kore ID. Mint and revoke them in **Tokens**.
Push, backup-agent and Kore ID access tokens are separate credentials, as
before.

A Kore ID **access token** is accepted as `Authorization: Bearer` on
`/api/v1` for an account that has signed in through SSO. It must have the
JWT header `typ: at+jwt` (RFC 9068; `application/at+jwt` is the same), the
client id as audience (and as `client_id` when present), a `scope`, and must
not come from a Kore ID session that back-channel logout already ended. Id
tokens (`typ: JWT`), logout tokens, other apps' tokens and anything unsigned
or expired are refused; a valid token for someone who never signed in here
is a 401. Tokens are short-lived (10 minutes at Kore ID); an open live
stream ends when its token does and reconnects. Operator and agent tokens
(`flatline_...`) are not JWTs and never take this path.

## Signing out

`DELETE /api/v1/auth/session` ends the local session. If the session came
from Kore ID the answer also has `ssoLogoutUrl`, Kore ID's RP-initiated logout
URL (`id_token_hint` from the stored id token and `post_logout_redirect_uri`);
the web app navigates there, which ends the single sign-on session, and Kore
ID returns to `/sign-in`. Register the post-logout address with Kore ID.

### Back-channel logout

When a Kore ID session ends anywhere (sign-out in another Kore app, an admin
disabling the user, "sign out everywhere", a password reset), Kore ID POSTs a
logout token to every app that got tokens in that session (OIDC Back-Channel
Logout 1.0). KoreMonitor's endpoint is

    POST /api/v1/auth/sso/backchannel-logout     (form field logout_token)

Register it as the client's `backchannelLogoutUri` in Kore ID's
`clients.json`: `https://<your host>/api/v1/auth/sso/backchannel-logout`.
Caddy already sends `/api/*` to the backend, and the route is public (Kore
ID calls it server to server, with no cookie).

Each KoreMonitor session made by a Kore ID sign-in stores the id token's `sid`
(`sessions.sso_sid`). The logout token is verified exactly as the spec says:
EdDSA signature against the JWKS, `iss`, `aud` = `KORE_ID_CLIENT_ID`, `iat`,
`exp`, header `typ: logout+jwt`, an `events` claim with
`http://schemas.openid.net/event/backchannel-logout`, no `nonce`, a `sid` or
`sub`, and a `jti` not seen before (remembered until the token's `exp`). A
valid token deletes every session with that `sid`, or, if it has no `sid`,
every Kore ID-made session of the account tied to its `sub`. Sessions not
made through Kore ID are left alone. The `sid` is also remembered for 15
minutes so that session's still-valid access tokens stop working. Answers:
`200` done (also when no session matched), `400 invalid_request` for a
missing or invalid token, `503` when the provider's keys cannot be fetched
(Kore ID retries).

## In-memory state

Pending sign-ins (`state`, nonce, PKCE verifier; 10 minutes), the logout
`jti` replay cache and the recently ended `sid`s are kept in the backend's
memory, not the database. KoreMonitor runs as a single backend process, so this
is enough; a restart only fails sign-ins that were in flight (the person
clicks **Continue with Kore ID** again) and forgets replay entries that would
have expired within two minutes anyway.

## Configuration

| Variable                           | Default                                          | Meaning                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KORE_ID_ISSUER`                   | unset (no browser sign-in)                       | Provider base URL, e.g. `https://id.kore.example`. `https` required except for localhost.                                                                                                   |
| `KORE_ID_CLIENT_ID`                | `flatline`                                       | This app's client id (unchanged by the display rename).                                                                                                                                     |
| `KORE_ID_CLIENT_SECRET`            | unset                                            | Confidential client secret. Unset means a public client (only if Kore ID registers one without a secret).                                                                                   |
| `KORE_ID_CLIENT_AUTH`              | `basic`                                          | `basic` or `post`: how the secret reaches the token endpoint.                                                                                                                               |
| `KORE_ID_REDIRECT_URI`             | `<FLATLINE_PUBLIC_URL>/api/v1/auth/sso/callback` | Must be registered with Kore ID exactly. Required if `FLATLINE_PUBLIC_URL` is unset.                                                                                                        |
| `KORE_ID_POST_LOGOUT_REDIRECT_URI` | `<origin of the redirect URI>/sign-in`           | Must be registered as a post-logout redirect.                                                                                                                                               |
| `KORE_ID_AUTO_PROVISION`           | `true`                                           | Anyone Kore ID admits to the app gets an account on first sign-in. The first sign-in on a fresh install creates the first operator. `false`: only already-tied accounts and the allowlists. |
| `KORE_ID_ALLOWED_EMAILS`           | empty                                            | Optional extra filter: comma-separated (verified) emails that may get an account on first sign-in.                                                                                          |
| `KORE_ID_ALLOWED_SUBS`             | empty                                            | Optional extra filter: comma-separated `sub` values that may get an account on first sign-in.                                                                                               |
| `KORE_ID_ACCOUNT_URL`              | `<issuer>/account`                               | The Kore ID account page, linked as **Kore ID account** in the account menu.                                                                                                                |
| `KORE_APP_URLS`                    | empty                                            | The other Kore apps for the app switcher, `app=https://url` pairs (`kore`, `koremind`, `korecalendar`). Apps without a URL are hidden.                                                      |

`FLATLINE_LOCAL_LOGIN` and `FLATLINE_TOKEN_LOGIN` no longer exist. A bad value
stops the backend at startup with the variable named.

## Setting it up

1. Register the client with Kore ID (`clients.json`): client id `flatline`
   (`"app": "flatline"`), redirect URI
   `https://<your host>/api/v1/auth/sso/callback`, post-logout redirect URI
   `https://<your host>/sign-in`, `backchannelLogoutUri`
   `https://<your host>/api/v1/auth/sso/backchannel-logout`. Keep the secret.
2. In Kore ID's admin, grant the `flatline` app to the people who should
   operate KoreMonitor (admins always have it).
3. Set `FLATLINE_PUBLIC_URL`, `KORE_ID_ISSUER` and `KORE_ID_CLIENT_SECRET` in
   `.env` (see `.env.example`), then `docker compose up -d`.
4. Open `/sign-in` and choose **Continue with Kore ID**. The first person to
   sign in becomes a full operator; no bootstrap token is involved.

Behind the Cloudflare Tunnel the callback arrives with
`X-Forwarded-Proto: https`, so the session cookie is `Secure`. The backend
makes outbound HTTPS requests to the provider (discovery, JWKS, token), so the
`flatline` container needs its `egress` network.

## Tests

`backend-rs/tests/sso.rs` runs the whole flow against an in-process provider
(PKCE, state binding and replay, nonce, audience, signature, provisioning
and the optional allowlists, verified-email linking, `at+jwt` bearer tokens,
the stored `sid`, back-channel logout and its refusals, logout URL, and
Kore-ID-only sign-in); `backend-rs/tests/sso_only.rs` asserts the password,
setup and operator-token login routes are gone. `apps/web/__tests__/sso.test.ts`
covers the sign-in helpers.
