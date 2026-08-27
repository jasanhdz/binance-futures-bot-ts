import {
  auditRegimeAvoidShadow,
  RegimeAvoidShadowAuditOptions,
  renderRegimeAvoidShadowMarkdown,
} from '../../src/tooling/aegis/regimeAvoidShadowAuditCore';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await auditRegimeAvoidShadow(options);
  console.log(renderRegimeAvoidShadowMarkdown(report));
  if (report.outputFiles) {
    console.log(`Reports written: ${report.outputFiles.markdown}, ${report.outputFiles.json}`);
  }
}

type CliOptions = RegimeAvoidShadowAuditOptions & { help?: boolean };

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { days: 1, allSymbols: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--date' && next) options.date = args[++i];
    else if (arg === '--from' && next) options.from = args[++i];
    else if (arg === '--to' && next) options.to = args[++i];
    else if (arg === '--days' && next) options.days = Number(args[++i]);
    else if (arg === '--symbol' && next) {
      options.symbol = args[++i].toUpperCase();
      options.allSymbols = false;
    } else if (arg === '--all-symbols') options.allSymbols = true;
    else if (arg === '--base-dir' && next) options.baseDir = args[++i];
    else if (arg === '--reports-dir' && next) options.reportsDir = args[++i];
    else if (arg === '--no-reports') options.writeReports = false;
  }
  return options;
}

function printHelp(): void {
  console.log(
    [
      'Offline Regime Avoid Shadow audit',
      '',
      'Options:',
      '  --days N                  Audit the last N UTC dates, default 1',
      '  --date YYYY-MM-DD         Audit one UTC date',
      '  --from YYYY-MM-DD         Start UTC date',
      '  --to YYYY-MM-DD           End UTC date',
      '  --symbol SYMBOL           Filter one symbol',
      '  --all-symbols             Include all symbols, default',
      '  --base-dir DIR            Logs directory, default logs/aegis',
      '  --reports-dir DIR         Reports directory, default reports/tools',
      '  --no-reports              Print only, do not write reports',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
