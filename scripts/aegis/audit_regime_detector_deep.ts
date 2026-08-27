#!/usr/bin/env ts-node
import {
    auditRegimeDetectorDeep,
    DEFAULT_DEEP_REGIME_SYMBOLS,
    DeepRegimeAuditOptions,
    renderMarkdown
} from '../../src/tooling/aegis/regimeDetectorDeepAuditCore';

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(helpText());
        return;
    }
    const report = await auditRegimeDetectorDeep(options);
    console.log(renderMarkdown(report));
    if (report.outputFiles) {
        console.log('');
        console.log(`Reports: ${Object.values(report.outputFiles).join(', ')}`);
    }
}

type CliOptions = DeepRegimeAuditOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        candlesDbPath: '/home/jasan/Develop/trading_system/data/binance_candles.db',
        reportsDir: '/home/jasan/Develop',
        symbols: DEFAULT_DEEP_REGIME_SYMBOLS,
        timeframe: '5m',
        leverage: 20,
        sampleEvery: 3,
        writeReports: true
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = () => args[++index];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--candles-db') options.candlesDbPath = next();
        else if (arg === '--reports-dir') options.reportsDir = next();
        else if (arg === '--symbols') options.symbols = splitCsv(next());
        else if (arg === '--timeframe') options.timeframe = next();
        else if (arg === '--from') options.from = next();
        else if (arg === '--to') options.to = next();
        else if (arg === '--limit') options.limit = Number(next());
        else if (arg === '--sample-every') options.sampleEvery = Number(next());
        else if (arg === '--leverage') options.leverage = Number(next());
        else if (arg === '--no-reports') options.writeReports = false;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function splitCsv(value?: string): string[] {
    return String(value ?? '')
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
}

function helpText(): string {
    return [
        'Deep Aegis technical regime detector audit',
        '',
        'Usage:',
        '  ts-node scripts/aegis/audit_regime_detector_deep.ts [options]',
        '',
        'Options:',
        '  --candles-db PATH       Read-only SQLite candles DB',
        '  --reports-dir PATH      Output directory, default /home/jasan/Develop',
        '  --symbols CSV           Symbols to audit',
        '  --timeframe 5m          OHLCV timeframe',
        '  --from ISO              Start timestamp',
        '  --to ISO                End timestamp',
        '  --limit N               Max samples',
        '  --sample-every N        Sample every N candles, default 3',
        '  --leverage N            ROE leverage proxy, default 20',
        '  --no-reports            Print only, write no files',
        '',
        'Read-only: does not call Binance, PM2, bot runtime, orders, .env, or live YAML writes.'
    ].join('\n');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
