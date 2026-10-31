"use client";

import { useEffect, useState } from "react";

/**
 * Whether a media query matches. False on the server and in the first
 * browser render (so both agree), then the real answer after mount.
 */
export function useMedia(query: string): boolean {
    const [matches, setMatches] = useState(false);
    useEffect(() => {
        const list = window.matchMedia(query);
        setMatches(list.matches);
        const onChange = () => setMatches(list.matches);
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
    }, [query]);
    return matches;
}
