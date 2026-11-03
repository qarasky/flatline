"use client";

/*
 * cmdk, dressed in kore-ui's tokens: kore-ui has no command palette, so this
 * is the one local primitive left. The input reads like kore-ui's Input, the
 * items like its menu items (40px, white 5% highlight, muted icons), group
 * headings like MenuLabel.
 */
import { cn, controlClass } from "@qarasky/kore-ui";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            className={cn("flex h-full w-full flex-col overflow-hidden text-text", className)}
            {...props}
        />
    );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <div className="relative px-5 pb-3">
            <span className="pointer-events-none absolute inset-y-0 left-8 flex items-center pb-3 text-muted">
                <SearchIcon aria-hidden className="size-4" />
            </span>
            <CommandPrimitive.Input className={cn(controlClass, "min-h-control py-1.5 pl-9", className)} {...props} />
        </div>
    );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            className={cn(
                "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto border-t border-border py-1",
                className
            )}
            {...props}
        />
    );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
    return <CommandPrimitive.Empty className="px-5 py-6 text-center text-muted" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            className={cn(
                "overflow-hidden [&_[cmdk-group-heading]]:px-5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted",
                className
            )}
            {...props}
        />
    );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            className={cn(
                "relative flex min-h-control cursor-default items-center gap-3 px-5 outline-none select-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-white/5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted",
                className
            )}
            {...props}
        />
    );
}
