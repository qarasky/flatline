# Admin panel, part 2: accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in to the new web app with their own email and password; anyone signed in manages members in a Members section; tokens record who made them, and removing a member can revoke them.

**Architecture:** One additive migration adds `users`, `sessions` and token-maker columns. The `fl_session` cookie stops carrying the operator token and carries a random session id instead, stored hashed; a session belongs to an account or a token. `require_token` resolves a bearer token or a session into an `Authed { principal, credential }` request extension that handlers, the SSE stream and the must-change-password gate read. The web app gains an email/password sign-in, a change-password page, the signed-in name in the sidebar, and a Members page.

**Tech Stack:** Rust (axum, sqlx/SQLite, `bcrypt` 0.19 already a dependency), Next.js 16 App Router, shadcn/ui, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-accounts-design.md` (and the rewrite spec `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`; this is its part 2).

## Global Constraints

- Every account has full permission, the same as an operator token. No roles.
- Email unique case-insensitively, stored as entered. Password at least **10** characters, no other rule.
- Passwords hashed with bcrypt off the async runtime (`spawn_blocking`); cost from `FLATLINE_PASSWORD_COST`, default **12**, clamped to 4..=31 (tests set 4).
- Starting password (set on add or reset) → `must_change_password`; it **expires 7 days** after it was set if still unchanged.
- Session lifetimes, sliding on use: account **30 days**, token **400 days**. Cookie attributes unchanged from part 1 (`HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`, `Secure` over HTTPS); the CSRF rule is unchanged.
- Ending sessions: removing an account, resetting its password, or changing your own password ends that account's other sessions; a revoked/disabled/expired/deleted token ends the sessions made with it.
- Wrong email and wrong password answer identically (401 `unauthorized`). Failed password sign-ins limited to **5 per email** and **20 per client address** per **15 minutes** (429 `rate_limited`, `retryAfter` seconds).
- A person cannot remove their own account. Removing the last account is allowed.
- Bearer tokens keep working everywhere exactly as today, including `/api/v1/users*`.
- One migration, `backend-rs/migrations/0017_accounts.sql`, additive. No rollback is planned.
- Repo rules (`AGENTS.md`): docs change with behaviour; routes in `mod.rs` and `openapi.json`; `type(scope): summary` commits; no emoji; Prettier; never push or deploy without the operator's go-ahead.
- The old Vite dashboard keeps working with tokens and gets no new UI.

## Review Focus

1. **A removed or reset member's open browser.** Their next API call, page load and live stream (within its 15 s revalidation) are refused. Tests: Task 2 (`removing_an_account_ends_its_sessions`, `the_stream_drops_a_removed_account`), Task 3 (`resetting_a_password_ends_sessions`).
2. **Must-change bypass.** A session with a starting password can call only `GET /auth/me`, `POST /auth/password` and `DELETE /auth/session`; everything else answers 403 `password_change_required`, including writes and the SSE stream. Test: Task 3.
3. **Account enumeration and brute force.** An unknown email and a wrong password answer the same 401; the sixth failure for one email inside 15 minutes is 429 even with the right password. Test: Task 3.
4. **First-account takeover on a fresh install.** `POST /auth/setup` without a valid operator token is refused, and once any account exists it answers 409 even with a token. Test: Task 3.
5. **The kiosk's token session outliving its token.** Disabling, expiring or deleting the token a session was made from ends that session. Test: Task 2.

---

### Task 1: Schema and the account store

**Files:**

- Create: `backend-rs/migrations/0017_accounts.sql`, `backend-rs/src/accounts.rs` (+ `pub mod accounts;` in `lib.rs`), `backend-rs/src/api/users.rs`
- Modify: `backend-rs/src/api/mod.rs` (routes in the `authed` group), `backend-rs/src/api/openapi.json`, `docs/api.md`
- Test: `backend-rs/tests/accounts.rs`; `backend-rs/tests/common/mod.rs` (set `FLATLINE_PASSWORD_COST=4` before building the harness)

**Interfaces:**

- Produces, schema (`0017_accounts.sql`, with a header comment):
  - `users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE /* lowercased */, name TEXT NOT NULL, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, password_set_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')))`
  - `sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (...now), last_used_at TEXT NOT NULL DEFAULT (...now), CHECK ((user_id IS NULL) != (token_id IS NULL)))` + index on `user_id`, `token_id`
  - `ALTER TABLE tokens ADD COLUMN maker_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;` and `ALTER TABLE tokens ADD COLUMN maker_name TEXT;` (the name survives the account's removal)
- Produces, Rust (`crate::accounts`):
  - `pub const MIN_PASSWORD_CHARS: usize = 10; pub const STARTING_PASSWORD_DAYS: i64 = 7;`
  - `pub struct Account { pub id: i64, pub email: String, pub name: String, pub must_change_password: bool, pub password_set_at: String, pub created_at: String }` with `pub fn starting_password_expired(&self) -> bool` (must change and set more than 7 days ago) and `pub fn to_json(&self) -> Value` → `{id, email, name, mustChangePassword, startingPasswordExpired, createdAt}`.
  - `pub enum AccountError { BadEmail, BadName, WeakPassword, EmailTaken, NotFound, Db(sqlx::Error) }` and `impl From<AccountError> for ApiError` → 400 `bad_request` / 400 `weak_password` / 409 `email_taken` / 404 `not_found` / 500.
  - `pub fn password_cost() -> u32`; `pub async fn hash_password(password: String) -> String` (spawn_blocking).
  - `pub async fn create(pool, email: &str, name: &str, password: &str, must_change: bool) -> Result<Account, AccountError>` — trims email and name; email must contain one `@` with text on both sides; name 1–100 chars.
  - `pub async fn list(pool) -> Result<Vec<Account>, AccountError>` (by name), `get(pool, id)`, `count(pool) -> Result<i64, AccountError>`, `update(pool, id, name: Option<&str>, email: Option<&str>)`, `set_password(pool, id, password: &str, must_change: bool)` (also sets `password_set_at` now), `delete(pool, id)`.
  - `pub async fn verify_password(pool, email: &str, password: &str) -> Result<Option<Account>, AccountError>` — compares against a fixed dummy bcrypt hash when the email is unknown, so timing does not reveal it.
- Produces, HTTP (operator auth, any principal): `GET /api/v1/users` → `{ok, users: [Account json + tokenCount]}`; `POST /api/v1/users` `{email, name, password}` → 201 `{ok, user}` (must change); `GET /api/v1/users/{id}` → `{ok, user, tokens: [{id, name, active}]}` (tokens they made); `PATCH /api/v1/users/{id}` `{name?, email?}`; `POST /api/v1/users/{id}/reset-password` `{password}` (Task 3 adds session ending). `DELETE /api/v1/users/{id}` is Task 4.

- [ ] **Step 1: Write the failing tests** in `backend-rs/tests/accounts.rs` (bearer token `h.token` throughout):

```rust
#[tokio::test] async fn adding_a_member_returns_them_without_the_password()
// POST /users {email:"Ana@Office.kz", name:"Ana", password:"correct horse"} → 201;
// body.user.email == "Ana@Office.kz", mustChangePassword == true, no "password"/"passwordHash" key.
#[tokio::test] async fn emails_are_unique_ignoring_case()
// second POST with "ana@office.kz" → 409, error == "email_taken".
#[tokio::test] async fn short_passwords_are_refused()
// password "123456789" (9) → 400 "weak_password"; 10 chars → 201.
#[tokio::test] async fn bad_emails_and_names_are_refused()
// "ana", "@x", "a@" → 400; name "" → 400.
#[tokio::test] async fn members_are_listed_and_editable()
// GET /users lists both by name with tokenCount 0; PATCH name → GET /users/{id} shows it; PATCH email to a taken one → 409.
#[tokio::test] async fn the_password_is_stored_hashed()
// SELECT password_hash FROM users → starts with "$2", != the password.
#[tokio::test] async fn a_starting_password_expires_after_seven_days()
// UPDATE users SET password_set_at = datetime('now','-8 days'); GET /users/{id} → startingPasswordExpired == true;
// with '-6 days' → false.
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path backend-rs/Cargo.toml --test accounts`
Expected: FAIL (404 on `/api/v1/users`).

- [ ] **Step 3: Implement** the migration, `accounts.rs` and `api/users.rs` per the interfaces; register routes.

- [ ] **Step 4: Run the new tests and the whole backend suite**

Run: `cargo test --manifest-path backend-rs/Cargo.toml`
Expected: all pass (314 before, plus 7).

- [ ] **Step 5: Document** the routes in `openapi.json` (a `User` schema; `email_taken`, `weak_password` in the error examples) and in `docs/api.md` (an "Accounts" section). `npx prettier --check backend-rs/src/api/openapi.json docs/api.md`.

- [ ] **Step 6: Commit**

```bash
git add backend-rs docs/api.md
git commit -m "feat(backend): member accounts with hashed passwords"
```

---

### Task 2: Sessions behind the cookie

**Files:**

- Create: `backend-rs/src/sessions.rs` (+ `pub mod sessions;`)
- Modify: `backend-rs/src/auth.rs` (verdict carries the token id; `Principal`, `Credential`, `Authed`; `require_token`), every `TokenVerdict::Operator` match (`src/api/auth.rs`, `src/api/provisioning.rs`, `src/api/status_pages.rs`, `tests/import.rs`, unit tests in `auth.rs`), `backend-rs/src/api/auth.rs` (`create_session` accepts `{email,password}` or `{token}`; `delete_session` ends the session; `me`), `backend-rs/src/api/stream.rs`, `backend-rs/src/api/openapi.json`, `docs/api.md`
- Test: `backend-rs/tests/session_cookie.rs` (update: the cookie value is now a session id), `backend-rs/tests/sessions.rs`

**Interfaces:**

- Consumes: `accounts::verify_password`, `accounts::get` (Task 1).
- Produces (`crate::auth`):
  - `TokenVerdict::Operator(i64)` — the token's row id.
  - `pub enum Principal { Account { user_id: i64, must_change_password: bool }, Token { token_id: i64 } }`
  - `pub enum Credential { Bearer(String), Session(String) }` with `pub fn stream_key(&self) -> String` (SHA-256 of the raw value).
  - `#[derive(Clone)] pub struct Authed { pub principal: Principal, pub credential: Credential }` — replaces part 1's `OperatorToken` as the request extension.
  - `pub async fn still_valid(pool, credential: &Credential) -> Result<bool, VerifyError>` (the stream's 15 s revalidation).
- Produces (`crate::sessions`):
  - `pub const ACCOUNT_SESSION_DAYS: i64 = 30; pub const TOKEN_SESSION_DAYS: i64 = 400;`
  - `pub enum SessionOwner { Account(i64), Token(i64) }`
  - `pub async fn create(pool, owner: SessionOwner) -> Result<String, sqlx::Error>` — returns `fls_` + 64 hex (32 random bytes); stores its SHA-256.
  - `pub async fn resolve(pool, raw: &str) -> Result<Option<Principal>, sqlx::Error>` — `None` when unknown, past its lifetime since `last_used_at`, or its token is inactive/expired/deleted; touches `last_used_at` at most once a minute.
  - `pub async fn end(pool, raw: &str)`, `pub async fn end_for_account(pool, user_id: i64, keep: Option<&str>)`.
- Produces (HTTP): `POST /api/v1/auth/session` with `{email, password}` → 200 `{ok, principal:"account", mustChangePassword}` + cookie; with `{token}` → 200 `{ok, principal:"token"}` + cookie (agent token and bad token answers unchanged). `DELETE /api/v1/auth/session` also deletes the server-side session. `GET /api/v1/auth/me` adds `principal` and `account: {id, email, name, mustChangePassword}` or `token: {id, name}`.

- [ ] **Step 1: Write the failing tests.** Update `session_cookie.rs`: the cookie value starts with `fls_`, never the token; `with_cookie` helpers take the cookie value from the sign-in response. New `tests/sessions.rs`:

```rust
#[tokio::test] async fn signing_in_with_email_and_password_sets_a_session()
// add member (bearer), POST /auth/session {email, password} → 200, principal == "account", Set-Cookie fl_session=fls_…;
// GET /auth/me with the cookie → principal "account", account.email.
#[tokio::test] async fn a_wrong_password_and_an_unknown_email_answer_alike()
// both → 401, same body.error "unauthorized", same body.message, no Set-Cookie.
#[tokio::test] async fn a_token_session_reports_its_token()
// POST /auth/session {token: h.token} → principal "token"; /auth/me → token.name == "admin".
#[tokio::test] async fn signing_out_ends_the_session_server_side()
// DELETE /auth/session with the cookie, then GET /monitors with the same cookie → 401.
#[tokio::test] async fn removing_an_account_ends_its_sessions()
// sign in as member; DELETE FROM users WHERE id = ? (direct SQL; Task 4 adds the route) → GET /monitors → 401.
#[tokio::test] async fn disabling_a_token_ends_sessions_made_with_it()
// mint key, sign in with it, PATCH active:false → 401; same for DELETE /api-keys/{id}.
#[tokio::test] async fn an_account_session_lapses_after_thirty_idle_days()
// UPDATE sessions SET last_used_at = datetime('now','-31 days') → 401; '-29 days' → 200 (and last_used_at moves to now).
#[tokio::test] async fn the_stream_drops_a_removed_account()
// open /events with an account cookie, delete the user, the next keepalive round yields {"type":"unauthorized"}
// (use tokio::time::pause/advance if the stream's ticker allows; otherwise assert still_valid() == false directly).
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path backend-rs/Cargo.toml --test sessions --test session_cookie`
Expected: FAIL (cookie still holds the token; email/password unsupported).

- [ ] **Step 3: Implement** per the interfaces. `require_token`: bearer → `verify_token` → `Authed { Token{token_id}, Bearer }`; cookie → `sessions::resolve` → `Authed { principal, Session }`; then the part 1 CSRF rule for the cookie source; insert `Authed`. The stream keys by `credential.stream_key()` and revalidates with `still_valid`. Update every `TokenVerdict::Operator` match to `Operator(_)`.

- [ ] **Step 4: Run the whole backend suite**

Run: `cargo test --manifest-path backend-rs/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Document** (`openapi.json` session body and `/auth/me`, `docs/api.md` browser-session paragraph: the cookie is a session id, lifetimes, what ends a session), then commit:

```bash
git add backend-rs docs/api.md
git commit -m "feat(backend): server-side sessions for accounts and tokens"
```

---

### Task 3: Password rules — change, must-change, rate limit, first account

**Files:**

- Modify: `backend-rs/src/accounts.rs` (rate limiter), `backend-rs/src/auth.rs` (must-change gate, `client_address`), `backend-rs/src/api/auth.rs` (`change_password`, `setup_status`, `setup`), `backend-rs/src/api/users.rs` (reset ends sessions), `backend-rs/src/api/mod.rs`, `openapi.json`, `docs/api.md`
- Test: `backend-rs/tests/passwords.rs`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces:
  - `crate::accounts::SignInLimiter` (in `AppState` or a `LazyLock` static, as `auth.rs` keeps its caches): `pub fn check(&self, email_key: &str, address: &str) -> Result<(), u64>` (seconds to wait), `pub fn record_failure(&self, email_key: &str, address: &str)`, `pub fn clear(&self, email_key: &str)`. Windows of 15 minutes; limits 5 per email, 20 per address.
  - `crate::auth::client_address(headers: &HeaderMap) -> String` — `cf-connecting-ip`, else the first `x-forwarded-for`, else `"unknown"`.
  - Must-change gate in `require_token`: `Principal::Account { must_change_password: true }` may only reach `GET /api/v1/auth/me`, `POST /api/v1/auth/password` (and the public `DELETE /auth/session`); anything else → 403 `password_change_required` with a hint naming `POST /api/v1/auth/password`.
  - `POST /api/v1/auth/password` `{currentPassword, newPassword}` — account sessions only (a bearer or token session → 400 `not_an_account`); wrong current → 401 `unauthorized`; weak new → 400 `weak_password`; success clears must-change, ends the account's other sessions (`end_for_account(.., keep = current)`) → `{ok:true}`.
  - Sign-in: a correct password whose starting password expired → 401 `starting_password_expired` (message "Ask someone to reset your password."), checked only after the password matched.
  - `POST /users/{id}/reset-password` sets must-change and ends all of that account's sessions.
  - `GET /api/v1/auth/setup` → `{ok, setupNeeded}` (true when no account exists). `POST /api/v1/auth/setup` `{token, email, name, password}` (public, beside login) — 409 `setup_done` when any account exists; the token must be a valid operator token (else 401, agent token → `agent_token_on_operator_api`); creates the account without must-change and signs it in (cookie). Any operator token qualifies, not only the first-boot one (writer's call: every operator token has the same authority).

- [ ] **Step 1: Write the failing tests** in `tests/passwords.rs`:

```rust
#[tokio::test] async fn a_starting_password_only_opens_the_change_password_door()
// member signs in → GET /auth/me 200 (mustChangePassword true); GET /monitors 403 "password_change_required";
// POST /monitors with CSRF header 403; GET /events 403.
#[tokio::test] async fn changing_the_password_lifts_the_gate_and_ends_other_sessions()
// two sessions A, B; A: POST /auth/password {currentPassword, newPassword} (CSRF) → 200; A: GET /monitors 200; B: 401.
#[tokio::test] async fn changing_needs_the_current_password_and_a_long_new_one()
// wrong current → 401; new "short" → 400 "weak_password".
#[tokio::test] async fn a_bearer_token_has_no_password_to_change()
// POST /auth/password with bearer → 400 "not_an_account".
#[tokio::test] async fn resetting_a_password_ends_sessions()
// member changes password (gate lifted), bearer POST /users/{id}/reset-password {password: "another start pw"};
// the member's cookie → 401; signing in again → mustChangePassword true.
#[tokio::test] async fn an_expired_starting_password_is_refused_with_a_reason()
// UPDATE users SET password_set_at = datetime('now','-8 days') → sign-in with the right password → 401 "starting_password_expired";
// the wrong password → 401 "unauthorized".
#[tokio::test] async fn the_sixth_failure_for_an_email_is_throttled()
// five wrong passwords → 401 each; sixth attempt with the RIGHT password → 429 "rate_limited", body.retryAfter > 0.
#[tokio::test] async fn one_address_is_throttled_across_emails()
// 20 failures across 20 unknown emails from cf-connecting-ip 203.0.113.9 → the 21st → 429; another address → 401.
#[tokio::test] async fn the_first_account_needs_an_operator_token()
// GET /auth/setup → setupNeeded true; POST /auth/setup without token → 401; with h.token → 200 + cookie, account has mustChangePassword false;
// GET /auth/setup → false; a second POST /auth/setup with h.token → 409 "setup_done".
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path backend-rs/Cargo.toml --test passwords`
Expected: FAIL.

- [ ] **Step 3: Implement** per the interfaces.

- [ ] **Step 4: Run the whole backend suite**

Run: `cargo test --manifest-path backend-rs/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Document and commit**

```bash
git add backend-rs docs/api.md
git commit -m "feat(backend): password changes, sign-in limits and the first account"
```

---

### Task 4: Tokens remember their maker; removing a member

**Files:**

- Modify: `backend-rs/src/api/api_keys.rs` (record maker on mint; list reports it), `backend-rs/src/device.rs` (`approve` carries the approver), `backend-rs/src/api/device.rs` (approve passes the principal; poll inserts the maker), `backend-rs/src/api/users.rs` (`DELETE`), `openapi.json`, `docs/api.md`
- Test: `backend-rs/tests/token_makers.rs`

**Interfaces:**

- Consumes: `Authed`/`Principal` (Task 2), accounts (Task 1).
- Produces:
  - Tokens minted by an account session (`POST /api-keys`, or a QR approval made by an account) store `maker_user_id` and `maker_name`; minted by a bearer token or a token session → both NULL.
  - `GET /api/v1/api-keys` adds `maker: {id: number | null, name: string, removed: boolean} | null` per key.
  - `devices.approve(code, name, maker: Option<(i64, String)>)`; `State::Approved` keeps the maker until the poll mints.
  - `DELETE /api/v1/users/{id}` `{revokeTokenIds?: number[]}` — 409 `cannot_remove_self` when the caller's own account; every id must be a token that user made (else 400); revokes those (`active = 0`), deletes the account (its sessions cascade) → `{ok, revokedTokens: n}`.

- [ ] **Step 1: Write the failing tests** in `tests/token_makers.rs`:

```rust
#[tokio::test] async fn a_token_minted_by_a_member_names_them()
// member (password changed) mints via cookie+CSRF POST /api-keys → GET /api-keys shows maker {id, name:"Ana", removed:false};
// a key minted with the bearer token → maker null.
#[tokio::test] async fn a_screen_paired_by_a_member_names_them()
// device start → member lookup/approve via cookie → poll → the new token's maker is the member.
#[tokio::test] async fn removing_a_member_revokes_the_tokens_chosen()
// member made keys K1, K2; bearer DELETE /users/{id} {revokeTokenIds:[K1]} → 200 revokedTokens 1;
// K1 disabled (bearer GET with K1 → 401); K2 still works; GET /api-keys shows K2 maker {id:null, name:"Ana", removed:true}.
#[tokio::test] async fn only_their_own_tokens_can_be_revoked_with_them()
// revokeTokenIds containing the admin token's id → 400, nothing deleted.
#[tokio::test] async fn nobody_removes_their_own_account()
// member's cookie DELETE /users/{own id} (CSRF) → 409 "cannot_remove_self".
#[tokio::test] async fn removing_the_last_account_is_allowed()
// one account, bearer DELETE → 200; GET /auth/setup → setupNeeded true; bearer requests still work.
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path backend-rs/Cargo.toml --test token_makers`
Expected: FAIL.

- [ ] **Step 3: Implement** per the interfaces.

- [ ] **Step 4: Run the whole backend suite and clippy**

Run: `cargo test --manifest-path backend-rs/Cargo.toml && cargo clippy --manifest-path backend-rs/Cargo.toml --all-targets`
Expected: all pass, no warnings.

- [ ] **Step 5: Update `AGENTS.md`** ("One credential type" → accounts and operator tokens are both full-permission operator credentials; push and backup-agent tokens unchanged), `docs/api.md`, `docs/architecture.md` (credentials section, `accounts.rs`/`sessions.rs` rows). Commit:

```bash
git add backend-rs AGENTS.md docs
git commit -m "feat(backend): tokens remember who made them; remove members"
```

---

### Task 5: Web sign-in, change password and the signed-in person

**Files:**

- Create: `apps/web/lib/me.ts`, `apps/web/lib/password.ts`, `apps/web/app/account/password/page.tsx`, `apps/web/components/change-password-form.tsx`
- Modify: `apps/web/lib/api.ts` (server 403 `password_change_required` → `/account/password`), `apps/web/lib/auth-server.ts` (`requireOperator(): Promise<Me>`), `apps/web/lib/legacy-token.ts` (`createSession` sends `{token}` unchanged), `apps/web/components/sign-in-form.tsx`, `apps/web/app/sign-in/page.tsx`, `apps/web/app/(admin)/layout.tsx`, `apps/web/components/app-sidebar.tsx`, `apps/web/lib/session.ts` (`PASSWORD_PATH = "/account/password"`), `apps/web/lib/gate.ts` (let `/account/password` through like any signed-in page)
- Test: `apps/web/__tests__/me.test.ts`, `apps/web/__tests__/password.test.ts`, `apps/web/__tests__/api-server.test.ts` (add a case)

**Interfaces:**

- Consumes: HTTP from Tasks 2–3.
- Produces:
  - `@/lib/me`: `type Me = { principal: "account"; account: { id: number; email: string; name: string; mustChangePassword: boolean } } | { principal: "token"; token: { id: number; name: string } }`; `displayName(me: Me): string` (account name, else `token.name`, else `"Operator"`); `initials(name: string): string` (first letters of the first two words, upper-case, `"?"` when empty).
  - `@/lib/password`: `MIN_PASSWORD_CHARS = 10`; `passwordProblem(password: string, confirm: string): string | null` → `"Use at least 10 characters."` / `"The passwords do not match."` / `null`.
  - `requireOperator(): Promise<Me>` — redirects an account with `mustChangePassword` to `/account/password`.
  - Sign-in form modes `"password" | "token" | "setup"`: password mode (email, password) is the default; "Use a token instead" switches to token mode and back; when `GET /api/v1/auth/setup` says `setupNeeded`, a "Create the first account" link opens setup mode (operator token, name, email, password, confirm). A `mustChangePassword` answer goes to `/account/password`, otherwise to `safeNext(next)`.
  - `/account/password` page (signed-in, outside the admin layout, centred like sign-in): current password, new, confirm; on success → `/monitors`. When reached because of a starting password it says "Choose your own password to continue."
  - Sidebar footer shows `initials` + `displayName(me)`; menu: **Change password** (accounts only) and **Sign out**. The admin layout passes `me` to `AppSidebar`.

- [ ] **Step 1: Write the failing tests**

```ts
// me.test.ts
expect(
  displayName({
    principal: "account",
    account: { id: 1, email: "a@x.kz", name: "Ana Bek", mustChangePassword: false },
  })
).toBe("Ana Bek");
expect(displayName({ principal: "token", token: { id: 3, name: "Wall TV" } })).toBe("Wall TV");
expect(initials("Ana Bek")).toBe("AB");
expect(initials("ana")).toBe("A");
expect(initials("  ")).toBe("?");

// password.test.ts
expect(passwordProblem("123456789", "123456789")).toBe("Use at least 10 characters.");
expect(passwordProblem("correct horse", "correct hors")).toBe("The passwords do not match.");
expect(passwordProblem("correct horse", "correct horse")).toBeNull();

// api-server.test.ts (new case)
// fetch → 403 {error:"password_change_required"} on the server → redirect("/account/password")
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:web`
Expected: FAIL (modules missing; the 403 case not redirected).

- [ ] **Step 3: Implement** per the interfaces.

- [ ] **Step 4: Run checks**

Run: `npm run test:web && npm run typecheck:web && npm run build:web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): email and password sign-in"
```

---

### Task 6: Members page, end-to-end check, docs

**Files:**

- Create: `apps/web/app/(admin)/members/page.tsx`, `apps/web/components/members/members-list.tsx`, `apps/web/components/members/add-member-dialog.tsx`, `apps/web/components/members/reset-password-dialog.tsx`, `apps/web/components/members/remove-member-dialog.tsx`, `apps/web/lib/members.ts`, shadcn `dialog`, `checkbox`, `badge` under `components/ui/`
- Modify: `apps/web/lib/nav.ts` (Members after Tokens, icon `Users`, href `/members`), `apps/web/__tests__/nav.test.ts`, `docs/development.md` (web app section: accounts), `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md` IA table (add Members)
- Test: `apps/web/__tests__/members.test.ts`

**Interfaces:**

- Consumes: Tasks 1, 3, 4 (HTTP), Task 5 (`Me`, `passwordProblem`).
- Produces:
  - `@/lib/members`: `interface Member { id: number; email: string; name: string; mustChangePassword: boolean; startingPasswordExpired: boolean; createdAt: string; tokenCount: number }`; `interface MemberToken { id: number; name: string; active: boolean }`; `memberStatus(m: Member): "active" | "awaiting-first-sign-in" | "needs-reset"`; `removalWarning(members: Member[], removingId: number): string | null` → `"This is the last account. Signing in will need a token until someone adds an account."` when it is the only one, else `null`.
  - Members page: `PageHeader` crumb "Members" with an **Add member** button; one dense row per member (initials, name, email, status pill from `memberStatus`, a `⋯` menu with Reset password and Remove; Remove hidden on your own row). Add: name, email, starting password + confirm (`passwordProblem`). Reset: new starting password + confirm. Remove: loads `GET /users/{id}`, lists their active tokens with checkboxes all ticked, shows `removalWarning`, then `DELETE` with the ticked ids. Every change refreshes the list (`router.refresh()`).

- [ ] **Step 1: Write the failing tests**

```ts
// members.test.ts
const base = {
  id: 1,
  email: "a@x.kz",
  name: "Ana",
  createdAt: "2026-10-28 10:00:00",
  tokenCount: 0,
};
expect(memberStatus({ ...base, mustChangePassword: false, startingPasswordExpired: false })).toBe(
  "active"
);
expect(memberStatus({ ...base, mustChangePassword: true, startingPasswordExpired: false })).toBe(
  "awaiting-first-sign-in"
);
expect(memberStatus({ ...base, mustChangePassword: true, startingPasswordExpired: true })).toBe(
  "needs-reset"
);
expect(
  removalWarning([{ ...base, mustChangePassword: false, startingPasswordExpired: false }], 1)
).toMatch(/last account/);
expect(removalWarning([{ ...base, id: 1 } as never, { ...base, id: 2 } as never], 1)).toBeNull();
// nav.test.ts: the expected list gains ["members", "Members", "/members"] after tokens, before superboard.
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:web`
Expected: FAIL.

- [ ] **Step 3: Implement** per the interfaces (`npx shadcn@latest add dialog checkbox badge`; repoint any `cn` import to `@/lib/utils` and drop an unrelated `cn` package if the CLI adds one, as in part 1).

- [ ] **Step 4: End-to-end check** on `./dev.sh` with headless Chromium (playwright-core under `/tmp/flatline-shot`):

1. Token sign-in (dev admin token, never printed) → Members → add "Ana" with a starting password → listed as awaiting first sign-in.
2. New context: sign in as Ana → lands on Change password; `/monitors` sends back there; change it → `/monitors`, sidebar shows "Ana".
3. As Ana, Members: her own row has no Remove.
4. Back as the token: reset Ana's password → Ana's open page, on reload, is at sign-in.
5. Ana (after a new change) mints a token via the API with her cookie; removing Ana lists that token ticked; remove → the token is disabled.
6. Wrong password six times for one email → the form shows the wait message.
   Screenshots of sign-in, change password and Members.

- [ ] **Step 5: Run every check**

Run: `cargo test --manifest-path backend-rs/Cargo.toml && npm run test:web && npm run typecheck:web && npm run build:web && npm run test:dashboard && npm run typecheck:dashboard && npm run fmt:check`
Expected: all pass; Prettier lists only the four pre-existing files.

- [ ] **Step 6: Commit**

```bash
git add apps/web docs
git commit -m "feat(web): Members section"
```
