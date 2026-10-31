"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { buildCommands, type Command as PaletteCommand } from "@/lib/commands";
import type { Me } from "@/lib/me";
import { SIGN_IN_PATH } from "@/lib/session";

/** Window event the sidebar's search button sends to open the palette. */
export const OPEN_PALETTE_EVENT = "flatline:command-palette";

/** Open the palette from anywhere (the sidebar button). */
export function openCommandPalette(): void {
    window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

/**
 * ⌘K / Ctrl+K: jump to any section, monitor or server, or run a main
 * action. Works from anywhere in the admin area, text fields included, but
 * never opens over another dialog.
 */
export function CommandPalette({ me }: { me: Me }) {
    const router = useRouter();
    const pathname = usePathname();
    const { monitors } = useBoardData();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const groups = useMemo(() => buildCommands(monitors, me), [monitors, me]);

    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if (
                event.key.toLowerCase() !== "k" ||
                !(event.metaKey || event.ctrlKey) ||
                event.altKey ||
                event.shiftKey
            ) {
                return;
            }
            event.preventDefault();
            setOpen((wasOpen) => {
                // Another open dialog wins; the palette's own closing animation does not count.
                if (
                    !wasOpen &&
                    document.querySelector('[role="dialog"][data-state="open"]:not([data-command-palette])')
                ) {
                    return false;
                }
                return !wasOpen;
            });
        }
        function onOpen() {
            setOpen(true);
        }
        window.addEventListener("keydown", onKey, true);
        window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
        };
    }, []);

    // A navigation closes it.
    useEffect(() => setOpen(false), [pathname]);

    // Each opening starts empty, even when it reopens during the close animation.
    useEffect(() => {
        if (open) {
            setQuery("");
        }
    }, [open]);

    async function run(command: PaletteCommand) {
        setOpen(false);
        if (command.id === "sign-out") {
            try {
                await api("/api/v1/auth/session", { method: "DELETE" });
            } finally {
                router.replace(SIGN_IN_PATH);
                router.refresh();
            }
            return;
        }
        router.push(command.href);
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent data-command-palette className="overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
                <DialogTitle className="sr-only">Command palette</DialogTitle>
                <DialogDescription className="sr-only">
                    Jump to a section, monitor or server, or run an action.
                </DialogDescription>
                <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group]]:px-1.5">
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Jump to a monitor, server or section…"
                    />
                    <CommandList className="max-h-[60svh]">
                        <CommandEmpty>Nothing matches.</CommandEmpty>
                        {groups.map((group) =>
                            group.commands.length > 0 ? (
                                <CommandGroup key={group.heading} heading={group.heading}>
                                    {group.commands.map((command) => (
                                        <CommandItem
                                            key={command.id}
                                            value={`${group.heading} ${command.label} ${command.id}`}
                                            keywords={command.keywords}
                                            onSelect={() => void run(command)}
                                        >
                                            <span className="truncate">{command.label}</span>
                                            {command.keywords[0] && group.heading !== "Actions" ? (
                                                <span className="text-muted-foreground ml-auto truncate text-xs">
                                                    {command.keywords[0]}
                                                </span>
                                            ) : null}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            ) : null
                        )}
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
