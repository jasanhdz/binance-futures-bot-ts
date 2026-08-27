import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AegisMomentumReportService } from './AegisMomentumReportService';

const NOW = new Date('2026-05-18T12:00:00.000Z');

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-momentum-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function service(): AegisMomentumReportService {
  return new AegisMomentumReportService({ baseDir: tempDir, now: () => NOW });
}

async function writeEvents(rows: Array<Record<string, unknown> | string>): Promise<void> {
  const lines = rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
  await fs.writeFile(
    path.join(tempDir, 'turbo_trade_events_2026-05-18.jsonl'),
    `${lines}\n`,
    'utf8',
  );
}

function momentumEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-05-18T11:30:00.000Z',
    symbol: 'XRPUSDT',
    event: 'ENTRY_POLICY_DECISION',
    reason: 'all_enforced_guards_allowed',
    metadata: {
      symbol: 'XRPUSDT',
      side: 'LONG',
      finalDecision: 'ALLOW',
      finalStrategy: 'aegis_turbo',
      strategyCandidates: {
        momentum_ride: { decision: 'SHADOW_ALLOW', reason: 'momentum_shadow_allow' },
        aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
      },
      momentumRide: {
        patternDetected: true,
        patternSide: 'LONG',
        candlesCount: 3,
        volumeRatio: 1.8,
        turboAgreement: true,
        btcEthAgreement: true,
        btcEthContradict: false,
        reasons: ['momentum_pattern_detected', 'momentum_turbo_confirmed'],
      },
      regimeContext: {
        label: 'MOMENTUM_UP',
        confidence: 0.82,
      },
      tailRiskScore: 0.22,
    },
    ...overrides,
  };
}

