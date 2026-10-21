import { AnimatePresence, m } from "motion/react";
import type { Ref } from "react";
import type { Board, BoardNode, GroupNode } from "@/lib/board-model";
import { curve, duration, enterTransition, exitTransition, spring } from "@/lib/motion";
import { useBoardView } from "./board-context";
import { GroupRow } from "./GroupRow";
import { MonitorRow } from "./MonitorRow";

/** Groups with more than this many direct children expand with the slower token. */
const LARGE_GROUP = 10;

const MAX_DEPTH = 8;

/**
 * One node: a monitor row, or a group header with its children.
 *
 * The wrapper animates `layout="position"` so a reorder moves the row instead
 * of teleporting it, and fades in/out when a filter or a new monitor changes
 * who is present. `initial={false}` on the surrounding AnimatePresence means
 * rows that exist on load never animate.
 */
function NodeView({ node, depth, ref }: { node: BoardNode; depth: number; ref?: Ref<HTMLDivElement> }) {
    const view = useBoardView();
    const calm = view.calm;
    const motionProps = calm
        ? {}
        : {
              layout: "position" as const,
              initial: { opacity: 0, y: -4 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, transition: exitTransition(duration.base) },
              transition: { layout: spring, default: enterTransition(duration.base) },
          };

    if (node.kind === "monitor") {
        return (
            <m.div ref={ref} {...motionProps}>
                <MonitorRow
                    monitor={node.monitor}
                    depth={depth}
                    strip={view.strips.get(node.id)}
                    selected={view.selected.has(node.id)}
                    isOpen={view.openId === node.id}
                    menuOpen={view.menuId === node.id}
                    selecting={view.selected.size > 0}
                    flashSeq={view.cueRows.has(node.id) ? view.cueSeq : 0}
                    calm={calm}
                    now={view.now}
                />
            </m.div>
        );
    }

    return (
        <m.div ref={ref} {...motionProps}>
            <GroupBlock group={node} depth={depth} />
        </m.div>
    );
}

function GroupBlock({ group, depth }: { group: GroupNode; depth: number }) {
    const view = useBoardView();
    const expanded = view.forceOpen || !view.collapsed.has(group.id);
    const seconds = group.children.length > LARGE_GROUP ? duration.slow : duration.base;

    return (
        <>
            <GroupRow
                group={group}
                depth={depth}
                expanded={expanded}
                menuOpen={view.menuId === group.id}
                calm={view.calm}
            />
            <AnimatePresence initial={false}>
                {expanded && depth < MAX_DEPTH && group.children.length > 0 ? (
                    <m.div
                        key="children"
                        initial={view.calm ? false : { height: 0, opacity: 0 }}
                        animate={{
                            height: "auto",
                            opacity: 1,
                            transition: { duration: seconds, ease: curve.standard },
                        }}
                        exit={{
                            height: 0,
                            opacity: 0,
                            transition: { duration: seconds * 0.6, ease: curve.exit },
                        }}
                        style={{ overflow: "hidden" }}
                    >
                        <NodeList nodes={group.children} depth={depth + 1} />
                    </m.div>
                ) : null}
            </AnimatePresence>
        </>
    );
}

function NodeList({ nodes, depth }: { nodes: BoardNode[]; depth: number }) {
    return (
        <div className="relative">
            <AnimatePresence initial={false} mode="popLayout">
                {nodes.map((node) => (
                    <NodeView key={`${node.kind}:${node.id}`} node={node} depth={depth} />
                ))}
            </AnimatePresence>
        </div>
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
                        <div className="px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-quiet uppercase">
                            Ungrouped <span className="tnum ml-1 font-normal">{board.ungrouped.length}</span>
                        </div>
                    ) : null}
                    <NodeList nodes={board.ungrouped} depth={0} />
                </>
            ) : null}
        </>
    );
}
