import { describe, expect, it } from 'vitest';
import { ShadowTradingEngine } from '../../../core/shadow/ShadowTradingEngine';
import {
  ShadowCostScenario,
  ShadowMarketQuote,
  ShadowPosition,
} from '../../../core/shadow/ShadowTradingTypes';
import {
  MicroBurstPaperPosition,
  MicroBurstPaperTrading,
  MicroBurstPaperQuote,
} from '../research/MicroBurstPaperTrading';
import { MicroBurstShadowPolicyAdapter } from './MicroBurstShadowPolicyAdapter';
import { defaultMicroBurstConfig, MicroBurstConfig } from './MicroBurstTypes';
import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';
import { DEFAULT_COST_SCENARIOS } from '../research/MicroBurstOutcomeTypes';

const provenance = {
  strategyVersion: 'golden',
  cohortId: 'golden',
  codeCommitSha: 'test',
  configHash: 'test',
};
const quote: MicroBurstPaperQuote = {
  bestBid: 100,
  bestAsk: 100.1,
  observedAtMs: 1_000,
  status: 'HEALTHY',
};

type Case = {
  name: string;
  side: 'LONG' | 'SHORT';
  destination: number;
  stop: number;
  observations: Array<{
    currentPrice: number;
    receivedAtMs: number;
    exchangeTimeMs?: number;
    quote?: MicroBurstPaperQuote;
    anomaly?: boolean;
    btcConflict?: boolean;
  }>;
  config?: Partial<MicroBurstConfig>;
};

function signal(testCase: Case): MicroBurstShadowEvaluationResult {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: 'golden',
    symbol: 'ETHUSDT',
    snapshotAtMs: 1_000,
    decision: 'ENTRY_INTENT',
    side: testCase.side,
    confidence: 0.9,
    referencePrice: 100,
    supportPrice: 99,
    resistancePrice: 110,
    structuralInvalidation: testCase.stop,
    destinationPrice: testCase.destination,
    roomToTargetBps: 1_000,
    riskToInvalidationBps: 100,
    rewardRisk: 10,
    momentum: { direction: testCase.side, strength: 0.9, continuationScore: 0.9 },
    book: { status: 'HEALTHY', ageMs: 1, imbalance: 0.3, imbalanceSlope: null },
    btc: { status: 'HEALTHY', ageMs: 1, ret1m: 0, ret3m: 0, ret5m: 0, conflict: false },
    microRegime: 'RANGING',
    dataQuality: { contextValid: true, invalidReasons: [] },
    wouldEnter: true,
    liveExecution: false,
    shadowSignalId: `${testCase.name}-signal`,
    duplicateSuppressed: false,
    firstObservedAt: 1_000,
    lastObservedAt: 1_000,
    diagnostics: { leverage: 20, positionFraction: 0.05 },
  };
}

function paperQuote(value: MicroBurstPaperQuote | undefined): MicroBurstPaperQuote | undefined {
  return value;
}

function shadowQuote(value: MicroBurstPaperQuote | undefined): ShadowMarketQuote | undefined {
  return value && { ...value };
}

function normalize(position: MicroBurstPaperPosition | ShadowPosition) {
  const stop = 'currentStop' in position ? position.currentStop : position.stop;
  const destination =
    'destinationPrice' in position ? position.destinationPrice : position.destination;
  const mfe =
    position.side === 'LONG'
      ? ((position.peakPrice - position.entryPrice) / position.entryPrice) * 10_000
      : ((position.entryPrice - position.troughPrice) / position.entryPrice) * 10_000;
  const mae =
    position.side === 'LONG'
      ? ((position.entryPrice - position.troughPrice) / position.entryPrice) * 10_000
      : ((position.peakPrice - position.entryPrice) / position.entryPrice) * 10_000;
  return {
    state: position.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    side: position.side,
    symbol: position.symbol,
    entryPrice: position.entryPrice,
    stop,
    destination,
    peak: position.peakPrice,
    trough: position.troughPrice,
    mfeBps: position.mfeBps ?? mfe,
    maeBps: position.maeBps ?? mae,
    exitReason: position.exitReason,
    exitPrice:
      'executableExitPrice' in position
        ? position.executableExitPrice
        : (position as ShadowPosition).exitExecutablePrice,
    grossBps:
      'grossPriceReturnBps' in position
        ? position.grossPriceReturnBps
        : (position as ShadowPosition).grossBps,
    scenarios: position.netBpsByCostScenario,
  };
}

