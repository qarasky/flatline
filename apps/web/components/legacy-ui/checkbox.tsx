"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size">;

/**
 * Checkbox primitive. The real input stays in the DOM (visually hidden) so
 * keyboard, form and screen-reader behaviour is the platform's; the box and
 * tick are drawn by the sibling span.
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
    return (
        <span className={cn("ui-checkbox", className)}>
            <input type="checkbox" {...props} />
            <span className="ui-checkbox-box" aria-hidden>
                <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M2.5 6.2 5 8.7l4.5-5" />
                </svg>
            </span>
        </span>
    );
}
