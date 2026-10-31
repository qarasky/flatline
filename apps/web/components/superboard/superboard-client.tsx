"use client";

import dynamic from "next/dynamic";

/**
 * The board renders in the browser only (spec: the wall board is almost
 * entirely live, "render them however is simplest"). It reads the window's
 * size, the visibility API and the local clock while rendering, none of
 * which exist on the server.
 */
export const SuperboardClient = dynamic(() => import("./superboard").then((m) => m.SuperboardApp), {
    ssr: false,
    loading: () => (
        <p className="px-4 py-10 text-sm text-quiet" role="status">
            Loading…
        </p>
    ),
});
