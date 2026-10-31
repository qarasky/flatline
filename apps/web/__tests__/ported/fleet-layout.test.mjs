import { test } from "vitest";
import assert from "node:assert/strict";
import { fleetPageSize } from "@/lib/fleet-layout";

test("fleets up to ten do not paginate when a tall card allows only one measured row", () => {
    for (const cols of [1, 3, 4, 5]) {
        for (const count of [1, 8, 9, 10]) {
            assert.equal(Math.ceil(count / fleetPageSize(cols, 1)), 1);
        }
    }
});

test("larger fleets paginate while spacious walls and explicit kiosk overrides remain supported", () => {
    assert.equal(Math.ceil(11 / fleetPageSize(5, 1)), 2);
    assert.equal(fleetPageSize(7, 3), 21);
    assert.equal(fleetPageSize(5, 2, 4), 4);
});