function action(decision: { action: string } | null | undefined): string {
  if (!decision) return 'NONE';
  return decision.action === 'CLOSE_MARKET' ? 'CLOSE' : decision.action;
}

function makeEngine(config: MicroBurstConfig): ShadowTradingEngine {
  const journal = new MemoryJournal();
  return new ShadowTradingEngine(
    journal,
    new Map([['MICRO_BURST_V1', new MicroBurstShadowPolicyAdapter(config)]] as const),
    defaultCostScenarios(),
  );
}

function defaultCostScenarios(): Map<'MICRO_BURST_V1', Record<string, ShadowCostScenario>> {
  return new Map<'MICRO_BURST_V1', Record<string, ShadowCostScenario>>([
    [
      'MICRO_BURST_V1',
      Object.fromEntries(
        DEFAULT_COST_SCENARIOS.map((scenario) => [
          scenario.label,
          { feeBps: scenario.feeBps, additionalSlippageBps: scenario.slippageBps },
        ]),
      ),
    ],
  ]);
}

class MemoryJournal {
  positions: ShadowPosition[] = [];
  appendPosition(position: ShadowPosition): void {
    this.positions = [
      ...this.positions.filter((item) => item.tradeId !== position.tradeId),
      position,
    ];
  }
  appendEvent(): void {}
  loadOpenPositions(): ShadowPosition[] {
    return this.positions.filter((position) => position.state !== 'CLOSED');
  }
  loadAllPositions(): ShadowPosition[] {
    return this.positions;
  }
  loadAllEvents(): never[] {
    return [];
  }
  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: true, malformedCount: 0 };
  }
  flush(): void {}
}

function runCase(testCase: Case): void {
  const config = { ...defaultMicroBurstConfig(), ...testCase.config };
  const reference = new MicroBurstPaperTrading(config);
  const engine = makeEngine(config);
  const referenceOpen = reference.open(
    signal(testCase),
    paperQuote(quote),
    1_000,
    provenance,
    1_000,
  );
  const candidateOpen = engine.open(
    {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'golden',
      symbol: 'ETHUSDT',
      side: testCase.side,
      decisionAtMs: 1_000,
      decisionReceivedAtMs: 1_000,
      referencePrice: 100,
      structuralStop: testCase.stop,
      destination: testCase.destination,
      leverage: 20,
      positionFraction: 0.05,
      parentDecisionId: signal(testCase).shadowSignalId,
      provenance,
    },
    shadowQuote(quote),
  );
  expect(candidateOpen.status).toBe(referenceOpen.status);
  if (referenceOpen.status !== 'OPENED' || candidateOpen.status !== 'OPENED') return;
  expect(normalize(candidateOpen.position)).toMatchObject(normalize(referenceOpen.position));

  let previousCandidate = candidateOpen.position;
  for (const observation of testCase.observations) {
    const paperObservation = {
      currentPrice: observation.currentPrice,
      observedAtMs: observation.receivedAtMs,
      quote: paperQuote(observation.quote ?? quote),
      exitContext: {
        anomalyExitFlag: observation.anomaly ?? false,
        currentBtcContext: observation.btcConflict
          ? {
              ret1m: 0,
              ret3m: 0,
              ret5m: 0,
              acceleration: 0,
              conflictFlag: true,
              direction: 'SHORT' as const,
              observedAtMs: observation.receivedAtMs,
              receivedAtMs: observation.receivedAtMs,
            }
          : null,
        currentBookPressure: null,
      },
    };
    const referenceResult = reference.manage('ETHUSDT', paperObservation);
    const candidateResult = engine.manage(
      { strategyId: 'MICRO_BURST_V1', symbol: 'ETHUSDT' },
      {
        currentPrice: observation.currentPrice,
        receivedAtMs: observation.receivedAtMs,
        exchangeTimeMs: observation.exchangeTimeMs ?? observation.receivedAtMs,
        quote: shadowQuote(observation.quote ?? quote),
        marketDataQuality: 'HEALTHY',
        strategyContext: paperObservation.exitContext,
      },
    );
    expect(referenceResult).not.toBeNull();
    expect(candidateResult).not.toBeNull();
    expect(action(referenceResult!.exitDecision)).toBe(
      candidateResult!.state === 'CLOSED'
        ? 'CLOSE'
        : candidateResult!.stop !== previousCandidate.stop
          ? 'MOVE_STOP'
          : 'HOLD',
    );
    expect(normalize(candidateResult!)).toMatchObject(normalize(referenceResult!.position));
    previousCandidate = candidateResult!;
  }
}

