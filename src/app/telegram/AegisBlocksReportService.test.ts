import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AegisBlocksReportService } from './AegisBlocksReportService';

const NOW = new Date('2026-05-18T12:00:00.000Z');

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-blocks-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function service(): AegisBlocksReportService {
  return new AegisBlocksReportService({ baseDir: tempDir, now: () => NOW });
}

async function writeEvents(rows: Array<Record<string, unknown> | string>): Promise<void> {
  const lines = rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
  await fs.writeFile(
    path.join(tempDir, 'turbo_trade_events_2026-05-18.jsonl'),
    `${lines}\n`,
    'utf8',
  );
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-05-18T11:30:00.000Z',
    symbol: 'LINKUSDT',
    strategy: 'AEGIS_TURBO',
    mode: 'AEGIS_TURBO_MICRO_LIVE',
    event: 'DECISION_ENFORCEMENT_DENIED',
    reason: 'decision_brain_wait_confirmation',
    metadata: {
      symbol: 'LINKUSDT',
      side: 'LONG',
      turboScore: 0.84,
      votes: { long: 2, short: 0, neutral: 1 },
      decisionBrainDecision: 'WAIT_CONFIRMATION',
      entryQualityRecommendation: 'ALLOW_SHADOW',
      entryQualityScore: 0.72,
      tailRiskScore: 0.41,
      eventRiskMode: 'CAUTION',
      eventRiskReason: 'weak setup',
      eventRiskWouldBlock: true,
      setupGrade: 'A',
      aPlus: false,
      source: 'DECISION_ENFORCEMENT_DENIED',
    },
    ...overrides,
  };
}

