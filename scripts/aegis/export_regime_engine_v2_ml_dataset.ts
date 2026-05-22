import {
    exportRegimeEngineV2MlDataset,
    RegimeEngineV2MlDatasetOptions
} from '../../src/tools/regimeEngineV2MlDatasetCore';

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const result = await exportRegimeEngineV2MlDataset(options);
    console.log(`Rows: ${result.rows.length}`);
    if (result.outputFiles) {
        console.log(`Dataset written: ${result.outputFiles.csv}, ${result.outputFiles.jsonl}, ${result.outputFiles.schema}`);
    }
}

type CliOptions = RegimeEngineV2MlDatasetOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        candlesDbPath: '/home/jasan/Develop/trading_system/data/binance_candles.db',
        reportsDir: '/home/jasan/Develop',
        outputDir: '/home/jasan/Develop',
        timeframe: '5m',
        sampleEvery: 6,
        leverage: 20,
        feeBps: 8,
        slippageBps: 3,
        momentumPatternOnly: true
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--from' && next) options.from = args[++i];
        else if (arg === '--to' && next) options.to = args[++i];
        else if (arg === '--sample-every' && next) options.sampleEvery = Number(args[++i]);
        else if (arg === '--leverage' && next) options.leverage = Number(args[++i]);
        else if (arg === '--fee-bps' && next) options.feeBps = Number(args[++i]);
        else if (arg === '--slippage-bps' && next) options.slippageBps = Number(args[++i]);
        else if (arg === '--limit' && next) options.limit = Number(args[++i]);
        else if (arg === '--max-samples-per-symbol' && next) options.maxSamplesPerSymbol = Number(args[++i]);
        else if (arg === '--progress-every' && next) options.progressEvery = Number(args[++i]);
        else if (arg === '--engine-lookback-candles' && next) options.engineLookbackCandles = Number(args[++i]);
        else if (arg === '--symbols' && next) options.symbols = args[++i].split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
        else if (arg === '--db' && next) options.candlesDbPath = args[++i];
        else if (arg === '--output-dir' && next) options.outputDir = args[++i];
        else if (arg === '--source' && next) options.source = args[++i];
    }
    return options;
}

function printHelp(): void {
    console.log([
        'Export RegimeEngineV2 ML exploratory dataset',
        '',
        'Options:',
        '  --from YYYY-MM-DD',
        '  --to YYYY-MM-DD',
        '  --symbols A,B,C',
        '  --sample-every N',
        '  --fee-bps N',
        '  --slippage-bps N',
        '  --max-samples-per-symbol N',
        '  --progress-every N',
        '  --engine-lookback-candles N',
        '  --limit N',
        '  --output-dir DIR',
        '  --source NAME'
    ].join('\n'));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
