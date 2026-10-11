# Security Policy

Flatline is a self-hosted, single-owner deployment. There is no public bug bounty and no
supported-versions table.

## Reporting a vulnerability

Open a private security advisory on this repository rather than a public issue.

Please include:

- what the issue is and what an attacker gains
- steps to reproduce, or a proof of concept
- the Flatline version (`docker logs flatline | head -1`, or the API index at
  `GET /` on the backend)

## Scope

In scope:

- authentication bypass, or reaching another user's monitors, notifications or API tokens
- privilege escalation between users
- anything that lets an unauthenticated caller read or change data
- SQL injection or path traversal in the API or upload handling

Out of scope:

- upstream Uptime Kuma vulnerabilities. Report those to
  [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma/security/advisories/new)
- missing hardening you are not able to demonstrate
- findings from automated scanners with no working exploit

## Deploying safely

- Put the instance behind HTTPS. API tokens are bearer credentials sent in a header.
- Give agents a token scoped to `read` only unless they genuinely need to mutate monitors.
- Invite links are single-use and expire, but treat an unused one as a live secret until it is
  redeemed or revoked.
- Back up `./data`. The SQLite database holds API token hashes, notification bot tokens and
  invite hashes.