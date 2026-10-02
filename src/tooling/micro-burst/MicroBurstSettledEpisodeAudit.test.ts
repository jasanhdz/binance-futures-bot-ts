import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { auditSettledEpisodes } from './MicroBurstSettledEpisodeAudit';

it('uses weighted fills and exchange timestamps, rejects duplicate episodes and incomplete evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'micro-settlement-audit-'));
  const path = join(dir, 'ledger.sqlite');
  const db = new Database(path);
  try {
    db.exec(
      'CREATE TABLE micro_loss_state (initialized, revision, epoch, streak, halted); CREATE TABLE micro_loss_trades (trade_id, identity, evidence, result, conflicted);',
    );
    const identity = {
      episodeId: 'episode',
      quantity: 3,
      entryOrderId: 'entry',
      closeOrderIds: ['exit'],
    };
    const evidence = {
      fillsComplete: true,
      fundingComplete: true,
      exactOrdersFilledAndPositionFlat: true,
      fills: [
        { id: '1', orderId: 'entry', price: 100, quantity: 1, eventTimeMs: 1000 },
        { id: '2', orderId: 'entry', price: 103, quantity: 2, eventTimeMs: 1100 },
        { id: '3', orderId: 'exit', price: 101, quantity: 3, eventTimeMs: 2000 },
      ],
    };
    db.prepare('INSERT INTO micro_loss_trades VALUES (?, ?, ?, ?, 0)').run(
      'trade',
      JSON.stringify(identity),
      JSON.stringify(evidence),
      JSON.stringify({ status: 'VERIFIED', netPnlUsdt: -3.3, commissionsUsdt: 0.3 }),
    );
    expect(auditSettledEpisodes(path, ['trade'])).toMatchObject({
      independentEpisodes: 1,
      trades: [{ entry: { vwap: 102 }, fillToFillDurationMs: 1000, mfeBps: null, maeBps: null }],
    });
    expect(() => auditSettledEpisodes(path, ['trade', 'trade'])).toThrow(
      'DUPLICATE_OR_MISSING_EPISODE',
    );
    db.prepare('UPDATE micro_loss_trades SET evidence = ?').run(
      JSON.stringify({ ...evidence, fillsComplete: false }),
    );
    expect(() => auditSettledEpisodes(path, ['trade'])).toThrow('INCOMPLETE_SETTLEMENT');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