describe('AegisBlocksReportService', () => {
  it('parsea ventana default 1h', () => {
    const parsed = service().parseCommand([]);

    expect(parsed).toMatchObject({ valid: true, mode: 'summary', windowMinutes: 60 });
  });

  it('parsea /blocks 4h', () => {
    const parsed = service().parseCommand(['4h']);

    expect(parsed).toMatchObject({ valid: true, mode: 'summary', windowMinutes: 240 });
  });

  it('parsea /blocks LINKUSDT', () => {
    const parsed = service().parseCommand(['LINKUSDT']);

    expect(parsed).toMatchObject({
      valid: true,
      mode: 'summary',
      symbol: 'LINKUSDT',
      windowMinutes: 60,
    });
  });

  it('agrupa por símbolo', async () => {
    await writeEvents([
      event({ symbol: 'LINKUSDT', metadata: { symbol: 'LINKUSDT', side: 'LONG' } }),
      event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'SHORT' } }),
      event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'LONG' } }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.bySymbol).toMatchObject({ LINKUSDT: 1, ADAUSDT: 2 });
  });

  it('agrupa por reason', async () => {
    await writeEvents([
      event({ reason: 'decision_brain_wait_confirmation' }),
      event({ reason: 'decision_brain_do_not_enter' }),
      event({ reason: 'decision_brain_do_not_enter' }),
    ]);

    const report = await service().buildReport({ mode: 'reasons', windowMinutes: 60 });

    expect(report.byReason).toMatchObject({
      decision_brain_wait_confirmation: 1,
      decision_brain_do_not_enter: 2,
    });
  });

  it('agrupa por setupGrade', async () => {
    await writeEvents([
      event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A' } }),
      event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A_PLUS' } }),
      event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A_PLUS' } }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.bySetupGrade).toMatchObject({ A: 1, A_PLUS: 2 });
  });

  it('ignora JSON corrupto y reporta warning', async () => {
    await writeEvents([event(), '{bad json']);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.warnings[0]).toContain('líneas JSON corruptas ignoradas');
  });

  it('near-miss ordena por A_PLUS/score', async () => {
    await writeEvents([
      event({
        symbol: 'ADAUSDT',
        metadata: {
          symbol: 'ADAUSDT',
          side: 'LONG',
          setupGrade: 'A',
          turboScore: 0.99,
          entryQualityRecommendation: 'ALLOW',
        },
      }),
      event({
        symbol: 'LINKUSDT',
        metadata: {
          symbol: 'LINKUSDT',
          side: 'LONG',
          setupGrade: 'A_PLUS',
          turboScore: 0.81,
          entryQualityRecommendation: 'ALLOW_SHADOW',
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });

    expect(report.nearMisses.map((sample) => sample.symbol)).toEqual(['LINKUSDT', 'ADAUSDT']);
  });

  it('detail SYMBOL filtra correctamente', async () => {
    await writeEvents([
      event({ symbol: 'LINKUSDT', metadata: { symbol: 'LINKUSDT', side: 'LONG' } }),
      event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'LONG' } }),
    ]);

    const report = await service().buildReport({
      mode: 'detail',
      symbol: 'ADAUSDT',
      windowMinutes: 60,
    });

    expect(report.totalBlocks).toBe(1);
    expect(report.bySymbol).toMatchObject({ ADAUSDT: 1 });
    expect(report.bySymbol.LINKUSDT).toBeUndefined();
  });

  it('limita ventana máxima a 24h', () => {
    const parsed = service().parseCommand(['LINKUSDT', '24h']);

    expect(parsed).toMatchObject({ valid: true, windowMinutes: 1440 });
  });

  it('cuenta GATE_ALLOWED/ORDER_SUBMITTED', async () => {
    await writeEvents([
      event(),
      event({ event: 'GATE_ALLOWED', reason: 'ok' }),
      event({ event: 'ORDER_SUBMITTED', reason: 'ok' }),
      event({ event: 'PROBE_MODE_ALLOWED', reason: 'probe_allowed' }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.allowedEvents).toMatchObject({
      GATE_ALLOWED: 1,
      ORDER_SUBMITTED: 1,
      PROBE_MODE_ALLOWED: 1,
    });
  });

  it('no cuenta momentum_shadow_allow como bloqueo real', async () => {
    await writeEvents([
      event({ event: 'MOMENTUM_RIDE_DIAGNOSTIC', reason: 'momentum_shadow_allow' }),
      event({ event: 'MOMENTUM_RIDE_DIAGNOSTIC', reason: 'momentum_pattern_detected' }),
      event({ event: 'MOMENTUM_RIDE_DIAGNOSTIC', reason: 'momentum_shadow_deny' }),
      event({ event: 'MOMENTUM_RIDE_DIAGNOSTIC', reason: 'momentum_turbo_confirmed' }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
  });

  it('no cuenta momentum_turbo_contradict como bloqueo si viene solo como diagnóstico Momentum', async () => {
    await writeEvents([
      event({ event: 'MOMENTUM_RIDE_DIAGNOSTIC', reason: 'momentum_turbo_contradict' }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
    expect(report.byReason.momentum_turbo_contradict).toBeUndefined();
  });

  it('no cuenta momentum_regime_not_confirmed si EntryPolicy final permite Aegis Turbo', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalReason: 'all_enforced_guards_allowed',
          finalStrategy: 'aegis_turbo',
          strategyCandidates: {
            momentum_ride: { decision: 'DENY', reason: 'momentum_regime_not_confirmed' },
            aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
          },
          momentumRide: {
            patternDetected: true,
            reasons: ['momentum_pattern_detected', 'momentum_regime_not_confirmed'],
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
    expect(report.byReason.momentum_regime_not_confirmed).toBeUndefined();
  });

  it('no cuenta regime_context_insufficient_data como bloqueo si viene solo como diagnóstico', async () => {
    await writeEvents([
      event({ event: 'REGIME_CONTEXT_DIAGNOSTIC', reason: 'regime_context_insufficient_data' }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
    expect(report.byReason.regime_context_insufficient_data).toBeUndefined();
  });

  it('no cuenta regime_context_insufficient_data si EntryPolicy final permite la entrada', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalReason: 'all_enforced_guards_allowed',
          finalStrategy: 'aegis_turbo',
          regimeContext: {
            insufficientData: true,
            reason: 'regime_context_insufficient_data',
            globalBlockingDisabled: true,
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
    expect(report.byReason.regime_context_insufficient_data).toBeUndefined();
  });

  it('no cuenta long_risk_shadow como bloqueo real si EntryPolicy final permite la entrada', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: {
          symbol: 'ETHUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalReason: 'all_enforced_guards_allowed',
          finalStrategy: 'aegis_turbo',
          longRiskShadow: {
            decision: 'SHADOW_DENY',
            reason: 'long_risk_shadow_multi_factor',
            wouldBlock: true,
            riskLevel: 'CRITICAL',
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
    expect(report.byReason.long_risk_shadow_multi_factor).toBeUndefined();
  });

  it('cuenta long_risk_probe_long_critical cuando EntryPolicy final bloquea', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'long_risk_probe_long_critical',
        metadata: {
          symbol: 'SUIUSDT',
          side: 'LONG',
          finalDecision: 'DENY',
          finalReason: 'long_risk_probe_long_critical',
          finalStrategy: 'none',
          deniedBy: 'long_risk_shadow',
          longRiskShadow: {
            decision: 'DENY',
            reason: 'long_risk_probe_long_critical',
            riskLevel: 'CRITICAL',
            enforcementApplied: true,
            blockedProbeLong: true,
            actionTaken: 'BLOCK',
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ long_risk_probe_long_critical: 1 });
  });

  it('ENTRY_POLICY_DECISION DENY cuenta por finalReason real aunque incluya diagnóstico Momentum', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'entry_policy_decision',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          finalDecision: 'DENY',
          finalReason: 'decision_brain_do_not_enter',
          finalStrategy: 'none',
          strategyCandidates: {
            momentum_ride: { decision: 'DENY', reason: 'momentum_turbo_contradict' },
            aegis_turbo: { decision: 'DENY', reason: 'decision_brain_do_not_enter' },
          },
          momentumRide: {
            patternDetected: true,
            reasons: ['momentum_pattern_detected', 'momentum_turbo_contradict'],
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ decision_brain_do_not_enter: 1 });
    expect(report.byReason.momentum_turbo_contradict).toBeUndefined();
  });

  it('ENTRY_POLICY_DECISION DENY cuenta por finalReason real aunque incluya diagnóstico RegimeContext', async () => {
    await writeEvents([
      event({
        event: 'ENTRY_POLICY_DECISION',
        reason: 'entry_policy_decision',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          finalDecision: 'DENY',
          finalReason: 'decision_brain_do_not_enter',
          finalStrategy: 'none',
          regimeContext: {
            insufficientData: true,
            reason: 'regime_context_insufficient_data',
            globalBlockingDisabled: true,
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ decision_brain_do_not_enter: 1 });
    expect(report.byReason.regime_context_insufficient_data).toBeUndefined();
  });

  it('soporta campos faltantes', async () => {
    await writeEvents([
      {
        timestamp: '2026-05-18T11:45:00.000Z',
        symbol: 'BTCUSDT',
        event: 'GATE_DENIED',
        reason: 'raw_would_execute_false',
      },
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.bySide).toMatchObject({ 'N/D': 1 });
    expect(report.samples[0].tailRiskScore).toBeNull();
  });

  it('/blocks cuenta la razón específica de Clean Entry', async () => {
    await writeEvents([
      event({
        event: 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION',
        reason: 'clean_entry_wait_confirmation',
        metadata: {
          cleanEntryGuard: {
            symbol: 'LINKUSDT',
            side: 'LONG',
            decision: 'WAIT_CONFIRMATION',
            reasons: ['clean_entry_event_risk_would_block'],
            decisionBrain: 'ENTER_NOW',
            entryQualityRecommendation: 'ALLOW_SHADOW',
            entryQualityRuleGateReason: 'insufficient_data',
            tailRiskScore: 0.33,
            eventRiskWouldBlock: true,
            setupGrade: 'A',
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ clean_entry_event_risk_would_block: 1 });
    expect(report.samples[0]).toMatchObject({
      symbol: 'LINKUSDT',
      reason: 'clean_entry_event_risk_would_block',
      decisionBrain: 'ENTER_NOW',
      entryQuality: 'ALLOW_SHADOW',
      setupGrade: 'A',
    });
  });

  it('/blocks detail SYMBOL muestra reason clean entry nuevo', async () => {
    await writeEvents([
      event({
        symbol: 'ADAUSDT',
        event: 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION',
        reason: 'clean_entry_wait_confirmation',
        metadata: { symbol: 'ADAUSDT', side: 'LONG' },
      }),
    ]);

    const messages = await service().buildTelegramMessages(['detail', 'ADAUSDT']);

    expect(messages.join('\n')).toContain('clean_entry_wait_confirmation');
  });

  it('/blocks near-miss puede incluir clean entry wait', async () => {
    await writeEvents([
      event({
        symbol: 'LINKUSDT',
        event: 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION',
        reason: 'clean_entry_wait_confirmation',
        metadata: {
          cleanEntryGuard: {
            symbol: 'LINKUSDT',
            side: 'LONG',
            turboScore: 0.91,
            setupGrade: 'A',
            decisionBrain: 'ENTER_NOW',
            entryQualityRecommendation: 'ALLOW_SHADOW',
            tailRiskScore: 0.39,
            eventRiskWouldBlock: false,
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });

    expect(report.nearMisses[0]).toMatchObject({
      symbol: 'LINKUSDT',
      reason: 'clean_entry_wait_confirmation',
    });
  });

  it('/blocks reconoce PROBE_MODE_DENIED y muestra metadata en near-miss', async () => {
    await writeEvents([
      event({
        symbol: 'ADAUSDT',
        event: 'PROBE_MODE_DENIED',
        reason: 'probe_tail_risk_too_high',
        metadata: {
          symbol: 'ADAUSDT',
          side: 'LONG',
          turboScore: 0.94,
          tailRiskScore: 0.31,
          setupGrade: 'A',
          decisionBrainDecision: 'ENTER_NOW',
          entryQualityModelRecommendation: 'ALLOW_SHADOW',
          eventRiskMode: 'CAUTION',
          probeMode: {
            enabled: true,
            allowed: false,
            reason: 'probe_tail_risk_too_high',
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });
    const messages = await service().buildTelegramMessages(['near-miss']);

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ probe_tail_risk_too_high: 1 });
    expect(report.nearMisses[0]).toMatchObject({
      symbol: 'ADAUSDT',
      probeMode: {
        enabled: true,
        allowed: false,
        reason: 'probe_tail_risk_too_high',
      },
    });
    expect(messages.join('\n')).toContain('Probe: DENY | probe_tail_risk_too_high');
  });

  it('/blocks reconoce ENTRY_POLICY_DECISION denegado y muestra EntryPolicy', async () => {
    await writeEvents([
      event({
        symbol: 'XRPUSDT',
        event: 'ENTRY_POLICY_DECISION',
        reason: 'entry_policy_decision',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          turboScore: 0.93,
          entryQualityRecommendation: 'ALLOW_SHADOW',
          tailRiskScore: 0.22,
          entryPolicy: {
            finalDecision: 'WAIT_CONFIRMATION',
            finalReason: 'probe_min_minutes_between_entries',
          },
        },
      }),
      event({
        symbol: 'BTCUSDT',
        event: 'ENTRY_POLICY_DECISION',
        reason: 'entry_policy_decision',
        metadata: {
          symbol: 'BTCUSDT',
          side: 'LONG',
          entryPolicy: {
            finalDecision: 'ALLOW',
            finalReason: 'all_enforced_guards_allowed',
          },
        },
      }),
      event({
        symbol: 'XRPUSDT',
        event: 'PROBE_MODE_DENIED',
        reason: 'probe_min_minutes_between_entries',
        metadata: {
          symbol: 'XRPUSDT',
          side: 'LONG',
          probeMode: {
            enabled: true,
            allowed: false,
            reason: 'probe_min_minutes_between_entries',
          },
          entryPolicy: {
            finalDecision: 'WAIT_CONFIRMATION',
            finalReason: 'probe_min_minutes_between_entries',
          },
        },
      }),
    ]);

    const report = await service().buildReport({
      mode: 'detail',
      symbol: 'XRPUSDT',
      windowMinutes: 60,
    });
    const messages = await service().buildTelegramMessages(['detail', 'XRPUSDT']);

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ probe_min_minutes_between_entries: 1 });
    expect(report.samples[0]).toMatchObject({
      symbol: 'XRPUSDT',
      entryPolicy: {
        finalDecision: 'WAIT_CONFIRMATION',
        finalReason: 'probe_min_minutes_between_entries',
      },
    });
    expect(messages.join('\n')).toContain(
      'EntryPolicy: WAIT_CONFIRMATION | probe_min_minutes_between_entries',
    );
  });

  it('/blocks muestra regime metadata en ENTRY_POLICY_DECISION y near-miss', async () => {
    await writeEvents([
      event({
        symbol: 'ADAUSDT',
        event: 'ENTRY_POLICY_DECISION',
        reason: 'regime_alt_long_btc_short_block',
        metadata: {
          symbol: 'ADAUSDT',
          side: 'LONG',
          turboScore: 0.94,
          setupGrade: 'A',
          finalDecision: 'DENY',
          finalReason: 'regime_alt_long_btc_short_block',
          regime: {
            regime: 'RISK_OFF',
            confidence: 0.78,
            reason: 'regime_alt_long_btc_short_block',
            source: 'HYBRID_HEURISTIC',
            wouldBlock: true,
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });
    const messages = await service().buildTelegramMessages(['near-miss']);

    expect(report.totalBlocks).toBe(1);
    expect(report.byReason).toMatchObject({ regime_alt_long_btc_short_block: 1 });
    expect(report.nearMisses[0].entryPolicy).toMatchObject({
      finalDecision: 'DENY',
      finalReason: 'regime_alt_long_btc_short_block',
    });
    expect(report.nearMisses[0].regime).toMatchObject({
      label: 'RISK_OFF',
      confidence: 0.78,
      reason: 'regime_alt_long_btc_short_block',
      source: 'HYBRID_HEURISTIC',
      wouldBlock: true,
    });
    expect(messages.join('\n')).toContain(
      'Regime: RISK_OFF 78.0% | regime_alt_long_btc_short_block',
    );
  });

  it('/blocks no cuenta ENTRY_POLICY_DECISION ALLOW aunque regime sea SHADOW_DENY', async () => {
    await writeEvents([
      event({
        symbol: 'ADAUSDT',
        event: 'ENTRY_POLICY_DECISION',
        reason: 'all_enforced_guards_allowed',
        metadata: {
          symbol: 'ADAUSDT',
          side: 'LONG',
          finalDecision: 'ALLOW',
          finalReason: 'all_enforced_guards_allowed',
          regime: {
            regime: 'CHOP',
            confidence: 0.7,
            decision: 'SHADOW_DENY',
            reason: 'regime_shadow_would_block',
            source: 'HYBRID_HEURISTIC',
            wouldBlock: true,
          },
        },
      }),
    ]);

    const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

    expect(report.totalBlocks).toBe(0);
  });
});
