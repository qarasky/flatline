import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Input primitive.
 */
export function Input({ className, ...props }: InputProps) {
    return (
        <input
            className={cn(
                "h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-sm text-foreground",
                "placeholder:text-quiet focus-visible:outline-none",
                className
            )}
            {...props}
        />
    );
}
