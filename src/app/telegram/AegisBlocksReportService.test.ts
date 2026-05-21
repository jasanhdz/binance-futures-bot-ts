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
    const lines = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
    await fs.writeFile(path.join(tempDir, 'turbo_trade_events_2026-05-18.jsonl'), `${lines}\n`, 'utf8');
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
            source: 'DECISION_ENFORCEMENT_DENIED'
        },
        ...overrides
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

        expect(parsed).toMatchObject({ valid: true, mode: 'summary', symbol: 'LINKUSDT', windowMinutes: 60 });
    });

    it('agrupa por símbolo', async () => {
        await writeEvents([
            event({ symbol: 'LINKUSDT', metadata: { symbol: 'LINKUSDT', side: 'LONG' } }),
            event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'SHORT' } }),
            event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'LONG' } })
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.bySymbol).toMatchObject({ LINKUSDT: 1, ADAUSDT: 2 });
    });

    it('agrupa por reason', async () => {
        await writeEvents([
            event({ reason: 'decision_brain_wait_confirmation' }),
            event({ reason: 'decision_brain_do_not_enter' }),
            event({ reason: 'decision_brain_do_not_enter' })
        ]);

        const report = await service().buildReport({ mode: 'reasons', windowMinutes: 60 });

        expect(report.byReason).toMatchObject({
            decision_brain_wait_confirmation: 1,
            decision_brain_do_not_enter: 2
        });
    });

    it('agrupa por setupGrade', async () => {
        await writeEvents([
            event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A' } }),
            event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A_PLUS' } }),
            event({ metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A_PLUS' } })
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.bySetupGrade).toMatchObject({ A: 1, A_PLUS: 2 });
    });

    it('ignora JSON corrupto y reporta warning', async () => {
        await writeEvents([
            event(),
            '{bad json'
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.totalBlocks).toBe(1);
        expect(report.warnings[0]).toContain('líneas JSON corruptas ignoradas');
    });

    it('near-miss ordena por A_PLUS/score', async () => {
        await writeEvents([
            event({
                symbol: 'ADAUSDT',
                metadata: { symbol: 'ADAUSDT', side: 'LONG', setupGrade: 'A', turboScore: 0.99, entryQualityRecommendation: 'ALLOW' }
            }),
            event({
                symbol: 'LINKUSDT',
                metadata: { symbol: 'LINKUSDT', side: 'LONG', setupGrade: 'A_PLUS', turboScore: 0.81, entryQualityRecommendation: 'ALLOW_SHADOW' }
            })
        ]);

        const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });

        expect(report.nearMisses.map((sample) => sample.symbol)).toEqual(['LINKUSDT', 'ADAUSDT']);
    });

    it('detail SYMBOL filtra correctamente', async () => {
        await writeEvents([
            event({ symbol: 'LINKUSDT', metadata: { symbol: 'LINKUSDT', side: 'LONG' } }),
            event({ symbol: 'ADAUSDT', metadata: { symbol: 'ADAUSDT', side: 'LONG' } })
        ]);

        const report = await service().buildReport({ mode: 'detail', symbol: 'ADAUSDT', windowMinutes: 60 });

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
            event({ event: 'PROBE_MODE_ALLOWED', reason: 'probe_allowed' })
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.allowedEvents).toMatchObject({ GATE_ALLOWED: 1, ORDER_SUBMITTED: 1, PROBE_MODE_ALLOWED: 1 });
    });

    it('soporta campos faltantes', async () => {
        await writeEvents([
            {
                timestamp: '2026-05-18T11:45:00.000Z',
                symbol: 'BTCUSDT',
                event: 'GATE_DENIED',
                reason: 'raw_would_execute_false'
            }
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
                        setupGrade: 'A'
                    }
                }
            })
        ]);

        const report = await service().buildReport({ mode: 'summary', windowMinutes: 60 });

        expect(report.totalBlocks).toBe(1);
        expect(report.byReason).toMatchObject({ clean_entry_event_risk_would_block: 1 });
        expect(report.samples[0]).toMatchObject({
            symbol: 'LINKUSDT',
            reason: 'clean_entry_event_risk_would_block',
            decisionBrain: 'ENTER_NOW',
            entryQuality: 'ALLOW_SHADOW',
            setupGrade: 'A'
        });
    });

    it('/blocks detail SYMBOL muestra reason clean entry nuevo', async () => {
        await writeEvents([
            event({
                symbol: 'ADAUSDT',
                event: 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION',
                reason: 'clean_entry_wait_confirmation',
                metadata: { symbol: 'ADAUSDT', side: 'LONG' }
            })
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
                        eventRiskWouldBlock: false
                    }
                }
            })
        ]);

        const report = await service().buildReport({ mode: 'near-miss', windowMinutes: 60 });

        expect(report.nearMisses[0]).toMatchObject({
            symbol: 'LINKUSDT',
            reason: 'clean_entry_wait_confirmation'
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
                        reason: 'probe_tail_risk_too_high'
                    }
                }
            })
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
                reason: 'probe_tail_risk_too_high'
            }
        });
        expect(messages.join('\n')).toContain('Probe: DENY | probe_tail_risk_too_high');
    });
});
