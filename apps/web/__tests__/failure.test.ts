import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { failureMessage } from "@/lib/failure";

describe("failureMessage", () => {
    it("passes the API's explanation through", () => {
        const error = new ApiError(409, "cannot_remove_self", "You cannot remove your own account.");
        expect(failureMessage(error)).toBe("You cannot remove your own account.");
    });

    it("explains a network failure plainly", () => {
        expect(failureMessage(new TypeError("fetch failed"))).toBe("Could not reach Flatline. Try again.");
    });
});
