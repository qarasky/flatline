import {
    pageSeverity,
    resolveMonitorStates,
    stateLabel,
    type Heartbeat,
    type Incident,
    type MonitorEntry,
    type StatusPageData,
} from "@flatline/shared";
import { Badge, Card, StatusDot, type Status } from "@qarasky/kore-ui";

/**
 * Public status page rendering.
 *
 * Ported from the standalone status site (v2 consolidation), now on kore-ui
 * tokens and parts. Its own full-screen layout (no app shell) lives in
 * globals.css under "Public status pages". Two colour systems stay apart:
 * the client's accent only re-tints kore-ui's accent (chrome: focus rings,
 * links), while up / degraded / outage use the fixed status tokens, so they
 * mean the same thing on every client page.
 */

/** How many recent beats to draw per monitor. */
const BEAT_COUNT = 45;

/**
 * Expose the client accent as kore-ui's accent for this page.
 * @param accent Hex accent from the page
 * @returns Style overriding --color-accent, or nothing for the default
 */
function brandVars(accent: string | null | undefined): React.CSSProperties | undefined {
    // The default stays kore-ui's blue accent: never a colour that could read as a status.
    return accent ? ({ "--color-accent": accent } as React.CSSProperties) : undefined;
}

/** Monitor status (heartbeat code) -> beat / severity key. */
function beatKey(status: number): "up" | "down" | "maintenance" | "pending" {
    return status === 1 ? "up" : status === 0 ? "down" : status === 3 ? "maintenance" : "pending";
}

/** Page or monitor severity -> kore-ui StatusDot state. */
const SEVERITY_DOT: Record<string, Status> = {
    up: "up",
    down: "down",
    degraded: "warn",
    maintenance: "maint",
    pending: "warn",
};

/**
 * Beat bar for a single monitor. Spans rather than a canvas: legible in a
 * monochrome renderer, cheap at 45 spans.
 */
function Beats({ beats }: { beats: Heartbeat[] }) {
    if (!beats || beats.length === 0) {
        return <div className="status-beats" aria-hidden="true" />;
    }

    // Oldest first so the newest beat is on the right, matching the trend.
    const recent = beats.slice(0, BEAT_COUNT).reverse();
    const lastCheck = beats[0]?.time;

    return (
        <>
            <div className="status-beats" aria-hidden="true">
                {recent.map((beat, i) => (
                    <span key={i} title={beat.time} className="status-beat" data-s={beatKey(beat.status)} />
                ))}
            </div>
            <span className="status-beat-time tnum" aria-hidden="true">
                {lastCheck ? formatDate(lastCheck).slice(11) : `${beats.length} checks`}
            </span>
        </>
    );
}

/** One monitor row: name, the state in words with its dot, recent beats. */
function MonitorRow({ monitor, state }: { monitor: MonitorEntry; state: { status: number; beats: Heartbeat[] } }) {
    return (
        <div className="status-monitor">
            <span className="min-w-0 flex-auto truncate text-sub">{monitor.name}</span>
            <StatusDot
                status={SEVERITY_DOT[beatKey(state.status)] ?? "off"}
                label={stateLabel(state.status)}
                className="shrink-0 font-medium"
            />
            <Beats beats={state.beats} />
        </div>
    );
}

/** One incident card; the left edge carries its style (warn, danger, info). */
function IncidentCard({ incident, resolved }: { incident: Incident; resolved: boolean }) {
    return (
        <Card className="status-incident mb-2.5 px-4.5 py-4" data-style={incident.style}>
            <div className="mb-2 flex items-start justify-between gap-3">
                <h3 className="text-heading font-semibold">{incident.title}</h3>
                <Badge tone={resolved ? "neutral" : "accent"}>{resolved ? "Resolved" : "Investigating"}</Badge>
            </div>
            <p className="text-sub text-muted">{stripTags(incident.content)}</p>
            {incident.createdDate ? (
                <p className="mt-2.5 text-2xs text-muted">{formatDate(incident.createdDate)}</p>
            ) : null}
        </Card>
    );
}

/** Section heading on the status page ("Active incidents", a group's name). */
function SectionTitle({ children }: { children: React.ReactNode }) {
    return <h2 className="mb-3 text-meta font-semibold tracking-[0.07em] text-muted uppercase">{children}</h2>;
}

/**
 * Render a status page.
 * @param props.data Page configuration and groups
 * @param props.heartbeats Recent beats keyed by monitor id
 * @param props.history Resolved incidents
 * @returns The rendered page
 */
