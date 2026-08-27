import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ProspectiveOutcomeRecord } from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';
import { analyzeMicroBurstProspective } from './MicroBurstProspectiveAnalyzer';

const fixture = (name: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures', name, 'data.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('MicroBurstProspectiveAnalyzer', () => {
  it('deduplicates fixture IDs, separates cohorts, and refuses fabricated controls', () => {
    const report = analyzeMicroBurstProspective({
      signals: fixture('signals'),
      outcomes: fixture('outcomes') as unknown as ProspectiveOutcomeRecord[],
      seed: 42,
    });

    expect(report.uniqueSignalCount).toBe(2);
    expect(report.uniqueOutcomeCount).toBe(2);
    expect(report.duplicateSignalRows).toBe(1);
    expect(report.duplicateOutcomeRows).toBe(1);
    expect(report.text).toContain('LONG SIGNAL_PRICE version=v1 config=cfg-a commit=sha-a N=1');
    expect(report.text).toContain('SHORT SIGNAL_PRICE version=v2 config=cfg-b commit=sha-b N=1');
    expect(report.text).toContain('missing usable 300s=1');
    expect(report.text).toContain('RANDOM_SIDE (seed=42): unavailable');
    expect(report.text).toContain('TIME_SHIFT (forward): unavailable');
  });

  it('reconstructs time-shift entry from the first post-shift trade without crossing symbols', () => {
    const signal = {
      shadowSignalId: 'shifted',
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'v1',
      codeCommitSha: 'sha',
      configHash: 'cfg',
      symbol: 'BTCUSDT',
      side: 'LONG',
      signalAtMs: 100,
      marketPriceAtSignal: 50,
      referencePriceSource: 'TEST',
      structuralStopPrice: 1,
      destinationPrice: 1_000,
      support: null,
      resistance: null,
      roomToTargetBps: 1,
      riskToInvalidationBps: 1,
      rewardRisk: 1,
      momentum: {},
      book: {},
      tradeFlow: {},
      btc: {},
      confidence: 1,
      leverageTier: 'TEST',
      leverage: 1,
      positionFraction: 1,
      microRegime: 'TEST',
    };
    const report = analyzeMicroBurstProspective({
      signals: [signal],
      outcomes: [],
      archiveTrades: (symbol) =>
        symbol === 'BTCUSDT'
          ? [
              {
                eventTime: 300_101,
                receivedAtMs: 300_101,
                price: 100,
                quantity: 1,
                isBuyerMaker: false,
              },
              {
                eventTime: 600_100,
                receivedAtMs: 600_100,
                price: 110,
                quantity: 1,
                isBuyerMaker: false,
              },
            ]
          : [
              {
                eventTime: 300_101,
                receivedAtMs: 300_101,
                price: 1,
                quantity: 1,
                isBuyerMaker: false,
              },
            ],
    });

    expect(report.text).toContain('TIME_SHIFT (forward 300s): N=1 mean_300s=1000.0bps');
    expect(report.text).toContain('first archived trade strictly after shifted T0');
  });

  it('reports unresolved terminal exports separately from missing outcomes', () => {
    const report = analyzeMicroBurstProspective({
      signals: [{ shadowSignalId: 'terminal' }],
      outcomes: [],
      unresolvedOutcomeIds: ['terminal'],
    });

    expect(report.unresolvedOutcomeCount).toBe(1);
    expect(report.text).toContain('signals without completed outcome: 1');
    expect(report.text).toContain('unresolved terminal journal exports: 1');
  });

  it('requires an explicit cohort when official data contains multiple cohorts', () => {
    const row = (id: string, cohortId: string) => ({ shadowSignalId: id, cohortId });
    expect(() => analyzeMicroBurstProspective({
      signals: [row('a', 'cohort-a'), row('b', 'cohort-b')],
      outcomes: [],
      official: true,
      availableCohorts: ['cohort-a', 'cohort-b'],
    })).toThrow('COHORT_SELECTION_REQUIRED');
  });

  it('reports deterministic episode bootstrap and attrition', () => {
    const report = analyzeMicroBurstProspective({
      signals: [{ shadowSignalId: 'a', episodeId: 'MBV1-EP-a' }],
      outcomes: [],
    });
    expect(report.text).toContain('Episode bootstrap/attrition: bootstrap=1; completed=0; attrition=1');
  });
});
