import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => ({ value: "flatline_op_revoked" }) }),
    headers: async () => new Headers({ "x-flatline-path": "/servers?x=1" }),
}));

const { api, ApiError } = await import("@/lib/api");

function answer(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("api on the server", () => {
    beforeEach(() => {
        redirect.mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends a rejected session to sign-in on any page, not just the layout", async () => {
        vi.stubGlobal("fetch", answer(401, { ok: false, error: "unauthorized", message: "no" }));
        await expect(api("/api/v1/monitors")).rejects.toThrow("NEXT_REDIRECT");
        expect(redirect).toHaveBeenCalledWith("/sign-in?expired=1&next=%2Fservers%3Fx%3D1");
    });

    it("leaves other failures to the page's error boundary", async () => {
        vi.stubGlobal("fetch", answer(503, { ok: false, error: "unavailable", message: "busy" }));
        await expect(api("/api/v1/monitors")).rejects.toBeInstanceOf(ApiError);
        expect(redirect).not.toHaveBeenCalled();
    });
});