describe('AegisMomentumReportService', () => {
  it('parsea /momentum default 1h', () => {
    const parsed = service().parseCommand([]);

    expect(parsed).toMatchObject({ valid: true, mode: 'summary', windowMinutes: 60 });
  });

  it('cuenta momentum_shadow_allow como oportunidad shadow, no bloqueo', async () => {
    await writeEvents([momentumEvent()]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalEvaluations).toBe(1);
    expect(report.shadowAllow).toBe(1);
    expect(report.patternsDetected).toBe(1);
    expect(report.topCandidates[0]).toMatchObject({
      symbol: 'XRPUSDT',
      interpretation: 'Oportunidad hipotética en shadow',
    });
  });

  it('cuenta momentum_turbo_contradict como deny de Momentum', async () => {
    await writeEvents([
      momentumEvent({
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalStrategy: 'aegis_turbo',
          strategyCandidates: {
            momentum_ride: { decision: 'DENY', reason: 'momentum_turbo_contradict' },
            aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
          },
          momentumRide: {
            patternDetected: true,
            patternSide: 'LONG',
            candlesCount: 3,
            volumeRatio: 1.6,
            turboAgreement: false,
            btcEthContradict: false,
            reasons: ['momentum_pattern_detected', 'momentum_turbo_contradict'],
          },
          regimeContext: { label: 'MOMENTUM_UP', confidence: 0.8 },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.enforceDeny).toBe(1);
    expect(report.byReason).toMatchObject({ momentum_turbo_contradict: 1 });
  });

  it('clasifica finalStrategy=momentum_ride como entrada real Momentum', async () => {
    await writeEvents([
      momentumEvent({
        metadata: {
          symbol: 'ADAUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalStrategy: 'momentum_ride',
          riskProfile: { strategy: 'momentum_ride', leverage: 50 },
          strategyCandidates: {
            momentum_ride: { decision: 'ALLOW', reason: 'momentum_pattern_detected' },
            aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
          },
          momentumRide: {
            patternDetected: true,
            patternSide: 'LONG',
            candlesCount: 3,
            volumeRatio: 2.1,
            turboAgreement: true,
            reasons: ['momentum_pattern_detected', 'momentum_turbo_confirmed'],
          },
          regimeContext: { label: 'TREND_UP', confidence: 0.74 },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.enforceAllow).toBe(1);
    expect(report.finalStrategyMomentumRide).toBe(1);
    expect(report.samples[0]).toMatchObject({
      hasRiskProfile: true,
      interpretation: 'Entrada Momentum real',
    });
  });

  it('clasifica finalStrategy=aegis_turbo + momentum DENY como Aegis fallback', async () => {
    await writeEvents([
      momentumEvent({
        metadata: {
          symbol: 'ETHUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalStrategy: 'aegis_turbo',
          strategyCandidates: {
            momentum_ride: { decision: 'DENY', reason: 'momentum_regime_not_confirmed' },
            aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
          },
          momentumRide: {
            patternDetected: true,
            patternSide: 'LONG',
            candlesCount: 3,
            volumeRatio: 1.5,
            turboAgreement: true,
            reasons: ['momentum_pattern_detected', 'momentum_regime_not_confirmed'],
          },
          regimeContext: { label: 'CHOP', confidence: 0.6 },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.aegisFallbackAfterMomentumDeny).toBe(1);
    expect(report.samples[0].interpretation).toBe('Momentum no aplicó, Aegis siguió');
  });

  it('agrupa por symbol, reason y regime', async () => {
    await writeEvents([
      momentumEvent(),
      momentumEvent({
        symbol: 'ADAUSDT',
        metadata: {
          symbol: 'ADAUSDT',
          side: 'SHORT',
          finalDecision: 'ALLOW',
          finalStrategy: 'aegis_turbo',
          strategyCandidates: {
            momentum_ride: { decision: 'DENY', reason: 'momentum_tail_risk_high' },
            aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
          },
          momentumRide: {
            patternDetected: true,
            patternSide: 'SHORT',
            candlesCount: 3,
            volumeRatio: 1.7,
            turboAgreement: true,
            reasons: ['momentum_pattern_detected', 'momentum_tail_risk_high'],
          },
          regimeContext: { label: 'MOMENTUM_DOWN', confidence: 0.8 },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.bySymbol).toMatchObject({ XRPUSDT: 1, ADAUSDT: 1 });
    expect(report.byReason).toMatchObject({ momentum_tail_risk_high: 1 });
    expect(report.byRegime).toMatchObject({ MOMENTUM_UP: 1, MOMENTUM_DOWN: 1 });
  });

  it('detail SYMBOL filtra y soporta metadata faltante', async () => {
    await writeEvents([
      momentumEvent(),
      {
        timestamp: '2026-05-18T11:45:00.000Z',
        symbol: 'LINKUSDT',
        event: 'MOMENTUM_RIDE_DIAGNOSTIC',
        reason: 'momentum_turbo_not_confirmed',
        metadata: {
          symbol: 'LINKUSDT',
          side: 'LONG',
          momentumDecision: 'DENY',
        },
      },
    ]);

    const report = await service().buildReport({
      mode: 'detail',
      symbol: 'LINKUSDT',
      windowMinutes: 60,
    });

    expect(report.totalEvaluations).toBe(1);
    expect(report.samples[0]).toMatchObject({
      symbol: 'LINKUSDT',
      momentumReason: 'momentum_turbo_not_confirmed',
    });
  });

  it('ignora JSON corrupto y reporta warning', async () => {
    await writeEvents([momentumEvent(), '{bad json']);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalEvaluations).toBe(1);
    expect(report.warnings[0]).toContain('líneas JSON corruptas ignoradas');
  });

  it('formatea summary para Telegram', async () => {
    await writeEvents([momentumEvent()]);

    const messages = await service().buildTelegramMessages(['1h']);

    expect(messages.join('\n')).toContain('Momentum Ride');
    expect(messages.join('\n')).toContain('Total evaluaciones Momentum: 1');
    expect(messages.join('\n')).toContain('Top candidatos:');
  });
});
