import {
    auditRegimeEngineV2,
    RegimeEngineV2AuditOptions,
    renderRegimeEngineV2Markdown
} from '../../src/tools/regimeEngineV2AuditCore';

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const report = await auditRegimeEngineV2(options);
    console.log(renderRegimeEngineV2Markdown(report));
    if (report.outputFiles) {
        console.log(`Reports written: ${report.outputFiles.markdown}, ${report.outputFiles.json}, ${report.outputFiles.csv}, ${report.outputFiles.recommendations}`);
    }
}

type CliOptions = RegimeEngineV2AuditOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        candlesDbPath: '/home/jasan/Develop/trading_system/data/binance_candles.db',
        reportsDir: '/home/jasan/Develop',
        timeframe: '5m',
        sampleEvery: 6,
        leverage: 20
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
        else if (arg === '--symbols' && next) options.symbols = args[++i].split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
        else if (arg === '--db' && next) options.candlesDbPath = args[++i];
        else if (arg === '--reports-dir' && next) options.reportsDir = args[++i];
        else if (arg === '--momentum-pattern-only') options.momentumPatternOnly = true;
        else if (arg === '--no-reports') options.writeReports = false;
    }
    return options;
}

function printHelp(): void {
    console.log([
        'Offline RegimeEngineV2 audit',
        '',
        'Options:',
        '  --from YYYY-MM-DD          Start date',
        '  --to YYYY-MM-DD            End date',
        '  --sample-every N           Sample every N candles, default 6',
        '  --leverage N               ROE leverage proxy, default 20',
        '  --fee-bps N                Round-trip fee sensitivity input per side, default 0',
        '  --slippage-bps N           Round-trip slippage sensitivity input per side, default 0',
        '  --symbols A,B,C            Optional symbol list',
        '  --limit N                  Max samples',
        '  --momentum-pattern-only    Evaluate only offline Momentum Ride-like patterns',
        '  --db PATH                  SQLite candles DB',
        '  --reports-dir DIR          Output reports dir, default /home/jasan/Develop',
        '  --no-reports               Print only, do not write reports'
    ].join('\n'));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
