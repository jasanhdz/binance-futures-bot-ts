import { renderE4EntryMaeStudyMarkdown, runE4EntryMaeStudy } from '../../src/tooling/aegis/e4EntryMaeStudyCore';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const value = (name: string): string | undefined => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: npm run study:e4-entry-mae -- [--from ISO] [--to ISO] [--logs-dir DIR] [--out-dir DIR] [--no-reports]');
        return;
    }
    const report = await runE4EntryMaeStudy({
        repoRoot: process.cwd(),
        from: value('--from'),
        to: value('--to'),
        logsDir: value('--logs-dir'),
        outDir: value('--out-dir'),
        writeReports: !args.includes('--no-reports')
    });
    console.log(renderE4EntryMaeStudyMarkdown(report));
    if (report.outputFiles) console.log(`Reports written: ${report.outputFiles.markdown}, ${report.outputFiles.json}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
