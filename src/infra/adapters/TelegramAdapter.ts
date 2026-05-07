export class TelegramService {
    static getAlertBotToken(): string {
        return this.ALERT_BOT_TOKEN;
    }

    private static get ALERT_BOT_TOKEN(): string {
        return process.env.TELEGRAM_BOT_TOKEN || "";
    }

    private static get LOG_BOT_TOKEN(): string {
        return process.env.TELEGRAM_LOG_BOT_TOKEN || "";
    }

    private static get CHAT_ID(): string {
        return process.env.TELEGRAM_CHAT_ID || "";
    }

    private static sanitizeMarkdown(text: string): string {
        // Escape characters reserved in MarkdownV2 (and legacy Markdown where applicable)
        // Characters to escape: _ * [ ] ( ) ~ > # + - = | { } . !
        return text.replace(/[_*[\]()~>#+\-=|{}.!]/g, '\\$&');
    }

    private static async send(token: string, message: string) {
        if (!token || !this.CHAT_ID) {
            console.warn("⚠️ Telegram skipped: Missing TOKEN or CHAT_ID in .env");
            return;
        }

        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        // Auto-sanitize message to prevent "Bad Request: can't parse entities"
        // We assume the input message is NOT pre-formatted markdown, or if it is, 
        // we might break it. Ideally, we should only sanitize dynamic content.
        // BUT for error reporting, reliability > formatting.
        // Let's try to be smart: if it contains "**", assume it's bold and don't escape *
        // This is a simple heuristic. For robust solution, we'd need a proper builder.
        // For now, let's just escape everything that looks like an error stack trace.

        // BETTER APPROACH: Use 'Markdown' mode but be careful. 
        // If we want to support bolding with **, we shouldn't escape *.
        // But stack traces often have _.

        // Let's sanitize ONLY if it looks like a raw error (contains "Error:")
        let finalMessage = message;
        if (message.includes("Error:") || message.includes("Stack:")) {
            // It's likely an error dump, sanitize everything to be safe
            // But wait, we want to keep the "⚠️ **TITLE**" part.
            // Strategy: Split by newlines. Sanitize lines that look like code/errors.
            // Too complex.

            // Simple Strategy: 
            // 1. Replace all `_` with `\_` (Fixes most variable name issues)
            // 2. Replace `[` and `]` with `\[` `\]` (Fixes array issues)
            finalMessage = message
                .replace(/_/g, '\\_')
                .replace(/\[/g, '\\[')
                .replace(/\]/g, '\\]');
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this.CHAT_ID,
                    text: finalMessage,
                    parse_mode: 'Markdown'
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.text();
                console.warn(`⚠️ Telegram API Error: ${err}`);

                // Fallback: If Markdown fails, send as plain text
                if (err.includes("can't parse entities")) {
                    console.warn("⚠️ Retrying as Plain Text...");
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: this.CHAT_ID,
                            text: message, // Original message
                            // parse_mode: undefined // Plain text
                        })
                    });
                }
            }
        } catch (error) {
            console.error("❌ Error en Telegram Gateway:", error);
        }
    }

    static async sendAlert(message: string) {
        await this.send(this.ALERT_BOT_TOKEN, message);
    }

    static async sendPlainTextToChat(chatId: string, message: string, token = this.ALERT_BOT_TOKEN) {
        if (!token || !chatId) {
            console.warn("⚠️ Telegram plain text skipped: Missing TOKEN or chatId");
            return;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
        } catch (error) {
            console.error("❌ Error en Telegram Plain Text Gateway:", error);
        }
    }

    static async sendSystemLog(message: string) {
        // Si no hay bot de logs definido, usa el de alertas por defecto (fallback)
        const token = this.LOG_BOT_TOKEN || this.ALERT_BOT_TOKEN;
        console.log(`[TelegramService] Sending System Log to token ending in ...${token.slice(-4)}`);
        await this.send(token, `🛠️ *SYSTEM LOG* 🛠️\n\n${message}`);
    }
}
