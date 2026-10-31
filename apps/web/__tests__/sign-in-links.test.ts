import { describe, expect, it, vi } from "vitest";

import { deviceSignInHref } from "@/lib/device-api";
import { exchangeTokenForSession } from "@/lib/kiosk-exchange";
import { rootSignInHref } from "@/lib/gate";

describe("deviceSignInHref", () => {
    it("marks the session expired so a dead cookie cannot bounce the phone back", () => {
        expect(deviceSignInHref("abc123")).toBe("/sign-in?expired=1&next=%2Fdevice%23abc123");
        expect(deviceSignInHref(null)).toBe("/sign-in?expired=1&next=%2Fdevice");
    });
});

describe("rootSignInHref", () => {
    it("keeps an old dashboard link through sign-in", () => {
        expect(rootSignInHref("?m=12")).toBe("/sign-in?next=%2F%3Fm%3D12");
        expect(rootSignInHref("")).toBe("/sign-in");
    });
});

describe("exchangeTokenForSession", () => {
    const noWait = async () => {};

    it("retries a failed exchange while it still holds the token", async () => {
        const post = vi
            .fn()
            .mockRejectedValueOnce(new Error("503"))
            .mockRejectedValueOnce(new Error("503"))
            .mockResolvedValue(undefined);
        expect(await exchangeTokenForSession(post, noWait)).toBe(true);
        expect(post).toHaveBeenCalledTimes(3);
    });

    it("gives up after its attempts so the screen can start over", async () => {
        const post = vi.fn().mockRejectedValue(new Error("down"));
        expect(await exchangeTokenForSession(post, noWait, 4)).toBe(false);
        expect(post).toHaveBeenCalledTimes(4);
    });
});
