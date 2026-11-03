"use client";

import { Ellipsis } from "lucide-react";
import { useState } from "react";

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    IconButton,
    Menu,
    MenuContent,
    MenuItem,
    MenuSeparator,
    MenuTrigger,
} from "@qarasky/kore-ui";

import { ROW_MENU_LABEL, type RowMenuId } from "@/lib/row-menu";

import { useBoardActions } from "./board-context";

/** The `⋯` button's menu. Opening it holds the row order, like hovering the list. */
export function RowMenuButton({ name, monitorId, items }: { name: string; monitorId: number; items: RowMenuId[] }) {
    const actions = useBoardActions();
    const [open, setOpen] = useState(false);
    return (
        <Menu
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                actions.menuOpenChange(next);
            }}
        >
            <MenuTrigger asChild>
                <IconButton
                    label={`Actions for ${name}`}
                    tooltip={false}
                    icon={<Ellipsis />}
                    className="board-reveal"
                    data-open={open || undefined}
                />
            </MenuTrigger>
            <MenuContent align="end">
                {items.map((id) => (
                    <MenuEntry key={id} id={id} kind="dropdown" onSelect={() => actions.menuAction(monitorId, id)} />
                ))}
            </MenuContent>
        </Menu>
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
            <ContextMenuContent>
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
                {destructive ? <MenuSeparator /> : null}
                <MenuItem danger={destructive} onSelect={onSelect}>
                    {ROW_MENU_LABEL[id]}
                </MenuItem>
            </>
        );
    }
    return (
        <>
            {destructive ? <ContextMenuSeparator /> : null}
            <ContextMenuItem danger={destructive} onSelect={onSelect}>
                {ROW_MENU_LABEL[id]}
            </ContextMenuItem>
        </>
    );
}
