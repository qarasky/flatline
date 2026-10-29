import { describe, expect, it } from "vitest";

import { requestInit } from "@/lib/api";

describe("requestInit", () => {
    it("forwards the session cookie on the server", () => {
        const headers = requestInit({ server: true, session: "fls_x", method: "GET" }).headers;
        expect(headers).toMatchObject({ Cookie: "fl_session=fls_x" });
        expect(headers).not.toHaveProperty("Authorization");
    });

    it("marks server writes for CSRF, since they ride on the cookie too", () => {
        expect(requestInit({ server: true, session: "fls_x", method: "POST" }).headers).toMatchObject({
            "X-Flatline-CSRF": "1",
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

    it("sends no cookie on the server without a session", () => {
        expect(requestInit({ server: true, method: "GET" }).headers).not.toHaveProperty("Cookie");
    });
});
