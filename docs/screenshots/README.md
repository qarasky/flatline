# Documentation screenshots

Screenshots of the real dashboard components, rendered against the **mock
fleet** rather than a production installation: the hosts, websites, container
names and measurements all come from `superboard/mockagent`. Nothing here is
hand-drawn, and no production database is opened.

| Image            | Shows                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `superboard.png` | The wall board: eight demo servers, per-core CPU squares, RAM/Disk rows, container rows, linked-website chips, update states and agent warnings.                                                                                                                   |
| `dashboard.png`  | The operator board: status summary, the Needs-attention section, and the grouped list with 24 h heartbeat strips. The mock fleet is only minutes old, so a day of demo history (with a few outages) was written into the disposable dev database before capturing. |
| `history.png`    | The server history dialog on the 1h range: CPU, RAM, GPU and VRAM with mean, peak and p90/p95/p99.                                                                                                                                                                 |

## Regenerating

From the repository root, with the dev stack running:

```sh
./dev.sh                                    # backend :3001, old dashboard :3004, mock fleet
npm ci
npx playwright install chromium
node docs/screenshots/capture.mjs
```

`capture.mjs` signs in with the local dev token from `.dev-data/initial-token.txt`,
waits for the mock fleet to be painted, and writes the three PNGs at 1920×1080
with device scale factor 1. It touches nothing but those files.

Two caveats when regenerating:

- **Let the fleet run for a while before retaking `history.png`.** Archived
  snapshots arrive every ~30 s, and the 1h chart only looks like a chart once a
  few minutes of history exist. A fresh `.dev-data/` shows an almost empty
  chart.
- **Check the images afterwards** for card fit, readable labels and dialog
  clipping. Browser and font versions can shift pixels slightly, which is
  exactly why these are regenerated from the app rather than drawn.
