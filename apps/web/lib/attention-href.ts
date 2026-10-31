import type { AttentionItem } from "@/lib/attention";

/**
 * Where an Attention row leads: a backup problem to its agent's page (the
 * key is `backup:<agentId>`), a silent push monitor or an agent warning to
 * its server's page, anything else to its monitor in the peek on Monitors.
 */
export function attentionHref(item: AttentionItem): string {
    if (item.kind === "backup" && item.key.startsWith("backup:")) {
        return `/backups/${encodeURIComponent(item.key.slice("backup:".length))}`;
    }
    if (item.monitorId === null) {
        return "/backups";
    }
    // Silence and agent warnings are about the server, not its last check.
    if (item.kind === "stale" || item.kind === "agent") {
        return `/servers/${item.monitorId}`;
    }
    return `/monitors?m=${item.monitorId}`;
}
