"use client";

import { KoreProvider } from "@qarasky/kore-ui";
import Link from "next/link";

/** kore-ui's setup: Next's Link for its links, the tooltip delay group and the toast region. */
export function Providers({ children }: { children: React.ReactNode }) {
    return <KoreProvider linkComponent={Link}>{children}</KoreProvider>;
}
