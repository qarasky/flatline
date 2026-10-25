import type { BackupAgentSummary } from "./api";
import { ageOf } from "./fleet-presentation";

/**
 * Superboard presentation of a server's backup agents: one "last backup"
 * line per agent, the backup-agent version beside the telemetry agent's, and
 * whether backups should flag the card. Tone always follows the server's
 * `health`, so the card and the Telegram alerts agree.
 */

export type BackupTone = "quiet" | "warn";

export interface BackupLine {
    /** Agent id, a stable React key. */
    key: string;
    text: string;
    tone: BackupTone;
    /** Hover: exact time of the last completed backup, health, error code. */
    title: string;
}

/** Health values that flag a backup as behind. */
const BEHIND = new Set(["overdue", "failed"]);

/** Agents the card shows: a revoked credential means a decommissioned agent. */
function shown(agents: BackupAgentSummary[]): BackupAgentSummary[] {
    return agents.filter((agent) => agent.credentialActive).sort((a, b) => a.name.localeCompare(b.name));
}

function lastBackupTime(agent: BackupAgentSummary): string | null {
    const run = agent.lastCompletedRun;
    return run?.exportFinishedAt ?? run?.completedAt ?? null;
}

/**
 * One line per shown agent, sorted by name. A single agent drops the
 * `<name>: ` prefix.
 * @param agents Backup agents linked to this server's monitor
 * @param now Current time in milliseconds (the lines tick)
 */
export function backupLines(agents: BackupAgentSummary[], now: number): BackupLine[] {
    const list = shown(agents);
    const named = list.length > 1;
    return list.map((agent) => {
        const time = lastBackupTime(agent);
        const body =
            agent.health === "disabled"
                ? "backups off"
                : time
                  ? `last backup ${ageOf(time, now)} ago`
                  : "no backup yet";
        const title = [
            time ? `Last backup ${new Date(time).toLocaleString()}` : "No completed backup",
            agent.health,
            agent.lastErrorCode,
        ]
            .filter(Boolean)
            .join(" · ");
        return {
            key: agent.id,
            text: named ? `${agent.name}: ${body}` : body,
            tone: BEHIND.has(agent.health) ? "warn" : "quiet",
            title: named ? `${agent.name} · ${title}` : title,
        };
    });
}

/** Numeric dotted-version order; a -pre/+build suffix is ignored. */
function compareVersions(a: string, b: string): number {
    const parts = (value: string) =>
        value
            .split(/[-+]/)[0]
            .split(".")
            .map((part) => Number.parseInt(part, 10) || 0);
    const [as, bs] = [parts(a), parts(b)];
    for (let index = 0; index < Math.max(as.length, bs.length); index++) {
        const diff = (as[index] ?? 0) - (bs[index] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/**
 * The `backup …` segment for the card's second line: the distinct reported
 * versions, lowest first (two values mean an update is half done), or null
 * when no shown agent has reported one. A failing self-update turns it warn.
 * @param agents Backup agents linked to this server's monitor
 */
export function backupVersion(agents: BackupAgentSummary[]): { text: string; tone: BackupTone; title: string } | null {
    const list = shown(agents);
    const versions = [...new Set(list.map((agent) => agent.reportedVersion).filter((v): v is string => Boolean(v)))];
    if (versions.length === 0) {
        return null;
    }
    versions.sort(compareVersions);
    const failing = list.filter((agent) => agent.updateStatus && agent.updateStatus !== "ok");
    const title = failing.length
        ? `Backup agent update failing: ${failing.map((agent) => `${agent.name} ${agent.updateStatus}`).join(", ")}`
        : `Backup agent ${versions.join(", ")}`;
    return { text: `backup ${versions.join("/")}`, tone: failing.length ? "warn" : "quiet", title };
}

/**
 * How many shown agents are behind (server health overdue or failed), and
 * the card headline for them when nothing more severe applies.
 * @param agents Backup agents linked to this server's monitor
 */
export function backupAttention(agents: BackupAgentSummary[]): { flagged: number; headline: string | null } {
    const flagged = shown(agents).filter((agent) => BEHIND.has(agent.health)).length;
    if (flagged === 0) {
        return { flagged, headline: null };
    }
    return { flagged, headline: flagged === 1 ? "Backup overdue" : `${flagged} backups behind` };
}
