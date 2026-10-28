import Link from "next/link";
import { Fragment } from "react";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export interface Crumb {
    label: string;
    href?: string;
}

/** The thin bar at the top of every admin page: breadcrumbs left, actions right. */
export function PageHeader({ crumbs, actions }: { crumbs: Crumb[]; actions?: React.ReactNode }) {
    return (
        <header className="bg-background sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
                <ol className="flex items-center gap-1.5 truncate">
                    {crumbs.map((crumb, index) => {
                        const last = index === crumbs.length - 1;
                        return (
                            <Fragment key={`${crumb.label}-${index}`}>
                                {index > 0 && (
                                    <li aria-hidden className="text-muted-foreground/60">
                                        /
                                    </li>
                                )}
                                <li className={last ? "text-foreground truncate font-medium" : "text-muted-foreground"}>
                                    {crumb.href && !last ? (
                                        <Link href={crumb.href} className="hover:text-foreground">
                                            {crumb.label}
                                        </Link>
                                    ) : (
                                        <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
                                    )}
                                </li>
                            </Fragment>
                        );
                    })}
                </ol>
            </nav>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
    );
}
