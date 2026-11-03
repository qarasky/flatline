import {
    Activity,
    Bell,
    DatabaseBackup,
    Inbox,
    KeyRound,
    MonitorPlay,
    Server,
    Users,
    type LucideIcon,
} from "lucide-react";

export type NavId =
    "attention" | "monitors" | "servers" | "backups" | "notifications" | "tokens" | "members" | "superboard";

export interface NavSection {
    id: NavId;
    label: string;
    href: string;
    icon: LucideIcon;
    /** Opens as a full page of its own, outside the admin layout. */
    external?: boolean;
}

/** The sidebar's sections, in order. */
export const NAV_SECTIONS: readonly NavSection[] = [
    { id: "attention", label: "Attention", href: "/attention", icon: Inbox },
    { id: "monitors", label: "Monitors", href: "/monitors", icon: Activity },
    { id: "servers", label: "Servers", href: "/servers", icon: Server },
    { id: "backups", label: "Backups", href: "/backups", icon: DatabaseBackup },
    { id: "notifications", label: "Notifications", href: "/notifications", icon: Bell },
    { id: "tokens", label: "Tokens", href: "/tokens", icon: KeyRound },
    { id: "members", label: "Members", href: "/members", icon: Users },
    { id: "superboard", label: "Superboard", href: "/superboard", icon: MonitorPlay, external: true },
];

/** The section a path belongs to, or null outside the sections. */
export function activeSection(pathname: string): NavId | null {
    const path = pathname.split(/[?#]/, 1)[0];
    const section = NAV_SECTIONS.find((s) => path === s.href || path.startsWith(`${s.href}/`));
    return section?.id ?? null;
}
