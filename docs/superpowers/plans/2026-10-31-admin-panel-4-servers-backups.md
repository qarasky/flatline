# Admin panel, part 4: Servers and Backups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Servers section (push monitors that report metrics: a live list and a detail page with history charts, containers, linked websites, agent warnings, provider and thresholds) and the Backups section (agents, runs, downloads, verification, token rotate/revoke) in `apps/web`.

**Architecture:** The old dashboard's server and backup presentation is ported, not rewritten. The pure modules (`history-chart`, `backup-presentation`, `backup-card`, `fleet-layout`) are copied with their tests, as in part 3, and the presentational components (`MetricBar`, `CoreSquares`, `ContainerRows`, `ProviderLogo`, the history chart, `BackupAgents`) are copied into `apps/web/components/fleet/`. The Superboard in part 5 reuses them. The old colour classes (`text-ok`, `text-quiet`, `tnum`, …) become theme aliases in `globals.css`, so ported markup keeps its class names. Live metrics come from the shared live hub with `metrics: true`; the roster comes from part 3's `BoardDataProvider`.

**Tech Stack:** as part 3 (Next.js 16.4, React 19.3, Tailwind 4, shadcn/Radix, Vitest).

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`, "Information architecture" (the Servers and Backups rows). Part 4 of 7.

## Global Constraints

- Part 3's Global Constraints hold: copied modules keep their exports and tests, there are no new runtime dependencies, there is no `motion` library, and shadcn's stray `cn` package is uninstalled. Browser checks follow the same rules, the dev stack restarts with `./dev.sh stop && ./dev.sh`, and the token is never printed.
- **No external loads:** `ProviderLogo` draws only the bundled logos (`/providers/*`). An unknown provider draws no logo; the Google favicon fallback is not ported (writer's call; it was the one external load in the old UI).
- **Servers are push monitors** (`type === "push"`). `/servers/[id]` for any other monitor is not found.
- **Writes** go through `api()` (CSRF header). Freshly minted backup tokens are shown once, with a copy button and the warning that they cannot be shown again.
- **Docs:** add one line per task to `docs/development.md` "Web app (in progress)".

## Review Focus

1. **A server with no metrics yet, or with a stale sample.** Its row and page say "No metrics yet" or "Stale since …", never a blank bar or 0 %. Test: Task 3, `serverRow` cases.
2. **History for a range with no data, or a fetch that fails or hangs.** The chart says so, and the range buttons keep working. Old timeouts come from `historyTimeoutMs`. Browser check: Task 4.
3. **Rotating a backup token.** The new token is shown exactly once, closing the dialog drops it from memory, and the old token stops working. Test: Task 5, through the API in the browser check.
4. **Downloading a bundle.** It uses the single-use ticket URL; no long-lived credential appears in a URL. Test: Task 5 (`download` uses `download-ticket`).
5. **Live metrics while the tab is hidden or paused.** Nothing piles up; Pause on Monitors does not freeze Servers. The hub's metrics upgrade is the only stream. Browser check: Task 3, a single `/api/v1/events` request.

---

### Task 1: Port the server and backup presentation

**Files:**

- Create (copied from `apps/dashboard/src/lib/`): `apps/web/lib/{history-chart,backup-presentation,backup-card,fleet-layout}.ts`. `./api` imports go to `./monitor-types`, and any types they need that are missing from it are added there.
- Create (copied from `apps/dashboard/test/`): `apps/web/__tests__/ported/{history-chart,backup-presentation,backup-card,backups,fleet-layout,container-rows}.test.mjs`, converted as in part 3.
- Create (copied from `apps/dashboard/src/components/`): `apps/web/components/fleet/{metric-bar,core-squares,container-rows,provider-logo}.tsx` (`MetricBar`, `UsageBar`, `usageTone`, `CoreSquares`, `ContainerRows`, `ProviderLogo` without the favicon fallback).
- Modify: `apps/web/app/globals.css`, adding `@theme` aliases for the old colour names: `ok` → `--status-up`, `warn` → `--status-warn`, `bad` → `--status-down`, `bad-dim` → `--status-muted`, `maint` → `--status-maint`, `quiet` → `--muted-foreground`, `surface-2` → `--raised`. Add a `tnum` utility (`font-variant-numeric: tabular-nums`).

- [ ] Copy and convert the tests; `npm run test:web` → FAIL (modules missing).
- [ ] Copy the modules and components; `npm run test:web && npm run typecheck:web` → PASS, with the same number of tests as the originals.
- [ ] Commit `feat(web): port the server and backup presentation`.

---

### Task 2: API calls for metrics and backups

**Files:** Modify `apps/web/lib/monitors-api.ts`; Create `apps/web/lib/backups-api.ts`; Test `apps/web/__tests__/backups-api.test.ts`.

**Interfaces (Produces):**

- `monitors-api.ts`:
  - `fetchMetricsHistory(id, hours, signal?)` → `GET /api/v1/monitors/{id}/metrics/summary?hours=`;
  - `fetchLatestMetrics(id, signal?)` → `GET /api/v1/monitors/{id}/metrics/latest`; 404 resolves to `null`.
- `backups-api.ts`: ports from the old `api.ts`:
  - `fetchBackupAgents(monitorId?)`, `fetchBackupRuns(agentId, signal?)`;
  - `downloadBackupRun(runId)`, which POSTs `download-ticket` and navigates a hidden anchor to the returned `url`;
  - new: `updateBackupAgent(id, patch: {name?, monitorId?: number | null, enabled?, intervalSeconds?, retentionCount?})`, `rotateBackupToken(id): Promise<{agent, token}>`, `revokeBackupToken(id)`, `createBackupAgent({name, monitorId?})`, and `recordVerification(runId, body)` with the body shape `backend-rs/src/api/backups.rs` accepts.

- [ ] Failing tests (stubbed `fetch`):
  - `downloadBackupRun("r1")` POSTs `/api/v1/backup-runs/r1/download-ticket` with the CSRF header and never puts a token in a URL;
  - `rotateBackupToken(3)` POSTs `/api/v1/backup-agents/3/rotate-token` and returns the token;
  - `fetchLatestMetrics(9)` on a 404 → `null`.
- [ ] Implement; tests and typecheck pass. Commit `feat(web): metrics and backup API calls`.

---

### Task 3: The Servers list

**Files:**

- Create: `apps/web/lib/server-row.ts`, `apps/web/components/servers/use-fleet-metrics.ts`, `apps/web/components/servers/servers-list.tsx`.
- Modify: `apps/web/app/(admin)/servers/page.tsx`.
- Test: `apps/web/__tests__/server-row.test.ts`.

**Interfaces (Produces):**

- `useFleetMetrics(ids: number[]): Map<number, {time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null}>`. It loads with `fetchLatestMetricsBulk` (chunks of 200) on each live snapshot and applies `metrics` events from `subscribeLive({metrics: true})`.
- `serverRow(monitor, sample | undefined, nowMs): {cpu: number | null; ram: number | null; disk: number | null; agentVersion: string | null; freshness: "none" | "fresh" | "stale"; ageText: string}`.
  - `disk` is the fullest mount.
  - `stale` follows `isSampleStale` from `fleet-presentation`.

- [ ] Failing tests:
  - no sample → `freshness: "none"`, all values null;
  - a sample older than the stale rule → `"stale"`;
  - the fullest mount wins `disk`;
  - the agent version is read from `metrics.agent.version`.
- [ ] Implement `serverRow` and the hook.
- [ ] The page: a dense list, one row per push monitor.
  - Each row shows the status dot and word, the name with its provider logo, CPU/RAM/disk `UsageBar`s with numbers, the agent version and "updated 12s ago".
  - Stale and no-metrics rows say so in words.
  - Search box and sort (worst first, name, CPU, RAM, disk).
  - A row links to `/servers/<id>`.
  - Header crumbs: `Servers`.
- [ ] Tests, typecheck and build pass.
- [ ] Browser check:
  - the row count equals the push monitors;
  - bars show numbers;
  - the page opens exactly one `/api/v1/events` request;
  - after a minute the "updated" ages are still under the push interval.
- [ ] Commit `feat(web): the Servers list`.

---

### Task 4: A server's page

**Files:**

- Create: `apps/web/app/(admin)/servers/[id]/page.tsx` (+ `not-found.tsx`), `apps/web/components/servers/server-detail.tsx`, `apps/web/components/fleet/history-chart.tsx` (ported from `ServerHistory.tsx` as an inline section instead of a modal).
- Reference: `apps/dashboard/src/components/{FleetCard,ServerHistory,WebsiteLinks}.tsx`.

**What it shows:**

- **Header:** crumbs `Servers / <name>`; the status; Mute/Unmute; Edit (the part-3 `MonitorForm` in place); "Open as monitor" (`/monitors/<id>`).
- **Live:** CPU (with `CoreSquares`), memory, disks (every mount), GPU when present, temperatures, the sample age.
- **Agent:**
  - version and update status (`updatesStatus`);
  - warnings (`agentWarnings`), with "Clear warnings" (`clearAgentWarnings`);
  - SMART/full-mount warnings (`smartWarning`).
- **History:** the ported chart with its range buttons (1 h, 6 h, 24 h, 7 d, 30 d as the old one had).
- **Containers:** `ContainerRows` with every container.
- **Linked websites:** status and an Edit links button. It opens a dialog using part 3's `LinkPicker`, saving with `replaceMonitorLinks`.
- **Thresholds** and **provider** are shown read-only; they are edited through Edit.
- **Backups:** the ported `BackupAgents` for this monitor (runs, downloads), linking to `/backups/<agentId>`.

- [ ] Failing test: none new beyond Task 3 (pure logic is ported and tested). The browser check is the gate.
- [ ] Implement.
  - A non-push or unknown id is not found, using the same safe-integer and 400/404 rule as `/monitors/[id]`.
  - The page renders its first view on the server (monitor and latest sample).
- [ ] Browser check:
  - a mock-fleet server shows bars, cores, containers and a history chart;
  - switching to 24 h redraws;
  - Clear warnings clears a warned server's warning line;
  - editing linked websites persists through the API;
  - `/servers/<http monitor id>` and `/servers/abc` are not found.
- [ ] Commit `feat(web): a server's page`.

---

### Task 5: Backups

**Files:**

- Create: `apps/web/app/(admin)/backups/page.tsx`, `apps/web/app/(admin)/backups/[id]/page.tsx` (+ `not-found.tsx`), `apps/web/components/backups/{backups-list,backup-agent-detail,token-dialog,verification-dialog,new-agent-dialog}.tsx`, `apps/web/components/fleet/backup-agents.tsx` (ported).
- Test: `apps/web/__tests__/backups-api.test.ts` (extended).

**What it shows:**

- **List:** one row per agent, with health (`backupHealth`), the linked server (or "not linked"), the last run and its age, the version, encryption, and "next due". Plus "Register agent", which creates one and shows its token once.
- **Detail:**
  - settings: name, linked server (picker of push monitors), enabled, interval, retention — saved with `updateBackupAgent`;
  - runs, newest first, with size, duration, sources, encryption, verification state and Download;
  - "Record verification" per run (archive / restore, passed / failed, note);
  - Rotate token (shown once) and Revoke token (confirm).
- **Attention** backup items with no monitor now link to `/backups/<agentId>` (extend `attentionHref` to use the item key's agent id: Task 5 changes `AttentionItem` only if the key already carries it; otherwise link to `/backups`).

- [ ] Failing tests: `rotateBackupToken`, `revokeBackupToken`, `recordVerification` request shapes.
- [ ] Implement.
- [ ] Browser check:
  - the list shows the dev agents;
  - registering an agent shows a token once;
  - rotating shows a new one, and the old token gets 401 on `/api/backup/v1/checkin`;
  - revoking disables it;
  - a verification is recorded and shown;
  - Download issues a ticket.
- [ ] Commit `feat(web): the Backups section`.

---

### Task 6: Retarget links to Servers and Backups

- `buildCommands`: Servers entries go to `/servers/<id>`.
- `attentionHref`: `stale` and `agent` items go to `/servers/<id>`.
- The Monitors peek shows "Open server page" for push monitors.
- Tests: `commands.test.ts` and `attention-href.test.ts` updated first (RED), then the code.
- Docs line. Full check suite. Commit `feat(web): link servers and backups from everywhere`.
