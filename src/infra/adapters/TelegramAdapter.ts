export class TelegramService {
    private static get ALERT_BOT_TOKEN(): string {
        return process.env.TELEGRAM_BOT_TOKEN || "";
    }

    private static get LOG_BOT_TOKEN(): string {
        return process.env.TELEGRAM_LOG_BOT_TOKEN || "";
    }

    private static get CHAT_ID(): string {
        return process.env.TELEGRAM_CHAT_ID || "";
    }

    private static async send(token: string, message: string) {
        if (!token || !this.CHAT_ID) {
            console.warn("⚠️ Telegram skipped: Missing TOKEN or CHAT_ID in .env");
            return;
        }

        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this.CHAT_ID,
                    text: message,
                    parse_mode: 'Markdown'
                })
            });

            if (!response.ok) {
                const err = await response.text();
                console.warn(`⚠️ Telegram API Error: ${err}`);
            }
        } catch (error) {
            console.error("❌ Error en Telegram Gateway:", error);
        }
    }

    static async sendAlert(message: string) {
        await this.send(this.ALERT_BOT_TOKEN, message);
    }

    static async sendSystemLog(message: string) {
        // Si no hay bot de logs definido, usa el de alertas por defecto (fallback)
        const token = this.LOG_BOT_TOKEN || this.ALERT_BOT_TOKEN;
        console.log(`[TelegramService] Sending System Log to token ending in ...${token.slice(-4)}`);
        await this.send(token, `🛠️ *SYSTEM LOG* 🛠️\n\n${message}`);
    }
}
