import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const compilerOptions: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
};

function sourceFiles(root: string): string[] {
  return ts.sys
    .readDirectory(resolve(repoRoot, root), ['.ts'], ['**/*.test.ts', '**/*.d.ts'])
    .map((file) => resolve(file));
}

function resolvedImports(fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return sourceFile.statements.flatMap((statement) => {
    const moduleSpecifier =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return [];
    const resolved = ts.resolveModuleName(moduleSpecifier.text, fileName, compilerOptions, ts.sys)
      .resolvedModule?.resolvedFileName;
    return resolved && resolve(resolved).startsWith(`${repoRoot}/`) ? [resolve(resolved)] : [];
  });
}

describe('Phase 3 architecture contracts', () => {
  it('keeps Micro Burst production consumers on the narrowed market-data port', () => {
    const forbidden = new Set([resolve(repoRoot, 'src/app/ports/Exchange.ts')]);
    const violations: string[] = [];
    for (const fileName of [
      ...sourceFiles('src/domain/strategies/micro-burst'),
      ...sourceFiles('src/app/micro-burst'),
    ]) {
      for (const target of resolvedImports(fileName)) {
        if (forbidden.has(target)) violations.push(fileName);
      }
    }
    expect(violations).toEqual([]);
    expect(
      readFileSync(
        resolve(repoRoot, 'src/domain/strategies/micro-burst/MicroBurstRuntime.ts'),
        'utf8',
      ),
    ).toContain('exchange: MarketDataPort');
  });

  it('keeps neutral market-data ports independent from Micro Burst implementations', () => {
    const source = readFileSync(resolve(repoRoot, 'src/app/ports/MarketData.ts'), 'utf8');
    expect(source).not.toMatch(/micro-burst|MicroBurst/);
    expect(resolvedImports(resolve(repoRoot, 'src/app/ports/MarketData.ts'))).not.toContain(
      resolve(repoRoot, 'src/domain/strategies/micro-burst/MicroBurstMarketDataTypes.ts'),
    );
  });

  it('keeps shared market-data core independent from strategies and mutation authority', () => {
    const forbiddenRoots = [
      resolve(repoRoot, 'src/domain/strategies/aegis'),
      resolve(repoRoot, 'src/domain/strategies/momentum-ride'),
      resolve(repoRoot, 'src/domain/strategies/micro-burst'),
      resolve(repoRoot, 'src/app/micro-burst'),
      resolve(repoRoot, 'src/app/execution'),
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      resolve(repoRoot, 'src/app/ports/Exchange.ts'),
      resolve(repoRoot, 'src/app/position'),
      resolve(repoRoot, 'src/domain/services'),
      resolve(repoRoot, 'src/domain/risk'),
    ];
    const forbiddenNames = [
      'TradingExchangePort',
      'SharedStrategyExecutionService',
      'TradingService',
      'placeOrder',
      'cancelOrder',
      'closePosition',
    ];
    const violations: string[] = [];

    for (const fileName of sourceFiles('src/core/market-data')) {
      const source = readFileSync(fileName, 'utf8');
      for (const target of resolvedImports(fileName)) {
        if (forbiddenRoots.some((root) => target === root || target.startsWith(`${root}/`))) {
          violations.push(`${fileName} -> ${target}`);
        }
      }
      for (const name of forbiddenNames) {
        if (source.includes(name)) violations.push(`${fileName} contains ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
