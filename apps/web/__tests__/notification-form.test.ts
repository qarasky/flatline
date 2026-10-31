import { describe, expect, it } from "vitest";

import { notificationBody, notificationValues, type NotificationValues } from "@/lib/notification-form";
import type { NotificationRecord } from "@/lib/notifications-api";

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

const stored: NotificationRecord = {
    id: 3,
    name: "Ops",
    type: "telegram",
    active: true,
    isDefault: false,
    config: {
        telegramChatID: "-100",
        telegramMessageThreadID: 9,
        telegramServerUrl: "https://tg.proxy",
        telegramUseTemplate: true,
    },
    monitorIds: [],
};

describe("notificationBody", () => {
    it("leaves an empty bot token out when editing, so the stored one is kept", () => {
        const body = notificationBody(values, stored);
        expect(body.config).not.toHaveProperty("telegramBotToken");
        expect(body).toMatchObject({ name: "Ops", type: "telegram", active: true, isDefault: false });
        expect(body.config).toMatchObject({
            telegramChatID: "-100",
            telegramProtectContent: true,
            telegramSendSilently: false,
        });
    });

    it("sends a new bot token, trimmed", () => {
        expect(notificationBody({ ...values, botToken: " 123:abc " }, stored).config.telegramBotToken).toBe("123:abc");
    });

    it("sends the topic only when one is set", () => {
        expect(notificationBody(values, null).config).not.toHaveProperty("telegramMessageThreadID");
        expect(notificationBody({ ...values, threadId: "42" }, null).config.telegramMessageThreadID).toBe(42);
    });

    it("keeps stored settings the form does not show when editing", () => {
        const body = notificationBody(notificationValues(stored), stored);
        expect(body.config).toMatchObject({ telegramServerUrl: "https://tg.proxy", telegramUseTemplate: true });
        expect(body.config.telegramMessageThreadID).toBe(9);
        expect(body.config).not.toHaveProperty("telegramBotToken");
    });

    it("drops the topic when the field is cleared", () => {
        const body = notificationBody({ ...notificationValues(stored), threadId: "" }, stored);
        expect(body.config).not.toHaveProperty("telegramMessageThreadID");
        expect(body.config.telegramServerUrl).toBe("https://tg.proxy");
    });
});
