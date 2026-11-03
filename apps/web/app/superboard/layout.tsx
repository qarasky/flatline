/**
 * The wall board has its own full-screen layout (no app shell): kore-ui
 * tokens and parts, with the fleet card grid in globals.css ("Superboard").
 */
export default function SuperboardLayout({ children }: { children: React.ReactNode }) {
    return <div className="min-h-svh bg-bg text-text">{children}</div>;
}
