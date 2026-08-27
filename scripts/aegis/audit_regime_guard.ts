#!/usr/bin/env ts-node
import path from 'path';
import { auditRegimeGuard, DEFAULT_REGIME_AUDIT_SYMBOLS, renderConsoleSummary } from '../../src/tooling/aegis/regimeGuardAuditCore';

type CliOptions = {
    logsDir?: string;
    candlesDbPath?: string;
    reportsDir?: string;
    days?: number;
    from?: string;
    to?: string;
    symbols?: string[];
    limit?: number;
    leverage?: number;
    writeReports?: boolean;
    includeHold?: boolean;
    timeframe?: string;
    momentumOnly?: boolean;
    momentumCandles?: 2 | 3;
    minVolumeRatio?: number;
    help?: boolean;
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(helpText());
        return;
    }

    const report = await auditRegimeGuard({
        logsDir: options.logsDir,
        candlesDbPath: options.candlesDbPath,
        reportsDir: options.reportsDir,
        days: options.days,
        from: options.from,
        to: options.to,
        symbols: options.symbols,
        limit: options.limit,
        leverage: options.leverage,
        writeReports: options.writeReports,
        includeHold: options.includeHold,
        timeframe: options.timeframe,
        momentumOnly: options.momentumOnly,
        momentumCandles: options.momentumCandles,
        minVolumeRatio: options.minVolumeRatio
    });
    console.log(renderConsoleSummary(report));
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        logsDir: path.join(process.cwd(), 'logs', 'aegis'),
        candlesDbPath: path.join(process.cwd(), '..', 'data', 'binance_candles.db'),
        reportsDir: path.join(process.cwd(), 'reports'),
        days: 7,
        symbols: DEFAULT_REGIME_AUDIT_SYMBOLS,
        limit: 2000,
        leverage: 20,
        writeReports: true,
        includeHold: false,
        timeframe: '5m',
        momentumOnly: false,
        momentumCandles: 3,
        minVolumeRatio: 1.3
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const next = () => args[++i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--logs-dir') options.logsDir = next();
        else if (arg === '--candles-db') options.candlesDbPath = next();
        else if (arg === '--reports-dir') options.reportsDir = next();
        else if (arg === '--days') options.days = Number(next());
        else if (arg === '--from') options.from = next();
        else if (arg === '--to') options.to = next();
        else if (arg === '--symbols') options.symbols = splitList(next());
        else if (arg === '--limit') options.limit = Number(next());
        else if (arg === '--leverage') options.leverage = Number(next());
        else if (arg === '--leverage-proxy') options.leverage = Number(next());
        else if (arg === '--timeframe') options.timeframe = next();
        else if (arg === '--momentum-only') options.momentumOnly = true;
        else if (arg === '--momentum-candles') options.momentumCandles = parseMomentumCandles(next());
        else if (arg === '--min-volume-ratio') options.minVolumeRatio = Number(next());
        else if (arg === '--include-hold') options.includeHold = true;
        else if (arg === '--no-reports') options.writeReports = false;
        else throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function parseMomentumCandles(value?: string): 2 | 3 {
    const parsed = Number(value);
    if (parsed === 2 || parsed === 3) return parsed;
    throw new Error('--momentum-candles must be 2 or 3');
}

function splitList(value?: string): string[] {
    return String(value || '')
        .split(',')
        .map(item => item.trim().toUpperCase())
        .filter(Boolean);
}

function helpText(): string {
    return [
        'Offline Aegis Regime Guard audit',
        '',
        'Usage:',
        '  npm run audit:regime-guard -- [options]',
        '  ts-node scripts/aegis/audit_regime_guard.ts [options]',
        '',
        'Options:',
        '  --days N                 Load the latest N log days, default 7',
        '  --from ISO_OR_DATE        Start timestamp/date filter',
        '  --to ISO_OR_DATE          End timestamp/date filter',
        '  --symbols CSV             Symbols to audit, default Aegis universe',
        '  --limit N                 Max evaluations, default 2000',
        '  --leverage N              ROE proxy leverage when logs do not provide one, default 20',
        '  --leverage-proxy N        Alias for --leverage, useful for offline momentum outcome ROE',
        '  --candles-db PATH         Read-only SQLite candles DB path',
        '  --logs-dir PATH           Aegis logs directory',
        '  --reports-dir PATH        Report output directory',
        '  --timeframe 5m            Candle timeframe in ohlcv_data, default 5m',
        '  --momentum-only           Ignore trade entries and audit candle-derived momentum patterns',
        '  --momentum-candles 2|3    Consecutive same-color momentum candles, default 3',
        '  --min-volume-ratio N      Minimum latest candle volume vs previous 20 candles, default 1.3',
        '  --include-hold            Include HOLD signals only when raw action has a side',
        '  --no-reports              Print only, do not write jsonl/csv/markdown reports',
        '  --help                    Show this help',
        '',
        'This script is offline/read-only for logs and candles. It does not call Binance, PM2, or the bot.'
    ].join('\n');
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
