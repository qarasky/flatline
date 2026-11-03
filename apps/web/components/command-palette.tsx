"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Dialog, DialogContent } from "@qarasky/kore-ui";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { buildCommands, type Command as PaletteCommand } from "@/lib/commands";
import type { Me } from "@/lib/me";
import { endSession } from "@/lib/sso";
import { SIGN_IN_PATH } from "@/lib/session";

/** Window event the top bar's search button sends to open the palette. */
export const OPEN_PALETTE_EVENT = "flatline:command-palette";

/** Open the palette from anywhere (the top bar's search button). */
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
            const providerLogout = await endSession();
            if (providerLogout) {
                window.location.assign(providerLogout);
                return;
            }
            router.replace(SIGN_IN_PATH);
            router.refresh();
            return;
        }
        router.push(command.href);
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
                data-command-palette
                title="Search"
                description="Jump to a section, monitor or server, or run an action."
                size="lg"
                className="pb-1"
                showClose={false}
                onOpenAutoFocus={(event) => {
                    // The search field, not the first button, takes focus.
                    event.preventDefault();
                    (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>("[cmdk-input]")?.focus();
                }}
            >
                <Command>
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Jump to a monitor, server or section…"
                    />
                    <CommandList className="max-h-[min(60svh,480px)]">
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
                                                <span className="ml-auto truncate text-meta text-muted">
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
