# Admin panel, part 1: foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js app in `apps/web` with the Flatline theme, a Plane-style sidebar shell with placeholder sections, and cookie-based sign-in backed by the Rust API, including the silent migration of an old `localStorage` token.

**Architecture:** The Rust backend learns a second way to receive the operator token: an `HttpOnly` cookie `fl_session`, set by a new `POST /api/v1/auth/session` and cleared by `DELETE`. Cookie-authenticated writes must carry `X-Flatline-CSRF: 1`. The Next app (App Router, SSR) reads the cookie on the server and calls the API with it as a bearer token; in the browser it calls same-origin `/api/...` and lets the cookie ride along. Nothing old is removed in this part: the Vite dashboard keeps running (moved to port 3004 in dev) until part 6.

**Tech Stack:** Rust (axum, sqlx), Next.js 16.4 App Router, React 19.3, Tailwind CSS 4, shadcn/ui (new-york style, Radix), lucide-react, `@fontsource-variable/inter`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`. This is part 1 of 6 ("Order of work", step 1). Parts 2–6 get their own plans after this one lands.

## Global Constraints

- Versions match Kore: `next` `16.4.2`, `react`/`react-dom` `19.3.0`, `tailwindcss` `^4`, TypeScript `^5`.
- No external loads: fonts, icons and scripts are bundled. No `next/font/google`, no CDN.
- Brand tokens (dark only): bg `#16181d`, surface `#1d2026`, raised `#23262d`, border `#2c3038`, border-strong `#3a3f49`, text `#e6e8ee`, muted `#8a8f9a`, accent `#5b8def`, accent-hover `#7aa3f2`.
- Status colours, separate from the brand: up `#3fb950`, warn `#f0c54b`, down `#e5484d`, muted-down `#8a3a3d`, maintenance `#a371f7` (violet; writer's call, the spec only requires "off blue").
- Radius 6 px; focus ring 2 px accent, 2 px offset; motion off under `prefers-reduced-motion`.
- Cookie: name `fl_session`, value = the operator token, `Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days, the browser maximum), plus `Secure` when the request arrived over HTTPS. **Lax, not the spec's Strict** (writer's call): with Strict, a link opened from Telegram would land on the sign-in page while signed in. The CSRF header below protects writes.
- CSRF: a request authenticated by the cookie (no `Authorization` header) with a method other than GET/HEAD/OPTIONS must carry `X-Flatline-CSRF: 1`, else `403 {ok:false, error:"csrf_required"}`. Bearer requests are unchanged.
- Old browser storage key: `flatline.token` (`apps/dashboard/src/lib/api.ts:13`).
- Repo rules (`AGENTS.md`): docs change in the same commit as behaviour; API routes in `backend-rs/src/api/openapi.json`; commit subjects `type(scope): summary`; no emoji; Prettier (repo config, 4-space indent, width 120) covers `apps/web`; never push or deploy without the operator's go-ahead.

## Review Focus

1. **A revoked token still in the cookie.** The API answers 401; the app must land on `/sign-in?expired=1` and stay there (no redirect loop between the gate and the sign-in page). Tests: Task 1 (cookie with revoked token → 401), Task 3 (`gate` with `expired` and a cookie → no redirect).
2. **A forged write from another site.** A cookie-only POST/PATCH/DELETE without the CSRF header is refused; the same request with a bearer token is not. Test: Task 1.
3. **An open redirect through `next`.** `//evil.example`, `https://evil.example`, `/\evil`, `javascript:` all fall back to `/monitors`. Test: Task 3.
4. **The wall TV's old token is revoked or the API is down during migration.** Revoked → the key is deleted and the sign-in form shows; network/5xx → the key is kept for the next visit and the form shows. Never a loop. Test: Task 4.
5. **An agent token pasted at sign-in.** The backend's explicit `agent_token_on_operator_api` error reaches the form as its message, not "invalid token". Tests: Task 1 (session route returns that error), Task 4 (form shows the API message).

---

### Task 1: Backend cookie session

**Files:**

- Modify: `backend-rs/src/auth.rs` (token extraction, cookie helpers, `require_token`)
- Modify: `backend-rs/src/api/auth.rs` (two handlers)
- Modify: `backend-rs/src/api/mod.rs:143-148` (routes in the `public` router, beside `auth/login`, so they share its limits)
- Modify: `backend-rs/src/api/stream.rs:31-38` (read the token from the request extension)
- Modify: `backend-rs/src/api/openapi.json` (document both routes, the cookie as a second security scheme, `csrf_required`)
- Modify: `docs/api.md` (auth section: cookie session and CSRF), `docs/architecture.md` if it describes auth
- Test: `backend-rs/tests/session_cookie.rs`

**Interfaces:**

- Produces (Rust, `crate::auth`):
  - `pub const SESSION_COOKIE: &str = "fl_session";`
  - `pub const CSRF_HEADER: &str = "x-flatline-csrf";`
  - `pub const SESSION_MAX_AGE: i64 = 34_560_000;`
  - `pub enum TokenSource { Bearer, Cookie }`
  - `pub fn request_token(headers: &HeaderMap) -> Option<(String, TokenSource)>` — bearer first, else the `fl_session` cookie (reuse `status_pages::parse_cookies`).
  - `#[derive(Clone)] pub struct OperatorToken(pub String);` — inserted into request extensions by `require_token` after a successful check.
  - `pub fn session_cookie(token: &str, secure: bool) -> String` and `pub fn clear_session_cookie(secure: bool) -> String` (`Max-Age=0`, empty value, same attributes).
  - `pub fn request_is_https(headers: &HeaderMap) -> bool` — `x-forwarded-proto` equals `https` (first value, case-insensitive).
- Produces (HTTP):
  - `POST /api/v1/auth/session` body `{"token": "<operator token>"}` → `200 {ok:true, tokenKind:"operator"}` + `Set-Cookie`. Invalid → the same 401 body `login` returns; agent token → `agent_token_on_operator_api`; store failure → 503. Never sets a cookie on failure.
  - `DELETE /api/v1/auth/session` → `200 {ok:true}` + clearing `Set-Cookie`. Public (works with a missing or revoked cookie).

- [ ] **Step 1: Write the failing tests** in `backend-rs/tests/session_cookie.rs`, using `tests/common` (`harness`, `request`, `send`). Build cookie requests by adding `cookie: fl_session=<token>` to a `request(..., None, ...)`.

```rust
#[tokio::test] async fn session_sets_an_httponly_lax_cookie()
// POST /api/v1/auth/session {"token": h.token} → 200, body.ok == true,
// Set-Cookie starts with "fl_session=<h.token>;" and contains "HttpOnly",
// "SameSite=Lax", "Path=/", "Max-Age=34560000", and NOT "Secure".

#[tokio::test] async fn session_cookie_is_secure_behind_https()
// same POST with header x-forwarded-proto: https → Set-Cookie contains "Secure".

#[tokio::test] async fn session_refuses_a_bad_token_without_a_cookie()
// {"token":"flatline_op_nope"} → 401, body.error == "unauthorized", no Set-Cookie header.

#[tokio::test] async fn session_refuses_an_agent_token_explicitly()
// create a push monitor (or reuse a helper that mints a push token), POST its push token
// → 401, body.error == "agent_token_on_operator_api", no Set-Cookie.

#[tokio::test] async fn the_cookie_authenticates_reads()
// GET /api/v1/monitors with only the cookie → 200.

#[tokio::test] async fn a_revoked_token_in_the_cookie_is_refused()
// mint a second operator token via POST /api/v1/api-keys, disable it (PATCH active:false),
// GET /api/v1/monitors with that cookie → 401.

#[tokio::test] async fn cookie_writes_need_the_csrf_header()
// POST /api/v1/monitors (valid group body) with only the cookie → 403, body.error == "csrf_required";
// the same with header x-flatline-csrf: 1 → 200/201;
// the same with the bearer token and no CSRF header → 200/201.

#[tokio::test] async fn the_event_stream_accepts_the_cookie()
// GET /api/v1/events with only the cookie → 200 and next_sse_data(..) yields a frame.

#[tokio::test] async fn deleting_the_session_clears_the_cookie()
// DELETE /api/v1/auth/session with no credentials → 200, Set-Cookie starts with "fl_session=;"
// and contains "Max-Age=0".
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path backend-rs/Cargo.toml --test session_cookie`
Expected: FAIL (404 on `/api/v1/auth/session`, 401 on cookie-only reads).

- [ ] **Step 3: Implement** the `crate::auth` items above. In `require_token`: use `request_token`; on `Operator` insert `OperatorToken(token)` into the request extensions; when the source is `Cookie` and the method is not GET/HEAD/OPTIONS and the `x-flatline-csrf` header is not exactly `1`, answer `403` via `ApiError::new(StatusCode::FORBIDDEN, "csrf_required", "Cookie-authenticated writes must send X-Flatline-CSRF: 1.")` with a `hint` naming the header. `stream::events` takes `Extension(OperatorToken(token))` instead of re-reading `Authorization`. Handlers `create_session` / `delete_session` in `api/auth.rs` reuse `login`'s verification and error shapes.

- [ ] **Step 4: Run the new tests and the whole backend suite**

Run: `cargo test --manifest-path backend-rs/Cargo.toml`
Expected: all pass (305 before this task, plus 9).

- [ ] **Step 5: Document** both routes and the cookie in `openapi.json` (add `cookieAuth` `{type:"apiKey", in:"cookie", name:"fl_session"}` to `securitySchemes`, `csrf_required` to the error list) and in `docs/api.md`. Run `cargo test --manifest-path backend-rs/Cargo.toml openapi` (the existing openapi tests parse it) and `npx prettier --check backend-rs/src/api/openapi.json docs/api.md`.

- [ ] **Step 6: Commit**

```bash
git add backend-rs docs/api.md docs/architecture.md
git commit -m "feat(backend): cookie session for the web app"
```

---

### Task 2: Next app skeleton, theme and checks

**Files:**

- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/vitest.config.mts`, `apps/web/components.json`, `apps/web/.gitignore`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/icon.svg` (copy of `apps/dashboard/public/favicon.svg`), `apps/web/lib/utils.ts` (shadcn `cn`), `apps/web/components/ui/*` (shadcn: `button`, `input`, `label`, `separator`, `tooltip`, `dropdown-menu`, `sheet`, `skeleton`, `sidebar`)
- Create: `apps/web/__tests__/theme.test.ts`
- Modify: root `package.json` (scripts), `.prettierignore` (`apps/web/.next`, `apps/web/next-env.d.ts`), `AGENTS.md` (layout row for `apps/web`, checks row "Web app"), `docs/development.md`

**Interfaces:**

- Produces: the `@/` alias rooted at `apps/web/`; `cn(...)` in `@/lib/utils`; shadcn components under `@/components/ui/*`; Tailwind colour utilities named after the tokens (`bg-surface`, `text-muted-foreground`, `bg-primary`, `text-status-down`, …) — see the mapping below; root scripts `test:web`, `typecheck:web`, `build:web`.

- [ ] **Step 1: Scaffold.** `package.json` dependencies: `next@16.4.2`, `react@19.3.0`, `react-dom@19.3.0`, `lucide-react`, `@fontsource-variable/inter`, `@flatline/shared` (`file:../../packages/shared`), plus what `npx shadcn@latest init` adds (Radix packages, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`). Dev: `tailwindcss@^4`, `@tailwindcss/postcss`, `typescript@^5`, `@types/*`, `vitest`. Scripts as Kore: `dev`, `build`, `start`, `test` (`vitest run`), `typecheck` (`tsc --noEmit`). `next.config.ts`: `output: "standalone"`, `poweredByHeader: false`, rewrites `/api/:path*` and `/agent/:path*` to `${API_URL}` (default `http://127.0.0.1:3001`), as Kore's. Run `npx shadcn@latest init` (style new-york, base neutral, CSS variables on) then `npx shadcn@latest add button input label separator tooltip dropdown-menu sheet skeleton sidebar`.

- [ ] **Step 2: Write the failing theme test** `__tests__/theme.test.ts`: read `app/globals.css` as text and assert each of these declarations appears inside the `:root` block (whitespace-insensitive):

```ts
const expected = {
  "--background": "#16181d",
  "--foreground": "#e6e8ee",
  "--card": "#1d2026",
  "--popover": "#23262d",
  "--primary": "#5b8def",
  "--primary-foreground": "#ffffff",
  "--secondary": "#23262d",
  "--muted": "#1d2026",
  "--muted-foreground": "#8a8f9a",
  "--accent": "#23262d",
  "--accent-foreground": "#e6e8ee", // shadcn "accent" = hover surface, not the brand
  "--border": "#2c3038",
  "--input": "#2c3038",
  "--ring": "#5b8def",
  "--sidebar": "#1d2026",
  "--sidebar-primary": "#5b8def",
  "--sidebar-accent": "#23262d",
  "--sidebar-border": "#2c3038",
  "--sidebar-ring": "#5b8def",
  "--radius": "0.375rem",
  "--status-up": "#3fb950",
  "--status-warn": "#f0c54b",
  "--status-down": "#e5484d",
  "--status-muted": "#8a3a3d",
  "--status-maint": "#a371f7",
  "--surface": "#1d2026",
  "--raised": "#23262d",
  "--border-strong": "#3a3f49",
  "--accent-hover": "#7aa3f2",
};
```

Also assert `globals.css` contains no `http://` or `https://` (no external loads) and that `app/layout.tsx` imports `@fontsource-variable/inter`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm --prefix apps/web test`
Expected: FAIL on the shadcn defaults (oklch values).

- [ ] **Step 4: Theme.** Replace shadcn's generated `:root`/`.dark` variables with the values above (dark only: `color-scheme: dark`, no `.dark` block); expose `--status-*`, `--surface`, `--raised`, `--border-strong`, `--accent-hover` through `@theme inline` as colours. Font: `--font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`; mono stack as Kore's. Base: 14 px body, antialiased, `font-feature-settings: "cv11", "ss01"`; `:focus-visible` 2 px `--ring` outline, 2 px offset; a `prefers-reduced-motion: reduce` block that sets animation and transition durations to `0.01ms`. `app/layout.tsx`: imports the font package and `globals.css`, `<html lang="en">`, metadata title `Flatline`, `robots: { index: false, follow: false }`.

- [ ] **Step 5: Run the checks**

Run: `npm --prefix apps/web test && npm --prefix apps/web run typecheck && npm --prefix apps/web run build && npm run fmt:check`
Expected: tests pass, typecheck clean, build succeeds, Prettier reports only the four files already failing on master (`apps/dashboard/src/App.tsx`, `apps/dashboard/src/components/DeviceApprove.tsx`, `apps/dashboard/test/device-auth.test.mjs`, `docs/superpowers/plans/2026-10-21-qr-sign-in.md`).

- [ ] **Step 6: Root scripts and docs.** Root `package.json`: `"test:web": "npm --prefix apps/web test"`, `"typecheck:web": "npm --prefix apps/web run typecheck"`, `"build:web": "npm --prefix apps/web run build"`. `AGENTS.md`: layout row `apps/web/` "Next.js admin panel (replaces `apps/dashboard/` during the rewrite)"; checks row "Web app: `npm run test:web && npm run typecheck:web`". `docs/development.md`: a short "Web app (in progress)" section.

- [ ] **Step 7: Commit**

```bash
git add apps/web package.json .prettierignore AGENTS.md docs/development.md
git commit -m "feat(web): Next.js app with the Flatline theme"
```

---

### Task 3: API client, auth gate and safe redirects

**Files:**

- Create: `apps/web/lib/session.ts`, `apps/web/lib/safe-next.ts`, `apps/web/lib/api.ts`, `apps/web/lib/gate.ts`, `apps/web/lib/auth-server.ts`, `apps/web/proxy.ts`
- Test: `apps/web/__tests__/safe-next.test.ts`, `apps/web/__tests__/api.test.ts`, `apps/web/__tests__/gate.test.ts`

**Interfaces:**

- Produces:
  - `@/lib/session`: `SESSION_COOKIE = "fl_session"`, `CSRF_HEADER = "X-Flatline-CSRF"`, `LEGACY_TOKEN_KEY = "flatline.token"`, `HOME_PATH = "/monitors"`, `SIGN_IN_PATH = "/sign-in"`, `PATH_HEADER = "x-flatline-path"` (set by `proxy.ts` on every passed request to `pathname + search`, read by server layouts).
  - `@/lib/safe-next`: `safeNext(raw: string | null | undefined): string` — returns `raw` only when it starts with a single `/` and contains no `\`, no `//` prefix, no scheme; otherwise `HOME_PATH`; never returns a path under `/sign-in`.
  - `@/lib/api`: `class ApiError extends Error { status: number; code: string; hint?: string }` (message = the API's `message`); `requestInit(opts: { server: boolean; token?: string; method?: string; body?: unknown }): RequestInit` (pure); `api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>` — server side uses `process.env.API_URL ?? "http://127.0.0.1:3001"` and the cookie token from `next/headers` (lazy import, as Kore's `lib/api.ts`), browser side uses the relative path; non-2xx throws `ApiError`; a network failure throws `ApiError(503, "unreachable")`.
  - `@/lib/gate`: `type GateResult = { kind: "next" } | { kind: "redirect"; to: string }`; `gate(pathname: string, search: string, hasSession: boolean): GateResult`.
  - `@/lib/auth-server`: `requireOperator(path: string): Promise<void>` (server only) — `GET /api/v1/auth/me`; on `ApiError` 401 → `redirect("/sign-in?expired=1&next=" + encodeURIComponent(path))`; other errors rethrow.
  - `proxy.ts` (Next 16 proxy): applies `gate`, matcher excludes `/api/`, `/agent/`, `/_next/`, `/icon.svg`, `/favicon.ico`, `/robots.txt`.

- [ ] **Step 1: Write the failing tests**

```ts
// safe-next.test.ts
expect(safeNext("/monitors/12?x=1")).toBe("/monitors/12?x=1");
for (const bad of [
  null,
  undefined,
  "",
  "monitors",
  "//evil.example",
  "https://evil.example",
  "/\\evil.example",
  "javascript:alert(1)",
  "/sign-in",
  "/sign-in?next=/x",
])
  expect(safeNext(bad)).toBe("/monitors");

// api.test.ts
expect(requestInit({ server: true, token: "flatline_op_x", method: "GET" }).headers).toMatchObject({
  Authorization: "Bearer flatline_op_x",
});
const browserPost = requestInit({ server: false, method: "POST", body: { a: 1 } });
expect(browserPost.credentials).toBe("same-origin");
expect(browserPost.headers).toMatchObject({
  "X-Flatline-CSRF": "1",
  "Content-Type": "application/json",
});
expect(browserPost.body).toBe('{"a":1}');
expect(requestInit({ server: false, method: "GET" }).headers).not.toHaveProperty("X-Flatline-CSRF");
expect(requestInit({ server: true, method: "POST" }).headers).not.toHaveProperty("X-Flatline-CSRF");

// gate.test.ts
expect(gate("/monitors", "?status=down", false)).toEqual({
  kind: "redirect",
  to: "/sign-in?next=%2Fmonitors%3Fstatus%3Ddown",
});
expect(gate("/monitors", "", true)).toEqual({ kind: "next" });
expect(gate("/sign-in", "?next=%2Fservers", true)).toEqual({ kind: "redirect", to: "/servers" });
expect(gate("/sign-in", "?expired=1&next=%2Fservers", true)).toEqual({ kind: "next" }); // no loop
expect(gate("/sign-in", "", false)).toEqual({ kind: "next" });
expect(gate("/", "", true)).toEqual({ kind: "redirect", to: "/monitors" });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm --prefix apps/web test`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the modules with the signatures above. `proxy.ts` turns a `redirect` result into `NextResponse.redirect(new URL(to, req.url))`.

- [ ] **Step 4: Run the tests**

Run: `npm --prefix apps/web test && npm --prefix apps/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): API client and sign-in gate"
```

---

### Task 4: Sign-in page and old-token migration

**Files:**

- Create: `apps/web/lib/legacy-token.ts`, `apps/web/app/sign-in/page.tsx`, `apps/web/components/sign-in-form.tsx`
- Test: `apps/web/__tests__/legacy-token.test.ts`, `apps/web/__tests__/sign-in-message.test.ts`

**Interfaces:**

- Consumes: `api`, `ApiError` (Task 3); `LEGACY_TOKEN_KEY`, `safeNext` (Task 3).
- Produces:
  - `type SessionResult = "ok" | "rejected" | "error"`
  - `createSession(token: string): Promise<SessionResult>` — `POST /api/v1/auth/session`; 2xx → ok; 401 → rejected; anything else → error.
  - `migrateLegacyToken(deps: { storage: Pick<Storage, "getItem" | "removeItem">; createSession: (token: string) => Promise<SessionResult> }): Promise<"migrated" | "none" | "rejected" | "error">` — reads `flatline.token`; none → `"none"`; ok → removes the key, `"migrated"`; rejected → removes the key, `"rejected"`; error → keeps the key, `"error"`. A throwing `storage` counts as `"none"`.
  - `signInMessage(error: unknown): string` — an `ApiError` with a `message` returns it verbatim (this carries the agent-token explanation); anything else returns `"Could not reach Flatline. Try again."`.

- [ ] **Step 1: Write the failing tests**

```ts
// legacy-token.test.ts (fake storage: a Map with getItem/removeItem; createSession: vi.fn)
// no key → "none", createSession not called
// key + ok → "migrated", key removed, createSession called with the stored token
// key + rejected → "rejected", key removed
// key + error → "error", key kept
// storage.getItem throws → "none"

// sign-in-message.test.ts
expect(
  signInMessage(new ApiError(401, "agent_token_on_operator_api", "That is a host-agent token…"))
).toBe("That is a host-agent token…");
expect(signInMessage(new TypeError("fetch failed"))).toBe("Could not reach Flatline. Try again.");
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm --prefix apps/web test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `lib/legacy-token.ts`, then the page. `app/sign-in/page.tsx` (server) reads `next` and `expired` from `searchParams` and renders the form; when `expired` is set it shows "Your session ended. Sign in again." `components/sign-in-form.tsx` (client): on mount runs `migrateLegacyToken({ storage: window.localStorage, createSession })` once, showing nothing but a quiet "Signing in…" while it runs; `"migrated"` → `router.replace(safeNext(next))`; otherwise the form: the Flatline mark, a password-type `Input` labelled "Operator token", a primary `Button` "Sign in", and the error from `signInMessage` under the field. Submitting calls `createSession`; on ok → `router.replace(safeNext(next))` and `router.refresh()`. Copy note under the field: "Paste a `flatline_op_` token. Signing in with a QR code from a screen comes with the kiosk." (QR sign-in is ported in part 4.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npm --prefix apps/web test && npm --prefix apps/web run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): sign-in page and silent migration of old tokens"
```

---

### Task 5: Admin shell — sidebar, page header, sections

**Files:**

- Create: `apps/web/lib/nav.ts`, `apps/web/components/app-sidebar.tsx`, `apps/web/components/page-header.tsx`, `apps/web/components/section-placeholder.tsx`, `apps/web/app/(admin)/layout.tsx`, `apps/web/app/(admin)/{attention,monitors,servers,backups,notifications,tokens}/page.tsx`, `apps/web/app/page.tsx`
- Test: `apps/web/__tests__/nav.test.ts`

**Interfaces:**

- Consumes: `requireOperator` (Task 3), `api` (Task 3), shadcn `sidebar`, `dropdown-menu`, `tooltip` (Task 2).
- Produces:
  - `@/lib/nav`: `type NavId = "attention" | "monitors" | "servers" | "backups" | "notifications" | "tokens" | "superboard"`; `interface NavSection { id: NavId; label: string; href: string; icon: LucideIcon; external?: boolean }`; `NAV_SECTIONS: readonly NavSection[]`; `activeSection(pathname: string): NavId | null`.
  - `PageHeader({ crumbs, actions }: { crumbs: { label: string; href?: string }[]; actions?: React.ReactNode })`.
  - `SectionPlaceholder({ title, part }: { title: string; part: number })` — an empty state: "{title} moves here in part {part} of the rewrite."
  - Every later page renders inside `app/(admin)/layout.tsx` and starts with `PageHeader`.

- [ ] **Step 1: Write the failing test**

```ts
expect(NAV_SECTIONS.map((s) => [s.id, s.label, s.href])).toEqual([
  ["attention", "Attention", "/attention"],
  ["monitors", "Monitors", "/monitors"],
  ["servers", "Servers", "/servers"],
  ["backups", "Backups", "/backups"],
  ["notifications", "Notifications", "/notifications"],
  ["tokens", "Tokens", "/tokens"],
  ["superboard", "Superboard", "/superboard"],
]);
expect(NAV_SECTIONS.find((s) => s.id === "superboard")?.external).toBe(true);
expect(activeSection("/monitors")).toBe("monitors");
expect(activeSection("/monitors/12")).toBe("monitors");
expect(activeSection("/servers?x=1")).toBe("servers");
expect(activeSection("/monitorsx")).toBeNull();
expect(activeSection("/sign-in")).toBeNull();
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix apps/web test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** `lib/nav.ts` with icons `Inbox`, `Activity`, `Server`, `DatabaseBackup`, `Bell`, `KeyRound`, `MonitorPlay`. `app/(admin)/layout.tsx` (server): `await requireOperator(<current path>)` (path from the `PATH_HEADER` request header), reads the shadcn `sidebar_state` cookie for `defaultOpen`, renders `SidebarProvider` + `AppSidebar` + `SidebarInset`. `AppSidebar` (client): `collapsible="icon"`; header with the Flatline mark (`/icon.svg`) and "Flatline"; one `SidebarMenu` of `NAV_SECTIONS` with the active one marked via `usePathname()` + `activeSection`; Superboard is a plain `<a>` (full page load, no sidebar there); footer with a `DropdownMenu` holding "Sign out" → `DELETE /api/v1/auth/session` via `api`, then `router.replace("/sign-in")`. `PageHeader`: a 48 px bar with `SidebarTrigger`, breadcrumbs (muted, `/` separators, last crumb in foreground), `actions` right-aligned, hairline bottom border. Each section page: `PageHeader` with its crumb and `SectionPlaceholder` (Attention, Monitors → part 2; Servers, Backups → part 3; Notifications, Tokens → part 5). `app/page.tsx`: `redirect("/monitors")`.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npm --prefix apps/web test && npm --prefix apps/web run typecheck && npm --prefix apps/web run build`
Expected: PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): admin shell with the section sidebar"
```

---

### Task 6: Local stack and an end-to-end check

**Files:**

- Modify: `dev.sh` (Next on `:3003`, the Vite dashboard moved to `:3004` until part 6; `stop` and `status` cover both)
- Modify: `docs/development.md`

**Interfaces:**

- Consumes: everything above.
- Produces: `./dev.sh` brings up backend `:3001`, web `:3003` (`API_URL=http://127.0.0.1:3001 npx next dev --port 3003`), legacy dashboard `:3004`, mock fleet.

- [ ] **Step 1: Update `dev.sh`** (new `WEB_PORT="${FLATLINE_WEB_PORT:-3003}"`, `DASH_PORT` default `3004`, `start_one "web" ...`, `stop_one "web" "next dev.*--port $WEB_PORT"`, a `web:` line in `status`), and `docs/development.md`.

- [ ] **Step 2: Run the stack and check it in a browser**

Run: `./dev.sh && ./dev.sh status`
Expected: backend, web, dashboard and mock agents up.

Then with headless Chromium (playwright-core; the setup used earlier in this repo works: `/tmp/flatline-shot`), verify and screenshot:

1. `http://127.0.0.1:3003/monitors` without a cookie → lands on `/sign-in?next=%2Fmonitors`.
2. Paste the dev admin token (`.dev-data/initial-token.txt`; do not print it) → lands on `/monitors` with the sidebar; all seven sections listed; Monitors marked active.
3. Sidebar collapses to icons and stays collapsed after a reload.
4. In a fresh context, set `localStorage["flatline.token"]` to the token on the sign-in page origin and open `/monitors` → ends on `/monitors` signed in, and the key is gone.
5. Sign out → `/sign-in`; `/monitors` redirects to sign-in again.

- [ ] **Step 3: Run every check**

Run: `cargo test --manifest-path backend-rs/Cargo.toml && npm run test:web && npm run typecheck:web && npm run build:web && npm run test:dashboard && npm run typecheck:dashboard && npm run fmt:check`
Expected: all pass; Prettier lists only the four pre-existing files.

- [ ] **Step 4: Commit**

```bash
git add dev.sh docs/development.md
git commit -m "chore(dev): run the Next app beside the old dashboard"
```
