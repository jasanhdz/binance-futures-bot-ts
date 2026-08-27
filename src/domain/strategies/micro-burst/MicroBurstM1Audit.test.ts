import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED,
  MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
} from './MicroBurstIdentity';

const strategyDir = resolve(__dirname);

describe('Micro Burst M1 static audit', () => {
  it('no production domain file contains marketOpen, placeStopClose, placeTpClose, or closeSideMarketSafe', () => {
    const productionSource = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
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

  it('no production domain file imports Exchange port', () => {
    const imports = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .flatMap((source) => source.split('\n').filter((line) => line.startsWith('import ')))
      .join('\n');

    expect(imports).not.toContain("from '../../app/ports/Exchange'");
    expect(imports).not.toContain("from '../../../app/ports/Exchange'");
  });

  it('keeps causal domain logic free of Date.now()', () => {
    const productionSource = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .join('\n');

    expect(productionSource).not.toContain('Date.now()');
  });

  it('keeps domain production imports isolated from other strategies', () => {
    const imports = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
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

  it('SHADOW and LIVE authority remain false', () => {
    expect(MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED).toBe(false);
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(false);
  });
});