describe('Micro Burst full golden parity', () => {
  it.each<Case>([
    {
      name: 'long-target',
      side: 'LONG',
      destination: 102,
      stop: 99,
      observations: [
        { currentPrice: 101, receivedAtMs: 2_000 },
        { currentPrice: 102, receivedAtMs: 3_000 },
      ],
    },
    {
      name: 'short-target',
      side: 'SHORT',
      destination: 98,
      stop: 101,
      observations: [
        { currentPrice: 99, receivedAtMs: 2_000 },
        { currentPrice: 98, receivedAtMs: 3_000 },
      ],
    },
    {
      name: 'long-hard-invalidation',
      side: 'LONG',
      destination: 110,
      stop: 99,
      observations: [{ currentPrice: 99, receivedAtMs: 2_000 }],
    },
    {
      name: 'short-hard-invalidation',
      side: 'SHORT',
      destination: 90,
      stop: 101,
      observations: [{ currentPrice: 101, receivedAtMs: 2_000 }],
    },
    {
      name: 'immediate-adverse',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [{ currentPrice: 99.8, receivedAtMs: 2_000 }],
    },
    {
      name: 'proof-window',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [{ currentPrice: 100.02, receivedAtMs: 61_000, exchangeTimeMs: 66_000 }],
    },
    {
      name: 'break-even',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [
        { currentPrice: 100.2, receivedAtMs: 2_000 },
        { currentPrice: 100, receivedAtMs: 3_000 },
      ],
    },
    {
      name: 'peak-callback-does-not-exit',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [
        { currentPrice: 100.2, receivedAtMs: 2_000 },
        { currentPrice: 100.3, receivedAtMs: 3_000 },
        { currentPrice: 100.24, receivedAtMs: 4_000 },
      ],
    },
    {
      name: 'max-hold',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [{ currentPrice: 100.2, receivedAtMs: 301_000, exchangeTimeMs: 296_000 }],
    },
    {
      name: 'anomaly',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [{ currentPrice: 100.2, receivedAtMs: 2_000, anomaly: true }],
    },
    {
      name: 'btc-reversal',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [{ currentPrice: 100.2, receivedAtMs: 2_000, btcConflict: true }],
    },
  ])('$name', (testCase) => runCase(testCase));

  it('matches entry uncertainty and ownership semantics', () => {
    const config = defaultMicroBurstConfig();
    const reference = new MicroBurstPaperTrading(config);
    const engine = makeEngine(config);
    const base = signal({
      name: 'uncertain',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [],
    });
    for (const invalid of [
      undefined,
      { ...quote, status: 'STALE' as const },
      { ...quote, status: 'UNSYNCED' as const },
      { ...quote, bestBid: 101 },
      { ...quote, bestAsk: Number.NaN },
      { ...quote, bestAsk: Infinity },
      { ...quote, observedAtMs: 2_000 },
    ]) {
      expect(reference.open(base, invalid, 1_000, provenance).status).toBe(
        'UNFILLED_DATA_UNCERTAIN',
      );
      expect(
        engine.open(
          {
            strategyId: 'MICRO_BURST_V1',
            strategyVersion: 'golden',
            symbol: `S${String(invalid?.status ?? 'NONE')}`,
            side: 'LONG',
            decisionAtMs: 1_000,
            decisionReceivedAtMs: 1_000,
            referencePrice: 100,
            structuralStop: 90,
            destination: 110,
            parentDecisionId: `d-${String(invalid?.status ?? 'NONE')}`,
            provenance,
          },
          shadowQuote(invalid),
        ).status,
      ).toBe('DATA_UNCERTAIN');
    }
    const open = reference.open(base, quote, 1_000, provenance);
    expect(open.status).toBe('OPENED');
    expect(
      reference.open({ ...base, side: 'SHORT', shadowSignalId: 'second' }, quote, 1_001, provenance)
        .status,
    ).toBe('SUPPRESSED');
    expect(
      reference.open(
        { ...base, symbol: 'BTCUSDT', shadowSignalId: 'cross-symbol' },
        quote,
        1_001,
        provenance,
      ).status,
    ).toBe('OPENED');
  });

  it('allows same-symbol re-entry only after the original position closes', () => {
    const config = defaultMicroBurstConfig();
    const engine = makeEngine(config);
    const testCase: Case = {
      name: 'reentry',
      side: 'LONG',
      destination: 101,
      stop: 90,
      observations: [],
    };
    const entry = signal(testCase);
    const intent = {
      strategyId: 'MICRO_BURST_V1' as const,
      strategyVersion: 'golden',
      symbol: 'ETHUSDT',
      side: 'LONG' as const,
      decisionAtMs: 1_000,
      decisionReceivedAtMs: 1_000,
      referencePrice: 100,
      structuralStop: 90,
      destination: 101,
      parentDecisionId: entry.shadowSignalId,
      provenance,
    };
    expect(engine.open(intent, quote).status).toBe('OPENED');
    expect(engine.open({ ...intent, parentDecisionId: 'blocked' }, quote).status).toBe(
      'SUPPRESSED',
    );
    expect(
      engine.manage(
        { strategyId: 'MICRO_BURST_V1', symbol: 'ETHUSDT' },
        {
          currentPrice: 101,
          receivedAtMs: 2_000,
          exchangeTimeMs: 2_000,
          quote,
          marketDataQuality: 'HEALTHY',
        },
      )?.state,
    ).toBe('CLOSED');
    expect(engine.open({ ...intent, parentDecisionId: 'after-close' }, quote).status).toBe(
      'OPENED',
    );
  });

  it('matches explicit MFE/MAE magnitudes and cost scenarios', () => {
    runCase({
      name: 'mfe-mae-long',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [
        { currentPrice: 103, receivedAtMs: 2_000 },
        { currentPrice: 98, receivedAtMs: 3_000 },
      ],
    });
    expect(((100 - 98) / 100) * 10_000).toBe(200);
    expect(((103 - 100) / 100) * 10_000).toBe(300);
    runCase({
      name: 'mfe-mae-short',
      side: 'SHORT',
      destination: 90,
      stop: 110,
      observations: [
        { currentPrice: 96, receivedAtMs: 2_000 },
        { currentPrice: 102, receivedAtMs: 3_000 },
      ],
    });
    expect(((100 - 96) / 100) * 10_000).toBe(400);
    expect(((102 - 100) / 100) * 10_000).toBe(200);
  });

  it('matches exit DATA_UNCERTAIN and later causal recovery', () => {
    const config = defaultMicroBurstConfig();
    const testCase: Case = {
      name: 'exit-data-uncertain',
      side: 'LONG',
      destination: 102,
      stop: 90,
      observations: [],
    };
    const reference = new MicroBurstPaperTrading(config);
    const journal = new MemoryJournal();
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MICRO_BURST_V1', new MicroBurstShadowPolicyAdapter(config)]] as const),
      defaultCostScenarios(),
    );
    const entry = signal(testCase);
    expect(reference.open(entry, quote, 1_000, provenance).status).toBe('OPENED');
    expect(
      engine.open(
        {
          strategyId: 'MICRO_BURST_V1',
          strategyVersion: 'golden',
          symbol: 'ETHUSDT',
          side: 'LONG',
          decisionAtMs: 1_000,
          decisionReceivedAtMs: 1_000,
          referencePrice: 100,
          structuralStop: 90,
          destination: 102,
          parentDecisionId: entry.shadowSignalId,
          provenance,
        },
        shadowQuote(quote),
      ).status,
    ).toBe('OPENED');
    const uncertainReference = reference.manage('ETHUSDT', {
      currentPrice: 102,
      observedAtMs: 2_000,
    });
    const uncertainCandidate = engine.manage(
      { strategyId: 'MICRO_BURST_V1', symbol: 'ETHUSDT' },
      {
        currentPrice: 102,
        receivedAtMs: 2_000,
        exchangeTimeMs: 2_000,
        marketDataQuality: 'HEALTHY',
      },
    );
    expect(uncertainReference!.position.state).toBe('DATA_UNCERTAIN');
    expect(uncertainCandidate!.state).toBe('DATA_UNCERTAIN');
    expect(engine.getOpenPositions()).toHaveLength(1);
    const recoveredReference = reference.manage('ETHUSDT', {
      currentPrice: 102,
      observedAtMs: 3_000,
      quote,
    });
    const recoveredCandidate = engine.manage(
      { strategyId: 'MICRO_BURST_V1', symbol: 'ETHUSDT' },
      {
        currentPrice: 102,
        receivedAtMs: 3_000,
        exchangeTimeMs: 3_000,
        quote,
        marketDataQuality: 'HEALTHY',
      },
    );
    expect(recoveredReference!.position.state).toBe('CLOSED');
    expect(recoveredCandidate!.state).toBe('CLOSED');
    expect(normalize(recoveredCandidate!)).toMatchObject(normalize(recoveredReference!.position));
  });

  it('preserves generic cross-strategy ownership while matching Micro Burst symbol suppression', () => {
    const config = defaultMicroBurstConfig();
    const engine = makeEngine(config);
    const base = signal({
      name: 'ownership',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [],
    });
    const intent = (
      strategyId: 'MICRO_BURST_V1' | 'MOMENTUM_RIDE',
      symbol: string,
      id: string,
    ) => ({
      strategyId,
      strategyVersion: 'golden',
      symbol,
      side: 'LONG' as const,
      decisionAtMs: 1_000,
      decisionReceivedAtMs: 1_000,
      referencePrice: 100,
      structuralStop: 90,
      destination: 110,
      parentDecisionId: id,
      provenance,
    });
    expect(
      engine.open(intent('MICRO_BURST_V1', 'ETHUSDT', base.shadowSignalId), quote).status,
    ).toBe('OPENED');
    expect(engine.open(intent('MICRO_BURST_V1', 'ETHUSDT', 'same-symbol-2'), quote).status).toBe(
      'SUPPRESSED',
    );
    expect(engine.open(intent('MICRO_BURST_V1', 'BTCUSDT', 'cross-symbol'), quote).status).toBe(
      'OPENED',
    );
    expect(engine.open(intent('MOMENTUM_RIDE', 'ETHUSDT', 'cross-strategy'), quote).status).toBe(
      'OPENED',
    );
  });

  it('restores an open position after flush and restart', () => {
    const config = defaultMicroBurstConfig();
    const journal = new MemoryJournal();
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MICRO_BURST_V1', new MicroBurstShadowPolicyAdapter(config)]] as const),
    );
    const testCase: Case = {
      name: 'restart',
      side: 'LONG',
      destination: 110,
      stop: 90,
      observations: [],
    };
    const entry = signal(testCase);
    engine.open(
      {
        strategyId: 'MICRO_BURST_V1',
        strategyVersion: 'golden',
        symbol: 'ETHUSDT',
        side: 'LONG',
        decisionAtMs: 1_000,
        decisionReceivedAtMs: 1_000,
        referencePrice: 100,
        structuralStop: 90,
        destination: 110,
        parentDecisionId: entry.shadowSignalId,
        provenance,
      },
      shadowQuote(quote),
    );
    engine.manage(
      { strategyId: 'MICRO_BURST_V1', symbol: 'ETHUSDT' },
      {
        currentPrice: 101,
        receivedAtMs: 2_000,
        exchangeTimeMs: 2_000,
        quote,
        marketDataQuality: 'HEALTHY',
      },
    );
    engine.flush();
    const restarted = new ShadowTradingEngine(
      journal,
      new Map([['MICRO_BURST_V1', new MicroBurstShadowPolicyAdapter(config)]] as const),
    );
    expect(restarted.getOpenPositions()).toHaveLength(1);
    expect(restarted.getOpenPositions()[0].peakPrice).toBe(101);
  });
});