export function StatusPageView({
    data,
    heartbeats,
    history = [],
    notice = null,
}: {
    data: StatusPageData;
    heartbeats: Record<string, Heartbeat[]>;
    history?: Incident[];
    /** Shown under the header, e.g. the "stale since" banner. */
    notice?: React.ReactNode;
}) {
    // Status lives in the heartbeat feed, not the config payload, so pair the
    // two before deciding anything about overall health.
    const states = resolveMonitorStates(data.publicGroupList, heartbeats);
    const byMonitor = new Map(states.map((s) => [s.monitor.id, s]));

    const severity = pageSeverity(states);
    const monitorCount = states.length;

    // StatusPage.getIcon() returns "/icon.svg" when no logo is set: the web
    // app serves the KoreMonitor mark (the cream pulse) there.
    const logoUrl = data.config.icon || "/icon.svg";

    // data.incidents holds pinned *active* incidents only; resolved ones come
    // from the separate history fetch.
    const activeIncidents = data.incidents ?? [];
    const pastIncidents = history;

    return (
        <div className="status-page" style={brandVars(data.config.accentColor)}>
            <div className="status-wrap">
                <header className="flex items-center gap-3 pt-5 pb-7">
                    <img
                        className="size-[34px] shrink-0 rounded-overlay bg-surface object-contain"
                        src={logoUrl}
                        alt=""
                    />
                    <div className="min-w-0">
                        <h1 className="text-[21px] font-semibold tracking-[-0.01em]">{data.config.title}</h1>
                        {data.config.description ? (
                            <p className="mt-1.5 max-w-[60ch] text-sub text-muted">{data.config.description}</p>
                        ) : null}
                    </div>
                </header>

                {notice}

                <section className="status-hero" data-severity={severity}>
                    <div className="inline-flex items-center gap-3">
                        <StatusDot
                            status={SEVERITY_DOT[severity] ?? "off"}
                            aria-hidden="true"
                            className="status-hero-dot"
                        />
                        <span className="status-hero-label">{heroLabel(severity)}</span>
                    </div>
                    {monitorCount > 0 ? (
                        <div className="mt-1.5 text-meta text-muted">
                            {monitorCount} {monitorCount === 1 ? "service" : "services"}
                        </div>
                    ) : null}
                </section>

                {activeIncidents.length > 0 ? (
                    <section className="mb-8">
                        <SectionTitle>Active incidents</SectionTitle>
                        {activeIncidents.map((incident) => (
                            <IncidentCard key={incident.id} incident={incident} resolved={false} />
                        ))}
                    </section>
                ) : null}

                {data.publicGroupList.map((group) => (
                    <section className="mb-8" key={group.id}>
                        <SectionTitle>{group.name}</SectionTitle>
                        <Card className="overflow-hidden">
                            {(group.monitorList ?? []).map((monitor) => {
                                const entry = byMonitor.get(monitor.id);
                                return (
                                    <MonitorRow
                                        key={monitor.id}
                                        monitor={monitor}
                                        state={entry?.state ?? { status: 2, beats: [], ping: null, msg: "" }}
                                    />
                                );
                            })}
                        </Card>
                    </section>
                ))}

                {pastIncidents.length > 0 ? (
                    <section className="mb-8">
                        <SectionTitle>Recent incidents</SectionTitle>
                        {pastIncidents.map((incident) => (
                            <IncidentCard key={incident.id} incident={incident} resolved />
                        ))}
                    </section>
                ) : null}

                {/* Only rendered when there is something to say. A bare
                    "updated at" line is noise on a page whose whole point is
                    showing current state. */}
                {data.config.showPoweredBy ? (
                    <footer className="mt-11 border-t border-border pt-5.5 text-meta text-muted">
                        <span>Status by KoreMonitor</span>
                    </footer>
                ) : null}
            </div>
        </div>
    );
}

/** Headline for an overall severity. */
function heroLabel(severity: string): string {
    switch (severity) {
        case "up":
            return "All systems operational";
        case "down":
            return "Major outage";
        case "degraded":
            return "Partially degraded";
        case "maintenance":
            return "Under maintenance";
        default:
            return "Status unavailable";
    }
}

/**
 * Incident bodies arrive as markdown/HTML. Strip tags rather than injecting
 * untrusted HTML into the page.
 */
function stripTags(value: string): string {
    return String(value ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function formatDate(value: string): string {
    const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}
