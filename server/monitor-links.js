/**
 * Server -> website monitor links.
 *
 * A "server" is a monitor that emits metrics (usually a `push` monitor). Each
 * server can link website monitors shown as status chips on its Superboard
 * card. A linked target is stored by id; when it is a `group` monitor it is
 * expanded to its non-group descendants on read, so linking a whole group
 * links every website inside it — including ones added after the link.
 *
 * The Node backend is kept at parity with the Rust core (the live backend),
 * so this module mirrors `backend-rs/src/links.rs`.
 */
const { R } = require("redbean-node");
const Monitor = require("./model/monitor");

/** Upper bound on links per server, matching the API's input cap. */
const MAX_LINKS = 200;

/** Status the SPA uses for "no heartbeat yet". */
const PENDING = 2;

/**
 * Raw links for one server, joined with the target's current status.
 * @param {number} monitorId Server monitor id
 * @returns {Promise<object[]>} Links with the target's name, type and status
 */
async function getRawLinks(monitorId) {
    const rows = await R.getAll(
        `SELECT ml.linked_monitor_id AS linked_monitor_id,
                m.name AS name, m.type AS type,
                (SELECT status FROM heartbeat WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS status,
                (SELECT ping FROM heartbeat WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS ping
         FROM monitor_link ml
         JOIN monitor m ON m.id = ml.linked_monitor_id
         WHERE ml.monitor_id = ?
         ORDER BY ml.id`,
        [ monitorId ]
    );

    return rows.map((row) => ({
        linkedMonitorId: row.linked_monitor_id,
        name: row.name,
        type: row.type,
        status: row.status ?? PENDING,
        ping: row.ping ?? null,
    }));
}

/**
 * Expand raw links into concrete monitor ids, in link order, without
 * duplicates. Groups contribute every descendant.
 * @param {object[]} raw Raw links
 * @param {number} serverId Server monitor id, excluded from the result
 * @returns {Promise<{ids: number[], via: Map<number, number>}>} Resolved ids
 */
async function expand(raw, serverId) {
    const ids = [];
    const seen = new Set();
    const via = new Map();

    const add = (id, source) => {
        if (id === serverId || seen.has(id)) {
            return;
        }
        seen.add(id);
        ids.push(id);
        via.set(id, source);
    };

    for (const link of raw) {
        if (link.type === "group") {
            const childIDs = await Monitor.getAllChildrenIDs(link.linkedMonitorId);
            for (const id of childIDs) {
                add(id, link.linkedMonitorId);
            }
        } else {
            add(link.linkedMonitorId, link.linkedMonitorId);
        }
    }

    return { ids, via };
}

/**
 * Load a set of monitors with their latest status in one query.
 * @param {number[]} ids Monitor ids
 * @returns {Promise<Map<number, object>>} Targets keyed by id
 */
async function loadTargets(ids) {
    const targets = new Map();
    if (ids.length === 0) {
        return targets;
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = await R.getAll(
        `SELECT m.id AS id, m.name AS name, m.type AS type, m.url AS url,
                (SELECT status FROM heartbeat WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS status,
                (SELECT ping FROM heartbeat WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS ping,
                (SELECT time FROM heartbeat WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS last_check
         FROM monitor m WHERE m.id IN (${placeholders})`,
        ids
    );

    for (const row of rows) {
        targets.set(row.id, row);
    }
    return targets;
}

/**
 * Resolve a server's links: the raw stored links plus every concrete monitor
 * they point at, each with its current status.
 * @param {number} monitorId Server monitor id
 * @returns {Promise<{raw: object[], resolved: object[]}>} Links for the card
 */
async function getResolvedLinks(monitorId) {
    const raw = await getRawLinks(monitorId);
    const { ids, via } = await expand(raw, monitorId);
    const targets = await loadTargets(ids);

    const resolved = [];
    for (const id of ids) {
        const target = targets.get(id);
        if (!target) {
            continue;
        }
        resolved.push({
            id: target.id,
            name: target.name,
            type: target.type,
            status: target.status ?? PENDING,
            ping: target.ping ?? null,
            url: target.url ?? null,
            lastCheck: target.last_check ?? null,
            via: via.get(id) ?? id,
        });
    }

    return { raw, resolved };
}

/**
 * Resolve links for several servers at once, omitting servers with no links.
 * @param {number[]} monitorIds Server monitor ids
 * @returns {Promise<{count: number, servers: Record<string, {raw: object[], resolved: object[]}>}>} Per-server links
 */
async function getLinksForMany(monitorIds) {
    const servers = {};
    let count = 0;

    for (const id of monitorIds) {
        const { raw, resolved } = await getResolvedLinks(id);
        if (raw.length > 0) {
            servers[id] = { raw, resolved };
            count++;
        }
    }

    return { count, servers };
}

/**
 * Replace a server's links with exactly the supplied ids.
 *
 * Ids that are not positive integers, equal the server itself, or duplicate
 * another entry are dropped; ids that no longer exist are skipped, since the
 * target may have been deleted between the picker loading and the save.
 * @param {number} monitorId Server monitor id
 * @param {unknown[]} linkedIds Desired linked monitor ids
 * @returns {Promise<void>}
 */
async function replaceLinks(monitorId, linkedIds) {
    const ids = [];
    const seen = new Set();

    for (const value of linkedIds.slice(0, MAX_LINKS)) {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0 || id === monitorId || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }

    let existing = [];
    if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = await R.getAll(`SELECT id FROM monitor WHERE id IN (${placeholders})`, ids);
        existing = rows.map((row) => row.id);
    }

    await R.exec("DELETE FROM monitor_link WHERE monitor_id = ?", [ monitorId ]);

    for (const id of existing) {
        const link = R.dispense("monitor_link");
        link.monitor_id = monitorId;
        link.linked_monitor_id = id;
        await R.store(link);
    }
}

/**
 * Remove every link belonging to a server.
 * @param {number} monitorId Server monitor id
 * @returns {Promise<void>}
 */
async function clearLinks(monitorId) {
    await R.exec("DELETE FROM monitor_link WHERE monitor_id = ?", [ monitorId ]);
}

/**
 * Remove links where the monitor is either the server or the linked target.
 * Called when a monitor is deleted, so no link outlives its endpoints even
 * where the database does not enforce foreign keys.
 * @param {number} monitorId Deleted monitor id
 * @returns {Promise<void>}
 */
async function deleteLinksFor(monitorId) {
    await R.exec("DELETE FROM monitor_link WHERE monitor_id = ? OR linked_monitor_id = ?", [ monitorId, monitorId ]);
}

module.exports = {
    getRawLinks,
    getResolvedLinks,
    getLinksForMany,
    replaceLinks,
    clearLinks,
    deleteLinksFor,
};
