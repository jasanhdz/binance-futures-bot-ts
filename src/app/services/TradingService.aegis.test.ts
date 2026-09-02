import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './TradingService';
import { AegisTradingSignal } from '../../strategies/aegis/domain/AegisStrategy';
import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';

function microBurstConfig(mode: 'OFF' | 'SHADOW' | 'LIVE'): MicroBurstRuntimeConfig {
  return {
    enabled: mode !== 'OFF',
    mode,
    symbols: { ETHUSDT: { enabled: true } },
    prospectiveValidation: { enabled: false },
    marketArchive: { enabled: false },
  };
}

describe('TradingService Aegis integration', () => {
  it.each([
    ['OFF', 'OFF'],
    ['SHADOW', 'SHADOW'],
    ['LIVE', 'LIVE'],
  ] as const)(
    'registers MicroBurst exactly once with the effective %s mode',
    (configuredMode, effectiveMode) => {
      const service = new TradingService(
        {
          exchange: {} as any,
          mlService: {} as any,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          state: {} as any,
          notifier: {} as any,
          configManager: {
            trading: { fee_buffer_pct: 0.03 },
            getMicroBurstConfig: () => microBurstConfig(configuredMode),
          } as any,
        },
        {
          symbols: ['ETHUSDT'],
          tickIntervalMs: 0,
          maxTradesPerDay: 100,
          tradingMode: 'AEGIS_SHADOW',
        },
      );

      const router = (service as any).microBurstStrategyRouter;
      expect(router.list()).toHaveLength(1);
      expect(router.list()[0].mode).toBe(effectiveMode);
    },
  );

  it('logs Aegis shadow scans and returns before entry execution', async () => {
    const signal: AegisTradingSignal = {
      symbol: 'ETHUSDT',
      action: 'PASS',
      confidence: 0,
      source: 'AEGIS_SAFE',
      longProb: 0.99,
      shortProb: 0.01,
      neutralProb: 0,
      metadata: {
        aegis: {
          shadow: {
            action: 'LONG',
            reason: 'shadow_only',
            would_execute: true,
            execute: false,
          },
          turbo: {
            raw: {
              action: 'LONG',
              turbo_score: 0.92,
              would_execute: true,
            },
            gated: {
              action: 'PASS',
              reason: 'live_disabled',
              blocked_by: 'AEGIS_LIVE_ENABLED',
            },
          },
        },
      },
    };

    const exchange = {
      getUSDTBalance: vi.fn(),
      marketOpen: vi.fn(),
      setLeverage: vi.fn(),
      ensureMarginType: vi.fn(),
      getSymbolFilters: vi.fn(),
      getLastCandle: vi.fn(),
      getServerTime: vi.fn(),
      subscribeToCandles: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const state = {
      get: vi.fn(() => ({ mode: 'IDLE' as const, currentRegime: 'AEGIS_TURBO' as const })),
      set: vi.fn(),
      reset: vi.fn(),
    };
    const mlService = {
      getSignal: vi.fn().mockResolvedValue(signal),
      getExitSignal: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = new TradingService(
      {
        exchange: exchange as any,
        mlService: mlService as any,
        logger,
        state,
        notifier: { sendMessage: vi.fn(), sendAlert: vi.fn() },
        configManager: { getMicroBurstConfig: () => microBurstConfig('OFF') } as any,
      },
      {
        symbols: ['ETHUSDT'],
        tickIntervalMs: 0,
        maxTradesPerDay: 100,
        tradingMode: 'AEGIS_SHADOW',
      },
    );

    await service.tick('ETHUSDT');

    expect(mlService.getSignal).toHaveBeenCalledWith('ETHUSDT');
    expect(logger.info).toHaveBeenCalledWith(
      'aegis_scan',
      expect.objectContaining({
        symbol: 'ETHUSDT',
        safeAction: 'LONG',
        safeReason: 'shadow_only',
        turboRawAction: 'LONG',
        turboRawScore: 0.92,
        turboRawWouldExecute: true,
        turboGatedAction: 'PASS',
        turboGatedReason: 'live_disabled',
        turboBlockedBy: 'AEGIS_LIVE_ENABLED',
      }),
    );
    expect(exchange.getUSDTBalance).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });
});
