# Kore ID single sign-on

Flatline can sign people in with **Kore ID**, the shared OpenID Connect
provider of Kore, KoreMind, KoreCalendar and Flatline (KoreMonitor). It is
optional: with `KORE_ID_ISSUER` unset nothing changes. Machine credentials are
never routed through SSO: operator tokens used as `Authorization: Bearer`,
push tokens, backup-agent tokens and the host agents keep working exactly as
before.

## Where it lives

The backend (`backend-rs/src/sso.rs`) is the OIDC relying party, not the web
app. It already owns accounts, sessions and the `fl_session` cookie, and
Caddy sends `/api/*` straight to it, so the browser never needs a second
cookie jar or a Node-side session. The web app only shows a **Continue with
Kore ID** link to `/api/v1/auth/sso/start` and a message for
`/sign-in?sso_error=<code>`.

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

Flatline has **one level of access**: every account is a full operator, and
there are no roles. So an account is never made just because someone has a
Kore ID. The default is that nobody can sign in through SSO.

- An account already tied to the person's `sub` signs in. Its name and email
  follow the provider. To revoke someone, remove them from **Members** and
  from the allowlist.
- Otherwise an account is created (or an existing local one with the same
  email is **linked**) only if the `sub` is in `KORE_ID_ALLOWED_SUBS` or the
  email is in `KORE_ID_ALLOWED_EMAILS`. Prefer `sub`: Kore ID does not verify
  email addresses, so an email allowlist trusts whoever registers that
  address first. A token with `email_verified: false` is never matched on
  email.
- An email that belongs to a local account already tied to a different `sub`
  is refused.

SSO accounts have no password (`password_hash` is the sentinel `!sso`) and
never need to choose one. Identity is the `sub` UUID (`users.kore_sub`, unique),
the same in all four Kore apps; local user ids stay integers.

## Bearer tokens

A Kore ID **access token** (a JWT with the client id as audience and a
`scope` claim) is accepted as `Authorization: Bearer` on `/api/v1` for an
account that has signed in through SSO. A valid token for someone who never
signed in here is a 401; id tokens (no `scope`), other apps' tokens and
anything unsigned or expired are refused. Tokens are short-lived (10 minutes
at Kore ID); an open live stream ends when its token does and reconnects.
Operator and agent tokens (`flatline_...`) are not JWTs and never take this path.

## Signing out

`DELETE /api/v1/auth/session` ends the local session as before. If the
session came from Kore ID the answer also has `ssoLogoutUrl`, Kore ID's
RP-initiated logout URL (`id_token_hint` from the stored id token and
`post_logout_redirect_uri`); the web app navigates there, which ends the
single sign-on session, and Kore ID returns to `/sign-in`. Register the
post-logout address with Kore ID. Kore ID has no back-channel logout, so
signing out of another Kore app does not end a Flatline session; it ends
after 30 idle days or sign-out here.

## Turning local sign-in off

| Variable               | Default | Effect when `false`                                                                                                                                                                                |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLATLINE_LOCAL_LOGIN` | `true`  | Email/password sign-in and first-account setup answer `403 local_login_disabled`. The backend refuses to start without Kore ID configured.                                                         |
| `FLATLINE_TOKEN_LOGIN` | `true`  | Signing in with an operator token (`auth/session {token}`, `auth/login`) answers `403 token_login_disabled`. Bearer use of tokens on the API is unaffected, so scripts and AI agents keep working. |

Keep token sign-in on if a wall TV or recovery path needs it. Before turning
local login off, sign in once through Kore ID and check that your account is
the one you expect.

## Configuration

| Variable                                       | Default                                          | Meaning                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `KORE_ID_ISSUER`                               | unset (SSO off)                                  | Provider base URL, e.g. `https://id.kore.example`. `https` required except for localhost.                 |
| `KORE_ID_CLIENT_ID`                            | `flatline`                                       | This app's client id (`koremonitor` after the rename).                                                    |
| `KORE_ID_CLIENT_SECRET`                        | unset                                            | Confidential client secret. Unset means a public client (only if Kore ID registers one without a secret). |
| `KORE_ID_CLIENT_AUTH`                          | `basic`                                          | `basic` or `post`: how the secret reaches the token endpoint.                                             |
| `KORE_ID_REDIRECT_URI`                         | `<FLATLINE_PUBLIC_URL>/api/v1/auth/sso/callback` | Must be registered with Kore ID exactly. Required if `FLATLINE_PUBLIC_URL` is unset.                      |
| `KORE_ID_POST_LOGOUT_REDIRECT_URI`             | `<origin of the redirect URI>/sign-in`           | Must be registered as a post-logout redirect.                                                             |
| `KORE_ID_ALLOWED_EMAILS`                       | empty                                            | Comma-separated emails that may get an account on first sign-in.                                          |
| `KORE_ID_ALLOWED_SUBS`                         | empty                                            | Comma-separated `sub` values that may get an account on first sign-in.                                    |
| `FLATLINE_LOCAL_LOGIN`, `FLATLINE_TOKEN_LOGIN` | `true`                                           | See above.                                                                                                |

A bad value stops the backend at startup with the variable named.

## Setting it up

1. Register the client with Kore ID: client id `flatline`, redirect URI
   `https://<your host>/api/v1/auth/sso/callback`, post-logout redirect URI
   `https://<your host>/sign-in`. Keep the secret it prints.
2. Set `FLATLINE_PUBLIC_URL`, `KORE_ID_ISSUER`, `KORE_ID_CLIENT_SECRET` and
   either `KORE_ID_ALLOWED_SUBS` or `KORE_ID_ALLOWED_EMAILS` in `.env`
   (see `.env.example`), then `docker compose up -d`.
3. Open `/sign-in` and choose **Continue with Kore ID**.

Behind the Cloudflare Tunnel the callback arrives with
`X-Forwarded-Proto: https`, so the session cookie is `Secure`, as for password
sign-in. The backend makes outbound HTTPS requests to the provider (discovery,
JWKS, token), so the `flatline` container needs its `egress` network.

## Tests

`backend-rs/tests/sso.rs` runs the whole flow against an in-process provider
(PKCE, state binding and replay, nonce, audience, signature, allowlists,
linking, bearer tokens, logout URL, the local-login switches);
`apps/web/__tests__/sso.test.ts` covers the sign-in helpers.
