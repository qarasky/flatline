import "../legacy.css";

/** The wall board keeps the old dashboard's look (spec: "ported as they are"), with the new accent. */
export default function SuperboardLayout({ children }: { children: React.ReactNode }) {
    return <div className="legacy-theme">{children}</div>;
}
