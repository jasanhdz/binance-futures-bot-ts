import { isForbiddenTime } from './AegisStrategy';
import { evaluateGuardianAction, GuardianConfig, GuardianContext } from './ProfitGuardian';
import { describe, it, expect } from 'vitest';

describe('Aegis safety logic verification', () => {
  describe('isForbiddenTime', () => {
    const FORBIDDEN_HOURS = [0, 1, 22, 23];
    const FORBIDDEN_DAYS = [2]; // Tuesday

    it('should forbid hours 0, 1, 22, 23', () => {
      const hour0 = new Date('2025-01-01T00:30:00Z').getTime(); // Wed
      expect(isForbiddenTime(hour0, FORBIDDEN_HOURS, FORBIDDEN_DAYS)).toBe(true);

      const hour1 = new Date('2025-01-01T01:30:00Z').getTime();
      expect(isForbiddenTime(hour1, FORBIDDEN_HOURS, FORBIDDEN_DAYS)).toBe(true);

      const hour12 = new Date('2025-01-01T12:30:00Z').getTime();
      expect(isForbiddenTime(hour12, FORBIDDEN_HOURS, FORBIDDEN_DAYS)).toBe(false);
    });

    it('should forbid Tuesdays', () => {
      const tuesday = new Date('2025-01-07T12:00:00Z').getTime(); // Tue
      expect(isForbiddenTime(tuesday, FORBIDDEN_HOURS, FORBIDDEN_DAYS)).toBe(true);

      const wednesday = new Date('2025-01-08T12:00:00Z').getTime(); // Wed
      expect(isForbiddenTime(wednesday, FORBIDDEN_HOURS, FORBIDDEN_DAYS)).toBe(false);
    });
  });

  describe('Safety Net (Trailing)', () => {
    const config: GuardianConfig = {
      beTriggerRoe: 0.1,
      beOffsetPct: 0.003,
      trailingDev: 0.015,
      trailingActivationRoe: 0.15,
      trailingCallbackRoe: 0.3,
    };

    const baseCtx: GuardianContext = {
      entryPrice: 1000,
      currentPrice: 1000,
      peakPrice: 1000,
      positionSide: 'SHORT',
      leverage: 20,
    };

    it('should NOT trigger below activation (14% ROE)', () => {
      // ROE = 14% -> Price = 1000 * (1 - 0.14/20) = 993
      const ctx = { ...baseCtx, currentPrice: 993, peakRoe: 0.14 };
      const action = evaluateGuardianAction(ctx, config);
      // Should be BE or HOLD, but definitely not TRAILING_SAFETY_NET
      expect(action.type).not.toBe('CLOSE_MARKET');
    });

    it('should trigger CLOSE when callback hit (Peak 20%, Current 13%)', () => {
      // Peak ROE = 20%
      // Trigger ROE = 20% * (1 - 0.30) = 14%
      // Current ROE = 13% (Price = 1000 * (1 - 0.13/20) = 993.5)

      const ctx = {
        ...baseCtx,
        currentPrice: 993.5,
        peakRoe: 0.2,
      };

      const action = evaluateGuardianAction(ctx, config);
      expect(action).toEqual({ type: 'CLOSE_MARKET', reason: 'TRAILING_SAFETY_NET' });
    });

    it('should MOVE SL when callback pending (Peak 20%, Current 18%)', () => {
      // Peak ROE = 20%
      // Trigger ROE = 14%
      // Trigger Price = 1000 * (1 - 0.14/20) = 993
      // Current Price = 991 (18% ROE) -> Safe

      const ctx = {
        ...baseCtx,
        currentPrice: 991,
        peakRoe: 0.2,
      };

      const action = evaluateGuardianAction(ctx, config);
      expect(action.type).toBe('MOVE_SL_TRAILING');
      if (action.type === 'MOVE_SL_TRAILING') {
        expect(action.price).toBeCloseTo(993, 1);
      }
    });
  });
});
