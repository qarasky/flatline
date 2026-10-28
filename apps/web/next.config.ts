import type { NextConfig } from "next";

// Where the Rust backend listens. In production Caddy routes /api and /agent
// to it before a request reaches Next, so these rewrites only matter when
// Next is hit directly (local development). Server-side `api()` calls read
// API_URL at runtime (lib/api.ts).
const apiUrl = (process.env.API_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");

const nextConfig: NextConfig = {
    output: "standalone",
    poweredByHeader: false,
    async rewrites() {
        return [
            { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
            { source: "/agent/:path*", destination: `${apiUrl}/agent/:path*` },
        ];
    },
};

export default nextConfig;
