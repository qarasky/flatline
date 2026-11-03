"use client";

import {
    AccountMenu,
    AppShell,
    AppSwitcher,
    Kbd,
    MenuItem,
    Sidebar,
    SidebarItem,
    SidebarNav,
    TopBar,
    Wordmark,
} from "@qarasky/kore-ui";
import { KeyRound, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAttentionCount } from "@/components/attention/attention-list";
import { openCommandPalette } from "@/components/command-palette";
import { KORE_APP, KORE_NAMES, SIDEBAR_COOKIE } from "@/lib/kore";
import { type Me, displayName } from "@/lib/me";
import { NAV_SECTIONS, activeSection } from "@/lib/nav";
import { PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/session";
import { type SignInMethods, endSession } from "@/lib/sso";

/** The search field in the top bar: a button that opens the command palette (⌘K). */
function SearchButton() {
    return (
        <button
            type="button"
            onClick={openCommandPalette}
            className="flex min-h-control w-full max-w-[560px] items-center gap-2 rounded-ui bg-raised px-3 text-left text-muted transition-colors hover:text-text"
        >
            <Search aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search monitors, servers and sections</span>
            <Kbd className="max-sm:hidden">⌘K</Kbd>
        </button>
    );
}

/** The attention section's icon, with a red dot while something needs attention and the sidebar shows icons only. */
function AttentionIcon({ icon, count, collapsed }: { icon: React.ReactNode; count: number; collapsed: boolean }) {
    return (
        <span className="relative flex">
            {icon}
            {collapsed && count > 0 ? (
                <span className="absolute -top-1 -right-1 size-2 rounded-full bg-status-down ring-2 ring-bg" />
            ) : null}
        </span>
    );
}

/**
 * The signed-in frame: kore-ui's AppShell with the Flatline sections in a
 * collapsible sidebar, search in the top bar, then the Kore app switcher and
 * the account menu. The collapsed state lives in the `sidebar_state` cookie
 * (read by the layout, so the first render is right) and ⌘B toggles it.
 */
export function AdminShell({
    me,
    methods,
    defaultCollapsed,
    children,
}: {
    me: Me;
    methods: SignInMethods;
    defaultCollapsed: boolean;
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    const router = useRouter();
    const active = activeSection(pathname);
    const attention = useAttentionCount();
    const [collapsed, setCollapsedState] = useState(defaultCollapsed);

    const setCollapsed = useCallback((next: boolean) => {
        setCollapsedState(next);
        document.cookie = `${SIDEBAR_COOKIE}=${next ? "false" : "true"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    }, []);

    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if (
                event.key.toLowerCase() === "b" &&
                (event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                !event.shiftKey
            ) {
                event.preventDefault();
                setCollapsedState((was) => {
                    const next = !was;
                    document.cookie = `${SIDEBAR_COOKIE}=${next ? "false" : "true"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
                    return next;
                });
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    async function signOut() {
        const providerLogout = await endSession();
        if (providerLogout) {
            window.location.assign(providerLogout);
            return;
        }
        router.replace(SIGN_IN_PATH);
        router.refresh();
    }

    const name = displayName(me);
    const user =
        me.principal === "account"
            ? { name, email: me.account.email }
            : { name, email: "Signed in with an operator token" };
    // Without Kore ID there is no Kore ID account page: the menu's account entry opens the password page.
    const accountUrl = methods.accountUrl ?? PASSWORD_PATH;
    const canChangePassword =
        me.principal === "account" && !me.account.sso && methods.localLogin && methods.accountUrl !== null;
    const hasApps = Object.keys(methods.apps).length > 0;

    return (
        <AppShell
            collapsible
            sidebarCollapsed={collapsed}
            onSidebarCollapsedChange={setCollapsed}
            brand={<Wordmark app={KORE_APP} names={KORE_NAMES} />}
            brandHref="/monitors"
            topBar={
                <TopBar
                    actions={
                        <>
                            {hasApps ? (
                                <AppSwitcher
                                    urls={methods.apps}
                                    current={KORE_APP}
                                    names={KORE_NAMES}
                                    accountUrl={methods.accountUrl ?? undefined}
                                />
                            ) : null}
                            <AccountMenu
                                user={user}
                                accountUrl={accountUrl}
                                labels={methods.accountUrl ? undefined : { account: "Change password" }}
                                apps={{ urls: methods.apps, current: KORE_APP, names: KORE_NAMES }}
                                onSignOut={signOut}
                            >
                                {canChangePassword ? (
                                    <MenuItem icon={<KeyRound />} asChild>
                                        <Link href={PASSWORD_PATH}>Change password</Link>
                                    </MenuItem>
                                ) : null}
                            </AccountMenu>
                        </>
                    }
                >
                    <SearchButton />
                </TopBar>
            }
            sidebar={
                <Sidebar>
                    <SidebarNav label="Sections">
                        {NAV_SECTIONS.map((section) => {
                            const Icon = section.icon;
                            const isAttention = section.id === "attention";
                            const count = isAttention ? attention : 0;
                            return (
                                <SidebarItem
                                    key={section.id}
                                    // The Superboard is a full page load: it has no app shell.
                                    LinkComponent={section.external ? PlainLink : undefined}
                                    href={section.href}
                                    active={section.id === active}
                                    icon={
                                        isAttention ? (
                                            <AttentionIcon icon={<Icon />} count={count} collapsed={collapsed} />
                                        ) : (
                                            <Icon />
                                        )
                                    }
                                    trailing={
                                        count > 0 ? (
                                            <span
                                                className="font-medium text-status-down tabular-nums"
                                                aria-label={`${count} need attention`}
                                            >
                                                {count}
                                            </span>
                                        ) : undefined
                                    }
                                    tooltip={count > 0 ? `${section.label} · ${count}` : section.label}
                                >
                                    {section.label}
                                </SidebarItem>
                            );
                        })}
                    </SidebarNav>
                </Sidebar>
            }
        >
            {children}
        </AppShell>
    );
}

/** A plain anchor, for links that must load a whole page. */
function PlainLink({ href, ...props }: React.ComponentProps<"a"> & { href: string }) {
    return <a href={href} {...props} />;
}
