import type { Metadata } from "next";

import { UpdateWatcher } from "@/components/update-watcher";

/** Status pages are public and never indexed (docs/status-pages.md, "Indexing"). */
export const metadata: Metadata = {
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

/** Public status pages: their own full-screen layout on kore-ui tokens; nothing from the admin area is loaded here. */
export default function StatusLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            {children}
            <UpdateWatcher mode="reload" />
        </>
    );
}
