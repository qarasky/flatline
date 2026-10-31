"use client";

import { onLiveResync } from "@/lib/live-hub";

import { UpdateWatcher } from "./update-watcher";

/**
 * The update watcher for pages with a live stream: a reconnect (which a
 * deploy causes) also triggers a check. Status pages use the plain watcher,
 * so they never load the stream client.
 */
export function LiveUpdateWatcher({ mode }: { mode: "reload" | "prompt" }) {
    return <UpdateWatcher mode={mode} onResync={onLiveResync} />;
}
