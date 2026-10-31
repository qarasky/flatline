import type { AttentionItem } from "@/lib/attention";

/** Where an Attention row leads: its monitor in the peek on Monitors, or Backups for an unlinked backup agent. */
export function attentionHref(item: AttentionItem): string {
    return item.monitorId === null ? "/backups" : `/monitors?m=${item.monitorId}`;
}
