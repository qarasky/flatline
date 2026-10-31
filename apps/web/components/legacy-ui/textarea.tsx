import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Textarea primitive, styled to match Input. */
export function Textarea({ className, ...props }: TextareaProps) {
    return (
        <textarea
            className={cn(
                "w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-foreground",
                "placeholder:text-quiet focus-visible:outline-none",
                className
            )}
            {...props}
        />
    );
}
