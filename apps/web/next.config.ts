import path from "node:path";

import type { NextConfig } from "next";

// Where the Rust backend listens. In production Caddy routes /api and /agent
// to it before a request reaches Next, so these rewrites only matter when
// Next is hit directly (local development). Server-side `api()` calls read
// API_URL at runtime (lib/api.ts).
const apiUrl = (process.env.API_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");

// The dev server only trusts localhost; dev.sh also opens it at 127.0.0.1 and
// on the LAN address (FLATLINE_DEV_ORIGINS), and without these entries it
// blocks the app's scripts there, so pages never hydrate. Dev only.
const devOrigins = ["127.0.0.1", ...(process.env.FLATLINE_DEV_ORIGINS ?? "").split(",").filter(Boolean)];

// The repository root: `@flatline/shared` lives in packages/, outside this
// app, and Turbopack resolves nothing outside its root. The standalone
// output traces from the same root (so its server is at apps/web/server.js).
const repoRoot = path.resolve(__dirname, "../..");

// The build's id, baked into the client bundle; `/build` answers the running
// server's, so an open tab notices a deploy (lib/build-id.ts). The image sets
// FLATLINE_BUILD_ID (the commit); a local build uses its build time. The dev
// server has none: nothing to compare.
const buildId =
    process.env.FLATLINE_BUILD_ID || (process.env.NODE_ENV === "production" ? new Date().toISOString() : "");

const nextConfig: NextConfig = {
    env: { NEXT_PUBLIC_FLATLINE_BUILD: buildId },
    output: "standalone",
    outputFileTracingRoot: repoRoot,
    turbopack: { root: repoRoot },
    transpilePackages: ["@flatline/shared"],
    poweredByHeader: false,
    allowedDevOrigins: devOrigins,
    // Status pages are advisory-noindexed in their headers too (docs/status-pages.md, "Indexing").
    async headers() {
        return [
            {
                source: "/status/:path*",
                headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" }],
            },
        ];
    },
    async rewrites() {
        return [
            { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
            { source: "/agent/:path*", destination: `${apiUrl}/agent/:path*` },
        ];
    },
};

export default nextConfig;
