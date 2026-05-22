import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AegisProbeReportService, detectExitReasonLabelMismatches } from './AegisProbeReportService';

const NOW = new Date('2026-05-22T02:00:00.000Z');

let tempDir: string;

beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-probe-'));
});

afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
});

function service(): AegisProbeReportService {
    return new AegisProbeReportService({ baseDir: tempDir, now: () => NOW });
}

async function writeEvents(rows: Array<Record<string, unknown> | string>): Promise<void> {
    const lines = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
    await fs.writeFile(path.join(tempDir, 'turbo_trade_events_2026-05-22.jsonl'), `${lines}\n`, 'utf8');
}

async function writeTrades(rows: Array<Record<string, unknown> | string>): Promise<void> {
    const lines = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
    await fs.writeFile(path.join(tempDir, 'turbo_trades_2026-05-22.jsonl'), `${lines}\n`, 'utf8');
}

function probeAllowed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        timestamp: '2026-05-22T01:00:00.000Z',
        trade_id: 'probe-1',
        symbol: 'AVAXUSDT',
        event: 'ENTRY_POLICY_DECISION',
        reason: 'probe_mode_allowed',
        metadata: {
            finalDecision: 'ALLOW',
            finalReason: 'probe_mode_allowed',
            guards: {
                probe_mode: { decision: 'ALLOW', reason: 'probe_allowed' }
            },
            cleanEntryGuard: {
                decision: 'WAIT_CONFIRMATION',
                reasons: ['clean_entry_event_risk_would_block'],
                setupGrade: 'A_PLUS',
                decisionBrain: 'ENTER_NOW',
                entryQualityRecommendation: 'ALLOW_SHADOW',
                entryQualityScore: 0.672,
                tailRiskScore: 0.288,
                eventRiskMode: 'CAUTION',
                eventRiskReason: 'caution_btc_eth_not_confirmed',
                votes: { long: 0, short: 3, neutral: 0 }
            },
            probeMode: {
                allowed: true,
                reason: 'probe_allowed',
                turboScore: 0.907,
                tailRiskScore: 0.288,
                decisionBrain: 'ENTER_NOW',
                entryQualityRecommendation: 'ALLOW_SHADOW',
                eventRiskMode: 'CAUTION',
                eventRiskReason: 'caution_btc_eth_not_confirmed',
                cleanEntryReasons: ['clean_entry_event_risk_would_block']
            }
        },
        ...overrides
    };
}

function probeTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        timestamp: '2026-05-22T01:30:00.000Z',
        trade_id: 'probe-1',
        symbol: 'AVAXUSDT',
        side: 'SHORT',
        opened_at: '2026-05-22T01:00:00.000Z',
        closed_at: '2026-05-22T01:30:00.000Z',
        entry_price: 9.487,
        exit_price: 9.381,
        quantity: 28,
        leverage: 10,
        position_fraction: 0.18,
        margin_estimated: 26.46,
        exit_reason: 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
        pnl_usdt: 2.95,
        roe: 0.1113,
        duration_minutes: 30,
        mfe_roe: 0.1149,
        mae_roe: -0.0141,
        status: 'CLOSED',
        metadata: {
            estimated: true,
            exit_type: 'EXIT_EYE_OPPOSITE_SIGNAL',
            canonical_exit_type: 'EXIT_EYE_OPPOSITE_SIGNAL',
            display_exit_label: 'EXIT_EYE_OPPOSITE_SIGNAL',
            probeMode: {
                allowed: true,
                eventRiskReason: 'caution_btc_eth_not_confirmed',
                eventRiskMode: 'CAUTION',
                tailRiskScore: 0.288,
                turboScore: 0.907,
                cleanEntryReasons: ['clean_entry_event_risk_would_block']
            },
            cleanEntryGuard: {
                decision: 'WAIT_CONFIRMATION',
                reasons: ['clean_entry_event_risk_would_block'],
                setupGrade: 'A_PLUS',
                decisionBrain: 'ENTER_NOW',
                entryQualityRecommendation: 'ALLOW_SHADOW',
                entryQualityScore: 0.672,
                tailRiskScore: 0.288,
                eventRiskMode: 'CAUTION',
                eventRiskReason: 'caution_btc_eth_not_confirmed',
                votes: { long: 0, short: 3, neutral: 0 }
            },
            entryPolicy: { finalReason: 'probe_mode_allowed' }
        },
        ...overrides
    };
}

