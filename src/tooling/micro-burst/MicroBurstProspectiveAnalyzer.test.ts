import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ProspectiveOutcomeRecord } from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';
import { analyzeMicroBurstProspective } from './MicroBurstProspectiveAnalyzer';

const fixture = (name: string): Record<string, unknown>[] => fs.readFileSync(path.join(__dirname, 'fixtures', name, 'data.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

describe('MicroBurstProspectiveAnalyzer', () => {
  it('deduplicates fixture IDs, separates cohorts, and refuses fabricated controls', () => {
    const report = analyzeMicroBurstProspective({
      signals: fixture('signals'),
      outcomes: fixture('outcomes') as unknown as ProspectiveOutcomeRecord[],
      seed: 42,
    });

    expect(report.uniqueSignalCount).toBe(2);
    expect(report.uniqueOutcomeCount).toBe(2);
    expect(report.duplicateSignalRows).toBe(1);
    expect(report.duplicateOutcomeRows).toBe(1);
    expect(report.text).toContain('LONG SIGNAL_PRICE version=v1 config=cfg-a commit=sha-a N=1');
    expect(report.text).toContain('SHORT SIGNAL_PRICE version=v2 config=cfg-b commit=sha-b N=1');
    expect(report.text).toContain('missing usable 300s=1');
    expect(report.text).toContain('RANDOM_SIDE (seed=42): unavailable');
    expect(report.text).toContain('TIME_SHIFT (forward): unavailable');
  });
});
