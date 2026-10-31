"use client";

import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SORT_KEYS, type SortKey } from "@/lib/board-model";
import type { Density } from "@/lib/board-url";

/** Plane's "Display": how the list is ordered and how tall its rows are. */
export function DisplayMenu({
    sort,
    onSort,
    density,
    onDensity,
}: {
    sort: SortKey;
    onSort: (sort: SortKey) => void;
    density: Density;
    onDensity: (density: Density) => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                    <SlidersHorizontal />
                    Display
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>Sort</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSort(value as SortKey)}>
                    {SORT_KEYS.map((option) => (
                        <DropdownMenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Rows</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={density} onValueChange={(value) => onDensity(value as Density)}>
                    <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
