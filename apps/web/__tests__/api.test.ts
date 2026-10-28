import { describe, expect, it } from "vitest";

import { requestInit } from "@/lib/api";

describe("requestInit", () => {
    it("sends the cookie's token as a bearer header on the server", () => {
        expect(requestInit({ server: true, token: "flatline_op_x", method: "GET" }).headers).toMatchObject({
            Authorization: "Bearer flatline_op_x",
        });
    });

    it("lets the browser send the cookie and marks writes for CSRF", () => {
        const post = requestInit({ server: false, method: "POST", body: { a: 1 } });
        expect(post.credentials).toBe("same-origin");
        expect(post.headers).toMatchObject({ "X-Flatline-CSRF": "1", "Content-Type": "application/json" });
        expect(post.body).toBe('{"a":1}');
    });

    it("adds no CSRF header to browser reads", () => {
        expect(requestInit({ server: false, method: "GET" }).headers).not.toHaveProperty("X-Flatline-CSRF");
    });

    it("adds no CSRF header on the server, which uses the bearer header", () => {
        expect(requestInit({ server: true, method: "POST" }).headers).not.toHaveProperty("X-Flatline-CSRF");
    });
});
