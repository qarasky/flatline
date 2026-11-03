import type { Status } from "@qarasky/kore-ui";

import type { BackupTone } from "@/lib/backup-presentation";

const STATUS: Record<BackupTone, Status> = { up: "up", down: "down", degraded: "warn", neutral: "off" };

/** The kore-ui StatusDot state for a backup health tone. */
export function backupStatus(tone: BackupTone): Status {
    return STATUS[tone];
}
