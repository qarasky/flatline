import { test } from "vitest";
import assert from "node:assert/strict";
import { isDeviceApprovePath } from "@/lib/routes";

test("isDeviceApprovePath matches /device with or without a trailing slash", () => {
    assert.equal(isDeviceApprovePath("/device"), true);
    assert.equal(isDeviceApprovePath("/device/"), true);
});

test("isDeviceApprovePath rejects every other path", () => {
    for (const path of ["/", "/devices", "/device/x", "/superboard", "/superboard/kiosk", "/status/device"]) {
        assert.equal(isDeviceApprovePath(path), false, path);
    }
});
