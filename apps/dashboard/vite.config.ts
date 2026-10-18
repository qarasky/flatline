import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * The backend to proxy API traffic to, so the dev origin stays same-origin
 * with the API (the Rust backend is same-origin by design and sends no CORS
 * headers — in production it serves this app itself).
 *
 * Override with FLATLINE_DEV_BACKEND when the backend runs elsewhere.
 */
const backend = process.env.FLATLINE_DEV_BACKEND || "http://127.0.0.1:3001";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 3003,
        proxy: {
            // The REST API and the live SSE stream.
            "/api": { target: backend, changeOrigin: true },
            // Agent downloads (version, checksums, binaries).
            "/agent": { target: backend, changeOrigin: true },
        },
    },
});
