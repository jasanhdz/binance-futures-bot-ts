import { promises as fs } from 'fs';
import path from 'path';
import { RegimeEngineV2InputCandle } from '../../domain/services/regime-v2/RegimeEngineV2.types';
import {
    buildRegimeEngineV2AuditSamples,
    HitOutcome,
    loadRegimeEngineV2Candles,
    RegimeEngineV2AuditOptions,
    RegimeEngineV2AuditSample
} from './regimeEngineV2AuditCore';

export type RegimeEngineV2MlDatasetOptions = RegimeEngineV2AuditOptions & {
    outputDir?: string;
    source?: string;
};

export type RegimeEngineV2MlDatasetRow = Record<string, string | number | boolean | undefined>;

export type RegimeEngineV2MlDatasetResult = {
    generatedAt: string;
    rows: RegimeEngineV2MlDatasetRow[];
    outputFiles?: {
        csv: string;
        jsonl: string;
        schema: string;
    };
};

const DATASET_COLUMNS = [
    'timestamp',
    'symbol',
    'side',
    'close',
    'horizonMinutes',
    'target_hit5_before_minus5',
    'target_hit8_before_minus5',
    'target_hit10_before_minus8',
    'target_forward_return_roe_60m',
    'target_mfe_roe_60m',
    'target_mae_roe_60m',
    'target_mfe_mae_ratio_60m',
    'target_time_to_8_minutes',
    'target_false_breakout',
    'technicalRegime',
    'momentumEnvironment',
    'confidence',
    'technicalDirection',
    'transitionRisk',
    'marketConfirmationState',
    'trendStrength',
    'momentumQuality',
    'chopRisk',
    'exhaustionRisk',
    'transitionRiskScore',
    'volatilityRisk',
    'marketConfirmationScore',
    'ema7Slope',
    'ema25Slope',
    'emaStackAge',
    'adx',
    'adxSlope',
    'choppiness',
    'atrPercentile',
    'bollingerWidthPercentile',
    'volumeRatio',
    'volumeTrend',
    'closeLocation',
    'wickRatio',
    'bodySizePercentile',
    'distanceFromEma25Pct',
    'distanceFromEma99Pct',
    'failedBreakoutCount',
    'breakoutStrengthPct',
    'breakoutCloseBeyondRangePct',
    'breakoutVolumePersistence',
    'breakoutFollowThroughScore',
    'failedBreakoutPressure',
    'adverseWickAgainstBreakout',
    'lowerWickRatio',
    'breakdownCloseBeyondRangePct',
    'lowerWickAgainstBreakdown',
    'shortBreakdownQuality',
    'shortSweepRisk',
    'shortContinuationScore',
    'shortRetestScore',
    'shortExtensionRisk',
    'shortAbsorptionRisk',
    'shortVolumePersistence',
    'shortAdverseReboundRisk',
    'patternKind',
    'consecutiveCandles',
    'patternVolumeRatio',
    'patternCloseLocation',
    'patternWickRatio',
    'patternDistanceFromEma25Pct',
    'patternBreakout',
    'btcAction',
    'btcScore',
    'ethAction',
    'ethScore',
    'feeBps',
    'slippageBps',
    'leverageProxy',
    'sampleEvery',
    'source'
];

export async function exportRegimeEngineV2MlDataset(options: RegimeEngineV2MlDatasetOptions = {}): Promise<RegimeEngineV2MlDatasetResult> {
    const loaded = loadRegimeEngineV2Candles(options);
    const rows = buildRegimeEngineV2MlDatasetRows(loaded.candlesBySymbol, {
        ...options,
        symbols: loaded.symbols,
        momentumPatternOnly: true,
        horizons: [60],
        warnings: loaded.warnings
    });
    const result: RegimeEngineV2MlDatasetResult = {
        generatedAt: new Date().toISOString(),
        rows
    };
    result.outputFiles = await writeDatasetFiles(result, options.outputDir ?? options.reportsDir ?? '/home/jasan/Develop');
    return result;
}

export function buildRegimeEngineV2MlDatasetRows(
    candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>,
    options: RegimeEngineV2MlDatasetOptions & { warnings?: string[] } = {}
): RegimeEngineV2MlDatasetRow[] {
    const { samples, sampleEvery, leverage, feeBps, slippageBps } = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
        ...options,
        momentumPatternOnly: true,
        horizons: [60]
    });
    return samples
        .filter((sample) => sample.pattern)
        .map((sample) => datasetRow(sample, {
            sampleEvery,
            leverage,
            feeBps,
            slippageBps,
            source: options.source ?? 'regime_engine_v2_v23'
        }));
}

