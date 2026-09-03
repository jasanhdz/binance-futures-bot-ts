export class TelegramService {
  private static readonly MAX_MESSAGE_LENGTH = 3900;
  static getAlertBotToken(): string {
    return this.ALERT_BOT_TOKEN;
  }

  private static get ALERT_BOT_TOKEN(): string {
    return process.env.TELEGRAM_BOT_TOKEN || '';
  }

  private static get LOG_BOT_TOKEN(): string {
    return process.env.TELEGRAM_LOG_BOT_TOKEN || '';
  }

  private static get CHAT_ID(): string {
    return process.env.TELEGRAM_CHAT_ID || '';
  }

  private static escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private static formatForTelegram(message: string): string {
    return this.escapeHtml(message)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  private static async send(token: string, message: string) {
    if (!token || !this.CHAT_ID) {
      console.warn('⚠️ Telegram skipped: Missing TOKEN or CHAT_ID in .env');
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const formattedMessage = this.formatForTelegram(message);
    const messageTooLong = formattedMessage.length > this.MAX_MESSAGE_LENGTH;
    const finalMessage = messageTooLong
      ? `${message.slice(0, this.MAX_MESSAGE_LENGTH - 16)}\n[message truncated]`
      : formattedMessage;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.CHAT_ID,
          text: finalMessage,
          ...(messageTooLong ? {} : { parse_mode: 'HTML' }),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const err = await response.text();
        console.warn(`⚠️ Telegram API Error: ${err}`);

        // Fallback: If Markdown fails, send as plain text
        if (err.includes("can't parse entities")) {
          console.warn('⚠️ Retrying as Plain Text...');
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.CHAT_ID,
              text: message.replace(/\*\*/g, ''),
            }),
          });
        }
      }
    } catch (error) {
      console.error('❌ Error en Telegram Gateway:', error);
    }
  }

  static async sendAlert(message: string) {
    await this.send(this.ALERT_BOT_TOKEN, message);
  }

  static async sendPlainTextToChat(chatId: string, message: string, token = this.ALERT_BOT_TOKEN) {
    if (!token || !chatId) {
      console.warn('⚠️ Telegram plain text skipped: Missing TOKEN or chatId');
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.slice(0, this.MAX_MESSAGE_LENGTH),
          parse_mode: 'HTML',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (error) {
      console.error('❌ Error en Telegram Plain Text Gateway:', error);
    }
  }

  static async sendSystemLog(message: string) {
    // Si no hay bot de logs definido, usa el de alertas por defecto (fallback)
    const token = this.LOG_BOT_TOKEN || this.ALERT_BOT_TOKEN;
    console.log(`[TelegramService] Sending System Log to token ending in ...${token.slice(-4)}`);
    await this.send(token, `🛠️ *SYSTEM LOG* 🛠️\n\n${message}`);
  }
}
