/*
 * Flatline server
 * node "server/server.js"
 * DO NOT require("./server") in other modules, it likely creates circular dependency!
 */
import { getRandomInt, isDev, log, sleep } from "../src/util";
import { auth } from "./better-auth";
import { createBetterAuthRouter } from "./routers/better-auth-router";
import { loadEnvFile } from "node:process";
import * as fs from "node:fs";

console.log("Welcome to Flatline");

// As the log function need to use dayjs, it should be very top
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("./modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

// Load environment variables from `.env`
try {
    loadEnvFile();
} catch (_) {}

// Check Node.js Version
const nodeVersion = process.versions.node;

// Get the required Node.js version from package.json
const requiredNodeVersions = require("../package.json").engines.node;
const bannedNodeVersions = "< 24";
console.log(`Your Node.js version: ${nodeVersion}`);

const semver = require("semver");
const requiredNodeVersionsComma = requiredNodeVersions
    .split("||")
    .map((version) => version.trim())
    .join(", ");

// Exit Flatline immediately if the Node.js version is banned
if (semver.satisfies(nodeVersion, bannedNodeVersions)) {
    console.error(
        "\x1b[31m%s\x1b[0m",
        `Error: Your Node.js version: ${nodeVersion} is not supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
    process.exit(-1);
}

// Warning if the Node.js version is not in the support list, but it maybe still works
if (!semver.satisfies(nodeVersion, requiredNodeVersions)) {
    console.warn(
        "\x1b[31m%s\x1b[0m",
        `Warning: Your Node.js version: ${nodeVersion} is not officially supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
}

const args = require("args-parser")(process.argv);
const config = require("./config");

process.title = "flatline";

log.debug("server", "Arguments");
log.debug("server", args);

if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
}


log.info("server", "Env: " + process.env.NODE_ENV);
log.debug("server", "Inside Container: " + (process.env.UPTIME_KUMA_IS_CONTAINER === "1"));

if (isDev || process.env.UPTIME_KUMA_DEBUG_INSPECTOR === "1") {
    const inspector = require("inspector");
    let inspectorHost = "127.0.0.1";

    log.warn("server", "Node.js Inspector is enabled. You can connect to it via Chrome DevTools or VSCode.");
    log.warn("server", "Node.js Inspector is listening on:", inspector.url());

    if (process.env.UPTIME_KUMA_IS_CONTAINER === "1") {
        log.warn(
            "server",
            "You need to expose the port 9229:9229 in your docker command or docker compose, and ssh tunneling in order to connect to it."
        );
        inspectorHost = "0.0.0.0";
    }

    inspector.open(9229, inspectorHost);
}

const checkVersion = require("./check-version");
log.info("server", "Flatline version:", checkVersion.version);

log.info("server", "Loading modules");

log.debug("server", "Importing express");
const express = require("express");
log.debug("server", "Importing redbean-node");
const { R } = require("redbean-node");
log.debug("server", "Importing http-graceful-shutdown");
const gracefulShutdown = require("http-graceful-shutdown");
log.debug("server", "Importing prometheus-api-metrics");
const prometheusAPIMetrics = require("prometheus-api-metrics");

const { UptimeKumaServer } = require("./uptime-kuma-server");
const server = UptimeKumaServer.getInstance();
const app = server.app;

log.debug("server", "Importing Settings");
const {
    allowDevAllOrigin,
    printServerUrls,
    allowDevOrigin,
} = require("./util-server");

log.debug("server", "Importing Notification");
const { Notification } = require("./notification");
Notification.init();


log.debug("server", "Importing Database");
const Database = require("./database");

log.debug("server", "Importing Background Jobs");
const { initBackgroundJobs, stopBackgroundJobs } = require("./jobs");
const { apiAuth } = require("./auth");
const { Prometheus } = require("./prometheus");

const hostname = config.hostname;

if (hostname) {
    log.info("server", "Custom hostname: " + hostname);
}

const port = config.port;

const disableFrameSameOrigin =
    !!process.env.UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN || args["disable-frame-sameorigin"] || false;
const cloudflaredToken = args["cloudflared-token"] || process.env.UPTIME_KUMA_CLOUDFLARED_TOKEN || undefined;

/**
 * Run unit test after the server is ready
 * @type {boolean}
 */
const testMode = !!args["test"] || false;

const {
    autoStart: cloudflaredAutoStart,
    stop: cloudflaredStop,
} = require("./cloudflared");
const UserInvite = require("./model/user_invite");
const StatusPage = require("./model/status_page");
const { Settings } = require("./settings");
const { EmbeddedMariaDB } = require("./embedded-mariadb");
const { SetupDatabase } = require("./setup-database");

app.use(express.json());

// Global Middleware
app.use(function (req, res, next) {
    if (!disableFrameSameOrigin) {
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }
    res.removeHeader("X-Powered-By");
    next();
});

(async () => {
    // Create a data directory
    Database.initDataDir(args);

    // Check if is chosen a database type
    let setupDatabase = new SetupDatabase(args, server);
    if (setupDatabase.isNeedSetup()) {
        // Hold here and start a special setup page until user choose a database type
        await setupDatabase.start(hostname, port);
    }

    // Connect to database
    try {
        await initDatabase(testMode);
    } catch (e) {
        log.error("server", "Failed to prepare your database: " + e.message);
        process.exit(1);
    }

    // Init Better Auth
    auth();

    // Database should be ready now
    await server.initAfterDatabaseReady();
    server.entryPage = await Settings.get("entryPage");
    await StatusPage.loadDomainMappingList();

    log.debug("server", "Initializing Prometheus");
    await Prometheus.init();

    log.debug("server", "Adding route");

    // ***************************
    // Normal Router here
    // ***************************

    // Entry page.
    //
    // With a web build present (release image) the static mount below serves
    // the SPA at "/" and this API index is only a fallback for browsers
    // pointed straight at the API in dev. When no build exists the index is
    // the only thing at "/", so it stays registered.
    const { mountStaticApp, webDistDir } = require("./static-app");
    const webDist = webDistDir();
    const hasWebBuild = require("fs").existsSync(require("path").join(webDist, "index.html"));

    if (!hasWebBuild) {
        app.get("/", async (request, response) => {
            response.json({
                ok: true,
                name: "Flatline API",
                version: "v1",
                documentation: "/api/v1/openapi.json",
                dashboard: "Build the web app (apps/dashboard) to serve it from this origin, or run its dev server.",
            });
        });
    }

    app.get("/setup-database-info", (request, response) => {
        allowDevAllOrigin(response);
        response.json({
            runningSetup: false,
            needSetup: false,
        });
    });

    if (isDev) {
        app.options("/*", async (request, response) => {
            allowDevOrigin(request, response);
            response.end();
        });

        app.use(express.urlencoded({ extended: true }));
        app.post("/test-webhook", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });

        app.get("/_e2e/take-sqlite-snapshot", async (request, response) => {
            // Checkpoint WAL to flush all data to the main .db file, then copy.
            // No close/reopen needed — the file is consistent after checkpoint.
            await R.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            fs.cpSync(Database.sqlitePath, `${Database.sqlitePath}.e2e-snapshot`);
            response.send("Snapshot taken.");
        });

        app.get("/_e2e/restore-sqlite-snapshot", async (request, response) => {
            if (!fs.existsSync(`${Database.sqlitePath}.e2e-snapshot`)) {
                throw new Error("Snapshot doesn't exist.");
            }

            await Database.close();
            try {
                fs.cpSync(`${Database.sqlitePath}.e2e-snapshot`, Database.sqlitePath);
            } catch (err) {
                throw new Error("Unable to copy snapshot file.");
            }
            await Database.connect();

            response.send("Snapshot restored.");
        });

        app.post("/test-x-www-form-urlencoded", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });
    }

    // Robots.txt — API-only: nothing here is crawlable.
    app.get("/robots.txt", async (_request, response) => {
        response.setHeader("Content-Type", "text/plain");
        response.send("User-agent: *\nDisallow: /");
    });

    // Basic Auth Router here

    // Prometheus API metrics  /metrics
    // With Basic Auth using the first user's username/password
    app.get("/metrics", apiAuth, prometheusAPIMetrics());

    // ./data/upload
    app.use("/upload", express.static(Database.uploadDir));

    app.get("/.well-known/change-password", async (_, response) => {
        response.redirect("https://github.com/artchsh/flatline/wiki/Reset-Password-via-CLI");
    });

    // API Router
    const apiRouter = require("./routers/api-router");
    app.use(apiRouter);

    // REST API v1 (token auth, for automation and agents).
    // Mounted after apiRouter but before the SPA catch-all below.
    const apiV1Router = require("./routers/api-v1-router");
    app.use(apiV1Router);

    // Status pages, groups, incidents and domains. Separate file for
    // readability; it must be mounted before the SPA catch-all too.
    const apiV1StatusRouter = require("./routers/api-v1-status-router");
    app.use(apiV1StatusRouter);

    // Status Page Router
    const statusPageRouter = require("./routers/status-page-router");
    app.use(statusPageRouter);

    // Auth REST: password login, setup status, invites and account
    // administration. The dashboard's only credential flow; no sessions.
    const authRouter = require("./routers/auth-router");
    app.use(authRouter);

    // better auth API Router
    const betterAuthRouter = await createBetterAuthRouter();
    app.use(betterAuthRouter);

    // The built web app — operator dashboard and public status pages — is
    // served from this process when a build exists (v2 consolidation). On a
    // dev machine without a build, the backend stays API-only.
    if (mountStaticApp(app, webDist)) {
        log.info("server", `Serving the web app from ${webDist}`);
    } else {
        log.debug("server", `No web build at ${webDist}; API only`);
    }

    // Catch-all, must be at the end of all express routes. Anything the API
    // and the web app did not answer is a JSON 404 — never an HTML error
    // page, so scripts and agents always get parseable output.
    app.use(async (request, response) => {
        if (request.originalUrl.startsWith("/upload/")) {
            response.status(404).json({ ok: false, error: "not_found", message: "File not found." });
        } else {
            response.status(404).json({
                ok: false,
                error: "not_found",
                message: `No route for ${request.method} ${request.path}. See GET /api/v1.`,
            });
        }
    });


    log.debug("server", "Init the server");

    server.httpServer.once("error", async (err) => {
        log.error("server", "Cannot listen: " + err.message);
        await shutdownFunction();
        process.exit(1);
    });

    await server.start();

    server.httpServer.listen(port, hostname, async () => {
        printServerUrls("server", port, hostname, config.isSSL);

        await startMonitors();

        // Housekeeping for expired invite links.
        UserInvite.startInvitePruner();

        // Put this here. Start background jobs after the db and server is ready to prevent clear up during db migration.
        await initBackgroundJobs();

        checkVersion.startInterval();
    });

    // Start cloudflared at the end if configured
    await cloudflaredAutoStart(cloudflaredToken);
})();



