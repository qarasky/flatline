import type { CSSProperties } from "react";
import { containerStatsSummary, containerTileLayout, containerTone, type FleetContainer } from "@/lib/fleet-presentation";

const SYMBOLS = { up: "●", stopped: "■", bad: "!", pending: "◐" };
function Tile({ container }: { container: FleetContainer }) {
    const tone = containerTone(container);
    const stats = containerStatsSummary(container.stats);
    const state = `${container.state ?? "unknown"}${container.health ? ` · ${container.health}` : ""}`;
    const description = `${container.name ?? "?"}: ${state}${stats ? `, ${stats.title}` : ""}${tone === "up" && !container.health ? " (no health check reported)" : ""}${tone === "stopped" ? " (stop reason unknown)" : ""}`;
    return <li className="fleet-container-tile" data-tone={tone} title={`${description}${container.image ? ` · ${container.image}` : ""}`} aria-label={description}>
        <span className="fleet-container-symbol" aria-hidden="true">{SYMBOLS[tone]}</span><span className="truncate">{container.name ?? "?"}</span>
        {stats ? <span className="fleet-container-stats tnum" aria-hidden="true">{stats.label}</span> : null}
    </li>;
}

export function ContainerTiles({ containers }: { containers: FleetContainer[] }) {
    const { pinned, rows, visibleRows, looping } = containerTileLayout(containers);
    const style = { "--container-visible-rows": visibleRows, "--container-loop-duration": `${rows.length * 4}s` } as CSSProperties;
    const renderRows = (copy: boolean) => <div className="fleet-container-loop-block" aria-hidden={copy || undefined}>
        {rows.map((row, index) => <ul className="fleet-container-tile-row" key={index}>{row.map((container, i) => <Tile key={`${container.name}-${i}`} container={container} />)}</ul>)}
    </div>;
    return <div className="fleet-container-list" style={style} tabIndex={looping ? 0 : undefined}
        aria-label={looping ? "Container status tiles. Automatically cycles; hover or focus to pause. Red problems are pinned where space allows." : "Container status tiles"}>
        {pinned.length ? <ul className="fleet-container-pinned">{pinned.map((container, i) => <Tile key={`${container.name}-${i}`} container={container} />)}</ul> : null}
        <div className="fleet-container-viewport">
            <div className="fleet-container-loop" data-looping={looping || undefined}>
                {renderRows(false)}{looping ? renderRows(true) : null}
            </div>
        </div>
    </div>;
}
