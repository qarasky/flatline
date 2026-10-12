const { sync: rimrafSync } = require("rimraf");
const Database = require("../server/database");
const { Settings } = require("../server/settings");
class TestDB {
    dataDir;

    /**
     * A fresh SQLite database for one test process.
     *
     * The default is unique per process on purpose: `npm test` runs test
     * files in parallel, and a shared `./data/test` directory makes them
     * fight over one SQLite file (SQLITE_BUSY, half-applied migrations).
     * Tests that need a specific path still pass one explicitly.
     * @param {string} dir Data directory to use
     */
    constructor(dir = `./data/test-${process.pid}`) {
        this.dataDir = dir;
    }

    async create() {
        Database.initDataDir({ "data-dir": this.dataDir });
        Database.dbConfig = {
            type: "sqlite",
        };
        Database.writeDBConfig(Database.dbConfig);
        await Database.connect(true);
        await Database.patch();
    }

    async destroy() {
        await Database.close();
        Settings.stopCacheCleaner();
        if (this.dataDir) {
            try {
                rimrafSync(this.dataDir);
            } catch (e) {
                console.error("Windows may hold file lock?");
                console.error(e);
            }
        }
    }
}

module.exports = TestDB;
