"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
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
import { api } from "@/lib/api";
import { NAV_SECTIONS, activeSection } from "@/lib/nav";
import { SIGN_IN_PATH } from "@/lib/session";

export function AppSidebar() {
    const pathname = usePathname();
    const router = useRouter();
    const active = activeSection(pathname);

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
                                <SidebarMenuButton tooltip="Operator">
                                    <span className="bg-raised flex size-5 shrink-0 items-center justify-center rounded text-xs font-medium">
                                        O
                                    </span>
                                    <span>Operator</span>
                                    <ChevronsUpDown className="ml-auto" />
                                </SidebarMenuButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start" className="min-w-48">
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
