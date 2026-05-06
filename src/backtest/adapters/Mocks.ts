import { Logger } from '../../app/ports/Logger';
import { Notifier } from '../../app/ports/Notifier';
import { StateStore } from '../../app/ports/StateStore';
import { BotState } from '../../domain/types';

export class MockLogger implements Logger {
    info(message: string, meta?: any): void {
        // console.log(`[INFO] ${message}`, meta || '');
    }
    error(message: string, meta?: any): void {
        console.error(`[ERROR] ${message}`, meta || '');
    }
    warn(message: string, meta?: any): void {
        console.warn(`[WARN] ${message}`, meta || '');
    }
    debug(message: string, meta?: any): void {
        // console.debug(`[DEBUG] ${message}`, meta || '');
    }
}

export class MockNotifier implements Notifier {
    async sendMessage(message: string): Promise<void> {
        // console.log(`[NOTIFY] ${message}`);
    }
    async sendAlert(title: string, body: string): Promise<void> {
        // console.log(`[ALERT] ${title}: ${body}`);
    }
}

export class MockStateStore implements StateStore {
    private state: BotState = {
        mode: 'IDLE',
        currentRegime: 'AEGIS_TURBO'
    };

    get(): BotState {
        return { ...this.state };
    }

    set(partial: Partial<BotState>): BotState {
        this.state = { ...this.state, ...partial };
        return this.state;
    }

    reset(): void {
        this.state = {
            mode: 'IDLE',
            currentRegime: 'AEGIS_TURBO'
        };
    }
}
