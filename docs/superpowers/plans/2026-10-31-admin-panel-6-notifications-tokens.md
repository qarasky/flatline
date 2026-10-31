# Admin panel, part 6: Notifications and Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two sections of the new admin panel:

- **Notifications:** the Telegram notification configs. List, create, edit and delete them, and show which monitors use each, read-only.
- **Tokens:** list, mint (shown once), disable, enable and delete operator tokens, each showing who made it.

**Architecture:**

- **Backend, two additive changes:**
  - each notification in the list carries the ids of the monitors that use it;
  - an edit that leaves the bot token out keeps the stored one. The list never returns the token, so without this every edit would wipe it.
- **Pages:** client pages on the admin layout. They use the same `api()` client, dialogs and list style as Members (part 2).

**Tech Stack:** Rust (axum, sqlx); as parts 3–5 for the web.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`, "Information architecture" (the Notifications and Tokens rows). Part 6 of 7.

## Global Constraints

- **Earlier parts' constraints hold.**
- **One level of operator access (AGENTS.md):** no scopes are offered or described. The old panel's scope checkboxes are not ported, and the API's legacy `scopes` field is ignored.
- **Bot tokens:** never shown or sent back. The edit form's bot-token field is empty, and leaving it empty keeps the stored token.
- **Minted operator tokens** are shown once, behind a dialog that only Done closes (part 4's rule).

## Review Focus

1. **Editing a notification without retyping its bot token.** The token is kept, and alerts still send. Test: Task 1, `patching_without_the_bot_token_keeps_it`.
2. **Deleting a notification that monitors use.** The confirmation names the monitors, and their links go with it. Test: Task 1, the delete cascade. Browser check: Task 2.
3. **Disabling the token the current browser signed in with.** The page says so before disabling, and afterwards the session ends at the next request. Browser check: Task 3.
4. **A device token (QR sign-in) in the list.** It shows its screen name and maker, and disabling it signs that screen out. Browser check: Task 3.
5. **Minting a token.** It is shown once with a copy button, and closing drops it. Browser check: Task 3.

---

### Task 1: Notification monitors and keeping the bot token

- `GET /api/v1/notifications`: each notification gains `monitorIds: number[]`, in ascending order.
- `PATCH /api/v1/notifications/{id}`: when the body's `config` lacks `telegramBotToken`, or sends it as an empty string, the stored value is kept.
- Tests in `backend-rs/tests/notifications.rs` (create it if absent):
  - `the_list_names_the_monitors_using_each_notification`;
  - `patching_without_the_bot_token_keeps_it` (read through the DB);
  - `patching_with_a_new_bot_token_replaces_it`;
  - `deleting_a_notification_unlinks_its_monitors`.
- Docs: `openapi.json` and `docs/api.md`.
- Commit `feat(backend): notifications list their monitors and keep their bot token on edit`.

### Task 2: The Notifications section

- `lib/notifications-api.ts`:
  - `fetchNotificationList()` returns `{id, name, type, active, isDefault, config (without the bot token), monitorIds}[]`;
  - `createNotification`, `updateNotification` and `deleteNotification`.
- `lib/notification-form.ts`: `notificationBody(values, editing): {name, type: "telegram", active, isDefault, config}`.
  - When editing, an empty bot token is left out of `config`.
  - Test it first.
- `app/(admin)/notifications/page.tsx` and `components/notifications/*`:
  - **List rows:** name, an "on/off" word, "default for new monitors", chat id, and "Used by N monitors" with the names expandable (links to `/monitors/<id>`).
  - **Create and Edit dialogs:** name, bot token (password field; "leave empty to keep" when editing), chat id, topic/thread id, send silently, protect content, default, active.
  - **Delete confirmation:** names the monitors that will stop notifying through it.
- Browser check:
  - create, then edit the name without the token; the API still has the token (checked by a DB read in the check);
  - the monitor list shows "Used by";
  - delete.
- Commit `feat(web): the Notifications section`.

### Task 3: The Tokens section

- `lib/tokens-api.ts`: `fetchTokens`, `mintToken({name, expires?})`, `setTokenActive(id, active)` and `deleteToken(id)` on `/api/v1/api-keys`.
- `lib/token-row.ts`: `tokenRow(key, me, nowMs): {status: "active" | "disabled" | "expired"; lastUsed: string; maker: string; isCurrent: boolean}`.
  - `isCurrent` is true when `me` is that token.
  - `maker` is "removed member Ana" when the maker's account is gone.
  - Test it first.
- `app/(admin)/tokens/page.tsx` and `components/tokens/*`:
  - **List rows:** name, status word, made by, created, last used, expires.
  - **Row menu:** Disable/Enable, and Delete (confirm). Disabling the token this browser uses warns that it signs this browser out.
  - **Mint:** a name and an optional expiry (never / 30 days / 90 days / 1 year). The token is shown once.
- Retarget the Members page's links, which point at tokens, to `/tokens`.
- Browser check:
  - mint shows once;
  - disable and enable;
  - a device token from a QR approval shows its maker;
  - delete;
  - disabling the current token of a token-signed browser ends its session.
- Docs: `docs/development.md` lines for parts 6.
- Full check suite. Commit `feat(web): the Tokens section`.
