import type { Metadata } from "next";
import "./globals.css";

/**
 * Root metadata.
 *
 * robots is excluded globally rather than per page: every Flatline status page
 * is private, and forgetting it on one route would leak a client.
 */
export const metadata: Metadata = {
    icons: { icon: { url: "/favicon.svg?v=flatline-1", type: "image/svg+xml" } },
    title: {
        default: "Status",
        template: "%s",
    },
    robots: {
        index: false,
        follow: false,
        nocache: true,
        googleBot: {
            index: false,
            follow: false,
            noimageindex: true,
        },
    },
    referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
