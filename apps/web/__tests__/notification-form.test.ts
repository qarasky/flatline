import { describe, expect, it } from "vitest";

import { notificationBody, type NotificationValues } from "@/lib/notification-form";

const values: NotificationValues = {
    name: " Ops ",
    botToken: "",
    chatId: " -100 ",
    threadId: "",
    silent: false,
    protect: true,
    isDefault: false,
    active: true,
};

describe("notificationBody", () => {
    it("leaves an empty bot token out when editing, so the stored one is kept", () => {
        const body = notificationBody(values, true);
        expect(body.config).not.toHaveProperty("telegramBotToken");
        expect(body).toMatchObject({ name: "Ops", type: "telegram", active: true, isDefault: false });
        expect(body.config).toMatchObject({
            telegramChatID: "-100",
            telegramProtectContent: true,
            telegramSendSilently: false,
        });
    });

    it("sends a new bot token, trimmed", () => {
        expect(notificationBody({ ...values, botToken: " 123:abc " }, true).config.telegramBotToken).toBe("123:abc");
    });

    it("sends the topic only when one is set", () => {
        expect(notificationBody(values, false).config).not.toHaveProperty("telegramMessageThreadID");
        expect(notificationBody({ ...values, threadId: "42" }, false).config.telegramMessageThreadID).toBe(42);
    });
});
