import { describe, expect, it } from "vitest";

import { MIN_PASSWORD_CHARS, passwordProblem } from "@/lib/password";

describe("passwordProblem", () => {
    it("asks for at least ten characters", () => {
        expect(MIN_PASSWORD_CHARS).toBe(10);
        expect(passwordProblem("123456789", "123456789")).toBe("Use at least 10 characters.");
    });

    it("asks for the two entries to match", () => {
        expect(passwordProblem("correct horse", "correct hors")).toBe("The passwords do not match.");
    });

    it("accepts a long, matching password", () => {
        expect(passwordProblem("correct horse", "correct horse")).toBeNull();
    });
});