/**
 * Initialize the database
 * @param {boolean} testMode Should the connection be
 * started in test mode?
 * @returns {Promise<void>}
 */
async function initDatabase(testMode = false) {
    log.debug("server", "Connecting to the database");
    await Database.connect(testMode);
    log.info("server", "Connected to the database");

    // Patch the database
    await Database.patch(port, hostname);
}

/**
 * Resume active monitors
 * @returns {Promise<void>}
 */
async function startMonitors() {
    let list = await R.find("monitor", " active = 1 ");

    for (let monitor of list) {
        server.monitorList[monitor.id] = monitor;
    }

    for (let monitor of list) {
        try {
            await monitor.start();
        } catch (e) {
            log.error("monitor", e);
        }
        // Give some delays, so all monitors won't make request at the same moment when just start the server.
        await sleep(getRandomInt(300, 1000));
    }
}

/**
 * Shutdown the application
 * Stops all monitors and closes the database connection.
 * @param {string} signal The signal that triggered this function to be called.
 * @returns {Promise<void>}
 */
async function shutdownFunction(signal) {
    log.info("server", "Shutdown requested");
    log.info("server", "Called signal: " + signal);

    await server.stop();

    log.info("server", "Stopping all monitors");
    for (let id in server.monitorList) {
        let monitor = server.monitorList[id];
        await monitor.stop();
    }
    await sleep(2000);
    await Database.close();

    if (EmbeddedMariaDB.hasInstance()) {
        EmbeddedMariaDB.getInstance().stop();
    }

    stopBackgroundJobs();
    await cloudflaredStop();
    Settings.stopCacheCleaner();
}

/**
 * Final function called before application exits
 * @returns {void}
 */
function finalFunction() {
    log.info("server", "Graceful shutdown successful!");
}

gracefulShutdown(server.httpServer, {
    signals: "SIGINT SIGTERM",
    timeout: 30000, // timeout: 30 secs
    development: false, // not in dev mode
    forceExit: true, // triggers process.exit() at the end of shutdown process
    onShutdown: shutdownFunction, // shutdown function (async) - e.g. for cleanup DB, ...
    finally: finalFunction, // finally function (sync) - e.g. for logging
});

// Catch unexpected errors here
let unexpectedErrorHandler = (error, promise) => {
    console.trace(error);
    UptimeKumaServer.errorLog(error, false);
    console.error("If you keep encountering errors, please report to https://github.com/artchsh/flatline/issues");
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);
