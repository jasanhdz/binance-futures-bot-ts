import { auditLongRiskShadow } from '../../src/tooling/aegis/longRiskShadowAuditCore';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const report = await auditLongRiskShadow({
    from: arg('--from'),
    to: arg('--to'),
    outDir: arg('--out-dir'),
  });
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.outputFiles) {
    console.log(
      `Reports written: ${report.outputFiles.markdown}, ${report.outputFiles.json}, ${report.outputFiles.csv}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
