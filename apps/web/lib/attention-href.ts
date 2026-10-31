import type { AttentionItem } from "@/lib/attention";

/**
 * Where an Attention row leads: a backup problem to its agent's page (the
 * key is `backup:<agentId>`), anything else to its monitor in the peek on
 * Monitors, or Backups when nothing more specific is known.
 */
export function attentionHref(item: AttentionItem): string {
    if (item.kind === "backup" && item.key.startsWith("backup:")) {
        return `/backups/${encodeURIComponent(item.key.slice("backup:".length))}`;
    }
    return item.monitorId === null ? "/backups" : `/monitors?m=${item.monitorId}`;
}
