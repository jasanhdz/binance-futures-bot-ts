import { describe, expect, it } from 'vitest';
import { Side } from '../../../core/types';
import {
  describeAegisExit,
  formatRoe,
  formatScore,
  formatSignedUsd,
} from './AegisExitMessageFormatter';

const state = {
  lastEntryPrice: 100,
  lastLeverage: 10,
  lastActualLeverage: undefined,
  lastStopRoe: -0.15,
  lastTakeProfitRoe: 0.25,
  lastTrailStop: undefined,
};

function classify(reason: string, pnl?: number, exitPrice = 100) {
  return describeAegisExit({
    reason,
    pnl,
    botState: state,
    side: 'LONG' as Side,
    exitPrice,
    computeBracketPrice: (_side, entryPrice, roe, leverage, type) =>
      type === 'STOP' ? entryPrice * (1 + roe / leverage) : entryPrice * (1 + roe / leverage),
  });
}

describe('AegisExitMessageFormatter', () => {
  it('formats shared numeric values with the existing operational conventions', () => {
    expect(formatScore(0.123)).toBe('12.3%');
    expect(formatScore(Number.NaN)).toBe('0.0%');
    expect(formatRoe(0.125)).toBe('+12.50% ROE');
    expect(formatRoe(-0.1)).toBe('-10.00% ROE');
    expect(formatSignedUsd(2.5)).toBe('+$2.50');
    expect(formatSignedUsd(-2.5)).toBe('-$2.50');
  });

  it.each([
    ['AEGIS_EXIT_EYE_OPPOSITE_SIGNAL', 'EXIT_EYE_OPPOSITE_SIGNAL'],
    ['TIME_LIMIT', 'TIME_LIMIT_EXIT'],
    ['BREAK_EVEN', 'BREAK_EVEN_EXIT'],
    ['TRAILING_CALLBACK', 'TRAILING_STOP_EXIT'],
    ['AI_GUARDIAN_CLOSE', 'AI_GUARDIAN_EXIT'],
    ['EMERGENCY_STOP', 'RISK_CONTROL_EXIT'],
  ])('preserves canonical classification for %s', (reason, canonicalExitType) => {
    expect(classify(reason, -1).canonicalExitType).toBe(canonicalExitType);
  });

  it('classifies a close near the trailing stop before bracket prices', () => {
    expect(
      describeAegisExit({
        reason: 'UNKNOWN',
        pnl: 1,
        botState: { ...state, lastTrailStop: 101 },
        side: 'LONG',
        exitPrice: 101.2,
        computeBracketPrice: () => 102,
      }),
    ).toMatchObject({ canonicalExitType: 'TRAILING_STOP_EXIT', emoji: '🛡️' });
  });

  it('classifies TP, SL, unknown, profit and loss fallbacks', () => {
    expect(classify('UNKNOWN', 1, 102.5)).toMatchObject({
      canonicalExitType: 'TAKE_PROFIT',
      displayExitLabel: 'TAKE PROFIT (TP)',
    });
    expect(classify('UNKNOWN', -1, 98.5)).toMatchObject({
      canonicalExitType: 'STOP_LOSS',
      displayExitLabel: 'STOP LOSS (SL)',
    });
    expect(classify('UNKNOWN')).toMatchObject({ canonicalExitType: 'CLOSE_OUTCOME_UNKNOWN' });
    expect(classify('UNKNOWN', 1, 100)).toMatchObject({
      canonicalExitType: 'PROFIT_EXIT_UNCLASSIFIED',
    });
    expect(classify('UNKNOWN', -1, 100)).toMatchObject({
      canonicalExitType: 'LOSS_EXIT_UNCLASSIFIED',
    });
  });
});
