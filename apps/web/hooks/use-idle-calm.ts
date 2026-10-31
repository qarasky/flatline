"use client";

import { useEffect, useRef, useState } from "react";

import { isCalm } from "@/lib/motion";

/**
 * True after five minutes without input: a wall screen nobody is touching.
 * Non-essential motion switches off; any input switches it back on.
 */
export function useIdleCalm(): boolean {
    const [calm, setCalm] = useState(false);
    const lastInput = useRef(Date.now());
    const calmRef = useRef(false);

    useEffect(() => {
        const onInput = () => {
            lastInput.current = Date.now();
            if (calmRef.current) {
                calmRef.current = false;
                setCalm(false);
            }
        };
        const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
        for (const name of events) {
            window.addEventListener(name, onInput, { passive: true });
        }
        const timer = window.setInterval(() => {
            const next = isCalm(lastInput.current, Date.now());
            if (next !== calmRef.current) {
                calmRef.current = next;
                setCalm(next);
            }
        }, 15_000);
        return () => {
            for (const name of events) {
                window.removeEventListener(name, onInput);
            }
            window.clearInterval(timer);
        };
    }, []);

    return calm;
}
