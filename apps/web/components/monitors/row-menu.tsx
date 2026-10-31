"use client";

import { Ellipsis } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROW_MENU_LABEL, type RowMenuId } from "@/lib/row-menu";

import { useBoardActions } from "./board-context";

/** The `⋯` button's menu. Opening it holds the row order, like hovering the list. */
export function RowMenuButton({ name, monitorId, items }: { name: string; monitorId: number; items: RowMenuId[] }) {
    const actions = useBoardActions();
    const [open, setOpen] = useState(false);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                actions.menuOpenChange(next);
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Actions for ${name}`}
                    className="board-reveal"
                    data-open={open || undefined}
                >
                    <Ellipsis />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
                {items.map((id) => (
                    <MenuEntry key={id} id={id} kind="dropdown" onSelect={() => actions.menuAction(monitorId, id)} />
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Right-click on a row opens the same items. */
export function RowContextMenu({
    monitorId,
    items,
    children,
}: {
    monitorId: number;
    items: RowMenuId[];
    children: React.ReactNode;
}) {
    const actions = useBoardActions();
    return (
        <ContextMenu onOpenChange={actions.menuOpenChange}>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
                {items.map((id) => (
                    <MenuEntry key={id} id={id} kind="context" onSelect={() => actions.menuAction(monitorId, id)} />
                ))}
            </ContextMenuContent>
        </ContextMenu>
    );
}

function MenuEntry({ id, kind, onSelect }: { id: RowMenuId; kind: "dropdown" | "context"; onSelect: () => void }) {
    const destructive = id === "delete";
    if (kind === "dropdown") {
        return (
            <>
                {destructive ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem variant={destructive ? "destructive" : "default"} onSelect={onSelect}>
                    {ROW_MENU_LABEL[id]}
                </DropdownMenuItem>
            </>
        );
    }
    return (
        <>
            {destructive ? <ContextMenuSeparator /> : null}
            <ContextMenuItem variant={destructive ? "destructive" : "default"} onSelect={onSelect}>
                {ROW_MENU_LABEL[id]}
            </ContextMenuItem>
        </>
    );
}
