import {
    auditRecentLosingTrades,
    RecentTradeLossAuditOptions,
    renderRecentLossAuditMarkdown
} from '../../src/tools/recentTradeLossAuditCore';

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const report = await auditRecentLosingTrades(options);
    console.log(renderRecentLossAuditMarkdown(report));
    if (report.outputFiles) {
        console.log(`Reports written: ${report.outputFiles.markdown}, ${report.outputFiles.json}, ${report.outputFiles.csv}`);
        if (report.outputFiles.charts.length > 0) console.log(`Charts written: ${report.outputFiles.charts.join(', ')}`);
    }
}

type CliOptions = RecentTradeLossAuditOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        repoRoot: process.cwd(),
        candlesDbPath: '/home/jasan/Develop/trading_system/data/binance_candles.db',
        outDir: '/home/jasan/Develop',
        symbols: ['ETHUSDT', 'ADAUSDT']
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--symbols' && next) options.symbols = args[++i].split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
        else if (arg === '--from' && next) options.from = args[++i];
        else if (arg === '--to' && next) options.to = args[++i];
        else if (arg === '--include-control' && next) options.includeControl = args[++i].trim().toUpperCase();
        else if (arg === '--charts') options.charts = true;
        else if (arg === '--out-dir' && next) options.outDir = args[++i];
        else if (arg === '--db' && next) options.candlesDbPath = args[++i];
        else if (arg === '--logs-dir' && next) options.logsDir = args[++i];
        else if (arg === '--no-reports') options.writeReports = false;
    }
    return options;
}

function printHelp(): void {
    console.log([
        'Recent Aegis losing trades audit',
        '',
        'Options:',
        '  --symbols ETHUSDT,ADAUSDT      Target symbols, default ETHUSDT,ADAUSDT',
        '  --from YYYY-MM-DD              Start date',
        '  --to YYYY-MM-DD                End date',
        '  --include-control AVAXUSDT     Add a positive control trade',
        '  --charts                       Generate PNG charts',
        '  --out-dir DIR                  Output directory, default /home/jasan/Develop',
        '  --db PATH                      SQLite candles DB',
        '  --logs-dir DIR                 Aegis logs directory',
        '  --no-reports                   Print only'
    ].join('\n'));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
