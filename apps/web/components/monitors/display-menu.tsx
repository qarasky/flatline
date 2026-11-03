"use client";

import { SlidersHorizontal } from "lucide-react";

import {
    Button,
    Menu,
    MenuContent,
    MenuLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
} from "@qarasky/kore-ui";

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
        <Menu>
            <MenuTrigger asChild>
                <Button size="sm">
                    <SlidersHorizontal />
                    Display
                </Button>
            </MenuTrigger>
            <MenuContent align="end">
                <MenuLabel>Sort</MenuLabel>
                <MenuRadioGroup value={sort} onValueChange={(value) => onSort(value as SortKey)}>
                    {SORT_KEYS.map((option) => (
                        <MenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                        </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuLabel>Rows</MenuLabel>
                <MenuRadioGroup value={density} onValueChange={(value) => onDensity(value as Density)}>
                    <MenuRadioItem value="comfortable">Comfortable</MenuRadioItem>
                    <MenuRadioItem value="compact">Compact</MenuRadioItem>
                </MenuRadioGroup>
            </MenuContent>
        </Menu>
    );
}
