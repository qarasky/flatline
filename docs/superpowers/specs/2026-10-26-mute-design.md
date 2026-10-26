# Mute: acknowledge a known outage

Date: 2026-10-26. Status: approved in conversation; written for the builder.

## Why

Some outages are known and cannot be fixed yet. aiel-qorgan is the current
example: the client stopped paying, so the server is down and stays down. A
red card that stays red trains the operator to ignore red, and the repeated
Telegram reminders are noise. The operator wants to say "I know, stop
shouting" without hiding the fact that the thing is broken, and without
missing anything new that goes wrong on the same server.

## What the operator gets

- An action, **Mute**, on a red Superboard card (in the right-click menu,
  beside "Clear agent warnings") and on a down monitor in the dashboard (the
  monitor detail view). **Unmute** in the same places while a mute is active.
- A muted card is **dark red**: a dim red border and status badge instead of
  the bright `#e5484d`. It still reads as broken; it no longer reads as an
  alarm. The headline keeps saying what is wrong ("Host down").
- A muted card does not count in the Superboard header's "N need attention"
  (with one exception, below). The header shows muted cards separately
  ("1 muted"); exact wording is the builder's.
- Telegram stops sending reminders and the minor alerts listed below for
  what was muted.
- Anything **new and substantial** on the card ends the mute: the card goes
  bright red and Telegram alerts as usual.
- When everything that was muted has recovered, the mute ends by itself, so
  the next outage starts loud.

The mute lives on the server (database), so every screen, the wall display
included, shows the same state and updates live.

## Goals

- Silence a known problem on the board and in Telegram.
- Never let a mute hide a new substantial problem.
- No lingering mutes: a mute only exists while what it covers is still broken.

## Non-goals

- Timed mutes ("mute for 4 hours"). Not asked for.
- Maintenance windows or scheduled silences.
- Muting yellow (warning-only) cards. The action is offered only on red.
- Making a SMART failure turn a card red. Today a card is red only for a
  down host or a down linked website, and that stays so. SMART matters here
  only as something that ends a mute.
- Public status pages. They are unaffected.

## Anti-goals (a failure even if it works)

- A new website going down, a newly failing disk or a newly full disk on a
  muted server that produces no Telegram alert or no bright red.
- A mute that outlives its outage and silently swallows the next one.
- A muted card that looks healthy.
- A mute for a down website that silences problems of the healthy server it
  runs on.

## The model

A mute belongs to a **subject monitor**: the card's server monitor (a push
monitor with metrics) when muted from a card, or the monitor itself when
muted from the dashboard. Muting a server monitor from the dashboard is the
same as muting its card.

At mute time the server records a **snapshot** of the subject:

- the ids of the monitors on it that are down: the subject itself if down,
  and each linked website that is down (links as already expanded for the
  card, groups included);
- from the subject's latest sample, when it has one: the disks reported
  SMART `failed`, and the mounts at or above the disk-full level (below).

Mute is refused (an error the UI shows) when no monitor on the subject is
down. Muting a subject that already has a mute replaces its snapshot.

A monitor is **covered** when it is in the snapshot of any active mute. A
website linked to several servers is covered if any of their mutes covers
it. A **group** monitor is covered when it is down and every down
descendant of it is covered (so aiel-qorgan's "work" and "Aiel Qorgan"
groups go quiet with it).

**The host is muted** when the subject itself is in its snapshot. This
decides the host-level silences below. A mute made only of websites on a
running server leaves the server's own alerts alone (decided by the
operator).

### Disk-full level

A mount is "full" at the subject's configured disk alert threshold, or at
the card's existing 90% "hot" level when no disk threshold is configured.

### What ends a mute

- **A new substantial problem on the subject** deletes the mute:
  - a monitor on the card goes down that is not in the snapshot (the host,
    or a linked website);
  - a disk is reported SMART `failed` that was not in the snapshot;
  - a mount reaches the disk-full level that was not in the snapshot.
    Only a new breach counts: a disk that was already over the level at
    mute time, or a repeat of the 30-minute disk alert, or an alert re-sent
    after a backend restart, does not end the mute. The check reads the
    sample on ingest against the snapshot; it does not depend on the
    in-memory alert state.
