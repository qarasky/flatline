# Flatline documentation

Flatline is a self-hosted uptime monitor: a Rust backend, a Go host agent and a
React dashboard, deployed as one origin. Start with [architecture](architecture.md)
for the shape of the system, then go to whichever document matches your task.

## Reading guide

| Document                                       | Read it when                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)             | Understanding how the pieces fit, how data is stored and retained, and how live updates work. |
| [api.md](api.md)                               | Calling Flatline from a script, an integration or an LLM agent.                               |
| [agent.md](agent.md)                           | Installing, configuring, updating or debugging the `superboard` host agent.                   |
| [superboard.md](superboard.md)                 | Changing or explaining the wall board: card anatomy, scopes, history, links.                  |
| [dashboard.md](dashboard.md)                   | Working on the operator UI: routes, panels, groups, monitor types.                            |
| [status-pages.md](status-pages.md)             | Publishing, theming or password-gating a public status page.                                  |
| [deployment.md](deployment.md)                 | Shipping a release: the office host, the image, rollout, the fleet inventory.                 |
| [operations.md](operations.md)                 | Backing up, rolling back, rotating tokens, and diagnosing a broken instance.                  |
| [development.md](development.md)               | Running the stack locally, tests, builds, repository layout.                                  |
| [provisioning.md](provisioning.md)             | Adding hosts and monitors. Also served at `/add-push-server.md`.                              |
| [roadmap.md](roadmap.md)                       | Checking what is deliberately not implemented.                                                |
| [history.md](history.md)                       | Understanding what changed from upstream Uptime Kuma.                                         |
| [screenshots/README.md](screenshots/README.md) | The sample screenshots and how they were produced.                                            |

## Where things live in the repository

| Path                     | What                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `backend-rs/`            | The Rust backend, its migrations and its integration tests.      |
| `backend-rs/migrations/` | Ordered SQL migrations, applied automatically at startup.        |
| `superboard/`            | The Go agent, plus `superboard/mockagent` for local development. |
| `apps/dashboard/`        | The React/Vite web app (dashboard, Superboard, status pages).    |
| `packages/shared/`       | Types shared between the dashboard and its tests.                |
| `agent-install.sh`       | The installer/updater served at `/agent/install.sh`.             |
| `docs/provisioning.md`   | The runbook served at `/add-push-server.md`.                     |
| `docker/`                | Dockerfiles and the office compose file.                         |
| `dev.sh`                 | The local development stack.                                     |
