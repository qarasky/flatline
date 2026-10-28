import "@fontsource-variable/inter";
import "./globals.css";

import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Flatline",
    robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
