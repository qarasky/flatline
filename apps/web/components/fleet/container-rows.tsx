import { containerIssue, containerStatsSummary, containerTone, type FleetContainer } from "@/lib/fleet-presentation";

const SYMBOLS = { up: "●", stopped: "■", bad: "!", pending: "◐" };

/** State and health, as a person would say it. */
function stateText(container: FleetContainer): string {
    return `${container.state ?? "unknown"}${container.health ? ` · ${container.health}` : ""}`;
}

/**
 * One container per row: the full name plus what it is doing.
 *
 * A failing container shows the state that failed (unhealthy, restarting,
 * dead). A healthy one shows its live CPU/memory instead, since it only earns
 * a row when it is among the busiest. Names are never truncated: an operator
 * hunting for "worker-ingest-3" must not have to hover to tell it apart from
 * "worker-ingest-8". The tooltip carries the image and the full stats either
 * way.
 */
function Row({ container }: { container: FleetContainer }) {
    const tone = containerTone(container);
    const failed = containerIssue(container);
    const stats = containerStatsSummary(container.stats);
    const state = stateText(container);
    const detail = failed ? state : (stats?.label ?? "");
    const description = `${container.name ?? "?"}: ${state}${stats ? `, ${stats.title}` : ""}${container.image ? ` · ${container.image}` : ""}`;
    return (
        <li className="fleet-container-row" data-tone={tone} title={description} aria-label={description}>
            <span className="fleet-container-symbol" aria-hidden="true">
                {SYMBOLS[tone]}
            </span>
            <span className="fleet-container-name">{container.name ?? "?"}</span>
            {detail ? (
                <span className="fleet-container-state tnum" aria-hidden="true">
                    {detail}
                </span>
            ) : null}
        </li>
    );
}

/**
 * The card's container rows, already chosen and bounded by containerRows
 * (failing first, stopped never). The caller decides whether the section
 * shows at all.
 */
export function ContainerRows({ containers }: { containers: FleetContainer[] }) {
    return (
        <ul className="fleet-container-rows">
            {containers.map((container, i) => (
                <Row key={`${container.name}-${i}`} container={container} />
            ))}
        </ul>
    );
}
