import { describe, expect, it } from 'vitest';
import { AegisExecutionIntentFactory, ApprovedAegisExecution } from './AegisExecutionIntentFactory';

describe('AegisExecutionIntentFactory', () => {
  it('maps already-resolved Aegis identity, risk, protection, and provenance deterministically', () => {
    const approved: ApprovedAegisExecution = {
      identity: {
        strategyId: 'AEGIS_TURBO',
        strategyVersion: 'migration-v1',
        freezeState: 'DRAFT',
        codeCommitSha: 'abc123',
      },
      signalId: 'signal-1',
      tradeId: 'AEGIS-ETHUSDT-1',
      symbol: 'ETHUSDT',
      side: 'SHORT',
      requestedAt: 1_777_777,
      risk: { leverage: 15, positionFraction: 0.08 },
      protection: {
        stopRoe: -0.15,
        takeProfitRoe: 0.25,
        requireStop: true,
        requireTakeProfit: true,
        closeIfProtectionFails: true,
      },
      failureCloseReasons: {
        positionConfirmation: 'AEGIS_POSITION_VERIFY_FAILED',
        protection: 'AEGIS_BRACKET_FAILED',
        unexpected: 'AEGIS_ENTRY_ERROR_CLOSED',
      },
      provenance: { decisionReason: 'all_aegis_guards_passed', e4Decision: 'ALLOW' },
    };

    const first = AegisExecutionIntentFactory.create(approved);
    const second = AegisExecutionIntentFactory.create(approved);

    expect(first).toEqual(second);
    expect(first).toEqual({
      identity: approved.identity,
      signalId: 'signal-1',
      tradeId: 'AEGIS-ETHUSDT-1',
      symbol: 'ETHUSDT',
      side: 'SHORT',
      requestedAt: 1_777_777,
      leverage: 15,
      positionFraction: 0.08,
      stopRoe: -0.15,
      takeProfitRoe: 0.25,
      protection: {
        requireStop: true,
        requireTakeProfit: true,
        closeIfProtectionFails: true,
      },
      failureCloseReasons: approved.failureCloseReasons,
      metadata: { decisionReason: 'all_aegis_guards_passed', e4Decision: 'ALLOW' },
    });
    expect(first.metadata).not.toBe(approved.provenance);
  });

  it('preserves effective legacy Aegis fail-close when configured false', () => {
    const result = AegisExecutionIntentFactory.create({
      identity: {
        strategyId: 'AEGIS_TURBO',
        strategyVersion: 'migration-v1',
        freezeState: 'DRAFT',
        codeCommitSha: 'abc123',
      },
      tradeId: 'AEGIS-ETHUSDT-2',
      symbol: 'ETHUSDT',
      side: 'LONG',
      requestedAt: 1_777_778,
      risk: { leverage: 15, positionFraction: 0.08 },
      protection: {
        stopRoe: -0.15,
        takeProfitRoe: 0.25,
        requireStop: true,
        requireTakeProfit: true,
        closeIfProtectionFails: false,
      },
      provenance: { configuredCloseIfBracketFails: false },
    });

    expect(result.protection.closeIfProtectionFails).toBe(true);
    expect(result.metadata).toEqual({ configuredCloseIfBracketFails: false });
  });
});
