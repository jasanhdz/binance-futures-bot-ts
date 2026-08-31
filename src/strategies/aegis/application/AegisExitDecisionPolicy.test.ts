import { describe, expect, it } from 'vitest';
import type { AegisExitEyeDecision } from '../domain/services/AegisExitEye';
import { classifyAegisExitDecision } from './AegisExitDecisionPolicy';

function decision(
  action: AegisExitEyeDecision['action'],
  flags: Partial<Pick<AegisExitEyeDecision, 'shouldClose' | 'shouldProtect'>> = {},
): AegisExitEyeDecision {
  return {
    action,
    shouldClose: flags.shouldClose ?? false,
    shouldProtect: flags.shouldProtect ?? false,
    reason: 'test',
    confidence: 'medium',
    metadata: {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      currentRoe: 0.1,
      peakRoe: 0.2,
      givebackRoe: 0.1,
    },
  };
}

describe('classifyAegisExitDecision', () => {
  it('prioritizes executable profit protection', () => {
    expect(
      classifyAegisExitDecision(
        decision('PROTECT_PROFIT', { shouldProtect: true, shouldClose: true }),
        0.1,
      ),
    ).toBe('PROTECT_PROFIT');
  });

  it('allows a close only when the position is profitable', () => {
    expect(classifyAegisExitDecision(decision('CLOSE_POSITION', { shouldClose: true }), 0.1)).toBe(
      'CLOSE_POSITION',
    );
    expect(classifyAegisExitDecision(decision('CLOSE_POSITION', { shouldClose: true }), 0)).toBe(
      'NOTIFY_ONLY',
    );
  });

  it('keeps shadow or disabled actions notification-only', () => {
    expect(classifyAegisExitDecision(decision('SHADOW_CLOSE'), 0.1)).toBe('NOTIFY_ONLY');
    expect(classifyAegisExitDecision(decision('NONE'), 0.1)).toBe('NOTIFY_ONLY');
  });
});
