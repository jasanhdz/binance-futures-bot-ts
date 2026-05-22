import { describe, expect, it, vi } from 'vitest';
import { TelegramCommandRouter } from './TelegramCommandRouter';
import { TelegramCommandHandlersPort } from './TelegramCommandTypes';

function handlers(): TelegramCommandHandlersPort {
    return {
        handleHelp: vi.fn(() => 'HELP'),
        handleStatus: vi.fn(async () => 'STATUS'),
        handleAccount: vi.fn(async () => 'ACCOUNT'),
        handlePositions: vi.fn(async () => 'POSITIONS'),
        handleTrade: vi.fn(async () => 'TRADE'),
        handleTrades: vi.fn(async () => 'TRADES'),
        handleConfig: vi.fn(async () => 'CONFIG'),
        handleSignal: vi.fn(async () => 'SIGNAL'),
        handleSignals: vi.fn(async () => 'SIGNALS'),
        handleRisk: vi.fn(async () => 'RISK'),
        handleRiskMode: vi.fn(async () => 'RISKMODE'),
        handleBrackets: vi.fn(async () => 'BRACKETS'),
        handleReportToday: vi.fn(async () => 'REPORT'),
        handleBlocks: vi.fn(async () => 'BLOCKS'),
        handleMomentum: vi.fn(async () => 'MOMENTUM'),
        handleProbe: vi.fn(async () => 'PROBE')
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

    it('passes /trade symbol argument to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/trade LINKUSDT' });

        expect(h.handleTrade).toHaveBeenCalledWith('LINKUSDT');
    });

    it('routes /trades to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/trades' })).resolves.toBe('TRADES');
        expect(h.handleTrades).toHaveBeenCalled();
    });

    it('passes /riskmode argument to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/riskmode RISK_OFF' });

        expect(h.handleRiskMode).toHaveBeenCalledWith('RISK_OFF');
    });

    it('routes /blocks to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/blocks' })).resolves.toBe('BLOCKS');
        expect(h.handleBlocks).toHaveBeenCalledWith([]);
    });

    it('passes /blocks arguments to handler', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/blocks detail LINKUSDT' });

        expect(h.handleBlocks).toHaveBeenCalledWith(['detail', 'LINKUSDT']);
    });

    it('keeps unauthorized /blocks blocked by router', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '999', text: '/blocks' })).resolves.toBe('Unauthorized.');
        expect(h.handleBlocks).not.toHaveBeenCalled();
    });

    it('routes /momentum to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/momentum' })).resolves.toBe('MOMENTUM');
        expect(h.handleMomentum).toHaveBeenCalledWith([]);
    });

    it('passes /momentum arguments to handler', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/momentum detail XRPUSDT' });

        expect(h.handleMomentum).toHaveBeenCalledWith(['detail', 'XRPUSDT']);
    });

    it('routes /probe to handler for authorized chat', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await expect(router.handleMessage({ chatId: '123', text: '/probe' })).resolves.toBe('PROBE');
        expect(h.handleProbe).toHaveBeenCalledWith([]);
    });

    it('passes /probe arguments to handler', async () => {
        const h = handlers();
        const router = new TelegramCommandRouter(h, { allowedChatIds: ['123'], now: () => 1000 });

        await router.handleMessage({ chatId: '123', text: '/probe detail AVAXUSDT' });

        expect(h.handleProbe).toHaveBeenCalledWith(['detail', 'AVAXUSDT']);
    });
});
