import { describe, expect, it, vi } from 'vitest';
import { TelegramCommandRouter } from './TelegramCommandRouter';
import { TelegramCommandHandlersPort } from './TelegramCommandTypes';

function handlers(): TelegramCommandHandlersPort {
    return {
        handleHelp: vi.fn(() => 'HELP'),
        handleStatus: vi.fn(async () => 'STATUS'),
        handleAccount: vi.fn(async () => 'ACCOUNT'),
        handlePositions: vi.fn(async () => 'POSITIONS'),
        handleConfig: vi.fn(async () => 'CONFIG'),
        handleSignal: vi.fn(async () => 'SIGNAL'),
        handleSignals: vi.fn(async () => 'SIGNALS'),
        handleRisk: vi.fn(async () => 'RISK'),
        handleRiskMode: vi.fn(async () => 'RISKMODE'),
        handleBrackets: vi.fn(async () => 'BRACKETS'),
        handleReportToday: vi.fn(async () => 'REPORT')
    };
}

describe('TelegramCommandRouter', () => {
    it('responds to /help', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/help' })).resolves.toBe('HELP');
        expect(h.handleHelp).toHaveBeenCalled();
    });

    it('responds with help for unknown commands', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/wat' })).resolves.toBe('HELP');
        expect(h.handleHelp).toHaveBeenCalled();
    });

    it('blocks unauthorized chats', async () => {
        const router = new TelegramCommandRouter(handlers(), { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '999', text: '/status' })).resolves.toBe('Unauthorized.');
    });

    it('rate limits a second command from the same chat', async () => {
        let now = 1000;
        const router = new TelegramCommandRouter(handlers(), {
            allowedChatIds: ['123'],
            rateLimitMs: 2000,
            now: () => now
        });

        await expect(router.handleMessage({ chatId: '123', text: '/status' })).resolves.toBe('STATUS');
        now = 1500;
        await expect(router.handleMessage({ chatId: '123', text: '/account' })).resolves.toBe('Espera un momento antes de enviar otro comando.');
    });

    it('passes /signal symbol argument to handler', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/signal ETHUSDT' });

        expect(h.handleSignal).toHaveBeenCalledWith('ETHUSDT');
    });

    it('passes /riskmode argument to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/riskmode RISK_OFF' });

        expect(h.handleRiskMode).toHaveBeenCalledWith('RISK_OFF');
    });
});
