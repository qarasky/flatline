"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { CommandPalette as KoreCommandPalette } from "@qarasky/kore-ui";

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
    const groups = useMemo(() => buildCommands(monitors, me), [monitors, me]);

    useEffect(() => {
        function onOpen() {
            setOpen(true);
        }
        window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    }, []);

    // A navigation closes it.
    useEffect(() => setOpen(false), [pathname]);

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
        <KoreCommandPalette
            open={open}
            onOpenChange={setOpen}
            title="Search"
            placeholder="Jump to a monitor, server or section…"
            emptyText="Nothing matches."
            groups={groups.map((group) => ({
                heading: group.heading,
                commands: group.commands.map((command) => ({
                    id: command.id,
                    label: command.label,
                    description: group.heading !== "Actions" && command.keywords[0] ? command.keywords[0] : undefined,
                    keywords: command.keywords,
                    onSelect: () => void run(command),
                })),
            }))}
        />
    );
}
