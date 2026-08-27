import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIT_ENTRY_FILES = [
  'src/audit/binance-usdm-readonly-audit.ts',
  'src/audit/binance-usdm-readonly-audit-client.ts',
  'src/audit/binance-usdm-readonly-reconciliation.ts',
] as const;

const FORBIDDEN_IMPORT_FRAGMENTS = [
  'BinanceAdapter',
  'TradingService',
  '/brain-contract-v1/',
  '/prospective-shadow-cohort-v1/',
  'createOrder',
  'cancelOrder',
  'changeLeverage',
  'changeMargin',
  'positionSide/dual',
] as const;

export function staticAuditSafetyReport(root: string): {
  result: 'PASS' | 'FAIL';
  files: readonly string[];
  forbidden_imports: string[];
  network_surface: readonly string[];
} {
  const forbidden: string[] = [];
  for (const relative of AUDIT_ENTRY_FILES) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    const imports = [
      ...source.matchAll(/(?:import[^'\"]+from\s+|require\()['\"]([^'\"]+)['\"]/g),
    ].map((match) => match[1]);
    for (const imported of imports) {
      if (FORBIDDEN_IMPORT_FRAGMENTS.some((fragment) => imported.includes(fragment))) {
        forbidden.push(`${relative}:${imported}`);
      }
    }
  }
  return {
    result: forbidden.length === 0 ? 'PASS' : 'FAIL',
    files: AUDIT_ENTRY_FILES,
    forbidden_imports: forbidden,
    network_surface: [
      'getAccountInformationV3',
      'getPositionInformationV3',
      'getCurrentPositionMode',
      'getAllOpenOrders',
      'getAllOpenAlgoOrders',
    ],
  };
}

if (require.main === module) {
  const report = staticAuditSafetyReport(process.cwd());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'PASS') {
    process.stderr.write('AEGIS_AUDIT_FORBIDDEN_IMPORT_DETECTED\n');
    process.exitCode = 1;
  }
}
