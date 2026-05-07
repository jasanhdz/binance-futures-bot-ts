import { Logger } from '../../app/ports/Logger';
import { TelegramCommandRouter } from '../../app/telegram/TelegramCommandRouter';
import { TelegramService } from '../adapters/TelegramAdapter';

type TelegramUpdate = {
    update_id: number;
    message?: {
        message_id?: number;
        text?: string;
        chat?: { id?: number | string };
        from?: { username?: string };
    };
};

export class TelegramBotCommandListener {
    private offset = 0;
    private running = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly options: {
            token: string;
            router: TelegramCommandRouter;
            logger?: Logger;
            pollIntervalMs?: number;
        }
    ) {}

    start(): void {
        if (this.running) return;
        if (!this.options.token) {
            this.options.logger?.warn('telegram_command_listener_disabled_missing_token', {});
            return;
        }
        this.running = true;
        this.pollOnce();
    }

    stop(): void {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private schedule(): void {
        if (!this.running) return;
        this.timer = setTimeout(() => this.pollOnce(), this.options.pollIntervalMs ?? 1000);
    }

    private async pollOnce(): Promise<void> {
        try {
            const updates = await this.getUpdates();
            for (const update of updates) {
                this.offset = Math.max(this.offset, update.update_id + 1);
                await this.processUpdate(update);
            }
        } catch (error) {
            this.options.logger?.warn('telegram_command_listener_poll_failed', { error: String(error) });
        } finally {
            this.schedule();
        }
    }

    private async getUpdates(): Promise<TelegramUpdate[]> {
        const url = `https://api.telegram.org/bot${this.options.token}/getUpdates`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35000);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    offset: this.offset || undefined,
                    timeout: 25,
                    allowed_updates: ['message']
                }),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(await response.text());
            const data: any = await response.json();
            return Array.isArray(data?.result) ? data.result : [];
        } finally {
            clearTimeout(timeout);
        }
    }

    private async processUpdate(update: TelegramUpdate): Promise<void> {
        const text = update.message?.text;
        const chatId = update.message?.chat?.id;
        if (!text || chatId === undefined || chatId === null) return;

        const response = await this.options.router.handleMessage({
            chatId: String(chatId),
            text,
            messageId: update.message?.message_id,
            fromUsername: update.message?.from?.username
        });
        if (!response) return;
        await TelegramService.sendPlainTextToChat(String(chatId), response, this.options.token);
    }
}
