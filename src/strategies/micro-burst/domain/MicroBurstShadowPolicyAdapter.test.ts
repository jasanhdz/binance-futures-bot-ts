import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';
import { MicroBurstShadowPolicyAdapter } from './MicroBurstShadowPolicyAdapter';
import { ShadowPosition } from '../../../core/shadow/ShadowTradingTypes';
import { shadowPositionKey } from '../../../core/shadow/ShadowPositionKey';

describe('MicroBurstShadowPolicyAdapter', () => {
  it('preserves the direct Micro Burst exit decision', () => {
    const position = {
      schemaVersion: 2,
      key: shadowPositionKey('MICRO_BURST_V1', 'ETHUSDT'),
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'test',
      symbol: 'ETHUSDT',
      side: 'LONG',
      tradeId: 't',
      parentDecisionId: 'd',
      decisionAtMs: 0,
      decisionReceivedAtMs: 0,
      openedAtMs: 0,
      openedReceivedAtMs: 0,
      entryDecisionPrice: 100,
      entryExecutablePrice: 100,
      entryPrice: 100,
      stop: 95,
      destination: 110,
      state: 'OPEN_SHADOW',
      lastObservedAtMs: 0,
      peakPrice: 100,
      troughPrice: 100,
      mfeBps: 0,
      maeBps: 0,
      provenance: { strategyVersion: 'test', codeCommitSha: 'test' },
    } as ShadowPosition;
    const observation = {
      exchangeTimeMs: 1_000,
      receivedAtMs: 1_000,
      currentPrice: 100.2,
      marketDataQuality: 'HEALTHY' as const,
    };
    const adapter = new MicroBurstShadowPolicyAdapter(defaultMicroBurstConfig());
    const actual = adapter.evaluateLifecycle(position, observation);
    const direct = evaluateMicroBurstExit(
      {
        unrealizedRoe: 0,
        priceReturn: 0.002,
        currentPrice: 100.2,
        entryPrice: 100,
        peakPrice: 100,
        troughPrice: 100,
        structuralInvalidationPrice: 95,
        destinationPrice: 110,
        currentStopPrice: 95,
        timeInTradeMs: 1000,
        momentumDecayFlag: false,
        anomalyExitFlag: false,
        currentBookPressure: null,
        currentBtcContext: null,
        leverage: 1,
      },
      defaultMicroBurstConfig(),
      'LONG',
    );
    expect(actual.action).toBe(
      direct.action === 'CLOSE_MARKET'
        ? 'CLOSE'
        : direct.action === 'MOVE_STOP'
          ? 'MOVE_STOP'
          : 'HOLD',
    );
  });

  it('uses local receive time rather than exchange event time for lifecycle timing', () => {
    const position = {
      schemaVersion: 2,
      key: shadowPositionKey('MICRO_BURST_V1', 'ETHUSDT'),
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'test',
      symbol: 'ETHUSDT',
      side: 'LONG',
      tradeId: 't',
      parentDecisionId: 'd',
      decisionAtMs: 0,
      decisionReceivedAtMs: 0,
      openedAtMs: 0,
      openedReceivedAtMs: 0,
      entryDecisionPrice: 100,
      entryExecutablePrice: 100,
      entryPrice: 100,
      stop: 95,
      destination: 110,
      state: 'OPEN_SHADOW',
      lastObservedAtMs: 0,
      peakPrice: 100,
      troughPrice: 100,
      mfeBps: 0,
      maeBps: 0,
      provenance: { strategyVersion: 'test', codeCommitSha: 'test' },
    } as ShadowPosition;
    const policy = new MicroBurstShadowPolicyAdapter({
      ...defaultMicroBurstConfig(),
      exitMaxHoldMs: 10,
    });
    const decision = policy.evaluateLifecycle(position, {
      exchangeTimeMs: 1_000_000,
      receivedAtMs: 11,
      currentPrice: 100,
      marketDataQuality: 'HEALTHY',
    });
    expect(decision).toMatchObject({ action: 'CLOSE', reason: 'MAX_HOLD' });
  });

  it('uses the confirmed intelligent exit in the SHADOW lifecycle adapter', () => {
    const position = {
      schemaVersion: 2,
      key: shadowPositionKey('MICRO_BURST_V1', 'ETHUSDT'),
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'test',
      symbol: 'ETHUSDT',
      side: 'LONG',
      tradeId: 'intelligent-exit-trade',
      parentDecisionId: 'd',
      decisionAtMs: 0,
      decisionReceivedAtMs: 0,
      openedAtMs: 0,
      openedReceivedAtMs: 0,
      entryDecisionPrice: 100,
      entryExecutablePrice: 100,
      entryPrice: 100,
      initialStructuralStop: 99,
      stop: 100.16,
      destination: 102,
      state: 'MANAGING',
      lastObservedAtMs: 0,
      peakPrice: 100.7,
      troughPrice: 100,
      mfeBps: 70,
      maeBps: 0,
      provenance: { strategyVersion: 'test', codeCommitSha: 'test' },
    } as ShadowPosition;
    const adapter = new MicroBurstShadowPolicyAdapter(defaultMicroBurstConfig());
    const observation = (receivedAtMs: number) => ({
      exchangeTimeMs: receivedAtMs,
      receivedAtMs,
      currentPrice: 100.5,
      marketDataQuality: 'HEALTHY' as const,
      strategyContext: {
        currentBookPressure: {
          spreadBps: 1,
          signedTopOfBookImbalance: -0.3,
          topOfBookImbalance: 0.3,
          imbalanceSlope: -0.08,
          temporalAbsorptionDetected: false,
          temporalSweepDetected: false,
          staticBidConcentration: false,
          staticAskConcentration: false,
          anomalyFlag: false,
          status: 'HEALTHY' as const,
        },
        marketEvidence: {
          observedAtMs: receivedAtMs,
          shortHorizonReturnBps: -2,
          mediumHorizonReturnBps: 2,
          priceSampleCount: 30,
          buyTakerVolume: 20,
          sellTakerVolume: 80,
          takerTradeCount: 100,
          takerFlowWindowComplete: true,
          takerFlowGapFree: true,
        },
      },
    });

    const armed = adapter.evaluateLifecycle(position, observation(20_000));
    expect(armed.action).toBe('HOLD');
    const recoveredPosition: ShadowPosition = {
      ...position,
      latestManagementDecision: {
        action: armed.action,
        reason: armed.reason,
        observedAtMs: 20_000,
        diagnostics: armed.diagnostics,
      },
    };
    const restoredAdapter = new MicroBurstShadowPolicyAdapter(defaultMicroBurstConfig());
    expect(restoredAdapter.evaluateLifecycle(recoveredPosition, observation(23_000))).toMatchObject(
      {
        action: 'CLOSE',
        reason: 'INTELLIGENT_EXIT',
        diagnostics: { confirmationElapsedMs: 3_000 },
      },
    );
  });
});
