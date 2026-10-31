/** Keep small fleets together; narrow screens scroll instead of hiding hosts.
 * Explicit perPage links remain available for custom kiosk configurations.
 */
export function fleetPageSize(cols: number, rows: number, override: number | null = null): number {
    return override ?? Math.max(10, cols * rows);
}
