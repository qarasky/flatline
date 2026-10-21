import { lazy, Suspense, useState } from "react";
import { getToken } from "@/lib/api";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { UpdateWatcher } from "@/components/UpdateWatcher";
import { usePath } from "@/lib/router";
import { boardRouteFrom, isDeviceApprovePath, statusSlugFromPath } from "@/lib/routes";

/*
 * Each top-level route is its own chunk: a status-page visitor downloads the
 * status view, not the operator dashboard, and a wall loads only the board.
 * The entry chunk holds React, the router and these few lines.
 */
const Dashboard = lazy(() => import("@/components/Dashboard").then((m) => ({ default: m.Dashboard })));
const SuperboardApp = lazy(() => import("@/components/Superboard").then((m) => ({ default: m.SuperboardApp })));
const DeviceApprove = lazy(() =>
    import("@/components/DeviceApprove").then((m) => ({ default: m.DeviceApprove }))
);
const StatusPageApp = lazy(() =>
    import("@/components/status/StatusPageApp").then((m) => ({ default: m.StatusPageApp }))
);

/** Placeholder while a route chunk downloads; same tone as the views' own loading text. */
function RouteLoading({ label = "Loading…" }: { label?: string }) {
    return (
        <p className="px-4 py-10 text-sm text-quiet" role="status">
            {label}
        </p>
    );
}

/**
 * Site root: a client's status domain shows its status page; everything
 * else is the operator dashboard.
 *
 * A stored operator token means "this browser is the operator", so the
 * dashboard wins immediately — client status domains have their own origin
 * and therefore their own (empty) token store. Without a token the host is
 * resolved against the status-page domain map first, so a mapped client
 * domain renders its page instead of a login gate.
 */
function RootRoute() {
    const [authed] = useState(() => Boolean(getToken()));
    if (authed) {
        return <Dashboard />;
    }
    return <StatusPageApp slug={null} fallback={<Dashboard />} />;
}

/**
 * Application root.
 *
 * Routes: the operator dashboard at "/" (unless the host maps to a status
 * page), public status pages at "/status/:slug", the wall board at
 * "/superboard" (optionally group-scoped), and the chrome-free board at
 * "/superboard/kiosk", and the phone's "approve this screen" page at
 * "/device". The route is resolved before either view mounts, so the
 * dashboard's polling never runs while the board or a status page is open.
 *
 * Every route sits in its own error boundary: the kiosk and status pages
 * show the error and reload themselves, operator routes offer "try again".
 * The same split decides what happens when a new deploy is detected.
 */
export default function App() {
    const path = usePath();
    const board = boardRouteFrom(path);
    const statusSlug = board ? null : statusSlugFromPath(path);

    let content: React.ReactNode;
    // Unattended screens reload themselves on a new deploy; operator
    // routes get a prompt. An unauthenticated "/" is either a client's
    // status domain or the token gate — nothing to lose either way.
    let updates: "reload" | "prompt";
    if (board) {
        updates = board.kiosk ? "reload" : "prompt";
        content = (
            <RouteErrorBoundary resetKey={path} autoReload={board.kiosk}>
                <Suspense fallback={<RouteLoading />}>
                    <SuperboardApp kiosk={board.kiosk} filter={board.filter} />
                </Suspense>
            </RouteErrorBoundary>
        );
    } else if (isDeviceApprovePath(path)) {
        // A phone mid-approval: a reload would be harmless (the code is in
        // the URL) but a prompt never blocks it.
        updates = "prompt";
        content = (
            <RouteErrorBoundary resetKey={path}>
                <Suspense fallback={<RouteLoading />}>
                    <DeviceApprove />
                </Suspense>
            </RouteErrorBoundary>
        );
    } else if (statusSlug) {
        updates = "reload";
        // Status pages are often left on a screen too; nobody is there to
        // click "try again", so they recover like the kiosk.
        content = (
            <RouteErrorBoundary resetKey={path} autoReload>
                <Suspense fallback={<RouteLoading label="Loading status…" />}>
                    <StatusPageApp slug={statusSlug} />
                </Suspense>
            </RouteErrorBoundary>
        );
    } else {
        updates = path === "/" && !getToken() ? "reload" : "prompt";
        content = (
            <RouteErrorBoundary resetKey={path}>
                <Suspense fallback={<RouteLoading />}>{path === "/" ? <RootRoute /> : <Dashboard />}</Suspense>
            </RouteErrorBoundary>
        );
    }

    return (
        <>
            {content}
            <UpdateWatcher mode={updates} />
        </>
    );
}
