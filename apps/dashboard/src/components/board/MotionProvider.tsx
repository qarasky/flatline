import type { ReactNode } from "react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";

/**
 * Motion for the dashboard route only.
 *
 * `domMax` (not `domAnimation`) because the list reorders with `layout`. It is
 * imported here, and this file is imported only by the Dashboard, so the
 * library lives in the dashboard chunk and never in the entry, Superboard or
 * status-page chunks. `strict` makes any accidental full `motion.*` import
 * throw instead of silently bundling the whole library.
 *
 * `reducedMotion="user"` removes transform and layout animation when the OS
 * asks for it; opacity and colour feedback stay.
 */
export function MotionProvider({
    children,
    reducedMotion = "user",
}: {
    children: ReactNode;
    reducedMotion?: "user" | "always" | "never";
}) {
    return (
        <LazyMotion features={domMax} strict>
            <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
        </LazyMotion>
    );
}
