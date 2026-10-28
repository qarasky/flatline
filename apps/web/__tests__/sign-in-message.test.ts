import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { signInMessage } from "@/lib/legacy-token";

describe("signInMessage", () => {
    it("passes the API's explanation through", () => {
        const error = new ApiError(401, "agent_token_on_operator_api", "That is a host-agent token…");
        expect(signInMessage(error)).toBe("That is a host-agent token…");
    });

    it("explains a network failure plainly", () => {
        expect(signInMessage(new TypeError("fetch failed"))).toBe("Could not reach Flatline. Try again.");
    });
});
