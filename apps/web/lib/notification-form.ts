import type { NotificationRecord } from "@/lib/notifications-api";

/** What the notification form edits (Telegram, the only kind). */
export interface NotificationValues {
    name: string;
    /** Empty when editing means "keep the stored token". */
    botToken: string;
    chatId: string;
    threadId: string;
    silent: boolean;
    protect: boolean;
    isDefault: boolean;
    active: boolean;
}

/** The form's starting values; a stored bot token is never shown. */
export function notificationValues(record?: NotificationRecord | null): NotificationValues {
    const config = record?.config ?? {};
    const text = (key: string) =>
        typeof config[key] === "string" || typeof config[key] === "number" ? String(config[key]) : "";
    return {
        name: record?.name ?? "",
        botToken: "",
        chatId: text("telegramChatID"),
        threadId: text("telegramMessageThreadID"),
        silent: config.telegramSendSilently === true,
        protect: config.telegramProtectContent === true,
        isDefault: record?.isDefault ?? false,
        active: record?.active ?? true,
    };
}

/**
 * The create or update body. When editing, settings the form does not show
 * (an imported `telegramServerUrl`, say) are carried over, since the API
 * replaces `config` whole; the bot-token field left empty sends no token, so
 * the backend keeps the stored one.
 */
export function notificationBody(
    values: NotificationValues,
    /** The notification being edited; null when creating. */
    record: NotificationRecord | null
): { name: string; type: "telegram"; active: boolean; isDefault: boolean; config: Record<string, unknown> } {
    const config: Record<string, unknown> = {
        ...(record?.config ?? {}),
        telegramChatID: values.chatId.trim(),
        telegramSendSilently: values.silent,
        telegramProtectContent: values.protect,
    };
    const token = values.botToken.trim();
    if (token || !record) {
        config.telegramBotToken = token;
    }
    // Telegram's topic id is an integer; anything else is passed through for the API to judge.
    const thread = values.threadId.trim();
    if (thread) {
        config.telegramMessageThreadID = /^-?\d+$/.test(thread) ? Number(thread) : thread;
    } else {
        delete config.telegramMessageThreadID;
    }
    return { name: values.name.trim(), type: "telegram", active: values.active, isDefault: values.isDefault, config };
}
