"use client";

import { ChevronsUpDown, KeyRound, LogOut, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@/components/ui/sidebar";
import { AttentionCount } from "@/components/attention/attention-list";
import { openCommandPalette } from "@/components/command-palette";
import { api } from "@/lib/api";
import { type Me, displayName, initials } from "@/lib/me";
import { NAV_SECTIONS, activeSection } from "@/lib/nav";
import { PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/session";

export function AppSidebar({ me }: { me: Me }) {
    const pathname = usePathname();
    const router = useRouter();
    const active = activeSection(pathname);
    const name = displayName(me);

    async function signOut() {
        try {
            await api("/api/v1/auth/session", { method: "DELETE" });
        } finally {
            router.replace(SIGN_IN_PATH);
            router.refresh();
        }
    }

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild size="lg" tooltip="Flatline">
                            <Link href="/monitors">
                                {/* The cream pulse mark; the red-orange variant stays off status UI. */}
                                <img src="/icon.svg" alt="" width={24} height={24} className="size-6 shrink-0" />
                                <span className="font-semibold tracking-tight">Flatline</span>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            tooltip="Search (⌘K)"
                            onClick={openCommandPalette}
                            className="text-muted-foreground"
                        >
                            <Search />
                            <span>Search</span>
                            <kbd className="ml-auto text-[11px] tracking-wide group-data-[collapsible=icon]:hidden">
                                ⌘K
                            </kbd>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {NAV_SECTIONS.map((section) => (
                                <SidebarMenuItem key={section.id}>
                                    <SidebarMenuButton asChild isActive={section.id === active} tooltip={section.label}>
                                        {section.external ? (
                                            // A full page load: the Superboard has no sidebar.
                                            <a href={section.href}>
                                                <section.icon />
                                                <span>{section.label}</span>
                                            </a>
                                        ) : (
                                            <Link href={section.href}>
                                                <section.icon />
                                                <span>{section.label}</span>
                                            </Link>
                                        )}
                                    </SidebarMenuButton>
                                    {section.id === "attention" ? <AttentionCount /> : null}
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <SidebarMenuButton tooltip={name}>
                                    <span className="bg-raised flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-medium">
                                        {initials(name)}
                                    </span>
                                    <span className="truncate">{name}</span>
                                    <ChevronsUpDown className="ml-auto" />
                                </SidebarMenuButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start" className="min-w-56">
                                <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
                                    <span className="truncate font-medium">{name}</span>
                                    <span className="text-muted-foreground truncate text-xs">
                                        {me.principal === "account" ? me.account.email : "Signed in with a token"}
                                    </span>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {me.principal === "account" && (
                                    <DropdownMenuItem asChild>
                                        <Link href={PASSWORD_PATH}>
                                            <KeyRound />
                                            Change password
                                        </Link>
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={() => void signOut()}>
                                    <LogOut />
                                    Sign out
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