function datasetRow(
    sample: RegimeEngineV2AuditSample,
    meta: { sampleEvery: number; leverage: number; feeBps: number; slippageBps: number; source: string }
): RegimeEngineV2MlDatasetRow {
    const decision = sample.decision;
    const indicators = decision.indicators;
    const scores = decision.scores;
    const pattern = sample.pattern;
    const outcome = sample.outcomes['60m'];
    return {
        timestamp: sample.timestamp,
        symbol: sample.symbol,
        side: sample.side,
        close: sample.close,
        horizonMinutes: 60,
        target_hit5_before_minus5: hitToFlag(outcome.hit5BeforeMinus5),
        target_hit8_before_minus5: hitToFlag(outcome.hit8BeforeMinus5),
        target_hit10_before_minus8: hitToFlag(outcome.hit10BeforeMinus8),
        target_forward_return_roe_60m: outcome.forwardReturnRoe,
        target_mfe_roe_60m: outcome.mfeRoe,
        target_mae_roe_60m: outcome.maeRoe,
        target_mfe_mae_ratio_60m: outcome.mfeMaeRatio,
        target_time_to_8_minutes: outcome.timeTo8Minutes,
        target_false_breakout: outcome.falseBreakout === undefined ? undefined : outcome.falseBreakout ? 1 : 0,
        technicalRegime: decision.technicalRegime,
        momentumEnvironment: decision.momentumEnvironment,
        confidence: decision.confidence,
        technicalDirection: decision.technicalDirection,
        transitionRisk: decision.transition.risk,
        marketConfirmationState: decision.marketConfirmation.state,
        trendStrength: scores.trendStrength,
        momentumQuality: scores.momentumQuality,
        chopRisk: scores.chopRisk,
        exhaustionRisk: scores.exhaustionRisk,
        transitionRiskScore: scores.transitionRisk,
        volatilityRisk: scores.volatilityRisk,
        marketConfirmationScore: scores.marketConfirmationScore,
        ema7Slope: indicators.ema7Slope,
        ema25Slope: indicators.ema25Slope,
        emaStackAge: indicators.emaStackAge,
        adx: indicators.adx,
        adxSlope: indicators.adxSlope,
        choppiness: indicators.choppiness,
        atrPercentile: indicators.atrPercentile,
        bollingerWidthPercentile: indicators.bollingerWidthPercentile,
        volumeRatio: indicators.volumeRatio,
        volumeTrend: indicators.volumeTrend,
        closeLocation: indicators.closeLocation,
        wickRatio: indicators.wickRatio,
        bodySizePercentile: indicators.bodySizePercentile,
        distanceFromEma25Pct: indicators.distanceFromEma25Pct,
        distanceFromEma99Pct: indicators.distanceFromEma99Pct,
        failedBreakoutCount: indicators.failedBreakoutCount,
        breakoutStrengthPct: indicators.breakoutStrengthPct,
        breakoutCloseBeyondRangePct: indicators.breakoutCloseBeyondRangePct,
        breakoutVolumePersistence: indicators.breakoutVolumePersistence,
        breakoutFollowThroughScore: indicators.breakoutFollowThroughScore,
        failedBreakoutPressure: indicators.failedBreakoutPressure,
        adverseWickAgainstBreakout: indicators.adverseWickAgainstBreakout,
        lowerWickRatio: indicators.lowerWickRatio,
        breakdownCloseBeyondRangePct: indicators.breakdownCloseBeyondRangePct,
        lowerWickAgainstBreakdown: indicators.lowerWickAgainstBreakdown,
        shortBreakdownQuality: indicators.shortBreakdownQuality,
        shortSweepRisk: indicators.shortSweepRisk,
        shortContinuationScore: indicators.shortContinuationScore,
        shortRetestScore: indicators.shortRetestScore,
        shortExtensionRisk: indicators.shortExtensionRisk,
        shortAbsorptionRisk: indicators.shortAbsorptionRisk,
        shortVolumePersistence: indicators.shortVolumePersistence,
        shortAdverseReboundRisk: indicators.shortAdverseReboundRisk,
        patternKind: pattern?.kind,
        consecutiveCandles: pattern?.indicators.consecutiveCandles,
        patternVolumeRatio: pattern?.indicators.volumeRatio,
        patternCloseLocation: pattern?.indicators.closeLocation,
        patternWickRatio: pattern?.indicators.wickRatio,
        patternDistanceFromEma25Pct: pattern?.indicators.distanceFromEma25Pct,
        patternBreakout: pattern?.indicators.breakout,
        btcAction: decision.marketConfirmation.btc?.action,
        btcScore: decision.marketConfirmation.btc?.score,
        ethAction: decision.marketConfirmation.eth?.action,
        ethScore: decision.marketConfirmation.eth?.score,
        feeBps: meta.feeBps,
        slippageBps: meta.slippageBps,
        leverageProxy: meta.leverage,
        sampleEvery: meta.sampleEvery,
        source: meta.source
    };
}

async function writeDatasetFiles(result: RegimeEngineV2MlDatasetResult, outputDir: string): Promise<RegimeEngineV2MlDatasetResult['outputFiles']> {
    await fs.mkdir(outputDir, { recursive: true });
    const stamp = result.generatedAt.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
    const csv = path.join(outputDir, `aegis_regime_engine_v2_ml_dataset_${stamp}.csv`);
    const jsonl = path.join(outputDir, `aegis_regime_engine_v2_ml_dataset_${stamp}.jsonl`);
    const schema = path.join(outputDir, `aegis_regime_engine_v2_ml_dataset_schema_${stamp}.md`);
    await fs.writeFile(csv, rowsToCsv(result.rows), 'utf8');
    await fs.writeFile(jsonl, result.rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await fs.writeFile(schema, schemaMarkdown(), 'utf8');
    return { csv, jsonl, schema };
}

function rowsToCsv(rows: RegimeEngineV2MlDatasetRow[]): string {
    return [
        DATASET_COLUMNS.join(','),
        ...rows.map((row) => DATASET_COLUMNS.map((column) => csvValue(row[column])).join(','))
    ].join('\n') + '\n';
}

function schemaMarkdown(): string {
    return [
        '# RegimeEngineV2 ML Dataset Schema',
        '',
        'Each row is an offline Momentum Ride-like pattern sample. Features use candles up to the sample timestamp only. Target columns use future candles and must not be used as features.',
        '',
        ...DATASET_COLUMNS.map((column) => `- ${column}`)
    ].join('\n') + '\n';
}

function hitToFlag(value: HitOutcome | undefined): number | undefined {
    return value === undefined ? undefined : value === 'TARGET_FIRST' ? 1 : 0;
}

function csvValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
