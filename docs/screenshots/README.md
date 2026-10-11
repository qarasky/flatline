# Documentation screenshots

These are screenshots of the **actual dashboard components**, rendered against
fictional data—not production captures or hand-drawn mockups.

| Image | Shows |
|---|---|
| `dashboard.png` | Grouped monitor table, service failures and host reachability |
| `superboard.png` | Eight servers, CPU/RAM/disk/GPU, freshness and container tiles |
| `history.png` | CPU/RAM/GPU/VRAM history, mean/peak and p90/p95/p99 |

All names, domains (`example.com`), container images, measurements and history
are generated in [`extra/docs-fixtures.mjs`](../../extra/docs-fixtures.mjs).
The clock is fixed to 2026-10-01 12:00 UTC, at 1920×1080. The token is a dummy
string that cannot authenticate against a real backend. No database is opened.

## Regenerate

From the repository root, with Node.js >=26.2 and frontend dependencies installed:

```sh
npm ci
npm --prefix apps/dashboard ci
npx playwright install chromium
VITE_FLATLINE_URL= npm --prefix apps/dashboard run build
node extra/generate-docs-screenshots.mjs
```

The generator serves the build and fixture API on an ephemeral loopback port,
in a fresh browser context. It blocks all requests outside that local origin;
**do not point it at production**. The blank `VITE_FLATLINE_URL` is important:
it keeps the screenshot build's requests same-origin. Screenshots overwrite
these three PNGs; the temporary server and browser close afterward.

Review the images after regenerating, especially card fit, readable labels,
and dialog clipping. Browser/font versions may change pixels slightly.
