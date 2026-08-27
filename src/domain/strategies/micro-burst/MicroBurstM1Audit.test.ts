import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED,
  MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
} from './MicroBurstIdentity';

const strategyDir = resolve(__dirname);

const APPLICATION_LAYER_FILES = ['MicroBurstRuntime.ts', 'MicroBurstSignalJournal.ts'];

function getDomainProductionFiles(): string[] {
  return readdirSync(strategyDir)
    .filter((name) =>
      name.endsWith('.ts') &&
      !name.includes('.test') &&
      !APPLICATION_LAYER_FILES.includes(name),
    );
}

describe('Micro Burst M3 static audit', () => {
  it('no domain production file contains marketOpen, placeStopClose, placeTpClose, or closeSideMarketSafe', () => {
    const productionSource = getDomainProductionFiles()
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .join('\n');

    const forbiddenCalls = [
      'marketOpen',
      'placeStopClose',
      'placeTpClose',
      'closeSideMarketSafe',
    ];

    for (const call of forbiddenCalls) {
      expect(productionSource).not.toContain(call);
    }
  });

  it('no domain production file imports Exchange port', () => {
    const imports = getDomainProductionFiles()
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .flatMap((source) => source.split('\n').filter((line) => line.startsWith('import ')))
      .join('\n');

    expect(imports).not.toContain("from '../../app/ports/Exchange'");
    expect(imports).not.toContain("from '../../../app/ports/Exchange'");
  });

  it('keeps causal domain logic free of Date.now()', () => {
    const productionSource = getDomainProductionFiles()
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .join('\n');

    expect(productionSource).not.toContain('Date.now()');
  });

  it('keeps domain production imports isolated from other strategies', () => {
    const imports = getDomainProductionFiles()
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .flatMap((source) => source.split('\n').filter((line) => line.startsWith('import ')))
      .join('\n');

    for (const forbidden of [
      'Aegis',
      'CurrentBrain',
      'E4',
      'ExitEye',
      'MomentumRide',
      'ProfitGuardian',
    ]) {
      expect(imports).not.toContain(forbidden);
    }
  });

  it('SHADOW authority enabled, LIVE authority disabled', () => {
    expect(MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED).toBe(true);
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(false);
  });

  it('application layer files do not invoke exchange mutation', () => {
    const appSource = APPLICATION_LAYER_FILES
      .map((name) => {
        try { return readFileSync(resolve(strategyDir, name), 'utf8'); }
        catch { return ''; }
      })
      .join('\n');

    const forbiddenCalls = [
      'marketOpen',
      'placeStopClose',
      'placeTpClose',
      'closeSideMarketSafe',
      'SharedStrategyExecutionService.execute',
    ];

    for (const call of forbiddenCalls) {
      expect(appSource).not.toContain(call);
    }
  });

  it('application layer files do not import SharedStrategyExecutionService', () => {
    const appImports = APPLICATION_LAYER_FILES
      .map((name) => {
        try { return readFileSync(resolve(strategyDir, name), 'utf8'); }
        catch { return ''; }
      })
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');

    expect(appImports).not.toContain('SharedStrategyExecutionService');
  });

  it('LIVE authority flag is false', () => {
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(false);
  });
});
