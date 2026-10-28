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

const nextConfig: NextConfig = {
    output: "standalone",
    poweredByHeader: false,
    allowedDevOrigins: devOrigins,
    async rewrites() {
        return [
            { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
            { source: "/agent/:path*", destination: `${apiUrl}/agent/:path*` },
        ];
    },
};

export default nextConfig;
