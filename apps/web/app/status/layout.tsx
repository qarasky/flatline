import "../legacy.css";

import type { Metadata } from "next";

import { UpdateWatcher } from "@/components/update-watcher";

/** Status pages are public and never indexed (docs/status-pages.md, "Indexing"). */
export const metadata: Metadata = {
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

/** Public status pages keep the old look; nothing from the admin area is loaded here. */
export default function StatusLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="legacy-theme">
            {children}
            <UpdateWatcher mode="reload" />
        </div>
    );
}
