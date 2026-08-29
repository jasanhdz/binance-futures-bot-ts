import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig } from './MicroBurstTypes';
import { MicroBurstPaperQuote, MicroBurstPaperTrading } from '../research/MicroBurstPaperTrading';
import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';

const provenance = { cohortId: 'C', codeCommitSha: 'S', configHash: 'H' };

function signal(
  symbol = 'ETHUSDT',
  side: 'LONG' | 'SHORT' = 'LONG',
): MicroBurstShadowEvaluationResult {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: 'V',
    symbol,
    snapshotAtMs: 1_000,
    decision: 'ENTRY_INTENT',
    side,
    confidence: 1,
    referencePrice: 100,
    supportPrice: 90,
    resistancePrice: 110,
    structuralInvalidation: side === 'LONG' ? 95 : 105,
    destinationPrice: side === 'LONG' ? 110 : 90,
    roomToTargetBps: 1000,
    riskToInvalidationBps: 500,
    rewardRisk: 2,
    momentum: { direction: side, strength: 1, continuationScore: 1 },
    book: { status: 'HEALTHY', ageMs: 1, imbalance: 1, imbalanceSlope: 0 },
    btc: { status: 'HEALTHY', ageMs: 1, ret1m: 0, ret3m: 0, ret5m: 0, conflict: false },
    microRegime: 'TRENDING_UP',
    dataQuality: { contextValid: true, invalidReasons: [] },
    wouldEnter: true,
    liveExecution: false,
    shadowSignalId: `S-${symbol}-${side}`,
    duplicateSuppressed: false,
    firstObservedAt: 1_000,
    lastObservedAt: 1_000,
    diagnostics: { leverage: 10, positionFraction: 0.1 },
  };
}

function quote(bid = 99, ask = 101, observedAtMs = 900): MicroBurstPaperQuote {
  return { bestBid: bid, bestAsk: ask, observedAtMs, status: 'HEALTHY' };
}

describe('MicroBurst paper trading lifecycle', () => {
  it('locks one position per symbol but permits another symbol', () => {
    const paper = new MicroBurstPaperTrading(defaultMicroBurstConfig());
    expect(paper.open(signal(), quote(), 1_000, provenance).status).toBe('OPENED');
    expect(paper.open(signal(), quote(), 1_000, provenance).status).toBe('SUPPRESSED');
    expect(paper.open(signal('ETHUSDT', 'SHORT'), quote(), 1_000, provenance).status).toBe(
      'SUPPRESSED',
    );
    expect(paper.open(signal('BTCUSDT'), quote(), 1_000, provenance).status).toBe('OPENED');
  });

  it('uses ask for long, bid for short, and rejects stale or lookahead quotes', () => {
    const long = new MicroBurstPaperTrading(defaultMicroBurstConfig());
    const openedLong = long.open(signal(), quote(99, 101), 1_000, provenance);
    expect(openedLong.status === 'OPENED' && openedLong.position.entryPrice).toBe(101);
    const short = new MicroBurstPaperTrading(defaultMicroBurstConfig());
    const openedShort = short.open(signal('ETHUSDT', 'SHORT'), quote(99, 101), 1_000, provenance);
    expect(openedShort.status === 'OPENED' && openedShort.position.entryPrice).toBe(99);
    expect(
      new MicroBurstPaperTrading(defaultMicroBurstConfig()).open(
        signal(),
        quote(99, 101, 1_001),
        1_000,
        provenance,
      ).status,
    ).toBe('UNFILLED_DATA_UNCERTAIN');
    expect(
      new MicroBurstPaperTrading(defaultMicroBurstConfig()).open(
        signal(),
        quote(99, 101, 1_700),
        1_000,
        provenance,
        2_000,
      ).status,
    ).toBe('OPENED');
    expect(
      new MicroBurstPaperTrading(defaultMicroBurstConfig()).open(
        signal(),
        { ...quote(), status: 'STALE' },
        1_000,
        provenance,
      ).status,
    ).toBe('UNFILLED_DATA_UNCERTAIN');
  });

  it('closes at the causal executable bid and records gross bps and ROE', () => {
    const paper = new MicroBurstPaperTrading(defaultMicroBurstConfig());
    paper.open(signal(), quote(), 1_000, provenance);
    const result = paper.manage('ETHUSDT', {
      currentPrice: 110,
      observedAtMs: 2_000,
      quote: quote(109, 111),
    });
    expect(result?.position.exitReason).toBe('TARGET');
    expect(result?.position.exitPrice).toBe(109);
    expect(result?.position.grossPriceReturnBps).toBeCloseTo(792.0792, 3);
    expect(result?.position.grossRoe).toBeCloseTo(0.7920792, 6);
    expect(result?.position.netBps).toBeUndefined();
    expect(result?.position.canonicalNetBps).toBeNull();
    expect(result?.position.netBpsByCostScenario?.cost_0).toBeCloseTo(792.0792, 3);
    expect(result?.position.netBpsByCostScenario?.cost_10).toBeCloseTo(782.0792, 3);
    expect(result?.position.netBpsByCostScenario?.cost_14).toBeCloseTo(778.0792, 3);
    expect(result?.position.netBpsByCostScenario?.cost_20).toBeCloseTo(772.0792, 3);
    expect(result?.position.netBpsByCostScenario?.cost_30).toBeCloseTo(762.0792, 3);
    expect(paper.getPosition('ETHUSDT')).toBeUndefined();
  });

  it('tightens stops only and does not fabricate an exit without a quote', () => {
    const config = { ...defaultMicroBurstConfig(), exitBreakEvenActivationBps: 1 };
    const paper = new MicroBurstPaperTrading(config);
    paper.open(signal(), quote(), 1_000, provenance);
    const managed = paper.manage('ETHUSDT', {
      currentPrice: 102,
      observedAtMs: 1_500,
      quote: quote(),
    });
    expect(managed?.position.currentStop).toBe(101);
    const uncertain = paper.manage('ETHUSDT', { currentPrice: 95, observedAtMs: 1_600 });
    expect(uncertain?.position.state).toBe('DATA_UNCERTAIN');
    expect(paper.getPosition('ETHUSDT')?.state).toBe('DATA_UNCERTAIN');
  });
});
