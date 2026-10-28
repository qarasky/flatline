# Accounts: sign in with email and password

Date: 2026-10-28. Status: approved in conversation; written for the builder.
Related: [admin panel rewrite](2026-10-28-admin-panel-rewrite-design.md) (this
slots into its order of work, see below).

## Why

Today the only credential is a token: everyone who uses Flatline pastes a
`flatline_op_` token to sign in. The operator wants the old way back, as Kore
does it: **people sign in with an email and a password**. The operator and other
people at the office use Flatline; each person gets their own account.

Everyone can do the same things. Accounts exist to give each person their own
credentials, not to restrict anyone.

## What people get

- A sign-in page with **email and password** as the main form. A small "Use a
  token instead" link keeps token sign-in available (the wall TV, recovery).
- A **Members** section in the admin sidebar: the list of accounts, with **Add
  member** (email, name, starting password), reset a member's password, and
  remove a member.
- In the sidebar's account menu: the signed-in person's name, **Change
  password** and **Sign out**.
- A person added with a starting password is asked to **choose their own
  password the first time they sign in**, before anything else.

## Goals

- Each person signs in with their own email and password.
- The operator creates accounts; people then set their own password.
- Removing an account or resetting its password signs that person out
  everywhere at once.
- Tokens keep working exactly as today for the API, both agents, AI clients and
  the kiosk's QR pairing.

## Non-goals

- Roles, permissions, read-only accounts. Every account has full permission,
  the same as an operator token.
- Self-signup, invite links, email delivery of any kind, "forgot password"
  emails, SSO/OAuth, two-factor.
- An audit log of who changed what.
- Per-person preferences beyond name and password.

## Anti-goals (a failure even if it works)

- A removed person, or one whose password was reset, can keep using a browser
  they were signed in on.
- The operator locks everyone out: removing the last account, or a broken
  account sign-in, with no way back in. Token sign-in is the way back and must
  always work.
- A token-based client (agents, CI, AI clients, the wall TV) breaks or has to
  change.
- Passwords stored or logged recoverably.
- A starting password chosen by the operator stays in use indefinitely.

## Accounts

