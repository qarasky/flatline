"use client";

import type { Board, BoardNode, GroupNode } from "@/lib/board-model";

import { useBoardView } from "./board-context";
import { GroupRow } from "./group-row";
import { MonitorRow } from "./monitor-row";

const MAX_DEPTH = 8;

function NodeView({ node, depth }: { node: BoardNode; depth: number }) {
    const view = useBoardView();
    if (node.kind === "monitor") {
        return (
            <MonitorRow
                monitor={node.monitor}
                depth={depth}
                strip={view.strips.get(node.id)}
                selected={view.selected.has(node.id)}
                isOpen={view.openId === node.id}
                isCursor={view.cursorId === node.id}
                flashSeq={view.cueRows.has(node.id) ? view.cueSeq : 0}
                calm={view.calm}
                now={view.now}
            />
        );
    }
    return <GroupBlock group={node} depth={depth} />;
}

function GroupBlock({ group, depth }: { group: GroupNode; depth: number }) {
    const view = useBoardView();
    const expanded = view.forceOpen || !view.collapsed.has(group.id);
    return (
        <>
            <GroupRow group={group} depth={depth} expanded={expanded} isCursor={view.cursorId === group.id} />
            {expanded && depth < MAX_DEPTH && group.children.length > 0 ? (
                <NodeList nodes={group.children} depth={depth + 1} />
            ) : null}
        </>
    );
}

function NodeList({ nodes, depth }: { nodes: BoardNode[]; depth: number }) {
    return (
        <>
            {nodes.map((node) => (
                <NodeView key={`${node.kind}:${node.id}`} node={node} depth={depth} />
            ))}
        </>
    );
}

/** The group tree. Ungrouped monitors follow the groups under their own quiet header. */
export function BoardTree({ board }: { board: Board }) {
    return (
        <>
            <NodeList nodes={board.roots} depth={0} />
            {board.ungrouped.length > 0 ? (
                <>
                    {board.roots.length > 0 ? (
                        <div className="text-muted-foreground px-4 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase">
                            Ungrouped <span className="ml-1 font-normal tabular-nums">{board.ungrouped.length}</span>
                        </div>
                    ) : null}
                    <NodeList nodes={board.ungrouped} depth={0} />
                </>
            ) : null}
        </>
    );
}
