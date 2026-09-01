import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const compilerOptions: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
};

function repoPath(fileName: string): string {
  return relative(repoRoot, fileName).split(sep).join('/');
}

function productionSourceFiles(): string[] {
  return ts.sys
    .readDirectory(resolve(repoRoot, 'src'), ['.ts'], ['**/*.test.ts', '**/*.d.ts'])
    .map((file) => resolve(file));
}

function importsOf(fileName: string): Array<{ source: string; target: string }> {
  const source = readFileSync(fileName, 'utf8');
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const imports: Array<{ source: string; target: string }> = [];
  for (const statement of sourceFile.statements) {
    let moduleSpecifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier)
      moduleSpecifier = statement.moduleSpecifier;
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
      moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const resolved = ts.resolveModuleName(moduleSpecifier.text, fileName, compilerOptions, ts.sys)
      .resolvedModule?.resolvedFileName;
    if (resolved && resolve(resolved).startsWith(`${repoRoot}${sep}`))
      imports.push({ source: repoPath(fileName), target: repoPath(resolve(resolved)) });
  }
  return imports;
}

const concreteStrategyPrefixes = [
  'src/strategies/aegis/',
  'src/strategies/momentum/',
  'src/strategies/micro-burst/',
];

const sharedRoots = ['src/core/', 'src/app/execution/', 'src/app/position/', 'src/app/ports/'];

const sharedImportAllowlist: Record<string, string[]> = {};

const mutationMethods = new Set([
  'setLeverage',
  'ensureMarginType',
  'marketOpen',
  'placeStopClose',
  'placeTpClose',
  'closeSideMarketSafe',
  'openStopForSide',
  'cancelOrderById',
]);

const mutationAuthorityAllowlist = new Set([
  'src/app/services/TradingService.ts',
  'src/app/execution/SharedStrategyExecutionService.ts',
  // Generic lifecycle mechanics may close a position but do not choose strategy policy.
  'src/app/position/StrategyPositionLifecycleCore.ts',
  'src/app/position/PositionProtectionService.ts',
  'src/infra/adapters/BinanceAdapter.ts',
  'src/infra/adapters/ReadOnlyAuditedExchange.ts',
]);

describe('Phase 0 architecture contracts', () => {
  it('keeps position recovery under one application owner', () => {
    const tradingService = readFileSync(
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      'utf8',
    );
    expect(tradingService.match(/new PositionRecoveryService\(/g) ?? []).toHaveLength(1);
  });

  it('keeps concrete position protection outside TradingService', () => {
    const tradingService = readFileSync(
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      'utf8',
    );
    expect(tradingService.match(/new PositionProtectionService\(/g) ?? []).toHaveLength(1);
    expect(tradingService).not.toMatch(
      /private (?:async )?(?:ensureAegisBrackets|replaceBracketsForNewEntryPrice|reconcileManualPositionSizeIncrease|safeMoveCloseStop|performSafeMoveCloseStop|bracketPrice|roundPrice|roundQuantity|isBetterStop)\b/,
    );
  });

  it('keeps mutable risk-session state outside TradingService', () => {
    const tradingService = readFileSync(
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      'utf8',
    );
    expect(tradingService.match(/new StrategyRiskSessionService\(/g) ?? []).toHaveLength(1);
    expect(tradingService).not.toMatch(
      /private (?:readonly )?(?:tradesToday|phaseOShortTradesToday|lastTradeDayReset|dailyStartBalance|lastDailyPnlPct|consecutiveLossTracker|strategyRiskLedger)\b/,
    );
    expect(tradingService).not.toMatch(
      /private (?:async )?(?:persistDailyRiskState|initializeDailyStartBalance|restoreConsecutiveLossState|persistConsecutiveLossState|checkDailyReset)\b/,
    );
  });

  it('keeps shared/core imports independent from concrete strategy implementations', () => {
    const violations: string[] = [];
    for (const fileName of productionSourceFiles()) {
      const source = repoPath(fileName);
      if (!sharedRoots.some((root) => source.startsWith(root))) continue;
      for (const imported of importsOf(fileName)) {
        if (!concreteStrategyPrefixes.some((prefix) => imported.target.startsWith(prefix)))
          continue;
        if (sharedImportAllowlist[source]?.includes(imported.target)) continue;
        violations.push(`${source} -> ${imported.target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps research and soak tooling away from mutation implementations', () => {
    const files = [
      ...ts.sys.readDirectory(resolve(repoRoot, 'src/tooling'), ['.ts'], ['**/*.test.ts']),
      ...ts.sys.readDirectory(resolve(repoRoot, 'scripts'), ['.ts'], ['**/*.test.ts']),
    ];
    const forbiddenTargets = new Set([
      'src/app/services/TradingService.ts',
      'src/app/execution/SharedStrategyExecutionService.ts',
    ]);
    const allowedReadOnlySmokeImports = new Set([
      'scripts/micro-burst-m3_2_6_3-soak.ts -> src/infra/adapters/BinanceAdapter.ts',
      'scripts/micro-burst-production-path-shadow-smoke.ts -> src/infra/adapters/BinanceAdapter.ts',
    ]);
    const violations: string[] = [];
    for (const fileName of files) {
      const source = repoPath(fileName);
      if (!source.includes('micro-burst') && !source.includes('/aegis/')) continue;
      for (const imported of importsOf(resolve(fileName))) {
        const key = `${imported.source} -> ${imported.target}`;
        if (
          forbiddenTargets.has(imported.target) ||
          imported.target === 'src/infra/adapters/BinanceAdapter.ts'
        ) {
          if (!allowedReadOnlySmokeImports.has(key)) violations.push(key);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('limits mutation-capable exchange method access to approved infrastructure', () => {
    const violations: string[] = [];
    for (const fileName of productionSourceFiles()) {
      const source = repoPath(fileName);
      const sourceFile = ts.createSourceFile(
        fileName,
        readFileSync(fileName, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAccessExpression(node) &&
          mutationMethods.has(node.name.text) &&
          !mutationAuthorityAllowlist.has(source)
        )
          violations.push(`${source}:${node.getStart(sourceFile)}.${node.name.text}`);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(violations).toEqual([]);
  });
});