describe('AegisProbeReportService', () => {
    it('parsea /probe default 24h', () => {
        const parsed = service().parseCommand([]);

        expect(parsed).toMatchObject({ valid: true, mode: 'summary', windowMinutes: 1440 });
    });

    it('cuenta PROBE_MODE_ALLOWED y agrupa por EventRisk, TailRisk y setupGrade', async () => {
        await writeEvents([probeAllowed()]);
        await writeTrades([]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.totalEvaluations).toBe(1);
        expect(report.probeAllowed).toBe(1);
        expect(report.byEventRiskReason).toMatchObject({ caution_btc_eth_not_confirmed: 1 });
        expect(report.byTailRiskBand).toMatchObject({ '0.25-0.30': 1 });
        expect(report.bySetupGrade).toMatchObject({ A_PLUS: 1 });
    });

    it('calcula win/loss y métricas de trades cerrados ligados a probe_mode_allowed', async () => {
        await writeEvents([
            probeAllowed(),
            { timestamp: '2026-05-22T01:08:00.000Z', trade_id: 'probe-1', symbol: 'AVAXUSDT', event: 'BREAK_EVEN_ARMED', roe: 0.08 },
            { timestamp: '2026-05-22T01:12:00.000Z', trade_id: 'probe-1', symbol: 'AVAXUSDT', event: 'AEGIS_EXIT_EYE_CLOSE_POSITION', roe: 0.11 },
            { timestamp: '2026-05-22T01:30:00.000Z', trade_id: 'probe-1', symbol: 'AVAXUSDT', event: 'TRADE_CLOSED', roe: 0.1113 }
        ]);
        await writeTrades([probeTrade()]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 120 });

        expect(report.tradesOpenedByProbe).toBe(1);
        expect(report.tradesClosedByProbe).toBe(1);
        expect(report.winRate).toBe(1);
        expect(report.pnlTotal).toBeCloseTo(2.95);
        expect(report.exitEyeCloseCount).toBe(1);
        expect(report.breakEvenActivatedCount).toBe(1);
        expect(report.topTrades[0]).toMatchObject({ symbol: 'AVAXUSDT', roe: 0.1113 });
    });

    it('soporta JSON corrupto y trades sin cierre', async () => {
        await writeEvents([probeAllowed(), '{bad json']);
        await writeTrades([
            probeTrade({
                closed_at: undefined,
                exit_price: undefined,
                exit_reason: undefined,
                pnl_usdt: undefined,
                roe: undefined,
                status: 'OPEN'
            })
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 120 });

        expect(report.tradesOpenedByProbe).toBe(1);
        expect(report.tradesClosedByProbe).toBe(0);
        expect(report.warnings[0]).toContain('líneas JSON corruptas ignoradas');
    });

    it('detecta mismatch reason ExitEye con exitType trailing', () => {
        const mismatches = detectExitReasonLabelMismatches([
            probeTrade({
                exit_reason: 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
                metadata: { exit_type: 'TRAILING STOP EXIT' }
            })
        ]);

        expect(mismatches).toEqual([
            expect.objectContaining({
                tradeId: 'probe-1',
                mismatchReason: 'exit_eye_reason_with_trailing_exit_type'
            })
        ]);
    });

    it('no marca trailing real cuando hubo activación trailing', () => {
        const mismatches = detectExitReasonLabelMismatches([
            probeTrade({
                exit_reason: 'TRAILING_STOP_EXIT',
                metadata: { exit_type: 'TRAILING STOP EXIT' }
            }),
            {
                timestamp: '2026-05-22T01:15:00.000Z',
                trade_id: 'probe-1',
                symbol: 'AVAXUSDT',
                event: 'TRAILING_ACTIVATED'
            }
        ]);

        expect(mismatches).toEqual([]);
    });

    it('no marca TP ni SL reales con exitType consistente', () => {
        const mismatches = detectExitReasonLabelMismatches([
            probeTrade({
                trade_id: 'tp-1',
                exit_reason: 'TAKE_PROFIT',
                metadata: { exit_type: 'TAKE PROFIT (TP)' }
            }),
            probeTrade({
                trade_id: 'sl-1',
                exit_reason: 'STOP_LOSS',
                metadata: { exit_type: 'STOP LOSS (SL)' }
            })
        ]);

        expect(mismatches).toEqual([]);
    });

    it('marca trailing sin activación registrada', () => {
        const mismatches = detectExitReasonLabelMismatches([
            probeTrade({
                exit_reason: 'TRAILING_STOP_EXIT',
                metadata: { exit_type: 'TRAILING STOP EXIT' }
            })
        ]);

        expect(mismatches).toEqual([
            expect.objectContaining({
                tradeId: 'probe-1',
                mismatchReason: 'trailing_exit_type_without_trailing_activation'
            })
        ]);
    });

    it('formatea comandos detail y near-miss', async () => {
        await writeEvents([probeAllowed()]);
        await writeTrades([probeTrade()]);

        const detail = await service().buildTelegramMessages(['detail', 'AVAXUSDT']);
        const nearMiss = await service().buildTelegramMessages(['near-miss', '24h']);

        expect(detail.join('\n')).toContain('Probe Mode AVAXUSDT');
        expect(nearMiss.join('\n')).toContain('Near-miss recientes');
    });
});