- An account has an **email** (unique, compared case-insensitively, stored as
  entered), a **name** (shown in the sidebar and the Members list) and a
  password. _(Name: writer's call; the operator asked for email and password.)_
- **Anyone signed in can add, reset and remove accounts**, since everyone has
  the same rights. A person cannot remove their own account (avoids a
  self-lockout by mistake); someone else does it.
- **Removing the last account is allowed** only because token sign-in always
  remains; the Members page warns when it would leave no accounts.
- **Passwords:** at least 10 characters, no other rules. _(Writer's call.)_
  Stored only as a slow, salted hash (bcrypt is already a dependency; argon2 is
  fine too, builder's call), checked off the async runtime as the bcrypt token
  check already is.
- **Starting password:** set by whoever adds the account or resets its
  password. The account is marked "must change password"; its first sign-in
  leads to a Change password screen and nothing else works until it is done
  (the API refuses other calls from that session with a clear error).
- **An unused starting password expires after 7 days.** Sign-in then refuses
  it with "ask someone to reset your password", and Members shows the account
  as needing a reset. _(Builder check; writer's call: an operator-chosen
  password must not sit valid indefinitely for someone who never signs in.)_
- **Changing your own password** asks for the current one.
- **Forgotten password:** another signed-in person resets it (a new starting
  password, marked "must change"). There is no email.

## Tokens belong to their maker

_(Builder check; the operator chose this.)_ Today tokens belong to no one, so a
removed person could keep full access through a token they made. Instead:

- Every token minted from now on records **who made it**: the account signed in
  when it was minted on the Tokens page, or the account that approved a QR
  pairing (the wall TV's token belongs to whoever approved it). Tokens minted
  with a bearer token, and every token that exists before this change (the
  first-boot admin token, imported keys, today's device tokens), have no maker.
- The Tokens page shows each token's maker ("—" when none).
- **Removing a member lists the tokens they made** and lets the remover revoke
  them in the same step, each one chosen individually, defaulting to revoke
  all; a paired screen the office still needs can be kept. A kept token keeps
  working and shows its maker as a removed member.
- Revoking a token ends the sessions made with it, as below.

## Sessions

- Signing in with email and password creates a **session** for that account;
  the browser holds it in the existing `fl_session` cookie (`HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS, the same CSRF rule for writes).
- Today the cookie carries the operator token itself. With accounts it carries
  a **session id** instead, stored hashed server-side, belonging either to an
  account or to a token (token sign-in and the kiosk). One mechanism for both.
- **Ending sessions:** removing an account, resetting its password, or the
  person changing their own password ends that account's other sessions
  immediately; revoking a token (including the tokens revoked while removing a
  member) ends the sessions made with it. Signing out ends
  the current session.
- **Lifetime:** an account session lasts 30 days since it was last used; a token
  session (the wall TV) lasts as long as today's cookie, 400 days since last
  used. _(Writer's call.)_
- `GET /api/v1/auth/me` says who is signed in: the account (id, email, name,
  must-change flag) or the token (its name).
- The SSE stream, CSRF rule and every `/api/v1` route accept the session cookie
  exactly as they accept today's cookie.

## Sign-in

- `POST /api/v1/auth/session` accepts `{email, password}` (new) or `{token}`
  (today's), and answers with the same shapes and the same refusal of agent
  tokens as now. A wrong email or wrong password gives the same answer, so the
  form does not reveal which emails exist.
- **Rate limit:** failed email/password attempts are limited per email and per
  client address, as Kore's login is; a limited attempt answers 429 with how long
  to wait. Token sign-in keeps its existing limits.
- The page shows email and password; "Use a token instead" switches the form to
  the token field. The migration of an old `localStorage` token (part 1) still
  runs first, unchanged.

## First account

- **Existing install (office):** nothing changes on upgrade. The operator signs
  in with a token once and adds their own account in Members. The migration
  creates no accounts.
- **Fresh install:** the first-boot admin token (`initial-token.txt`) works as
  today. In addition, the sign-in page, when no account exists yet, offers
  **Create the first account**, which asks for that admin token plus email, name
  and password. _(Writer's call: a first-account form open to anyone who can
  reach the page would let a stranger claim a fresh install.)_

## API

All under `/api/v1`, operator-authenticated (account session, token cookie or
bearer), registered in `backend-rs/src/api/mod.rs`, documented in `openapi.json`:

- `GET /users`, `POST /users` (email, name, starting password),
  `PATCH /users/{id}` (name, email), `POST /users/{id}/reset-password` (new
  starting password), `DELETE /users/{id}` (with the ids of the member's tokens
  to revoke in the same step; `GET /users/{id}` or the token list says which
  tokens they made).
- The token list (`GET /api-keys`) reports each token's maker.
- `POST /auth/password` (current and new password) for the signed-in account.
- `POST /auth/session` and `DELETE /auth/session` as above; `GET /auth/me`
  extended.
- The first-account route on a fresh install (exact shape: builder's call).

Bearer tokens may call the user routes (an AI client can add a member); there
is no "current account" for a bearer token, so `/auth/password` refuses it.

## Where this sits in the rewrite

This becomes **part 2** of the admin panel rewrite, before Monitors: it changes
the sign-in page and the sidebar's account menu that every later page sits in.
The rewrite's parts 2–6 move to 3–7. Members joins the sidebar after Tokens.

## Constraints

- One additive migration (`0017_*`). No rollback is planned (the rewrite
  migrates fully), but the usual pre-release database backup applies.
- `AGENTS.md`'s "One credential type" rule changes: accounts and operator tokens
  are both full-permission operator credentials; push and backup-agent tokens are
  unchanged. Update it, `docs/api.md`, `docs/architecture.md`, and the dashboard
  docs in the same change.
- The old Vite dashboard keeps working with tokens until part 7 removes it; it
  does not get an email/password form.
- Status pages, agents, provisioning and backup endpoints are untouched.

## Left to the builder

- Table and column names, the hash algorithm and cost, session id format.
- Exact rate-limit numbers (Kore's are a fine starting point).
- Members page layout and copy; whether reset shows the new starting password
  once or lets the operator type it.
- Whether "must change password" is enforced by a dedicated error code the app
  routes on, or by `/auth/me` alone plus a server-side refusal.
