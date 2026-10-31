import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
    {
        variants: {
            tone: {
                up: "text-ok bg-ok/15",
                down: "text-bad bg-bad/15",
                degraded: "text-warn bg-warn/15",
                maintenance: "text-maint bg-maint/15",
                neutral: "text-muted-foreground bg-muted/15",
            },
        },
        defaultVariants: {
            tone: "neutral",
        },
    }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/**
 * Status badge. Always renders a word next to the colour, never colour alone:
 * colour is unreliable for a colourblind operator and a wrong hue should not
 * be the only signal.
 */
export function Badge({ className, tone, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ tone, className }))} {...props} />;
}
