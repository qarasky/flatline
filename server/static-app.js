const express = require("express");
const fs = require("fs");
const path = require("path");

/**
 * Serve the built web app (operator dashboard + public status pages, one
 * Vite bundle since the v2 consolidation) from the backend process.
 *
 * Mounted only when a build exists, so development machines without one
 * keep the pure API behaviour. Routing contract:
 *
 * - `/assets/*` are content-hashed: immutable, cached for a year.
 * - Other files in the build (favicon, …) are served as-is.
 * - Every other GET/HEAD that is not an API path returns the SPA shell, so
 *   client-side routes survive a reload.
 * - API paths (`/api`, `/upload`, `/metrics`, `/.well-known`) are never
 *   answered by the SPA; their JSON 404s stay JSON.
 */

/**
 * Where the built web app lives. The release image copies the build to
 * /app/dashboard; override for non-standard layouts.
 * @returns {string} Absolute or relative directory
 */
function webDistDir() {
    return process.env.FLATLINE_WEB_DIST || "/app/dashboard";
}

/**
 * Paths the SPA must never answer for. Prefixes are matched on path
 * boundaries so `/apifoo` is not treated as an API path.
 * @param {string} urlPath Request path
 * @returns {boolean} True when the request belongs to the API surface
 */
function isApiPath(urlPath) {
    return urlPath === "/api" || urlPath.startsWith("/api/") ||
        urlPath === "/upload" || urlPath.startsWith("/upload/") ||
        urlPath === "/metrics" || urlPath.startsWith("/.well-known/");
}

/**
 * Mount the web app on an Express app.
 * @param {import("express").Express} app Express app
 * @param {string} distDir Build output directory
 * @returns {boolean} True when the app was mounted; false when no build exists
 */
function mountStaticApp(app, distDir) {
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath)) {
        return false;
    }

    // Hashed assets never change under the same name; a miss is a real 404
    // (fallthrough: false), not a request for the SPA shell.
    app.use("/assets", express.static(path.join(distDir, "assets"), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
    }));

    // Everything else in the build directory, including the shell itself.
    // No caching for the shell: it names the hashed assets.
    app.use(express.static(distDir, { index: "index.html", maxAge: 0 }));

    app.use((request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return next();
        }
        if (isApiPath(request.path)) {
            return next();
        }
        response.sendFile(indexPath);
    });

    return true;
}

module.exports = { mountStaticApp, webDistDir, isApiPath };
