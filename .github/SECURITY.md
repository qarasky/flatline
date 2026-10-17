# Security Policy

Flatline is a self-hosted, single-operator deployment. There is no bug bounty and
no supported-versions table; the operator runs whatever `master` is deployed.

## Reporting a vulnerability

Open a private security advisory on this repository rather than a public issue.
Please include what the issue is, what an attacker gains, and either steps to
reproduce or a proof of concept.

Useful context: the deployed commit (`git rev-parse HEAD` on the server) and the
image in use (`sudo docker images | grep flatline-rust`). There is no version
endpoint to quote.

## Scope

In scope:

- Authentication bypass, or reaching data without a bearer token.
- Anything that lets an unauthenticated caller read or change data, including
  through the public status-page and badge read paths.
- SQL injection or path traversal in the API or the agent download endpoints.
- Privilege escalation on an agent host through the install or self-update path
  (the agent runs as root and replaces its own binary — a release an attacker can
  substitute is a fleet compromise; that is why releases are push-token gated and
  sha256 verified).
- Leakage of one credential's access into another monitor's data: a push token
  must only ever affect its own monitor.

Out of scope:

- Upstream Uptime Kuma vulnerabilities — report those to
  [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma/security/advisories/new).
  This fork shares their lineage but not their code.
- SSRF by design: an HTTP monitor fetches the URL the operator configured. That
  is the feature, and the operator already has full permission.
- Findings from automated scanners with no working exploit, and missing hardening
  that cannot be demonstrated to matter.

## Deploying safely

- **Put the instance behind HTTPS.** Tokens are bearer credentials sent in a
  header, and agent updates require HTTPS anyway. The office deployment binds
  loopback only and is reached through a tunnel.
- **Treat every token as the operator.** This backend has exactly one
  permission level: a token can read, mutate and delete anything. Mint a named
  token per integration so a leak costs one revocation, and revoke rather than
  rotate when one escapes.
- **Agent hosts hold only a push token.** It can report that host's monitor and
  download releases — nothing else. Never install an operator token on a client
  box.
- **Back up `./data` and the backups themselves.** The database holds token
  hashes, the Telegram bot token, status-page password hashes and incident text.
  Backups are as sensitive as the live file: root-only, out of Git.
- **Know what is advisory.** Status pages are `noindex` with an
  `X-Robots-Tag` and a disallow-all `robots.txt`, but that only stops compliant
  crawlers. Unpredictable slugs and the page password are the actual boundary;
  see [status pages](../docs/status-pages.md).
- **Keep the deployment surface small.** The image ships one process, one
  database file and the agent downloads. There is no plugin system, no upload
  handling and no second service to harden.
