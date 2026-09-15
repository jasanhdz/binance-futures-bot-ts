import { auditHistoricalExportFile } from '../src/tooling/micro-burst/MicroBurstHistoricalExportAudit';

const filePath = process.argv[2];
if (!filePath) {
  console.error(
    'Uso: ts-node scripts/micro-burst-audit-historical-export.ts /ruta/export.json|csv',
  );
  process.exit(2);
}

console.log(JSON.stringify(auditHistoricalExportFile(filePath), null, 2));