- **Recovery shrinks the snapshot.** When a snapshot monitor comes back up
  it is removed from the snapshot, so if it goes down again later that is
  new and ends the mute. When no snapshot monitor is left, the mute is
  deleted, whatever the disk lists hold. A snapshot mount that drops back
  under the level is removed from the snapshot too, so a later breach is new.
- **Unmute** deletes the mute. Unmute on a covered monitor that is not the
  subject (a website in a server's snapshot, a covered group) deletes every
  mute covering it: the operator wants the noise back. Mute is not offered
  on a monitor that is already covered.

A deleted mute is gone; nothing remembers it, so the next problem is loud.

### What a mute silences in Telegram

While a mute is active, these are not sent:

- repeat reminders (`resend_interval`) for covered monitors, groups included;
- a down transition for a covered monitor (normally impossible for a
  snapshot monitor, since recovery removes it; a covered group can
  transition when a covered child goes down);
- when the host is muted: CPU and RAM threshold alerts for the subject, and
  backup `failed` and `overdue` alerts for backup agents linked to it.

These are always sent, muted or not:

- recovery messages (monitor up, metric recovered, backup healthy again). A
  metric recovery is only sent when its alert went out, as today; an alert
  suppressed by a mute counts as not sent. Backup recoveries follow their
  existing persisted-state rule and are sent;
- everything that ends a mute, which is sent after the mute is deleted and
  therefore goes out normally.

## Where it shows

- **Superboard card:** dark red (border and status badge) when the card is
  red and every down monitor on it is covered. Otherwise the normal colours.
  A small "muted" marker with its age (for example "muted 2d ago") near the
  status badge; placement is the builder's call. Yellow lines on the card
  (stale, backups behind, containers, usage) render as today.
- **Superboard header:** a dark-red card leaves "N need attention" and is
  counted as "N muted", unless the host is not muted and the card also has a
  yellow problem, in which case it stays in "need attention" (the server's
  own problems are not muted). When the host is muted, the stale and backup
  problems that follow from it do not keep the card in the count.
- **Dashboard "Needs attention" list and monitor rows:** a covered down
  monitor or group stays listed but is marked muted and sorted after
  unmuted items; its status dot uses the dark red. Stale and backup items
  for a muted host are marked muted the same way.
- **Monitor detail:** Mute (when down and not covered) or Unmute (when
  covered), and when covered, since when and by which subject.

## Constraints

- Migrations are additive: a new `0016_*.sql`. One row per subject monitor;
  deleting a monitor deletes its mute and drops it from other snapshots.
- New routes registered in `backend-rs/src/api/mod.rs` and documented in
  `openapi.json`: mute and unmute for `/api/v1/monitors/{id}`, operator
  token only (the same `flatline_` credential as everything else).
- The monitor listing the dashboard already reads carries the mute state
  (for a subject, its mute; for any covered monitor, which subjects cover
  it), so no extra request per card. Every mute change, by hand or
  automatic, publishes a live event so open screens update without reloading.
- Mute ends are decided on the server where the events happen (heartbeat
  recording, metric ingest, backup health), not by the dashboard.
- Docs change in the same commit: `docs/superboard.md`, the dashboard doc
  that covers the monitor view and "Needs attention", the notifications
  section, and the API doc.
- Dashboard colours follow the existing palette; the dark red must stay
  clearly distinguishable from the bright red and from the neutral border on
  the wall display.

## Left to the builder

- Table and column names, JSON shapes, route verbs (`POST`/`DELETE` on
  `.../mute` is the obvious fit).
- Where SMART and disk-full checks run on ingest; they only need to run for
  subjects with an active mute.
- Exact dark red value, marker wording and placement.
- Whether the mute check in alert paths is a cached lookup or a query; the
  alert paths are not hot except metric ingest, so cache there if needed.
