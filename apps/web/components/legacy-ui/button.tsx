import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                outline: "border border-border bg-transparent hover:bg-surface",
                ghost: "hover:bg-surface",
                destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            },
            size: {
                default: "h-8 px-3",
                sm: "h-7 px-2 text-xs",
                icon: "size-8",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

/**
 * Button primitive, shadcn-shaped so vendored components compose with it.
 */
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
    const Comp = asChild ? Slot.Root : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { buttonVariants };
