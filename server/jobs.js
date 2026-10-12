const { UptimeKumaServer } = require("./uptime-kuma-server");
const { clearOldData } = require("./jobs/clear-old-data");
const { pruneOldMetrics } = require("./jobs/prune-old-metrics");
const { rollupMetricsJob } = require("./metrics-rollup");
const { incrementalVacuum } = require("./jobs/incremental-vacuum");
const Cron = require("croner");

const jobs = [
    {
        name: "clear-old-data",
        interval: "14 03 * * *",
        jobFunc: clearOldData,
        croner: null,
    },
    {
        // Folds raw samples into hourly rollups. Runs hourly so the raw
        // prune below never deletes an hour before it has been rolled up.
        name: "rollup-metrics",
        interval: "12 * * * *",
        jobFunc: rollupMetricsJob,
        croner: null,
    },
    {
        name: "prune-old-metrics",
        interval: "27 04 * * *",
        jobFunc: pruneOldMetrics,
        croner: null,
    },
    {
        name: "incremental-vacuum",
        interval: "*/5 * * * *",
        jobFunc: incrementalVacuum,
        croner: null,
    },
];

/**
 * Initialize background jobs
 * @returns {Promise<void>}
 */
const initBackgroundJobs = async function () {
    const timezone = await UptimeKumaServer.getInstance().getTimezone();

    for (const job of jobs) {
        const cornerJob = new Cron(
            job.interval,
            {
                name: job.name,
                timezone,
            },
            job.jobFunc
        );
        job.croner = cornerJob;
    }
};

/**
 * Stop all background jobs if running
 * @returns {void}
 */
const stopBackgroundJobs = function () {
    for (const job of jobs) {
        if (job.croner) {
            job.croner.stop();
            job.croner = null;
        }
    }
};

module.exports = {
    initBackgroundJobs,
    stopBackgroundJobs,
};
